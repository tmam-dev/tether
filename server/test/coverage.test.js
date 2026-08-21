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
