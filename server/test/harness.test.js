import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan } from "../dist/db.js";
import { getHarnessView } from "../dist/harness.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-harness-test-"));
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

function rootSpan({ traceId, spanId, goal, startNs, endNs, manifest }) {
	const attrs = { "gen_ai.agent.goal": goal, "gen_ai.agent.name": "coding-agent" };
	if (manifest !== undefined) attrs["gen_ai.agent.harness_manifest"] = manifest;
	const raw = { traceId, spanId, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events: [], status: { code: 1 } };
	return { traceId, spanId, parentSpanId: null, name: goal, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
}

const FULL_MANIFEST = JSON.stringify({
	schemaVersion: 2,
	skills: [{ name: "code-review", description: "reviews diffs for bugs", source: "project" }],
	subAgents: [{ name: "Explore", description: "fast read-only search", tools: ["Grep", "Glob", "Read"] }],
	mcpServers: [{ name: "context7" }],
});

describe("getHarnessView", () => {
	test("returns null when the database has no runs at all", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.equal(getHarnessView(db), null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("returns null for an unknown traceId even when other runs exist", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t1", spanId: "r1", goal: "g", startNs: "1000000000000", endNs: "1001000000000", manifest: FULL_MANIFEST }));
			assert.equal(getHarnessView(db, "nonexistent"), null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("reshapes a full manifest into skills/subAgents/mcpServers", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t2", spanId: "r2", goal: "fix the flaky auth test", startNs: "1000000000000", endNs: "1001000000000", manifest: FULL_MANIFEST }));
			const view = getHarnessView(db, "t2");
			assert.equal(view.traceId, "t2");
			assert.equal(view.goal, "fix the flaky auth test");
			assert.equal(view.skills.length, 1);
			assert.deepEqual(view.skills[0], { name: "code-review", description: "reviews diffs for bugs", source: "project" });
			assert.equal(view.subAgents.length, 1);
			assert.deepEqual(view.subAgents[0], { name: "Explore", description: "fast read-only search", tools: ["Grep", "Glob", "Read"] });
			assert.equal(view.mcpServers.length, 1);
			assert.deepEqual(view.mcpServers[0], { name: "context7" });
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to empty categories (not null, not a throw) when the manifest attribute is missing", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t3", spanId: "r3", goal: "g", startNs: "1000000000000", endNs: "1001000000000" }));
			const view = getHarnessView(db, "t3");
			assert.notEqual(view, null);
			assert.deepEqual(view.skills, []);
			assert.deepEqual(view.subAgents, []);
			assert.deepEqual(view.mcpServers, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to empty categories when the manifest attribute is malformed JSON", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "t4", spanId: "r4", goal: "g", startNs: "1000000000000", endNs: "1001000000000", manifest: "{not valid json" }));
			const view = getHarnessView(db, "t4");
			assert.deepEqual(view.skills, []);
			assert.deepEqual(view.subAgents, []);
			assert.deepEqual(view.mcpServers, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to empty categories when a category entry has the wrong shape", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			const badManifest = JSON.stringify({ schemaVersion: 2, skills: [{ name: "ok but no description" }], subAgents: "not an array", mcpServers: [{ name: 123 }] });
			insertSpan(db, rootSpan({ traceId: "t5", spanId: "r5", goal: "g", startNs: "1000000000000", endNs: "1001000000000", manifest: badManifest }));
			const view = getHarnessView(db, "t5");
			assert.deepEqual(view.skills, []);
			assert.deepEqual(view.subAgents, []);
			assert.deepEqual(view.mcpServers, []);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("degrades to an empty startedAt (not a crash) when the timestamp is outside Date's valid range", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "huge", spanId: "r8", goal: "g", startNs: "99999999999999999999999", endNs: "99999999999999999999999" }));
			const view = getHarnessView(db, "huge");
			assert.equal(view.startedAt, "");
			assert.deepEqual(view.skills, []);
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
				traceId: "t9",
				spanId: "r9",
				name: "fallback-name",
				startTimeUnixNano: "1000000000000",
				endTimeUnixNano: "1001000000000",
				attributes: [{ key: "gen_ai.agent.goal", value: { intValue: "42" } }],
				events: [],
				status: { code: 1 },
			};
			insertSpan(db, {
				traceId: "t9",
				spanId: "r9",
				parentSpanId: null,
				name: "fallback-name",
				startTimeUnixNano: "1000000000000",
				endTimeUnixNano: "1001000000000",
				raw: JSON.stringify(raw),
			});
			const view = getHarnessView(db, "t9");
			assert.equal(view.goal, "fallback-name");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("with no traceId, returns the most recently started run's manifest", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "older", spanId: "r6", goal: "older run", startNs: "1000000000000", endNs: "1001000000000", manifest: FULL_MANIFEST }));
			insertSpan(db, rootSpan({ traceId: "newer", spanId: "r7", goal: "newer run", startNs: "2000000000000", endNs: "2001000000000" }));
			const view = getHarnessView(db);
			assert.equal(view.traceId, "newer");
			assert.equal(view.goal, "newer run");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
