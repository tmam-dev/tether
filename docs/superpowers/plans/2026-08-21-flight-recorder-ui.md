# Flight Recorder UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `server/`'s placeholder page with a real run list and a per-run Flight Recorder view — the first actual UI in Tether, showing goal, verdict, and a scrubbable step timeline entirely from data already captured.

**Architecture:** A new pure-function reshape module (`server/src/runs.ts`) converts stored OTLP-shaped spans into a plain `RunView`/`RunSummary` shape. Two new template functions (`server/src/templates/run-list.ts`, `server/src/templates/flight-recorder.ts`) render that shape to HTML — the Flight Recorder template is an adaptation of the existing dependency-free prototype from `trail`'s design branch, with every feature real data can't support removed (not hidden — removed). `server/src/server.ts` gains two routes (`GET /`, `GET /runs/:traceId`) that call the reshape module and the templates; the old placeholder route is replaced, not left alongside.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, `better-sqlite3` (already a dependency), no new dependencies, no framework, no build step for the HTML/CSS/JS templates (plain strings, matching the prototype's own zero-build ethos).

**Spec:** `docs/superpowers/specs/2026-08-21-flight-recorder-ui-design.md`. This plan resolves that spec's open items (§5) through a full read of the 843-line prototype (not just the sampled sections the spec was written against), which surfaced real cuts the spec didn't anticipate — recorded in Task 2's Context section, not silently applied.

## Global Constraints

- No new dependencies — everything here is pure TypeScript/DOM string-building against data already in SQLite.
- Indentation is tabs, not spaces, in `server/src/` — matches the existing convention.
- Tests import from `../dist/*.js` (compiled output), matching `db.test.js`/`server.test.js`'s existing convention.
- Every reshape/query function degrades gracefully (returns `null`/`[]`, never throws) — matches the "never crash" discipline already established for `POST /traces` and `GET /` in `server/src/server.ts`.
- The adapted Flight Recorder template must not reintroduce any of the cut features (pinned criteria, sub-goal decomposition + implicated-step spotlight, guardrail/eval signals, diffs, context-window inspector, verdict override, the Steps↔Spans granularity toggle, the multi-run picker) — see Task 2's Context section for why each one doesn't fit real data.
- HTML output must escape user-controlled text (goal, agent name, step titles, raw I/O, judge narrative) to prevent XSS — every one of these fields originates from an MCP client's own tool-call arguments, which Tether treats as untrusted input, same as any other external caller.

---

### Task 1: Backend reshape module (`server/src/runs.ts`)

**Files:**
- Create: `server/src/runs.ts`
- Create: `server/test/runs.test.js`

**Interfaces:**
- Consumes: `Database.Database` from `better-sqlite3` (already used by `server/src/db.ts`, same type-import pattern: `import type Database from "better-sqlite3"`).
- Produces: `StepType` (`"reason"|"read"|"edit"|"run"|"tool"|"llm"|"search"`), `RetrySignal` (`{kind:"retry"; count:number; detail:string}`), `StepView` (`{type:StepType; title:string; status:"ok"|"err"; start:number; dur:number; cost:number|null; tok:number|null; io:[string,string][]; sig?:RetrySignal[]}`), `RunView` (`{traceId:string; goal:string; agent:string; verdict:"met"|"partial"|"failed"|"unjudged"; score:number|null; narrative:string|null; totals:{dur:string; cost:number|null; tokens:number|null; steps:number}; steps:StepView[]}`), `RunSummary` (`{traceId:string; goal:string; verdict:"met"|"partial"|"failed"|"unjudged"; dur:string; startedAt:string}`). Functions: `getRun(db, traceId): RunView | null`, `listRuns(db, limit): RunSummary[]`. All exported from `server/src/runs.ts`. Task 3 imports `getRun`, `listRuns`, `RunView`, `RunSummary` from `./runs.js`; Task 2 imports `RunView` from `./runs.js`.

**Context:** Verified directly against `mcp/src/index.ts` and a real stored span (not assumed): every run is one root span (`parentSpanId IS NULL`, emitted by `trail_finish_run`) plus flat child spans (`parentSpanId` = the root's id, no nesting). Root span attributes: `gen_ai.agent.goal`, `gen_ai.agent.name`, optionally `gen_ai.agent.verdict`/`verdict_score`/`verdict_narrative` (absent entirely when no judge ran — this is the `"unjudged"` case). Child spans from `trail_log_step`: `gen_ai.operation.name` (`execute_tool`|`execute_task`), `gen_ai.tool.name` (only for `tool`-kind steps — free text like `"run pytest"`, no structured category), events named `gen_ai.content.prompt`/`gen_ai.content.completion` carrying `gen_ai.prompt`/`gen_ai.completion` text. Child spans from `trail_log_llm_call`: `gen_ai.operation.name = "chat"`, `gen_ai.usage.cost`/`total_tokens` (present ONLY on these — a plain `trail_log_step` never carries cost/tokens, since that tool's schema has no such fields). An error span (`status.code === 2`) carries an `exception` event with an `exception.message` attribute. Stored `raw` is the full OTLP-shaped span JSON — `attributes` as `[{key, value:{stringValue|intValue|doubleValue|boolValue}}]`, not a plain object.

- [ ] **Step 1: Write the failing tests**

Create `server/test/runs.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getRun, listRuns } from "../dist/runs.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-runs-test-"));
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

function rootSpan({ traceId, spanId, goal, agent, startNs, endNs, verdict, score, narrative }) {
	const attrs = { "gen_ai.agent.goal": goal, "gen_ai.agent.name": agent };
	if (verdict) {
		attrs["gen_ai.agent.verdict"] = verdict;
		attrs["gen_ai.agent.verdict_score"] = score;
		attrs["gen_ai.agent.verdict_narrative"] = narrative;
	}
	const raw = { traceId, spanId, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events: [], status: { code: 1 } };
	return { traceId, spanId, parentSpanId: null, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

function stepSpan({ traceId, spanId, parentSpanId, name, startNs, endNs, toolName, isError, prompt, completion, cost, tokens }) {
	const attrs = { "gen_ai.operation.name": toolName ? "execute_tool" : "execute_task" };
	if (toolName) attrs["gen_ai.tool.name"] = toolName;
	if (cost !== undefined) attrs["gen_ai.usage.cost"] = cost;
	if (tokens !== undefined) attrs["gen_ai.usage.total_tokens"] = tokens;
	const events = [];
	if (prompt) events.push({ name: "gen_ai.content.prompt", timeUnixNano: endNs, attributes: otlpAttrs({ "gen_ai.prompt": prompt }) });
	if (completion) events.push({ name: "gen_ai.content.completion", timeUnixNano: endNs, attributes: otlpAttrs({ "gen_ai.completion": completion }) });
	if (isError) events.push({ name: "exception", timeUnixNano: endNs, attributes: otlpAttrs({ "exception.type": "Error", "exception.message": "step failed" }) });
	const raw = { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events, status: { code: isError ? 2 : 1 } };
	return { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

function llmCallSpan({ traceId, spanId, parentSpanId, model, startNs, endNs, cost, tokens }) {
	const attrs = { "gen_ai.operation.name": "chat", "gen_ai.request.model": model, "gen_ai.usage.cost": cost, "gen_ai.usage.total_tokens": tokens };
	const raw = { traceId, spanId, parentSpanId, name: `chat ${model}`, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events: [], status: { code: 1 } };
	return { traceId, spanId, parentSpanId, name: `chat ${model}`, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

describe("getRun", () => {
	test("returns null when no root span exists for the traceId", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.equal(getRun(db, "nonexistent"), null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("reshapes a root-only run (no steps) with an unjudged verdict", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "do the thing", agent: "coding-agent", startNs: "1000000000000", endNs: "1001000000000" }));
			const run = getRun(db, "t1");
			assert.equal(run.goal, "do the thing");
			assert.equal(run.agent, "coding-agent");
			assert.equal(run.verdict, "unjudged");
			assert.equal(run.score, null);
			assert.equal(run.narrative, null);
			assert.equal(run.totals.steps, 0);
			assert.deepEqual(run.steps, []);
			assert.equal(run.totals.dur, "1s");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("reshapes goal/verdict/score/narrative from the root span when a judge ran", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t2", spanId: "r2", goal: "ship the feature", agent: "coding-agent", startNs: "1000000000000", endNs: "1500000000000", verdict: "met", score: 0.9, narrative: "Fully shipped." }));
			const run = getRun(db, "t2");
			assert.equal(run.verdict, "met");
			assert.equal(run.score, 0.9);
			assert.equal(run.narrative, "Fully shipped.");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("orders steps by start time and computes relative start/duration in seconds", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t3", spanId: "r3", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1030000000000" }));
			insertSpan(db, stepSpan({ traceId: "t3", spanId: "s2", parentSpanId: "r3", name: "second step", startNs: "1015000000000", endNs: "1020000000000", toolName: "run pytest" }));
			insertSpan(db, stepSpan({ traceId: "t3", spanId: "s1", parentSpanId: "r3", name: "first step", startNs: "1005000000000", endNs: "1010000000000", toolName: "read file.py" }));
			const run = getRun(db, "t3");
			assert.equal(run.steps.length, 2);
			assert.equal(run.steps[0].title, "read file.py");
			assert.equal(run.steps[0].start, 5);
			assert.equal(run.steps[0].dur, 5);
			assert.equal(run.steps[1].title, "run pytest");
			assert.equal(run.steps[1].start, 15);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("infers step type: chat -> llm, tool-name keyword match, task-with-no-tool-name -> reason", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t4", spanId: "r4", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, stepSpan({ traceId: "t4", spanId: "s1", parentSpanId: "r4", name: "planned it", startNs: "1010000000000", endNs: "1011000000000" }));
			insertSpan(db, stepSpan({ traceId: "t4", spanId: "s2", parentSpanId: "r4", name: "read auth.py", startNs: "1012000000000", endNs: "1013000000000", toolName: "read auth.py" }));
			insertSpan(db, stepSpan({ traceId: "t4", spanId: "s3", parentSpanId: "r4", name: "edit auth.py", startNs: "1014000000000", endNs: "1015000000000", toolName: "str_replace auth.py" }));
			insertSpan(db, stepSpan({ traceId: "t4", spanId: "s4", parentSpanId: "r4", name: "run pytest", startNs: "1016000000000", endNs: "1017000000000", toolName: "run pytest" }));
			insertSpan(db, stepSpan({ traceId: "t4", spanId: "s5", parentSpanId: "r4", name: "grep TODO", startNs: "1018000000000", endNs: "1019000000000", toolName: "grep TODO" }));
			insertSpan(db, stepSpan({ traceId: "t4", spanId: "s6", parentSpanId: "r4", name: "curl the api", startNs: "1020000000000", endNs: "1021000000000", toolName: "curl the api" }));
			insertSpan(db, llmCallSpan({ traceId: "t4", spanId: "s7", parentSpanId: "r4", model: "gpt-4o-mini", startNs: "1022000000000", endNs: "1023000000000", cost: 0.01, tokens: 500 }));
			const run = getRun(db, "t4");
			const byTitle = Object.fromEntries(run.steps.map((s) => [s.title, s.type]));
			assert.equal(byTitle["planned it"], "reason");
			assert.equal(byTitle["read auth.py"], "read");
			assert.equal(byTitle["str_replace auth.py"], "edit");
			assert.equal(byTitle["run pytest"], "run");
			assert.equal(byTitle["grep TODO"], "search");
			assert.equal(byTitle["curl the api"], "tool");
			assert.equal(byTitle["chat gpt-4o-mini"], "llm");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("only llm-call steps carry cost/tokens; plain steps have null", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t5", spanId: "r5", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, stepSpan({ traceId: "t5", spanId: "s1", parentSpanId: "r5", name: "run tests", startNs: "1010000000000", endNs: "1011000000000", toolName: "run tests" }));
			insertSpan(db, llmCallSpan({ traceId: "t5", spanId: "s2", parentSpanId: "r5", model: "gpt-4o-mini", startNs: "1012000000000", endNs: "1013000000000", cost: 0.02, tokens: 800 }));
			const run = getRun(db, "t5");
			const step = run.steps.find((s) => s.title === "run tests");
			const llm = run.steps.find((s) => s.type === "llm");
			assert.equal(step.cost, null);
			assert.equal(step.tok, null);
			assert.equal(llm.cost, 0.02);
			assert.equal(llm.tok, 800);
			assert.equal(run.totals.cost, 0.02);
			assert.equal(run.totals.tokens, 800);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("extracts prompt/completion events as io pairs, and an error message for a failed step", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t6", spanId: "r6", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, stepSpan({ traceId: "t6", spanId: "s1", parentSpanId: "r6", name: "run pytest", startNs: "1010000000000", endNs: "1011000000000", toolName: "run pytest", isError: true, prompt: "pytest -x", completion: "1 failed" }));
			const run = getRun(db, "t6");
			const step = run.steps[0];
			assert.equal(step.status, "err");
			assert.deepEqual(step.io, [["Input", "pytest -x"], ["Output", "1 failed"], ["Error", "step failed"]]);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("flags a retry signal starting at the 2nd occurrence of 3+ consecutive same-title errors", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t7", spanId: "r7", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			for (let i = 0; i < 4; i++) {
				const ns = String(1010000000000 + i * 2000000000);
				insertSpan(db, stepSpan({ traceId: "t7", spanId: "s" + i, parentSpanId: "r7", name: "run tests", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "run tests", isError: true }));
			}
			const run = getRun(db, "t7");
			assert.equal(run.steps[0].sig, undefined);
			assert.deepEqual(run.steps[1].sig, [{ kind: "retry", count: 2, detail: run.steps[1].sig[0].detail }]);
			assert.equal(run.steps[2].sig[0].count, 3);
			assert.equal(run.steps[3].sig[0].count, 4);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("does not flag a retry signal for only 2 consecutive same-title errors (below the 3-run threshold)", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t8", spanId: "r8", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, stepSpan({ traceId: "t8", spanId: "s0", parentSpanId: "r8", name: "run tests", startNs: "1010000000000", endNs: "1011000000000", toolName: "run tests", isError: true }));
			insertSpan(db, stepSpan({ traceId: "t8", spanId: "s1", parentSpanId: "r8", name: "run tests", startNs: "1012000000000", endNs: "1013000000000", toolName: "run tests", isError: true }));
			const run = getRun(db, "t8");
			assert.equal(run.steps[0].sig, undefined);
			assert.equal(run.steps[1].sig, undefined);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});

describe("listRuns", () => {
	test("returns an empty array when there are no runs", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.deepEqual(listRuns(db, 10), []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("returns root-span-only summaries, most recent first, capped at limit", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "older", spanId: "r1", goal: "first run", agent: "a", startNs: "1000000000000", endNs: "1010000000000" }));
			insertSpan(db, stepSpan({ traceId: "older", spanId: "s1", parentSpanId: "r1", name: "a step", startNs: "1005000000000", endNs: "1006000000000", toolName: "x" }));
			insertSpan(db, rootSpan({ traceId: "newer", spanId: "r2", goal: "second run", agent: "a", startNs: "2000000000000", endNs: "2010000000000", verdict: "met", score: 1, narrative: "done" }));
			const runs = listRuns(db, 10);
			assert.equal(runs.length, 2);
			assert.equal(runs[0].traceId, "newer");
			assert.equal(runs[0].goal, "second run");
			assert.equal(runs[0].verdict, "met");
			assert.equal(runs[1].traceId, "older");
			assert.equal(runs[1].verdict, "unjudged");
			const capped = listRuns(db, 1);
			assert.equal(capped.length, 1);
			assert.equal(capped[0].traceId, "newer");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/runs.test.js`
Expected: FAIL — `../dist/runs.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `server/src/runs.ts`:

```ts
/**
 * Reshapes stored OTLP-shaped spans into plain view objects a template can
 * read directly. Every function here degrades gracefully (null/[] on
 * anything unexpected) -- never throws, matching the rest of this codebase's
 * discovery/query functions.
 */

import type Database from "better-sqlite3";

export type StepType = "reason" | "read" | "edit" | "run" | "tool" | "llm" | "search";

export interface RetrySignal {
	kind: "retry";
	count: number;
	detail: string;
}

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
}

