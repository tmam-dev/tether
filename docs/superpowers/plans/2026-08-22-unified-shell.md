# Unified Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tether's four independently-routed, full-page-reload views (run list, Flight Recorder, harness anatomy, analytics) with one persistent shell — a left run rail plus a swappable content panel — navigated by a small vanilla-JS client router with no full page reload.

**Architecture:** Three panels (rail, harness, analytics) stay server-rendered HTML, split into a `renderXBody` function reused by both the shell's initial page render and a matching `/fragments/*` route the client router fetches. The fourth panel (Detail/Flight Recorder) already renders client-side from embedded JSON today; its ~250-line inline script is relocated (not rewritten) into a new `server/src/static/app.ts`, compiled by the existing `tsc` build alongside everything else, and loaded once as `/app.js` instead of re-executing on every page load. No JSON API is added — the one new "data fragment" (`/fragments/detail/:traceId`) exists solely to feed the relocated Detail-mounting function.

**Tech Stack:** Same as the rest of the repo — TypeScript/`tsc`, `better-sqlite3`, `node:http`, `node --test`, zero new dependencies, zero bundler/build step beyond `tsc` (browser code is authored directly as `server/src/static/app.ts` and compiles straight to `dist/static/app.js` since it needs no imports at runtime).

**Spec:** `docs/superpowers/specs/2026-08-22-unified-shell-design.md`

## Global Constraints

- No new dependencies, no bundler.
- Tabs indentation, matching every existing file.
- `server/` tests import from `../dist/*.js`, never `../src/*.ts`.
- Every reshape/render function degrades gracefully (never throws) on malformed input, matching `runs.ts`/`harness.ts`/`coverage.ts`/`analytics.ts`'s established contract.
- Every user-controlled string reaching the DOM is escaped — server-side via each file's own copied `escapeHtml` (`&<>"'`), or client-side exactly where the existing Flight Recorder code already escaped it (unchanged, just relocated).
- `Content-Type: text/html; charset=utf-8` on every HTML route/fragment; `text/javascript; charset=utf-8` on `/app.js`.
- Client-side navigation is progressive enhancement — every URL must still work as a real, direct, no-JS page load.

---

### Task 1: `server/src/templates/rail.ts` — the run rail

**Files:**
- Create: `server/src/templates/rail.ts`
- Test: `server/test/rail.test.js`

**Interfaces:**
- Produces: `formatRelativeTime(startedAtIso: string, nowMs: number): string`, `renderRailBody(runs: RunSummary[], activeTraceId: string | undefined, nowMs: number): string` — both consumed by Task 8 (`server.ts`'s routes, which call `renderRailBody` on every request; the client re-fetches the same output via `/fragments/rail` for polling, per Task 7's router).

- [ ] **Step 1: Write the failing tests**

Create `server/test/rail.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime, renderRailBody } from "../dist/templates/rail.js";

function run(overrides = {}) {
	return { traceId: "t".repeat(32), goal: "do the thing", verdict: "met", dur: "10s", startedAt: "2026-08-22T10:00:00.000Z", ...overrides };
}

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-08-22T12:00:00.000Z");

	test("under a minute reads 'just now'", () => {
		assert.equal(formatRelativeTime("2026-08-22T11:59:45.000Z", now), "just now");
	});
	test("minutes ago", () => {
		assert.equal(formatRelativeTime("2026-08-22T11:55:00.000Z", now), "5m ago");
	});
	test("hours ago", () => {
		assert.equal(formatRelativeTime("2026-08-22T09:00:00.000Z", now), "3h ago");
	});
	test("days ago", () => {
		assert.equal(formatRelativeTime("2026-08-19T12:00:00.000Z", now), "3d ago");
	});
	test("30 days or more falls back to the plain date", () => {
		assert.equal(formatRelativeTime("2026-01-01T12:00:00.000Z", now), "2026-01-01");
	});
	test("a malformed timestamp never throws, returns the raw string", () => {
		assert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
	});
	test("a future timestamp (clock skew) falls back to the plain date, not a negative duration", () => {
		assert.equal(formatRelativeTime("2026-08-23T12:00:00.000Z", now), "2026-08-23");
	});
});

