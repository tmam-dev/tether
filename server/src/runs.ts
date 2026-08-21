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

function toAttributeMap(attributes: { key: string; value: Record<string, unknown> }[] | undefined): AttrMap {
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

function formatDuration(startNs: string, endNs: string): string {
	const seconds = Math.max(0, Math.round((Number(BigInt(endNs) - BigInt(startNs))) / 1e9));
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
	const rootStartNs = BigInt(rootRow.startTimeUnixNano);

	const steps: StepView[] = [];
	let totalCost: number | null = null;
	let totalTokens: number | null = null;

	for (const row of stepRows) {
		const parsed = parseRaw(row.raw);
		if (!parsed) continue;
		const cost = typeof parsed.attrs["gen_ai.usage.cost"] === "number" ? (parsed.attrs["gen_ai.usage.cost"] as number) : null;
		const tok = typeof parsed.attrs["gen_ai.usage.total_tokens"] === "number" ? (parsed.attrs["gen_ai.usage.total_tokens"] as number) : null;
		if (cost !== null) totalCost = (totalCost ?? 0) + cost;
		if (tok !== null) totalTokens = (totalTokens ?? 0) + tok;

		steps.push({
			type: inferStepType(parsed.attrs),
			title: (parsed.attrs["gen_ai.tool.name"] as string | undefined) ?? row.name,
			status: parsed.errorCode === 2 ? "err" : "ok",
			start: Number(BigInt(row.startTimeUnixNano) - rootStartNs) / 1e9,
			dur: Number(BigInt(row.endTimeUnixNano) - BigInt(row.startTimeUnixNano)) / 1e9,
			cost,
			tok,
			io: buildStepIo(parsed.events),
		});
	}

	detectRetries(steps);

	return {
		traceId,
		goal: (root.attrs["gen_ai.agent.goal"] as string | undefined) ?? rootRow.name,
		agent: (root.attrs["gen_ai.agent.name"] as string | undefined) ?? "unknown",
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
		summaries.push({
			traceId: row.traceId,
			goal: (parsed.attrs["gen_ai.agent.goal"] as string | undefined) ?? row.name,
			verdict: (parsed.attrs["gen_ai.agent.verdict"] as Verdict | undefined) ?? "unjudged",
			dur: formatDuration(row.startTimeUnixNano, row.endTimeUnixNano),
			startedAt: new Date(Number(BigInt(row.startTimeUnixNano) / 1_000_000n)).toISOString(),
		});
	}
	return summaries;
}