export type Verdict = "met" | "partial" | "failed" | "unjudged";

export interface RunView {
	traceId: string;
	goal: string;
	agent: string;
	verdict: Verdict;
	score: number | null;
	narrative: string | null;
	totals: { dur: string; cost: number | null; tokens: number | null; steps: number };
	steps: StepView[];
}

export interface RunSummary {
	traceId: string;
	goal: string;
	verdict: Verdict;
	dur: string;
	startedAt: string;
}

interface StoredRow {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	raw: string;
}

type AttrMap = Record<string, string | number | boolean>;

function toAttributeMap(attributes: { key: string; value: Record<string, unknown> }[] | undefined): AttrMap {
	const map: AttrMap = {};
	for (const attr of attributes ?? []) {
		const v = attr.value ?? {};
		if ("stringValue" in v) map[attr.key] = v.stringValue as string;
		else if ("intValue" in v) map[attr.key] = Number(v.intValue);
		else if ("doubleValue" in v) map[attr.key] = v.doubleValue as number;
		else if ("boolValue" in v) map[attr.key] = v.boolValue as boolean;
	}
	return map;
}

function inferStepType(attrs: AttrMap): StepType {
	if (attrs["gen_ai.operation.name"] === "chat") return "llm";
	const toolName = attrs["gen_ai.tool.name"];
	if (typeof toolName === "string") {
		const t = toolName.toLowerCase();
		if (/read|cat|view|open/.test(t)) return "read";
		if (/edit|write|str_replace|patch/.test(t)) return "edit";
		if (/run|exec|bash|test|build/.test(t)) return "run";
		if (/search|grep|find/.test(t)) return "search";
		return "tool";
	}
	return "reason";
}

