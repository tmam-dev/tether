# Analytics Widget Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second, smaller plugin shape — a "widget" — mount as a bounded-size card in a new composable grid on the Analytics view, alongside (not replacing) today's full-slot plugin system, with a server-side-persisted list of which widgets are on the dashboard.

**Architecture:** Reuse the shipped plugin system entirely (manifest, `plugin add`, same-origin iframe execution) — only add: an optional `kind`/`size` pair to the manifest schema, two new `/api/v1/dashboard/analytics` endpoints backed by a small JSON file (sibling to the existing `dev-overrides.json`), server-rendered widget-picker/grid markup appended to the existing Analytics fragment, and client-side JS that fetches the persisted list, mounts one iframe per widget, and keeps the picker/grid/persisted-list in sync on add/remove.

**Tech Stack:** TypeScript (`tsc`, `module: Node16`), plain `node:http`, zero client-side build (hand-written `app.ts` compiled straight to browser-loadable `app.js`), `node --test` against compiled `dist/`.

**Spec:** `docs/superpowers/specs/2026-08-29-analytics-widget-dashboard-design.md`

## Global Constraints

- Every manifest written before this plan has no `kind` field — it MUST keep installing and rendering exactly as it does today (`kind` defaults to `"panel"`, `replaces` stays required only for `"panel"`).
- A widget manifest requires `size: "small" | "medium" | "large"` and has no `replaces` field.
- No new isolation/trust model — a widget iframe is `sandbox="allow-scripts allow-same-origin"`, identical to a full-slot plugin's, per the 2026-08-26 spec's already-stated trust model.
- All server-side code must run through the existing "never throw on a bad/missing file" convention (`plugins.ts`'s existing style — see `readDevOverrides`) for anything reading `analytics-dashboard.json`.
- Tests run against **compiled** output (`../dist/...` imports) — every task's tests require `npm run build` in `server/` first. Run `npm run build && node --test test/*.js` (or `npm test`, which already runs the test script) from `server/` to verify each task.
- This codebase's `moduleDetection: "legacy"` tsconfig gotcha (documented in this repo's root `CLAUDE.md`) applies to `server/src/static/app.ts`: it must never gain a top-level `import`/`export` statement, or the browser `<script>` load breaks. Nothing in this plan adds one — `WidgetOption`-style types needed client-side are declared as local `interface`s inside `app.ts` itself, not imported.

---

### Task 1: Manifest schema — `kind` and `size` fields

**Files:**
- Modify: `server/src/plugins.ts:24-34` (`PluginManifest` interface), `server/src/plugins.ts:63-77` (`isValidManifest`)
- Test: `server/test/plugins.test.js`

**Interfaces:**
- Produces: `PluginManifest.kind?: "panel" | "widget"`, `PluginManifest.size?: "small" | "medium" | "large"`. `isValidManifest` now requires `size` (one of the three values) when `kind === "widget"`, and requires `replaces` (existing behavior, unchanged) when `kind` is `"panel"` or absent.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/plugins.test.js`, inside (or near) the existing `describe("readManifest", ...)` / manifest-validation block — use the file's existing `installFixturePlugin(root, slug, overrides)` helper (it spreads `overrides` over a default manifest that includes `replaces: "detail"`; setting a key to `undefined` in `overrides` drops it from the written JSON since `JSON.stringify` omits `undefined` values):

```js
describe("manifest kind/size validation", () => {
	test("a manifest with no kind field validates as a panel (backward compatible) and still requires replaces", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "legacy-panel");
			const [plugin] = listInstalledPlugins(root);
			assert.equal(plugin.replaces, "detail");
			assert.equal(plugin.kind, undefined);
		});
	});

	test("a panel manifest missing replaces is rejected", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "broken-panel", { replaces: undefined });
			assert.equal(listInstalledPlugins(root).length, 0);
		});
	});

	test("a widget manifest with a valid size and no replaces is accepted", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "cost-trend", { kind: "widget", size: "medium", replaces: undefined });
			const [plugin] = listInstalledPlugins(root);
			assert.equal(plugin.kind, "widget");
			assert.equal(plugin.size, "medium");
		});
	});

	test("a widget manifest missing size is rejected", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "no-size", { kind: "widget", replaces: undefined });
			assert.equal(listInstalledPlugins(root).length, 0);
		});
	});

	test("a widget manifest with an invalid size is rejected", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "bad-size", { kind: "widget", size: "huge", replaces: undefined });
			assert.equal(listInstalledPlugins(root).length, 0);
		});
	});

	test("a manifest with an unrecognized kind is rejected", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "bad-kind", { kind: "bogus" });
			assert.equal(listInstalledPlugins(root).length, 0);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `server/`): `npm run build && node --test test/plugins.test.js`
