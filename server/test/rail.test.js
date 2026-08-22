import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime, renderRailBody } from "../dist/templates/rail.js";

function run(overrides = {}) {
	return { traceId: "t".repeat(32), goal: "do the thing", verdict: "met", dur: "10s", startedAt: "2026-08-22T10:00:00.000Z", ...overrides };
}

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-08-22T12:00:00.000Z");

	test("under a minute reads 'just now'", () => {
		assert.equal(formatRelativeTime("2026-08-22T11:59:45.000Z", now), "just now");
	});
	test("minutes ago", () => {
		assert.equal(formatRelativeTime("2026-08-22T11:55:00.000Z", now), "5m ago");
	});
	test("hours ago", () => {
		assert.equal(formatRelativeTime("2026-08-22T09:00:00.000Z", now), "3h ago");
	});
	test("days ago", () => {
		assert.equal(formatRelativeTime("2026-08-19T12:00:00.000Z", now), "3d ago");
	});
	test("30 days or more falls back to the plain date", () => {
		assert.equal(formatRelativeTime("2026-01-01T12:00:00.000Z", now), "2026-01-01");
	});
	test("a malformed timestamp never throws, returns the raw string", () => {
		assert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
	});
	test("a future timestamp (clock skew) falls back to the plain date, not a negative duration", () => {
		assert.equal(formatRelativeTime("2026-08-23T12:00:00.000Z", now), "2026-08-23");
	});
});

describe("renderRailBody", () => {
	test("an empty store shows an empty message", () => {
		assert.match(renderRailBody([], undefined, Date.now()), /No runs yet/);
	});

	test("marks the active run's row and not others", () => {
		const active = run({ traceId: "a".repeat(32), goal: "active one" });
		const other = run({ traceId: "b".repeat(32), goal: "other one" });
		const html = renderRailBody([active, other], "a".repeat(32), Date.now());
		const activeIdx = html.indexOf("active one");
		const otherIdx = html.indexOf("other one");
		const activeRowStart = html.lastIndexOf("<a", activeIdx);
		const otherRowStart = html.lastIndexOf("<a", otherIdx);
		assert.match(html.slice(activeRowStart, activeIdx), /rail-row-active/);
		assert.doesNotMatch(html.slice(otherRowStart, otherIdx), /rail-row-active/);
	});

	test("no run is marked active when activeTraceId is undefined", () => {
		const html = renderRailBody([run()], undefined, Date.now());
		assert.doesNotMatch(html, /rail-row-active/);
	});

	test("escapes an XSS goal", () => {
		const html = renderRailBody([run({ goal: "<script>alert(1)</script>" })], undefined, Date.now());
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("an unrecognized verdict falls back to the 'unjudged' dot color and label", () => {
		const html = renderRailBody([run({ verdict: "totally-bogus" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("a poisoned verdict of '__proto__' does not crash rendering via the prototype chain, and falls back to 'unjudged'", () => {
		const html = renderRailBody([run({ verdict: "__proto__" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("a poisoned verdict of 'constructor' does not crash rendering via the prototype chain, and falls back to 'unjudged'", () => {
		const html = renderRailBody([run({ verdict: "constructor" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("each row links to the run's detail page", () => {
		const html = renderRailBody([run({ traceId: "c".repeat(32) })], undefined, Date.now());
		assert.match(html, new RegExp(`href="/runs/${"c".repeat(32)}"`));
	});
});
