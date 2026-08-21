# Tether — Harness Anatomy View Design Spec

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-21
- **Scope:** The second real UI surface in Tether — a standalone page showing what a harness's registered skills, sub-agents, and MCP servers *are*, independent of any single run's timeline. Second of the four surfaces named in `trail`'s `docs/superpowers/specs/2026-08-21-agent-harness-visualization-design.md` (harness anatomy, coverage overlay, usage analytics, plus the already-shipped Flight Recorder). Does not cover coverage overlay or usage analytics — those are separately scoped, downstream of this.

---

## 1. Why this document exists

The harness manifest (skills, sub-agents, MCP servers a harness had available at run start) has been captured on every run since `mcp/src/manifest.ts` shipped — `trail_finish_run` stamps it onto the root span as `gen_ai.agent.harness_manifest`, a JSON string. Nothing reads it back today: `server/src/runs.ts`'s `RunView`/`RunSummary` don't expose it, and no route serves it. This spec designs the first UI to actually show it.

Per the original design spec's own framing (§1 of the `trail` doc): showing *what a harness has* (skill library, tool surface, sub-agent composition), not just *what a run did*, is the differentiating idea. This surface is the first place that idea becomes visible.

---

## 2. Where things stand today

Verified directly against the shipped code (2026-08-21):

- **`mcp/src/manifest.ts`** — `buildHarnessManifest(rootDir, homeDir, claudeJsonPath)` returns `{ schemaVersion: 2, skills, subAgents, mcpServers }`:
  - `skills: SkillEntry[]` — `{ name, description, source: "project" | "user" }`, discovered from `.claude/skills/*/SKILL.md` frontmatter in both the project root and the developer's home directory.
  - `subAgents: SubAgentEntry[]` — `{ name, description, tools: string[] }`, discovered from `.claude/agents/*.md` frontmatter in the project root only (no user-level `~/.claude/agents` discovery yet — a known, separately-tracked gap, not addressed here).
  - `mcpServers: McpServerEntry[]` — `{ name }` only, deliberately: command/args/env are never captured since those routinely carry secrets. No tool list or tool count per server.
  - All three categories are **flat lists** — a sub-agent's `tools` field names the tools *that sub-agent* can use, but nothing records which sub-agents or skills hand off to which others. There is no composition/handoff graph in the data model today.
  - Every discovery function degrades to `[]` on a missing directory, malformed frontmatter, or read error — never throws. Output is bounded (`MAX_SKILLS`/`MAX_SUB_AGENTS`/`MAX_MCP_SERVERS` = 50 each, descriptions truncated to 300 characters) so the manifest can't blow past the ingest endpoint's body size.
- **`mcp/src/index.ts:117`** — `trail_start_run` calls `buildHarnessManifest(rootDir)` where `rootDir = process.env.TRAIL_PROJECT_ROOT ?? process.cwd()`. This resolves the open question the original design spec (§5.1) flagged about project-root discovery — already shipped, not a decision this spec needs to make.
- **`mcp/src/index.ts:305`** — `trail_finish_run` attaches `"gen_ai.agent.harness_manifest": JSON.stringify(run.manifest)` to the root span's attributes. This is the only place the manifest reaches the server; it is stored (like every other attribute) inside that span's `raw` JSON blob in SQLite, untouched since ingestion.
- **`server/src/runs.ts`** — has a private `toAttributeMap(attributes)` helper (converts the stored `[{key, value: {stringValue|...}}]` shape to a plain object) and a root-span query (`WHERE parentSpanId IS NULL`) already used by both `getRun` and `listRuns`. Neither reads `gen_ai.agent.harness_manifest`.

**Consequence:** this is a pure reshape-and-display task, like the Flight Recorder build was once manifest capture existed. No new instrumentation. The one thing to build is the read-and-render path.

---

## 3. Target design

### 3.1 Serving architecture

