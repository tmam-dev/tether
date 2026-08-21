/**
 * Reshapes stored OTLP-shaped spans into plain view objects a template can
 * read directly. Every function here degrades gracefully (null/[] on
 * anything unexpected) -- never throws, matching the rest of this codebase's
 * discovery/query functions.
 */

import type Database from "better-sqlite3";

export type StepType = "reason" | "read" | "edit" | "run" | "tool" | "llm" | "search";

export interface RetrySignal {
	kind: "retry";
	count: number;
	detail: string;
}

export interface StepView {
	type: StepType;
	title: string;
	status: "ok" | "err";
	start: number;
	dur: number;
	cost: number | null;
	tok: number | null;
	io: [string, string][];
	sig?: RetrySignal[];
	sourceType?: "skill" | "sub_agent" | "mcp_server";
	sourceName?: string;
}

export type Verdict = "met" | "partial" | "failed" | "unjudged";

export interface RunView {
	traceId: string;
	goal: string;
	agent: string;
	verdict: Verdict;
	score: number | null;
	narrative: string | null;
	totals: { dur: string; cost: number | null; tokens: number | null; steps: number };
	steps: StepView[];
}

export interface RunSummary {
	traceId: string;
	goal: string;
	verdict: Verdict;
	dur: string;
	startedAt: string;
}

interface StoredRow {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	raw: string;
}

type AttrMap = Record<string, string | number | boolean>;

export function toAttributeMap(attributes: { key: string; value: Record<string, unknown> }[] | undefined): AttrMap {
	const map: AttrMap = {};
	for (const attr of attributes ?? []) {
		const v = attr.value ?? {};
		if ("stringValue" in v) map[attr.key] = v.stringValue as string;
		else if ("intValue" in v) map[attr.key] = Number(v.intValue);
		else if ("doubleValue" in v) map[attr.key] = v.doubleValue as number;
		else if ("boolValue" in v) map[attr.key] = v.boolValue as boolean;
	}
	return map;
}

function inferStepType(attrs: AttrMap): StepType {
	if (attrs["gen_ai.operation.name"] === "chat") return "llm";
	const toolName = attrs["gen_ai.tool.name"];
	if (typeof toolName === "string") {
		const t = toolName.toLowerCase();
		if (/read|cat|view|open/.test(t)) return "read";
		if (/edit|write|str_replace|patch/.test(t)) return "edit";
		if (/run|exec|bash|test|build/.test(t)) return "run";
		if (/search|grep|find/.test(t)) return "search";
		return "tool";
	}
	return "reason";
}

/** Parses a nanosecond-timestamp string to a bigint, returning null (never throwing) on malformed input. */
function toNs(s: string): bigint | null {
	try {
		return BigInt(s);
	} catch {
		return null;
	}
}

// Date's valid range is +/-8.64e15ms from the epoch -- outside it, `new Date(ms).toISOString()`
// throws RangeError. Since these nanosecond timestamps arrive via unauthenticated, unvalidated
// ingest, an out-of-range value must degrade to "" rather than crash every route that lists runs.
const MAX_DATE_MS = 8.64e15;

/** Converts a nanosecond timestamp to an ISO string, degrading to "" (never throwing) if it's outside Date's valid range. */
export function toIsoOrEmpty(ns: bigint): string {
	const ms = Number(ns / 1_000_000n);
	if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return "";
	return new Date(ms).toISOString();
}

/** Returns v if it's a string, otherwise undefined -- guards against a non-string attribute value where a string is expected (attributes arrive from unauthenticated, unvalidated ingest, so gen_ai.agent.goal etc. can be any OTLP value type). */
export function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** Returns v if it's one of the three recognized source types, otherwise undefined -- an unrecognized value from unauthenticated ingest is treated the same as no attribution at all. */
function asSourceType(v: unknown): StepView["sourceType"] {
	return v === "skill" || v === "sub_agent" || v === "mcp_server" ? v : undefined;
}

function formatDuration(startNs: string, endNs: string): string {
	const start = toNs(startNs);
	const end = toNs(endNs);
	if (start === null || end === null) return "0s";
	const seconds = Math.max(0, Math.round(Number(end - start) / 1e9));
	if (seconds < 60) return seconds + "s";
	return Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
}

function parseRaw(raw: string): { attrs: AttrMap; events: { name: string; attributes: AttrMap }[]; errorCode: number } | null {
	try {
		const parsed = JSON.parse(raw) as {
			attributes?: { key: string; value: Record<string, unknown> }[];
			events?: { name: string; attributes?: { key: string; value: Record<string, unknown> }[] }[];
			status?: { code?: number };
		};
		return {
			attrs: toAttributeMap(parsed.attributes),
			events: (parsed.events ?? []).map((e) => ({ name: e.name, attributes: toAttributeMap(e.attributes) })),
			errorCode: parsed.status?.code ?? 1,
		};
	} catch {
		return null;
	}
}

function buildStepIo(events: { name: string; attributes: AttrMap }[]): [string, string][] {
	const io: [string, string][] = [];
	for (const e of events) {
		if (e.name === "gen_ai.content.prompt" && typeof e.attributes["gen_ai.prompt"] === "string") {
			io.push(["Input", e.attributes["gen_ai.prompt"] as string]);
		} else if (e.name === "gen_ai.content.completion" && typeof e.attributes["gen_ai.completion"] === "string") {
			io.push(["Output", e.attributes["gen_ai.completion"] as string]);
		} else if (e.name === "exception" && typeof e.attributes["exception.message"] === "string") {
			io.push(["Error", e.attributes["exception.message"] as string]);
		}
	}
	return io;
}

const MIN_RETRY_RUN = 3;

