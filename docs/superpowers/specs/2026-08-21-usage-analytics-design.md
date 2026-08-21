# Tether — Usage Analytics Design Spec

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-21
- **Scope:** The fourth and final real UI surface named in `trail`'s `docs/superpowers/specs/2026-08-21-agent-harness-visualization-design.md` — a standalone page aggregating coverage across every run in the local store, so a developer can see which skills/sub-agents/MCP servers are earning their keep vs. sitting unused. Flight Recorder, harness anatomy, and coverage overlay are already shipped.

---

## 1. Why this document exists, and a correction to the original design

The original design spec (§3.4) said usage analytics "extends the Outcomes lens." **Tether has no Outcomes page** — that was one of four `trail` prototypes (Flight Recorder, Fleet, Topology, Outcomes) this pivot never built; only Flight Recorder was adapted. There is nothing to extend. This spec builds a new standalone page instead, following the same precedent as the harness anatomy view (`GET /harness`), not an extension of anything.

The original spec also proposed correlating usage with "failures, retries, or high cost." This spec deliberately does not attempt that for v1: real correlation analysis needs sample-size and confounding-factor care to avoid misleading a developer with a spurious pattern from a handful of runs, and Tether has no existing statistical-analysis code to build on. Aggregate counts and dead-weight detection are the honest, immediately useful slice; correlation is left for a future spec once there's enough real usage data in actual deployments to make it meaningful.

---

## 2. Where things stand today

Verified directly (2026-08-21):

- **`server/src/runs.ts`'s `listRuns(db, limit)`** always takes an explicit cap — every call site in `server.ts` passes `50`. There is no "every run" query today.
- **`server/src/coverage.ts`'s `getCoverage(db, traceId)`** already returns exactly the per-run shape this spec needs to aggregate: `{ tracked: boolean, entries: [{ type, name, usedCount }] }`, one entry per manifest item the run had registered. This spec is aggregation over many calls to the existing function, not new per-run logic.

---

## 3. Target design

### 3.1 New backend addition: `getAllTraceIds` in `server/src/runs.ts`

```ts
/** Every root span's traceId, unordered, uncapped. Used only for store-wide aggregation (usage analytics) -- everything else in this codebase deliberately caps and orders by recency. */
export function getAllTraceIds(db: Database.Database): string[] {
	const rows = db.prepare("SELECT traceId FROM spans WHERE parentSpanId IS NULL").all() as { traceId: string }[];
	return rows.map((r) => r.traceId);
}
```

A small, single-purpose addition to the module that already owns querying the `spans` table for run-level information — not a new module, since it's one query, not a reshape.

### 3.2 New module: `server/src/analytics.ts`

```ts
export interface UsageEntry {
	type: "skill" | "sub_agent" | "mcp_server";
	name: string;
	registeredRuns: number;   // runs whose manifest included this entry, tracked or not
	trackedRuns: number;      // of those, runs where coverage.tracked was true (usage data is meaningful)
	usedRuns: number;         // of trackedRuns, how many actually used it at least once
	totalUsedCount: number;   // sum of usedCount across all tracked runs
	deadWeight: boolean;      // trackedRuns > 0 && usedRuns === 0
}

export interface UsageView {
	totalRuns: number;
	trackedRuns: number;
	entries: UsageEntry[]; // one per distinct (type, name) ever seen, insertion order = first-seen
}

export function getUsage(db: Database.Database): UsageView
```

- Iterates `getAllTraceIds(db)`, calling `getCoverage(db, traceId)` for each (never throws, matching `getCoverage`'s own contract; a `null` result — which shouldn't occur for a traceId we just queried, but the type allows it — is simply skipped, not an error).
- For each run's `CoverageView`: increments `totalRuns`; if `tracked`, increments `trackedRuns`. For each of that run's `entries`, finds or creates the matching `(type, name)` bucket and increments `registeredRuns`; if the run was `tracked`, additionally increments the bucket's `trackedRuns`, adds `usedCount` to `totalUsedCount`, and increments `usedRuns` when `usedCount > 0`.
- `deadWeight` is computed once, after aggregation: `trackedRuns > 0 && usedRuns === 0` — an entry with zero tracked runs can't be called dead weight (there's no evidence either way), it's just unproven.
- Never throws — every function this composes already guarantees that; iterating an array and incrementing counters cannot itself throw.

