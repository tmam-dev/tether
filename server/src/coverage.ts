/**
 * Joins a run's steps (runs.ts) against its harness manifest (harness.ts) to
 * show which manifest entries were actually used. This join needs new
 * per-step attribution data (runs.ts's StepView.sourceType/sourceName) --
 * there is no free join available from existing data alone (see this
 * feature's design spec §1 for why).
 */

import type Database from "better-sqlite3";
import { getRun } from "./runs.js";
import { getHarnessView } from "./harness.js";

export interface CoverageEntry {
	type: "skill" | "sub_agent" | "mcp_server";
	name: string;
	usedCount: number;
}

export interface CoverageView {
	tracked: boolean;
	entries: CoverageEntry[];
}

/**
 * Reshapes a run's coverage: for each of its harness manifest entries, how
 * many steps reported using it. Returns null only when the run itself
 * doesn't exist (mirrors getRun/getHarnessView's own null contract) --
 * never throws otherwise.
 */
export function getCoverage(db: Database.Database, traceId: string): CoverageView | null {
	const run = getRun(db, traceId);
	const harness = getHarnessView(db, traceId);
	if (!run || !harness) return null;

	const tracked = run.steps.some((s) => s.sourceType !== undefined);

	const countFor = (type: CoverageEntry["type"], name: string): number =>
		run.steps.filter((s) => s.sourceType === type && s.sourceName === name).length;

	const entries: CoverageEntry[] = [
		...harness.skills.map((s) => ({ type: "skill" as const, name: s.name, usedCount: countFor("skill", s.name) })),
		...harness.subAgents.map((a) => ({ type: "sub_agent" as const, name: a.name, usedCount: countFor("sub_agent", a.name) })),
		...harness.mcpServers.map((m) => ({ type: "mcp_server" as const, name: m.name, usedCount: countFor("mcp_server", m.name) })),
	];

	return { tracked, entries };
}
