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
	const bytes = Buffer.byteLength(s, "utf8");
	if (bytes <= maxBytes) return s;
	const cut = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
	return `${cut}…[truncated, ${bytes}b]`;
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
		const path = redact(entry.path);
		const { header, hunks, body } = splitHunks(entry.diff);
		const budget = Math.min(DIFF_ENTRY_BUDGET, remaining);

		if (body !== null) {
			// No hunks: unstructured text. Byte-truncate like any other string.
			const safe = redact(body);
			const size = Buffer.byteLength(safe, "utf8");
			const kept = size <= budget ? safe : truncate(safe, budget);
			const used = Buffer.byteLength(kept, "utf8");
			remaining = Math.max(0, remaining - used);
			out.push({ path, diff: kept, hunksShown: 0, hunksTotal: 0, bytesOmitted: Math.max(0, size - used), partialHunk: false });
			continue;
		}

		const safeHeader = redact(header);
		const kept: string[] = [];
		let used = 0, shown = 0, omitted = 0, partial = false;

		for (const hunk of hunks) {
			const safe = redact(hunk);
			const size = Buffer.byteLength(safe, "utf8");
			if (used + size <= budget) {
				kept.push(safe);
				used += size;
				shown += 1;
				continue;
			}
			if (shown === 0 && budget > 0) {
				// One hunk alone exceeds the entry budget -- the only case where a partial hunk
				// beats showing nothing. Flagged so the UI can say the hunk itself is cut.
				const cut = truncate(safe, budget);
				const cutSize = Buffer.byteLength(cut, "utf8");
				kept.push(cut);
				used += cutSize;
				shown += 1;
				partial = true;
				omitted += Math.max(0, size - cutSize);
				continue;
			}
			omitted += size;
		}

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
