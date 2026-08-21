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
