# Tether — Coverage Overlay Design Spec

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-21
- **Scope:** The third real UI surface in Tether — a "Coverage" panel on the existing Flight Recorder run detail page (`GET /runs/:traceId`), showing which of a run's harness manifest entries (skills, sub-agents, MCP servers) were actually used during that run, vs. sat unused. Third of the four surfaces named in `trail`'s `docs/superpowers/specs/2026-08-21-agent-harness-visualization-design.md` (harness anatomy and Flight Recorder already shipped; usage analytics is the remaining one, separately scoped, downstream of this).

---

## 1. Why this document exists, and a correction to the original design

The original design spec (`agent-harness-visualization-design.md` §3.3) described coverage as "requires only a join between two datasets that both already exist... no further new capture." **That claim does not hold up under investigation.** `mcp/src/index.ts`'s `trail_log_step` schema (`run_id`, `name`, `kind`, `input`, `output`, `status`, `error_message`, `duration_ms`) has no field identifying which skill, sub-agent, or MCP server a step came from — it's free-text logged by whatever coding agent calls it, with no structured link to the harness manifest `trail_start_run` captures separately. A step named `"run pytest"` tells you nothing about whether a skill, a sub-agent, or a bare shell command produced it.

Given that, this spec adds a small piece of new instrumentation (an optional attribution field on `trail_log_step`) rather than attempting a heuristic text-match join, which would produce misleading false positives/negatives (e.g., a skill literally named `test` coincidentally matching a step named `"run pytest"`). This mirrors the project's established practice of not overpromising when the underlying data doesn't support a feature (per the Flight Recorder spec's own honest cuts).

---

## 2. Where things stand today

Verified directly (2026-08-21):

- **`mcp/src/index.ts`'s `trail_log_step`** — as described above, no attribution field exists.
- **`mcp/src/manifest.ts`** — already captures skills (`name`, `description`, `source: "project"|"user"`), sub-agents (`name`, `description`, `tools`), and MCP servers (`name`) into the per-run `HarnessManifest`, stamped on the root span (shipped, used by the already-built harness anatomy view).
- **`server/src/runs.ts`'s `StepView`** — `{ type, title, status, start, dur, cost, tok, io, sig? }`. No source-attribution field.
- **`server/src/harness.ts`'s `getHarnessView`** — already reshapes a run's manifest into `HarnessView { skills, subAgents, mcpServers }`. Reusable as-is for the join this spec adds.
- **`server/src/templates/flight-recorder.ts`** — the existing run detail page has a two-panel `.split` section (Steps / Verdict-or-step-inspector) below the scrubber. This spec adds a third panel, not a modification of the existing two.

---

## 3. Target design

### 3.1 New instrumentation: `trail_log_step` gets two optional parameters

```ts
source_type: z.enum(["skill", "sub_agent", "mcp_server"]).optional()
  .describe("If this step came from a registered skill, sub-agent, or MCP server, which kind"),
source_name: z.string().optional()
  .describe("Name of the skill/sub-agent/MCP server, matching an entry from this run's harness manifest"),
```

Both are optional — an agent harness that doesn't support attribution simply omits them, exactly as it does today. **Both-or-neither**: if only one of the pair is provided, `trail_log_step` treats it as if neither were given (a dangling type with no name, or vice versa, isn't a usable coverage signal) — this keeps the stored data always either "a complete attribution" or "no attribution," never a half-formed one a reader has to guard against.

Wire representation: two new OTLP span attributes on the step span, matching the existing `gen_ai.*` convention — `gen_ai.harness.source_type` and `gen_ai.harness.source_name`. No change to `trail_log_llm_call` or `trail_log_exception` in this spec — attribution is scoped to task/tool steps, where "did the agent reach for a registered capability" is the meaningful question; LLM calls and exceptions are left for a future spec if ever needed.

`source_name` is not validated against the run's own manifest at logging time (`mcp/` stays simple/dumb about this, matching its existing style — `trail_log_step` doesn't validate `name` against anything else either). Matching against the manifest happens entirely server-side, at read time.

### 3.2 `server/src/runs.ts` changes

- `StepView` gains two optional fields: `sourceType?: "skill" | "sub_agent" | "mcp_server"` and `sourceName?: string`.
- `getRun`'s step-building loop reads `gen_ai.harness.source_type`/`gen_ai.harness.source_name` off each step span's attributes (via the already-exported `toAttributeMap`), validating `source_type` against the three literal values (an unrecognized/malformed value degrades to `undefined` — never throws, matching every other field in this function) and `source_name` via the already-exported `asString` guard.