describe("renderRailBody", () => {
	test("an empty store shows an empty message", () => {
		assert.match(renderRailBody([], undefined, Date.now()), /No runs yet/);
	});

	test("marks the active run's row and not others", () => {
		const active = run({ traceId: "a".repeat(32), goal: "active one" });
		const other = run({ traceId: "b".repeat(32), goal: "other one" });
		const html = renderRailBody([active, other], "a".repeat(32), Date.now());
		const activeIdx = html.indexOf("active one");
		const otherIdx = html.indexOf("other one");
		const activeRowStart = html.lastIndexOf("<a", activeIdx);
		const otherRowStart = html.lastIndexOf("<a", otherIdx);
		assert.match(html.slice(activeRowStart, activeIdx), /rail-row-active/);
		assert.doesNotMatch(html.slice(otherRowStart, otherIdx), /rail-row-active/);
	});

	test("no run is marked active when activeTraceId is undefined", () => {
		const html = renderRailBody([run()], undefined, Date.now());
		assert.doesNotMatch(html, /rail-row-active/);
	});

	test("escapes an XSS goal", () => {
		const html = renderRailBody([run({ goal: "<script>alert(1)</script>" })], undefined, Date.now());
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("an unrecognized verdict falls back to the 'unjudged' dot color and label", () => {
		const html = renderRailBody([run({ verdict: "totally-bogus" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("each row links to the run's detail page", () => {
		const html = renderRailBody([run({ traceId: "c".repeat(32) })], undefined, Date.now());
		assert.match(html, new RegExp(`href="/runs/${"c".repeat(32)}"`));
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/templates/rail.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/templates/rail.ts`**

```ts
import type { RunSummary } from "../runs.js";

const VERDICT_COLOR: Record<string, string> = { met: "#2FA24A", partial: "#C08810", failed: "#DC4A38", unjudged: "#8A8F97" };
const VERDICT_LABEL: Record<string, string> = { met: "Goal met", partial: "Partial", failed: "Goal missed", unjudged: "Not judged" };

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/rail.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/rail.ts test/rail.test.js
git commit -m "feat(server): add the run rail template"
```

---

### Task 2: `server/src/templates/shell.ts` — the persistent shell

**Files:**
- Create: `server/src/templates/shell.ts`
- Test: `server/test/shell.test.js`

**Interfaces:**
- Consumes: nothing from other new files (only types).
- Produces: `ShellView` (`"detail" | "harness" | "analytics"`), `ShellState` (`{ view: ShellView; traceId?: string }`), `renderNotFoundPanel(): string`, `renderShell(state: ShellState, title: string, railHtml: string, panelHtml: string): string` — all consumed by Task 8 (`server.ts`).

- [ ] **Step 1: Write the failing tests**

Create `server/test/shell.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderShell, renderNotFoundPanel } from "../dist/templates/shell.js";

describe("renderNotFoundPanel", () => {
	test("returns a plain not-found message", () => {
		assert.match(renderNotFoundPanel(), /Run not found/);
	});
});

describe("renderShell", () => {
	test("escapes the title", () => {
		const html = renderShell({ view: "detail", traceId: "a".repeat(32) }, "<script>alert(1)</script>", "", "");
		assert.doesNotMatch(html, /<title><script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("embeds the rail and panel HTML verbatim inside their mount points", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "RAIL_MARKER", "PANEL_MARKER");
		assert.match(html, /<div id="rail">RAIL_MARKER<\/div>/);
		assert.match(html, /<main id="content">PANEL_MARKER<\/main>/);
	});

	test("Harness tab is disabled when no traceId is selected", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(html, /tab-disabled/);
		assert.doesNotMatch(html, /href="\/runs\/[^"]+\/harness"/);
	});

	test("Harness tab links to the selected run's harness page and is marked active on the harness view", () => {
		const html = renderShell({ view: "harness", traceId: "b".repeat(32) }, "Tether", "", "");
		assert.match(html, new RegExp(`href="/runs/${"b".repeat(32)}/harness"[^>]*class="tab tab-active"|class="tab tab-active"[^>]*href="/runs/${"b".repeat(32)}/harness"`));
	});

	test("Analytics tab is marked active on the analytics view", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(html, /href="\/analytics" data-nav="analytics" class="tab tab-active"|class="tab tab-active" href="\/analytics"/);
	});

	test("bootstraps window.__TETHER_INITIAL__ with the view and traceId (null when absent)", () => {
		const withRun = renderShell({ view: "detail", traceId: "c".repeat(32) }, "Tether", "", "");
		assert.match(withRun, new RegExp(`__TETHER_INITIAL__ = \\{"view":"detail","traceId":"${"c".repeat(32)}"\\}`));
		const noRun = renderShell({ view: "analytics" }, "Tether", "", "");
		assert.match(noRun, /__TETHER_INITIAL__ = \{"view":"analytics","traceId":null\}/);
	});

	test("loads the client router", () => {
		assert.match(renderShell({ view: "analytics" }, "Tether", "", ""), /<script src="\/app\.js" defer><\/script>/);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/templates/shell.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/templates/shell.ts`**

```ts
export type ShellView = "detail" | "harness" | "analytics";

export interface ShellState {
	view: ShellView;
	traceId?: string;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Shown in `#content` for any unknown traceId, both as a full shell-wrapped page (direct
 * navigation) and as a raw fragment body (client-side navigation via /fragments/*). */
export function renderNotFoundPanel(): string {
	return `<p class="empty">Run not found.</p>`;
}

const STYLE = `
	:root {
		--bg: #F7F6F2; --panel: #FFFFFF; --panel-2: #FBFAF7; --line: #E6E3DB; --line-strong: #D6D2C7;
		--ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
		--accent: #0FA6B4; --accent-ink: #0B7C87; --accent-wash: rgba(15,166,180,0.10);
		--met: #2FA24A; --partial: #C08810; --failed: #DC4A38; --stuck: #E0761A;
		--met-wash: rgba(47,162,74,0.12); --partial-wash: rgba(192,136,16,0.12); --failed-wash: rgba(220,74,56,0.12);
		--stuck-wash: rgba(224,118,26,0.15);
		--shadow: 0 1px 2px rgba(20,24,28,0.05), 0 8px 24px rgba(20,24,28,0.06);
		--radius: 12px;
		--mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Roboto Mono", monospace;
		--sans: -apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #0E1116; --panel: #161B22; --panel-2: #1A2029; --line: #262D38; --line-strong: #333C49;
			--ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683;
			--accent: #19C6D8; --accent-ink: #57DCEA; --accent-wash: rgba(25,198,216,0.12);
			--met: #3FB950; --partial: #D9A21B; --failed: #F0533F; --stuck: #F0871E;
			--met-wash: rgba(63,185,80,0.15); --partial-wash: rgba(217,162,27,0.15); --failed-wash: rgba(240,83,63,0.15);
			--stuck-wash: rgba(240,135,30,0.16);
			--shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.4);
		}
	}
	:root[data-theme="light"] {
		--bg: #F7F6F2; --panel: #FFFFFF; --panel-2: #FBFAF7; --line: #E6E3DB; --line-strong: #D6D2C7;
		--ink: #1B1F24; --ink-2: #565C64; --ink-3: #8A8F97;
		--accent: #0FA6B4; --accent-ink: #0B7C87; --accent-wash: rgba(15,166,180,0.10);
		--met: #2FA24A; --partial: #C08810; --failed: #DC4A38; --stuck: #E0761A;
		--met-wash: rgba(47,162,74,0.12); --partial-wash: rgba(192,136,16,0.12); --failed-wash: rgba(220,74,56,0.12);
		--stuck-wash: rgba(224,118,26,0.15);
		--shadow: 0 1px 2px rgba(20,24,28,0.05), 0 8px 24px rgba(20,24,28,0.06);
	}
	:root[data-theme="dark"] {
		--bg: #0E1116; --panel: #161B22; --panel-2: #1A2029; --line: #262D38; --line-strong: #333C49;
		--ink: #E8ECF1; --ink-2: #A3ACB8; --ink-3: #6C7683;
		--accent: #19C6D8; --accent-ink: #57DCEA; --accent-wash: rgba(25,198,216,0.12);
		--met: #3FB950; --partial: #D9A21B; --failed: #F0533F; --stuck: #F0871E;
		--met-wash: rgba(63,185,80,0.15); --partial-wash: rgba(217,162,27,0.15); --failed-wash: rgba(240,83,63,0.15);
		--stuck-wash: rgba(240,135,30,0.16);
		--shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.4);
	}

	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

	.shell { display: flex; min-height: 100vh; }
	.rail-wrap { width: 260px; flex: none; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
	.rail-brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
	.rail-brand .brand-name { font-weight: 640; letter-spacing: -0.01em; font-size: 15px; }
	.rail-home { color: var(--ink-2); text-decoration: none; font-size: 15px; }
	.rail-home:hover { color: var(--ink); }
	#rail { flex: 1; overflow-y: auto; padding: 6px; }
	.rail-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; text-decoration: none; color: var(--ink); margin-bottom: 2px; }
	.rail-row:hover { background: var(--panel-2); }
	.rail-row-active { background: var(--accent-wash); }
	.rail-row-active .rail-goal { color: var(--accent-ink); }
	.rail-dot-goal { display: flex; align-items: center; gap: 7px; }
	.rail-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
	.rail-goal { font-size: 13px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rail-time { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); padding-left: 14px; }
	.rail-empty { color: var(--ink-3); font-size: 13px; padding: 10px; }

	.main-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.tabbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
	.tab { font-size: 12.5px; color: var(--ink-2); text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
	.tab:hover { color: var(--ink); border-color: var(--line-strong); }
	.tab-active { color: var(--accent-ink); border-color: var(--accent); background: var(--accent-wash); }
	.tab-disabled { color: var(--ink-3); opacity: 0.5; }
	.iconbtn { margin-left: auto; width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; display: grid; place-items: center; transition: background .15s, color .15s; }
	.iconbtn:hover { color: var(--ink); background: var(--panel-2); }
	#content { flex: 1; max-width: 1280px; width: 100%; margin: 0 auto; padding: 20px clamp(14px, 3vw, 28px) 64px; overflow-y: auto; }

	.empty { color: var(--ink-3); font-size: 13px; }
	.note { color: var(--ink-3); font-size: 12.5px; margin: 0 0 20px; }
	.as-of { color: var(--ink-2); font-size: 13px; margin: 0 0 10px; }
	.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 16px; }
	.card-head h2 { font-size: 14px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
	.card-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-weight: 400; }
	.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.entry { border-top: 1px solid var(--line); padding-top: 10px; }
	.entry:first-child { border-top: none; padding-top: 0; }
	.entry-name { font-weight: 600; font-size: 13.5px; }
	.entry-name .tag { font-weight: 400; font-size: 10.5px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 6px; }
	.tag-dead { color: var(--failed); border: 1px solid var(--failed); }
	.entry-desc { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
	.entry-tools { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; margin-top: 4px; }

	.mission { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: start; margin-bottom: 14px; }
	.goal-eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-3); display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
	.goal-eyebrow .agent-pill { color: var(--accent-ink); }
	.goal-title { font-size: clamp(18px, 2.4vw, 23px); font-weight: 620; letter-spacing: -0.015em; margin: 0; text-wrap: balance; line-height: 1.25; }
	.goal-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; }
	.gm { display: flex; flex-direction: column; gap: 1px; }
	.gm .k { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
	.gm .v { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }

	.verdict { min-width: 210px; display: flex; flex-direction: column; gap: 12px; }
	.verdict-badge { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 11px; border: 1px solid var(--vc-line); background: var(--vc-wash); }
	.verdict-badge .glyph { width: 30px; height: 30px; flex: none; color: var(--vc); }
	.verdict-badge .vt { display: flex; flex-direction: column; line-height: 1.15; }
	.verdict-badge .vt .lab { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
	.verdict-badge .vt .val { font-size: 18px; font-weight: 680; color: var(--vc); letter-spacing: -0.01em; }

	.pcredit { display: flex; align-items: center; gap: 12px; }
	.pcredit svg { transform: rotate(-90deg); flex: none; }
	.pc-num { font-family: var(--mono); font-size: 16px; font-weight: 680; fill: var(--vc); }
	.pcredit .pc-side { display: flex; flex-direction: column; gap: 6px; flex: 1; }
	.conf-row { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); }

	.trail-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px 12px; margin-bottom: 14px; }
	.transport { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
	.play-btn { width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer; flex: none; background: var(--accent); color: #05171A; display: grid; place-items: center; box-shadow: 0 4px 14px var(--accent-wash); transition: transform .12s; }
	:root[data-theme="light"] .play-btn { color: #fff; }
	.play-btn:hover { transform: scale(1.05); } .play-btn:active { transform: scale(0.96); }
	.clock { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink); min-width: 92px; letter-spacing: 0.02em; }
	.clock .sep { color: var(--ink-3); }
	.live-accrue { display: flex; gap: 14px; margin-left: auto; flex-wrap: wrap; }
	.accrue { display: flex; flex-direction: column; align-items: flex-end; }
	.accrue .k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
	.accrue .v { font-family: var(--mono); font-size: 14px; font-weight: 620; color: var(--ink); font-variant-numeric: tabular-nums; }
	.speeds { display: flex; gap: 3px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
	.speeds button { font: inherit; font-family: var(--mono); font-size: 11px; border: 0; background: transparent; color: var(--ink-3); padding: 3px 8px; border-radius: 6px; cursor: pointer; }
	.speeds button[aria-pressed="true"] { background: var(--accent-wash); color: var(--accent-ink); }

	.strip-shell { position: relative; }
	.strip { position: relative; height: 44px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; cursor: pointer; }
	.seg { position: absolute; top: 0; bottom: 0; border-right: 1px solid var(--panel); opacity: 0.55; transition: opacity .2s; }
	.seg.played { opacity: 1; }
	.seg.err { background-image: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.10) 4px, rgba(0,0,0,0.10) 8px); }
	.seg.current { box-shadow: inset 0 0 0 2px var(--accent); opacity: 1; }
	.cost-area { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; pointer-events: none; }
	.playhead { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--accent); box-shadow: 0 0 10px var(--accent); pointer-events: none; z-index: 3; }
	.playhead::before { content:""; position: absolute; top: -1px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }

	.signals { position: relative; height: 26px; margin-top: 5px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--line); }
	.sig-cap { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); pointer-events: none; z-index: 2; }
	.sig-m { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 15px; height: 15px; border-radius: 5px; display: grid; place-items: center; cursor: pointer; border: 1px solid var(--panel); transition: transform .1s; z-index: 3; }
	.sig-m:hover { transform: translate(-50%,-50%) scale(1.3); }
	.sig-m svg { width: 9px; height: 9px; }
	.axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--ink-3); margin-top: 6px; font-variant-numeric: tabular-nums; }

	.split { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 14px; align-items: start; }
	.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
	.panel-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
	.panel-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
	.panel-head .count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); margin-left: auto; font-variant-numeric: tabular-nums; }

	.steps { padding: 6px 8px 10px; max-height: 640px; overflow-y: auto; }
	.step { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: start; padding: 10px 10px; border-radius: 10px; cursor: pointer; position: relative; transition: background .13s; }
	.step:hover { background: var(--panel-2); }
	.step[aria-selected="true"] { background: var(--accent-wash); }
	.step[data-current="true"]::before { content:""; position: absolute; left: 2px; top: 12px; bottom: 12px; width: 3px; border-radius: 2px; background: var(--accent); }
	.step .rail { display: grid; place-items: center; }
	.step .tick { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--tc-wash); color: var(--tc); border: 1px solid transparent; }
	.step .tick svg { width: 16px; height: 16px; }
	.step .body .st-title { font-size: 13.5px; font-weight: 560; letter-spacing: -0.005em; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
	.step .body .st-title code { font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 0.5px 5px; color: var(--ink); }
	.step .meta { text-align: right; font-family: var(--mono); font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.5; }
	.stat-chip { font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; font-weight: 600; }
	.stat-ok { color: var(--met); background: var(--met-wash); }
	.stat-err { color: var(--failed); background: var(--failed-wash); }

	.sbadge { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10px; font-weight: 600; padding: 1px 6px 1px 4px; border-radius: 5px; letter-spacing: 0.02em; }
	.sbadge svg { width: 11px; height: 11px; }
	.sbadge.retry { color: var(--stuck); background: var(--stuck-wash); }

	.insp { padding: 14px 16px; }
	.insp-section + .insp-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
	.insp h3 { font-family: var(--mono); font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 9px; }
	.judge-quote { font-size: 14px; line-height: 1.55; color: var(--ink); }
	.judge-quote b { color: var(--vc); font-weight: 640; }

	.io-kind { font-family: var(--mono); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
	.io-block { background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
	.io-block + .io-kind { margin-top: 12px; }
	.io-sig { display: flex; align-items: flex-start; gap: 9px; border-radius: 9px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 12px; background: var(--panel-2); border: 1px solid var(--line); }
	.io-sig svg { width: 17px; height: 17px; flex: none; margin-top: 1px; }
	.io-sig .st { font-weight: 600; }
	.insp-empty { color: var(--ink-3); font-size: 13px; }
	.cov-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
	.cov-status { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; }
	.cov-status.cov-used { color: var(--met); }
	.pin-note { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--accent-ink); margin-bottom: 10px; }
	.pin-note button { font: inherit; color: var(--ink-3); background: transparent; border: 0; cursor: pointer; text-decoration: underline; margin-left: auto; }

	@media (max-width: 880px) {
		.mission { grid-template-columns: 1fr; }
		.verdict { min-width: 0; }
		.split { grid-template-columns: 1fr; }
		.steps { max-height: none; }
	}
	@media (prefers-reduced-motion: reduce) { * { transition: none !important; } .play-btn { display: none; } }
`;

function topbar(state: ShellState): string {
	const harnessTab = state.traceId
		? `<a class="tab${state.view === "harness" ? " tab-active" : ""}" href="/runs/${escapeHtml(state.traceId)}/harness" data-nav="harness">Harness</a>`
		: `<span class="tab tab-disabled" aria-disabled="true">Harness</span>`;
	const analyticsTab = `<a class="tab${state.view === "analytics" ? " tab-active" : ""}" href="/analytics" data-nav="analytics">Analytics</a>`;
	return `<div class="tabbar">
		${harnessTab}
		${analyticsTab}
		<button class="iconbtn" id="themeBtn" type="button" title="Toggle theme" aria-label="Toggle light/dark theme">
			<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
		</button>
	</div>`;
}

/** The one document every route now returns. `railHtml` and `panelHtml` are pre-rendered by the
 * caller (server.ts) so this module never needs to import runs.ts/harness.ts/analytics.ts's data
 * functions -- it only assembles markup already produced elsewhere. */
export function renderShell(state: ShellState, title: string, railHtml: string, panelHtml: string): string {
	const bootstrap = JSON.stringify({ view: state.view, traceId: state.traceId ?? null }).replace(/</g, "\\u003c");
	return `<!doctype html>
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<div class="shell">
	<nav class="rail-wrap">
		<div class="rail-brand"><span class="brand-name">Tether</span><a href="/" class="rail-home" aria-label="All runs" title="All runs">&larr;</a></div>
		<div id="rail">${railHtml}</div>
	</nav>
	<div class="main-wrap">
		${topbar(state)}
		<main id="content">${panelHtml}</main>
	</div>
</div>
<script>window.__TETHER_INITIAL__ = ${bootstrap};</script>
<script src="/app.js" defer></script>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/shell.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/shell.ts test/shell.test.js
git commit -m "feat(server): add the persistent shell template"
```

---

### Task 3: Refactor `harness.ts` — drop the picker, expose `renderHarnessBody`

**Files:**
- Modify: `server/src/templates/harness.ts`
- Modify: `server/test/harness-page.test.js`

**Interfaces:**
- Produces: `renderHarnessBody(view: HarnessView): string` (replaces `renderHarnessPage`), consumed by Task 8 (`server.ts`, both the `/runs/:id/harness` shell route and the `/fragments/harness/:id` route).
- Note: the caller now guarantees `view` is non-null (Task 8's routes check `getHarnessView`'s result and render `renderNotFoundPanel()` instead of calling this function at all when it's null) — this function no longer handles the "run not found" or "no runs at all" cases itself.

- [ ] **Step 1: Read the current test file, then replace it**

Read `server/test/harness-page.test.js` first to see its current shape, then replace its contents with:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderHarnessBody } from "../dist/templates/harness.js";

function view(overrides = {}) {
	return { traceId: "t".repeat(32), goal: "do the thing", startedAt: "2026-08-22T10:00:00.000Z", skills: [], subAgents: [], mcpServers: [], ...overrides };
}

describe("renderHarnessBody", () => {
	test("shows the run's goal and start time", () => {
		const html = renderHarnessBody(view({ goal: "fix the bug" }));
		assert.match(html, /fix the bug/);
	});

	test("renders a skill entry with its source tag", () => {
		const html = renderHarnessBody(view({ skills: [{ name: "code-review", description: "reviews diffs", source: "project" }] }));
		assert.match(html, /code-review/);
		assert.match(html, /reviews diffs/);
		assert.match(html, />project</);
	});

	test("renders a sub-agent entry with its tools", () => {
		const html = renderHarnessBody(view({ subAgents: [{ name: "test-runner", description: "runs tests", tools: ["Bash", "Read"] }] }));
		assert.match(html, /test-runner/);
		assert.match(html, /Bash, Read/);
	});

	test("renders an MCP server entry", () => {
		const html = renderHarnessBody(view({ mcpServers: [{ name: "github" }] }));
		assert.match(html, /github/);
	});

	test("shows a per-category empty message when a category has zero entries", () => {
		const html = renderHarnessBody(view());
		assert.match(html, /No skills discovered for this run\./);
		assert.match(html, /No sub-agents discovered for this run\./);
		assert.match(html, /No MCP servers discovered for this run\./);
	});

	test("escapes an XSS skill name and description", () => {
		const html = renderHarnessBody(view({ skills: [{ name: "<script>alert(1)</script>", description: "<img src=x onerror=alert(1)>", source: "project" }] }));
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.doesNotMatch(html, /<img src=x/);
	});

	test("no longer renders a run picker", () => {
		const html = renderHarnessBody(view());
		assert.doesNotMatch(html, /runPicker/);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build && node --test test/harness-page.test.js`
Expected: FAIL — `renderHarnessBody` is not exported yet.

- [ ] **Step 3: Rewrite `server/src/templates/harness.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/harness-page.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/harness.ts test/harness-page.test.js
git commit -m "refactor(server): harness.ts exposes renderHarnessBody, drops the run picker"
```

---

### Task 4: Refactor `analytics.ts` — expose `renderAnalyticsBody`

**Files:**
- Modify: `server/src/templates/analytics.ts`
- Modify: `server/test/analytics-page.test.js`

**Interfaces:**
- Produces: `renderAnalyticsBody(usage: UsageView): string` (replaces `renderAnalyticsPage`), consumed by Task 8 (`server.ts`, both the `/analytics` shell route and the `/fragments/analytics` route).

- [ ] **Step 1: Read the current test file, then replace it**

Read `server/test/analytics-page.test.js` first, then replace its contents, changing every `renderAnalyticsPage(...)` call to `renderAnalyticsBody(...)` and the import to `import { renderAnalyticsBody } from "../dist/templates/analytics.js";`. Keep every existing assertion as-is — the body content and escaping behavior are unchanged, only the page-chrome wrapper is being removed. Add one new test:
```js
	test("no longer renders its own <title> or topbar (that's the shell's job now)", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] });
		assert.doesNotMatch(html, /<title>/);
		assert.doesNotMatch(html, /class="topbar"/);
	});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build && node --test test/analytics-page.test.js`
Expected: FAIL — `renderAnalyticsBody` is not exported yet.

- [ ] **Step 3: Rewrite `server/src/templates/analytics.ts`**

```ts
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

/** The analytics panel's body -- store-wide, no traceId. */
export function renderAnalyticsBody(usage: UsageView): string {
	const skills = usage.entries.filter((e) => e.type === "skill");
	const subAgents = usage.entries.filter((e) => e.type === "sub_agent");
	const mcpServers = usage.entries.filter((e) => e.type === "mcp_server");

	if (usage.totalRuns === 0) return `<p class="empty">No runs yet.</p>`;
	if (usage.trackedRuns === 0) return `<p class="empty">No runs have reported skill/sub-agent/MCP-server usage yet — coverage tracking requires trail_log_step calls with source_type/source_name set.</p>`;
	if (usage.entries.length === 0) return `<p class="empty">No skills, sub-agents, or MCP servers have been registered by any run.</p>`;

	const untracked = usage.totalRuns - usage.trackedRuns;
	const note = untracked > 0 ? `<p class="note">${untracked} run(s) have no coverage tracking (excluded from the counts below).</p>` : "";
	return `<p class="as-of">Usage across ${usage.totalRuns} run(s)</p>
	${note}
	${section("Skills", skills, "No skills registered by any run.")}
	${section("Sub-agents", subAgents, "No sub-agents registered by any run.")}
	${section("MCP servers", mcpServers, "No MCP servers registered by any run.")}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/analytics-page.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/analytics.ts test/analytics-page.test.js
git commit -m "refactor(server): analytics.ts exposes renderAnalyticsBody"
```

---

### Task 5: Refactor `flight-recorder.ts` — the Detail panel's data fragment

**Files:**
- Modify: `server/src/templates/flight-recorder.ts`
- Modify: `server/test/flight-recorder.test.js`

**Interfaces:**
- Produces: `renderDetailFragment(run: RunView, coverage: CoverageView | null): string` and `renderEmptyDetailPanel(): string` (replace `renderFlightRecorderPage`), both consumed by Task 8 (`server.ts`). `renderDetailFragment`'s output is also consumed at runtime by Task 6's `mountDetailPanel` (via the `#run-data` script tag it emits, parsed client-side — not a compile-time dependency).

The interactive script (mission/strip/steps/inspector/coverage rendering, play/pause/scrub/keyboard, theme toggle) is deleted from this file entirely — it moves to `server/src/static/app.ts` in Task 6, verbatim in behavior. This task only produces the skeleton markup and the JSON data island; **the client-rendering tests for verdict/score/narrative move to Task 6's `app.test.js`**, since there's no more DOM to execute a script against here — this file no longer contains any executable script, only a `type="application/json"` data island the HTML parser never executes regardless of its contents.

- [ ] **Step 1: Read the current test file, then replace it**

Read `server/test/flight-recorder.test.js` first (it currently has a `vm`-based fake-DOM harness to execute the old inline script — none of that is needed anymore). Replace its entire contents with:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDetailFragment, renderEmptyDetailPanel } from "../dist/templates/flight-recorder.js";

function makeRunView(overrides = {}) {
	return {
		traceId: "t".repeat(32),
		goal: "do the thing",
		agent: "coding-agent",
		verdict: "met",
		score: 0.9,
		narrative: "Fully shipped and verified.",
		totals: { dur: "10s", cost: 0.05, tokens: 500, steps: 1 },
		steps: [
			{ type: "tool", title: "run tests", status: "ok", start: 0, dur: 5, cost: 0.05, tok: 500, io: [["Input", "pytest -x"], ["Output", "1 passed"]] },
		],
		...overrides,
	};
}

/** Extracts and JSON.parses the text content of the `id="run-data"` script tag, brace/string-aware
 * so it's robust to arbitrary content in string fields (semicolons, braces, etc). */
function extractRunData(html) {
	const marker = '<script type="application/json" id="run-data">';
	const start = html.indexOf(marker) + marker.length;
	assert.ok(start > marker.length - 1, "could not find the run-data script tag");
	const end = html.indexOf("</script>", start);
	return JSON.parse(html.slice(start, end));
}

describe("renderDetailFragment", () => {
	test("embeds the run and coverage as parseable JSON", () => {
		const html = renderDetailFragment(makeRunView({ goal: "fix the bug" }), { tracked: true, entries: [] });
		const data = extractRunData(html);
		assert.equal(data.goal, "fix the bug");
		assert.deepEqual(data.coverage, { tracked: true, entries: [] });
	});

	test("a null coverage argument round-trips as null", () => {
		const html = renderDetailFragment(makeRunView(), null);
		assert.equal(extractRunData(html).coverage, null);
	});

	test("includes the static skeleton the client renderer expects", () => {
		const html = renderDetailFragment(makeRunView(), null);
		for (const id of ["mission", "playBtn", "strip", "steps", "insp", "coverage"]) {
			assert.match(html, new RegExp(`id="${id}"`));
		}
	});

	test("a goal containing </script> cannot terminate the data script element early", () => {
		const html = renderDetailFragment(makeRunView({ goal: "</script><img src=x onerror=alert(1)>" }), null);
		// Only the run-data tag's own real closing </script> may appear before the skeleton starts.
		const dataOpenIdx = html.indexOf('<script type="application/json" id="run-data">');
		const realCloseIdx = html.indexOf("</script>", dataOpenIdx);
		const before = html.slice(dataOpenIdx, realCloseIdx);
		assert.equal(before.includes("</script><img"), false);
		assert.equal(extractRunData(html).goal, "</script><img src=x onerror=alert(1)>");
	});

	test("a goal containing $& or $' does not corrupt the injected JSON", () => {
		for (const goal of ["weird $& goal", "weird $' goal"]) {
			const html = renderDetailFragment(makeRunView({ goal }), null);
			assert.equal(extractRunData(html).goal, goal);
		}
	});

	test("does not render a <style> or <script> block of its own (moved to shell.ts / app.js)", () => {
		const html = renderDetailFragment(makeRunView(), null);
		assert.doesNotMatch(html, /<style>/);
		assert.doesNotMatch(html, /<script>\(function/);
	});
});

describe("renderEmptyDetailPanel", () => {
	test("shows an honest empty-state message", () => {
		assert.match(renderEmptyDetailPanel(), /No runs yet/);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build && node --test test/flight-recorder.test.js`
Expected: FAIL — `renderDetailFragment`/`renderEmptyDetailPanel` are not exported yet.

- [ ] **Step 3: Rewrite `server/src/templates/flight-recorder.ts`**

```ts
import type { RunView } from "../runs.js";
import type { CoverageView } from "../coverage.js";

/**
 * The Detail panel's static DOM skeleton -- element ids match exactly what
 * server/src/static/app.ts's mountDetailPanel expects to find via document.getElementById.
 * No <style> (moved to shell.ts's shared stylesheet) and no <script> (the interactive
 * rendering logic moved to app.ts, loaded once by the shell instead of once per page).
 */
const SKELETON = `
<section class="mission" id="mission"></section>

<section class="trail-card">
	<div class="transport">
		<button class="play-btn" id="playBtn" aria-label="Play replay">
			<svg id="playIcon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
		</button>
		<div class="clock"><span id="clockNow">0:00</span><span class="sep"> / </span><span id="clockTot">0:00</span></div>
		<div class="speeds" id="speeds" role="group" aria-label="Playback speed">
			<button data-sp="1" aria-pressed="true">1&times;</button>
			<button data-sp="2" aria-pressed="false">2&times;</button>
			<button data-sp="4" aria-pressed="false">4&times;</button>
		</div>
		<div class="live-accrue">
			<div class="accrue"><span class="k">Cost so far</span><span class="v" id="accCost">$0.00</span></div>
			<div class="accrue"><span class="k">Steps</span><span class="v" id="accSteps">0</span></div>
			<div class="accrue"><span class="k">Tokens</span><span class="v" id="accTok">0</span></div>
		</div>
	</div>
	<div class="strip-shell">
		<div class="strip" id="strip" role="slider" aria-label="Scrub run timeline" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
			<svg class="cost-area" id="costArea" preserveAspectRatio="none" aria-hidden="true"></svg>
			<div class="playhead" id="playhead" style="left:0%"></div>
		</div>
		<div class="signals" id="signals"><span class="sig-cap">retries</span></div>
		<div class="axis"><span>t = 0s</span><span id="axisEnd">end</span></div>
	</div>
</section>

<section class="split">
	<div class="panel">
		<div class="panel-head">
			<h2>Steps</h2>
			<span class="count" id="stepCount"></span>
		</div>
		<div class="steps" id="steps"></div>
	</div>
	<div class="panel">
		<div class="panel-head"><h2 id="inspTitle">Verdict</h2></div>
		<div class="insp" id="insp"></div>
	</div>
</section>

<section class="panel">
	<div class="panel-head"><h2>Coverage</h2></div>
	<div class="insp" id="coverage"></div>
</section>
`;

/**
 * The Detail panel's initial content: the static skeleton plus the run's data as an inert
 * `type="application/json"` script tag -- never executed as JS by the browser (by spec, whether
 * present at initial load or inserted later via innerHTML), read via textContent + JSON.parse by
 * app.ts's mountDetailPanel instead. `<` is still escaped so a goal containing a literal
 * "</script>" can't end this tag early at the HTML-parser level -- that risk is independent of the
 * tag's type attribute. The old  /  escaping is dropped: it only mattered when this JSON
 * was substituted directly into JS source (`const RUN = ...`) and eval'd; both characters are valid
 * inside a JSON string and inside a <script> tag's text content, so JSON.parse(textContent) needs
 * no help with them.
 */
export function renderDetailFragment(run: RunView, coverage: CoverageView | null): string {
	const json = JSON.stringify({ ...run, coverage }).replace(/</g, "\\u003c");
	return `${SKELETON}
<script type="application/json" id="run-data">${json}</script>`;
}

/** Shown in the Detail panel when the store has no runs at all (only reachable at `/`). */
export function renderEmptyDetailPanel(): string {
	return `<p class="empty">No runs yet. Point a coding agent at this Tether instance and run something.</p>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/flight-recorder.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/flight-recorder.ts test/flight-recorder.test.js
git commit -m "refactor(server): flight-recorder.ts emits a data fragment, not a full interactive page"
```

---

### Task 6: `server/src/static/app.ts`, part A — relocate the Detail panel's interactive script

**Files:**
- Create: `server/src/static/app.ts`
- Test: `server/test/app.test.js`

**Interfaces:**
- Produces: `mountDetailPanel(runData: RunData): () => void` (the returned function unmounts — cancels any pending animation frame and removes the two `window`/`document`-level listeners this panel attaches; consumed by Task 7's router, added to the same file).
- `RunData` is a local type alias: `RunView & { coverage: CoverageView | null }`, matching exactly what `renderDetailFragment` (Task 5) embeds and what `app.ts` parses out of the `#run-data` script tag at runtime.

This task is a **relocation, not a rewrite**: every function below is the same logic as the inline script deleted from `flight-recorder.ts` in Task 5, adapted only for (a) TypeScript's strict mode (explicit types, a `$()` helper that throws instead of silently returning `null`) and (b) being callable once per navigation instead of once per page load — which means its two `window`/`document`-scoped listeners (drag-to-scrub `mousemove`/`mouseup`, spacebar-to-play `keydown`) must be removable, since `window`/`document` persist across panel swaps but the panel's own DOM doesn't. Element-scoped listeners (the play button, the speed buttons, the strip itself) need no manual cleanup — they're destroyed along with the elements they're attached to when the router replaces `#content`'s HTML.

This app.js file is authored directly (no bundler): `tsc` compiles `server/src/static/app.ts` straight to `server/dist/static/app.js` as part of the existing `npm run build`, matching every other file in this project. It's loaded via a plain `<script src="/app.js" defer>` tag (Task 2), so it must not use `import`/`export` at the top level in a way that requires a module loader in the browser — this file has zero runtime imports (only `import type`, which `tsc` erases entirely at compile time), so it compiles to a plain global script with no `export`/`import` statements left in the output.

- [ ] **Step 1: Write the failing tests**

Create `server/test/app.test.js`, reusing the exact fake-DOM-under-`vm` approach `flight-recorder.test.js` used before Task 5 (a `FakeElement` class plus stub `document`/`window` globals), but now calling `mountDetailPanel` directly with a plain JS object instead of extracting it from rendered HTML:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_JS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "static", "app.js");

function makeRunData(overrides = {}) {
	return {
		traceId: "t".repeat(32),
		goal: "do the thing",
		agent: "coding-agent",
		verdict: "met",
		score: 0.9,
		narrative: "Fully shipped and verified.",
		totals: { dur: "10s", cost: 0.05, tokens: 500, steps: 1 },
		steps: [
			{ type: "tool", title: "run tests", status: "ok", start: 0, dur: 5, cost: 0.05, tok: 500, io: [["Input", "pytest -x"], ["Output", "1 passed"]] },
		],
		coverage: null,
		...overrides,
	};
}

class FakeElement {
	constructor(id) {
		this.id = id;
		this._innerHTML = "";
		this.textContent = "";
		this.title = "";
		this.style = { setProperty: () => {} };
		this.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		this.dataset = {};
		this._attrs = {};
		this.children = [];
		this._listeners = {};
	}
	set innerHTML(v) { this._innerHTML = v; }
	get innerHTML() { return this._innerHTML; }
	setAttribute(n, v) { this._attrs[n] = v; }
	getAttribute(n) { return this._attrs[n] ?? null; }
	addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
	removeEventListener() {}
	appendChild(child) { this.children.push(child); return child; }
	querySelectorAll() { return []; }
	querySelector() { return null; }
	remove() {}
	scrollIntoView() {}
	getBoundingClientRect() { return { left: 0, width: 100 }; }
}

/** Loads app.js fresh into an isolated vm context with a minimal fake DOM, returning
 * `{ elements, windowStub, mountDetailPanel }` so a test can call mountDetailPanel(runData)
 * directly and assert on what actually landed in the fake elements' innerHTML. */
function loadApp() {
	const src = readFileSync(APP_JS_PATH, "utf-8");
	const elements = {};
	function getOrCreate(id) {
		if (!elements[id]) elements[id] = new FakeElement(id);
		return elements[id];
	}
	const windowListeners = {};
	const documentListeners = {};
	const documentStub = {
		getElementById: (id) => getOrCreate(id),
		createElement: () => new FakeElement(null),
		addEventListener: (type, fn) => { (documentListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { documentListeners[type] = (documentListeners[type] ?? []).filter((f) => f !== fn); },
		documentElement: new FakeElement("html"),
		querySelectorAll: () => [],
		querySelector: () => null,
	};
	const windowStub = {
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		addEventListener: (type, fn) => { (windowListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] ?? []).filter((f) => f !== fn); },
		history: { pushState: () => {} },
		location: { pathname: "/" },
		setInterval: () => 0,
		fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }),
		__TETHER_INITIAL__: undefined,
	};
	const sandbox = { document: documentStub, window: windowStub, history: windowStub.history, location: windowStub.location, setInterval: windowStub.setInterval, fetch: windowStub.fetch, console };
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "app.js" });
	return { elements, windowListeners, documentListeners, mountDetailPanel: sandbox.mountDetailPanel };
}

describe("mountDetailPanel", () => {
	test("renders the goal into the mission panel", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ goal: "fix the bug" }));
		assert.match(elements.mission.innerHTML, /fix the bug/);
	});

	test("an unrecognized verdict does not throw and still renders", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "totally-bogus" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
	});

	test("a judged run with a missing score does not render a completion percentage", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: null }));
		assert.equal(elements.mission.innerHTML.includes("Goal completion"), false);
	});

	test("a judged run with a real score renders the completion percentage", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: 0.75 }));
		assert.match(elements.mission.innerHTML, /Goal completion/);
		assert.match(elements.mission.innerHTML, /75%/);
	});

	test("judge narrative containing a script tag is escaped in the inspector panel", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: 0.5, narrative: "<script>alert(1)</script>" }));
		assert.match(elements.insp.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.equal(elements.insp.innerHTML.includes("<script>alert(1)</script>"), false);
	});

	test("unmount removes the window mousemove/mouseup and document keydown listeners it added", () => {
		const { windowListeners, documentListeners, mountDetailPanel } = loadApp();
		const unmount = mountDetailPanel(makeRunData());
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);
		assert.equal((documentListeners.keydown ?? []).length, 1);
		unmount();
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal((documentListeners.keydown ?? []).length, 0);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/static/app.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/static/app.ts` (part A — everything above the `// ---------- Router ----------` marker Task 7 adds later)**

```ts
import type { RunView, CoverageView as _CoverageView } from "../runs.js";
import type { CoverageView } from "../coverage.js";

type RunData = RunView & { coverage: CoverageView | null };

function $<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el as T;
}

// ---------- Icons (static, shared across every mount) ----------
const I: Record<string, string> = {
	reason: '<path d="M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3Z"/><path d="M9.5 19h5M10 21.5h4"/>',
	read: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
	edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16Z"/><path d="M13.5 6.5l4 4"/>',
	run: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
	tool: '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.2l-5 5a1.6 1.6 0 0 0 2.3 2.3l5-5a3.5 3.5 0 0 0 4.2-4.8l-2.1 2.1-1.9-.2-.2-1.9Z"/>',
	llm: '<circle cx="12" cy="12" r="2.2"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.5 1.5M16.2 16.2l1.5 1.5M17.7 6.3l-1.5 1.5M7.8 16.2l-1.5 1.5"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>',
};
const SVG_LOOP = '<path d="M4 9a7 7 0 0 1 12-4l2 2M20 15a7 7 0 0 1-12 4l-2-2"/><path d="M18 3v4h-4M6 21v-4h4"/>';
function icon(t: string): string {
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (I[t] || I.tool) + '</svg>';
}
function svg(p: string, sw?: number): string {
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.7) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

const TYPE_COLOR: Record<string, [string, string]> = {
	reason: ["#8A85F2", "rgba(138,133,242,0.14)"], read: ["#5C93C4", "rgba(92,147,196,0.14)"],
	edit: ["#19b0c0", "rgba(25,176,192,0.15)"], run: ["#C98A5E", "rgba(201,138,94,0.15)"],
	tool: ["#C77DBB", "rgba(199,125,187,0.14)"], llm: ["#5FA8D3", "rgba(95,168,211,0.14)"],
	search: ["#6FA96B", "rgba(111,169,107,0.14)"],
};
const VERDICT: Record<string, { label: string; color: string; wash: string; line: string; glyph: string }> = {
	met: { label: "Goal met", color: "var(--met)", wash: "var(--met-wash)", line: "rgba(47,162,74,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.2"/>' },
	partial: { label: "Partial", color: "var(--partial)", wash: "var(--partial-wash)", line: "rgba(192,136,16,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 15.7v.1"/>' },
	failed: { label: "Goal missed", color: "var(--failed)", wash: "var(--failed-wash)", line: "rgba(220,74,56,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>' },
	unjudged: { label: "Not judged", color: "var(--ink-3)", wash: "var(--panel-2)", line: "var(--line)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' },
};

/**
 * Mounts the Detail (Flight Recorder) panel into the skeleton renderDetailFragment already put in
 * #content, using `runData`. Relocated as-is from the page's old per-load inline <script> -- same
 * rendering/escaping logic, now callable once per navigation instead of once per page load.
 * Returns an unmount function the router must call before swapping #content to a different panel,
 * so this panel's window/document-level listeners (drag-to-scrub, spacebar) and any in-flight
 * requestAnimationFrame loop can't keep running against a panel that's no longer on screen.
 */
export function mountDetailPanel(runData: RunData): () => void {
	let playT = 0, playing = false, speed = 1, raf: number | null = null, lastTs: number | null = null, pinnedStep: number | null = null, dragging = false;

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	function runDur(r: RunData): number { return r.steps.reduce((m, s) => Math.max(m, s.start + s.dur), 0); }
	function fmtT(s: number): string { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
	function fmtCost(c: number | null): string { return c == null ? "" : "$" + c.toFixed(c < 1 ? 3 : 2); }
	function fmtTok(t: number | null): string { return t == null ? "" : (t >= 1000 ? (t / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(t)); }
	function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]); }

	function ring(pct: number, color: string): string {
		const r = 18, C = 2 * Math.PI * r, on = (pct / 100) * C;
		return '<svg width="46" height="46" viewBox="0 0 46 46">'
			+ '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="5"/>'
			+ '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + on.toFixed(1) + " " + C.toFixed(1) + '"/>'
			+ '<text class="pc-num" x="23" y="23" text-anchor="middle" dominant-baseline="central" transform="rotate(90 23 23)">' + pct + "</text></svg>";
	}

	function gm(k: string, v: string): string { return '<div class="gm"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; }

	function renderMission(): void {
		const r = runData, v = VERDICT[r.verdict] || VERDICT.unjudged;
		const m = $("mission");
		m.style.setProperty("--vc", v.color); m.style.setProperty("--vc-wash", v.wash); m.style.setProperty("--vc-line", v.line);
		m.innerHTML =
			"<div>"
			+ '<div class="goal-eyebrow"><span>Goal</span> · <span class="agent-pill">@' + escapeHtml(r.agent) + "</span></div>"
			+ '<h1 class="goal-title">' + escapeHtml(r.goal) + "</h1>"
			+ '<div class="goal-meta">' + gm("Duration", r.totals.dur) + gm("Total cost", fmtCost(r.totals.cost) || "—") + gm("Steps", String(r.totals.steps)) + gm("Tokens", fmtTok(r.totals.tokens) || "—") + "</div>"
			+ "</div>"
			+ '<div class="verdict">'
			+ '<div class="verdict-badge"><svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + v.glyph + "</svg>"
			+ '<div class="vt"><span class="lab">Verdict</span><span class="val">' + v.label + "</span></div></div>"
			+ (r.verdict !== "unjudged" && r.score != null ? '<div class="pcredit">' + ring(Math.round(r.score * 100), v.color)
				+ '<div class="pc-side"><div class="conf-row"><span>Goal completion</span><span>' + Math.round(r.score * 100) + "%</span></div></div></div>" : "")
			+ "</div>";
	}

	function renderStrip(): void {
		const r = runData, total = runDur(r), strip = $("strip");
		strip.querySelectorAll(".seg").forEach((n) => n.remove());
		r.steps.forEach((s, i) => {
			const seg = document.createElement("div");
			seg.className = "seg" + (s.status === "err" ? " err" : "");
			const left = total ? (s.start / total) * 100 : 0, w = total ? Math.max((s.dur / total) * 100, 1.2) : 100;
			seg.style.left = left + "%"; seg.style.width = w + "%"; seg.style.background = s.status === "err" ? "var(--failed-wash)" : TYPE_COLOR[s.type][1];
			seg.dataset.i = String(i); seg.title = s.title;
			seg.addEventListener("click", (e) => { e.stopPropagation(); seekTo(s.start + s.dur * 0.5); pinStep(i); });
			strip.appendChild(seg);
		});
		const area = $<SVGElement & HTMLElement>("costArea");
		const W = 1000, H = 100;
		area.setAttribute("viewBox", "0 0 " + W + " " + H);
		const totalCost = r.steps.reduce((a, s) => a + (s.cost || 0), 0);
		if (totalCost > 0 && total > 0) {
			let cum = 0;
			const pts: [number, number][] = [[0, H]];
			r.steps.forEach((s) => { cum += s.cost || 0; const x = ((s.start + s.dur) / total) * W; const y = H - (cum / totalCost) * H * 0.9; pts.push([x, y]); });
			pts.push([W, pts[pts.length - 1][1]]); pts.push([W, H]);
			const d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
			area.innerHTML = '<path d="' + d + ' Z" fill="var(--accent-wash)"/><path d="M0,' + H + " L" + pts.slice(1, -2).map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L") + '" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"/>';
		} else {
			area.innerHTML = "";
		}
		$("axisEnd").textContent = "t = " + Math.round(total) + "s";
		$("clockTot").textContent = fmtT(total);
		renderSignals();
	}

	function renderSignals(): void {
		const r = runData, total = runDur(r), lane = $("signals");
		lane.querySelectorAll(".sig-m").forEach((n) => n.remove());
		if (!total) return;
		r.steps.forEach((s, i) => {
			if (!s.sig) return;
			s.sig.forEach((sg) => {
				const at = ((s.start + s.dur * 0.5) / total) * 100;
				const m = document.createElement("div");
				m.className = "sig-m"; m.style.left = at + "%";
				m.style.background = "var(--stuck)"; m.style.color = "#fff"; m.style.borderColor = "var(--stuck)";
				m.innerHTML = svg(SVG_LOOP, 1.9); m.title = "Retry loop ×" + sg.count + " — step " + (i + 1);
				m.addEventListener("click", () => { pinStep(i); seekTo(s.start + 0.3); });
				lane.appendChild(m);
			});
		});
	}

	function sBadges(s: RunData["steps"][number]): string {
		if (!s.sig) return "";
		return s.sig.map((sg) => '<span class="sbadge retry">' + svg(SVG_LOOP, 2) + "&times;" + sg.count + "</span>").join("");
	}

	function renderSteps(): void {
		const r = runData, el = $("steps");
		$("stepCount").textContent = r.steps.length + " step" + (r.steps.length === 1 ? "" : "s");
		if (!r.steps.length) { el.innerHTML = '<div class="insp-empty" style="padding:14px">No steps logged for this run.</div>'; return; }
		el.innerHTML = r.steps.map((s, i) => {
			const [c, w] = TYPE_COLOR[s.type];
			const stat = s.status === "err" ? '<span class="stat-chip stat-err">error</span>' : "";
			const metaBits = ["t+" + fmtT(s.start), s.dur + "s" + (fmtCost(s.cost) ? " · " + fmtCost(s.cost) : "")];
			return '<div class="step" data-i="' + i + '" role="button" tabindex="0" aria-selected="false" style="--tc:' + c + ";--tc-wash:" + w + '">'
				+ '<div class="rail"><div class="tick">' + icon(s.type) + "</div></div>"
				+ '<div class="body"><div class="st-title">' + escapeHtml(s.title) + " " + stat + sBadges(s) + "</div></div>"
				+ '<div class="meta">' + metaBits.join("<br>") + "</div></div>";
		}).join("");
		el.querySelectorAll(".step").forEach((node) => {
			const i = Number(node.dataset.i);
			node.addEventListener("click", () => { pinStep(i); seekTo(runData.steps[i].start + 0.3); });
			node.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pinStep(i); seekTo(runData.steps[i].start + 0.3); } });
		});
	}

	function currentStepIndex(): number {
		let idx = -1;
		runData.steps.forEach((s, i) => { if (playT >= s.start) idx = i; });
		return idx;
	}

	function renderInspector(): void {
		if (pinnedStep != null && runData.steps[pinnedStep]) renderStepIO(runData.steps[pinnedStep], pinnedStep);
		else renderVerdict(runData);
	}

	function renderVerdict(r: RunData): void {
		$("inspTitle").textContent = "Verdict";
		const insp = $("insp");
		if (r.verdict === "unjudged") {
			insp.innerHTML = '<div class="insp-section"><div class="insp-empty">No verdict — no goal-attainment judge was configured for this run (set TRAIL_JUDGE_PROVIDER/TRAIL_JUDGE_API_KEY to enable one).</div></div>';
			return;
		}
		const v = VERDICT[r.verdict] || VERDICT.unjudged;
		insp.style.setProperty("--vc", v.color);
		insp.innerHTML = '<div class="insp-section"><h3>LLM judge</h3><div class="judge-quote">' + escapeHtml(r.narrative || "") + "</div></div>";
	}

	function coverageList(entries: NonNullable<RunData["coverage"]>["entries"], emptyMsg: string): string {
		if (!entries.length) return '<div class="insp-empty">' + emptyMsg + "</div>";
		return entries.map((e) => {
			const used = e.usedCount > 0;
			const status = used ? "✓ used (" + e.usedCount + " step" + (e.usedCount === 1 ? "" : "s") + ")" : "— not used";
			return '<div class="cov-row"><span>' + escapeHtml(e.name) + '</span><span class="cov-status' + (used ? " cov-used" : "") + '">' + status + "</span></div>";
		}).join("");
	}

	function renderCoverage(): void {
		const cov = runData.coverage, el = $("coverage");
		if (!cov || !cov.entries.length) {
			el.innerHTML = '<div class="insp-empty">No skills, sub-agents, or MCP servers were registered for this run — nothing to show coverage for.</div>';
			return;
		}
		if (!cov.tracked) {
			el.innerHTML = '<div class="insp-empty">Coverage not tracked for this run — no step reported which skill, sub-agent, or MCP server it came from.</div>';
			return;
		}
		const skills = cov.entries.filter((e) => e.type === "skill");
		const subAgents = cov.entries.filter((e) => e.type === "sub_agent");
		const mcpServers = cov.entries.filter((e) => e.type === "mcp_server");
		el.innerHTML =
			'<div class="insp-section"><h3>Skills</h3>' + coverageList(skills, "No skills registered for this run.") + "</div>"
			+ '<div class="insp-section"><h3>Sub-agents</h3>' + coverageList(subAgents, "No sub-agents registered for this run.") + "</div>"
			+ '<div class="insp-section"><h3>MCP servers</h3>' + coverageList(mcpServers, "No MCP servers registered for this run.") + "</div>";
	}

	function renderStepIO(s: RunData["steps"][number], i: number): void {
		$("inspTitle").textContent = s.title + " · step " + (i + 1);
		const insp = $("insp");
		let inner = '<div class="pin-note"><span>&#9670; pinned to step ' + (i + 1) + '</span><button id="unpin">back to verdict</button></div>';
		if (s.sig) inner += s.sig.map((sg) => '<div class="io-sig"><span style="color:var(--stuck);display:grid;place-items:center">' + svg(SVG_LOOP, 1.9) + '</span><div><span class="st" style="color:var(--stuck)">Retry loop &times;' + sg.count + '</span><div style="color:var(--ink-2);margin-top:2px">' + escapeHtml(sg.detail) + "</div></div></div>").join("");
		if (s.io && s.io.length) inner += s.io.map((p) => '<div class="io-kind">' + escapeHtml(p[0]) + '</div><div class="io-block">' + escapeHtml(p[1]) + "</div>").join("");
		else inner += '<div class="insp-empty">No input/output recorded for this step.</div>';
		insp.innerHTML = inner;
		const un = document.getElementById("unpin");
		if (un) un.addEventListener("click", () => pinStep(null));
	}

	function updatePlayhead(): void {
		const r = runData, total = runDur(r), pct = total ? Math.min(100, (playT / total) * 100) : 0;
		$("playhead").style.left = pct + "%"; $("clockNow").textContent = fmtT(playT);
		$("strip").setAttribute("aria-valuenow", String(Math.round(pct)));
		let cost = 0, tok = 0, steps = 0;
		r.steps.forEach((s) => {
			if (playT >= s.start + s.dur) { cost += s.cost || 0; tok += s.tok || 0; steps++; }
			else if (playT >= s.start && s.dur > 0) { const f = (playT - s.start) / s.dur; cost += (s.cost || 0) * f; tok += Math.round((s.tok || 0) * f); }
		});
		$("accCost").textContent = fmtCost(cost) || "$0.00"; $("accSteps").textContent = steps + "/" + r.steps.length; $("accTok").textContent = fmtTok(tok) || "0";
		const ci = currentStepIndex();
		$("strip").querySelectorAll(".seg").forEach((seg) => {
			const i = Number(seg.dataset.i), s = r.steps[i];
			seg.classList.toggle("played", playT >= s.start); seg.classList.toggle("current", i === ci);
		});
		$("steps").querySelectorAll(".step").forEach((node) => {
			const i = Number(node.dataset.i);
			node.setAttribute("data-current", i === ci ? "true" : "false");
			node.setAttribute("aria-selected", pinnedStep === i ? "true" : "false");
		});
		if (pinnedStep == null && ci >= 0 && playing) {
			const node = $("steps").querySelector('.step[data-i="' + ci + '"]');
			if (node) node.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
		}
	}
	function seekTo(t: number): void { const total = runDur(runData); playT = Math.max(0, Math.min(total, t)); updatePlayhead(); }
	function pinStep(i: number | null): void { pinnedStep = i; renderInspector(); updatePlayhead(); }

	function tick(ts: number): void {
		if (!playing) return;
		if (lastTs == null) lastTs = ts;
		const dt = (ts - lastTs) / 1000; lastTs = ts; playT += dt * speed;
		const total = runDur(runData);
		if (playT >= total) { playT = total; setPlaying(false); updatePlayhead(); return; }
		updatePlayhead(); raf = requestAnimationFrame(tick);
	}
	function setPlaying(p: boolean): void {
		playing = p; lastTs = null;
		$("playIcon").innerHTML = p ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M8 5v14l11-7z"/>';
		$("playBtn").setAttribute("aria-label", p ? "Pause replay" : "Play replay");
		if (p) { if (playT >= runDur(runData)) playT = 0; pinStep(null); raf = requestAnimationFrame(tick); }
		else if (raf != null) cancelAnimationFrame(raf);
	}

	function onWindowMouseMove(e: MouseEvent): void { if (dragging) seekFromEvent(e); }
	function onWindowMouseUp(): void { dragging = false; }
	function onDocumentKeydown(e: KeyboardEvent): void {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
		if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
	}
	function seekFromEvent(e: MouseEvent | TouchEvent): void {
		const strip = $("strip");
		const rect = strip.getBoundingClientRect();
		const clientX = "touches" in e && e.touches.length ? e.touches[0].clientX : (e as MouseEvent).clientX;
		const x = (clientX - rect.left) / rect.width;
		seekTo(x * runDur(runData));
	}

	function initControls(): void {
		$("playBtn").addEventListener("click", () => setPlaying(!playing));
		$("speeds").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
			speed = Number(b.dataset.sp);
			$("speeds").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
		}));
		const strip = $("strip");
		strip.addEventListener("mousedown", (e: MouseEvent) => {
			if ((e.target as HTMLElement).classList.contains("seg")) return;
			dragging = true; setPlaying(false); seekFromEvent(e);
		});
		window.addEventListener("mousemove", onWindowMouseMove);
		window.addEventListener("mouseup", onWindowMouseUp);
		strip.addEventListener("keydown", (e: KeyboardEvent) => {
			const total = runDur(runData);
			if (e.key === "ArrowRight") { seekTo(playT + total * 0.02); e.preventDefault(); }
			if (e.key === "ArrowLeft") { seekTo(playT - total * 0.02); e.preventDefault(); }
		});
		document.addEventListener("keydown", onDocumentKeydown);
	}

	renderMission(); renderStrip(); renderSteps(); renderInspector(); renderCoverage(); updatePlayhead(); initControls();

	return function unmount(): void {
		if (raf != null) cancelAnimationFrame(raf);
		window.removeEventListener("mousemove", onWindowMouseMove);
		window.removeEventListener("mouseup", onWindowMouseUp);
		document.removeEventListener("keydown", onDocumentKeydown);
	};
}
```

**Note for the implementer:** the `import type { RunView, CoverageView as _CoverageView } from "../runs.js";` line above has an unused, oddly-named second import purely to illustrate the pattern — delete it; the real imports are just `import type { RunView } from "../runs.js"; import type { CoverageView } from "../coverage.js";`. Also double check `StepView`'s exact field types against `server/src/runs.ts` (`type`, `title`, `status`, `start`, `dur`, `cost`, `tok`, `io`, `sig`) while wiring this up — `tsc` will catch any mismatch, fix inline.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: PASS. If `tsc` reports type errors, fix them in place (e.g. adjusting a generic parameter on `$<T>()`, or narrowing a union) without changing the runtime behavior of the relocated logic — every fix should be type-only.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/static/app.ts test/app.test.js
git commit -m "feat(server): relocate the Detail panel's interactive script into app.ts"
```

---

### Task 7: `server/src/static/app.ts`, part B — the client router

**Files:**
- Modify: `server/src/static/app.ts` (append to the file Task 6 created)
- Modify: `server/test/app.test.js`

**Interfaces:**
- Produces: a self-running `init()` call (top-level side effect, not exported — the whole point of this file being loaded via `<script src="/app.js" defer>` is that it runs itself). No other file imports from `app.ts`; Task 8's `server.ts` only reads its *compiled output* as a string to serve at `GET /app.js`.
- Consumes: `mountDetailPanel` from Task 6 (same file, same module scope — no import needed).

- [ ] **Step 1: Write the failing tests**

Append to `server/test/app.test.js`'s `loadApp()` fake DOM: it already stubs `history`, `location`, `setInterval`, and `fetch` (Task 6 anticipated this). These tests exercise the router's pure logic directly rather than simulating a real click event — `FakeElement` has no real prototype chain, so an `instanceof HTMLAnchorElement` check inside a click handler can't be driven through a hand-rolled `vm` DOM without disproportionate extra stubbing. The router is structured so `parsePathname`/`fragmentUrlFor`/`navigateTo` are plain functions the sandbox exposes, not buried inside the click handler, so testing them directly covers the real logic without that overhead — the click handler itself is a thin two-line wrapper (`preventDefault` + call `navigateTo`) covered by inspection, not a dedicated test. Add:
```js
describe("router: path parsing and fragment URLs", () => {
	test("parsePathname recognizes all four route shapes and rejects everything else", () => {
		const { sandbox } = loadApp();
		assert.deepEqual(sandbox.parsePathname("/analytics"), { view: "analytics", traceId: null });
		assert.deepEqual(sandbox.parsePathname("/runs/" + "a".repeat(32)), { view: "detail", traceId: "a".repeat(32) });
		assert.deepEqual(sandbox.parsePathname("/runs/" + "a".repeat(32) + "/harness"), { view: "harness", traceId: "a".repeat(32) });
		assert.equal(sandbox.parsePathname("/"), null);
		assert.equal(sandbox.parsePathname("/something-else"), null);
	});

	test("fragmentUrlFor maps each ShellState to its matching /fragments/* URL", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.fragmentUrlFor({ view: "analytics", traceId: null }), "/fragments/analytics");
		assert.equal(sandbox.fragmentUrlFor({ view: "harness", traceId: "b".repeat(32) }), "/fragments/harness/" + "b".repeat(32));
		assert.equal(sandbox.fragmentUrlFor({ view: "detail", traceId: "c".repeat(32) }), "/fragments/detail/" + "c".repeat(32));
	});
});

describe("router: navigation", () => {
	test("navigating to a recognized path fetches the right fragment and swaps #content", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);
		assert.equal(elements.content.innerHTML, "<p>analytics body</p>");
	});

	test("navigating to an unrecognized path falls back to a full navigation instead of fetching", async () => {
		const { windowStub, sandbox } = loadApp();
		let fetched = false;
		windowStub.fetch = () => { fetched = true; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }); };
		await sandbox.navigateTo("/some/unknown/path", true);
		assert.equal(fetched, false);
		assert.equal(windowStub.location.href, "/some/unknown/path");
	});

	test("a fragment fetch that resolves 404 renders the not-found body directly, not the generic retry block", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('<p class="empty">Run not found.</p>') });
		await sandbox.navigateTo("/runs/" + "d".repeat(32), true);
		assert.match(elements.content.innerHTML, /Run not found/);
		assert.doesNotMatch(elements.content.innerHTML, /Retry/);
	});

	test("a network failure during navigation renders a retry block", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.reject(new Error("network down"));
		await sandbox.navigateTo("/analytics", true);
		assert.match(elements.content.innerHTML, /Retry/);
	});

	test("navigating away from a mounted detail view unmounts it -- its window listeners are gone before the new panel mounts", async () => {
		const { elements, windowListeners, windowStub, sandbox } = loadApp();
		const detailHtml = '<script type="application/json" id="run-data">' + JSON.stringify({ traceId: "e".repeat(32), goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null }) + "</script>";
		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(url.includes("/fragments/detail/") ? detailHtml : "<p>analytics body</p>") });

		await sandbox.navigateTo("/runs/" + "e".repeat(32), true);
		// mountDetailPanel's own initControls() ran for real here, registering its two window
		// listeners on the same windowListeners object Task 6's unmount test asserts against.
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);

		await sandbox.navigateTo("/analytics", true);
		// navigateTo must have called the stored unmount() before swapping #content -- if it
		// didn't, these listeners would still be registered even though the Detail panel's DOM
		// (and the run-data it was mounted from) no longer exists.
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal(elements.content.innerHTML, "<p>analytics body</p>");
	});
});
```

Update `loadApp()` (from Task 6) so the sandbox exposes the router's internal functions for direct testing and the fake DOM has the extra elements/stubs the router needs:
```js
// Additions to loadApp() from Task 6:
//   - windowStub gains: location: { pathname: "/", href: "" } (href is a plain settable
//     property so the "unrecognized path -> full navigation" test can observe the assignment),
//     history: { pushState: () => {} }.
//   - elements gains a "content" and "rail" FakeElement up front (getOrCreate("content") /
//     getOrCreate("rail")) since the router looks them up by id on every navigation.
//   - The returned object gains `sandbox` (the raw vm sandbox object) so tests can call
//     sandbox.parsePathname/fragmentUrlFor/navigateTo directly.
```
Apply that update to `loadApp()` directly in the test file (it's a small, mechanical addition to the object literal and return statement already there).

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: FAIL — `parsePathname`/`fragmentUrlFor`/`navigateTo` don't exist in the sandbox yet (part B hasn't been appended to `app.ts`).

- [ ] **Step 3: Append the router to `server/src/static/app.ts`**

Add after `mountDetailPanel`'s closing brace:
```ts
// ---------- Router ----------

