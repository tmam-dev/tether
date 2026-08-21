/**
 * Tether's local HTTP server: accepts the same OTLP/JSON payload
 * mcp/src/otlp.ts sends, stores every span, and serves a run list page
 * plus a per-run Flight Recorder page. No auth -- binds 127.0.0.1 only
 * (see index.ts), nothing here checks headers.
 */

import { createServer, IncomingMessage, Server } from "node:http";
import type Database from "better-sqlite3";
import { insertSpan } from "./db.js";
import { getRun, listRuns } from "./runs.js";
import { renderFlightRecorderPage } from "./templates/flight-recorder.js";
import { renderRunListPage } from "./templates/run-list.js";

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	[key: string]: unknown;
}

function extractSpans(body: unknown): OtlpSpan[] {
	const spans: OtlpSpan[] = [];
	const resourceSpans = (body as { resourceSpans?: unknown[] })?.resourceSpans ?? [];
	for (const rs of resourceSpans) {
		const scopeSpans = (rs as { scopeSpans?: unknown[] })?.scopeSpans ?? [];
		for (const ss of scopeSpans) {
			const spanList = (ss as { spans?: OtlpSpan[] })?.spans ?? [];
			for (const span of spanList) spans.push(span);
		}
	}
	return spans;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

export function createTetherServer(db: Database.Database): Server {
	return createServer(async (req, res) => {
		if (req.method === "POST" && req.url === "/traces") {
			try {
				const bodyText = await readBody(req);
				const parsed = JSON.parse(bodyText);
				const spans = extractSpans(parsed);
				for (const span of spans) {
					insertSpan(db, {
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId ?? null,
						name: span.name,
						startTimeUnixNano: span.startTimeUnixNano,
						endTimeUnixNano: span.endTimeUnixNano,
						raw: JSON.stringify(span),
					});
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, spansIngested: spans.length }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
			}
			return;
		}

		if (req.method === "GET" && req.url === "/") {
			try {
				const page = renderRunListPage(listRuns(db, 50));
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(page);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
			}
			return;
		}

		if (req.method === "GET" && req.url?.startsWith("/runs/")) {
			const traceId = req.url.slice("/runs/".length);
			try {
				const run = getRun(db, traceId);
				if (!run) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "run not found" }));
					return;
				}
				const page = renderFlightRecorderPage(run);
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(page);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
			}
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});
}
