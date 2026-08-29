import type { UsageEntry, UsageView } from "../analytics.js";
import type { RegistryEntry } from "../registry.js";

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

export interface WidgetOption {
	slug: string;
	name: string;
	entry: string;
	size: "small" | "medium" | "large";
}

function widgetDashboard(widgets: WidgetOption[], registryWidgets: RegistryEntry[] = []): string {
	if (widgets.length === 0 && registryWidgets.length === 0) return "";
	const opts = widgets
		.map((w) => `<option value="${escapeHtml(w.slug)}" data-entry="${escapeHtml(w.entry)}" data-size="${escapeHtml(w.size)}">${escapeHtml(w.name)}</option>`)
		.join("");
	const registryOpts = registryWidgets.length
		? `<optgroup label="Browse marketplace (listed, not reviewed)">${registryWidgets
				.map(
					(w) =>
						`<option value="registry:${escapeHtml(w.slug)}" data-registry-slug="${escapeHtml(w.slug)}" title="${escapeHtml(w.description)} — ${escapeHtml(w.repo)}">${escapeHtml(w.name)} (install)</option>`
				)
				.join("")}</optgroup>`
		: "";
	return `<section class="widget-dashboard">
		<div class="widget-dashboard-head">
			<h2>Widgets</h2>
			<select id="addWidgetPicker" class="plugin-picker"><option value="">Add widget…</option>${opts}${registryOpts}</select>
		</div>
		<div id="widgetGrid" class="widget-grid"></div>
	</section>`;
}

/** The analytics panel's body -- store-wide, no traceId. `widgets` is every installed,
 * version-compatible kind:"widget" plugin (server.ts's widgetOptions()) -- which of them are
 * actually on the dashboard right now is client-side state (app.ts's initWidgetDashboard), fetched
 * separately from GET /api/v1/dashboard/analytics after this HTML has mounted. */
export function renderAnalyticsBody(usage: UsageView, widgets: WidgetOption[] = [], registryWidgets: RegistryEntry[] = []): string {
	const skills = usage.entries.filter((e) => e.type === "skill");
	const subAgents = usage.entries.filter((e) => e.type === "sub_agent");
	const mcpServers = usage.entries.filter((e) => e.type === "mcp_server");

	if (usage.totalRuns === 0) return `<p class="empty">No runs yet.</p>` + widgetDashboard(widgets, registryWidgets);
	if (usage.trackedRuns === 0) {
		return (
			`<p class="empty">No runs have reported skill/sub-agent/MCP-server usage yet — coverage tracking requires trail_log_step calls with source_type/source_name set.</p>` +
			widgetDashboard(widgets, registryWidgets)
		);
	}
	if (usage.entries.length === 0) {
		return `<p class="empty">No skills, sub-agents, or MCP servers have been registered by any run.</p>` + widgetDashboard(widgets, registryWidgets);
	}

	const untracked = usage.totalRuns - usage.trackedRuns;
	const note = untracked > 0 ? `<p class="note">${untracked} run(s) have no coverage tracking (excluded from the counts below).</p>` : "";
	return `<p class="as-of">Usage across ${usage.totalRuns} run(s)</p>
	${note}
	${section("Skills", skills, "No skills registered by any run.")}
	${section("Sub-agents", subAgents, "No sub-agents registered by any run.")}
	${section("MCP servers", mcpServers, "No MCP servers registered by any run.")}
	${widgetDashboard(widgets, registryWidgets)}`;
}
