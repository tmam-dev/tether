# Harness Anatomy View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a standalone `GET /harness` page showing a run's harness manifest (skills, sub-agents, MCP servers) as a flat categorized list, with a picker to view an older run's snapshot.

**Architecture:** A new backend reshape module (`server/src/harness.ts`) parses the `gen_ai.agent.harness_manifest` JSON string already stamped on every root span, into a plain `HarnessView`. A new template (`server/src/templates/harness.ts`) renders it server-side, no client-side fetch. A new route in `server.ts` wires the two together, plus small nav-link additions to the two existing pages so a developer can move between run list, Flight Recorder, and Harness.

**Tech Stack:** Same as the rest of `server/` — TypeScript compiled via `tsc`, `better-sqlite3`, plain `node:http`, `node --test` for tests, zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-harness-anatomy-view-design.md`

## Global Constraints

- No new dependencies — everything here is TypeScript/string-building against the existing `better-sqlite3`.
- Tabs indentation, matching every existing file in `server/`.
- Tests import from `../dist/*.js` (compiled output), never from `../src/*.ts` — matching `runs.test.js`/`server.test.js`.
- Every reshape function degrades gracefully (never throws) — a missing/malformed harness manifest yields empty categories, not a crash. Only an unknown `traceId`/empty database yields `null`.
- Every user-controlled string (skill/sub-agent names and descriptions, sub-agent tool names, MCP server names, the run's goal, the traceId used in the run-picker's `<option value>`) must go through `escapeHtml()` before interpolation into HTML — this exact class of bug (missing attribute-context escaping, and an unescaped `<script>`-injected JSON blob) produced two Critical XSS findings in the Flight Recorder build. This page avoids the injection-blob pattern entirely by building the run-picker as plain escaped `<option>` tags rather than injecting a JSON array into a `<script>` block.
- `Content-Type: text/html; charset=utf-8` on both new/modified HTML responses (matching the fix already shipped for the other two routes).

---

### Task 1: Backend reshape module

**Files:**
- Modify: `server/src/runs.ts` (export the existing `toAttributeMap` helper)
- Create: `server/src/harness.ts`
- Test: `server/test/harness.test.js`

**Interfaces:**
- Consumes: `toAttributeMap(attributes)` from `runs.ts` (newly exported, unchanged signature: `(attributes: { key: string; value: Record<string, unknown> }[] | undefined) => Record<string, string | number | boolean>`).
- Produces: `HarnessView`, `HarnessSkillView`, `HarnessSubAgentView`, `HarnessMcpServerView` types and `getHarnessView(db, traceId?): HarnessView | null`, all consumed by Task 2's template and Task 3's route.

- [ ] **Step 1: Export `toAttributeMap` from `runs.ts`**

In `server/src/runs.ts`, change:
```ts
function toAttributeMap(attributes: { key: string; value: Record<string, unknown> }[] | undefined): AttrMap {
```
to:
```ts
export function toAttributeMap(attributes: { key: string; value: Record<string, unknown> }[] | undefined): AttrMap {
```
No other change to this file. `AttrMap` itself stays unexported — the new module below uses the equivalent inline type, since TypeScript's structural typing makes that legal without importing the alias.

- [ ] **Step 2: Write the failing tests**

Create `server/test/harness.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getHarnessView } from "../dist/harness.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-harness-test-"));
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

function rootSpan({ traceId, spanId, goal, startNs, endNs, manifest }) {
	const attrs = { "gen_ai.agent.goal": goal, "gen_ai.agent.name": "coding-agent" };
	if (manifest !== undefined) attrs["gen_ai.agent.harness_manifest"] = manifest;
	const raw = { traceId, spanId, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events: [], status: { code: 1 } };
	return { traceId, spanId, parentSpanId: null, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

const FULL_MANIFEST = JSON.stringify({
	schemaVersion: 2,
	skills: [{ name: "code-review", description: "reviews diffs for bugs", source: "project" }],
	subAgents: [{ name: "Explore", description: "fast read-only search", tools: ["Grep", "Glob", "Read"] }],
	mcpServers: [{ name: "context7" }],
});

describe("getHarnessView", () => {
	test("returns null when the database has no runs at all", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.equal(getHarnessView(db), null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("returns null for an unknown traceId even when other runs exist", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g", startNs: "1000000000000", endNs: "1001000000000", manifest: FULL_MANIFEST }));
			assert.equal(getHarnessView(db, "nonexistent"), null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("reshapes a full manifest into skills/subAgents/mcpServers", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t2", spanId: "r2", goal: "fix the flaky auth test", startNs: "1000000000000", endNs: "1001000000000", manifest: FULL_MANIFEST }));
			const view = getHarnessView(db, "t2");
			assert.equal(view.traceId, "t2");
			assert.equal(view.goal, "fix the flaky auth test");
			assert.equal(view.skills.length, 1);
			assert.deepEqual(view.skills[0], { name: "code-review", description: "reviews diffs for bugs", source: "project" });
			assert.equal(view.subAgents.length, 1);
			assert.deepEqual(view.subAgents[0], { name: "Explore", description: "fast read-only search", tools: ["Grep", "Glob", "Read"] });
			assert.equal(view.mcpServers.length, 1);
			assert.deepEqual(view.mcpServers[0], { name: "context7" });
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to empty categories (not null, not a throw) when the manifest attribute is missing", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t3", spanId: "r3", goal: "g", startNs: "1000000000000", endNs: "1001000000000" }));
			const view = getHarnessView(db, "t3");
			assert.notEqual(view, null);
			assert.deepEqual(view.skills, []);
			assert.deepEqual(view.subAgents, []);
			assert.deepEqual(view.mcpServers, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to empty categories when the manifest attribute is malformed JSON", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t4", spanId: "r4", goal: "g", startNs: "1000000000000", endNs: "1001000000000", manifest: "{not valid json" }));
			const view = getHarnessView(db, "t4");
			assert.deepEqual(view.skills, []);
			assert.deepEqual(view.subAgents, []);
			assert.deepEqual(view.mcpServers, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to empty categories when a category entry has the wrong shape", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			const badManifest = JSON.stringify({ schemaVersion: 2, skills: [{ name: "ok but no description" }], subAgents: "not an array", mcpServers: [{ name: 123 }] });
			insertSpan(db, rootSpan({ traceId: "t5", spanId: "r5", goal: "g", startNs: "1000000000000", endNs: "1001000000000", manifest: badManifest }));
			const view = getHarnessView(db, "t5");
			assert.deepEqual(view.skills, []);
			assert.deepEqual(view.subAgents, []);
			assert.deepEqual(view.mcpServers, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("with no traceId, returns the most recently started run's manifest", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "older", spanId: "r6", goal: "older run", startNs: "1000000000000", endNs: "1001000000000", manifest: FULL_MANIFEST }));
			insertSpan(db, rootSpan({ traceId: "newer", spanId: "r7", goal: "newer run", startNs: "2000000000000", endNs: "2001000000000" }));
			const view = getHarnessView(db);
			assert.equal(view.traceId, "newer");
			assert.equal(view.goal, "newer run");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2b: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/harness.ts` does not exist yet, so `tsc` (and the test imports from `../dist/harness.js`) will error.

- [ ] **Step 3: Implement `server/src/harness.ts`**

```ts
/**
 * Reshapes a run's stored harness manifest (captured by mcp/src/manifest.ts
 * and stamped on trail_finish_run's root span as gen_ai.agent.harness_manifest)
 * into a plain view object a template can read directly. Degrades gracefully
 * to empty categories on a missing/malformed manifest -- never throws,
 * matching runs.ts's contract. Returns null only when there is no matching
 * root span at all.
 */

