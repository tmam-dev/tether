# Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new standalone `GET /analytics` page aggregating coverage across every run in the local store — which skills/sub-agents/MCP servers are used vs. dead weight.

**Architecture:** A small addition to `runs.ts` (an uncapped traceId query), a new `analytics.ts` module that aggregates many calls to the already-existing `getCoverage`, a new plain server-rendered template (no client-side JS, matching the harness anatomy page's model, not Flight Recorder's), a new route, and nav-link additions to every existing page.

**Tech Stack:** Same as the rest of the repo — TypeScript/`tsc`, `better-sqlite3`, `node:http`, `node --test`, zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-usage-analytics-design.md`

## Global Constraints

- No new dependencies.
- Tabs indentation, matching every existing file.
- `server/` tests import from `../dist/*.js`, never `../src/*.ts`.
- Every reshape function degrades gracefully (never throws), matching `runs.ts`/`harness.ts`/`coverage.ts`'s established contract.
- Every user-controlled string (skill/sub-agent/MCP-server names) reaching the analytics page goes through an `escapeHtml` matching `harness.ts`'s (`&<>"'`), copied per this codebase's existing per-template-escaper convention — do not import it across template files.
- `Content-Type: text/html; charset=utf-8` on the new HTML route, matching every other page.

---

### Task 1: `getAllTraceIds` in `runs.ts`

**Files:**
- Modify: `server/src/runs.ts`
- Modify: `server/test/runs.test.js`

**Interfaces:**
- Produces: `getAllTraceIds(db): string[]`, consumed by Task 2's `getUsage`.

- [ ] **Step 1: Write the failing test**

Add to `server/test/runs.test.js`, as a new top-level `describe` block (place it after the existing `describe("listRuns", ...)` block):
```js
describe("getAllTraceIds", () => {
	test("returns an empty array when there are no runs", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.deepEqual(getAllTraceIds(db), []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("returns every root span's traceId, uncapped, regardless of order", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			for (let i = 0; i < 5; i++) {
				insertSpan(db, rootSpan({ traceId: `trace-${i}`, spanId: `root-${i}`, goal: `run ${i}`, agent: "a", startNs: `${1000000000000 + i}`, endNs: `${1001000000000 + i}` }));
			}
			const ids = getAllTraceIds(db).sort();
			assert.deepEqual(ids, ["trace-0", "trace-1", "trace-2", "trace-3", "trace-4"]);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("excludes child spans, only returns root spans", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1001000000000" }));
			insertSpan(db, stepSpan({ traceId: "t1", spanId: "s1", parentSpanId: "r1", name: "a step", startNs: "1000000500000", endNs: "1000000900000", toolName: "x" }));
			assert.deepEqual(getAllTraceIds(db), ["t1"]);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
```
Add `getAllTraceIds` to the existing import line at the top of the test file (find `import { getRun, listRuns } from "../dist/runs.js";` and change to `import { getRun, listRuns, getAllTraceIds } from "../dist/runs.js";`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/runs.test.js 2>&1 | tail -30`
Expected: FAIL — `getAllTraceIds` is not exported yet.

- [ ] **Step 3: Implement**

In `server/src/runs.ts`, add the function right after `listRuns` (at the end of the file):
```ts
/** Every root span's traceId, unordered, uncapped. Used only for store-wide aggregation (usage analytics) -- everything else in this codebase deliberately caps and orders by recency. */
export function getAllTraceIds(db: Database.Database): string[] {
	const rows = db.prepare("SELECT traceId FROM spans WHERE parentSpanId IS NULL").all() as { traceId: string }[];
	return rows.map((r) => r.traceId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/runs.test.js`
Expected: PASS, all tests green (previous count + 3 new).

- [ ] **Step 5: Commit**

```bash
cd server
git add src/runs.ts test/runs.test.js
git commit -m "feat(server): add getAllTraceIds for store-wide aggregation"
```

---

### Task 2: `server/src/analytics.ts` — the aggregation

**Files:**
- Create: `server/src/analytics.ts`
- Test: `server/test/analytics.test.js`

**Interfaces:**
- Consumes: `getAllTraceIds` from `./runs.js` (Task 1), `getCoverage`/`CoverageEntry` from `./coverage.js` (already exists).
- Produces: `UsageEntry`, `UsageView`, `getUsage(db): UsageView`, consumed by Task 3's template.

- [ ] **Step 1: Write the failing tests**

Create `server/test/analytics.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getUsage } from "../dist/analytics.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-analytics-test-"));
	return join(dir, "test.sqlite");
}