interface ShellState {
	view: "detail" | "harness" | "analytics";
	traceId: string | null;
}

declare global {
	interface Window {
		__TETHER_INITIAL__?: ShellState;
	}
}

let currentUnmount: (() => void) | null = null;
let currentState: ShellState = { view: "detail", traceId: null };

function parsePathname(pathname: string): ShellState | null {
	if (pathname === "/analytics") return { view: "analytics", traceId: null };
	const harnessMatch = pathname.match(/^\/runs\/([^/]+)\/harness$/);
	if (harnessMatch) return { view: "harness", traceId: decodeURIComponent(harnessMatch[1]) };
	const detailMatch = pathname.match(/^\/runs\/([^/]+)$/);
	if (detailMatch) return { view: "detail", traceId: decodeURIComponent(detailMatch[1]) };
	return null;
}

function fragmentUrlFor(state: ShellState): string {
	if (state.view === "analytics") return "/fragments/analytics";
	if (state.view === "harness") return `/fragments/harness/${encodeURIComponent(state.traceId as string)}`;
	return `/fragments/detail/${encodeURIComponent(state.traceId as string)}`;
}

function setTabActive(view: ShellState["view"]): void {
	document.querySelectorAll(".tabbar .tab").forEach((el) => {
		el.classList.toggle("tab-active", el.getAttribute("data-nav") === view);
	});
}