import type Database from "better-sqlite3";
import { toAttributeMap } from "./runs.js";

export interface HarnessSkillView {
	name: string;
	description: string;
	source: "project" | "user";
}

export interface HarnessSubAgentView {
	name: string;
	description: string;
	tools: string[];
}

export interface HarnessMcpServerView {
	name: string;
}

export interface HarnessView {
	traceId: string;
	goal: string;
	startedAt: string;
	skills: HarnessSkillView[];
	subAgents: HarnessSubAgentView[];
	mcpServers: HarnessMcpServerView[];
}

interface StoredRow {
	traceId: string;
	name: string;
	startTimeUnixNano: string;
	raw: string;
}

interface ParsedManifest {
	skills: HarnessSkillView[];
	subAgents: HarnessSubAgentView[];
	mcpServers: HarnessMcpServerView[];
}

const EMPTY_MANIFEST: ParsedManifest = { skills: [], subAgents: [], mcpServers: [] };

function isSkillEntry(v: unknown): v is HarnessSkillView {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return typeof s.name === "string" && typeof s.description === "string" && (s.source === "project" || s.source === "user");
}

function isSubAgentEntry(v: unknown): v is HarnessSubAgentView {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.name === "string" &&
		typeof s.description === "string" &&
		Array.isArray(s.tools) &&
		s.tools.every((t) => typeof t === "string")
	);
}

