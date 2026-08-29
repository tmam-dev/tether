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
	/["']?[A-Za-z0-9_]*(?:secret|password|token|api[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, // KEY=value / "key": "value" near a secret-ish name
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
	const cut = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
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