function setRailActive(traceId: string | null): void {
	document.querySelectorAll("#rail a.rail-row").forEach((el) => {
		el.classList.toggle("rail-row-active", el.getAttribute("data-trace-id") === traceId);
	});
}

function mountRunDataIfPresent(): void {
	const dataEl = document.getElementById("run-data");
	if (!dataEl) return;
	// RunData is the type mountDetailPanel (Task 6, same module) already declares.
	const runData = JSON.parse(dataEl.textContent || "null") as RunData | null;
	if (!runData) return;
	currentUnmount = mountDetailPanel(runData);
	document.title = `Tether — ${runData.goal}`;
}

function renderRetry(retry: () => void): void {
	const content = $("content");
	content.innerHTML = `<p class="empty">Couldn't load this view. <button id="retryNav" type="button">Retry</button></p>`;
	document.getElementById("retryNav")?.addEventListener("click", retry);
}

async function navigateTo(pathname: string, push: boolean): Promise<void> {
	const target = parsePathname(pathname);
	if (!target) { window.location.href = pathname; return; }

	let html: string;
	let status: number;
	try {
		const res = await window.fetch(fragmentUrlFor(target));
		status = res.status;
		html = await res.text();
	} catch {
		renderRetry(() => navigateTo(pathname, push));
		return;
	}
	if (status !== 200 && status !== 404) {
		renderRetry(() => navigateTo(pathname, push));
		return;
	}

	if (currentUnmount) { currentUnmount(); currentUnmount = null; }
	$("content").innerHTML = html;
	currentState = target;

	if (status === 404) {
		document.title = "Tether — Run not found";
	} else if (target.view === "detail") {
		mountRunDataIfPresent();
	} else if (target.view === "harness") {
		document.title = "Tether — Harness";
	} else {
		document.title = "Tether — Analytics";
	}

	setTabActive(target.view);
	setRailActive(target.view === "analytics" ? null : target.traceId);
	if (push) window.history.pushState(null, "", pathname);
}