function detectRetries(steps: StepView[]): void {
	let i = 0;
	while (i < steps.length) {
		let j = i;
		while (j < steps.length && steps[j].status === "err" && steps[j].title === steps[i].title) j++;
		const runLength = j - i;
		if (runLength >= MIN_RETRY_RUN) {
			for (let k = i + 1; k < j; k++) {
				const count = k - i + 1;
				steps[k].sig = [{ kind: "retry", count, detail: `Attempt ${count} of "${steps[i].title}" — same failure as before.` }];
			}
		}
		i = j > i ? j : i + 1;
	}
}

/** Reshapes one trace's stored spans into a RunView. Returns null if no root span (parentSpanId IS NULL) is found for traceId. */
export function getRun(db: Database.Database, traceId: string): RunView | null {
	const rows = db
		.prepare("SELECT traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, raw FROM spans WHERE traceId = ? ORDER BY startTimeUnixNano ASC")
		.all(traceId) as StoredRow[];

	const rootRow = rows.find((r) => r.parentSpanId === null);
	if (!rootRow) return null;
	const root = parseRaw(rootRow.raw);
	if (!root) return null;

	const verdict = (root.attrs["gen_ai.agent.verdict"] as Verdict | undefined) ?? "unjudged";
	const score = typeof root.attrs["gen_ai.agent.verdict_score"] === "number" ? (root.attrs["gen_ai.agent.verdict_score"] as number) : null;
	const narrative = typeof root.attrs["gen_ai.agent.verdict_narrative"] === "string" ? (root.attrs["gen_ai.agent.verdict_narrative"] as string) : null;

	const stepRows = rows.filter((r) => r.spanId !== rootRow.spanId);
	// An unparseable root-span timestamp falls back to 0n rather than throwing -- the run still
	// renders (with a defensible-but-arbitrary time origin) instead of a 500 for every request.
	const rootStartNs = toNs(rootRow.startTimeUnixNano) ?? 0n;

	const steps: StepView[] = [];
	let totalCost: number | null = null;
	let totalTokens: number | null = null;

	for (const row of stepRows) {
		const parsed = parseRaw(row.raw);
		if (!parsed) continue;
		const startNs = toNs(row.startTimeUnixNano);
		const endNs = toNs(row.endTimeUnixNano);
		if (startNs === null || endNs === null) continue; // malformed step timestamp; drop the step, not the whole run
		const cost = typeof parsed.attrs["gen_ai.usage.cost"] === "number" ? (parsed.attrs["gen_ai.usage.cost"] as number) : null;
		const tok = typeof parsed.attrs["gen_ai.usage.total_tokens"] === "number" ? (parsed.attrs["gen_ai.usage.total_tokens"] as number) : null;
		if (cost !== null) totalCost = (totalCost ?? 0) + cost;
		if (tok !== null) totalTokens = (totalTokens ?? 0) + tok;
		const sourceType = asSourceType(parsed.attrs["gen_ai.harness.source_type"]);
		const sourceName = asString(parsed.attrs["gen_ai.harness.source_name"]);

		steps.push({
			type: inferStepType(parsed.attrs),
			title: asString(parsed.attrs["gen_ai.tool.name"]) ?? row.name,
			status: parsed.errorCode === 2 ? "err" : "ok",
			start: Number(startNs - rootStartNs) / 1e9,
			dur: Number(endNs - startNs) / 1e9,
			cost,
			tok,
			io: buildStepIo(parsed.events),
			...(sourceType && sourceName ? { sourceType, sourceName } : {}),
		});
	}

	detectRetries(steps);

	return {
		traceId,
		goal: asString(root.attrs["gen_ai.agent.goal"]) ?? rootRow.name,
		agent: asString(root.attrs["gen_ai.agent.name"]) ?? "unknown",
		verdict,
		score,
		narrative,
		totals: { dur: formatDuration(rootRow.startTimeUnixNano, rootRow.endTimeUnixNano), cost: totalCost, tokens: totalTokens, steps: steps.length },
		steps,
	};
}

/** Root-span-only summaries, most recent first, capped at limit. Never throws. */
export function listRuns(db: Database.Database, limit: number): RunSummary[] {
	const rows = db
		.prepare("SELECT traceId, name, startTimeUnixNano, endTimeUnixNano, raw FROM spans WHERE parentSpanId IS NULL ORDER BY startTimeUnixNano DESC LIMIT ?")
		.all(limit) as StoredRow[];

	const summaries: RunSummary[] = [];
	for (const row of rows) {
		const parsed = parseRaw(row.raw);
		if (!parsed) continue;
		const startNs = toNs(row.startTimeUnixNano);
		const endNs = toNs(row.endTimeUnixNano);
		if (startNs === null || endNs === null) continue; // malformed timestamp; drop this run from the list rather than crash
		summaries.push({
			traceId: row.traceId,
			goal: asString(parsed.attrs["gen_ai.agent.goal"]) ?? row.name,
			verdict: (parsed.attrs["gen_ai.agent.verdict"] as Verdict | undefined) ?? "unjudged",
			dur: formatDuration(row.startTimeUnixNano, row.endTimeUnixNano),
			startedAt: toIsoOrEmpty(startNs),
		});
	}
	return summaries;
}

/** Every root span's traceId, unordered, uncapped. Used only for store-wide aggregation (usage analytics) -- everything else in this codebase deliberately caps and orders by recency. */
export function getAllTraceIds(db: Database.Database): string[] {
	const rows = db.prepare("SELECT traceId FROM spans WHERE parentSpanId IS NULL").all() as { traceId: string }[];
	return rows.map((r) => r.traceId);
}
