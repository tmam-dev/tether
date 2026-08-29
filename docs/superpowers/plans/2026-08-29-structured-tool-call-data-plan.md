# Structured Tool-Call & LLM-Call Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque free-text `input`/`output` (steps) and `prompt`/`completion` (LLM calls) strings with real structured JSON, and add `stack`/`context` to exceptions — Phase 1 of Tether's rich-debug-data roadmap.

**Architecture:** A new `mcp/src/sanitize.ts` redacts/truncates structured values before they're `JSON.stringify`'d into the existing OTLP string-attribute slots (no wire-format or storage-schema change). `mcp/src/index.ts` is split into a thin entrypoint plus a new `mcp/src/tools.ts` holding the testable server-construction logic and pure span-building functions, so the new schemas can be unit-tested without spinning up a real MCP transport. `server/src/runs.ts` gains a JSON-parse-with-legacy-fallback decode step so old and new data both render. `server/src/static/app.ts` gains a small collapsible JSON-tree renderer for the Flight Recorder inspector.

**Tech Stack:** TypeScript (`tsc`, `moduleDetection: "legacy"` in `server/`), Zod for MCP tool schemas, `node:test` + `node:assert/strict` for both packages, better-sqlite3 (untouched by this plan), no frontend framework/bundler.

**Spec:** `docs/superpowers/specs/2026-08-29-structured-tool-call-data-design.md`

## Global Constraints

- No `spans` table schema change — `raw` stays a JSON blob (spec §2, §3.4).
- `AttrValue` in `mcp/src/otlp.ts` stays `string | number | boolean` — structured values travel as `JSON.stringify`'d strings in the existing attribute slots, never as nested OTLP `AnyValue` (spec §3.3, §6).
- Redaction and the 16KB-per-string-leaf truncation cap are enforced **producer-side only** (`mcp/src/sanitize.ts`), never on the server (spec §5).
- This is a breaking change to the public MCP tool schemas — no dual-shape (string-or-object) acceptance on the producer side (spec §6). The server's read side, by contrast, must tolerate both shapes forever (already-ingested legacy spans never get rewritten).
- Every task must leave both `mcp/` (`npm run build && npm test` in `mcp/`) and, where touched, `server/` (`npm run build && npm test` in `server/`) green before moving to the next task.

---

### Task 1: `sanitize.ts` — redaction + truncation

**Files:**
- Create: `mcp/src/sanitize.ts`
- Test: `mcp/test/sanitize.test.js`

**Interfaces:**
- Produces: `sanitize(value: unknown, maxBytes?: number): unknown` — recursively redacts secret-shaped string leaves and truncates any string leaf over `maxBytes` (default `16384`). Non-string leaves and object/array structure pass through unchanged. Used by every `build*Span` function added in Tasks 4-6.

- [ ] **Step 1: Write the failing tests**

Create `mcp/test/sanitize.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../dist/sanitize.js";

describe("sanitize — redaction", () => {
	test("redacts an OpenAI/Anthropic-style sk- key", () => {
		assert.equal(sanitize("key is sk-abcdefghij1234567890"), "key is [REDACTED]");
	});

	test("redacts a GitHub PAT (ghp_...)", () => {
		assert.equal(sanitize("my github token is ghp_abcdefghij1234567890abcd"), "my github token is [REDACTED]");
	});

	test("redacts an AWS access key id (AKIA...)", () => {
		assert.equal(sanitize("id=AKIAABCDEFGHIJKLMNOP"), "id=[REDACTED]");
	});

	test("redacts a Bearer token", () => {
		assert.equal(sanitize("Authorization: Bearer abcxyz1234567890"), "Authorization: [REDACTED]");
	});

	test("redacts a KEY=value pair whose key name contains 'password'", () => {
		assert.equal(sanitize("db_password=hunter2hunter2"), "[REDACTED]");
	});

	test("redacts a JSON-ish \"api_key\": \"value\" pair", () => {
		assert.equal(sanitize('{"api_key": "abc123def456"}'), '{[REDACTED]}');
	});

	test("does not redact ordinary text mentioning 'password' with no value attached", () => {
		assert.equal(sanitize("please enter your password"), "please enter your password");
	});

	test("does not redact an ordinary short numeric id", () => {
		assert.equal(sanitize("build id: 4821"), "build id: 4821");
	});
});

describe("sanitize — truncation", () => {
	test("leaves a string under the byte cap unchanged", () => {
		const s = "a".repeat(100);
		assert.equal(sanitize(s, 16384), s);
	});

	test("truncates a string over the byte cap with a marker naming the original byte count", () => {
		const s = "a".repeat(20000);
		const out = sanitize(s, 16384);
		assert.ok(out.length < s.length);
		assert.ok(out.endsWith("…[truncated, 20000b]"));
	});

	test("a string exactly at the byte cap is not truncated", () => {
		const s = "a".repeat(16384);
		assert.equal(sanitize(s, 16384), s);
	});

	test("truncation is measured in UTF-8 bytes, not JS string length, for multi-byte characters", () => {
		// each "€" is 3 bytes in UTF-8 but 1 UTF-16 code unit in JS string length
		const s = "€".repeat(10000); // 30000 bytes
		const out = sanitize(s, 16384);
		assert.match(out, /…\[truncated, 30000b\]$/);
	});
});

describe("sanitize — structure preservation", () => {
	test("truncates only the offending string leaf, preserving object shape and other keys", () => {
		const big = "x".repeat(20000);
		const out = sanitize({ file: "auth.py", diff: big, lines: 42 });
		assert.equal(out.file, "auth.py");
		assert.equal(out.lines, 42);
		assert.ok(out.diff.endsWith("…[truncated, 20000b]"));
	});

	test("recurses into arrays", () => {
		const out = sanitize(["sk-abcdefghij1234567890", "plain text"]);
		assert.deepEqual(out, ["[REDACTED]", "plain text"]);
	});

	test("passes numbers, booleans, and null through unchanged", () => {
		assert.deepEqual(sanitize({ n: 42, b: true, z: null }), { n: 42, b: true, z: null });
	});

	test("passes a plain object/array with no string leaves through unchanged", () => {
		assert.deepEqual(sanitize({ ok: true, count: 3, tags: [1, 2, 3] }), { ok: true, count: 3, tags: [1, 2, 3] });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/sanitize.test.js`
Expected: FAIL — `Cannot find module '../dist/sanitize.js'`

- [ ] **Step 3: Write the implementation**

Create `mcp/src/sanitize.ts`:

```ts
/**
 * Producer-side redaction and truncation for structured tool-call/LLM-call
 * data before it's sent to Trail. Best-effort pattern matching, not a
 * guarantee — see mcp/README.md's "Migrating from 0.2.x" section.
 */

const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9]{10,}\b/g, // OpenAI/Anthropic-style API keys
	/\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub personal access tokens
	/\bAKIA[A-Z0-9]{12,}\b/g, // AWS access key ids
	/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, // Authorization: Bearer <token>
	/["']?[A-Za-z0-9_]*(?:secret|password|token|api[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, // KEY=value / "key": "value" near a secret-ish name
];

function redact(s: string): string {
	let out = s;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

function truncate(s: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(s, "utf8");
	if (bytes <= maxBytes) return s;
	const cut = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
	return `${cut}…[truncated, ${bytes}b]`;
}

export function sanitize(value: unknown, maxBytes = 16384): unknown {
	if (typeof value === "string") return truncate(redact(value), maxBytes);
	if (Array.isArray(value)) return value.map((v) => sanitize(v, maxBytes));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, maxBytes);
		return out;
	}
	return value;
}
```

