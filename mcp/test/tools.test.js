import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildStepSpan, buildLlmCallSpan, buildExceptionSpan } from "../dist/tools.js";

const RUN = { traceId: "t".repeat(32), rootSpanId: "r".repeat(16), agent: "coding-agent" };

describe("buildStepSpan", () => {
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
