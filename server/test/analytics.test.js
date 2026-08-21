import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getUsage } from "../dist/analytics.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-analytics-test-"));
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

const ONE_SKILL_MANIFEST = JSON.stringify({
	schemaVersion: 2,
	skills: [{ name: "code-review", description: "reviews diffs", source: "project" }, { name: "deploy", description: "ships it", source: "project" }],
	subAgents: [],
	mcpServers: [],
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

describe("getUsage", () => {
	test("returns zeroed-out usage for an empty store", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			const usage = getUsage(db);
			assert.equal(usage.totalRuns, 0);
			assert.equal(usage.trackedRuns, 0);
			assert.deepEqual(usage.entries, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("aggregates usage across multiple runs, marking a never-used entry as dead weight", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			// Run 1: uses code-review twice, never touches deploy.
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g1", startNs: "1000000000000", endNs: "1010000000000", manifest: ONE_SKILL_MANIFEST }));
			insertSpan(db, attributedStep({ traceId: "t1", spanId: "s1", parentSpanId: "r1", name: "review", startNs: "1001000000000", endNs: "1002000000000", sourceType: "skill", sourceName: "code-review" }));
			insertSpan(db, attributedStep({ traceId: "t1", spanId: "s2", parentSpanId: "r1", name: "review again", startNs: "1003000000000", endNs: "1004000000000", sourceType: "skill", sourceName: "code-review" }));

			// Run 2: registers the same manifest, is untracked (no attributed step).
			insertSpan(db, rootSpan({ traceId: "t2", spanId: "r2", goal: "g2", startNs: "1020000000000", endNs: "1030000000000", manifest: ONE_SKILL_MANIFEST }));

			// Run 3: registers the same manifest, is tracked (uses code-review once), never uses deploy.
			insertSpan(db, rootSpan({ traceId: "t3", spanId: "r3", goal: "g3", startNs: "1040000000000", endNs: "1050000000000", manifest: ONE_SKILL_MANIFEST }));
			insertSpan(db, attributedStep({ traceId: "t3", spanId: "s3", parentSpanId: "r3", name: "review", startNs: "1041000000000", endNs: "1042000000000", sourceType: "skill", sourceName: "code-review" }));

			const usage = getUsage(db);
			assert.equal(usage.totalRuns, 3);
			assert.equal(usage.trackedRuns, 2); // t1 and t3; t2 has no attributed step

			const codeReview = usage.entries.find((e) => e.type === "skill" && e.name === "code-review");
			const deploy = usage.entries.find((e) => e.type === "skill" && e.name === "deploy");

			assert.equal(codeReview.registeredRuns, 3);
			assert.equal(codeReview.trackedRuns, 2);
			assert.equal(codeReview.usedRuns, 2);
			assert.equal(codeReview.totalUsedCount, 3); // 2 in t1 + 1 in t3
			assert.equal(codeReview.deadWeight, false);

			assert.equal(deploy.registeredRuns, 3);
			assert.equal(deploy.trackedRuns, 2);
			assert.equal(deploy.usedRuns, 0);
			assert.equal(deploy.totalUsedCount, 0);
			assert.equal(deploy.deadWeight, true);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("an entry with zero tracked runs is not dead weight -- there's no evidence either way", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g1", startNs: "1000000000000", endNs: "1010000000000", manifest: ONE_SKILL_MANIFEST }));
			const usage = getUsage(db);
			const codeReview = usage.entries.find((e) => e.type === "skill" && e.name === "code-review");
			assert.equal(codeReview.trackedRuns, 0);
			assert.equal(codeReview.deadWeight, false);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