function formatDuration(startNs: string, endNs: string): string {
	const seconds = Math.max(0, Math.round((Number(BigInt(endNs) - BigInt(startNs))) / 1e9));
	if (seconds < 60) return seconds + "s";
	return Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
}

function parseRaw(raw: string): { attrs: AttrMap; events: { name: string; attributes: AttrMap }[]; errorCode: number } | null {
	try {
		const parsed = JSON.parse(raw) as {
			attributes?: { key: string; value: Record<string, unknown> }[];
			events?: { name: string; attributes?: { key: string; value: Record<string, unknown> }[] }[];
			status?: { code?: number };
		};
		return {
			attrs: toAttributeMap(parsed.attributes),
			events: (parsed.events ?? []).map((e) => ({ name: e.name, attributes: toAttributeMap(e.attributes) })),
			errorCode: parsed.status?.code ?? 1,
		};
	} catch {
		return null;
	}
}

function buildStepIo(events: { name: string; attributes: AttrMap }[]): [string, string][] {
	const io: [string, string][] = [];
	for (const e of events) {
		if (e.name === "gen_ai.content.prompt" && typeof e.attributes["gen_ai.prompt"] === "string") {
			io.push(["Input", e.attributes["gen_ai.prompt"] as string]);
		} else if (e.name === "gen_ai.content.completion" && typeof e.attributes["gen_ai.completion"] === "string") {
			io.push(["Output", e.attributes["gen_ai.completion"] as string]);
		} else if (e.name === "exception" && typeof e.attributes["exception.message"] === "string") {
			io.push(["Error", e.attributes["exception.message"] as string]);
		}
	}
	return io;
}

const MIN_RETRY_RUN = 3;

function detectRetries(steps: StepView[]): void {
	let i = 0;
	while (i < steps.length) {
		let j = i;
		while (j < steps.length && steps[j].status === "err" && steps[j].title === steps[i].title) j++;
		const runLength = j - i;
		if (runLength >= MIN_RETRY_RUN) {
			for (let k = i + 1; k < j; k++) {
				const count = k - i + 1;
				steps[k].sig = [{ kind: "retry", count, detail: `Attempt ${count} of "${steps[i].title}" — same failure as before.` }];
			}
		}
		i = j > i ? j : i + 1;
	}
}

