import type { HarnessView, HarnessSkillView, HarnessSubAgentView, HarnessMcpServerView } from "../harness.js";
import type { RunSummary } from "../runs.js";

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function skillItem(s: HarnessSkillView): string {
	return `<li class="entry">
		<div class="entry-name">${escapeHtml(s.name)}<span class="tag">${s.source === "user" ? "user" : "project"}</span></div>
		<div class="entry-desc">${escapeHtml(s.description)}</div>
	</li>`;
}

function subAgentItem(a: HarnessSubAgentView): string {
	const tools = a.tools.length ? `<div class="entry-tools">Tools: ${a.tools.map(escapeHtml).join(", ")}</div>` : "";
	return `<li class="entry">
		<div class="entry-name">${escapeHtml(a.name)}</div>
		<div class="entry-desc">${escapeHtml(a.description)}</div>
		${tools}
	</li>`;
}

function mcpItem(m: HarnessMcpServerView): string {
	return `<li class="entry"><div class="entry-name">${escapeHtml(m.name)}</div></li>`;
}

function section(title: string, count: number, itemsHtml: string, emptyMessage: string): string {
	const body = count > 0 ? `<ul class="entries">${itemsHtml}</ul>` : `<p class="empty">${emptyMessage}</p>`;
	return `<section class="card">
		<div class="card-head"><h2>${title} <span class="count">${count}</span></h2></div>
		${body}
	</section>`;
}

function runOption(r: RunSummary, selectedTraceId: string): string {
	const selected = r.traceId === selectedTraceId ? " selected" : "";
	return `<option value="${escapeHtml(r.traceId)}"${selected}>${escapeHtml(r.goal)} — ${escapeHtml(r.startedAt)}</option>`;
}

const STYLE = `
	:root {
		--bg: #F7F6F2; --panel: #FFFFFF; --line: #E6E3DB; --line-strong: #D6D2C7;
		--ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
		--radius: 12px;
		--sans: -apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
		--mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Roboto Mono", monospace;
	}
	@media (prefers-color-scheme: dark) {
		:root { --bg: #0E1116; --panel: #161B22; --line: #262D38; --line-strong: #333C49; --ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683; }
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
	select#runPicker { font-family: var(--sans); font-size: 13px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; margin-bottom: 20px; max-width: 100%; }
	.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 16px; }
	.card-head h2 { font-size: 14px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
	.card-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-weight: 400; }
	.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.entry { border-top: 1px solid var(--line); padding-top: 10px; }
	.entry:first-child { border-top: none; padding-top: 0; }
	.entry-name { font-weight: 600; font-size: 13.5px; }
	.entry-name .tag { font-weight: 400; font-size: 10.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 6px; }
	.entry-desc { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
	.entry-tools { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; margin-top: 4px; }
	.empty { color: var(--ink-3); font-size: 13px; }
`;

export function renderHarnessPage(view: HarnessView | null, runs: RunSummary[]): string {
	const picker = runs.length
		? `<select id="runPicker" onchange="location.search='?run='+encodeURIComponent(this.value)">${runs.map((r) => runOption(r, view ? view.traceId : "")).join("")}</select>`
		: "";

	const body = view
		? `<p class="as-of">Harness as of: <strong>${escapeHtml(view.goal)}</strong> · ${escapeHtml(view.startedAt)}</p>
		${picker}
		${section("Skills", view.skills.length, view.skills.map(skillItem).join(""), "No skills discovered for this run.")}
		${section("Sub-agents", view.subAgents.length, view.subAgents.map(subAgentItem).join(""), "No sub-agents discovered for this run.")}
		${section("MCP servers", view.mcpServers.length, view.mcpServers.map(mcpItem).join(""), "No MCP servers discovered for this run.")}`
		: runs.length
			? `<p class="empty">That run wasn't found. Pick another run below.</p>
			${picker}`
			: `<p class="empty">No runs yet — once a run stamps a harness manifest, it'll show up here.</p>`;

	return `<!doctype html>
<title>Tether — Harness</title>
<style>${STYLE}</style>
<div class="wrap">
	<div class="topbar">
		<div class="brand"><div class="brand-name">Tether</div><div class="brand-sub">Harness</div></div>
		<a class="backlink" href="/">&larr; All runs</a>
	</div>
	${body}
</div>`;
}