function otlpAttrs(obj) {
	return Object.entries(obj).map(([key, v]) => {
		const value = typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
			: typeof v === "boolean" ? { boolValue: v }
			: { stringValue: v };
		return { key, value };
	});
}

const ONE_SKILL_MANIFEST = JSON.stringify({
	schemaVersion: 2,
	skills: [{ name: "code-review", description: "reviews diffs", source: "project" }, { name: "deploy", description: "ships it", source: "project" }],
	subAgents: [],
	mcpServers: [],
});

function rootSpan({ traceId, spanId, goal, startNs, endNs, manifest }) {
	const attrs = { "gen_ai.agent.goal": goal, "gen_ai.agent.name": "a" };
	if (manifest !== undefined) attrs["gen_ai.agent.harness_manifest"] = manifest;
	const raw = { traceId, spanId, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events: [], status: { code: 1 } };
	return { traceId, spanId, parentSpanId: null, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

function attributedStep({ traceId, spanId, parentSpanId, name, startNs, endNs, sourceType, sourceName }) {
	const attrs = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name };
	if (sourceType) attrs["gen_ai.harness.source_type"] = sourceType;
	if (sourceName) attrs["gen_ai.harness.source_name"] = sourceName;
	const raw = { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events: [], status: { code: 1 } };
	return { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

describe("getUsage", () => {
	test("returns zeroed-out usage for an empty store", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			const usage = getUsage(db);
			assert.equal(usage.totalRuns, 0);
			assert.equal(usage.trackedRuns, 0);
			assert.deepEqual(usage.entries, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("aggregates usage across multiple runs, marking a never-used entry as dead weight", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			// Run 1: uses code-review twice, never touches deploy.
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g1", startNs: "1000000000000", endNs: "1010000000000", manifest: ONE_SKILL_MANIFEST }));
			insertSpan(db, attributedStep({ traceId: "t1", spanId: "s1", parentSpanId: "r1", name: "review", startNs: "1001000000000", endNs: "1002000000000", sourceType: "skill", sourceName: "code-review" }));
			insertSpan(db, attributedStep({ traceId: "t1", spanId: "s2", parentSpanId: "r1", name: "review again", startNs: "1003000000000", endNs: "1004000000000", sourceType: "skill", sourceName: "code-review" }));

			// Run 2: registers the same manifest, uses neither skill, but IS tracked (an unrelated attributed step exists -- there is none here, so this run is untracked; see run 3 for a tracked-but-unused case).
			insertSpan(db, rootSpan({ traceId: "t2", spanId: "r2", goal: "g2", startNs: "1020000000000", endNs: "1030000000000", manifest: ONE_SKILL_MANIFEST }));

			// Run 3: registers the same manifest, is tracked (uses code-review once), never uses deploy.
			insertSpan(db, rootSpan({ traceId: "t3", spanId: "r3", goal: "g3", startNs: "1040000000000", endNs: "1050000000000", manifest: ONE_SKILL_MANIFEST }));
			insertSpan(db, attributedStep({ traceId: "t3", spanId: "s3", parentSpanId: "r3", name: "review", startNs: "1041000000000", endNs: "1042000000000", sourceType: "skill", sourceName: "code-review" }));

			const usage = getUsage(db);
			assert.equal(usage.totalRuns, 3);
			assert.equal(usage.trackedRuns, 2); // t1 and t3; t2 has no attributed step

			const codeReview = usage.entries.find((e) => e.type === "skill" && e.name === "code-review");
			const deploy = usage.entries.find((e) => e.type === "skill" && e.name === "deploy");

			assert.equal(codeReview.registeredRuns, 3);
			assert.equal(codeReview.trackedRuns, 2);
			assert.equal(codeReview.usedRuns, 2);
			assert.equal(codeReview.totalUsedCount, 3); // 2 in t1 + 1 in t3
			assert.equal(codeReview.deadWeight, false);

			assert.equal(deploy.registeredRuns, 3);
			assert.equal(deploy.trackedRuns, 2);
			assert.equal(deploy.usedRuns, 0);
			assert.equal(deploy.totalUsedCount, 0);
			assert.equal(deploy.deadWeight, true);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("an entry with zero tracked runs is not dead weight -- there's no evidence either way", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g1", startNs: "1000000000000", endNs: "1010000000000", manifest: ONE_SKILL_MANIFEST }));
			const usage = getUsage(db);
			const codeReview = usage.entries.find((e) => e.type === "skill" && e.name === "code-review");
			assert.equal(codeReview.trackedRuns, 0);
			assert.equal(codeReview.deadWeight, false);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/analytics.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/analytics.ts`**

```ts
/**
 * Aggregates getCoverage's per-run result across every run in the store, so
 * a developer can see which skills/sub-agents/MCP servers are used across
 * their whole history vs. registered-but-never-used ("dead weight").
 */

import type Database from "better-sqlite3";
import { getAllTraceIds } from "./runs.js";
import { getCoverage } from "./coverage.js";

export interface UsageEntry {
	type: "skill" | "sub_agent" | "mcp_server";
	name: string;
	registeredRuns: number;
	trackedRuns: number;
	usedRuns: number;
	totalUsedCount: number;
	deadWeight: boolean;
}

export interface UsageView {
	totalRuns: number;
	trackedRuns: number;
	entries: UsageEntry[];
}

interface MutableEntry {
	type: UsageEntry["type"];
	name: string;
	registeredRuns: number;
	trackedRuns: number;
	usedRuns: number;
	totalUsedCount: number;
}

/**
 * Aggregates coverage across every run in the store. Never throws --
 * composes getAllTraceIds and getCoverage, both of which already guarantee
 * that; a null getCoverage result (shouldn't occur for a traceId we just
 * queried, but the type allows it) is simply skipped, not an error.
 */
export function getUsage(db: Database.Database): UsageView {
	const buckets = new Map<string, MutableEntry>();
	let totalRuns = 0;
	let trackedRuns = 0;

	for (const traceId of getAllTraceIds(db)) {
		const coverage = getCoverage(db, traceId);
		if (!coverage) continue;
		totalRuns += 1;
		if (coverage.tracked) trackedRuns += 1;

		for (const entry of coverage.entries) {
			const key = `${entry.type} ${entry.name}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { type: entry.type, name: entry.name, registeredRuns: 0, trackedRuns: 0, usedRuns: 0, totalUsedCount: 0 };
				buckets.set(key, bucket);
			}
			bucket.registeredRuns += 1;
			if (coverage.tracked) {
				bucket.trackedRuns += 1;
				bucket.totalUsedCount += entry.usedCount;
				if (entry.usedCount > 0) bucket.usedRuns += 1;
			}
		}
	}

	const entries: UsageEntry[] = [...buckets.values()].map((b) => ({
		...b,
		deadWeight: b.trackedRuns > 0 && b.usedRuns === 0,
	}));

	return { totalRuns, trackedRuns, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/analytics.test.js`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/analytics.ts test/analytics.test.js
git commit -m "feat(server): add the usage analytics aggregation module (getUsage)"
```

---

### Task 3: Usage analytics page template

**Files:**
- Create: `server/src/templates/analytics.ts`
- Test: `server/test/analytics-page.test.js`

**Interfaces:**
- Consumes: `UsageView`/`UsageEntry` from `../analytics.js` (Task 2).
- Produces: `renderAnalyticsPage(usage: UsageView): string`, consumed by Task 4's route.

- [ ] **Step 1: Write the failing tests**

Create `server/test/analytics-page.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderAnalyticsPage } from "../dist/templates/analytics.js";

function entry(overrides = {}) {
	return { type: "skill", name: "code-review", registeredRuns: 3, trackedRuns: 2, usedRuns: 2, totalUsedCount: 3, deadWeight: false, ...overrides };
}

describe("renderAnalyticsPage", () => {
	test("shows an honest empty-state page when there are no runs at all", () => {
		const html = renderAnalyticsPage({ totalRuns: 0, trackedRuns: 0, entries: [] });
		assert.match(html, /No runs yet/);
	});

	test("shows a distinct message when runs exist but none report coverage tracking", () => {
		const html = renderAnalyticsPage({ totalRuns: 4, trackedRuns: 0, entries: [entry({ trackedRuns: 0, usedRuns: 0, totalUsedCount: 0, deadWeight: false })] });
		assert.match(html, /No runs have reported skill\/sub-agent\/MCP-server usage yet/);
	});

	test("shows a distinct message when tracked runs exist but nothing was ever registered", () => {
		const html = renderAnalyticsPage({ totalRuns: 2, trackedRuns: 2, entries: [] });
		assert.match(html, /No skills, sub-agents, or MCP servers have been registered by any run\./);
	});

	test("shows per-category empty messages when a category has zero entries", () => {
		const html = renderAnalyticsPage({ totalRuns: 2, trackedRuns: 2, entries: [entry()] });
		assert.match(html, /No sub-agents registered by any run\./);
		assert.match(html, /No MCP servers registered by any run\./);
	});

	test("renders an entry's usage counts and flags dead weight", () => {
		const html = renderAnalyticsPage({
			totalRuns: 3,
			trackedRuns: 2,
			entries: [entry({ name: "code-review", registeredRuns: 3, trackedRuns: 2, usedRuns: 2, totalUsedCount: 3, deadWeight: false }), entry({ name: "deploy", registeredRuns: 3, trackedRuns: 2, usedRuns: 0, totalUsedCount: 0, deadWeight: true })],
		});
		assert.match(html, /code-review/);
		assert.match(html, /used in 2\/2 tracked runs \(3 total uses\)/);
		assert.match(html, /deploy/);
		assert.match(html, /DEAD WEIGHT/);
	});

	test("notes how many runs have no coverage tracking, when some (not all) don't", () => {
		const html = renderAnalyticsPage({ totalRuns: 5, trackedRuns: 3, entries: [entry()] });
		assert.match(html, /2 run\(s\) have no coverage tracking/);
	});

	test("escapes an entry name", () => {
		const html = renderAnalyticsPage({ totalRuns: 1, trackedRuns: 1, entries: [entry({ name: "<script>alert(1)</script>" })] });
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/templates/analytics.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/templates/analytics.ts`**

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/analytics-page.test.js`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/analytics.ts test/analytics-page.test.js
git commit -m "feat(server): add the usage analytics page template"
```

---

### Task 4: Wire the route into server.ts, add nav links everywhere

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/templates/run-list.ts`
- Modify: `server/src/templates/flight-recorder.ts`
- Modify: `server/src/templates/harness.ts`
- Test: `server/test/server.test.js`

**Interfaces:**
- Consumes: `getUsage` from `./analytics.js` (Task 2), `renderAnalyticsPage` from `./templates/analytics.js` (Task 3).
- Produces: `GET /analytics` route.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/server.test.js`, as a new top-level `describe` block (place it after the existing `describe("GET /harness", ...)` block, before `describe("unknown routes", ...)`):
```js
describe("GET /analytics", () => {
	test("shows an empty-state page before any ingestion", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/analytics`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			const text = await res.text();
			assert.match(text, /No runs yet/);
		});
	});

	test("reflects real ingested run data", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/analytics`);
			assert.equal(res.status, 200);
			const text = await res.text();
			// otlpPayload's single span has no child steps at all, so its run is
			// untracked (no step ever reported a source) -- the "no runs have
			// reported usage yet" message is the correct, honest outcome here,
			// not the "nothing registered" one (that's for tracked runs with an
			// empty manifest, a different case).
			assert.match(text, /No runs have reported skill\/sub-agent\/MCP-server usage yet/);
		});
	});
});
```

Also add nav-link checks: inside the existing `describe("GET /", ...)` block:
```js
	test("links to the analytics page from the nav", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, /href="\/analytics"/);
		});
	});
```
Inside the existing `describe("GET /runs/:traceId", ...)` block:
```js
	test("links to the analytics page from the topbar", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			const text = await res.text();
			assert.match(text, /href="\/analytics"/);
		});
	});
```
Inside the existing `describe("GET /harness", ...)` block:
```js
	test("links to the analytics page from the topbar", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/harness`);
			const text = await res.text();
			assert.match(text, /href="\/analytics"/);
		});
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — no `/analytics` route exists yet, and no template links to it yet.

- [ ] **Step 3: Add the route to `server/src/server.ts`**

Add the imports alongside the existing ones near the top of the file:
```ts
import { getUsage } from "./analytics.js";
import { renderAnalyticsPage } from "./templates/analytics.js";
```

Add the new route. Insert it after the existing `GET /harness` block (before the final catch-all 404):
```ts
		if (req.method === "GET" && pathname === "/analytics") {
			try {
				const page = renderAnalyticsPage(getUsage(db));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(page);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
			}
			return;
		}
```

- [ ] **Step 4: Add the nav link to `server/src/templates/run-list.ts`**

Find:
```ts
	<div class="nav"><a href="/">Runs</a> · <a href="/harness">Harness</a></div>
```
Change to:
```ts
	<div class="nav"><a href="/">Runs</a> · <a href="/harness">Harness</a> · <a href="/analytics">Analytics</a></div>
```

- [ ] **Step 5: Add the nav link to `server/src/templates/flight-recorder.ts`**

Find:
```html
    <a class="backlink" href="/">&larr; All runs</a>
    <a class="backlink" href="/harness">Harness</a>
```
Change to:
```html
    <a class="backlink" href="/">&larr; All runs</a>
    <a class="backlink" href="/harness">Harness</a>
    <a class="backlink" href="/analytics">Analytics</a>
```

- [ ] **Step 6: Add the nav link to `server/src/templates/harness.ts`**

Find:
```ts
		<a class="backlink" href="/">&larr; All runs</a>
	</div>
```
Change to:
```ts
		<a class="backlink" href="/">&larr; All runs</a>
		<a class="backlink" href="/analytics">Analytics</a>
	</div>
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && npm run build && npm test`
Expected: PASS, full suite green (previous count + 2 new `GET /analytics` tests + 3 new nav-link tests).

- [ ] **Step 8: Commit**

```bash
cd server
git add src/server.ts src/templates/run-list.ts src/templates/flight-recorder.ts src/templates/harness.ts test/server.test.js
git commit -m "feat(server): serve the usage analytics page and link it from every nav"
```

---

### Task 5: End-to-end verification and README update

**Files:**
- Modify: `server/README.md`

**Interfaces:**
- Consumes: the full pipeline from Tasks 1-4, plus the real `mcp/` package.
- Produces: no new code — verification evidence plus a README update.

- [ ] **Step 1: Manual end-to-end verification**

Write a throwaway script (do not commit it — delete it when done, matching every prior plan's final task) that:
1. Rebuilds both packages fresh: `cd mcp && npm run build`, `cd server && npm run build`.
2. Starts the real built `server/dist/index.js` on a test port, `HOME` overridden to a fresh `mkdtemp` directory.
3. Creates a fake project directory (via `mkdtemp`) with a `.claude/skills/code-review/SKILL.md` (valid frontmatter), so runs against it have a real manifest entry to aggregate.
4. Runs three separate `trail_start_run`/...(steps)/`trail_finish_run` sequences (each its own MCP client connection, matching this project's established e2e pattern) against that same project directory:
   - Run 1: one `trail_log_step` call WITH `source_type: "skill"`/`source_name: "code-review"` set.
   - Run 2: one `trail_log_step` call WITH the same attribution set again (so `code-review`'s `totalUsedCount` across the store should be 2, `usedRuns` should be 2).
   - Run 3: zero steps logged (untracked).
5. `curl`s `http://127.0.0.1:<port>/analytics` and confirms in the raw HTML (the injected `RUN`-equivalent isn't relevant here since this page has no client-side JS — check the plain server-rendered HTML directly, unlike the Flight Recorder page): `code-review` shows "used in 2/2 tracked runs (2 total uses)", no `DEAD WEIGHT` tag on it, and the page notes "1 run(s) have no coverage tracking".
6. Also `curl`s `http://127.0.0.1:<port>/`, a `GET /runs/:traceId` for one of the three runs, and `http://127.0.0.1:<port>/harness`, confirming each links to `/analytics` and that link resolves correctly.
7. Stops the server, cleans up temp directories, deletes the throwaway script.

Paste the real terminal output (the relevant curl'd HTML excerpts) into your task report. If this reveals a real bug in Tasks 1-4 (not a problem with the throwaway script), report it clearly rather than working around it silently.

- [ ] **Step 2: Update `server/README.md`**

Find the bullet list describing served pages (after the `GET /harness` bullet added by the harness anatomy plan). Add:
```
- `GET /analytics` — aggregates coverage across every run in the local
  store: which skills/sub-agents/MCP servers are used vs. registered but
  never touched ("dead weight"), reshaped from the same per-run coverage
  data the Flight Recorder page's Coverage panel already computes. No
  correlation with failures/retries/cost -- that's real statistical work
  left for a future increment once there's enough real usage data to make
  it meaningful.
```

- [ ] **Step 3: Commit**

```bash
cd server
git add README.md
git commit -m "docs(server): describe the usage analytics page"
```
