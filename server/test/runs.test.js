import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getRun, listRuns, getAllTraceIds } from "../dist/runs.js";

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

function structuredStepSpan({ traceId, spanId, parentSpanId, name, startNs, endNs, toolName, isError, input, output, stack, context }) {
	const attrs = { "gen_ai.operation.name": toolName ? "execute_tool" : "execute_task" };
	if (toolName) attrs["gen_ai.tool.name"] = toolName;
	const events = [];
	if (input !== undefined) events.push({ name: "gen_ai.content.prompt", timeUnixNano: endNs, attributes: otlpAttrs({ "gen_ai.prompt": JSON.stringify(input) }) });
	if (output !== undefined) events.push({ name: "gen_ai.content.completion", timeUnixNano: endNs, attributes: otlpAttrs({ "gen_ai.completion": JSON.stringify(output) }) });
	if (isError) {
		const excAttrs = { "exception.type": "Error", "exception.message": "step failed" };
		if (stack) excAttrs["exception.stacktrace"] = stack;
		events.push({ name: "exception", timeUnixNano: endNs, attributes: otlpAttrs(excAttrs) });
	}
	if (context !== undefined) events.push({ name: "gen_ai.content.context", timeUnixNano: endNs, attributes: otlpAttrs({ "gen_ai.context": JSON.stringify(context) }) });
	const raw = { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events, status: { code: isError ? 2 : 1 } };
	return { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
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

	test("decodes JSON-encoded structured input/output into objects, a JSON-encoded plain string into an unquoted string, and leaves pre-Phase-1 legacy plain-string io as-is", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t8", spanId: "r8", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, structuredStepSpan({ traceId: "t8", spanId: "s1", parentSpanId: "r8", name: "edit auth.py", startNs: "1010000000000", endNs: "1011000000000", toolName: "str_replace auth.py", input: { file: "auth.py", find: "old", replace: "new" }, output: { ok: true } }));
			insertSpan(db, structuredStepSpan({ traceId: "t8", spanId: "s2", parentSpanId: "r8", name: "check output", startNs: "1012000000000", endNs: "1013000000000", toolName: "echo", output: "just a plain string" }));
			insertSpan(db, stepSpan({ traceId: "t8", spanId: "s3", parentSpanId: "r8", name: "legacy step", startNs: "1014000000000", endNs: "1015000000000", toolName: "run pytest", prompt: "pytest -x" }));
			const run = getRun(db, "t8");
			assert.deepEqual(run.steps[0].io, [["Input", { file: "auth.py", find: "old", replace: "new" }], ["Output", { ok: true }]]);
			assert.deepEqual(run.steps[1].io, [["Output", "just a plain string"]]);
			assert.deepEqual(run.steps[2].io, [["Input", "pytest -x"]]);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("extracts exception.stacktrace as a Stack io pair when present, after the Error pair", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t9", spanId: "r9", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, structuredStepSpan({ traceId: "t9", spanId: "s1", parentSpanId: "r9", name: "run build", startNs: "1010000000000", endNs: "1011000000000", toolName: "npm run build", isError: true, stack: "Error: boom\n  at build.js:1:1" }));
			const run = getRun(db, "t9");
			assert.deepEqual(run.steps[0].io, [["Error", "step failed"], ["Stack", "Error: boom\n  at build.js:1:1"]]);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("a failed step with no stack trace gets no Stack io pair", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t10", spanId: "r10", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, structuredStepSpan({ traceId: "t10", spanId: "s1", parentSpanId: "r10", name: "run build", startNs: "1010000000000", endNs: "1011000000000", toolName: "npm run build", isError: true }));
			const run = getRun(db, "t10");
			assert.deepEqual(run.steps[0].io, [["Error", "step failed"]]);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("extracts gen_ai.content.context as a Context io pair with a decoded structured value", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t11", spanId: "r11", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, structuredStepSpan({ traceId: "t11", spanId: "s1", parentSpanId: "r11", name: "exception", startNs: "1010000000000", endNs: "1011000000000", context: { attempt: 3 } }));
			const run = getRun(db, "t11");
			assert.deepEqual(run.steps[0].io, [["Context", { attempt: 3 }]]);
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
			assert.equal(run.steps[0].sourceName, undefined);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("drops a half-formed attribution pair (source_type with no source_name, or vice versa)", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t12", spanId: "r12", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));

			const typeOnly = stepSpan({ traceId: "t12", spanId: "s1", parentSpanId: "r12", name: "type only", startNs: "1010000000000", endNs: "1011000000000" });
			typeOnly.raw = JSON.stringify({ ...JSON.parse(typeOnly.raw), attributes: [...JSON.parse(typeOnly.raw).attributes, { key: "gen_ai.harness.source_type", value: { stringValue: "skill" } }] });
			insertSpan(db, typeOnly);

			const nameOnly = stepSpan({ traceId: "t12", spanId: "s2", parentSpanId: "r12", name: "name only", startNs: "1012000000000", endNs: "1013000000000" });
			nameOnly.raw = JSON.stringify({ ...JSON.parse(nameOnly.raw), attributes: [...JSON.parse(nameOnly.raw).attributes, { key: "gen_ai.harness.source_name", value: { stringValue: "code-review" } }] });
			insertSpan(db, nameOnly);

			const run = getRun(db, "t12");
			const step1 = run.steps.find((s) => s.title === "type only");
			const step2 = run.steps.find((s) => s.title === "name only");
			assert.equal(step1.sourceType, undefined);
			assert.equal(step1.sourceName, undefined);
			assert.equal(step2.sourceType, undefined);
			assert.equal(step2.sourceName, undefined);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});

describe("malformed nanosecond timestamps never throw (finding 5)", () => {
	test("getRun does not throw when the root span's startTimeUnixNano is malformed, and still returns a RunView", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "bad-root", spanId: "rbad1", goal: "g", agent: "a", startNs: "not-a-number", endNs: "1001000000000" }));
			let run;
			assert.doesNotThrow(() => { run = getRun(db, "bad-root"); });
			assert.notEqual(run, null);
			assert.equal(run.goal, "g");
			assert.equal(run.totals.dur, "0s");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("getRun skips a step whose own timestamp is malformed instead of crashing the whole run", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "bad-step", spanId: "rbad2", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
			insertSpan(db, stepSpan({ traceId: "bad-step", spanId: "sbad", parentSpanId: "rbad2", name: "broken step", startNs: "not-a-number", endNs: "1005000000000", toolName: "broken tool" }));
			insertSpan(db, stepSpan({ traceId: "bad-step", spanId: "sgood", parentSpanId: "rbad2", name: "good step", startNs: "1010000000000", endNs: "1011000000000", toolName: "good tool" }));
			let run;
			assert.doesNotThrow(() => { run = getRun(db, "bad-step"); });
			assert.equal(run.steps.length, 1);
			assert.equal(run.steps[0].title, "good tool");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("listRuns skips a run whose startTimeUnixNano is malformed instead of crashing the whole list", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "bad-list", spanId: "rbad3", goal: "bad run", agent: "a", startNs: "not-a-number", endNs: "1001000000000" }));
			insertSpan(db, rootSpan({ traceId: "good-list", spanId: "rgood3", goal: "good run", agent: "a", startNs: "1000000000000", endNs: "1001000000000" }));
			let runs;
			assert.doesNotThrow(() => { runs = listRuns(db, 10); });
			assert.equal(runs.length, 1);
			assert.equal(runs[0].traceId, "good-list");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("falls back to the root span's name (not a crash) when gen_ai.agent.goal is a non-string attribute value", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			const raw = {
				traceId: "t7",
				spanId: "r7",
				name: "fallback-name",
				startTimeUnixNano: "1000000000000",
				endTimeUnixNano: "1001000000000",
				attributes: [{ key: "gen_ai.agent.goal", value: { intValue: "42" } }],
				events: [],
				status: { code: 1 },
			};
			insertSpan(db, {
				traceId: "t7",
				spanId: "r7",
				parentSpanId: null,
				name: "fallback-name",
				startTimeUnixNano: "1000000000000",
				endTimeUnixNano: "1001000000000",
				raw: JSON.stringify(raw),
			});
			const run = getRun(db, "t7");
			assert.equal(run.goal, "fallback-name");
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

	test("degrades to an empty startedAt (not a crash) when the timestamp is outside Date's valid range", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "huge", spanId: "r1", goal: "g", agent: "a", startNs: "99999999999999999999999", endNs: "99999999999999999999999" }));
			const runs = listRuns(db, 10);
			assert.equal(runs.length, 1);
			assert.equal(runs[0].startedAt, "");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("falls back to the span name (not a crash) when gen_ai.agent.goal is a non-string attribute value", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			const raw = {
				traceId: "t",
				spanId: "r1",
				name: "fallback-name",
				startTimeUnixNano: "1000000000000",
				endTimeUnixNano: "1001000000000",
				attributes: [{ key: "gen_ai.agent.goal", value: { intValue: "42" } }],
				events: [],
				status: { code: 1 },
			};
			insertSpan(db, {
				traceId: "t",
				spanId: "r1",
				parentSpanId: null,
				name: "fallback-name",
				startTimeUnixNano: "1000000000000",
				endTimeUnixNano: "1001000000000",
				raw: JSON.stringify(raw),
			});
			const runs = listRuns(db, 10);
			assert.equal(runs[0].goal, "fallback-name");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});

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
