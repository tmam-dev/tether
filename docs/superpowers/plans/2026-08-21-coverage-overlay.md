# Coverage Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional skill/sub-agent/MCP-server attribution field to `trail_log_step`, and a new "Coverage" panel on the existing Flight Recorder run detail page showing which of a run's harness manifest entries were actually used.

**Architecture:** `mcp/src/index.ts`'s `trail_log_step` gains two optional parameters, emitted as two new OTLP span attributes. `server/src/runs.ts`'s `StepView` gains matching optional fields. A new `server/src/coverage.ts` module joins `getRun`'s steps against `getHarnessView`'s manifest to produce per-entry usage counts. `server/src/templates/flight-recorder.ts` gains a third panel rendering that join; `server/src/server.ts` wires it into the existing `GET /runs/:traceId` route (no new route).

**Tech Stack:** Same as the rest of the repo — TypeScript/`tsc`, `better-sqlite3`, `node:http`, `node --test`, zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-coverage-overlay-design.md`

## Global Constraints

- No new dependencies.
- Tabs indentation, matching every existing file.
- `server/` tests import from `../dist/*.js`, never `../src/*.ts`.
- Every reshape function degrades gracefully (never throws) — matching `runs.ts`/`harness.ts`'s established contract. `getCoverage` returns `null` only when the run itself doesn't exist.
- Every user-controlled string (skill/sub-agent/MCP-server names) that reaches the Coverage panel goes through the page's existing client-side `escapeHtml()` — the same one `renderMission`/`renderSteps`/`renderVerdict` already use. Do not introduce a second escaper.
- `mcp/src/index.ts`'s tool handlers are not unit-tested in this codebase today (verified: no `mcp/test/index.test.js` exists) — verification for Task 1 happens in Task 5's end-to-end check, matching this project's existing pattern, not by adding a new unit-test file that would be the first of its kind.

---

### Task 1: `trail_log_step` gains optional source attribution

**Files:**
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Produces: two new optional tool parameters (`source_type`, `source_name`) and two new span attributes (`gen_ai.harness.source_type`, `gen_ai.harness.source_name`), consumed by Task 2's `getRun`.

- [ ] **Step 1: Add the two new parameters to `trail_log_step`'s `inputSchema`**

In `mcp/src/index.ts`, find the `trail_log_step` tool's `inputSchema` object:
```ts
		inputSchema: {
			run_id: z.string(),
			name: z.string().describe("Step name, e.g. 'run pytest' or 'edit auth.py'"),
			kind: z.enum(["task", "tool"]).describe("task = reasoning/work unit, tool = external action"),
			input: z.string().optional().describe("What went in (command, arguments, file path…)"),
			output: z.string().optional().describe("What came out (truncated result, diff summary…)"),
			status: statusSchema,
			error_message: z.string().optional(),
			duration_ms: z.number().optional().describe("How long the step took (defaults to instant)"),
		},
```
Add two new fields after `duration_ms`:
```ts
		inputSchema: {
			run_id: z.string(),
			name: z.string().describe("Step name, e.g. 'run pytest' or 'edit auth.py'"),
			kind: z.enum(["task", "tool"]).describe("task = reasoning/work unit, tool = external action"),
			input: z.string().optional().describe("What went in (command, arguments, file path…)"),
			output: z.string().optional().describe("What came out (truncated result, diff summary…)"),
			status: statusSchema,
			error_message: z.string().optional(),
			duration_ms: z.number().optional().describe("How long the step took (defaults to instant)"),
			source_type: z.enum(["skill", "sub_agent", "mcp_server"]).optional()
				.describe("If this step came from a registered skill, sub-agent, or MCP server, which kind"),
			source_name: z.string().optional()
				.describe("Name of the skill/sub-agent/MCP server, matching an entry from this run's harness manifest"),
		},
```

- [ ] **Step 2: Update the handler to accept and conditionally emit the new attributes**

Find the handler function signature:
```ts
	async ({ run_id, name, kind, input, output, status, error_message, duration_ms }) => {
```
Change to:
```ts
	async ({ run_id, name, kind, input, output, status, error_message, duration_ms, source_type, source_name }) => {
```

Find the `attributes` object inside the `sendSpan` call:
```ts
			attributes: {
				"gen_ai.operation.name": kind === "tool" ? "execute_tool" : "execute_task",
				"gen_ai.system": "trail-mcp",
				"gen_ai.agent.name": run.agent,
				...(kind === "tool" ? { "gen_ai.tool.name": name } : {}),
			},
```
Add the both-or-neither attribution pair (only emitted when BOTH `source_type` and `source_name` are present — a single one alone isn't a usable signal):
```ts
			attributes: {
				"gen_ai.operation.name": kind === "tool" ? "execute_tool" : "execute_task",
				"gen_ai.system": "trail-mcp",
				"gen_ai.agent.name": run.agent,
				...(kind === "tool" ? { "gen_ai.tool.name": name } : {}),
				...(source_type && source_name ? { "gen_ai.harness.source_type": source_type, "gen_ai.harness.source_name": source_name } : {}),
			},
```

- [ ] **Step 3: Build and confirm no type errors**

Run: `cd mcp && npm run build`
Expected: clean build, no errors. (No unit test to run here per this task's Global Constraint — verified end-to-end in Task 5.)

- [ ] **Step 4: Commit**

```bash
cd mcp
git add src/index.ts
git commit -m "feat(mcp): add optional skill/sub-agent/MCP-server attribution to trail_log_step"
```

---

### Task 2: `runs.ts` reshapes the new attributes into `StepView`

**Files:**
- Modify: `server/src/runs.ts`
- Modify: `server/test/runs.test.js`

**Interfaces:**
- Produces: `StepView.sourceType?: "skill" | "sub_agent" | "mcp_server"` and `StepView.sourceName?: string`, consumed by Task 3's `getCoverage`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/runs.test.js`, inside the existing `describe("getRun", ...)` block (the exact insertion point doesn't matter — append near the other step-shape tests):
```js
	test("reshapes a step's source_type/source_name attribution when present", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t10", spanId: "r10", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			const attributed = stepSpan({ traceId: "t10", spanId: "s1", parentSpanId: "r10", name: "review the diff", startNs: "1010000000000", endNs: "1011000000000", toolName: "review the diff" });
			attributed.raw = JSON.stringify({ ...JSON.parse(attributed.raw), attributes: [...JSON.parse(attributed.raw).attributes, { key: "gen_ai.harness.source_type", value: { stringValue: "skill" } }, { key: "gen_ai.harness.source_name", value: { stringValue: "code-review" } }] });
			insertSpan(db, attributed);
			const unattributed = stepSpan({ traceId: "t10", spanId: "s2", parentSpanId: "r10", name: "plain step", startNs: "1012000000000", endNs: "1013000000000" });
			insertSpan(db, unattributed);

			const run = getRun(db, "t10");
			const step1 = run.steps.find((s) => s.title === "review the diff");
			const step2 = run.steps.find((s) => s.title === "plain step");
			assert.equal(step1.sourceType, "skill");
			assert.equal(step1.sourceName, "code-review");
			assert.equal(step2.sourceType, undefined);
			assert.equal(step2.sourceName, undefined);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("ignores an unrecognized source_type value rather than passing it through", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t11", spanId: "r11", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			const step = stepSpan({ traceId: "t11", spanId: "s1", parentSpanId: "r11", name: "weird step", startNs: "1010000000000", endNs: "1011000000000" });
			step.raw = JSON.stringify({ ...JSON.parse(step.raw), attributes: [...JSON.parse(step.raw).attributes, { key: "gen_ai.harness.source_type", value: { stringValue: "not-a-real-type" } }, { key: "gen_ai.harness.source_name", value: { stringValue: "whatever" } }] });
			insertSpan(db, step);

			const run = getRun(db, "t11");
			assert.equal(run.steps[0].sourceType, undefined);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/runs.test.js 2>&1 | tail -40`
Expected: FAIL — `sourceType`/`sourceName` are `undefined` on the attributed step (the reshape doesn't read the new attributes yet).

- [ ] **Step 3: Implement**

In `server/src/runs.ts`, add the two new optional fields to `StepView`:
```ts
export interface StepView {
	type: StepType;
	title: string;
	status: "ok" | "err";
	start: number;
	dur: number;
	cost: number | null;
	tok: number | null;
	io: [string, string][];
	sig?: RetrySignal[];
	sourceType?: "skill" | "sub_agent" | "mcp_server";
	sourceName?: string;
}
```

Add a small validation helper near `asString`/`toIsoOrEmpty` (same file):
```ts
/** Returns v if it's one of the three recognized source types, otherwise undefined -- an unrecognized value from unauthenticated ingest is treated the same as no attribution at all. */
function asSourceType(v: unknown): StepView["sourceType"] {
	return v === "skill" || v === "sub_agent" || v === "mcp_server" ? v : undefined;
}
```

In `getRun`'s step-building loop, find:
```ts
		steps.push({
			type: inferStepType(parsed.attrs),
			title: asString(parsed.attrs["gen_ai.tool.name"]) ?? row.name,
			status: parsed.errorCode === 2 ? "err" : "ok",
			start: Number(startNs - rootStartNs) / 1e9,
			dur: Number(endNs - startNs) / 1e9,
			cost,
			tok,
			io: buildStepIo(parsed.events),
		});
