import type { RunSummary } from "../runs.js";

// Object.assign(Object.create(null), ...) rather than a plain object literal: `run.verdict` is
// attacker-controlled (arrives via the unauthenticated POST /traces endpoint), and runs.ts's
// asVerdict() is the primary guard against a poisoned value like "__proto__" or "constructor"
// reaching here at all -- but a null-prototype lookup table means even a value that somehow
// bypassed that boundary resolves via `??`/`hasOwnProperty` semantics instead of walking the
// prototype chain to a function or Object.prototype, which would crash escapeHtml() below.
const VERDICT_COLOR: Record<string, string> = Object.assign(Object.create(null), { met: "#2FA24A", partial: "#C08810", failed: "#DC4A38", unjudged: "#8A8F97" });
const VERDICT_LABEL: Record<string, string> = Object.assign(Object.create(null), { met: "Goal met", partial: "Partial", failed: "Goal missed", unjudged: "Not judged" });

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** "5m ago" / "3h ago" / "3d ago" / a plain YYYY-MM-DD date for anything older than 30 days or in
 * the future (clock skew shouldn't ever show a negative duration). Never throws -- a malformed
 * ISO string returns itself unchanged, matching this codebase's degrade-gracefully convention. */
export function formatRelativeTime(startedAtIso: string, nowMs: number): string {
	const t = Date.parse(startedAtIso);
	if (Number.isNaN(t)) return startedAtIso;
	const diff = nowMs - t;
	if (diff < 0) return startedAtIso.slice(0, 10);
	if (diff < MINUTE_MS) return "just now";
	if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
	if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
	if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
	return startedAtIso.slice(0, 10);
}

function railRow(run: RunSummary, activeTraceId: string | undefined, nowMs: number): string {
	const color = VERDICT_COLOR[run.verdict] ?? VERDICT_COLOR.unjudged;
	const label = VERDICT_LABEL[run.verdict] ?? "Not judged";
	const activeClass = run.traceId === activeTraceId ? " rail-row-active" : "";
	return `<a class="rail-row${activeClass}" href="/runs/${escapeHtml(run.traceId)}" data-trace-id="${escapeHtml(run.traceId)}">
		<span class="rail-dot-goal"><span class="rail-dot" style="background:${color}" title="${escapeHtml(label)}"></span><span class="rail-goal">${escapeHtml(run.goal)}</span></span>
		<span class="rail-time">${escapeHtml(formatRelativeTime(run.startedAt, nowMs))}</span>
	</a>`;
}

/** The inner HTML of the shell's `<nav id="rail">` -- never the `<nav>` wrapper itself, since the
 * client router replaces just this element's innerHTML on each rail poll (see app.ts). */
export function renderRailBody(runs: RunSummary[], activeTraceId: string | undefined, nowMs: number): string {
	if (runs.length === 0) return `<p class="rail-empty">No runs yet.</p>`;
	return runs.map((r) => railRow(r, activeTraceId, nowMs)).join("");
}