/** Reshapes one trace's stored spans into a RunView. Returns null if no root span (parentSpanId IS NULL) is found for traceId. */
export function getRun(db: Database.Database, traceId: string): RunView | null {
	const rows = db
		.prepare("SELECT traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, raw FROM spans WHERE traceId = ? ORDER BY startTimeUnixNano ASC")
		.all(traceId) as StoredRow[];

	const rootRow = rows.find((r) => r.parentSpanId === null);
	if (!rootRow) return null;
	const root = parseRaw(rootRow.raw);
	if (!root) return null;

	const verdict = (root.attrs["gen_ai.agent.verdict"] as Verdict | undefined) ?? "unjudged";
	const score = typeof root.attrs["gen_ai.agent.verdict_score"] === "number" ? (root.attrs["gen_ai.agent.verdict_score"] as number) : null;
	const narrative = typeof root.attrs["gen_ai.agent.verdict_narrative"] === "string" ? (root.attrs["gen_ai.agent.verdict_narrative"] as string) : null;

	const stepRows = rows.filter((r) => r.spanId !== rootRow.spanId);
	const rootStartNs = BigInt(rootRow.startTimeUnixNano);

	const steps: StepView[] = [];
	let totalCost: number | null = null;
	let totalTokens: number | null = null;

	for (const row of stepRows) {
		const parsed = parseRaw(row.raw);
		if (!parsed) continue;
		const cost = typeof parsed.attrs["gen_ai.usage.cost"] === "number" ? (parsed.attrs["gen_ai.usage.cost"] as number) : null;
		const tok = typeof parsed.attrs["gen_ai.usage.total_tokens"] === "number" ? (parsed.attrs["gen_ai.usage.total_tokens"] as number) : null;
		if (cost !== null) totalCost = (totalCost ?? 0) + cost;
		if (tok !== null) totalTokens = (totalTokens ?? 0) + tok;

		steps.push({
			type: inferStepType(parsed.attrs),
			title: (parsed.attrs["gen_ai.tool.name"] as string | undefined) ?? row.name,
			status: parsed.errorCode === 2 ? "err" : "ok",
			start: Number(BigInt(row.startTimeUnixNano) - rootStartNs) / 1e9,
			dur: Number(BigInt(row.endTimeUnixNano) - BigInt(row.startTimeUnixNano)) / 1e9,
			cost,
			tok,
			io: buildStepIo(parsed.events),
		});
	}

	detectRetries(steps);

	return {
		traceId,
		goal: (root.attrs["gen_ai.agent.goal"] as string | undefined) ?? rootRow.name,
		agent: (root.attrs["gen_ai.agent.name"] as string | undefined) ?? "unknown",
		verdict,
		score,
		narrative,
		totals: { dur: formatDuration(rootRow.startTimeUnixNano, rootRow.endTimeUnixNano), cost: totalCost, tokens: totalTokens, steps: steps.length },
		steps,
	};
}

/** Root-span-only summaries, most recent first, capped at limit. Never throws. */
export function listRuns(db: Database.Database, limit: number): RunSummary[] {
	const rows = db
		.prepare("SELECT traceId, name, startTimeUnixNano, endTimeUnixNano, raw FROM spans WHERE parentSpanId IS NULL ORDER BY startTimeUnixNano DESC LIMIT ?")
		.all(limit) as StoredRow[];

	const summaries: RunSummary[] = [];
	for (const row of rows) {
		const parsed = parseRaw(row.raw);
		if (!parsed) continue;
		summaries.push({
			traceId: row.traceId,
			goal: (parsed.attrs["gen_ai.agent.goal"] as string | undefined) ?? row.name,
			verdict: (parsed.attrs["gen_ai.agent.verdict"] as Verdict | undefined) ?? "unjudged",
			dur: formatDuration(row.startTimeUnixNano, row.endTimeUnixNano),
			startedAt: new Date(Number(BigInt(row.startTimeUnixNano) / 1_000_000n)).toISOString(),
		});
	}
	return summaries;
}
```

- [ ] **Step 4: Build**

Run: `cd server && npm run build`
Expected: exits 0.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --test test/runs.test.js`
Expected: all tests pass.

- [ ] **Step 6: Run the full server test suite to confirm no regressions**

Run: `cd server && npm test`
Expected: all tests pass (`db.test.js`, `server.test.js` unaffected, plus the new `runs.test.js`).

- [ ] **Step 7: Commit**

```bash
git add server/src/runs.ts server/test/runs.test.js
git commit -m "feat(server): add the run reshape module (getRun/listRuns)"
```

---

### Task 2: Flight Recorder page template (`server/src/templates/flight-recorder.ts`)

**Files:**
- Create: `server/src/templates/flight-recorder.ts`

**Interfaces:**
- Consumes: `RunView` from Task 1's `../runs.js`.
- Produces: `renderFlightRecorderPage(run: RunView): string`, exported. Task 3 imports this and calls it with a `getRun(db, traceId)` result.

**Context:** This is an adaptation of `flight-recorder.html`, the self-contained prototype from `trail`'s `design/agent-observability-prototypes` branch (843 lines, read in full — not just sampled — specifically to catch hidden interdependencies before writing this task). Per `docs/superpowers/specs/2026-08-21-flight-recorder-ui-design.md` §3.3, the cut list is: pinned criteria, sub-goal decomposition, guardrail/eval signals (keep retry only), diffs, context-window inspector, verdict override. The full read surfaced additional cuts the spec didn't anticipate, each with a real interdependency reason:

1. **Sub-goals, "implicated steps," and the spotlight feature are one cluster, not separable.** The prototype's `renderMission()` renders sub-goals with `data-ref` links into specific step indices; `r.implicated` (step indices) drives both the "Spotlight the miss" button and `.step.implicated` styling in `renderSteps()`; `toggleSpotlight()` ties both together. Since Tether's judge produces no sub-goal breakdown at all (`Verdict = {verdict, score, narrative}`, verified against `mcp/src/judge.ts`), this entire cluster is removed together.
2. **Guardrail/eval/retry signals share the same three rendering functions** (`renderSignals()`, `sBadges()`, `renderStepIO()`'s signal block) — they aren't separable by deleting whole functions. Only the `retry` branch survives in each; `guardrail`/`eval` branches, `evalColor()`, `SVG_SHIELD`, and their CSS (`.sbadge.guard`, `.sbadge.eval`, `.io-sig.guard`) are removed.
3. **The context-window inspector also feeds the live playback stats bar** (a "Context" readout in `updatePlayhead()`, computed via `computeCtx()`) — not just the per-step panel. Both the per-step call site and the stats-bar readout are removed together; `computeCtx()`/`ctxHtml()` are deleted entirely.
4. **The "Steps ↔ Spans" granularity toggle (`spansFor()`) shows fabricated sub-span data** — the prototype invents synthetic `execute_tool`/`chat` sub-spans under each step with made-up duration fractions (e.g. `dur*0.35`). Tether's real model has no such collapsing: one `trail_log_step`/`trail_log_llm_call` call is already exactly one real span, so there is nothing to "expand" into. This whole toggle, `spansFor()`, `renderSpans()`, and the `.gran`/`.span-row`/`.span-group-h` CSS are removed — a cut the spec's sampled-sections research didn't catch.
5. **The multi-run picker (`RUNS` keyed object, `ORDER`, `renderPicker()`, `selectRun()`) assumes every run is preloaded into one page.** Per the design spec §3.1, Tether serves one run per request instead — the picker is removed, not adapted; a single `RUN` object (singular, not `RUNS[cur]`) replaces it, and a "&larr; All runs" link replaces the picker's role of getting to a different run.
6. **`confidence` and `judgeModel` are fields the prototype invents that don't exist in real data at all**, distinct from `score`/`partial` (which IS real, from `verdict_score`). `mcp/src/judge.ts`'s `Verdict` interface has no confidence field, and no judge-model identifier is ever attached to a span. The "Judge confidence" row and the "provenance" dropdown (`How was this judged?` — method/model/confidence/pinned-wins, all either fabricated or referencing cut features) are removed; only the score ring and judge narrative survive.
7. **`framework` is invented per-run data with no real analog**; the top-level per-run `model` field is also wrong to show at the run level (a model belongs to an individual LLM-call step, not the run as a whole — a run can involve multiple models). The goal eyebrow line simplifies to `Goal · @agent-name`, dropping both.
8. **An "unjudged" state is a real, expected case, not an edge case to paper over** — a run with no `TRAIL_JUDGE_PROVIDER`/`TRAIL_JUDGE_API_KEY` configured has no verdict/score/narrative at all. `VERDICT` gains a fourth entry (`unjudged`, neutral gray), `renderMission()` skips the score ring when unjudged, and `renderVerdict()` shows a one-line explanation instead of a judge narrative.

What ships, matching what's genuinely captured (spec §2.1, §3.3): goal, agent name, verdict badge + score ring (when judged) + narrative, total duration/cost/tokens, a scrubbable step timeline (play/pause/1x/2x/4x speed, draggable/clickable/keyboard-seekable scrubber), per-step type icon (heuristic taxonomy from Task 1), per-step expansion showing raw input/output/error text, retry-loop badges and signal markers, and cost/token figures only on the `llm`-type steps that actually have them (other step types show no cost/token figure — never a fabricated `$0.00`).

The template below has already been built and verified (no leftover references to any cut feature — checked by grep; valid JS syntax — checked with `node --check`; balanced HTML tags; no backticks/`${}`/backslashes in its content, so it embeds safely as a JS template literal with no escaping needed).

- [ ] **Step 1: Create `server/src/templates/flight-recorder.ts`**

```ts
import type { RunView } from "../runs.js";

/**
 * Adapted from trail's design/agent-observability-prototypes:flight-recorder.html
 * (843 lines, read in full). Every feature real Tether data can't support has
 * been removed, not hidden -- see this file's originating plan task for the
 * complete list and the interdependency reasons behind each cut.
 */
const TEMPLATE = `<title>Tether — Flight Recorder</title>
<style>
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
  .wrap { max-width: 1280px; margin: 0 auto; padding: 20px clamp(14px, 3vw, 28px) 64px; }

  .topbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
  .brand-mark { width: 26px; height: 26px; }
  .brand-name { font-weight: 640; letter-spacing: -0.01em; font-size: 15px; }
  .brand-sub { font-family: var(--mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
  .backlink { font-size: 12.5px; color: var(--ink-2); text-decoration: none; display: flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
  .backlink:hover { color: var(--ink); border-color: var(--line-strong); }
  .iconbtn { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; display: grid; place-items: center; transition: background .15s, color .15s; }
  .iconbtn:hover { color: var(--ink); background: var(--panel-2); }

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

  /* signals lane (retry only) */
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

  /* step signal badges (retry only) */
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
  .pin-note { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--accent-ink); margin-bottom: 10px; }
  .pin-note button { font: inherit; color: var(--ink-3); background: transparent; border: 0; cursor: pointer; text-decoration: underline; margin-left: auto; }

  .foot { margin-top: 22px; text-align: center; font-family: var(--mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.03em; }
  .foot a { color: var(--accent-ink); text-decoration: none; }
  .foot a:hover { text-decoration: underline; }

  @media (max-width: 880px) {
    .mission { grid-template-columns: 1fr; }
    .verdict { min-width: 0; }
    .split { grid-template-columns: 1fr; }
    .steps { max-height: none; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } .play-btn { display: none; } }
</style>

<div class="wrap">
  <div class="topbar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="15" stroke="var(--accent)" stroke-width="1.5" opacity="0.35"/>
        <path d="M6 22 C11 22 11 10 16 10 C21 10 21 20 26 20" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="6" cy="22" r="2.6" fill="var(--accent)"/><circle cx="26" cy="20" r="2.6" fill="var(--accent)"/>
      </svg>
      <div><div class="brand-name">Tether</div><div class="brand-sub">Flight Recorder</div></div>
    </div>
    <a class="backlink" href="/">&larr; All runs</a>
    <button class="iconbtn" id="themeBtn" title="Toggle theme" aria-label="Toggle light/dark theme">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
    </button>
  </div>

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

  <div class="foot"><a href="/">&larr; back to all runs</a></div>
</div>

<script>
(function () {
  "use strict";

  const I = {
    reason: '<path d="M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3Z"/><path d="M9.5 19h5M10 21.5h4"/>',
    read:   '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
    edit:   '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16Z"/><path d="M13.5 6.5l4 4"/>',
    run:    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
    tool:   '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.2l-5 5a1.6 1.6 0 0 0 2.3 2.3l5-5a3.5 3.5 0 0 0 4.2-4.8l-2.1 2.1-1.9-.2-.2-1.9Z"/>',
    llm:    '<circle cx="12" cy="12" r="2.2"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.5 1.5M16.2 16.2l1.5 1.5M17.7 6.3l-1.5 1.5M7.8 16.2l-1.5 1.5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>',
    done:   '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-4.9"/>'
  };
  const SVG_LOOP = '<path d="M4 9a7 7 0 0 1 12-4l2 2M20 15a7 7 0 0 1-12 4l-2-2"/><path d="M18 3v4h-4M6 21v-4h4"/>';
  function icon(t) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (I[t] || I.tool) + '</svg>'; }
  function svg(p, sw) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(sw||1.7)+'" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>'; }

  const TYPE_COLOR = {
    reason: ['#8A85F2', 'rgba(138,133,242,0.14)'], read: ['#5C93C4', 'rgba(92,147,196,0.14)'],
    edit: ['#19b0c0', 'rgba(25,176,192,0.15)'], run: ['#C98A5E', 'rgba(201,138,94,0.15)'],
    tool: ['#C77DBB', 'rgba(199,125,187,0.14)'], llm: ['#5FA8D3', 'rgba(95,168,211,0.14)'],
    search: ['#6FA96B', 'rgba(111,169,107,0.14)'], done: ['#2FA24A', 'rgba(47,162,74,0.15)']
  };
  const VERDICT = {
    met:      { label:'Goal met',    color:'var(--met)',     wash:'var(--met-wash)',     line:'rgba(47,162,74,0.35)',  glyph:'<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.2"/>' },
    partial:  { label:'Partial',     color:'var(--partial)', wash:'var(--partial-wash)', line:'rgba(192,136,16,0.35)', glyph:'<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 15.7v.1"/>' },
    failed:   { label:'Goal missed', color:'var(--failed)',  wash:'var(--failed-wash)',  line:'rgba(220,74,56,0.35)',  glyph:'<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>' },
    unjudged: { label:'Not judged',  color:'var(--ink-3)',   wash:'var(--panel-2)',      line:'var(--line)',           glyph:'<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' }
  };

  // ---------- The run (injected by the server for this request) ----------
  const RUN = __RUN_JSON__;

  // ---------- State ----------
  let playT=0, playing=false, speed=1, raf=null, lastTs=null, pinnedStep=null;

  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function runDur(r){ return r.steps.reduce((m,s)=>Math.max(m,s.start+s.dur),0); }
  function fmtT(s){ s=Math.max(0,Math.round(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
  function fmtCost(c){ return c==null ? '' : '$'+c.toFixed(c<1?3:2); }
  function fmtTok(t){ return t==null ? '' : (t>=1000 ? (t/1000).toFixed(1).replace(/\.0$/,'')+'k' : String(t)); }
  function escapeHtml(s){ return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  function ring(pct, color) {
    const r=18, C=2*Math.PI*r, on=pct/100*C;
    return '<svg width="46" height="46" viewBox="0 0 46 46">'
      + '<circle cx="23" cy="23" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="5"/>'
      + '<circle cx="23" cy="23" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="5" stroke-linecap="round" stroke-dasharray="'+on.toFixed(1)+' '+C.toFixed(1)+'"/>'
      + '<text class="pc-num" x="23" y="23" text-anchor="middle" dominant-baseline="central" transform="rotate(90 23 23)">'+pct+'</text></svg>';
  }

  function renderMission() {
    const r = RUN, v = VERDICT[r.verdict];
    const m = $('mission');
    m.style.setProperty('--vc', v.color); m.style.setProperty('--vc-wash', v.wash); m.style.setProperty('--vc-line', v.line);
    m.innerHTML =
      '<div>'
        + '<div class="goal-eyebrow"><span>Goal</span> · <span class="agent-pill">@'+escapeHtml(r.agent)+'</span></div>'
        + '<h1 class="goal-title">'+escapeHtml(r.goal)+'</h1>'
        + '<div class="goal-meta">'+gm('Duration',r.totals.dur)+gm('Total cost',fmtCost(r.totals.cost)||'—')+gm('Steps',String(r.totals.steps))+gm('Tokens',fmtTok(r.totals.tokens)||'—')+'</div>'
      + '</div>'
      + '<div class="verdict">'
        + '<div class="verdict-badge"><svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+v.glyph+'</svg>'
          + '<div class="vt"><span class="lab">Verdict</span><span class="val">'+v.label+'</span></div></div>'
        + (r.verdict!=='unjudged' ? '<div class="pcredit">'+ring(Math.round(r.score*100), v.color)
            + '<div class="pc-side"><div class="conf-row"><span>Goal completion</span><span>'+Math.round(r.score*100)+'%</span></div></div></div>' : '')
      + '</div>';
  }
  function gm(k,v){ return '<div class="gm"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>'; }

  function renderStrip() {
    const r = RUN, total = runDur(r), strip = $('strip');
    strip.querySelectorAll('.seg').forEach(n=>n.remove());
    r.steps.forEach((s,i) => {
      const seg = document.createElement('div');
      seg.className = 'seg'+(s.status==='err'?' err':''); const left=total? (s.start/total)*100 : 0, w=total? Math.max((s.dur/total)*100,1.2) : 100;
      seg.style.left=left+'%'; seg.style.width=w+'%'; seg.style.background = s.status==='err'?'var(--failed-wash)':TYPE_COLOR[s.type][1];
      seg.dataset.i=i; seg.title=s.title;
      seg.addEventListener('click',(e)=>{ e.stopPropagation(); seekTo(s.start+s.dur*0.5); pinStep(i); });
      strip.appendChild(seg);
    });
    const area = $('costArea'); const W=1000,H=100; area.setAttribute('viewBox','0 0 '+W+' '+H);
    const totalCost = r.steps.reduce((a,s)=>a+(s.cost||0),0);
    if (totalCost > 0 && total > 0) {
      let cum=0; const pts=[[0,H]];
      r.steps.forEach(s=>{ cum+=(s.cost||0); const x=((s.start+s.dur)/total)*W; const y=H-(cum/totalCost)*H*0.9; pts.push([x,y]); });
      pts.push([W,pts[pts.length-1][1]]); pts.push([W,H]);
      const d='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
      area.innerHTML = '<path d="'+d+' Z" fill="var(--accent-wash)"/><path d="M0,'+H+' L'+pts.slice(1,-2).map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L')+'" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"/>';
    } else {
      area.innerHTML = '';
    }
    $('axisEnd').textContent='t = '+Math.round(total)+'s'; $('clockTot').textContent=fmtT(total);
    renderSignals();
  }

  function renderSignals() {
    const r = RUN, total = runDur(r), lane = $('signals');
    lane.querySelectorAll('.sig-m').forEach(n=>n.remove());
    if (!total) return;
    r.steps.forEach((s,i) => {
      if (!s.sig) return;
      s.sig.forEach(sg => {
        const at = ((s.start+s.dur*0.5)/total)*100;
        const m = document.createElement('div'); m.className='sig-m'; m.style.left=at+'%';
        m.style.background='var(--stuck)'; m.style.color='#fff'; m.style.borderColor='var(--stuck)';
        m.innerHTML = svg(SVG_LOOP,1.9); m.title = 'Retry loop ×'+sg.count+' — step '+(i+1);
        m.addEventListener('click', ()=>{ pinStep(i); seekTo(s.start+0.3); });
        lane.appendChild(m);
      });
    });
  }

  function sBadges(s) {
    if (!s.sig) return '';
    return s.sig.map(sg => '<span class="sbadge retry">'+svg(SVG_LOOP,2)+'&times;'+sg.count+'</span>').join('');
  }

  function renderSteps() {
    const r = RUN; const el = $('steps');
    $('stepCount').textContent = r.steps.length+' step'+(r.steps.length===1?'':'s');
    if (!r.steps.length) { el.innerHTML = '<div class="insp-empty" style="padding:14px">No steps logged for this run.</div>'; return; }
    el.innerHTML = r.steps.map((s,i) => {
      const [c,w] = TYPE_COLOR[s.type];
      const stat = s.status==='err' ? '<span class="stat-chip stat-err">error</span>' : (s.type==='done' ? '<span class="stat-chip stat-ok">done</span>' : '');
      const metaBits = [ 't+'+fmtT(s.start), s.dur+'s'+(fmtCost(s.cost)?(' · '+fmtCost(s.cost)):'') ];
      return '<div class="step" data-i="'+i+'" role="button" tabindex="0" aria-selected="false" style="--tc:'+c+';--tc-wash:'+w+'">'
        + '<div class="rail"><div class="tick">'+icon(s.type)+'</div></div>'
        + '<div class="body"><div class="st-title">'+escapeHtml(s.title)+' '+stat+sBadges(s)+'</div></div>'
        + '<div class="meta">'+metaBits.join('<br>')+'</div></div>';
    }).join('');
    el.querySelectorAll('.step').forEach(node => {
      const i=+node.dataset.i;
      node.addEventListener('click', ()=>{ pinStep(i); seekTo(RUN.steps[i].start+0.3); });
      node.addEventListener('keydown',(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pinStep(i); seekTo(RUN.steps[i].start+0.3); } });
    });
  }

  function currentStepIndex(){ const r=RUN; let idx=-1; r.steps.forEach((s,i)=>{ if(playT>=s.start) idx=i; }); return idx; }

  function renderInspector() {
    const r = RUN;
    if (pinnedStep!=null && r.steps[pinnedStep]) renderStepIO(r.steps[pinnedStep], pinnedStep);
    else renderVerdict(r);
  }

  function renderVerdict(r) {
    $('inspTitle').textContent = 'Verdict';
    const insp = $('insp');
    if (r.verdict==='unjudged') {
      insp.innerHTML = '<div class="insp-section"><div class="insp-empty">No verdict — no goal-attainment judge was configured for this run (set TRAIL_JUDGE_PROVIDER/TRAIL_JUDGE_API_KEY to enable one).</div></div>';
      return;
    }
    const v = VERDICT[r.verdict];
    insp.style.setProperty('--vc', v.color);
    insp.innerHTML = '<div class="insp-section"><h3>LLM judge</h3><div class="judge-quote">'+r.narrative+'</div></div>';
  }

  function renderStepIO(s, i) {
    $('inspTitle').textContent = (s.title)+' · step '+(i+1);
    const insp = $('insp');
    let inner = '<div class="pin-note"><span>&#9670; pinned to step '+(i+1)+'</span><button id="unpin">back to verdict</button></div>';
    if (s.sig) inner += s.sig.map(sg => '<div class="io-sig"><span style="color:var(--stuck);display:grid;place-items:center">'+svg(SVG_LOOP,1.9)+'</span><div><span class="st" style="color:var(--stuck)">Retry loop &times;'+sg.count+'</span><div style="color:var(--ink-2);margin-top:2px">'+escapeHtml(sg.detail)+'</div></div></div>').join('');
    if (s.io && s.io.length) inner += s.io.map(p=>'<div class="io-kind">'+escapeHtml(p[0])+'</div><div class="io-block">'+escapeHtml(p[1])+'</div>').join('');
    else inner += '<div class="insp-empty">No input/output recorded for this step.</div>';
    insp.innerHTML = inner;
    const un=$('unpin'); if (un) un.addEventListener('click', ()=>pinStep(null));
  }

  function updatePlayhead() {
    const r=RUN, total=runDur(r); const pct=total? Math.min(100,(playT/total)*100) : 0;
    $('playhead').style.left=pct+'%'; $('clockNow').textContent=fmtT(playT);
    $('strip').setAttribute('aria-valuenow', Math.round(pct));
    let cost=0,tok=0,steps=0;
    r.steps.forEach(s=>{ if(playT>=s.start+s.dur){ cost+=(s.cost||0); tok+=(s.tok||0); steps++; } else if(playT>=s.start && s.dur>0){ const f=(playT-s.start)/s.dur; cost+=(s.cost||0)*f; tok+=Math.round((s.tok||0)*f); } });
    $('accCost').textContent=fmtCost(cost)||'$0.00'; $('accSteps').textContent=steps+'/'+r.steps.length; $('accTok').textContent=fmtTok(tok)||'0';
    const ci=currentStepIndex();
    $('strip').querySelectorAll('.seg').forEach(seg=>{ const i=+seg.dataset.i, s=r.steps[i]; seg.classList.toggle('played',playT>=s.start); seg.classList.toggle('current',i===ci); });
    $('steps').querySelectorAll('.step').forEach(node=>{ const i=+node.dataset.i; node.setAttribute('data-current', i===ci?'true':'false'); node.setAttribute('aria-selected',(pinnedStep===i)?'true':'false'); });
    if (pinnedStep==null && ci>=0 && playing) { const node=$('steps').querySelector('.step[data-i="'+ci+'"]'); if(node) node.scrollIntoView({block:'nearest', behavior:reduceMotion?'auto':'smooth'}); }
  }
  function seekTo(t){ const total=runDur(RUN); playT=Math.max(0,Math.min(total,t)); updatePlayhead(); }
  function pinStep(i){ pinnedStep=i; renderInspector(); updatePlayhead(); }

  function tick(ts) {
    if (!playing) return;
    if (lastTs==null) lastTs=ts;
    const dt=(ts-lastTs)/1000; lastTs=ts; playT+=dt*speed;
    const total=runDur(RUN);
    if (playT>=total){ playT=total; setPlaying(false); updatePlayhead(); return; }
    updatePlayhead(); raf=requestAnimationFrame(tick);
  }
  function setPlaying(p) {
    playing=p; lastTs=null;
    $('playIcon').innerHTML = p ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', p?'Pause replay':'Play replay');
    if (p) { if(playT>=runDur(RUN)) playT=0; pinStep(null); raf=requestAnimationFrame(tick); }
    else if (raf) cancelAnimationFrame(raf);
  }

  function initControls() {
    $('playBtn').addEventListener('click', ()=>setPlaying(!playing));
    $('speeds').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ speed=+b.dataset.sp; $('speeds').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); }));
    const strip=$('strip');
    function seekFromEvent(e){ const rect=strip.getBoundingClientRect(); const x=((e.touches?e.touches[0].clientX:e.clientX)-rect.left)/rect.width; seekTo(x*runDur(RUN)); }
    let dragging=false;
    strip.addEventListener('mousedown',(e)=>{ if(e.target.classList.contains('seg')) return; dragging=true; setPlaying(false); seekFromEvent(e); });
    window.addEventListener('mousemove',(e)=>{ if(dragging) seekFromEvent(e); });
    window.addEventListener('mouseup',()=>dragging=false);
    strip.addEventListener('keydown',(e)=>{ const total=runDur(RUN); if(e.key==='ArrowRight'){ seekTo(playT+total*0.02); e.preventDefault(); } if(e.key==='ArrowLeft'){ seekTo(playT-total*0.02); e.preventDefault(); } });
    $('themeBtn').addEventListener('click', ()=>{ const root=document.documentElement; const isDark=(root.getAttribute('data-theme')||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark'; root.setAttribute('data-theme', isDark?'light':'dark'); });
    document.addEventListener('keydown',(e)=>{ if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return; if(e.key===' '){ e.preventDefault(); setPlaying(!playing); } });
  }

  renderMission(); renderStrip(); renderSteps(); renderInspector(); updatePlayhead(); initControls();
})();
</script>
`;

export function renderFlightRecorderPage(run: RunView): string {
	return TEMPLATE.replace("__RUN_JSON__", JSON.stringify(run));
}
```

- [ ] **Step 2: Build**

Run: `cd server && npm run build`
Expected: exits 0. (No test file for this task — the template is exercised end-to-end by Task 3's route tests and Task 4's manual verification; there is no meaningful unit test for a function that returns a large HTML string beyond "does it contain the substituted JSON," which Task 3's tests already cover via the route.)

- [ ] **Step 3: Commit**

```bash
git add server/src/templates/flight-recorder.ts
git commit -m "feat(server): add the adapted Flight Recorder HTML template"
```

---

### Task 3: Wire the new routes into `server/src/server.ts`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/test/server.test.js`

**Interfaces:**
- Consumes: `getRun`, `listRuns` from `../runs.js` (Task 1); `renderFlightRecorderPage` from `./templates/flight-recorder.js` (Task 2).
- Produces: nothing new for other tasks — this is where the reshape module and template actually get served.

**Context:** `server/src/server.ts` currently has two routes: `POST /traces` (unchanged by this task) and `GET /` (today: a placeholder page via `renderPlaceholderPage(countTraces(db))` — this task replaces it with a real run list). This task adds `GET /runs/:traceId` and removes the placeholder page function/import (`countTraces`'s import for the placeholder purpose — note `countTraces` may still be needed elsewhere; check before removing its import, but the placeholder-specific `renderPlaceholderPage` function is definitely removed). URL parsing for `/runs/:traceId` uses a simple prefix check (`req.url?.startsWith("/runs/")`) and extracts the trace ID from the remainder — no router library, matching this file's existing plain `node:http` approach (no framework, per the packaging spec).

- [ ] **Step 1: Read the current file first**

Read `server/src/server.ts` in full before making changes — it was last touched by the final-review fix wave (crash-proofing `GET /`), so confirm the exact current shape of the `GET /` branch and the `renderPlaceholderPage` function before replacing them.

- [ ] **Step 2: Write the new/changed tests**

In `server/test/server.test.js`, add these imports alongside the existing ones at the top of the file:

```js
import { getRun } from "../dist/runs.js";
```

Add this new `describe` block after the existing `GET /` describe block:

```js
describe("GET /runs/:traceId", () => {
	test("renders the Flight Recorder page for a run that exists", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /Flight Recorder/);
			assert.match(text, /test-span/);
		});
	});

	test("returns 404 for a traceId with no matching run", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"f".repeat(32)}`);
			assert.equal(res.status, 404);
		});
	});
});
```

Update the existing `GET /` describe block's two tests (`"returns a page reporting zero runs before any ingestion"` and `"reflects the ingested trace count after a POST /traces"`) — they currently assert on the placeholder page's `/0 runs/`/`/1 run(?!s)/` text. Replace both bodies to assert on the new run-list page instead:

```js
describe("GET /", () => {
	test("returns a page with no run links before any ingestion", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.equal(text.includes("/runs/"), false);
		});
	});

	test("lists the run after a POST /traces, linking to its detail page", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, new RegExp(`/runs/${"a".repeat(32)}`));
			assert.match(text, /test-span/);
		});
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && node --test test/server.test.js`
Expected: FAIL — `renderFlightRecorderPage`/`getRun`/`listRuns` aren't wired into the routes yet, so `GET /` still serves the old placeholder text and `GET /runs/:traceId` 404s unconditionally.

- [ ] **Step 4: Update `server/src/server.ts`**

Add these imports alongside the existing ones at the top of the file:

```ts
import { getRun, listRuns } from "./runs.js";
import { renderFlightRecorderPage } from "./templates/flight-recorder.js";
import { renderRunListPage } from "./templates/run-list.js";
```

Replace the `renderPlaceholderPage` function and its call site in the `GET /` branch. Find the current `GET /` branch (added by the crash-proofing fix wave — read the actual current code first per Step 1, since the exact surrounding try/catch shape must be preserved) and change what it renders: instead of `renderPlaceholderPage(countTraces(db))`, call `renderRunListPage(listRuns(db, 50))` (50 = a reasonable default cap for a local single-developer tool, not user-configurable in this task). Delete the `renderPlaceholderPage` function entirely once nothing calls it. If `countTraces` is not used anywhere else in this file after this change, remove its import too — check first, since `POST /traces`'s response body may still reference it.

Add a new route, checked after the existing `POST /traces` and `GET /` branches and before the final 404 fallback:

```ts
		if (req.method === "GET" && req.url?.startsWith("/runs/")) {
			const traceId = req.url.slice("/runs/".length);
			try {
				const run = getRun(db, traceId);
				if (!run) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "run not found" }));
					return;
				}
				const page = renderFlightRecorderPage(run);
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(page);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
			}
			return;
		}