```
Add the two new fields, keeping the both-or-neither rule (a `sourceType` with no `sourceName`, or vice versa, is dropped — matches Task 1's emission rule, and protects `coverage.ts` from ever seeing a half-formed pair):
```ts
		const sourceType = asSourceType(parsed.attrs["gen_ai.harness.source_type"]);
		const sourceName = asString(parsed.attrs["gen_ai.harness.source_name"]);

		steps.push({
			type: inferStepType(parsed.attrs),
			title: asString(parsed.attrs["gen_ai.tool.name"]) ?? row.name,
			status: parsed.errorCode === 2 ? "err" : "ok",
			start: Number(startNs - rootStartNs) / 1e9,
			dur: Number(endNs - startNs) / 1e9,
			cost,
			tok,
			io: buildStepIo(parsed.events),
			...(sourceType && sourceName ? { sourceType, sourceName } : {}),
		});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/runs.test.js`
Expected: PASS, all tests green (previous count + 2 new).

- [ ] **Step 5: Commit**

```bash
cd server
git add src/runs.ts test/runs.test.js
git commit -m "feat(server): reshape a step's optional skill/sub-agent/MCP-server attribution"
```

---

### Task 3: `server/src/coverage.ts` — the join

**Files:**
- Create: `server/src/coverage.ts`
- Test: `server/test/coverage.test.js`

**Interfaces:**
- Consumes: `getRun`/`StepView` from `./runs.js` (Task 2), `getHarnessView`/`HarnessView` from `./harness.js` (already exists).
- Produces: `CoverageEntry`, `CoverageView`, `getCoverage(db, traceId): CoverageView | null`, consumed by Task 4's route wiring.

- [ ] **Step 1: Write the failing tests**

Create `server/test/coverage.test.js`:
```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getCoverage } from "../dist/coverage.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-coverage-test-"));
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