function onRailOrTabClick(e: MouseEvent): void {
	const targetEl = e.target as Element | null;
	const anchor = targetEl?.closest("a[data-trace-id], a[data-nav]");
	if (!anchor) return;
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	e.preventDefault();
	navigateTo(new URL((anchor as HTMLAnchorElement).href).pathname, true);
}

function onPopState(): void {
	navigateTo(window.location.pathname, false);
}

function pollRail(): void {
	const query = currentState.traceId ? `?active=${encodeURIComponent(currentState.traceId)}` : "";
	window.fetch(`/fragments/rail${query}`)
		.then((res) => (res.ok ? res.text() : null))
		.then((html) => { if (html != null) $("rail").innerHTML = html; })
		.catch(() => {});
}

function initThemeToggle(): void {
	document.getElementById("themeBtn")?.addEventListener("click", () => {
		const root = document.documentElement;
		const isDark = (root.getAttribute("data-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
		root.setAttribute("data-theme", isDark ? "light" : "dark");
	});
}

function init(): void {
	const initial = window.__TETHER_INITIAL__;
	if (initial) currentState = initial;

	document.getElementById("rail")?.addEventListener("click", onRailOrTabClick);
	document.querySelector(".tabbar")?.addEventListener("click", onRailOrTabClick);
	window.addEventListener("popstate", onPopState);
	initThemeToggle();
	window.setInterval(pollRail, 5000);

	if (currentState.view === "detail") mountRunDataIfPresent();
}

init();
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: PASS, all tests green. Fix any `tsc` type errors that come up (e.g. `window.location.href` assignability, `NodeListOf<Element>`'s `.forEach` typing) in place — type-only fixes, no behavior change.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/static/app.ts test/app.test.js
git commit -m "feat(server): add the client-side router (navigation, polling, panel lifecycle)"
```

---

### Task 8: Rewire `server/src/server.ts`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/test/server.test.js`

**Interfaces:**
- Consumes: `renderShell`, `renderNotFoundPanel`, `ShellState` (Task 2); `renderRailBody` (Task 1); `renderHarnessBody` (Task 3); `renderAnalyticsBody` (Task 4); `renderDetailFragment`, `renderEmptyDetailPanel` (Task 5); the compiled `dist/static/app.js` (Task 6+7's output, read as a static string).
- Produces: the final route table — `POST /traces` (unchanged), `GET /app.js`, `GET /fragments/rail`, `GET /fragments/analytics`, `GET /fragments/harness/:traceId`, `GET /fragments/detail/:traceId`, `GET /`, `GET /runs/:traceId`, `GET /runs/:traceId/harness`, `GET /analytics`. The old bare `GET /harness` route is removed entirely.

- [ ] **Step 1: Read the current test file, then replace it**

Read `server/test/server.test.js` first — keep its `withServer`/`otlpPayload` test helpers and the entire `describe("POST /traces", ...)` block unchanged. Replace every other `describe` block (`GET /`, `GET /runs/:traceId`, `GET /harness`, `GET /analytics`, `unknown routes`, `GET / error handling`) with:
```js
describe("GET /app.js", () => {
	test("serves the client router as JavaScript", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/app.js`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
			const text = await res.text();
			assert.match(text, /function navigateTo/);
		});
	});
});