A new standalone page, consistent with the rest of the server's zero-JS-API, fully-server-rendered approach:

- **`GET /harness`** — shows the harness manifest from the most recent run (same ordering as `listRuns`: newest `startTimeUnixNano` first).
- **`GET /harness?run=<traceId>`** — shows the manifest as it was stamped on that specific run. Lets a developer check "what did my harness look like when I ran this three days ago," per the original design spec's stated requirement (§3.1: "two runs of the same project on different days can show different manifests — that's intended").
- **Run picker:** a plain HTML `<select>` (populated from `listRuns(db, 50)`, same list the run-list page already shows) that submits a `GET` on change via a tiny inline `onchange="location.search='?run='+encodeURIComponent(this.value)"` — no fetch, no client state, matching the Flight Recorder page's existing "read a server-rendered page" model. Selecting a run navigates to a fresh full-page load of `/harness?run=...`.
- **Nav:** both this page and the existing Flight Recorder / run-list pages get a small top nav bar with two links — "All runs" and "Harness" — so a developer can move between the two surfaces. (The Flight Recorder page today has an "← All runs" link but no equivalent; this is a small addition to that page's template, not a redesign.)

### 3.2 New backend module: `server/src/harness.ts`

- **`getHarnessView(db, traceId?): HarnessView | null`**
  - If `traceId` is given, queries that trace's root span directly (same `WHERE traceId = ? AND parentSpanId IS NULL` shape `getRun` already uses).
  - If `traceId` is omitted, queries the single most recent root span (`ORDER BY startTimeUnixNano DESC LIMIT 1` — the same ordering `listRuns` uses, just capped at 1 row instead of 50).
  - Returns `null` if there is no matching root span at all (empty database, or an unknown/deleted `traceId`) — the route turns this into an honest empty-state page, not a 404 crash, since "no runs yet" is an expected state for a fresh Tether install.
  - Parses `gen_ai.agent.harness_manifest` off the root span's attributes (via `toAttributeMap`, exported from `runs.ts` for reuse rather than duplicated). If the attribute is missing (a run predating this feature) or fails `JSON.parse`, or fails a basic shape check (must have `skills`/`subAgents`/`mcpServers` arrays), returns a `HarnessView` with all three categories empty rather than throwing or omitting the page — the run itself still exists and should still be selectable from the picker, it just had (or reported) no discoverable harness.
- **Exported types:**
  ```ts
  export interface HarnessSkillView { name: string; description: string; source: "project" | "user" }
  export interface HarnessSubAgentView { name: string; description: string; tools: string[] }
  export interface HarnessMcpServerView { name: string }

  export interface HarnessView {
    traceId: string;
    goal: string;       // the run's name, so the page can say "as of: <goal>"
    startedAt: string;  // ISO string, same formatting convention as RunSummary.startedAt
    skills: HarnessSkillView[];
    subAgents: HarnessSubAgentView[];
    mcpServers: HarnessMcpServerView[];
  }
  ```
- **`runs.ts` change:** export the existing private `toAttributeMap` (rename nothing, just add `export`). This is the only change to `runs.ts` — `RunView`/`RunSummary` are not touched, since the run-timeline pages have no need for harness data and adding it there would blur that module's existing single responsibility (run reshape, not harness reshape).

### 3.3 New template: `server/src/templates/harness.ts`

- **`renderHarnessPage(view: HarnessView | null, runs: RunSummary[]): string`**
- Three sections, in this order: **Skills**, **Sub-agents**, **MCP servers**. Each:
  - Shows a count in its header (e.g. "Skills (4)").
  - Lists each entry: name (bold), description (truncated already by capture, rendered as-is), and for sub-agents, their declared `tools` as a small inline tag list (e.g. `Tools: Bash, Read, WebFetch`) — matching the exact "Tools: ..." format this very session's own agent listings already use, per the original design spec's §3.1 note.
  - Shows an explicit, honest empty message when a category has zero entries — "No skills discovered for this run" / "No sub-agents discovered for this run" / "No MCP servers discovered for this run" — never a blank section, never fabricated placeholder content.
- When `view` is `null` (no runs in the database at all): the whole page shows a single empty-state message ("No runs yet — once a run stamps a harness manifest, it'll show up here.") plus the (necessarily empty) run picker.
- **Escaping:** every one of `goal`, skill `name`/`description`, sub-agent `name`/`description`/`tools[]`, and MCP server `name` is unvalidated text that arrived via `POST /traces` — the exact same class of data that produced the Flight Recorder page's two Critical XSS findings (the `</script>` JSON-injection breakout and the unescaped judge narrative). This template must escape all of it before interpolation, and if it also injects any structured data into an inline `<script>` block (e.g. for the run-picker's `<option>` values, though those can likely be built as plain escaped HTML `<option>` tags instead, avoiding the injection pattern entirely), it must use the same defensive pattern the fixed `flight-recorder.ts` now uses (function replacer, `<`/U+2028/U+2029 escaping) rather than re-inventing it. Preference: avoid a `<script>`-injected data blob altogether for this page, since a `<select>` of runs can be built as plain server-rendered `<option>` tags with no JSON injection needed at all — simpler and removes an entire class of risk this page doesn't need to take on.
- Visual language matches the existing pages (same dark theme/CSS variables as `flight-recorder.ts`/`run-list.ts`) but this is not a pixel-precise requirement — reasonable visual consistency, not a shared CSS file (matching the codebase's current per-template inline `<style>` convention).

### 3.4 Route wiring: `server/src/server.ts`

- Add `GET /harness` (with optional `?run=` query param, parsed from the already-existing `pathname`/query-string split) alongside the existing three routes.
- Calls `getHarnessView(db, traceId)` and `listRuns(db, 50)`, passes both to `renderHarnessPage`.
- Same crash-proofing shape as the other two GET routes: compute the page before `writeHead`, try/catch to a 500 JSON error on unexpected failure (a `getHarnessView` bug, not a missing-manifest case — that's handled by returning empty categories, not by throwing).
- `Content-Type: text/html; charset=utf-8` (matching the fix already shipped for the other two HTML routes).

---

## 4. Explicitly out of scope for this spec

- **Composition/handoff graph** — the original design spec's §5.3 flagged "does a sub-agent's own recursion need a graph structure" as an open question; this spec resolves it for now by shipping the flat categorized list the data actually supports, not a graph. Revisit only if manifest capture is later extended to record handoff relationships.
- **Coverage overlay** (which manifest entries were actually touched during a run) and **usage analytics** (aggregate coverage across all runs) — the next two surfaces in the original design spec's build sequence, each their own spec.
- **User-level sub-agent discovery** (`~/.claude/agents`) and **MCP server tool lists/counts** — both are gaps in `mcp/src/manifest.ts`'s current capture, not this spec's concern; this spec displays whatever the manifest contains, however complete that is today.
- **Editing or acting on** any harness entry (e.g., disabling a skill) — pure display, matching the original spec's §3.2 characterization ("Pure display of the manifest").

## 5. Open items resolved during this spec's authoring

- **Flat list vs. composition graph (§5.3 of the original spec):** resolved — flat categorized list for v1 (§3.2/3.3 above), since the data model has no composition data to graph.
- **Placement (not an open item in the original spec, but needed a decision here):** resolved — standalone `GET /harness` page, not a tab on the existing run detail page, so it can be browsed independent of drilling into a specific run first.
- **Project-root discovery (§5.1 of the original spec):** already resolved by shipped code (`TRAIL_PROJECT_ROOT` env var, falls back to `cwd()`) — not a decision this spec needs to make.
- **Manifest schema versioning (§5.2 of the original spec):** already resolved by shipped code (`schemaVersion: 2`, a stable, documented shape) — not a decision this spec needs to make.
