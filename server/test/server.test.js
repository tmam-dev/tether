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

describe("GET /api/v1/runs/:traceId", () => {
	test("returns the run with coverage as JSON", async () => {
		await withServer(async ({ db, port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const traceId = "a".repeat(32);
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${traceId}`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "application/json");
			const body = await res.json();
			assert.equal(body.traceId, traceId);
			assert.ok("coverage" in body);
		});
	});

	test("404s with an error body for an unknown traceId", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});
});

describe("GET /api/v1/harness/:traceId", () => {
	test("404s for an unknown traceId", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/harness/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET /api/v1/analytics", () => {
	test("returns a UsageView shape on an empty store", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/analytics`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.totalRuns, 0);
			assert.deepEqual(body.entries, []);
		});
	});
});

describe("GET /app.js", () => {
	test("serves the client router as JavaScript", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/app.js`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
			const text = await res.text();
			assert.match(text, /function navigateTo/);
		});
	});
});

describe("GET /", () => {
	test("an empty store renders the shell with an empty rail and empty Detail panel", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /No runs yet/);
			assert.match(text, /tab-disabled/); // Harness tab disabled, nothing selected
		});
	});

	test("with runs, shows the most recent run's Detail panel and highlights it in the rail", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, /rail-row-active/);
			assert.match(text, /id="run-data"/);
		});
	});
});

describe("GET /runs/:traceId", () => {
	test("renders that run's Detail panel", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /id="run-data"/);
		});
	});

	test("an unknown traceId renders a shell-wrapped 404, not bare JSON", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			const text = await res.text();
			assert.match(text, /Run not found/);
			assert.match(text, /class="shell"/);
		});
	});
});

describe("GET /runs/:traceId/harness", () => {
	test("renders that run's harness panel with the Harness tab active", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}/harness`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /tab tab-active/);
		});
	});

	test("an unknown traceId renders a shell-wrapped 404", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"z".repeat(32)}/harness`);
			assert.equal(res.status, 404);
			assert.match(await res.text(), /Run not found/);
		});
	});
});

describe("GET /analytics", () => {
	test("renders the shell with the analytics panel and the Analytics tab active", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/analytics`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /No runs yet/);
			assert.match(text, /tab tab-active/);
		});
	});
});

describe("GET /harness (removed)", () => {
	test("the old bare route no longer exists", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/harness`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET /fragments/rail", () => {
	test("returns the rail's inner HTML with the active run marked", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/rail?active=${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			assert.match(await res.text(), /rail-row-active/);
		});
	});
});

describe("GET /fragments/analytics", () => {
	test("returns the analytics panel's inner HTML", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/analytics`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /No runs yet/);
		});
	});
});

describe("GET /fragments/harness/:traceId", () => {
	test("returns the harness panel's inner HTML for a real run", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/harness/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /Harness as of/);
		});
	});

	test("an unknown traceId returns a 404 fragment (not a shell page)", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/harness/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			const text = await res.text();
			assert.match(text, /Run not found/);
			assert.doesNotMatch(text, /class="shell"/);
		});
	});
});

describe("GET /fragments/detail/:traceId", () => {
	test("returns the detail panel's inner HTML for a real run", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail/${"a".repeat(32)}`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /id="run-data"/);
		});
	});

	test("an unknown traceId returns a 404 fragment", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			assert.doesNotMatch(await res.text(), /class="shell"/);
		});
	});
});

describe("unknown routes", () => {
	test("returns 404 for an unrecognized path", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/totally/unknown`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET / error handling", () => {
	test("returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 500);
		});
	});
});

// C2 regression: every route below computes its render output into a local variable BEFORE its
// writeHead call, so a render-time throw is caught inside the try and reported by sendError()
// as the FIRST header write for that response -- not a second one after writeHead(200, ...)
// already ran. A closed db makes listRuns()/getRun()/getUsage() throw, which is the same failure
// shape a poisoned verdict caused before C1 was fixed. Before the C2 fix, every route other than
// `GET /` wrote headers before evaluating its render expression, so this same test would have
// crashed the whole server process with ERR_HTTP_HEADERS_SENT instead of returning 500.
describe("error handling on routes beyond GET / (C2 regression)", () => {
	test("GET /fragments/rail returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/fragments/rail`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});

	test("GET /fragments/analytics returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/fragments/analytics`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});

	test("GET /runs/:traceId returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});

	test("GET /runs/:traceId/harness returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/runs/${"a".repeat(32)}/harness`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});

	test("GET /analytics returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/analytics`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});

	test("GET /fragments/detail returns 500 (not a crash) when the database connection is closed", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail`);
			assert.equal(res.status, 500);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});
});

describe("GET /fragments/detail (I2: server-side resolution of '/')", () => {
	test("an empty store returns the empty detail panel body", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /No runs yet/);
		});
	});

	test("with runs, returns the most recent run's detail fragment (matches GET / resolution)", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpPayload()) });
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail`);
			assert.equal(res.status, 200);
			assert.match(await res.text(), /id="run-data"/);
		});
	});
});

describe("malformed traceId (Minor 4)", () => {
	test("GET /runs/:traceId with a malformed traceId renders a shell-wrapped page, not bare JSON", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/%`);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			const text = await res.text();
			assert.match(text, /class="shell"/);
		});
	});

	test("GET /runs/:traceId/harness with a malformed traceId renders a shell-wrapped page, not bare JSON", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/runs/%/harness`);
			assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
			const text = await res.text();
			assert.match(text, /class="shell"/);
		});
	});

	test("GET /fragments/detail/:traceId with a malformed traceId still returns bare JSON", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/detail/%`);
			assert.equal(res.status, 400);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});

	test("GET /fragments/harness/:traceId with a malformed traceId still returns bare JSON", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/fragments/harness/%`);
			assert.equal(res.status, 400);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});
});

// Regression: decodeTraceIdOrShellError was called OUTSIDE this route's try block. Its own
// error-rendering path (for a malformed traceId) calls buildRail(db, undefined) -> listRuns(db,
// 50), which throws when the db is closed. A throw from before `try {` escapes the async handler
// as an unhandled promise rejection and crashes the whole process -- this test would have hung/
// crashed the whole `node --test` run against the pre-fix code instead of getting a response back.
describe("GET /runs/:traceId/harness with a malformed traceId and a closed db (route-handler regression)", () => {
	test("returns 500 (not a crash) and the server keeps working afterward", async () => {
		await withServer(async ({ port, db }) => {
			db.close();
			const res = await fetch(`http://127.0.0.1:${port}/runs/%/harness`);
			assert.equal(res.status, 500);

			// The process must still be alive to answer this second request at all.
			const followUp = await fetch(`http://127.0.0.1:${port}/runs/${"z".repeat(32)}/harness`);
			assert.equal(followUp.status, 500);
		});
	});
});

describe("live repro: poisoned verdict no longer crashes any route (C1 + C2 combined)", () => {
	test("ingesting a trace with verdict '__proto__' does not crash GET /, /fragments/rail, /fragments/detail, /analytics, or /runs/:traceId", async () => {
		await withServer(async ({ port }) => {
			const payload = otlpPayload();
			payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: "gen_ai.agent.verdict", value: { stringValue: "__proto__" } });
			const ingestRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			assert.equal(ingestRes.status, 200);

			for (const path of ["/", "/fragments/rail", "/fragments/detail", "/analytics", `/runs/${"a".repeat(32)}`, `/fragments/detail/${"a".repeat(32)}`]) {
				const res = await fetch(`http://127.0.0.1:${port}${path}`);
				assert.equal(res.status, 200, `${path} should render 200, not crash`);
			}
		});
	});
});