describe("GET /", () => {
	test("an empty store renders the shell with an empty rail and empty Detail panel", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /No runs yet/);
			assert.match(text, /tab-disabled/); // Harness tab disabled, nothing selected
		});
	});

	test("with runs, shows the most recent run's Detail panel and highlights it in the rail", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, /rail-row-active/);
			assert.match(text, /id="run-data"/);
		});
	});
});

describe("GET /runs/:traceId", () => {
	test("renders that run's Detail panel", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /id="run-data"/);
		});
	});

	test("an unknown traceId renders a shell-wrapped 404, not bare JSON", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			const text = await res.text();
			assert.match(text, /Run not found/);
			assert.match(text, /class="shell"/);
		});
	});
});

describe("GET /runs/:traceId/harness", () => {
	test("renders that run's harness panel with the Harness tab active", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}/harness`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /tab tab-active/);
		});
	});

	test("an unknown traceId renders a shell-wrapped 404", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"z".repeat(32)}/harness`);
			assert.equal(res.status, 404);
			assert.match(await res.text(), /Run not found/);
		});
	});
});

describe("GET /analytics", () => {
	test("renders the shell with the analytics panel and the Analytics tab active", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/analytics`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /No runs yet/);
			assert.match(text, /tab tab-active/);
		});
	});
});

describe("GET /harness (removed)", () => {
	test("the old bare route no longer exists", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/harness`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET /fragments/rail", () => {
	test("returns the rail's inner HTML with the active run marked", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/rail?active=${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			assert.match(await res.text(), /rail-row-active/);
		});
	});
});