```

This follows the same compute-body-before-writeHead pattern as the crash-proofed `GET /` branch (never write headers before the potentially-throwing call completes), and the same try/catch-to-500 shape.

- [ ] **Step 5: Create `server/src/templates/run-list.ts`**

```ts
import type { RunSummary } from "../runs.js";

const VERDICT_LABEL: Record<string, string> = { met: "Goal met", partial: "Partial", failed: "Goal missed", unjudged: "Not judged" };
const VERDICT_COLOR: Record<string, string> = { met: "#2FA24A", partial: "#C08810", failed: "#DC4A38", unjudged: "#8A8F97" };

function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
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
</style>
<div class="wrap">
	<h1>Tether — Runs</h1>
	${empty}
	${runs.length ? `<table><thead><tr><th>Goal</th><th>Verdict</th><th>Duration</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
</div>`;
}
```

- [ ] **Step 6: Build**

Run: `cd server && npm run build`
Expected: exits 0.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && node --test test/server.test.js`
Expected: all tests pass, including the updated `GET /` tests and the new `GET /runs/:traceId` tests.

- [ ] **Step 8: Run the full server test suite**

Run: `cd server && npm test`
Expected: all tests pass (`db.test.js`, `runs.test.js`, `server.test.js`).

- [ ] **Step 9: Commit**

