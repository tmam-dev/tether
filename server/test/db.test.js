import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan, countTraces } from "../dist/db.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-db-test-"));
	return join(dir, "test.sqlite");
}

const BASE_SPAN = {
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	parentSpanId: null,
	name: "test-span",
	startTimeUnixNano: "1000000000",
	endTimeUnixNano: "2000000000",
	raw: JSON.stringify({ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "test-span" }),
};

describe("openDatabase", () => {
	test("creates the spans table and returns a usable database on a fresh path", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.equal(countTraces(db), 0);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("is idempotent — opening the same path twice does not throw", () => {
		const dbPath = makeTempDbPath();
		const db1 = openDatabase(dbPath);
		db1.close();
		const db2 = openDatabase(dbPath);
		try {
			assert.equal(countTraces(db2), 0);
		} finally {
			db2.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});

describe("insertSpan / countTraces", () => {
	test("counts distinct traces, not total spans", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			insertSpan(db, { ...BASE_SPAN, spanId: "c".repeat(16), parentSpanId: "b".repeat(16), name: "child-span" });
			assert.equal(countTraces(db), 1);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("a second trace increments the count", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			insertSpan(db, { ...BASE_SPAN, traceId: "d".repeat(32), spanId: "e".repeat(16) });
			assert.equal(countTraces(db), 2);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("re-inserting the same traceId+spanId replaces the row instead of erroring", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			insertSpan(db, { ...BASE_SPAN, name: "updated-name" });
			const row = db.prepare("SELECT name FROM spans WHERE traceId = ? AND spanId = ?").get(BASE_SPAN.traceId, BASE_SPAN.spanId);
			assert.equal(row.name, "updated-name");
			assert.equal(countTraces(db), 1);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("stores a null parentSpanId correctly for a root span", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			const row = db.prepare("SELECT parentSpanId FROM spans WHERE traceId = ? AND spanId = ?").get(BASE_SPAN.traceId, BASE_SPAN.spanId);
			assert.equal(row.parentSpanId, null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