function isMcpServerEntry(v: unknown): v is HarnessMcpServerView {
	if (typeof v !== "object" || v === null) return false;
	return typeof (v as Record<string, unknown>).name === "string";
}

/** Parses the gen_ai.agent.harness_manifest attribute value. Never throws -- any failure (not a string, invalid JSON, wrong shape) yields EMPTY_MANIFEST. */
function parseManifest(raw: unknown): ParsedManifest {
	if (typeof raw !== "string") return EMPTY_MANIFEST;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY_MANIFEST;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY_MANIFEST;
	const m = parsed as { skills?: unknown; subAgents?: unknown; mcpServers?: unknown };

	return {
		skills: Array.isArray(m.skills) ? m.skills.filter(isSkillEntry) : [],
		subAgents: Array.isArray(m.subAgents) ? m.subAgents.filter(isSubAgentEntry) : [],
		mcpServers: Array.isArray(m.mcpServers) ? m.mcpServers.filter(isMcpServerEntry) : [],
	};
}

/** Parses a nanosecond-timestamp string to a bigint, returning 0n (never throwing) on malformed input. */
function toNsOrZero(s: string): bigint {
	try {
		return BigInt(s);
	} catch {
		return 0n;
	}
}

function rowToView(row: StoredRow): HarnessView {
	let attrs: Record<string, string | number | boolean>;
	try {
		const parsed = JSON.parse(row.raw) as { attributes?: { key: string; value: Record<string, unknown> }[] };
		attrs = toAttributeMap(parsed.attributes);
	} catch {
		attrs = {};
	}

	const manifest = parseManifest(attrs["gen_ai.agent.harness_manifest"]);
	const startNs = toNsOrZero(row.startTimeUnixNano);

	return {
		traceId: row.traceId,
		goal: (attrs["gen_ai.agent.goal"] as string | undefined) ?? row.name,
		startedAt: new Date(Number(startNs / 1_000_000n)).toISOString(),
		...manifest,
	};
}

/**
 * Reshapes the harness manifest stamped on a run's root span into a
 * HarnessView. With no traceId, returns the most recently started run's
 * manifest. Returns null only when there is no matching root span at all
 * (empty database, or an unknown traceId) -- a missing/malformed manifest
 * on an existing run instead yields a HarnessView with empty categories,
 * since the run itself is real and should still be selectable in the
 * picker built from listRuns.
 */