Expected: the three "accepted" cases fail (current `isValidManifest` requires `replaces` unconditionally, so `cost-trend` gets rejected today) and the "no kind field" case passes already (already covered by existing behavior) — confirms the new widget path doesn't exist yet.

- [ ] **Step 3: Implement**

In `server/src/plugins.ts`, extend the interface (near line 24):

```ts
export interface PluginManifest {
	name: string;
	slug: string;
	version: string;
	author: string;
	description: string;
	entry: string;
	icon?: string;
	replaces?: "detail" | "harness" | "analytics";
	kind?: "panel" | "widget";
	size?: "small" | "medium" | "large";
	tetherApiVersion: number;
}
```

(`replaces` becomes optional at the type level — `isValidManifest` below is what actually enforces "required for panel, absent/ignored for widget".)

Add two more sets near the existing `REPLACES_SLOTS` (line 13):

```ts
const KINDS = new Set(["panel", "widget"]);
const SIZES = new Set(["small", "medium", "large"]);
```

Replace `isValidManifest` (lines 63-77) with:

```ts
function isValidManifest(v: unknown): v is PluginManifest {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	const baseValid =
		typeof m.name === "string" &&
		typeof m.slug === "string" &&
		typeof m.version === "string" &&
		typeof m.author === "string" &&
		typeof m.description === "string" &&
		typeof m.entry === "string" &&
		typeof m.tetherApiVersion === "number";
	if (!baseValid) return false;
	if (m.kind !== undefined && !KINDS.has(m.kind as string)) return false;
	const kind = (m.kind as "panel" | "widget" | undefined) ?? "panel";
	if (kind === "widget") return typeof m.size === "string" && SIZES.has(m.size);
	return typeof m.replaces === "string" && REPLACES_SLOTS.has(m.replaces);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/plugins.test.js`
Expected: PASS, and no existing test in this file regresses.

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins.ts server/test/plugins.test.js
git commit -m "feat(plugins): accept a widget-kind manifest alongside panel plugins"
```

---

### Task 2: Dashboard persistence helpers

**Files:**
- Modify: `server/src/plugins.ts` (add near `readDevOverrides`/`setDevOverride`, lines 152-189)
- Test: `server/test/plugins.test.js`

**Interfaces:**
- Consumes: `isPlainSlug` (already in this file, Task 1 unchanged it).
- Produces: `readDashboardSlugs(pluginsRoot: string): string[]`, `writeDashboardSlugs(pluginsRoot: string, slugs: string[]): boolean` (returns `false`, and does not write, if any slug fails `isPlainSlug`).

- [ ] **Step 1: Write the failing tests**

Add to `server/test/plugins.test.js`:

```js
describe("dashboard slug persistence", () => {
	test("returns an empty list when no dashboard file exists yet", () => {
		withTempPluginsRoot((root) => {
			assert.deepEqual(readDashboardSlugs(root), []);
		});
	});

	test("a write/read round-trip preserves order", () => {
		withTempPluginsRoot((root) => {
			assert.equal(writeDashboardSlugs(root, ["cost-trend", "latency-p95"]), true);
			assert.deepEqual(readDashboardSlugs(root), ["cost-trend", "latency-p95"]);
		});
	});

	test("a malformed dashboard file reads back as an empty list, never throws", () => {
		withTempPluginsRoot((root) => {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "analytics-dashboard.json"), "{not json");
			assert.doesNotThrow(() => readDashboardSlugs(root));
			assert.deepEqual(readDashboardSlugs(root), []);
		});
	});

	test("writing a slug that fails isPlainSlug is rejected and nothing is written", () => {
		withTempPluginsRoot((root) => {
			assert.equal(writeDashboardSlugs(root, ["cost-trend", "../escape"]), false);
			assert.deepEqual(readDashboardSlugs(root), []);
		});
	});
});
```

Add `readDashboardSlugs, writeDashboardSlugs` to this test file's existing `import { ... } from "../dist/plugins.js"` block (alongside `isPlainSlug` etc.).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/plugins.test.js`
Expected: FAIL — `readDashboardSlugs`/`writeDashboardSlugs` are not exported yet (build error or `undefined is not a function`).

- [ ] **Step 3: Implement**

In `server/src/plugins.ts`, add near the `dev-overrides.json` helpers (after `setDevOverride`, ~line 189):