### 3.3 New module: `server/src/coverage.ts`

```ts
export interface CoverageEntry {
	type: "skill" | "sub_agent" | "mcp_server";
	name: string;
	usedCount: number; // 0 if never matched by any step's source_type+source_name
}

export interface CoverageView {
	tracked: boolean; // true if at least one step in this run reported a source
	entries: CoverageEntry[]; // one per manifest entry, skills then subAgents then mcpServers
}

export function getCoverage(db: Database.Database, traceId: string): CoverageView | null
```

- Composes the already-built `getRun(db, traceId)` and `getHarnessView(db, traceId)` (both already exist — this is genuinely a join, just not the free one the original spec assumed) rather than re-querying spans a third way.
- Returns `null` only when the run itself doesn't exist (mirroring `getRun`/`getHarnessView`'s own null contract) — never throws otherwise.
- `tracked` distinguishes "this run's tooling doesn't support attribution at all" (show an honest "not tracked" message, not a misleading "0 used everywhere") from "this run's tooling supports attribution, and this particular entry genuinely wasn't touched" (show "not used").
- `usedCount` is a count, not a boolean, so multiple steps using the same skill are visible (e.g., "used (3 steps)") — a natural byproduct of counting matches, not a design requirement to satisfy on its own.

### 3.4 Template change: `server/src/templates/flight-recorder.ts`

- `renderFlightRecorderPage(run: RunView, coverage: CoverageView | null): string` — signature gains the second parameter. The single injected data blob (currently `const RUN = {...run}` via the already-fixed function-replacer/escaped-JSON pattern) becomes `const RUN = {...run, coverage}` — one canonical injected object, not a second `<script>` variable.
- A new panel, added below the existing `.split` (Steps/Verdict) section — not a modification of either existing panel:
  ```html
  <section class="panel">
    <div class="panel-head"><h2>Coverage</h2></div>
    <div id="coverage"></div>
  </section>
  ```
- A new client-side `renderCoverage()` function (called alongside the existing `renderMission()`/`renderSteps()`/etc. at page load), reusing the page's existing client-side `escapeHtml()` (the same one already used by `renderMission`/`renderSteps`/`renderVerdict` — no new escaper to keep in sync):
  - If `RUN.coverage` is null or `RUN.coverage.entries.length === 0`: "No skills, sub-agents, or MCP servers were registered for this run — nothing to show coverage for."
  - Else if `!RUN.coverage.tracked`: "Coverage not tracked for this run — no step reported which skill, sub-agent, or MCP server it came from."
  - Else: three sub-lists (Skills / Sub-agents / MCP servers, matching the harness anatomy page's category grouping for visual consistency), each entry showing the (escaped) name plus either "✓ used (N step(s))" or "— not used", and each sub-list showing its own honest empty message ("No skills registered for this run.") when that specific category has zero manifest entries — mirroring `harness.ts`'s per-category empty-state pattern exactly.

### 3.5 Route wiring: `server/src/server.ts`

- The existing `GET /runs/:traceId` handler additionally calls `getCoverage(db, traceId)` and passes it as `renderFlightRecorderPage`'s second argument. No new route — this rides the existing one.

---

## 4. Explicitly out of scope for this spec

- **`trail_log_llm_call`/`trail_log_exception` attribution** — scoped out per §3.1; revisit only if there's a concrete need to attribute LLM calls or exceptions to a specific skill/sub-agent.
- **Validating `source_name` against the manifest at log time** — `mcp/` stays simple; all matching happens server-side at read time.
- **Usage analytics** (aggregate coverage across all runs) — the fourth and final surface from the original design spec, separately scoped, depends on this spec's per-run coverage data existing first.
- **Backfilling coverage for runs logged before this ships** — those runs simply show `tracked: false` (correctly — they truly have no attribution data), same as any harness that doesn't opt into the new fields.

## 5. Open items resolved during this spec's authoring

- **The original spec's core premise (§3.3, "no further new capture")** — corrected: new capture *is* needed (§1), via a small optional-field addition, not a heuristic text match.
- **Placement** — a new panel on the existing Flight Recorder page (`GET /runs/:traceId`), not a new top-level page — matches the original spec's own framing ("extends the existing Flight Recorder run timeline").
- **What counts as "unused" (original spec §5.4, left as an open question there)** — resolved by the `tracked` flag: an entry with `usedCount: 0` in a `tracked: true` run is genuinely "not used"; the same entry in a `tracked: false` run is "not tracked," never conflated.
