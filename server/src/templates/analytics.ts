import type { UsageEntry, UsageView } from "../analytics.js";

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function usageItem(e: UsageEntry): string {
	const deadWeightTag = e.deadWeight ? `<span class="tag tag-dead">DEAD WEIGHT</span>` : "";
	const stats = e.trackedRuns > 0
		? `used in ${e.usedRuns}/${e.trackedRuns} tracked runs (${e.totalUsedCount} total uses)`
		: `registered in ${e.registeredRuns} run(s), no tracked usage data`;
	return `<li class="entry">
		<div class="entry-name">${escapeHtml(e.name)}${deadWeightTag}</div>
		<div class="entry-desc">${stats}</div>
	</li>`;
}

function section(title: string, entries: UsageEntry[], emptyMessage: string): string {
	const body = entries.length > 0 ? `<ul class="entries">${entries.map(usageItem).join("")}</ul>` : `<p class="empty">${emptyMessage}</p>`;
	return `<section class="card">
		<div class="card-head"><h2>${title} <span class="count">${entries.length}</span></h2></div>
		${body}
	</section>`;
}

const STYLE = `
	:root {
		--bg: #F7F6F2; --panel: #FFFFFF; --line: #E6E3DB; --line-strong: #D6D2C7;
		--ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97; --failed: #DC4A38;
		--radius: 12px;
		--sans: -apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
		--mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Roboto Mono", monospace;
	}
	@media (prefers-color-scheme: dark) {
		:root { --bg: #0E1116; --panel: #161B22; --line: #262D38; --line-strong: #333C49; --ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683; --failed: #F0533F; }
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.5; }
	.wrap { max-width: 900px; margin: 0 auto; padding: 20px clamp(14px, 3vw, 28px) 64px; }
	.topbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
	.brand { margin-right: auto; }
	.brand-name { font-weight: 640; letter-spacing: -0.01em; font-size: 15px; }
	.brand-sub { font-family: var(--mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
	.backlink { font-size: 12.5px; color: var(--ink-2); text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
	.backlink:hover { color: var(--ink); border-color: var(--line-strong); }
	.as-of { color: var(--ink-2); font-size: 13px; margin: 0 0 10px; }
	.note { color: var(--ink-3); font-size: 12.5px; margin: 0 0 20px; }
	.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 16px; }
	.card-head h2 { font-size: 14px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
	.card-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-weight: 400; }
	.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.entry { border-top: 1px solid var(--line); padding-top: 10px; }
	.entry:first-child { border-top: none; padding-top: 0; }
	.entry-name { font-weight: 600; font-size: 13.5px; }
	.entry-name .tag { font-weight: 400; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 999px; padding: 1px 7px; margin-left: 6px; }
	.tag-dead { color: var(--failed); border: 1px solid var(--failed); }
	.entry-desc { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
	.empty { color: var(--ink-3); font-size: 13px; }
`;

export function renderAnalyticsPage(usage: UsageView): string {
	const skills = usage.entries.filter((e) => e.type === "skill");
	const subAgents = usage.entries.filter((e) => e.type === "sub_agent");
	const mcpServers = usage.entries.filter((e) => e.type === "mcp_server");

	let body: string;
	if (usage.totalRuns === 0) {
		body = `<p class="empty">No runs yet.</p>`;
	} else if (usage.trackedRuns === 0) {
		body = `<p class="empty">No runs have reported skill/sub-agent/MCP-server usage yet — coverage tracking requires trail_log_step calls with source_type/source_name set.</p>`;
	} else if (usage.entries.length === 0) {
		body = `<p class="empty">No skills, sub-agents, or MCP servers have been registered by any run.</p>`;
	} else {
		const untracked = usage.totalRuns - usage.trackedRuns;
		const note = untracked > 0 ? `<p class="note">${untracked} run(s) have no coverage tracking (excluded from the counts below).</p>` : "";
		body = `<p class="as-of">Usage across ${usage.totalRuns} run(s)</p>
		${note}
		${section("Skills", skills, "No skills registered by any run.")}
		${section("Sub-agents", subAgents, "No sub-agents registered by any run.")}
		${section("MCP servers", mcpServers, "No MCP servers registered by any run.")}`;
	}

	return `<!doctype html>
<title>Tether — Analytics</title>
<style>${STYLE}</style>
<div class="wrap">
	<div class="topbar">
		<div class="brand"><div class="brand-name">Tether</div><div class="brand-sub">Analytics</div></div>
		<a class="backlink" href="/">&larr; All runs</a>
		<a class="backlink" href="/harness">Harness</a>
	</div>
	${body}
</div>`;
}