describe("GET /fragments/analytics", () => {
	test("returns the analytics panel's inner HTML", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/analytics`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /No runs yet/);
		});
	});
});

describe("GET /fragments/harness/:traceId", () => {
	test("returns the harness panel's inner HTML for a real run", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/harness/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /Harness as of/);
		});
	});

	test("an unknown traceId returns a 404 fragment (not a shell page)", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/harness/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			const text = await res.text();
			assert.match(text, /Run not found/);
			assert.doesNotMatch(text, /class="shell"/);
		});
	});
});

describe("GET /fragments/detail/:traceId", () => {
	test("returns the detail panel's inner HTML for a real run", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /id="run-data"/);
		});
	});

	test("an unknown traceId returns a 404 fragment", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			assert.doesNotMatch(await res.text(), /class="shell"/);
		});
	});
});

describe("unknown routes", () => {
	test("returns 404 for an unrecognized path", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/totally/unknown`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET / error handling", () => {
	test("returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 500);
		});
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run build && node --test test/server.test.js`
Expected: FAIL — the new routes don't exist yet, `/harness` (bare) still exists.

- [ ] **Step 3: Rewrite `server/src/server.ts`**

```ts
/**
 * Tether's local HTTP server: accepts the same OTLP/JSON payload
 * mcp/src/otlp.ts sends, stores every span, and serves the unified shell
 * (run rail + a Detail/Harness/Analytics panel) plus the /fragments/* routes
 * its client router fetches for in-app navigation.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { insertSpan } from "./db.js";
import { getRun, listRuns } from "./runs.js";
import { getHarnessView } from "./harness.js";
import { getCoverage } from "./coverage.js";
import { getUsage } from "./analytics.js";
import { renderDetailFragment, renderEmptyDetailPanel } from "./templates/flight-recorder.js";
import { renderRailBody } from "./templates/rail.js";
import { renderHarnessBody } from "./templates/harness.js";
import { renderAnalyticsBody } from "./templates/analytics.js";
import { renderShell, renderNotFoundPanel, ShellState } from "./templates/shell.js";

const APP_JS = readFileSync(fileURLToPath(new URL("./static/app.js", import.meta.url)), "utf-8");

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	[key: string]: unknown;
}

function extractSpans(body: unknown): OtlpSpan[] {
	const spans: OtlpSpan[] = [];
	const resourceSpans = (body as { resourceSpans?: unknown[] })?.resourceSpans ?? [];
	for (const rs of resourceSpans) {
		const scopeSpans = (rs as { scopeSpans?: unknown[] })?.scopeSpans ?? [];
		for (const ss of scopeSpans) {
			const spanList = (ss as { spans?: OtlpSpan[] })?.spans ?? [];
			for (const span of spanList) spans.push(span);
		}
	}
	return spans;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

function sendError(res: ServerResponse, status: number, error: string): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: false, error }));
}

/** Decodes a traceId path segment, writing a 400 and returning null on a malformed one. */
function decodeTraceIdOr400(raw: string, res: ServerResponse): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		sendError(res, 400, "malformed traceId");
		return null;
	}
}

