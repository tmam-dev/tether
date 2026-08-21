/**
 * Aggregates getCoverage's per-run result across every run in the store, so
 * a developer can see which skills/sub-agents/MCP servers are used across
 * their whole history vs. registered-but-never-used ("dead weight").
 */

import type Database from "better-sqlite3";
import { getAllTraceIds } from "./runs.js";
import { getCoverage } from "./coverage.js";

export interface UsageEntry {
	type: "skill" | "sub_agent" | "mcp_server";
	name: string;
	registeredRuns: number;
	trackedRuns: number;
	usedRuns: number;
	totalUsedCount: number;
	deadWeight: boolean;
}

export interface UsageView {
	totalRuns: number;
	trackedRuns: number;
	entries: UsageEntry[];
}

interface MutableEntry {
	type: UsageEntry["type"];
	name: string;
	registeredRuns: number;
	trackedRuns: number;
	usedRuns: number;
	totalUsedCount: number;
}

/**
 * Aggregates coverage across every run in the store. Never throws --
 * composes getAllTraceIds and getCoverage, both of which already guarantee
 * that; a null getCoverage result (shouldn't occur for a traceId we just
 * queried, but the type allows it) is simply skipped, not an error.
 */
export function getUsage(db: Database.Database): UsageView {
	const buckets = new Map<string, MutableEntry>();
	let totalRuns = 0;
	let trackedRuns = 0;

	for (const traceId of getAllTraceIds(db)) {
		const coverage = getCoverage(db, traceId);
		if (!coverage) continue;
		totalRuns += 1;
		if (coverage.tracked) trackedRuns += 1;

		for (const entry of coverage.entries) {
			const key = `${entry.type} ${entry.name}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { type: entry.type, name: entry.name, registeredRuns: 0, trackedRuns: 0, usedRuns: 0, totalUsedCount: 0 };
				buckets.set(key, bucket);
			}
			bucket.registeredRuns += 1;
			if (coverage.tracked) {
				bucket.trackedRuns += 1;
				bucket.totalUsedCount += entry.usedCount;
				if (entry.usedCount > 0) bucket.usedRuns += 1;
			}
		}
	}

	const entries: UsageEntry[] = [...buckets.values()].map((b) => ({
		...b,
		deadWeight: b.trackedRuns > 0 && b.usedRuns === 0,
	}));

	return { totalRuns, trackedRuns, entries };
}
