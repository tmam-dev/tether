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
		assert.doesNotMatch(html, /<select/);
	});

	test("shows a distinct message plus the run picker when a specific run wasn't found but others exist", () => {
		const html = renderHarnessPage(null, RUNS);
		assert.match(html, /wasn't found/);
		assert.doesNotMatch(html, /No runs yet/);
		assert.match(html, /<select id="runPicker"/);
		assert.match(html, /value="t1"/);
		assert.match(html, /value="t2"/);
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