export function getHarnessView(db: Database.Database, traceId?: string): HarnessView | null {
	const row = traceId
		? (db
				.prepare("SELECT traceId, name, startTimeUnixNano, raw FROM spans WHERE traceId = ? AND parentSpanId IS NULL")
				.get(traceId) as StoredRow | undefined)
		: (db
				.prepare("SELECT traceId, name, startTimeUnixNano, raw FROM spans WHERE parentSpanId IS NULL ORDER BY startTimeUnixNano DESC LIMIT 1")
				.get() as StoredRow | undefined);

	if (!row) return null;
	return rowToView(row);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/harness.test.js`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/runs.ts src/harness.ts test/harness.test.js
git commit -m "feat(server): add the harness manifest reshape module (getHarnessView)"
```

---

### Task 2: Harness page template

**Files:**
- Create: `server/src/templates/harness.ts`
- Test: `server/test/harness-page.test.js`

**Interfaces:**
- Consumes: `HarnessView`, `HarnessSkillView`, `HarnessSubAgentView`, `HarnessMcpServerView` from `../harness.js` (Task 1); `RunSummary` from `../runs.js` (already exists).
- Produces: `renderHarnessPage(view: HarnessView | null, runs: RunSummary[]): string`, consumed by Task 3's route.

- [ ] **Step 1: Write the failing tests**

Create `server/test/harness-page.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderHarnessPage } from "../dist/templates/harness.js";

const RUNS = [
	{ traceId: "t2", goal: "fix the flaky auth test", verdict: "unjudged", dur: "8s", startedAt: "2026-08-21T16:55:08.226Z" },
	{ traceId: "t1", goal: "older run", verdict: "unjudged", dur: "3s", startedAt: "2026-08-20T10:00:00.000Z" },
];

function view(overrides = {}) {
	return {
		traceId: "t2",
		goal: "fix the flaky auth test",
		startedAt: "2026-08-21T16:55:08.226Z",
		skills: [],
		subAgents: [],
		mcpServers: [],
		...overrides,
	};
}

describe("renderHarnessPage", () => {
	test("shows an honest empty-state page when there are no runs at all", () => {
		const html = renderHarnessPage(null, []);
		assert.match(html, /No runs yet/);
	});

	test("shows per-category empty messages when a run has no discovered entries", () => {
		const html = renderHarnessPage(view(), RUNS);
		assert.match(html, /No skills discovered for this run\./);
		assert.match(html, /No sub-agents discovered for this run\./);
		assert.match(html, /No MCP servers discovered for this run\./);
	});

	test("renders skills, sub-agents (with their tools), and MCP servers", () => {
		const html = renderHarnessPage(
			view({
				skills: [{ name: "code-review", description: "reviews diffs for bugs", source: "project" }],
				subAgents: [{ name: "Explore", description: "fast read-only search", tools: ["Grep", "Glob", "Read"] }],
				mcpServers: [{ name: "context7" }],
			}),
			RUNS,
		);
		assert.match(html, /code-review/);
		assert.match(html, /reviews diffs for bugs/);
		assert.match(html, /Explore/);
		assert.match(html, /Tools: Grep, Glob, Read/);
		assert.match(html, /context7/);
	});

	test("escapes a skill name/description and a sub-agent tool name", () => {
		const html = renderHarnessPage(
			view({
				skills: [{ name: "<script>alert(1)</script>", description: "<img src=x onerror=alert(2)>", source: "project" }],
				subAgents: [{ name: "a", description: "b", tools: ['"><script>alert(3)</script>'] }],
			}),
			RUNS,
		);
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.doesNotMatch(html, /<img src=x onerror=alert\(2\)>/);
		assert.doesNotMatch(html, /"><script>alert\(3\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("escapes a double quote in a traceId so it cannot break out of the option's value attribute", () => {
		const html = renderHarnessPage(view(), [{ traceId: 'x" onmouseover="alert(1)', goal: "g", verdict: "unjudged", dur: "1s", startedAt: "2026-01-01" }]);
		assert.match(html, /value="x&quot; onmouseover=&quot;alert\(1\)"/);
		assert.doesNotMatch(html, /value="x" onmouseover="alert\(1\)"/);
	});

	test("marks the currently-viewed run as selected in the picker", () => {
		const html = renderHarnessPage(view({ traceId: "t1", goal: "older run" }), RUNS);
		assert.match(html, /value="t1" selected/);
		assert.doesNotMatch(html, /value="t2" selected/);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/templates/harness.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/templates/harness.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/harness-page.test.js`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/templates/harness.ts test/harness-page.test.js
git commit -m "feat(server): add the harness anatomy page template"
```

---

### Task 3: Wire the new route into server.ts, add nav links

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/templates/run-list.ts`
- Modify: `server/src/templates/flight-recorder.ts`
- Test: `server/test/server.test.js`

**Interfaces:**
- Consumes: `getHarnessView` from `./harness.js` (Task 1), `renderHarnessPage` from `./templates/harness.js` (Task 2), `listRuns` from `./runs.js` (already imported).
- Produces: `GET /harness` and `GET /harness?run=<traceId>` routes.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/server.test.js`, inside a new `describe("GET /harness", ...)` block (place it after the existing `describe("GET /runs/:traceId", ...)` block, before `describe("unknown routes", ...)`):
```js
describe("GET /harness", () => {
	test("shows an empty-state page before any ingestion", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/harness`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			const text = await res.text();
			assert.match(text, /No runs yet/);
		});
	});

	test("shows the most recent run's manifest with no query param", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/harness`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /test-span/);
		});
	});

	test("shows a specific run's manifest via ?run=", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/harness?run=${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /test-span/);
		});
	});
});
```

Also add, inside the existing `describe("GET /", ...)` block, a nav-link check:
```js
	test("links to the harness page from the nav", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, /href="\/harness"/);
		});
	});
