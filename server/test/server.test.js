import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, countTraces } from "../dist/db.js";
import { createTetherServer } from "../dist/server.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-server-test-"));
	return join(dir, "test.sqlite");
}

async function withServer(fn) {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	const server = createTetherServer(db);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await fn({ db, port });
	} finally {
		await new Promise((resolve) => server.close(resolve));
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
}

function otlpPayload() {
	return {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
				scopeSpans: [
					{
						scope: { name: "test-scope", version: "0.1.0" },
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "b".repeat(16),
								name: "test-span",
								kind: 1,
								startTimeUnixNano: "1000000000",
								endTimeUnixNano: "2000000000",
								attributes: [],
								events: [],
								status: { code: 1 },
							},
						],
					},
				],
			},
		],
	};
}

describe("POST /traces", () => {
	test("ingests a valid OTLP payload and increments the trace count", async () => {
		await withServer(async ({ db, port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.ok, true);
			assert.equal(body.spansIngested, 1);
			assert.equal(countTraces(db), 1);
		});
	});

	test("ingests a payload with no auth headers at all (local mode)", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(res.status, 200);
		});
	});

	test("ingests multiple spans across scopeSpans in one request", async () => {
		await withServer(async ({ db, port }) => {
			const payload = otlpPayload();
			payload.resourceSpans[0].scopeSpans[0].spans.push({
				traceId: "a".repeat(32),
				spanId: "c".repeat(16),
				parentSpanId: "b".repeat(16),
				name: "child-span",
				kind: 1,
				startTimeUnixNano: "1100000000",
				endTimeUnixNano: "1900000000",
				attributes: [],
				events: [],
				status: { code: 1 },
			});
			const res = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = await res.json();
			assert.equal(body.spansIngested, 2);
			assert.equal(countTraces(db), 1);
		});
	});

	test("returns 400 (not a crash) for unparseable JSON, and the server keeps working afterward", async () => {
		await withServer(async ({ db, port }) => {
			const badRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not valid json{{{",
			});
			assert.equal(badRes.status, 400);

			const goodRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(goodRes.status, 200);
			assert.equal(countTraces(db), 1);
		});
	});

	test("returns 200 with spansIngested:0 for a payload missing resourceSpans (extraction degrades gracefully, does not throw)", async () => {
		await withServer(async ({ db, port }) => {
			const badRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ notResourceSpans: [] }),
			});
			assert.equal(badRes.status, 200);
			const body = await badRes.json();
			assert.equal(body.spansIngested, 0);

			const goodRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(goodRes.status, 200);
			assert.equal(countTraces(db), 1);
		});
	});
});

describe("GET /", () => {
	test("returns a page reporting zero runs before any ingestion", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /0 runs/);
		});
	});

	test("reflects the ingested trace count after a POST /traces", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, /1 run(?!s)/);
		});
	});
});

describe("unknown routes", () => {
	test("returns 404 for an unrecognized path", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET / error handling", () => {
	test("returns 500 (not a crash) when the database connection is closed", async () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		const server = createTetherServer(db);
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		try {
			db.close();

			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
			assert.equal(typeof body.error, "string");
		} finally {
			await new Promise((resolve) => server.close(resolve));
			try {
				db.close();
			} catch {
				// already closed above; better-sqlite3 throws on a double close
			}
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