### 3.3 New template: `server/src/templates/analytics.ts`

- **`renderAnalyticsPage(usage: UsageView): string`** — plain server-rendered page, no embedded client-side JS/script-injection (unlike Flight Recorder — there's no per-run timeline to scrub here, so the harness anatomy page's simpler all-server-rendered style is the right model, not Flight Recorder's).
- Header: "Usage across N runs" plus, when `trackedRuns < totalRuns`, a note: "M run(s) have no coverage tracking (excluded from the counts below)."
- Three sections (Skills / Sub-agents / MCP servers, matching every other page's category grouping), each entry showing: name, "used in X/Y tracked runs (Z total uses)", and a "DEAD WEIGHT" tag when `deadWeight` is true — reusing the same visual language as coverage overlay's "✓ used" / "— not used" (a tag, not a paragraph, keeping this scannable across potentially many entries).
- Empty states, all honest and distinct (matching every other page's established pattern — never a blank section, never fabricated content):
  - `totalRuns === 0`: "No runs yet."
  - `totalRuns > 0 && trackedRuns === 0`: "No runs have reported skill/sub-agent/MCP-server usage yet — coverage tracking requires trail_log_step calls with source_type/source_name set."
  - `entries.length === 0` (runs exist and some are tracked, but no manifest ever registered anything): "No skills, sub-agents, or MCP servers have been registered by any run."
  - Per-category empty message when that specific category has zero entries, mirroring `harness.ts`'s per-category pattern exactly.
- Escaping: every entry `name` is unvalidated text from the same untrusted source as every other page (`POST /traces`) — goes through the same `escapeHtml` used by `harness.ts`/`run-list.ts` (all `&<>"'`), copied into this new template rather than imported, matching this codebase's existing per-template-escaper convention (noted in the harness anatomy review as a minor drift risk, accepted there since every current use is text-node context — same reasoning applies here, no attribute-context interpolation of entry names in this template).

### 3.4 Route wiring: `server/src/server.ts`

- Add `GET /analytics`: `const page = renderAnalyticsPage(getUsage(db));` — no query params, this is inherently store-wide. Same crash-proofing shape as every other route (compute before `writeHead`, try/catch to 500).
- `Content-Type: text/html; charset=utf-8`, matching every other HTML route.

### 3.5 Navigation

Every existing page's nav gains an "Analytics" link, alongside the existing links:
- `run-list.ts`: `<a href="/">Runs</a> · <a href="/harness">Harness</a> · <a href="/analytics">Analytics</a>`
- `flight-recorder.ts`: a third `.backlink` anchor next to the existing "&larr; All runs" / "Harness" pair.
- `harness.ts`: a second `.backlink` anchor next to the existing "&larr; All runs" (still no self-referential "Harness" link on the harness page itself, consistent with the earlier decision there).
- The new `analytics.ts` page's own nav links to "All runs" and "Harness" (not itself), matching the harness page's pattern of never linking to itself.

---

## 4. Explicitly out of scope for this spec

- **Correlation with failures, retries, or cost** — per §1, deferred to a future spec.
- **Time-windowed analytics** (e.g., "usage this week") — this is a whole-store aggregate; no time filtering.
- **A JSON API** — deliberately out of scope for the whole project so far (per the Flight Recorder spec's §4), and nothing here changes that.
- **Editing or acting on** any entry (e.g., archiving a dead-weight skill) — pure display.

## 5. Open items resolved during this spec's authoring

- **The original spec's "extends the Outcomes lens" framing** — corrected: Tether has no Outcomes page; this is a new standalone page, per §1.
- **Correlation ambition** — descoped to counts + dead-weight detection only, per §1 and the approved scoping decision.
- **Aggregation identity** — entries are grouped by `(type, name)` across every run's manifest, since a project's registered skills/sub-agents/MCP servers can change between runs; an entry doesn't need to appear in every run's manifest to be aggregated, only in at least one.
- **Untracked runs' effect on the denominator** — resolved via the `registeredRuns` vs `trackedRuns` distinction: an untracked run's registration of an entry counts toward `registeredRuns` (so the page can report "N runs registered you") but not toward `trackedRuns`/`usedRuns`/`totalUsedCount` (since an untracked run provides no usage evidence either way) — this mirrors coverage overlay's own tracked/not-tracked distinction, applied at aggregate scale.
