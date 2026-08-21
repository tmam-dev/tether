import type { HarnessView, HarnessSkillView, HarnessSubAgentView, HarnessMcpServerView } from "../harness.js";

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

/** The harness panel's body for one run. The caller (server.ts) guarantees `view` is non-null --
 * an unknown traceId is handled generically via shell.ts's renderNotFoundPanel, not here. */
export function renderHarnessBody(view: HarnessView): string {
	return `<p class="as-of">Harness as of: <strong>${escapeHtml(view.goal)}</strong> · ${escapeHtml(view.startedAt)}</p>
	${section("Skills", view.skills.length, view.skills.map(skillItem).join(""), "No skills discovered for this run.")}
	${section("Sub-agents", view.subAgents.length, view.subAgents.map(subAgentItem).join(""), "No sub-agents discovered for this run.")}
	${section("MCP servers", view.mcpServers.length, view.mcpServers.map(mcpItem).join(""), "No MCP servers discovered for this run.")}`;
}
