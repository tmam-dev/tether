import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderAnalyticsBody } from "../dist/templates/analytics.js";

function entry(overrides = {}) {
	return { type: "skill", name: "code-review", registeredRuns: 3, trackedRuns: 2, usedRuns: 2, totalUsedCount: 3, deadWeight: false, ...overrides };
}

describe("renderAnalyticsBody", () => {
	test("shows an honest empty-state page when there are no runs at all", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] });
		assert.match(html, /No runs yet/);
	});

	test("shows a distinct message when runs exist but none report coverage tracking", () => {
		const html = renderAnalyticsBody({ totalRuns: 4, trackedRuns: 0, entries: [entry({ trackedRuns: 0, usedRuns: 0, totalUsedCount: 0, deadWeight: false })] });
		assert.match(html, /No runs have reported skill\/sub-agent\/MCP-server usage yet/);
	});

	test("shows a distinct message when tracked runs exist but nothing was ever registered", () => {
		const html = renderAnalyticsBody({ totalRuns: 2, trackedRuns: 2, entries: [] });
		assert.match(html, /No skills, sub-agents, or MCP servers have been registered by any run\./);
	});

	test("shows per-category empty messages when a category has zero entries", () => {
		const html = renderAnalyticsBody({ totalRuns: 2, trackedRuns: 2, entries: [entry()] });
		assert.match(html, /No sub-agents registered by any run\./);
		assert.match(html, /No MCP servers registered by any run\./);
	});

	test("renders an entry's usage counts and flags dead weight", () => {
		const html = renderAnalyticsBody({
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
		const html = renderAnalyticsBody({ totalRuns: 5, trackedRuns: 3, entries: [entry()] });
		assert.match(html, /2 run\(s\) have no coverage tracking/);
	});

	test("escapes an entry name", () => {
		const html = renderAnalyticsBody({ totalRuns: 1, trackedRuns: 1, entries: [entry({ name: "<script>alert(1)</script>" })] });
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("no longer renders its own <title> or topbar (that's the shell's job now)", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] });
		assert.doesNotMatch(html, /<title>/);
		assert.doesNotMatch(html, /class="topbar"/);
	});
});
