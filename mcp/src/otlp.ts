/**
 * Minimal OTLP/JSON emitter for Trail's SDK ingest endpoint.
 *
 * Trail's server accepts OTLP/JSON at POST {TRAIL_URL}/traces with
 * hex-encoded trace/span ids, authenticated via X-Public-Key / X-Secret-Key.
 * Spans carry the same gen_ai.* semantic conventions the Python SDK emits,
 * so everything an MCP client logs shows up in Tracing, Requests/Exceptions,
 * and Agent analytics with zero UI changes.
 */

import { randomBytes } from "node:crypto";

export interface TrailConfig {
	url: string;        // e.g. https://your-server/api/sdk/v1, or http://localhost:4319 for local mode
	publicKey?: string;
	secretKey?: string;
	environment: string;
	serviceName: string;
}

export type AttrValue = string | number | boolean;

export function hexId(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

export function nowNanos(): string {
	return (BigInt(Date.now()) * 1_000_000n).toString();
}

function toOtlpValue(v: AttrValue): Record<string, unknown> {
	if (typeof v === "boolean") return { boolValue: v };
	if (typeof v === "number") {
		return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
	}
	return { stringValue: v };
}

export function toAttributes(attrs: Record<string, AttrValue | undefined>) {
	return Object.entries(attrs)
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([key, v]) => ({ key, value: toOtlpValue(v as AttrValue) }));
}

export interface SpanEvent {
	name: string;
	attributes: Record<string, AttrValue | undefined>;
	timeUnixNano?: string;
}

export interface SpanInput {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Record<string, AttrValue | undefined>;
	events?: SpanEvent[];
	error?: { message: string; type?: string };
}

/** Build a complete OTLP/JSON ExportTraceServiceRequest for one span. */
export function buildPayload(cfg: TrailConfig, span: SpanInput) {
	const events = (span.events ?? []).map((e) => ({
		timeUnixNano: e.timeUnixNano ?? span.endTimeUnixNano,
		name: e.name,
		attributes: toAttributes(e.attributes),
	}));

	if (span.error) {
		events.push({
			timeUnixNano: span.endTimeUnixNano,
			name: "exception",
			attributes: toAttributes({
				"exception.type": span.error.type ?? "Error",
				"exception.message": span.error.message,
			}),
		});
	}

	return {
		resourceSpans: [
			{
				resource: {
					attributes: toAttributes({
						"service.name": cfg.serviceName,
						"deployment.environment": cfg.environment,
						"telemetry.sdk.name": "trail",
						"telemetry.sdk.language": "mcp",
					}),
				},
				scopeSpans: [
					{
						scope: { name: "trail-mcp", version: "0.1.0" },
						spans: [
							{
								traceId: span.traceId,
								spanId: span.spanId,
								...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
								name: span.name,
								kind: 1, // SPAN_KIND_INTERNAL
								startTimeUnixNano: span.startTimeUnixNano,
								endTimeUnixNano: span.endTimeUnixNano,
								attributes: toAttributes({
									"gen_ai.environment": cfg.environment,
									"gen_ai.application_name": cfg.serviceName,
									...span.attributes,
								}),
								events,
								status: span.error
									? { code: 2, message: span.error.message } // ERROR
									: { code: 1 },                             // OK
							},
						],
					},
				],
			},
		],
	};
}

export async function sendSpan(cfg: TrailConfig, span: SpanInput): Promise<void> {
	const res = await fetch(`${cfg.url.replace(/\/$/, "")}/traces`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "trail-mcp/0.1.0",
			...(cfg.publicKey ? { "X-Public-Key": cfg.publicKey } : {}),
			...(cfg.secretKey ? { "X-Secret-Key": cfg.secretKey } : {}),
		},
		body: JSON.stringify(buildPayload(cfg, span)),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Trail ingest failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}
}