Note on the redaction regex: every pattern replaces its *entire* matched span with the literal string `[REDACTED]` — none preserve the key name. This is deliberate, not just simplicity: patterns are applied in sequence (one `.replace()` per pattern, each over the previous pattern's output), and a scheme that preserved the key name (e.g. `db_password=[REDACTED]`) would leave a label like `token:` sitting directly in front of an already-inserted `[REDACTED]` marker — which is itself shaped like `token: [REDACTED]`, a string the generic "key name containing 'token' followed by `:`/`=`" pattern (pattern 5) would then match *again* on its own turn through the loop, over-redacting. Whole-match replacement sidesteps this: once a span becomes `[REDACTED]`, nothing about it resembles `key: value` anymore, so no later pattern in the list can re-match it. The `{"api_key": "abc123def456"}` test case redacting to `{[REDACTED]}` (swallowing the key name along with the quotes and colon) is this same whole-match behavior, not exact JSON-aware redaction — expected and documented as "best-effort."

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/sanitize.test.js`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
cd mcp && git add src/sanitize.ts test/sanitize.test.js
git commit -m "feat(mcp): add sanitize() for redacting/truncating structured payloads"
```

---

### Task 2: `otlp.ts` — exception stack trace support

**Files:**
- Modify: `mcp/src/otlp.ts:60` (`SpanInput.error` type), `mcp/src/otlp.ts:71-80` (`buildPayload`'s exception event)
- Test: `mcp/test/otlp.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SpanInput.error` gains an optional `stack?: string` field. When present, `buildPayload` adds an `exception.stacktrace` attribute (OTel semantic-convention name) to the `exception` event, alongside the existing `exception.type`/`exception.message`. Used by `buildExceptionSpan` in Task 6.

- [ ] **Step 1: Write the failing test**

Add to `mcp/test/otlp.test.js` (new `describe` block, after the existing `describe("sendSpan", ...)` block):

```js
import { buildPayload } from "../dist/otlp.js";

describe("buildPayload — exception stacktrace", () => {
	test("adds an exception.stacktrace attribute when error.stack is set", () => {
		const payload = buildPayload(
			{ url: "http://localhost:4319", environment: "default", serviceName: "test" },
			{ ...BASE_SPAN, error: { message: "boom", type: "BuildError", stack: "Error: boom\n  at build.js:1:1" } },
		);
		const exceptionEvent = payload.resourceSpans[0].scopeSpans[0].spans[0].events.find((e) => e.name === "exception");
		const stackAttr = exceptionEvent.attributes.find((a) => a.key === "exception.stacktrace");
		assert.equal(stackAttr.value.stringValue, "Error: boom\n  at build.js:1:1");
	});

	test("omits exception.stacktrace entirely when error.stack is not set", () => {
		const payload = buildPayload(
			{ url: "http://localhost:4319", environment: "default", serviceName: "test" },
			{ ...BASE_SPAN, error: { message: "boom", type: "BuildError" } },
		);
		const exceptionEvent = payload.resourceSpans[0].scopeSpans[0].spans[0].events.find((e) => e.name === "exception");
		assert.equal(exceptionEvent.attributes.some((a) => a.key === "exception.stacktrace"), false);
	});
});
```

(This adds a second named import on the existing `import { sendSpan } from "../dist/otlp.js";` line — change it to `import { sendSpan, buildPayload } from "../dist/otlp.js";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npm run build && node --test test/otlp.test.js`
Expected: FAIL — `stackAttr` is `undefined` (first test), since `error.stack` isn't read yet.

- [ ] **Step 3: Write the implementation**

In `mcp/src/otlp.ts`, change line 60:

```ts
	error?: { message: string; type?: string };
```
to:
```ts
	error?: { message: string; type?: string; stack?: string };
```

And change lines 71-80 from:
```ts
	if (span.error) {
		events.push({
			timeUnixNano: span.endTimeUnixNano,
			name: "exception",
			attributes: toAttributes({
				"exception.type": span.error.type ?? "Error",
				"exception.message": span.error.message,
			}),
		});
	}
```
to:
```ts
	if (span.error) {
		events.push({
			timeUnixNano: span.endTimeUnixNano,
			name: "exception",
			attributes: toAttributes({
				"exception.type": span.error.type ?? "Error",
				"exception.message": span.error.message,
				"exception.stacktrace": span.error.stack,
			}),
		});
	}
```

(`toAttributes` already filters out `undefined` values — `otlp.ts:41` — so an absent `stack` produces no attribute, no extra branching needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/otlp.test.js`
Expected: PASS (all `sendSpan` tests plus the two new `buildPayload` tests)

- [ ] **Step 5: Commit**

```bash
cd mcp && git add src/otlp.ts test/otlp.test.js
git commit -m "feat(mcp): support an optional stack trace on exception spans"
```

---

### Task 3: Extract `mcp/src/tools.ts` from `index.ts` (pure refactor)

This task moves all server-construction logic (run state, tool registration, span-building) out of `index.ts` into a new `tools.ts`, with **no behavior change** — it exists purely to make the code testable, since `index.ts` currently connects a real stdio transport at module-load time (`await server.connect(transport)`), which would hang/fail if a test tried to `import` it. This directly resolves the "no dedicated test file" gap noted in `CLAUDE.md`.

**Files:**
- Create: `mcp/src/tools.ts`
- Modify: `mcp/src/index.ts` (becomes a thin entrypoint)
- Test: `mcp/test/tools.test.js`

**Interfaces:**
- Produces: `buildTrailServer(cfg: TrailConfig, judgeCfg: JudgeConfig | undefined): McpServer` — constructs and returns a fully-registered `McpServer` with its own isolated run-state `Map` (no shared/global state between calls, so tests can build multiple independent servers). Also produces `buildStepSpan`, `buildLlmCallSpan`, `buildExceptionSpan` (pure functions building a `SpanInput` from a run + tool-call args, used internally by the registered handlers and directly by tests) and the exported `Run` interface. Tasks 4-6 modify these three `build*Span` functions and their corresponding `inputSchema`s in place.
- Consumes: `TrailConfig`/`SpanInput`/`hexId`/`nowNanos`/`sendSpan` from `./otlp.js`, `buildHarnessManifest`/`HarnessManifest` from `./manifest.js`, `judgeGoalAttainment`/`JudgeConfig`/`Verdict` from `./judge.js` — all unchanged imports, just relocated from `index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `mcp/test/tools.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildStepSpan, buildLlmCallSpan, buildExceptionSpan } from "../dist/tools.js";

const RUN = { traceId: "t".repeat(32), rootSpanId: "r".repeat(16), agent: "coding-agent" };

describe("buildStepSpan", () => {
	test("sets gen_ai.tool.name and prompt/completion events for a successful tool step", () => {
		const span = buildStepSpan(RUN, "s1", "1000000000", "2000000000", {
			name: "run pytest", kind: "tool", input: "pytest -x", output: "1 failed", status: "ok",
		});
		assert.equal(span.attributes["gen_ai.tool.name"], "run pytest");
		assert.deepEqual(span.events, [
			{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": "pytest -x" } },
			{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": "1 failed" } },
		]);
		assert.equal(span.error, undefined);
	});

	test("omits gen_ai.tool.name for a task step", () => {
		const span = buildStepSpan(RUN, "s1", "1000000000", "2000000000", { name: "plan the fix", kind: "task", status: "ok" });
		assert.equal("gen_ai.tool.name" in span.attributes, false);
	});

	test("sets error.message on a failed step, defaulting when error_message is absent", () => {
		const span = buildStepSpan(RUN, "s2", "1000000000", "2000000000", { name: "run pytest", kind: "tool", status: "error" });
		assert.deepEqual(span.error, { message: "step failed" });
	});

	test("attributes source_type/source_name only when both are present", () => {
		const span = buildStepSpan(RUN, "s3", "1000000000", "2000000000", {
			name: "read auth.py", kind: "tool", status: "ok", source_type: "skill", source_name: "code-review",
		});
		assert.equal(span.attributes["gen_ai.harness.source_type"], "skill");
		assert.equal(span.attributes["gen_ai.harness.source_name"], "code-review");
	});
});

describe("buildLlmCallSpan", () => {
	test("computes total_tokens from input+output tokens and names the span 'chat {model}'", () => {
		const span = buildLlmCallSpan(RUN, "s4", "1000000000", "2000000000", {
			model: "claude-sonnet-4-5", input_tokens: 100, output_tokens: 50, status: "ok",
		});
		assert.equal(span.attributes["gen_ai.usage.total_tokens"], 150);
		assert.equal(span.name, "chat claude-sonnet-4-5");
	});

	test("leaves total_tokens undefined when neither input_tokens nor output_tokens is given", () => {
		const span = buildLlmCallSpan(RUN, "s5", "1000000000", "2000000000", { model: "gpt-4o-mini", status: "ok" });
		assert.equal(span.attributes["gen_ai.usage.total_tokens"], undefined);
	});
});

describe("buildExceptionSpan", () => {
	test("sets error message/type and defaults the span name to 'exception'", () => {
		const span = buildExceptionSpan(RUN, "s6", "2000000000", { message: "boom", type: "BuildError" });
		assert.equal(span.name, "exception");
		assert.deepEqual(span.error, { message: "boom", type: "BuildError" });
	});

	test("uses the given name when provided", () => {
		const span = buildExceptionSpan(RUN, "s7", "2000000000", { message: "boom", name: "test-failure" });
		assert.equal(span.name, "test-failure");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: FAIL — `Cannot find module '../dist/tools.js'`

- [ ] **Step 3: Create `tools.ts` and shrink `index.ts`**

Create `mcp/src/tools.ts`:

```ts
/**
 * Trail MCP server core: the McpServer factory, per-run state, and the pure
 * span-building functions the 5 registered tools use. Kept separate from
 * index.ts (the process entrypoint) so this file can be imported by tests
 * without triggering index.ts's stdio transport connection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TrailConfig, SpanInput, hexId, nowNanos, sendSpan } from "./otlp.js";
import { buildHarnessManifest, HarnessManifest } from "./manifest.js";
import { judgeGoalAttainment, JudgeConfig, Verdict } from "./judge.js";

export interface Run {
	traceId: string;
	rootSpanId: string;
	name: string;
	agent: string;
	startNanos: string;
	steps: number;
	errors: number;
	manifest: HarnessManifest;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// Accept common synonyms ("success"/"failed"/…) so a model that guesses at
// the value instead of reading the enum still lands on "ok" | "error".
const STATUS_ALIASES: Record<string, "ok" | "error"> = {
	ok: "ok",
	success: "ok",
	succeeded: "ok",
	pass: "ok",
	passed: "ok",
	error: "error",
	fail: "error",
	failed: "error",
	failure: "error",
};

const statusSchema = z
	.preprocess(
		(v) => (typeof v === "string" ? (STATUS_ALIASES[v.toLowerCase()] ?? v) : v),
		z.enum(["ok", "error"]),
	)
	.default("ok")
	.describe("Outcome: 'ok' or 'error' ('success'/'failed'/'failure'/'pass' etc. are also accepted)");

export function buildStepSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		name: string;
		kind: "task" | "tool";
		input?: string;
		output?: string;
		status: "ok" | "error";
		error_message?: string;
		source_type?: "skill" | "sub_agent" | "mcp_server";
		source_name?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": args.kind === "tool" ? "execute_tool" : "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			...(args.kind === "tool" ? { "gen_ai.tool.name": args.name } : {}),
			...(args.source_type && args.source_name ? { "gen_ai.harness.source_type": args.source_type, "gen_ai.harness.source_name": args.source_name } : {}),
		},
		events: [
			...(args.input ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": args.input } }] : []),
			...(args.output ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": args.output } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "step failed" } } : {}),
	};
}

export function buildLlmCallSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		model: string;
		prompt?: string;
		completion?: string;
		input_tokens?: number;
		output_tokens?: number;
		cost_usd?: number;
		status: "ok" | "error";
		error_message?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	const total =
		args.input_tokens !== undefined || args.output_tokens !== undefined
			? (args.input_tokens ?? 0) + (args.output_tokens ?? 0)
			: undefined;
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: `chat ${args.model}`,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "chat",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			"gen_ai.request.model": args.model,
			"gen_ai.usage.input_tokens": args.input_tokens,
			"gen_ai.usage.output_tokens": args.output_tokens,
			"gen_ai.usage.total_tokens": total,
			"gen_ai.usage.cost": args.cost_usd,
		},
		events: [
			...(args.prompt ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": args.prompt } }] : []),
			...(args.completion ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": args.completion } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "llm call failed" } } : {}),
	};
}

export function buildExceptionSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	end: string,
	args: { message: string; type?: string; name?: string },
): SpanInput {
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name ?? "exception",
		startTimeUnixNano: end,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
		},
		error: { message: args.message, type: args.type },
	};
}

export function buildTrailServer(cfg: TrailConfig, judgeCfg: JudgeConfig | undefined): McpServer {
	const runs = new Map<string, Run>();

	function getRun(runId: string): Run {
		const run = runs.get(runId);
		if (!run) throw new Error(`Unknown run_id "${runId}" — call trail_start_run first.`);
		return run;
	}

	const server = new McpServer({ name: "trail", version: "0.2.0" });

	server.registerTool(
		"trail_start_run",
		{
			title: "Start a Trail run",
			description:
				"Begin a traced run in Trail. Returns a run_id to pass to the other trail_* tools. " +
				"Call once at the start of a coding task.",
			inputSchema: {
				name: z.string().describe("Short name of the task, e.g. 'fix flaky auth test'"),
				agent: z.string().optional().describe("Agent name shown in analytics (default: coding-agent)"),
			},
		},
		async ({ name, agent }) => {
			const runId = hexId(8);
			const rootDir = process.env.TRAIL_PROJECT_ROOT ?? process.cwd();
			runs.set(runId, {
				traceId: hexId(16),
				rootSpanId: hexId(8),
				name,
				agent: agent ?? cfg.serviceName,
				startNanos: nowNanos(),
				steps: 0,
				errors: 0,
				manifest: buildHarnessManifest(rootDir),
			});
			return ok(`run started: run_id=${runId}. Log steps with trail_log_step / trail_log_llm_call, finish with trail_finish_run.`);
		},
	);

	server.registerTool(
		"trail_log_step",
		{
			title: "Log a step",
			description:
				"Record one unit of work in the run — a task (planning, editing, running tests) or a tool call " +
				"(shell command, file read, search). Appears in the trace tree and Agent analytics.",
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
		},
		async ({ run_id, name, kind, input, output, status, error_message, duration_ms, source_type, source_name }) => {
			const run = getRun(run_id);
			const end = nowNanos();
			const start = duration_ms
				? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
				: end;
			const isError = status === "error";
			run.steps += 1;
			if (isError) run.errors += 1;
			await sendSpan(cfg, buildStepSpan(run, hexId(8), start, end, { name, kind, input, output, status, error_message, source_type, source_name }));
			return ok(`step logged (${kind}${isError ? ", error" : ""})`);
		},
	);

	server.registerTool(
		"trail_log_llm_call",
		{
			title: "Log an LLM call",
			description:
				"Record an LLM request made during the run, with prompt, completion, model, token usage and cost. " +
				"Feeds LLM analytics (tokens, cost) and the trace I/O panel.",
			inputSchema: {
				run_id: z.string(),
				model: z.string().describe("Model id, e.g. 'claude-sonnet-4-5' or 'gpt-4o-mini'"),
				prompt: z.string().optional(),
				completion: z.string().optional(),
				input_tokens: z.number().optional(),
				output_tokens: z.number().optional(),
				cost_usd: z.number().optional(),
				duration_ms: z.number().optional(),
				status: statusSchema,
				error_message: z.string().optional(),
			},
		},
		async ({ run_id, model, prompt, completion, input_tokens, output_tokens, cost_usd, duration_ms, status, error_message }) => {
			const run = getRun(run_id);
			const end = nowNanos();
			const start = duration_ms
				? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
				: end;
			const isError = status === "error";
			run.steps += 1;
			if (isError) run.errors += 1;
			await sendSpan(cfg, buildLlmCallSpan(run, hexId(8), start, end, { model, prompt, completion, input_tokens, output_tokens, cost_usd, status, error_message }));
			return ok(`llm call logged (${model}${isError ? ", error" : ""})`);
		},
	);

	server.registerTool(
		"trail_log_exception",
		{
			title: "Log an exception",
			description:
				"Record a failure in the run — build break, test failure, unhandled error. " +
				"Shows under Observations → Exceptions with the message and type.",
			inputSchema: {
				run_id: z.string(),
				message: z.string(),
				type: z.string().optional().describe("e.g. 'BuildError', 'TestFailure'"),
				name: z.string().optional().describe("Span name (default 'exception')"),
			},
		},
		async ({ run_id, message, type, name }) => {
			const run = getRun(run_id);
			run.steps += 1;
			run.errors += 1;
			const end = nowNanos();
			await sendSpan(cfg, buildExceptionSpan(run, hexId(8), end, { message, type, name }));
			return ok("exception logged");
		},
	);

	server.registerTool(
		"trail_finish_run",
		{
			title: "Finish the run",
			description:
				"Close the run and emit the root agent span with total duration. Call once when the task is done.",
			inputSchema: {
				run_id: z.string(),
				status: statusSchema,
				summary: z.string().optional().describe("One-line outcome, shown as the run's output"),
			},
		},
		async ({ run_id, status, summary }) => {
			const run = getRun(run_id);
			let verdict: Verdict | null = null;
			if (judgeCfg && summary && run.name) {
				const evidence = `Steps: ${run.steps}, errors: ${run.errors}`;
				const outcomeWithStatus = `${summary}\nAgent-reported status: ${status}`;
				verdict = await judgeGoalAttainment(run.name, outcomeWithStatus, evidence, judgeCfg);
			}
			await sendSpan(cfg, {
				traceId: run.traceId,
				spanId: run.rootSpanId,
				name: run.name,
				startTimeUnixNano: run.startNanos,
				endTimeUnixNano: nowNanos(),
				attributes: {
					"gen_ai.operation.name": "agent",
					"gen_ai.system": "trail-mcp",
					"gen_ai.agent.name": run.agent,
					"gen_ai.agent.goal": run.name,
					"gen_ai.agent.harness_manifest": JSON.stringify(run.manifest),
					...(verdict
						? {
								"gen_ai.agent.verdict": verdict.verdict,
								"gen_ai.agent.verdict_score": verdict.score,
								"gen_ai.agent.verdict_narrative": verdict.narrative,
							}
						: {}),
				},
				events: summary
					? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": summary } }]
					: [],
				...(status === "error" ? { error: { message: summary ?? "run failed" } } : {}),
			});
			runs.delete(run_id);
			return ok(`run finished: ${run.steps} steps, ${run.errors} errors — view it in Observations → Tracing`);
		},
	);

	return server;
}
```

Replace the entire contents of `mcp/src/index.ts` with:

```ts
#!/usr/bin/env node
/**
 * Trail MCP server — lets coding agents (Claude Code, Cursor, Windsurf, …)
 * stream their work into Trail as traces.
 *
 * The agent authenticates with a Trail API key pair (env vars) and calls
 * these tools; each call becomes a span with Trail's gen_ai.* semantics, so
 * runs appear in Observations → Tracing (full tree), errors in Exceptions,
 * and agent/tool rollups in Analytics → Agents — no UI changes required.
 *
 * Tools:
 *   trail_start_run      begin a run (returns run_id)
 *   trail_log_step       record a task or tool step
 *   trail_log_llm_call   record an LLM call with prompt/completion + usage
 *   trail_log_exception  record a failure (shows in Exceptions)
 *   trail_finish_run     close the run (emits the root agent span)
 *
 * Server construction (state, tool registration, the pure span-building
 * functions) lives in tools.ts, kept separate so it can be imported by
 * tests without this file's stdio transport connection running.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TrailConfig } from "./otlp.js";
import { JudgeConfig } from "./judge.js";
import { buildTrailServer } from "./tools.js";

const DEFAULT_LOCAL_URL = "http://127.0.0.1:4319";

const cfg: TrailConfig = {
	url: process.env.TRAIL_URL ?? DEFAULT_LOCAL_URL,
	publicKey: process.env.TRAIL_PUBLIC_KEY,
	secretKey: process.env.TRAIL_SECRET_KEY,
	environment: process.env.TRAIL_ENV ?? "default",
	serviceName: process.env.TRAIL_APP ?? "coding-agent",
};

const judgeCfg: JudgeConfig | undefined =
	process.env.TRAIL_JUDGE_PROVIDER && process.env.TRAIL_JUDGE_API_KEY
		? {
				provider: process.env.TRAIL_JUDGE_PROVIDER,
				apiKey: process.env.TRAIL_JUDGE_API_KEY,
				model: process.env.TRAIL_JUDGE_MODEL,
				baseUrl: process.env.TRAIL_JUDGE_BASE_URL,
			}
		: undefined;

const server = buildTrailServer(cfg, judgeCfg);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("trail-mcp ready (stdio)");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/*.js`
Expected: PASS — all of `judge.test.js`, `manifest.test.js`, `otlp.test.js`, `sanitize.test.js`, `tools.test.js` (the full suite, confirming the refactor didn't break `judge`/`manifest`, which are untouched).

- [ ] **Step 5: Commit**

```bash
cd mcp && git add src/tools.ts src/index.ts test/tools.test.js
git commit -m "refactor(mcp): extract testable server core into tools.ts"
```

---

### Task 4: `trail_log_step` structured `input`/`output`

**Files:**
- Modify: `mcp/src/tools.ts` (`buildStepSpan` function and `trail_log_step`'s `inputSchema`/handler)
- Test: `mcp/test/tools.test.js`

**Interfaces:**
- Consumes: `sanitize` from `./sanitize.js` (Task 1).
- Produces: `buildStepSpan`'s `args.input`/`args.output` become `unknown` instead of `string`.

- [ ] **Step 1: Write the failing tests**

Add to `mcp/test/tools.test.js`'s `describe("buildStepSpan", ...)` block:

```js
	test("structured object input/output are JSON-encoded into the prompt/completion events", () => {
		const span = buildStepSpan(RUN, "s8", "1000000000", "2000000000", {
			name: "edit auth.py", kind: "tool", status: "ok",
			input: { file: "auth.py", find: "old", replace: "new" },
			output: { ok: true, linesChanged: 3 },
		});
		assert.deepEqual(span.events, [
			{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify({ file: "auth.py", find: "old", replace: "new" }) } },
			{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify({ ok: true, linesChanged: 3 }) } },
		]);
	});

	test("a secret-shaped string inside a structured input is redacted before encoding", () => {
		const span = buildStepSpan(RUN, "s9", "1000000000", "2000000000", {
			name: "call api", kind: "tool", status: "ok",
			input: { headers: { Authorization: "Bearer abcxyz1234567890" } },
		});
		const decoded = JSON.parse(span.events[0].attributes["gen_ai.prompt"]);
		assert.equal(decoded.headers.Authorization, "[REDACTED]");
	});

	test("falsy-but-present values (0, false, empty string) still produce an event, not get dropped", () => {
		const span = buildStepSpan(RUN, "s10", "1000000000", "2000000000", { name: "check exit code", kind: "tool", status: "ok", output: 0 });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": "0" } }]);
	});

	test("absent input/output produces no io events", () => {
		const span = buildStepSpan(RUN, "s11", "1000000000", "2000000000", { name: "plan", kind: "task", status: "ok" });
		assert.deepEqual(span.events, []);
	});
```

Also update the first test in that block (from Task 3) — it currently asserts a plain-string event shape that's about to change encoding. Replace:

```js
	test("sets gen_ai.tool.name and prompt/completion events for a successful tool step", () => {
		const span = buildStepSpan(RUN, "s1", "1000000000", "2000000000", {
			name: "run pytest", kind: "tool", input: "pytest -x", output: "1 failed", status: "ok",
		});
		assert.equal(span.attributes["gen_ai.tool.name"], "run pytest");
		assert.deepEqual(span.events, [
			{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": "pytest -x" } },
			{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": "1 failed" } },
		]);
		assert.equal(span.error, undefined);
	});
```
with:
```js
	test("sets gen_ai.tool.name and JSON-encodes string prompt/completion events for a successful tool step", () => {
		const span = buildStepSpan(RUN, "s1", "1000000000", "2000000000", {
			name: "run pytest", kind: "tool", input: "pytest -x", output: "1 failed", status: "ok",
		});
		assert.equal(span.attributes["gen_ai.tool.name"], "run pytest");
		assert.deepEqual(span.events, [
			{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify("pytest -x") } },
			{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify("1 failed") } },
		]);
		assert.equal(span.error, undefined);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: FAIL — events still hold raw strings, not JSON-encoded ones; the falsy-value test fails because `output: 0` is currently dropped by the truthy check.

- [ ] **Step 3: Write the implementation**

In `mcp/src/tools.ts`, add the import at the top:

```ts
import { sanitize } from "./sanitize.js";
```

Change `buildStepSpan`'s signature and body from:

```ts
export function buildStepSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		name: string;
		kind: "task" | "tool";
		input?: string;
		output?: string;
		status: "ok" | "error";
		error_message?: string;
		source_type?: "skill" | "sub_agent" | "mcp_server";
		source_name?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": args.kind === "tool" ? "execute_tool" : "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			...(args.kind === "tool" ? { "gen_ai.tool.name": args.name } : {}),
			...(args.source_type && args.source_name ? { "gen_ai.harness.source_type": args.source_type, "gen_ai.harness.source_name": args.source_name } : {}),
		},
		events: [
			...(args.input ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": args.input } }] : []),
			...(args.output ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": args.output } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "step failed" } } : {}),
	};
}
```

to:

```ts
export function buildStepSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		name: string;
		kind: "task" | "tool";
		input?: unknown;
		output?: unknown;
		status: "ok" | "error";
		error_message?: string;
		source_type?: "skill" | "sub_agent" | "mcp_server";
		source_name?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": args.kind === "tool" ? "execute_tool" : "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			...(args.kind === "tool" ? { "gen_ai.tool.name": args.name } : {}),
			...(args.source_type && args.source_name ? { "gen_ai.harness.source_type": args.source_type, "gen_ai.harness.source_name": args.source_name } : {}),
		},
		events: [
			...(args.input !== undefined ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify(sanitize(args.input)) } }] : []),
			...(args.output !== undefined ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify(sanitize(args.output)) } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "step failed" } } : {}),
	};
}
```

In the `trail_log_step` tool registration, change the schema fields:

```ts
				input: z.string().optional().describe("What went in (command, arguments, file path…)"),
				output: z.string().optional().describe("What came out (truncated result, diff summary…)"),
```
to:
```ts
				input: z.unknown().optional().describe("What went in — any JSON-serializable value (object, array, string, number…)"),
				output: z.unknown().optional().describe("What came out — any JSON-serializable value (object, array, string, number…)"),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd mcp && git add src/tools.ts test/tools.test.js
git commit -m "feat(mcp): accept structured input/output on trail_log_step"
```

---

### Task 5: `trail_log_llm_call` structured `messages`/`completion`

**Files:**
- Modify: `mcp/src/tools.ts` (`buildLlmCallSpan` function and `trail_log_llm_call`'s `inputSchema`/handler)
- Test: `mcp/test/tools.test.js`

**Interfaces:**
- Consumes: `sanitize` from `./sanitize.js`.
- Produces: `buildLlmCallSpan`'s `args.prompt?: string` becomes `args.messages?: {role, content}[]`; `args.completion?: string` becomes `args.completion?: {role: "assistant", content, tool_calls?}`.

- [ ] **Step 1: Write the failing tests**

Add to `mcp/test/tools.test.js`'s `describe("buildLlmCallSpan", ...)` block:

```js
	test("JSON-encodes a messages array into the prompt event", () => {
		const messages = [{ role: "system", content: "be helpful" }, { role: "user", content: "fix the bug" }];
		const span = buildLlmCallSpan(RUN, "s12", "1000000000", "2000000000", { model: "gpt-4o-mini", messages, status: "ok" });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify(messages) } }]);
	});

	test("JSON-encodes the completion message object into the completion event", () => {
		const completion = { role: "assistant", content: "done" };
		const span = buildLlmCallSpan(RUN, "s13", "1000000000", "2000000000", { model: "gpt-4o-mini", completion, status: "ok" });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify(completion) } }]);
	});

	test("preserves tool_calls on the completion message", () => {
		const completion = { role: "assistant", content: "", tool_calls: [{ name: "read_file", args: { path: "a.py" } }] };
		const span = buildLlmCallSpan(RUN, "s14", "1000000000", "2000000000", { model: "gpt-4o-mini", completion, status: "ok" });
		assert.deepEqual(JSON.parse(span.events[0].attributes["gen_ai.completion"]), completion);
	});

	test("redacts a secret-shaped string inside a message's content", () => {
		const messages = [{ role: "user", content: "my key is sk-abcdefghij1234567890" }];
		const span = buildLlmCallSpan(RUN, "s15", "1000000000", "2000000000", { model: "gpt-4o-mini", messages, status: "ok" });
		const decoded = JSON.parse(span.events[0].attributes["gen_ai.prompt"]);
		assert.equal(decoded[0].content, "my key is [REDACTED]");
	});

	test("an empty messages array produces no prompt event", () => {
		const span = buildLlmCallSpan(RUN, "s16", "1000000000", "2000000000", { model: "gpt-4o-mini", messages: [], status: "ok" });
		assert.deepEqual(span.events, []);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: FAIL — `buildLlmCallSpan` doesn't accept `messages`/object-`completion` args yet.

- [ ] **Step 3: Write the implementation**

In `mcp/src/tools.ts`, change `buildLlmCallSpan` from:

```ts
export function buildLlmCallSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		model: string;
		prompt?: string;
		completion?: string;
		input_tokens?: number;
		output_tokens?: number;
		cost_usd?: number;
		status: "ok" | "error";
		error_message?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	const total =
		args.input_tokens !== undefined || args.output_tokens !== undefined
			? (args.input_tokens ?? 0) + (args.output_tokens ?? 0)
			: undefined;
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: `chat ${args.model}`,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "chat",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			"gen_ai.request.model": args.model,
			"gen_ai.usage.input_tokens": args.input_tokens,
			"gen_ai.usage.output_tokens": args.output_tokens,
			"gen_ai.usage.total_tokens": total,
			"gen_ai.usage.cost": args.cost_usd,
		},
		events: [
			...(args.prompt ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": args.prompt } }] : []),
			...(args.completion ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": args.completion } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "llm call failed" } } : {}),
	};
}
```

to:

```ts
export interface LlmMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
}

export interface LlmCompletion {
	role: "assistant";
	content: string;
	tool_calls?: unknown;
}

export function buildLlmCallSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	start: string,
	end: string,
	args: {
		model: string;
		messages?: LlmMessage[];
		completion?: LlmCompletion;
		input_tokens?: number;
		output_tokens?: number;
		cost_usd?: number;
		status: "ok" | "error";
		error_message?: string;
	},
): SpanInput {
	const isError = args.status === "error";
	const total =
		args.input_tokens !== undefined || args.output_tokens !== undefined
			? (args.input_tokens ?? 0) + (args.output_tokens ?? 0)
			: undefined;
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: `chat ${args.model}`,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "chat",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
			"gen_ai.request.model": args.model,
			"gen_ai.usage.input_tokens": args.input_tokens,
			"gen_ai.usage.output_tokens": args.output_tokens,
			"gen_ai.usage.total_tokens": total,
			"gen_ai.usage.cost": args.cost_usd,
		},
		events: [
			...(args.messages && args.messages.length > 0 ? [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify(sanitize(args.messages)) } }] : []),
			...(args.completion !== undefined ? [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify(sanitize(args.completion)) } }] : []),
		],
		...(isError ? { error: { message: args.error_message ?? "llm call failed" } } : {}),
	};
}
```

In the `trail_log_llm_call` tool registration, change:

```ts
				prompt: z.string().optional(),
				completion: z.string().optional(),
```
to:
```ts
				messages: z.array(z.object({
					role: z.enum(["system", "user", "assistant", "tool"]),
					content: z.string(),
				})).optional().describe("The messages sent to the model"),
				completion: z.object({
					role: z.literal("assistant"),
					content: z.string(),
					tool_calls: z.unknown().optional(),
				}).optional().describe("The assistant's response message"),
```

And change the handler's destructuring and call from:
```ts
		async ({ run_id, model, prompt, completion, input_tokens, output_tokens, cost_usd, duration_ms, status, error_message }) => {
			const run = getRun(run_id);
			const end = nowNanos();
			const start = duration_ms
				? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
				: end;
			const isError = status === "error";
			run.steps += 1;
			if (isError) run.errors += 1;
			await sendSpan(cfg, buildLlmCallSpan(run, hexId(8), start, end, { model, prompt, completion, input_tokens, output_tokens, cost_usd, status, error_message }));
			return ok(`llm call logged (${model}${isError ? ", error" : ""})`);
		},
```
to:
```ts
		async ({ run_id, model, messages, completion, input_tokens, output_tokens, cost_usd, duration_ms, status, error_message }) => {
			const run = getRun(run_id);
			const end = nowNanos();
			const start = duration_ms
				? (BigInt(end) - BigInt(Math.round(duration_ms)) * 1_000_000n).toString()
				: end;
			const isError = status === "error";
			run.steps += 1;
			if (isError) run.errors += 1;
			await sendSpan(cfg, buildLlmCallSpan(run, hexId(8), start, end, { model, messages, completion, input_tokens, output_tokens, cost_usd, status, error_message }));
			return ok(`llm call logged (${model}${isError ? ", error" : ""})`);
		},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd mcp && git add src/tools.ts test/tools.test.js
git commit -m "feat(mcp): accept a structured messages array and completion object on trail_log_llm_call"
```

---

### Task 6: `trail_log_exception` `stack`/`context`

**Files:**
- Modify: `mcp/src/tools.ts` (`buildExceptionSpan` function and `trail_log_exception`'s `inputSchema`/handler)
- Test: `mcp/test/tools.test.js`

**Interfaces:**
- Consumes: `sanitize` from `./sanitize.js`; `SpanInput.error.stack` from Task 2.
- Produces: `buildExceptionSpan` gains `args.stack?: string` (passed through to `SpanInput.error.stack`) and `args.context?: unknown` (sanitized, JSON-encoded into a new `gen_ai.content.context` event).

- [ ] **Step 1: Write the failing tests**

Add to `mcp/test/tools.test.js`'s `describe("buildExceptionSpan", ...)` block:

```js
	test("passes stack through to error.stack", () => {
		const span = buildExceptionSpan(RUN, "s17", "2000000000", { message: "boom", stack: "Error: boom\n  at build.js:1:1" });
		assert.equal(span.error.stack, "Error: boom\n  at build.js:1:1");
	});

	test("JSON-encodes context into a gen_ai.content.context event", () => {
		const span = buildExceptionSpan(RUN, "s18", "2000000000", { message: "boom", context: { attempt: 3, file: "auth.py" } });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.context", attributes: { "gen_ai.context": JSON.stringify({ attempt: 3, file: "auth.py" }) } }]);
	});

	test("redacts a secret-shaped string inside context", () => {
		const span = buildExceptionSpan(RUN, "s19", "2000000000", { message: "boom", context: { env: "AKIAABCDEFGHIJKLMNOP" } });
		const decoded = JSON.parse(span.events[0].attributes["gen_ai.context"]);
		assert.equal(decoded.env, "[REDACTED]");
	});

	test("no context produces no events", () => {
		const span = buildExceptionSpan(RUN, "s20", "2000000000", { message: "boom" });
		assert.deepEqual(span.events, []);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: FAIL — `buildExceptionSpan` doesn't accept `stack`/`context` yet, and doesn't return an `events` array at all currently.

- [ ] **Step 3: Write the implementation**

In `mcp/src/tools.ts`, change `buildExceptionSpan` from:

```ts
export function buildExceptionSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	end: string,
	args: { message: string; type?: string; name?: string },
): SpanInput {
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name ?? "exception",
		startTimeUnixNano: end,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
		},
		error: { message: args.message, type: args.type },
	};
}
```

to:

```ts
export function buildExceptionSpan(
	run: Pick<Run, "traceId" | "rootSpanId" | "agent">,
	spanId: string,
	end: string,
	args: { message: string; type?: string; name?: string; stack?: string; context?: unknown },
): SpanInput {
	return {
		traceId: run.traceId,
		spanId,
		parentSpanId: run.rootSpanId,
		name: args.name ?? "exception",
		startTimeUnixNano: end,
		endTimeUnixNano: end,
		attributes: {
			"gen_ai.operation.name": "execute_task",
			"gen_ai.system": "trail-mcp",
			"gen_ai.agent.name": run.agent,
		},
		events: args.context !== undefined
			? [{ name: "gen_ai.content.context", attributes: { "gen_ai.context": JSON.stringify(sanitize(args.context)) } }]
			: [],
		error: { message: args.message, type: args.type, stack: args.stack },
	};
}
```

In the `trail_log_exception` tool registration, change:
```ts
			inputSchema: {
				run_id: z.string(),
				message: z.string(),
				type: z.string().optional().describe("e.g. 'BuildError', 'TestFailure'"),
				name: z.string().optional().describe("Span name (default 'exception')"),
			},
		},
		async ({ run_id, message, type, name }) => {
			const run = getRun(run_id);
			run.steps += 1;
			run.errors += 1;
			const end = nowNanos();
			await sendSpan(cfg, buildExceptionSpan(run, hexId(8), end, { message, type, name }));
			return ok("exception logged");
		},
```
to:
```ts
			inputSchema: {
				run_id: z.string(),
				message: z.string(),
				type: z.string().optional().describe("e.g. 'BuildError', 'TestFailure'"),
				name: z.string().optional().describe("Span name (default 'exception')"),
				stack: z.string().optional().describe("Stack trace, if available"),
				context: z.unknown().optional().describe("Structured context — relevant state, variables, or data at the time of failure"),
			},
		},
		async ({ run_id, message, type, name, stack, context }) => {
			const run = getRun(run_id);
			run.steps += 1;
			run.errors += 1;
			const end = nowNanos();
			await sendSpan(cfg, buildExceptionSpan(run, hexId(8), end, { message, type, name, stack, context }));
			return ok("exception logged");
		},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/*.js`
Expected: PASS — full `mcp/` suite green.

- [ ] **Step 5: Commit**

```bash
cd mcp && git add src/tools.ts test/tools.test.js
git commit -m "feat(mcp): accept stack trace and structured context on trail_log_exception"
```

---

### Task 7: `server/src/runs.ts` — decode structured io, surface stack/context

**Files:**
- Modify: `server/src/runs.ts:26` (`StepView.io` type), `server/src/runs.ts:158-170` (`buildStepIo`)
- Test: `server/test/runs.test.js`

**Interfaces:**
- Produces: `decodeIoValue(raw: string): string | unknown` (new, exported) — `JSON.parse`s a stored attribute value, falling back to the raw string on parse failure (legacy pre-Phase-1 data). `StepView.io` type widens from `[string, string][]` to `[string, string | unknown][]`.
- Consumes: nothing new — reads the same `gen_ai.content.prompt`/`gen_ai.content.completion`/`exception` events as before, plus the new `exception.stacktrace` attribute and `gen_ai.content.context` event from Tasks 2 and 6.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/runs.test.js`, a new fixture builder (place it alongside `stepSpan`/`llmCallSpan`):

```js
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
```

Add new tests inside `describe("getRun", ...)`, after the existing `"extracts prompt/completion events as io pairs..."` test:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/runs.test.js`
Expected: FAIL — structured `input`/`output` come back as raw JSON-encoded strings (e.g. `'{"file":"auth.py",...}'`) instead of decoded objects; `Stack`/`Context` io pairs aren't produced at all yet.

- [ ] **Step 3: Write the implementation**

In `server/src/runs.ts`, change line 26 from:
```ts
	io: [string, string][];
```
to:
```ts
	io: [string, string | unknown][];
```

Replace `buildStepIo` (lines 158-170), currently:

```ts
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
```

with:

```ts
/** Decodes a stored gen_ai.* string value: a Phase-1-or-later value is JSON.stringify'd structured
 * data (a string leaf always round-trips quoted, e.g. "hello", which distinguishes it from legacy
 * plain text that's never valid JSON on its own); a JSON.parse failure means it's a pre-Phase-1
 * plain string, passed through unchanged so already-ingested runs keep rendering as before. */
export function decodeIoValue(raw: string): string | unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function buildStepIo(events: { name: string; attributes: AttrMap }[]): [string, string | unknown][] {
	const io: [string, string | unknown][] = [];
	for (const e of events) {
		if (e.name === "gen_ai.content.prompt" && typeof e.attributes["gen_ai.prompt"] === "string") {
			io.push(["Input", decodeIoValue(e.attributes["gen_ai.prompt"] as string)]);
		} else if (e.name === "gen_ai.content.completion" && typeof e.attributes["gen_ai.completion"] === "string") {
			io.push(["Output", decodeIoValue(e.attributes["gen_ai.completion"] as string)]);
		} else if (e.name === "exception" && typeof e.attributes["exception.message"] === "string") {
			io.push(["Error", e.attributes["exception.message"] as string]);
			if (typeof e.attributes["exception.stacktrace"] === "string") {
				io.push(["Stack", e.attributes["exception.stacktrace"] as string]);
			}
		} else if (e.name === "gen_ai.content.context" && typeof e.attributes["gen_ai.context"] === "string") {
			io.push(["Context", decodeIoValue(e.attributes["gen_ai.context"] as string)]);
		}
	}
	return io;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/*.js`
Expected: PASS — full `server/` suite green (confirms nothing else reading `StepView.io` broke; `app.test.js`'s existing `io: [["Input", "pytest -x"], ["Output", "1 passed"]]` fixture in `makeRunData` still passes strings directly as `RunData`, bypassing `runs.ts` entirely, so it's unaffected by this task).

- [ ] **Step 5: Commit**

```bash
cd server && git add src/runs.ts test/runs.test.js
git commit -m "feat(server): decode structured step io, surface exception stack/context"
```

---

### Task 8: Flight Recorder inspector — collapsible JSON tree rendering

**Files:**
- Modify: `server/src/static/app.ts` (hoist `escapeHtml` to top-level; add `isMessageList`, `renderMessages`, `renderJsonNode`, `renderIoPair`; update `renderStepIO`)
- Modify: `server/src/templates/shell.ts:208-213` area (new CSS rules)
- Test: `server/test/app.test.js`

**Interfaces:**
- Produces: top-level (window-reachable, per the vm-harness convention this file already relies on) `renderIoPair(p: [string, string | unknown]): string`, `renderJsonNode(v: unknown): string`, `isMessageList(v: unknown): boolean`, `renderMessages(msgs): string`, and a hoisted top-level `escapeHtml(s: string): string`.
- Consumes: `StepView.io`'s widened type from Task 7 (picked up automatically via `RunData = import("../runs.js").RunView & {...}`).

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `server/test/app.test.js`, after the closing of `describe("mountDetailPanel", ...)`:

```js
describe("renderIoPair / JSON tree rendering", () => {
	test("a string io value renders exactly as plain escaped text (unchanged from before)", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Input", "pytest -x"]);
		assert.equal(html, '<div class="io-kind">Input</div><div class="io-block">pytest -x</div>');
	});

	test("an object io value renders as a collapsible JSON tree with escaped keys/values", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Input", { file: "auth.py", ok: true }]);
		assert.match(html, /<div class="io-kind">Input<\/div>/);
		assert.match(html, /class="io-json"/);
		assert.match(html, /class="jv-key">file</);
		assert.match(html, /class="jv-str">"auth\.py"/);
		assert.match(html, /class="jv-scalar">true/);
	});

	test("a messages array io value renders as a role-labeled list, not generic JSON", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Input", [{ role: "system", content: "be helpful" }, { role: "user", content: "hi" }]]);
		assert.match(html, /class="msg-role">system/);
		assert.match(html, /class="msg-role">user/);
		assert.doesNotMatch(html, /jv-node/);
	});

	test("HTML embedded in a structured string value is escaped, not injected", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Output", { note: "<script>alert(1)</script>" }]);
		assert.doesNotMatch(html, /<script>alert/);
		assert.match(html, /&lt;script&gt;/);
	});

	test("an empty object/array renders its punctuation, not an empty collapsible node", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.renderJsonNode({}), '<span class="jv-punct">{}</span>');
		assert.equal(sandbox.renderJsonNode([]), '<span class="jv-punct">[]</span>');
	});

	test("isMessageList rejects a plain object and a non-role-shaped array", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.isMessageList({ file: "a.py" }), false);
		assert.equal(sandbox.isMessageList([1, 2, 3]), false);
		assert.equal(sandbox.isMessageList([]), false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: FAIL — `sandbox.renderIoPair is not a function` (doesn't exist yet).

- [ ] **Step 3: Write the implementation**

In `server/src/static/app.ts`, add these top-level functions right after the `TYPE_COLOR` constant (before the `VERDICT` constant, around line 39):

```ts
function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]); }

function isMessageList(v: unknown): v is { role: string; content: string }[] {
	return Array.isArray(v) && v.length > 0 && v.every((m) => m !== null && typeof m === "object" && typeof (m as Record<string, unknown>).role === "string" && typeof (m as Record<string, unknown>).content === "string");
}

function renderMessages(msgs: { role: string; content: string }[]): string {
	return msgs.map((m) => '<details class="msg-row" open><summary class="msg-role">' + escapeHtml(m.role) + '</summary><div class="io-block">' + escapeHtml(m.content) + "</div></details>").join("");
}

function renderJsonNode(v: unknown): string {
	if (v === null) return '<span class="jv-null">null</span>';
	if (typeof v === "string") return '<span class="jv-str">"' + escapeHtml(v) + '"</span>';
	if (typeof v === "number" || typeof v === "boolean") return '<span class="jv-scalar">' + String(v) + "</span>";
	if (Array.isArray(v)) {
		if (!v.length) return '<span class="jv-punct">[]</span>';
		const rows = v.map((item, idx) => '<div class="jv-row"><span class="jv-key">' + idx + '</span>' + renderJsonNode(item) + "</div>").join("");
		return '<details class="jv-node" open><summary>Array(' + v.length + ")</summary><div class=\"jv-children\">" + rows + "</div></details>";
	}
	if (typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>);
		if (!entries.length) return '<span class="jv-punct">{}</span>';
		const rows = entries.map(([k, val]) => '<div class="jv-row"><span class="jv-key">' + escapeHtml(k) + '</span>' + renderJsonNode(val) + "</div>").join("");
		return '<details class="jv-node" open><summary>Object</summary><div class="jv-children">' + rows + "</div></details>";
	}
	return '<span class="jv-punct">' + escapeHtml(String(v)) + "</span>";
}

function renderIoPair(p: [string, string | unknown]): string {
	const [label, value] = p;
	const body =
		typeof value === "string" ? '<div class="io-block">' + escapeHtml(value) + "</div>"
		: isMessageList(value) ? renderMessages(value)
		: '<div class="io-json">' + renderJsonNode(value) + "</div>";
	return '<div class="io-kind">' + escapeHtml(label) + "</div>" + body;
}
```

Remove the now-redundant inner declaration inside `mountDetailPanel` (currently around line 70):
```ts
		function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]); }
```
Delete this line entirely — every call site inside `mountDetailPanel` now resolves `escapeHtml` to the top-level function via normal lexical scoping.

Change `renderStepIO` (around line 230) from:
```ts
		if (s.io && s.io.length) inner += s.io.map((p) => '<div class="io-kind">' + escapeHtml(p[0]) + '</div><div class="io-block">' + escapeHtml(p[1]) + "</div>").join("");
```
to:
```ts
		if (s.io && s.io.length) inner += s.io.map((p) => renderIoPair(p)).join("");
```

In `server/src/templates/shell.ts`, add these rules immediately after the existing `.io-sig svg { ... }` / `.io-sig .st { ... }` rules (around line 213):

```css
	.io-json { background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; overflow-x: auto; }
	.jv-node > summary { cursor: pointer; color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
	.jv-children { margin: 4px 0 0 14px; border-left: 1px solid var(--line); padding-left: 10px; }
	.jv-row { margin: 2px 0; }
	.jv-key { color: var(--ink-3); margin-right: 6px; }
	.jv-str { color: var(--ink); }
	.jv-scalar { color: var(--ink-2); }
	.jv-null { color: var(--ink-3); font-style: italic; }
	.jv-punct { color: var(--ink-3); }
	.msg-row { border: 1px solid var(--line); border-radius: 9px; margin-bottom: 8px; overflow: hidden; }
	.msg-row > summary { cursor: pointer; padding: 6px 12px; background: var(--panel-2); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
	.msg-row .io-block { border: none; border-radius: 0; border-top: 1px solid var(--line); }
```

(These reuse the file's existing theme custom properties — `--panel-2`, `--line`, `--mono`, `--ink`/`--ink-2`/`--ink-3` — so they adapt to light/dark automatically, the same way `.io-block` already does; no new `@media`/`[data-theme]` blocks are needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/*.js`
Expected: PASS — full `server/` suite green.

- [ ] **Step 5: Commit**

```bash
cd server && git add src/static/app.ts src/templates/shell.ts test/app.test.js
git commit -m "feat(server): render structured step io as a collapsible JSON tree"
```

---

### Task 9: Version bump, README migration note, final verification

**Files:**
- Modify: `mcp/package.json`, `mcp/src/tools.ts` (McpServer version literal), `mcp/src/otlp.ts` (scope/User-Agent version literals), `mcp/test/otlp.test.js` (matching assertion), `mcp/README.md`

**Interfaces:** none (packaging/docs only).

- [ ] **Step 1: Bump version literals**

In `mcp/package.json`, change:
```json
  "version": "0.2.0",
```
to:
```json
  "version": "0.3.0",
```
(Minor bump, not major: the package is pre-1.0, and semver's convention for pre-1.0 packages treats a breaking change as a minor bump, not a major one — `0.2.0` → `0.3.0`, not `1.0.0`.)

In `mcp/src/tools.ts`, change:
```ts
	const server = new McpServer({ name: "trail", version: "0.2.0" });
```
to:
```ts
	const server = new McpServer({ name: "trail", version: "0.3.0" });
```

In `mcp/src/otlp.ts`, change line 95:
```ts
						scope: { name: "trail-mcp", version: "0.2.0" },
```
to:
```ts
						scope: { name: "trail-mcp", version: "0.3.0" },
```
and line 128:
```ts
			"User-Agent": "trail-mcp/0.2.0",
```
to:
```ts
			"User-Agent": "trail-mcp/0.3.0",
```

In `mcp/test/otlp.test.js`, update the existing assertion (in `"still sends Content-Type and User-Agent headers in local mode"`):
```js
			assert.equal(capturedHeaders["User-Agent"], "trail-mcp/0.2.0");
```
to:
```js
			assert.equal(capturedHeaders["User-Agent"], "trail-mcp/0.3.0");
```

- [ ] **Step 2: Run the full mcp/ suite to confirm the version-string update didn't break anything**

Run: `cd mcp && npm run build && node --test test/*.js`
Expected: PASS

- [ ] **Step 3: Add a migration note to `mcp/README.md`**

Insert a new section into `mcp/README.md` immediately before the existing `## Notes` section (currently at line 103):

```markdown
## Migrating from 0.2.x to 0.3.0

This is a breaking change to three tool schemas — a caller still passing the
old string-shaped fields will fail MCP schema validation.

- `trail_log_step`: `input`/`output` now accept any JSON-serializable value
  (object, array, string, number…) instead of only a string. Structured
  values are more useful than a pre-truncated summary string — pass the
  actual tool-call arguments/result object.
- `trail_log_llm_call`: `prompt` (a string) is now `messages` — an array of
  `{ role: "system" | "user" | "assistant" | "tool", content: string }`.
  `completion` (a string) is now a single message object:
  `{ role: "assistant", content: string, tool_calls?: unknown }`.
- `trail_log_exception` gains two new optional fields: `stack` (a string)
  and `context` (any JSON-serializable value — relevant state/variables at
  the time of failure).

All structured values passed to these three tools are redacted (best-effort
pattern matching for common secret shapes — API keys, bearer tokens,
password/token-shaped key-value pairs — never a guarantee) and truncated
(each string value inside the structure is capped at 16KB) before being
sent, entirely on the client side; the server stores and renders whatever
it receives, unmodified. Already-recorded runs from 0.2.x keep rendering
exactly as they did before — nothing is migrated or rewritten.
```

- [ ] **Step 4: Full-repo verification**

Run, in order:
```bash
cd mcp && npm run build && npm test
cd ../server && npm run build && npm test
```
Expected: both PASS in full.

- [ ] **Step 5: Commit**

```bash
cd mcp && git add package.json src/tools.ts src/otlp.ts test/otlp.test.js README.md
git commit -m "chore(mcp): bump to 0.3.0 for the structured-data breaking change, document migration"
```

---

## Plan Self-Review Notes

- **Spec coverage:** §3.1 (schema changes) → Tasks 4-6. §3.2 (sanitize) → Task 1. §3.3 (wire encoding, exception.stacktrace) → Tasks 2, 6. §3.4 (server read/decode, backward compat) → Task 7. §3.5 (UI rendering) → Task 8. §3.6 (versioning) → Task 9. §3.7 (testing) → covered per-task; the buildTrailServer/tools.ts split (not itself in the spec) is called out in Task 3 as a testability prerequisite the spec's §3.7 implicitly requires.
- **Type consistency checked:** `buildStepSpan`/`buildLlmCallSpan`/`buildExceptionSpan` signatures introduced in Task 3 are amended (not renamed) in Tasks 4-6; `decodeIoValue`/`StepView.io` in Task 7 match `renderIoPair`'s `[string, string | unknown]` parameter in Task 8; `LlmMessage`/`LlmCompletion` interfaces introduced in Task 5 aren't reused elsewhere (no cross-task naming drift to check there).
- **No placeholders:** every step above shows literal before/after code, not a description of a change.