export function createTetherServer(db: Database.Database): Server {
	return createServer(async (req, res) => {
		const pathname = (req.url ?? "").split("?")[0];

		if (req.method === "POST" && pathname === "/traces") {
			try {
				const bodyText = await readBody(req);
				const parsed = JSON.parse(bodyText);
				const spans = extractSpans(parsed);
				for (const span of spans) {
					insertSpan(db, {
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId ?? null,
						name: span.name,
						startTimeUnixNano: span.startTimeUnixNano,
						endTimeUnixNano: span.endTimeUnixNano,
						raw: JSON.stringify(span),
					});
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, spansIngested: spans.length }));
			} catch (err) {
				sendError(res, 400, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/app.js") {
			res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
			res.end(APP_JS);
			return;
		}

		if (req.method === "GET" && pathname === "/fragments/rail") {
			try {
				const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
				const active = query.get("active") ?? undefined;
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderRailBody(listRuns(db, 50), active, Date.now()));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/fragments/analytics") {
			try {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderAnalyticsBody(getUsage(db)));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/fragments/harness/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/fragments/harness/".length), res);
			if (traceId === null) return;
			try {
				const view = getHarnessView(db, traceId);
				if (!view) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderNotFoundPanel());
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderHarnessBody(view));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/fragments/detail/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/fragments/detail/".length), res);
			if (traceId === null) return;
			try {
				const run = getRun(db, traceId);
				if (!run) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderNotFoundPanel());
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderDetailFragment(run, getCoverage(db, traceId)));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const harnessPathMatch = pathname.match(/^\/runs\/([^/]+)\/harness$/);
		if (req.method === "GET" && harnessPathMatch) {
			const traceId = decodeTraceIdOr400(harnessPathMatch[1], res);
			if (traceId === null) return;
			try {
				const rail = renderRailBody(listRuns(db, 50), traceId, Date.now());
				const view = getHarnessView(db, traceId);
				const state: ShellState = { view: "harness", traceId };
				if (!view) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderShell(state, "Tether — Run not found", rail, renderNotFoundPanel()));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderShell(state, "Tether — Harness", rail, renderHarnessBody(view)));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const detailPathMatch = pathname.match(/^\/runs\/([^/]+)$/);
		if (req.method === "GET" && (pathname === "/" || detailPathMatch)) {
			try {
				const runs = listRuns(db, 50);
				let traceId: string | null;
				if (pathname === "/") {
					traceId = runs[0]?.traceId ?? null;
				} else {
					const decoded = decodeTraceIdOr400(detailPathMatch![1], res);
					if (decoded === null) return;
					traceId = decoded;
				}

				const rail = renderRailBody(runs, traceId ?? undefined, Date.now());
				if (traceId === null) {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderShell({ view: "detail" }, "Tether", rail, renderEmptyDetailPanel()));
					return;
				}

				const run = getRun(db, traceId);
				const state: ShellState = { view: "detail", traceId };
				if (!run) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderShell(state, "Tether — Run not found", rail, renderNotFoundPanel()));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderShell(state, `Tether — ${run.goal}`, rail, renderDetailFragment(run, getCoverage(db, traceId))));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/analytics") {
			try {
				const rail = renderRailBody(listRuns(db, 50), undefined, Date.now());
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderShell({ view: "analytics" }, "Tether — Analytics", rail, renderAnalyticsBody(getUsage(db))));
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		sendError(res, 404, "not found");
	});
}
```

Note: `ShellState` is imported as a type from `./templates/shell.js` alongside the two functions — since `shell.ts` only exports it as `export interface ShellState`, this is a type-only import; add `import type { ShellState } from "./templates/shell.js";` as a separate line if the linter/`tsc` complains about mixing value and type imports from the same module (both forms compile fine under this project's `tsconfig.json`, but keep whichever `tsc` accepts without a warning).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run build && npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/server.ts test/server.test.js
git commit -m "feat(server): rewire routes onto the unified shell + fragment endpoints"
```

---

### Task 9: End-to-end verification and README update

**Files:**
- Modify: `server/README.md`

**Interfaces:**
- Consumes: the full pipeline from Tasks 1–8.
- Produces: no new code — verification evidence plus a README update.

- [ ] **Step 1: Manual end-to-end verification**

Write a throwaway script (do not commit it — delete it when done, matching every prior plan's final task) that:
1. Rebuilds fresh: `cd server && npm run build`.
2. Confirms `dist/static/app.js` exists and is non-empty (`ls -la dist/static/app.js`) — this is the concrete check that `tsc` picked up the new `src/static/` directory without any extra build-step wiring.
3. Starts the real built `dist/index.js` on a test port, `HOME` overridden to a fresh `mkdtemp` directory (matching the pattern used in the usage-analytics plan's own Task 5).
4. Seeds at least three runs via real `POST /traces` calls (or the real `mcp/` package's `trail_start_run`/`trail_log_step`/`trail_finish_run` flow) so there's a real rail, a real Detail panel, and real harness/analytics data to click through — include at least one run whose manifest registers a skill/MCP server that's never used (dead weight, for the Analytics panel) and at least one `trail_log_step` call with `source_type`/`source_name` set (for the Coverage panel).
5. Using a real browser (not just `curl`) against that server:
   - Load `/`. Confirm the rail shows all seeded runs, the most recent one is active, and its Detail panel (mission/timeline/steps/coverage) renders and the play/pause button works.
   - Click a different run in the rail. Confirm the URL updates to `/runs/:id`, the content swaps without a full page reload (Network tab shows a `/fragments/detail/:id` fetch, not a full document navigation), and the previously-playing timeline (if you started it) actually stops (proves `unmount` fired).
   - Click the Harness tab. Confirm it navigates to `/runs/:id/harness`, the tab is marked active, and the panel shows that run's manifest.
   - Click Analytics. Confirm the Harness tab becomes disabled again (no traceId selected) and the analytics panel renders, including the dead-weight entry seeded in step 4.
   - Use the browser's back button twice. Confirm it lands back on the Detail view for the originally-selected run without a full page reload.
   - Reload the page on `/analytics` directly (a real navigation, not client-side). Confirm it renders correctly server-side with no flash of missing content.
   - Navigate to `/runs/` + a made-up 32-char hex id. Confirm a 404 status with a shell-wrapped "Run not found" page, not bare JSON.
   - Wait 5+ seconds on any view with the DevTools Network tab open. Confirm a `/fragments/rail` request fires on its own.
6. Run the full test suite one more time (`npm test`) to confirm nothing above required an undocumented change that broke a test.
7. Stop the server, clean up temp directories, delete the throwaway script.

Paste the real terminal output and a summary of what you saw in the browser into your task report. If this reveals a real bug in Tasks 1–8 (not a problem with the throwaway script), fix it, re-run the affected task's tests, and report the fix clearly rather than working around it silently.

- [ ] **Step 2: Update `server/README.md`**

Replace the entire "What's here today" bullet list (currently describing `POST /traces`, `GET /`, `GET /runs/:traceId`, `GET /harness`, `GET /analytics` as four separate pages) with:
```
## What's here today

- `POST /traces` — OTLP/JSON ingestion, matches the wire format
  `trailai-mcp` already sends. No auth (nothing to protect on one
  developer's own machine).
- A single-page shell: a left rail lists every run (goal, verdict,
  relative time, live-updated every 5s) and stays on screen while the
  main panel swaps between three views, navigated client-side with no
  full page reload:
  - **Detail** (`/runs/:traceId`, or `/` for the most recent run) — the
    Flight Recorder view: goal, verdict, a scrubbable step timeline with
    play/pause/speed controls, per-step expansion showing raw
    input/output, and a Coverage panel showing which of the run's
    harness manifest entries were actually used.
  - **Harness** (`/runs/:traceId/harness`) — the skills, sub-agents, and
    MCP servers that run's harness had available, reshaped from the
    manifest `mcp/` stamps on every run. Always follows whichever run is
    selected in the rail.
  - **Analytics** (`/analytics`) — aggregates coverage across every run
    in the store: which skills/sub-agents/MCP servers are used vs.
    registered but never touched ("dead weight").
  Every route above is also a real, direct, no-JS server-rendered page
  — client-side navigation (via `/app.js`) is progressive enhancement
  on top of that, not a replacement for it.
```

- [ ] **Step 3: Commit**

```bash
cd server
git add README.md
git commit -m "docs(server): describe the unified shell"
```

---

## Self-Review Notes

- **Spec coverage:** §3.1 (shell & routes) → Tasks 2, 8. §3.2 (fragment endpoints, markup vs. data hybrid) → Tasks 1, 3, 4, 5, 6, 8. §3.3 (client router — navigation, back/forward, panel lifecycle, rail polling, error handling) → Task 7. §3.4 (URL scheme) → Task 8's route table. §3.5 (testing) → every task's own test file, matching the `vm`-harness precedent for client code and route-level coverage for the server. §4 (out of scope) and §5 (open items) required no dedicated tasks — they're constraints already respected throughout (no JSON API introduced, no mobile layout work, Harness's picker removed outright per Task 3).
- **Placeholder scan:** every step above contains complete, real code or a fully-specified manual verification checklist — no "TBD"/"handle appropriately"/"similar to Task N" left in.
- **Type consistency:** `ShellState`/`ShellView` (Task 2) are the same shape server-side (`shell.ts`, `server.ts`) and client-side (`app.ts`'s local `ShellState` interface — necessarily a separate declaration since browser code can't import server types at runtime, but field-for-field identical: `view: "detail" | "harness" | "analytics"`, `traceId: string | null`). `renderRailBody`/`renderHarnessBody`/`renderAnalyticsBody`/`renderDetailFragment`/`renderEmptyDetailPanel`/`renderShell`/`renderNotFoundPanel` are named and typed identically everywhere they're declared (Tasks 1–5) and consumed (Task 8). `mountDetailPanel`'s `RunData` type and its consumption via the `#run-data` script tag (Task 5 producing it, Task 6/7 consuming it) match on every field used.