```ts
function dashboardPath(pluginsRoot: string): string {
	return join(pluginsRoot, "analytics-dashboard.json");
}

/** The persisted, ordered list of widget slugs on the Analytics dashboard. Never throws -- a
 * missing or malformed file (or a non-array/non-string entry) reads back as []. Does NOT filter
 * against what's actually installed/compatible -- server.ts's dashboardSlugsView does that, the
 * same way pluginsBySlot filters listInstalledPlugins for the panel pickers. */
export function readDashboardSlugs(pluginsRoot: string): string[] {
	try {
		const raw = readFileSync(dashboardPath(pluginsRoot), "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((s): s is string => typeof s === "string" && isPlainSlug(s));
	} catch {
		return [];
	}
}

/** Persists `slugs` as the dashboard's full ordered list, replacing whatever was there. Refuses
 * (returns false, writes nothing) if any slug fails isPlainSlug -- the same guard every other
 * slug-to-filesystem-path use in this module applies. */
export function writeDashboardSlugs(pluginsRoot: string, slugs: string[]): boolean {
	if (!slugs.every(isPlainSlug)) return false;
	mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
	writeFileSync(dashboardPath(pluginsRoot), JSON.stringify(slugs, null, 2));
	return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/plugins.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins.ts server/test/plugins.test.js
git commit -m "feat(plugins): persist the analytics dashboard's widget slug list"
```

---

### Task 3: `GET`/`PUT /api/v1/dashboard/analytics`

**Files:**
- Modify: `server/src/server.ts` (add helper near `pluginsBySlot`, lines 110-123; add routes after the existing `/api/v1/analytics` block, lines 377-384)
- Create: `server/test/fixtures/sample-widget/tether-plugin.json`, `server/test/fixtures/sample-widget/dist/index.html`
- Test: `server/test/server.test.js`

**Interfaces:**
- Consumes: `listInstalledPlugins`, `readDashboardSlugs`, `writeDashboardSlugs` (Tasks 1-2), `readBody` (already imported in `server.ts`, used by `POST /traces`), `sendError` (`server.ts:63`).
- Produces: `GET /api/v1/dashboard/analytics` → `200 { slugs: string[] }`; `PUT /api/v1/dashboard/analytics` with body `{ slugs: string[] }` → `200 { slugs: string[] }` (the same filtered shape, re-read after write) or `400 { ok: false, error }` for a malformed body or an invalid slug.

- [ ] **Step 1: Create the fixture widget plugin**

`server/test/fixtures/sample-widget/tether-plugin.json`:

```json
{
	"name": "Sample Widget",
	"slug": "sample-widget",
	"version": "1.0.0",
	"author": "test-fixture",
	"description": "A minimal fixture widget for server route tests.",
	"entry": "dist/index.html",
	"kind": "widget",
	"size": "medium",
	"tetherApiVersion": 1
}
```

`server/test/fixtures/sample-widget/dist/index.html`:

```html
<!doctype html>
<title>Sample Widget</title>
<p id="marker">sample widget content</p>
```

- [ ] **Step 2: Write the failing tests**

Add to `server/test/server.test.js`, alongside the existing `makeFixturePluginsRoot` helper add a second one (or extend it to accept which fixture(s) to copy — simplest is a second helper so the existing one and its callers are untouched):

```js
function makeWidgetFixturePluginsRoot() {
	const root = mkdtempSync(join(tmpdir(), "tether-plugins-fixture-"));
	cpSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-widget"), join(root, "sample-widget"), { recursive: true });
	return root;
}
```