```bash
git add server/src/server.ts server/src/templates/run-list.ts server/test/server.test.js
git commit -m "feat(server): serve the run list and Flight Recorder pages, replacing the placeholder"
```

---

### Task 4: End-to-end verification and README update

**Files:**
- Modify: `server/README.md`

**Interfaces:** None — this task verifies the whole pipeline and updates documentation; it produces nothing further tasks consume.

**Context:** Every prior task's tests use synthetic OTLP fixtures. This task proves the real pipeline — `mcp/`'s actual tool calls, through the real ingestion endpoint, rendering in the real browser-facing pages — the same kind of check that caught real bugs in this project's history (a header-ordering crash, a `homeDir` default that silently pointed at the wrong file). `server/README.md` currently describes only the placeholder page under "What's here today" and needs updating to describe the real run list and Flight Recorder pages.

- [ ] **Step 1: Manual end-to-end verification**

Write a throwaway script (do not commit it) that:
1. Starts the built `server/dist/index.js` on a test port (`TETHER_PORT` set to something other than the default, to avoid colliding with any other instance).
2. Spawns `mcp/dist/index.js` as a child process via `StdioClientTransport` + `Client` from `@modelcontextprotocol/sdk/client`, with `TRAIL_URL` pointed at the test server (matching the pattern already used for this project's prior end-to-end verifications).
3. Calls `trail_start_run` with a real goal (e.g. `"fix the flaky auth test"`), then a few `trail_log_step` calls (mix of `task` and `tool` kind, including at least one with `status: "error"` and at least 3 consecutive identically-named failing tool calls to exercise the retry-detection heuristic), a `trail_log_llm_call`, then `trail_finish_run` with a summary.
4. `curl`s `http://127.0.0.1:<port>/` and confirms the run appears in the list, linking to `/runs/<traceId>`.
5. `curl`s the run detail page and confirms it contains the goal text, the step titles, and (if `TRAIL_JUDGE_PROVIDER`/`TRAIL_JUDGE_API_KEY` are set for this test — optional, the "unjudged" path is equally worth confirming by NOT setting them) either a rendered verdict or the "no goal-attainment judge was configured" message.
6. Stops both processes cleanly.

Paste the real terminal output into the task report — not a paraphrase. Delete the throwaway script when done.

- [ ] **Step 2: Update `server/README.md`'s "What's here today" section**

Find the bullet list under `## What's here today` (currently describes `POST /traces` and a placeholder `GET /`). Replace the `GET /` bullet with:

```markdown
- `GET /` — a run list: goal, verdict, duration, start time, linking into each
  run's detail page.
- `GET /runs/:traceId` — the Flight Recorder view for one run: goal, verdict
  (when a judge is configured), a scrubbable step timeline with play/pause/
  speed controls, and per-step expansion showing raw input/output. Adapted
  from a design prototype, cut down to exactly what's captured today — no
  pinned criteria, sub-goals, guardrail/eval signals, diffs, or context-window
  inspector, since none of that data exists yet.
```

- [ ] **Step 3: Commit**

```bash
git add server/README.md
git commit -m "docs(server): describe the run list and Flight Recorder pages"
```