```

And inside `describe("GET /runs/:traceId", ...)`:
```js
	test("links to the harness page from the topbar", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			const text = await res.text();
			assert.match(text, /href="\/harness"/);
		});
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/server.test.js 2>&1 | tail -40`
Expected: FAIL — no `/harness` route exists yet, and neither template links to it yet.

- [ ] **Step 3: Add the route to `server/src/server.ts`**

Add the import alongside the existing template/reshape imports near the top of the file:
```ts
import { getHarnessView } from "./harness.js";
import { renderHarnessPage } from "./templates/harness.js";
```

Add the new route. Insert it after the existing `GET /runs/:traceId` block (before the final catch-all 404):
```ts
		if (req.method === "GET" && pathname === "/harness") {
			try {
				const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
				const traceId = query.get("run") ?? undefined;
				const view = getHarnessView(db, traceId);
				const page = renderHarnessPage(view, listRuns(db, 50));
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

Change:
```ts
<div class="wrap">
	<h1>Tether — Runs</h1>
```
to:
```ts
<div class="wrap">
	<div class="nav"><a href="/">Runs</a> · <a href="/harness">Harness</a></div>
	<h1>Tether — Runs</h1>
```

Add one small CSS rule to the existing `<style>` block (the existing `a { color:#0B7C87; text-decoration:none; }` rule already styles these links; only the wrapper needs a rule):
```
.nav { font-size:12px; color:#8A8F97; margin-bottom:10px; }
```

- [ ] **Step 5: Add the nav link to `server/src/templates/flight-recorder.ts`**

Change:
```html
    <a class="backlink" href="/">&larr; All runs</a>
```
to:
```html
    <a class="backlink" href="/">&larr; All runs</a>
    <a class="backlink" href="/harness">Harness</a>
```
No CSS change needed — `.backlink` and the flex-wrap `.topbar` already support a second link.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npm run build && npm test`
Expected: PASS, full suite green (43 existing + 3 new `GET /harness` tests + 2 new nav-link tests = 48).

- [ ] **Step 7: Commit**

```bash
cd server
git add src/server.ts src/templates/run-list.ts src/templates/flight-recorder.ts test/server.test.js
git commit -m "feat(server): serve the harness anatomy page and link it from the nav"
```

---

### Task 4: End-to-end verification and README update

**Files:**
- Modify: `server/README.md`

**Interfaces:**
- Consumes: the full pipeline built in Tasks 1-3, plus the real `mcp/` package (already builds `HarnessManifest` via `mcp/src/manifest.ts` and stamps it via `trail_finish_run`).
- Produces: no new code — verification evidence plus a README update.

- [ ] **Step 1: Manual end-to-end verification**

Write a throwaway script (do not commit it — delete it when done, same discipline as the Flight Recorder plan's Task 4) that:
1. Builds both packages fresh: `cd mcp && npm run build`, `cd server && npm run build`.
2. Starts the real built `server/dist/index.js` on a test port, with `HOME` overridden to a fresh `mkdtemp` directory (isolating its SQLite data dir from any real local Tether data — `resolveDataDir()` in `db.ts` reads `os.homedir()`, which honors `HOME`).
3. Creates a temporary fake project directory (also via `mkdtemp`) containing:
   - `.claude/skills/code-review/SKILL.md` with valid frontmatter (`name`, `description`).
   - `.claude/agents/explore.md` with valid frontmatter (`name`, `description`, `tools: Grep, Glob, Read`).
   - `.mcp.json` with one entry under `mcpServers` (e.g. `{"mcpServers":{"context7":{"command":"true"}}}` — command is irrelevant, only the key name is ever read).
4. Spawns the real built `mcp/dist/index.js` as an MCP child process via `StdioClientTransport`/`Client`, with `TRAIL_URL` pointed at the test server and `TRAIL_PROJECT_ROOT` pointed at the fake project directory from step 3.
5. Calls `trail_start_run` (this is what triggers `buildHarnessManifest(rootDir)` and stamps the manifest — no steps need to be logged for this verification), then `trail_finish_run`.
6. Runs a second `trail_start_run`/`trail_finish_run` pair with `TRAIL_PROJECT_ROOT` pointed at a *different*, empty temp directory (no `.claude/skills`, no `.claude/agents`, no `.mcp.json`) — this is the "manifest exists but every category is empty" case, distinct from Task 1's "manifest attribute missing entirely" case (which is only reachable for runs that predate this feature and can't be produced by the real `mcp/`, so that case is covered by Task 1's unit test, not this live verification).
7. `curl`s `http://127.0.0.1:<port>/harness` (expect the newer, empty-categories run's data, with the honest per-category empty messages) and `http://127.0.0.1:<port>/harness?run=<traceId-of-the-first-run>` (expect the code-review skill, Explore sub-agent with its tools, and context7 MCP server to all appear). Confirm both pages also show the run picker with both runs listed.
8. Also `curl`s `http://127.0.0.1:<port>/` and `http://127.0.0.1:<port>/runs/<either-traceId>` to confirm the new "Harness" nav link is present and functional (i.e., following it lands on `/harness`).
9. Stops the server, cleans up both temp directories, deletes the throwaway script.

Paste the real terminal output (both curl'd pages' key content, or a clear excerpt) into your task report.

If this reveals a real bug in Tasks 1-3's code (not a problem with the throwaway script itself), report it clearly rather than working around it silently — this exact kind of check has caught real bugs earlier in this project (a header-ordering crash, a `homeDir` default pointing at the wrong file, a missing UTF-8 charset declaration).

- [ ] **Step 2: Update `server/README.md`**

Find the "What's here today" section (or equivalent bullet list describing the served pages — it currently describes the run list and Flight Recorder pages from the prior plan). Add one bullet:
```
- `GET /harness` (optionally `?run=<traceId>`) — the harness anatomy page: the skills, sub-agents, and MCP servers a run's harness had available, reshaped from the manifest `mcp/` stamps on every run. Defaults to the most recent run; use the picker (or the query param) to see an older run's snapshot.
```

- [ ] **Step 3: Commit**

```bash
cd server
git add README.md
git commit -m "docs(server): describe the harness anatomy page"
```
