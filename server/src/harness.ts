/**
 * Reshapes a run's stored harness manifest (captured by mcp/src/manifest.ts
 * and stamped on trail_finish_run's root span as gen_ai.agent.harness_manifest)
 * into a plain view object a template can read directly. Degrades gracefully
 * to empty categories on a missing/malformed manifest -- never throws,
 * matching runs.ts's contract. Returns null only when there is no matching
 * root span at all.
 */

import type Database from "better-sqlite3";
import { toAttributeMap, toIsoOrEmpty, asString } from "./runs.js";

export interface HarnessSkillView {
	name: string;
	description: string;
	source: "project" | "user";
}

export interface HarnessSubAgentView {
	name: string;
	description: string;
	tools: string[];
}

export interface HarnessMcpServerView {
	name: string;
}

export interface HarnessView {
	traceId: string;
	goal: string;
	startedAt: string;
	skills: HarnessSkillView[];
	subAgents: HarnessSubAgentView[];
	mcpServers: HarnessMcpServerView[];
}

interface StoredRow {
	traceId: string;
	name: string;
	startTimeUnixNano: string;
	raw: string;
}

interface ParsedManifest {
	skills: HarnessSkillView[];
	subAgents: HarnessSubAgentView[];
	mcpServers: HarnessMcpServerView[];
}

const EMPTY_MANIFEST: ParsedManifest = { skills: [], subAgents: [], mcpServers: [] };

function isSkillEntry(v: unknown): v is HarnessSkillView {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return typeof s.name === "string" && typeof s.description === "string" && (s.source === "project" || s.source === "user");
}

function isSubAgentEntry(v: unknown): v is HarnessSubAgentView {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.name === "string" &&
		typeof s.description === "string" &&
		Array.isArray(s.tools) &&
		s.tools.every((t) => typeof t === "string")
	);
}

function isMcpServerEntry(v: unknown): v is HarnessMcpServerView {
	if (typeof v !== "object" || v === null) return false;
	return typeof (v as Record<string, unknown>).name === "string";
}

/** Parses the gen_ai.agent.harness_manifest attribute value. Never throws -- any failure (not a string, invalid JSON, wrong shape) yields EMPTY_MANIFEST. */
function parseManifest(raw: unknown): ParsedManifest {
	if (typeof raw !== "string") return EMPTY_MANIFEST;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY_MANIFEST;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY_MANIFEST;
	const m = parsed as { skills?: unknown; subAgents?: unknown; mcpServers?: unknown };

	return {
		skills: Array.isArray(m.skills) ? m.skills.filter(isSkillEntry) : [],
		subAgents: Array.isArray(m.subAgents) ? m.subAgents.filter(isSubAgentEntry) : [],
		mcpServers: Array.isArray(m.mcpServers) ? m.mcpServers.filter(isMcpServerEntry) : [],
	};
}

/** Parses a nanosecond-timestamp string to a bigint, returning 0n (never throwing) on malformed input. */
function toNsOrZero(s: string): bigint {
	try {
		return BigInt(s);
	} catch {
		return 0n;
	}
}

function rowToView(row: StoredRow): HarnessView {
	let attrs: Record<string, string | number | boolean>;
	try {
		const parsed = JSON.parse(row.raw) as { attributes?: { key: string; value: Record<string, unknown> }[] };
		attrs = toAttributeMap(parsed.attributes);
	} catch {
		attrs = {};
	}

	const manifest = parseManifest(attrs["gen_ai.agent.harness_manifest"]);
	const startNs = toNsOrZero(row.startTimeUnixNano);

	return {
		traceId: row.traceId,
		goal: asString(attrs["gen_ai.agent.goal"]) ?? row.name,
		startedAt: toIsoOrEmpty(startNs),
		...manifest,
	};
}

/**
 * Reshapes the harness manifest stamped on a run's root span into a
 * HarnessView. With no traceId, returns the most recently started run's
 * manifest. Returns null only when there is no matching root span at all
 * (empty database, or an unknown traceId) -- a missing/malformed manifest
 * on an existing run instead yields a HarnessView with empty categories,
 * since the run itself is real and should still be selectable in the
 * picker built from listRuns.
 */
export function getHarnessView(db: Database.Database, traceId?: string): HarnessView | null {
	const row = traceId
		? (db
				.prepare("SELECT traceId, name, startTimeUnixNano, raw FROM spans WHERE traceId = ? AND parentSpanId IS NULL")
				.get(traceId) as StoredRow | undefined)
		: (db
				.prepare("SELECT traceId, name, startTimeUnixNano, raw FROM spans WHERE parentSpanId IS NULL ORDER BY startTimeUnixNano DESC LIMIT 1")
				.get() as StoredRow | undefined);

	if (!row) return null;
	return rowToView(row);
}