```js
describe("GET/PUT /api/v1/dashboard/analytics", () => {
	test("GET on an empty store returns an empty slug list", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { slugs: [] });
		});
	});

	test("PUT persists a slug and GET reflects it", async () => {
		const pluginsRoot = makeWidgetFixturePluginsRoot();
		await withServer(async ({ port }) => {
			const put = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slugs: ["sample-widget"] }),
			});
			assert.equal(put.status, 200);
			assert.deepEqual(await put.json(), { slugs: ["sample-widget"] });
			const get = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`);
			assert.deepEqual(await get.json(), { slugs: ["sample-widget"] });
		}, { pluginsRoot });
	});

	test("GET drops a persisted slug that is no longer installed", async () => {
		const pluginsRoot = makeWidgetFixturePluginsRoot();
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slugs: ["sample-widget", "never-installed"] }),
			});
			const get = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`);
			assert.deepEqual(await get.json(), { slugs: ["sample-widget"] });
		}, { pluginsRoot });
	});

	test("PUT rejects a malformed body", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slugs: "not-an-array" }),
			});
			assert.equal(res.status, 400);
		});
	});

	test("PUT rejects a slug that fails isPlainSlug and persists nothing", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slugs: ["../escape"] }),
			});
			assert.equal(res.status, 400);
			const get = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/analytics`);
			assert.deepEqual(await get.json(), { slugs: [] });
		});
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run build && node --test test/server.test.js`
Expected: FAIL — the routes don't exist yet, every request in these tests currently 404s via the server's final `sendError(res, 404, "not found")`.

- [ ] **Step 4: Implement**

In `server/src/server.ts`, add the import (extend the existing `plugins.js` import on line 23):

```ts
import { resolvePluginAssetPath, contentTypeFor, readDevOverrides, listInstalledPlugins, readDashboardSlugs, writeDashboardSlugs } from "./plugins.js";
```

Add a helper near `pluginsBySlot` (after line 123):

```ts
/** GET's response shape, and what PUT returns after a successful write: the persisted slug list,
 * filtered to widgets that are still installed and version-compatible -- a slug for a plugin
 * that's since been removed or gone incompatible is silently dropped, never surfaced as an error,
 * matching plugins.ts's existing "missing manifest = skip" convention. */
function dashboardSlugsView(pluginsRoot: string): { slugs: string[] } {
	const bySlug = new Map(listInstalledPlugins(pluginsRoot).map((p) => [p.slug, p]));
	const slugs = readDashboardSlugs(pluginsRoot).filter((slug) => {
		const p = bySlug.get(slug);
		return !!p && p.compatible && p.kind === "widget";
	});
	return { slugs };
}
```

Add the two routes right after the existing `GET /api/v1/analytics` block (after line 384):

```ts
if (req.method === "GET" && pathname === "/api/v1/dashboard/analytics") {
	try {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(dashboardSlugsView(pluginsRoot)));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}

