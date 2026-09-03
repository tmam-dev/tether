/**
 * Producer-side redaction and truncation for structured tool-call/LLM-call
 * data before it's sent to Trail. Best-effort pattern matching, not a
 * guarantee — see mcp/README.md's "Migrating from 0.2.x" section.
 */

const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9]{10,}\b/g, // OpenAI/Anthropic-style API keys
	/\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub personal access tokens
	/\bAKIA[A-Z0-9]{12,}\b/g, // AWS access key ids
	/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, // Authorization: Bearer <token>
	/["']?[A-Za-z0-9_]{0,64}(?:secret|password|token|api[_-]?key)[A-Za-z0-9_]{0,64}["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, // KEY=value / "key": "value" near a secret-ish name
];

function redact(s: string): string {
	let out = s;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

function truncate(s: string, maxBytes: number): string {
	return truncateBytes(s, maxBytes).text;
}

/**
 * Like truncate(), but also reports how many bytes of the original content were actually dropped.
 * The `…[truncated, Nb]` suffix truncate() appends is itself ~18-23 bytes, so the returned text's
 * total byte length is not a safe stand-in for "bytes omitted" -- when the overshoot is smaller
 * than the suffix, `size - text.length` goes negative and callers that clamp it to 0 would wrongly
 * report nothing was dropped. `cutBytes` here is the gap between the original and the kept content
 * alone, before the suffix is added, so it's always > 0 whenever a cut actually happened.
 */
function truncateBytes(s: string, maxBytes: number): { text: string; cutBytes: number } {
	const bytes = Buffer.byteLength(s, "utf8");
	if (bytes <= maxBytes) return { text: s, cutBytes: 0 };
	const cut = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
	const keptBytes = Buffer.byteLength(cut, "utf8");
	return { text: `${cut}…[truncated, ${bytes}b]`, cutBytes: bytes - keptBytes };
}

export function sanitize(value: unknown, maxBytes = 16384): unknown {
	if (typeof value === "string") return truncate(redact(value), maxBytes);
	if (Array.isArray(value)) return value.map((v) => sanitize(v, maxBytes));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, maxBytes);
		return out;
	}
	return value;
}

/** 256KB per diff entry, so one enormous file can't crowd out every other file's changes. */
const DIFF_ENTRY_BUDGET = 262144;
/** 1MB per step across all entries, so a step touching many files can't emit megabytes into one span. */
const DIFF_STEP_BUDGET = 1048576;

export interface DiffInput {
	path: string;
	diff: string;
}

export interface DiffEntry {
	path: string;
	diff: string;
	hunksShown: number;
	hunksTotal: number;
	bytesOmitted: number;
	partialHunk: boolean;
}

/**
 * Splits a unified diff into its leading file header (the ---/+++ lines) and its @@ hunks.
 * A string with no @@ at all has no header by definition -- it's unstructured text of unknown
 * size, so it comes back as `hunks: []` with the whole string as `body` for the caller to
 * budget-truncate. Treating it as a header would let malformed input bypass the budget.
 */
function splitHunks(diff: string): { header: string; hunks: string[]; body: string | null } {
	const idx = diff.search(/^@@/m);
	if (idx === -1) return { header: "", hunks: [], body: diff };
	return {
		header: diff.slice(0, idx),
		hunks: diff.slice(idx).split(/^(?=@@)/m).filter((h) => h.length > 0),
		body: null,
	};
}

/**
 * Redacts and budget-truncates agent-supplied file diffs at whole-hunk boundaries. A diff cut
 * mid-hunk is unreadable rather than merely partial, so hunks are admitted whole and what was
 * dropped is reported rather than hidden -- the UI is required to surface it.
 */
export function sanitizeDiffs(entries: DiffInput[]): DiffEntry[] {
	let remaining = DIFF_STEP_BUDGET;
	const out: DiffEntry[] = [];

	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") {
			continue; // Skip non-object entries (e.g. null/undefined slipping past the schema)
		}
		if (typeof entry.path !== "string" || typeof entry.diff !== "string") {
			continue; // Skip entries with non-string path or diff
		}
		const path = redact(entry.path);
		const pathBytes = Buffer.byteLength(path, "utf8");
		const { header, hunks, body } = splitHunks(entry.diff);
		const budget = Math.min(DIFF_ENTRY_BUDGET, remaining);

		if (body !== null) {
			// No hunks: unstructured text. Byte-truncate like any other string. The path is part
			// of what this entry costs the step budget, so it comes out of the same allowance the
			// body content competes for.
			const safe = redact(body);
			const size = Buffer.byteLength(safe, "utf8");
			const bodyBudget = Math.max(0, budget - pathBytes);
			let kept: string;
			let bytesOmitted: number;
			if (size <= bodyBudget) {
				kept = safe;
				bytesOmitted = 0;
			} else {
				const t = truncateBytes(safe, bodyBudget);
				kept = t.text;
				bytesOmitted = t.cutBytes;
			}
			const used = pathBytes + Buffer.byteLength(kept, "utf8");
			remaining = Math.max(0, remaining - used);
			out.push({ path, diff: kept, hunksShown: 0, hunksTotal: 0, bytesOmitted, partialHunk: false });
			continue;
		}

		// The header (and the path) are always retained -- a diff without its header is
		// ambiguous, and the path is how the UI identifies the file at all -- but their bytes
		// still count against both this entry's and the step's remaining budget, so a step with
		// many large pre-hunk headers can't emit unbounded bytes. If they alone exceed what's
		// left, hunks simply get none of the budget (hunkBudget floors at 0) rather than the
		// overhead being absorbed for free.
		const safeHeader = redact(header);
		const overhead = Buffer.byteLength(safeHeader, "utf8") + pathBytes;
		const hunkBudget = Math.max(0, budget - overhead);
		const kept: string[] = [];
		let hunkUsed = 0, shown = 0, omitted = 0, partial = false;

		for (const hunk of hunks) {
			const safe = redact(hunk);
			const size = Buffer.byteLength(safe, "utf8");
			if (hunkUsed + size <= hunkBudget) {
				kept.push(safe);
				hunkUsed += size;
				shown += 1;
				continue;
			}
			if (shown === 0 && hunkBudget > 0) {
				// One hunk alone exceeds the entry budget -- the only case where a partial hunk
				// beats showing nothing. Flagged so the UI can say the hunk itself is cut.
				const t = truncateBytes(safe, hunkBudget);
				kept.push(t.text);
				hunkUsed += Buffer.byteLength(t.text, "utf8");
				shown += 1;
				partial = true;
				omitted += t.cutBytes;
				continue;
			}
			omitted += size;
		}

		const used = overhead + hunkUsed;
		remaining = Math.max(0, remaining - used);
		out.push({
			path,
			diff: safeHeader + kept.join(""),
			hunksShown: shown,
			hunksTotal: hunks.length,
			bytesOmitted: omitted,
			partialHunk: partial,
		});
	}

	return out;
}