const MANIFEST = JSON.stringify({
	schemaVersion: 2,
	skills: [{ name: "code-review", description: "reviews diffs", source: "project" }, { name: "deploy", description: "ships it", source: "project" }],
	subAgents: [{ name: "Explore", description: "search", tools: ["Grep"] }],
	mcpServers: [{ name: "context7" }],
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

describe("getCoverage", () => {
	test("returns null when the run doesn't exist", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.equal(getCoverage(db, "nonexistent"), null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("tracked=false and every entry unmatched when no step reports a source", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g", startNs: "1000000000000", endNs: "1010000000000", manifest: MANIFEST }));
			insertSpan(db, attributedStep({ traceId: "t1", spanId: "s1", parentSpanId: "r1", name: "plain step", startNs: "1001000000000", endNs: "1002000000000" }));
			const cov = getCoverage(db, "t1");
			assert.equal(cov.tracked, false);
			assert.equal(cov.entries.length, 4);
			assert.ok(cov.entries.every((e) => e.usedCount === 0));
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("tracked=true, counts matches per entry, and distinguishes used from genuinely unused", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t2", spanId: "r2", goal: "g", startNs: "1000000000000", endNs: "1010000000000", manifest: MANIFEST }));
			insertSpan(db, attributedStep({ traceId: "t2", spanId: "s1", parentSpanId: "r2", name: "review", startNs: "1001000000000", endNs: "1002000000000", sourceType: "skill", sourceName: "code-review" }));
			insertSpan(db, attributedStep({ traceId: "t2", spanId: "s2", parentSpanId: "r2", name: "review again", startNs: "1003000000000", endNs: "1004000000000", sourceType: "skill", sourceName: "code-review" }));
			insertSpan(db, attributedStep({ traceId: "t2", spanId: "s3", parentSpanId: "r2", name: "explore", startNs: "1005000000000", endNs: "1006000000000", sourceType: "sub_agent", sourceName: "Explore" }));
			const cov = getCoverage(db, "t2");
			assert.equal(cov.tracked, true);
			const codeReview = cov.entries.find((e) => e.type === "skill" && e.name === "code-review");
			const deploy = cov.entries.find((e) => e.type === "skill" && e.name === "deploy");
			const explore = cov.entries.find((e) => e.type === "sub_agent" && e.name === "Explore");
			const context7 = cov.entries.find((e) => e.type === "mcp_server" && e.name === "context7");
			assert.equal(codeReview.usedCount, 2);
			assert.equal(deploy.usedCount, 0);
			assert.equal(explore.usedCount, 1);
			assert.equal(context7.usedCount, 0);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("empty entries when the manifest itself is empty, regardless of tracked state", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t3", spanId: "r3", goal: "g", startNs: "1000000000000", endNs: "1010000000000" }));
			const cov = getCoverage(db, "t3");
			assert.deepEqual(cov.entries, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `server/src/coverage.ts` does not exist yet.

- [ ] **Step 3: Implement `server/src/coverage.ts`**

```ts
/**
 * Joins a run's steps (runs.ts) against its harness manifest (harness.ts) to
 * show which manifest entries were actually used. This join needs new
 * per-step attribution data (runs.ts's StepView.sourceType/sourceName) --
 * there is no free join available from existing data alone (see this
 * feature's design spec §1 for why).
 */

import type Database from "better-sqlite3";
import { getRun } from "./runs.js";
import { getHarnessView } from "./harness.js";

export interface CoverageEntry {
	type: "skill" | "sub_agent" | "mcp_server";
	name: string;
	usedCount: number;
}

export interface CoverageView {
	tracked: boolean;
	entries: CoverageEntry[];
}

/**
 * Reshapes a run's coverage: for each of its harness manifest entries, how
 * many steps reported using it. Returns null only when the run itself
 * doesn't exist (mirrors getRun/getHarnessView's own null contract) --
 * never throws otherwise.
 */
export function getCoverage(db: Database.Database, traceId: string): CoverageView | null {
	const run = getRun(db, traceId);
	const harness = getHarnessView(db, traceId);
	if (!run || !harness) return null;

	const tracked = run.steps.some((s) => s.sourceType !== undefined);

	const countFor = (type: CoverageEntry["type"], name: string): number =>
		run.steps.filter((s) => s.sourceType === type && s.sourceName === name).length;

	const entries: CoverageEntry[] = [
		...harness.skills.map((s) => ({ type: "skill" as const, name: s.name, usedCount: countFor("skill", s.name) })),
		...harness.subAgents.map((a) => ({ type: "sub_agent" as const, name: a.name, usedCount: countFor("sub_agent", a.name) })),
		...harness.mcpServers.map((m) => ({ type: "mcp_server" as const, name: m.name, usedCount: countFor("mcp_server", m.name) })),
	];

	return { tracked, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/coverage.test.js`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/coverage.ts test/coverage.test.js
git commit -m "feat(server): add the coverage reshape module (getCoverage)"
```

---

### Task 4: Render the Coverage panel and wire it into the route

**Files:**
- Modify: `server/src/templates/flight-recorder.ts`
- Modify: `server/src/server.ts`
- Modify: `server/test/server.test.js`

**Interfaces:**
- Consumes: `getCoverage` from `./coverage.js` (Task 3), `CoverageView` type.
- Produces: `renderFlightRecorderPage(run: RunView, coverage: CoverageView | null): string` (signature change).

- [ ] **Step 1: Write the failing tests**

Add to `server/test/server.test.js`, inside the existing `describe("GET /runs/:traceId", ...)` block:
```js
	test("shows the Coverage panel with an honest empty message when no manifest was captured", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			const text = await res.text();
			assert.match(text, /Coverage/);
			assert.match(text, /nothing to show coverage for/);
		});
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build 2>&1 | head -30`
Expected: FAIL — `renderFlightRecorderPage` doesn't accept a second argument yet, and `server.ts` doesn't call `getCoverage`, so nothing in the response mentions "Coverage".

- [ ] **Step 3: Modify `server/src/templates/flight-recorder.ts`**

Change the exported function signature and JSON injection. Find:
```ts
export function renderFlightRecorderPage(run: RunView): string {
	// Escape `<` so a field like `</script><img src=x onerror=...>` can't break out of the
	// inline <script> block, and escape the JS line-terminator characters (valid in JSON
	// strings, illegal inside a JS string literal in older engines). Use a function replacer
	// (not a string one) so a goal containing "$&" / "$'" etc. can't trigger String.replace's
	// special replacement-pattern handling and corrupt the surrounding template.
	const json = JSON.stringify(run)
		.replace(/</g, "\\u003c")
		.replace(/ /g, "\\u2028")
		.replace(/ /g, "\\u2029");
	return TEMPLATE.replace("__RUN_JSON__", () => json);
```
Change to:
```ts
export function renderFlightRecorderPage(run: RunView, coverage: CoverageView | null): string {
	// Escape `<` so a field like `</script><img src=x onerror=...>` can't break out of the
	// inline <script> block, and escape the JS line-terminator characters (valid in JSON
	// strings, illegal inside a JS string literal in older engines). Use a function replacer
	// (not a string one) so a goal containing "$&" / "$'" etc. can't trigger String.replace's
	// special replacement-pattern handling and corrupt the surrounding template.
	const json = JSON.stringify({ ...run, coverage })
		.replace(/</g, "\\u003c")
		.replace(/ /g, "\\u2028")
		.replace(/ /g, "\\u2029");
	return TEMPLATE.replace("__RUN_JSON__", () => json);
```
Add the import at the top of the file, alongside the existing `RunView` import:
```ts
import type { RunView } from "../runs.js";
import type { CoverageView } from "../coverage.js";
```

Add the new panel's markup. Find the existing `.split` section's closing tag and the footer link:
```html
    <div class="panel">
      <div class="panel-head"><h2 id="inspTitle">Verdict</h2></div>
      <div class="insp" id="insp"></div>
    </div>
  </section>

  <div class="foot"><a href="/">&larr; back to all runs</a></div>
```
Insert a new `<section>` between the closing `</section>` of `.split` and the `.foot` div:
```html
    <div class="panel">
      <div class="panel-head"><h2 id="inspTitle">Verdict</h2></div>
      <div class="insp" id="insp"></div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Coverage</h2></div>
    <div class="insp" id="coverage"></div>
  </section>

  <div class="foot"><a href="/">&larr; back to all runs</a></div>
```

Add two small CSS rules to the existing `<style>` block, near the other `.insp*` rules (e.g. right after the `.insp-empty { color: var(--ink-3); font-size: 13px; }` line):
```css
  .cov-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
  .cov-status { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; }
  .cov-status.cov-used { color: var(--met); }
```

Add the two new client-side JS functions. Insert them right after the existing `renderVerdict` function (which ends with a closing `}` before `function renderStepIO(s, i) {`):
```js
  function coverageList(entries, emptyMsg) {
    if (!entries.length) return '<div class="insp-empty">'+emptyMsg+'</div>';
    return entries.map(function(e) {
      const used = e.usedCount > 0;
      const status = used ? '✓ used ('+e.usedCount+' step'+(e.usedCount===1?'':'s')+')' : '— not used';
      return '<div class="cov-row"><span>'+escapeHtml(e.name)+'</span><span class="cov-status'+(used?' cov-used':'')+'">'+status+'</span></div>';
    }).join('');
  }

  function renderCoverage() {
    const cov = RUN.coverage;
    const el = $('coverage');
    if (!cov || !cov.entries.length) {
      el.innerHTML = '<div class="insp-empty">No skills, sub-agents, or MCP servers were registered for this run — nothing to show coverage for.</div>';
      return;
    }
    if (!cov.tracked) {
      el.innerHTML = '<div class="insp-empty">Coverage not tracked for this run — no step reported which skill, sub-agent, or MCP server it came from.</div>';
      return;
    }
    const skills = cov.entries.filter(function(e){ return e.type==='skill'; });
    const subAgents = cov.entries.filter(function(e){ return e.type==='sub_agent'; });
    const mcpServers = cov.entries.filter(function(e){ return e.type==='mcp_server'; });
    el.innerHTML =
      '<div class="insp-section"><h3>Skills</h3>'+coverageList(skills, 'No skills registered for this run.')+'</div>'
      + '<div class="insp-section"><h3>Sub-agents</h3>'+coverageList(subAgents, 'No sub-agents registered for this run.')+'</div>'
      + '<div class="insp-section"><h3>MCP servers</h3>'+coverageList(mcpServers, 'No MCP servers registered for this run.')+'</div>';
  }
```

Finally, add the new function to the page-load call list. Find:
```js
  renderMission(); renderStrip(); renderSteps(); renderInspector(); updatePlayhead(); initControls();
```
Change to:
```js
  renderMission(); renderStrip(); renderSteps(); renderInspector(); renderCoverage(); updatePlayhead(); initControls();
```

- [ ] **Step 4: Modify `server/src/server.ts`**

Add the import:
```ts
import { getCoverage } from "./coverage.js";
```
Find the `GET /runs/:traceId` handler's success path:
```ts
				const page = renderFlightRecorderPage(run);
```
Change to:
```ts
				const page = renderFlightRecorderPage(run, getCoverage(db, traceId));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm run build && npm test`
Expected: PASS, full suite green (previous count + 1 new).

- [ ] **Step 6: Commit**

```bash
cd server
git add src/templates/flight-recorder.ts src/server.ts test/server.test.js
git commit -m "feat(server): render the Coverage panel on the Flight Recorder page"
```

---

### Task 5: End-to-end verification and README update

**Files:**
- Modify: `server/README.md`

**Interfaces:**
- Consumes: the full pipeline from Tasks 1-4, plus the real `mcp/` package.
- Produces: no new code — verification evidence plus a README update.

- [ ] **Step 1: Manual end-to-end verification**

Write a throwaway script (do not commit it — delete it when done, matching the discipline of every prior plan's final task) that:
1. Rebuilds both packages fresh: `cd mcp && npm run build`, `cd server && npm run build`.
2. Starts the real built `server/dist/index.js` on a test port, `HOME` overridden to a fresh `mkdtemp` directory.
3. Creates a fake project directory (via `mkdtemp`) with a `.claude/skills/code-review/SKILL.md` (valid frontmatter) so the run's harness manifest has at least one real skill entry.
4. Spawns the real built `mcp/dist/index.js` as an MCP child process via `StdioClientTransport`/`Client`, `TRAIL_URL` pointed at the test server, `TRAIL_PROJECT_ROOT` pointed at the fake project directory.
5. Calls `trail_start_run`, then:
   - One `trail_log_step` call WITH both `source_type: "skill"` and `source_name: "code-review"` set.
   - One `trail_log_step` call with NEITHER set (a plain step).
   - One `trail_log_step` call with ONLY `source_type` set and no `source_name` (confirm via the real response that this does not crash and produces a normal "step logged" result — the both-or-neither rule means this step should behave exactly like the plain step, with no attribution recorded).
   Then `trail_finish_run`.
6. `curl`s `http://127.0.0.1:<port>/runs/<traceId>` and confirms in the raw HTML: the Coverage panel shows "Skills" with `code-review` marked "✓ used (1 step)" (not 2 — the third call's malformed attribution must not count), and confirms no `RangeError`/500 occurred for the malformed-attribution call.
7. Runs a second full run (`trail_start_run`/`trail_finish_run`, no steps logged in between, still pointed at the same fake project directory so it has the same manifest) and confirms its Coverage panel shows the "Coverage not tracked for this run" message, not a false "— not used" for `code-review`. A zero-step run has no step reporting any source, so `tracked` must be `false` — this is the case that must not be confused with "genuinely unused."
8. Stops the server, cleans up temp directories, deletes the throwaway script.

Paste the real terminal output (the relevant curl'd HTML excerpts) into your task report. If this reveals a real bug in Tasks 1-4 (not a problem with the throwaway script), report it clearly rather than working around it silently.

- [ ] **Step 2: Update `server/README.md`**

Find the bullet describing `GET /runs/:traceId` (added by the Flight Recorder plan). Add one sentence to it describing the new panel:
```
- `GET /runs/:traceId` — the Flight Recorder view for one run: goal, verdict
  (when a judge is configured), a scrubbable step timeline with play/pause/
  speed controls, per-step expansion showing raw input/output, and a
  Coverage panel showing which of the run's harness manifest entries
  (skills/sub-agents/MCP servers) were actually used, when the coding agent
  reports that attribution. Adapted from a design prototype, cut down to
  exactly what's captured today — no pinned criteria, sub-goals,
  guardrail/eval signals, diffs, or context-window inspector, since none of
  that data exists yet.
```

- [ ] **Step 3: Commit**

```bash
cd server
git add README.md
git commit -m "docs(server): describe the Coverage panel"
```