if (req.method === "PUT" && pathname === "/api/v1/dashboard/analytics") {
	try {
		const bodyText = await readBody(req);
		const parsed = JSON.parse(bodyText);
		const slugs = (parsed as { slugs?: unknown })?.slugs;
		if (!Array.isArray(slugs) || !slugs.every((s) => typeof s === "string")) {
			sendError(res, 400, "body must be { slugs: string[] }");
			return;
		}
		if (!writeDashboardSlugs(pluginsRoot, slugs)) {
			sendError(res, 400, "one or more slugs are invalid");
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(dashboardSlugsView(pluginsRoot)));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test test/server.test.js`
Expected: PASS, and no existing test in this file regresses.

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/server.test.js server/test/fixtures/sample-widget
git commit -m "feat(server): add GET/PUT /api/v1/dashboard/analytics"
```

---

### Task 4: Server-rendered widget picker/grid markup

**Files:**
- Modify: `server/src/templates/analytics.ts` (`renderAnalyticsBody`), `server/src/templates/shell.ts` (`PLUGIN_STYLES`, ~lines 259-262), `server/src/server.ts` (both `renderAnalyticsBody` call sites: line 268 and ~line 495; add a `widgetOptions` helper near `pluginsBySlot`)
- Test: `server/test/analytics-page.test.js`

**Interfaces:**
- Produces: `WidgetOption { slug: string; name: string; entry: string; size: "small" | "medium" | "large" }` (exported from `templates/analytics.ts`); `renderAnalyticsBody(usage: UsageView, widgets: WidgetOption[] = [])`.
- Consumes (in `server.ts`): `InstalledPlugin` (Task 1's `kind`/`size` fields), `listInstalledPlugins`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/analytics-page.test.js`:

```js
function widget(overrides = {}) {
	return { slug: "cost-trend", name: "Cost Trend", entry: "dist/index.html", size: "medium", ...overrides };
}

describe("renderAnalyticsBody widget dashboard", () => {
	test("renders no widget section at all when no widgets are installed", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] });
		assert.equal(html.includes("addWidgetPicker"), false);
		assert.equal(html.includes("widgetGrid"), false);
	});

	test("renders an add-widget picker option and an empty grid container per installed widget", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] }, [widget()]);
		assert.match(html, /id="addWidgetPicker"/);
		assert.match(html, /id="widgetGrid"/);
		assert.match(html, /value="cost-trend"/);
		assert.match(html, /data-entry="dist\/index\.html"/);
		assert.match(html, /data-size="medium"/);
		assert.match(html, />Cost Trend</);
	});

	test("escapes a widget name containing HTML", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] }, [widget({ name: "<script>alert(1)</script>" })]);
		assert.equal(html.includes("<script>alert(1)</script>"), false);
		assert.match(html, /&lt;script&gt;/);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/analytics-page.test.js`
Expected: FAIL — `renderAnalyticsBody` currently ignores a second argument and never emits `addWidgetPicker`/`widgetGrid`.

- [ ] **Step 3: Implement**

In `server/src/templates/analytics.ts`, add the type and extend the function (replace lines 26-27 and the closing of the function, ~line 27-43):

```ts
export interface WidgetOption {
	slug: string;
	name: string;
	entry: string;
	size: "small" | "medium" | "large";
}

function widgetDashboard(widgets: WidgetOption[]): string {
	if (widgets.length === 0) return "";
	const opts = widgets
		.map((w) => `<option value="${escapeHtml(w.slug)}" data-entry="${escapeHtml(w.entry)}" data-size="${escapeHtml(w.size)}">${escapeHtml(w.name)}</option>`)
		.join("");
	return `<section class="widget-dashboard">
		<div class="widget-dashboard-head">
			<h2>Widgets</h2>
			<select id="addWidgetPicker" class="plugin-picker"><option value="">Add widget…</option>${opts}</select>
		</div>
		<div id="widgetGrid" class="widget-grid"></div>
	</section>`;
}

/** The analytics panel's body -- store-wide, no traceId. `widgets` is every installed,
 * version-compatible kind:"widget" plugin (server.ts's widgetOptions()) -- which of them are
 * actually on the dashboard right now is client-side state (app.ts's initWidgetDashboard), fetched
 * separately from GET /api/v1/dashboard/analytics after this HTML has mounted. */
export function renderAnalyticsBody(usage: UsageView, widgets: WidgetOption[] = []): string {
	const skills = usage.entries.filter((e) => e.type === "skill");
	const subAgents = usage.entries.filter((e) => e.type === "sub_agent");
	const mcpServers = usage.entries.filter((e) => e.type === "mcp_server");

	if (usage.totalRuns === 0) return `<p class="empty">No runs yet.</p>` + widgetDashboard(widgets);
	if (usage.trackedRuns === 0) {
		return (
			`<p class="empty">No runs have reported skill/sub-agent/MCP-server usage yet — coverage tracking requires trail_log_step calls with source_type/source_name set.</p>` +
			widgetDashboard(widgets)
		);
	}
	if (usage.entries.length === 0) {
		return `<p class="empty">No skills, sub-agents, or MCP servers have been registered by any run.</p>` + widgetDashboard(widgets);
	}

	const untracked = usage.totalRuns - usage.trackedRuns;
	const note = untracked > 0 ? `<p class="note">${untracked} run(s) have no coverage tracking (excluded from the counts below).</p>` : "";
	return `<p class="as-of">Usage across ${usage.totalRuns} run(s)</p>
	${note}
	${section("Skills", skills, "No skills registered by any run.")}
	${section("Sub-agents", subAgents, "No sub-agents registered by any run.")}
	${section("MCP servers", mcpServers, "No MCP servers registered by any run.")}
	${widgetDashboard(widgets)}`;
}
```

(Every existing early-return branch now also appends `widgetDashboard(widgets)`, so the widget grid still shows up even on an otherwise-empty analytics store — this matches the spec: the grid's presence depends only on whether any widget plugin is installed, not on whether there's trace data yet.)

In `server/src/templates/shell.ts`, extend `PLUGIN_STYLES` (lines 259-262) — this block is always included in every response (`STYLE` is unconditional; unlike `PLUGIN_STYLES`, which only loads when a panel plugin exists in `pluginsBySlot` — a widget-only install wouldn't set that flag, so put these three rules in `STYLE` instead, right after the existing `.card` rule at line 100, so they load unconditionally):

```css
.widget-dashboard { margin-top: 16px; }
.widget-dashboard-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.widget-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.widget-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.widget-card-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; font-size: 12.5px; font-weight: 600; border-bottom: 1px solid var(--line); }
.widget-remove { font: inherit; color: var(--ink-3); background: transparent; border: 0; cursor: pointer; font-size: 15px; line-height: 1; }
.widget-frame { width: 100%; height: 240px; border: 0; display: block; }
.widget-cell-small.widget-card, .widget-cell-medium.widget-card { grid-column: span 1; }
.widget-cell-large.widget-card { grid-column: span 2; }
```

In `server/src/server.ts`:

Change line 20 from:

```ts
import { renderAnalyticsBody } from "./templates/analytics.js";
```

to:

```ts
import { renderAnalyticsBody } from "./templates/analytics.js";
import type { WidgetOption } from "./templates/analytics.js";
```

Add a helper near `pluginsBySlot` (after `dashboardSlugsView` from Task 3):

```ts
/** Every installed, version-compatible kind:"widget" plugin, in the shape renderAnalyticsBody's
 * picker needs -- the analytics-view analog of pluginsBySlot for panel plugins. */
function widgetOptions(pluginsRoot: string): WidgetOption[] {
	return listInstalledPlugins(pluginsRoot)
		.filter((p) => p.compatible && p.kind === "widget")
		.map((p) => ({ slug: p.slug, name: p.name, entry: p.entry, size: p.size as WidgetOption["size"] }));
}
```

Update both `renderAnalyticsBody` call sites to pass it:
- Line 268 (`/fragments/analytics` route): `renderAnalyticsBody(getUsage(db), widgetOptions(pluginsRoot))`
- ~Line 495 (full-page render): `renderAnalyticsBody(getUsage(db), widgetOptions(pluginsRoot))`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/analytics-page.test.js test/server.test.js test/shell.test.js`
Expected: PASS, and no existing test regresses (in particular `shell.test.js`'s existing CSS/style assertions, if any — check its output for a snapshot-style match on `STYLE` and adjust only if a test literally pins the full stylesheet string; adding rules should not break substring/structural assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/templates/analytics.ts server/src/templates/shell.ts server/src/server.ts server/test/analytics-page.test.js
git commit -m "feat(analytics): render the add-widget picker and grid container"
```

---

### Task 5: Client-side widget mounting, add/remove, persistence

**Files:**
- Modify: `server/src/static/app.ts` (add functions near `mountPluginFrame`/`onPluginPickerChange`, ~lines 397-417; wire into `navigateTo`'s analytics branch, ~line 501-503; wire into `init()`, ~line 557)
- Test: `server/test/app.test.js`

**Interfaces:**
- Consumes: `GET /api/v1/dashboard/analytics` → `{ slugs: string[] }`, `PUT /api/v1/dashboard/analytics` (Task 3); the server-rendered `#addWidgetPicker` `<select>` and `#widgetGrid` `<div>` (Task 4), where each `<option>` carries `data-entry` and `data-size`.
- Produces: `initWidgetDashboard(): Promise<void>` — reachable in tests as `sandbox.initWidgetDashboard` via the existing `loadApp()` vm harness, same as every other top-level function in this file.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/app.test.js`. This needs a `<select>` fake that supports `.options`/`hidden` on options — extend the existing `FakeSelectElement` (it currently only tracks `_options`/`value`) minimally so a test can hand it real `<option>`-like objects; add a small `FakeOptionElement` and a way to seed the picker's options in a test, following the same "build a fake DOM node with just enough behavior" style already used for `FakeElement`/`FakeSelectElement`:

```js
class FakeOptionElement {
	constructor(value, text, dataset) {
		this.value = value;
		this.textContent = text;
		this.hidden = false;
		this._attrs = { "data-entry": dataset.entry, "data-size": dataset.size };
	}
	getAttribute(n) { return this._attrs[n] ?? null; }
}

function seedWidgetPicker(elements) {
	const picker = new FakeSelectElement("addWidgetPicker");
	picker.options = [
		new FakeOptionElement("", "Add widget…", {}),
		new FakeOptionElement("cost-trend", "Cost Trend", { entry: "dist/index.html", size: "medium" }),
	];
	elements.addWidgetPicker = picker;
	const grid = new FakeElement("widgetGrid");
	elements.widgetGrid = grid;
	return { picker, grid };
}
```

```js
describe("initWidgetDashboard", () => {
	test("does nothing when the analytics view has no widget grid/picker (e.g. Detail/Harness)", async () => {
		const { sandbox } = loadApp();
		await assert.doesNotReject(sandbox.initWidgetDashboard());
	});

	test("mounts one iframe per persisted slug, in order, and hides its picker option", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		windowStub.fetch = (url) =>
			Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: ["cost-trend"] }) });
		await sandbox.initWidgetDashboard();
		assert.equal(grid.children.length, 1);
		assert.equal(picker.options[1].hidden, true);
	});

	test("a stale persisted slug with no matching installed widget is skipped, not thrown", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { grid } = seedWidgetPicker(elements);
		windowStub.fetch = (url) =>
			Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: ["long-gone"] }) });
		await assert.doesNotReject(sandbox.initWidgetDashboard());
		assert.equal(grid.children.length, 0);
	});

	test("a fetch failure leaves the grid empty instead of throwing", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { grid } = seedWidgetPicker(elements);
		windowStub.fetch = () => Promise.reject(new Error("network down"));
		await assert.doesNotReject(sandbox.initWidgetDashboard());
		assert.equal(grid.children.length, 0);
	});

	test("choosing a widget in the picker adds it to the grid, hides its option, and PUTs the new list", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		const putCalls = [];
		windowStub.fetch = (url, opts) => {
			if (opts?.method === "PUT") { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200 }); }
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: [] }) });
		};
		await sandbox.initWidgetDashboard();
		picker.value = "cost-trend";
		picker._listeners.change[0]();
		assert.equal(grid.children.length, 1);
		assert.equal(picker.options[1].hidden, true);
		assert.deepEqual(putCalls[putCalls.length - 1], { slugs: ["cost-trend"] });
	});

	test("clicking a widget card's remove button removes it from the grid, unhides its option, and PUTs the new list", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		const putCalls = [];
		windowStub.fetch = (url, opts) => {
			if (opts?.method === "PUT") { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200 }); }
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: ["cost-trend"] }) });
		};
		await sandbox.initWidgetDashboard();
		assert.equal(grid.children.length, 1);
		const removeBtn = grid.children[0].children[0].children[0];
		removeBtn._listeners.click[0]();
		assert.equal(grid.children.length, 0);
		assert.equal(picker.options[1].hidden, false);
		assert.deepEqual(putCalls[putCalls.length - 1], { slugs: [] });
	});
});
```

Also add (near the existing `FakeElement.appendChild`) whatever's missing for `document.createElement` to hand back distinguishable, inspectable nodes for the widget card's head/button/iframe — the existing `documentStub.createElement: () => new FakeElement(null)` (line 90) already returns a fresh `FakeElement` on every call, and `FakeElement` already supports `appendChild`/`addEventListener`/`setAttribute`/`className`, so no harness change is needed there — only the two additions above (`FakeOptionElement`, `seedWidgetPicker`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/app.test.js`
Expected: FAIL — `sandbox.initWidgetDashboard` is `undefined`.

