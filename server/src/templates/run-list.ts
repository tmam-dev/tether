import type { RunSummary } from "../runs.js";

const VERDICT_LABEL: Record<string, string> = { met: "Goal met", partial: "Partial", failed: "Goal missed", unjudged: "Not judged" };
const VERDICT_COLOR: Record<string, string> = { met: "#2FA24A", partial: "#C08810", failed: "#DC4A38", unjudged: "#8A8F97" };

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function row(run: RunSummary): string {
	const color = VERDICT_COLOR[run.verdict] ?? VERDICT_COLOR.unjudged;
	const label = VERDICT_LABEL[run.verdict] ?? "Not judged";
	return `<tr>
		<td><a href="/runs/${escapeHtml(run.traceId)}">${escapeHtml(run.goal)}</a></td>
		<td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${color}"></span>${label}</span></td>
		<td>${escapeHtml(run.dur)}</td>
		<td>${escapeHtml(run.startedAt)}</td>
	</tr>`;
}

export function renderRunListPage(runs: RunSummary[]): string {
	const rows = runs.map(row).join("\n");
	const empty = runs.length === 0 ? `<p style="color:#8A8F97">No runs yet. Point a coding agent at this Tether instance and run something.</p>` : "";
	return `<!doctype html>
<title>Tether</title>
<style>
	body { margin:0; background:#F7F6F2; color:#1B1F24; font-family:-apple-system,system-ui,sans-serif; font-size:14px; }
	@media (prefers-color-scheme: dark) { body { background:#0E1116; color:#E8ECF1; } }
	.wrap { max-width:960px; margin:0 auto; padding:32px 24px; }
	h1 { font-size:20px; font-weight:640; margin:0 0 20px; }
	table { width:100%; border-collapse:collapse; }
	th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:#8A8F97; padding:8px 10px; border-bottom:1px solid #E6E3DB; }
	td { padding:10px; border-bottom:1px solid #E6E3DB; }
	a { color:#0B7C87; text-decoration:none; }
	a:hover { text-decoration:underline; }
	.nav { font-size:12px; color:#8A8F97; margin-bottom:10px; }
</style>
<div class="wrap">
	<div class="nav"><a href="/">Runs</a> · <a href="/harness">Harness</a> · <a href="/analytics">Analytics</a></div>
	<h1>Tether — Runs</h1>
	${empty}
	${runs.length ? `<table><thead><tr><th>Goal</th><th>Verdict</th><th>Duration</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
</div>`;
}
