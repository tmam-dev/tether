/**
 * Tether's local HTTP server: accepts the same OTLP/JSON payload
 * mcp/src/otlp.ts sends, stores every span, and serves the unified shell
 * (run rail + a Detail/Harness/Analytics panel) plus the /fragments/* routes
 * its client router fetches for in-app navigation.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { insertSpan } from "./db.js";
import { getRun, listRuns } from "./runs.js";
import { getHarnessView } from "./harness.js";
import { getCoverage } from "./coverage.js";
import { getUsage } from "./analytics.js";
import { renderDetailFragment, renderEmptyDetailPanel } from "./templates/flight-recorder.js";
import { renderRailBody } from "./templates/rail.js";
import { renderHarnessBody } from "./templates/harness.js";
import { renderAnalyticsBody } from "./templates/analytics.js";
import { renderShell, renderNotFoundPanel } from "./templates/shell.js";
import type { ShellState, ShellView } from "./templates/shell.js";

const APP_JS = readFileSync(fileURLToPath(new URL("./static/app.js", import.meta.url)), "utf-8");

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

/** Writes a JSON error response. Guarded against being called after headers were already sent
 * (e.g. a render function threw AFTER a route's success-path writeHead already ran) -- a second
 * writeHead in that situation throws ERR_HTTP_HEADERS_SENT, which (being thrown from inside a
 * catch block in an async handler) becomes an unhandled rejection and crashes the whole process.
 * Every route below is written to compute its body into a local variable before its one and only
 * writeHead call specifically so this guard is never needed in practice -- it's a second line of
 * defense in case a future route reintroduces that bug. */
function sendError(res: ServerResponse, status: number, error: string): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: false, error }));
}

/** Decodes a traceId path segment for a /fragments/* route, writing a bare-JSON 400 (matching
 * every other error response a fragment endpoint gives) and returning null on a malformed one. */
function decodeTraceIdOr400(raw: string, res: ServerResponse): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		sendError(res, 400, "malformed traceId");
		return null;
	}
}

/** Decodes a traceId path segment for a full-page route, rendering a shell-wrapped error page on
 * a malformed one -- consistent with how these routes already give a well-formed-but-unknown
 * traceId a shell-wrapped 404, rather than decodeTraceIdOr400's bare JSON (which is correct only
 * for the /fragments/* routes, since those already return raw fragment bodies, not full pages). */
function decodeTraceIdOrShellError(raw: string, res: ServerResponse, db: Database.Database, view: ShellView): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		const body = renderShell({ view }, "Tether — Run not found", buildRail(db, undefined), renderNotFoundPanel());
		res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
		res.end(body);
		return null;
	}
}

/** The rail's inner HTML for the 50 most recent runs, with `active` highlighted -- the same
 * `renderRailBody(listRuns(db, 50), active, Date.now())` call several routes below need. */
function buildRail(db: Database.Database, active: string | undefined): string {
	return renderRailBody(listRuns(db, 50), active, Date.now());
}

export function createTetherServer(db: Database.Database): Server {
	return createServer(async (req, res) => {
		const pathname = (req.url ?? "").split("?")[0];

		if (req.method === "POST" && pathname === "/traces") {
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
				sendError(res, 400, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/app.js") {
			try {
				res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
				res.end(APP_JS);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/fragments/rail") {
			try {
				const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
				const active = query.get("active") ?? undefined;
				const body = buildRail(db, active);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/fragments/analytics") {
			try {
				const body = renderAnalyticsBody(getUsage(db));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/fragments/harness/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/fragments/harness/".length), res);
			if (traceId === null) return;
			try {
				const view = getHarnessView(db, traceId);
				if (!view) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderNotFoundPanel());
					return;
				}
				const body = renderHarnessBody(view);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		// No traceId -- resolves to the most recently started run, same as `/` itself does
		// server-side. Exists so the client router can fetch `/` client-side (see app.ts's
		// parsePathname("/")) instead of falling through to a full page reload on a Back
		// navigation to the landing page.
		if (req.method === "GET" && pathname === "/fragments/detail") {
			try {
				const traceId = listRuns(db, 50)[0]?.traceId ?? null;
				if (traceId === null) {
					const body = renderEmptyDetailPanel();
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}
				const run = getRun(db, traceId);
				if (!run) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderNotFoundPanel());
					return;
				}
				const body = renderDetailFragment(run, getCoverage(db, traceId));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname.startsWith("/fragments/detail/")) {
			const traceId = decodeTraceIdOr400(pathname.slice("/fragments/detail/".length), res);
			if (traceId === null) return;
			try {
				const run = getRun(db, traceId);
				if (!run) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(renderNotFoundPanel());
					return;
				}
				const body = renderDetailFragment(run, getCoverage(db, traceId));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const harnessPathMatch = pathname.match(/^\/runs\/([^/]+)\/harness$/);
		if (req.method === "GET" && harnessPathMatch) {
			const traceId = decodeTraceIdOrShellError(harnessPathMatch[1], res, db, "harness");
			if (traceId === null) return;
			try {
				const rail = buildRail(db, traceId);
				const view = getHarnessView(db, traceId);
				const state: ShellState = { view: "harness", traceId };
				if (!view) {
					const body = renderShell(state, "Tether — Run not found", rail, renderNotFoundPanel());
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}
				const body = renderShell(state, "Tether — Harness", rail, renderHarnessBody(view));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		const detailPathMatch = pathname.match(/^\/runs\/([^/]+)$/);
		if (req.method === "GET" && (pathname === "/" || detailPathMatch)) {
			try {
				const runs = listRuns(db, 50);
				let traceId: string | null;
				if (pathname === "/") {
					traceId = runs[0]?.traceId ?? null;
				} else {
					const decoded = decodeTraceIdOrShellError(detailPathMatch![1], res, db, "detail");
					if (decoded === null) return;
					traceId = decoded;
				}

				const rail = renderRailBody(runs, traceId ?? undefined, Date.now());
				if (traceId === null) {
					const body = renderShell({ view: "detail" }, "Tether", rail, renderEmptyDetailPanel());
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}

				const run = getRun(db, traceId);
				const state: ShellState = { view: "detail", traceId };
				if (!run) {
					const body = renderShell(state, "Tether — Run not found", rail, renderNotFoundPanel());
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(body);
					return;
				}
				const body = renderShell(state, `Tether — ${run.goal}`, rail, renderDetailFragment(run, getCoverage(db, traceId)));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		if (req.method === "GET" && pathname === "/analytics") {
			try {
				const rail = buildRail(db, undefined);
				const body = renderShell({ view: "analytics" }, "Tether — Analytics", rail, renderAnalyticsBody(getUsage(db)));
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
			} catch (err) {
				sendError(res, 500, (err as Error).message);
			}
			return;
		}

		sendError(res, 404, "not found");
	});
}