- [ ] **Step 3: Implement**

In `server/src/static/app.ts`, add near `mountPluginFrame`/`onPluginPickerChange` (after line 417):

```ts
interface DashboardResponse {
	slugs: string[];
}

function widgetGridSpanClass(size: string): string {
	return size === "large" ? "widget-cell-large" : size === "small" ? "widget-cell-small" : "widget-cell-medium";
}

function buildWidgetCard(slug: string, name: string, entry: string, size: string, onRemove: (slug: string) => void): HTMLElement {
	const card = document.createElement("div") as HTMLDivElement;
	card.className = `widget-card ${widgetGridSpanClass(size)}`;
	const head = document.createElement("div") as HTMLDivElement;
	head.className = "widget-card-head";
	head.textContent = name;
	const removeBtn = document.createElement("button") as HTMLButtonElement;
	removeBtn.setAttribute("type", "button");
	removeBtn.className = "widget-remove";
	removeBtn.setAttribute("aria-label", `Remove ${name}`);
	removeBtn.textContent = "×";
	removeBtn.addEventListener("click", () => onRemove(slug));
	head.appendChild(removeBtn);
	const iframe = document.createElement("iframe") as HTMLIFrameElement;
	iframe.className = "plugin-frame widget-frame";
	iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
	iframe.src = `/plugins/${encodeURIComponent(slug)}/${entry}`;
	card.appendChild(head);
	card.appendChild(iframe);
	return card;
}

async function saveDashboardSlugs(slugs: string[]): Promise<void> {
	try {
		await window.fetch("/api/v1/dashboard/analytics", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slugs }),
		});
	} catch {
		// Best-effort -- the in-memory grid is still correct even if the save failed; the next
		// page load falls back to whatever was last persisted successfully.
	}
}

async function initWidgetDashboard(): Promise<void> {
	const grid = document.getElementById("widgetGrid") as HTMLDivElement | null;
	const picker = document.getElementById("addWidgetPicker") as HTMLSelectElement | null;
	if (!grid || !picker) return;

	const optionsBySlug = new Map<string, HTMLOptionElement>();
	Array.from(picker.options).forEach((o) => {
		if (o.value) optionsBySlug.set(o.value, o);
	});
	const cardsBySlug = new Map<string, HTMLElement>();

	function removeWidget(slug: string): void {
		const card = cardsBySlug.get(slug);
		if (card) {
			card.remove();
			cardsBySlug.delete(slug);
		}
		const option = optionsBySlug.get(slug);
		if (option) option.hidden = false;
		saveDashboardSlugs(Array.from(cardsBySlug.keys()));
	}

	function addWidget(slug: string): boolean {
		if (cardsBySlug.has(slug)) return false;
		const option = optionsBySlug.get(slug);
		if (!option) return false; // stale/uninstalled -- silently skip, matches the server's own skip convention
		const entry = option.getAttribute("data-entry") ?? "";
		const size = option.getAttribute("data-size") ?? "medium";
		const card = buildWidgetCard(slug, option.textContent ?? slug, entry, size, removeWidget);
		grid.appendChild(card);
		cardsBySlug.set(slug, card);
		option.hidden = true;
		return true;
	}

	let persisted: string[] = [];
	try {
		const res = await window.fetch("/api/v1/dashboard/analytics");
		if (res.ok) persisted = ((await res.json()) as DashboardResponse).slugs;
	} catch {
		persisted = [];
	}
	persisted.forEach(addWidget);

	picker.addEventListener("change", () => {
		const slug = picker.value;
		if (slug === "") return;
		if (addWidget(slug)) saveDashboardSlugs(Array.from(cardsBySlug.keys()));
		picker.value = "";
	});
}
```

Wire it into `navigateTo`'s analytics branch — in the `else` block at ~lines 501-503:

```ts
} else {
	document.title = "Tether — Analytics";
	void initWidgetDashboard();
}
```

Wire it into `init()` — after line 557 (`if (currentState.view === "detail") mountRunDataIfPresent();`):

```ts
if (currentState.view === "detail") mountRunDataIfPresent();
if (currentState.view === "analytics") void initWidgetDashboard();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/app.test.js`
Expected: PASS, and no existing test in this file regresses.

- [ ] **Step 5: Run the full suite**

Run (from `server/`): `npm test`
Expected: every test file passes — this is the first point every task's pieces run together end to end.

- [ ] **Step 6: Commit**

```bash
git add server/src/static/app.ts server/test/app.test.js
git commit -m "feat(client): mount, add, and remove analytics widgets from a persisted dashboard"
```

---

### Task 6: Document the widget manifest fields and endpoints

**Files:**
- Modify: `server/README.md` (the "Plugins" section — the `tether-plugin.json` field table and the "What a plugin can read" endpoint list)

**Interfaces:**
- Consumes: nothing — documentation only, no code.

- [ ] **Step 1: Update the manifest field table**

In `server/README.md`'s `### \`tether-plugin.json\` (plugin repo root)` table, add two rows after the existing `replaces` row:

```markdown
| `kind` | no | `"panel"` (default) or `"widget"`. A panel replaces one of the three slots above (see `replaces`); a widget is a smaller card on the Analytics dashboard (see below) and has no `replaces`. |
| `size` | only for `kind: "widget"` | `"small" \| "medium" \| "large"` — the widget's footprint in the Analytics dashboard's grid. |
```

Update the existing `replaces` row's "Required" column from "yes" to "only for `kind: \"panel\"` (the default)".

- [ ] **Step 2: Document the Analytics widget dashboard and its endpoints**

Add a new subsection after the existing "What a plugin can read" section:

```markdown
### Analytics widgets

A plugin with `"kind": "widget"` in its manifest mounts as a small card in a grid on the
Analytics view instead of replacing the whole view — several widgets from different plugins can
be on the dashboard at once. Installed the same way as any plugin (`plugin add`); which widgets
are currently on the dashboard is picked via the "Add widget" control on the Analytics view itself,
and persisted server-side:

- `GET /api/v1/dashboard/analytics` — `{ "slugs": string[] }`, the ordered list of widget slugs
  currently on the dashboard (filtered to widgets that are still installed and version-compatible).
- `PUT /api/v1/dashboard/analytics` — body `{ "slugs": string[] }`, replaces the list wholesale.

A widget plugin reads data the same way a full-panel Analytics plugin does — `GET /api/v1/analytics`
— there is no separate widget-specific data API.
```

- [ ] **Step 3: Commit**

```bash
git add server/README.md
git commit -m "docs(plugins): document the widget kind and dashboard endpoints"
```

---

## After Task 5

Manual e2e (per the spec's §3.6): build (`npm run build` in `server/`), start the server (`node dist/index.js` or `npm start`), install a real widget plugin fixture via `plugin add` (or symlink a local dir + `plugin dev` for iteration), confirm it appears in the Analytics view's "Add widget" picker, add it, reload the page, confirm it's still there in the same position, remove it, reload, confirm it's gone.
