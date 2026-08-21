# Tether — Flight Recorder UI Design Spec

- **Status:** Draft — scoping, not yet reviewed/approved
- **Date:** 2026-08-21
- **Scope:** The first real UI in Tether — a run list and a per-run "Flight Recorder" view (goal, verdict, step timeline) adapted from the existing static HTML prototype at `design/agent-observability-prototypes` in the `trail` repo. Replaces `server/`'s current placeholder page. Does not cover harness anatomy/coverage/usage-analytics (those are separately scoped, downstream of this) or any of the richer prototype features this spec deliberately cuts (§4).

---

## 1. Why this document exists

Everything built in Tether so far (`mcp/`'s local mode, `server/`'s SQLite storage and OTLP ingestion) is plumbing — real, working, end-to-end-verified, but with nothing to show for it beyond a placeholder page reporting a run count. This is the first spec for an actual UI: the thing that makes "data is being captured" into "this is worth installing."

A prior design effort in `trail` (`docs/superpowers/specs/2026-08-07-agent-flight-recorder-design.md`) scoped a Flight Recorder view against `trail`'s own Next.js/React dashboard and MongoDB-backed server — none of that applies here. This spec re-scopes the same underlying idea against what Tether actually has: a plain `node:http` server, SQLite storage, and a specific, verified set of span attributes `mcp/` emits.

---

## 2. Where things stand today

### 2.1 What's already captured (verified against `mcp/src/index.ts` and a real stored span)

Every run is one OTel trace: one root span (emitted by `trail_finish_run`, `parentSpanId` unset) plus zero or more flat child spans (`parentSpanId` = the root's span id — no nesting; `trail_log_step`/`trail_log_llm_call`/`trail_log_exception` are all direct children).

- **Root span:** `gen_ai.agent.goal` (the run's name/goal text), `gen_ai.agent.harness_manifest` (JSON string — skills/sub-agents/MCP servers), and — only when a judge is configured and a summary was given — `gen_ai.agent.verdict` (`met`/`partial`/`failed`), `gen_ai.agent.verdict_score` (0–1), `gen_ai.agent.verdict_narrative` (free text). `startTimeUnixNano`/`endTimeUnixNano` give total run duration.
- **`trail_log_step` spans:** `gen_ai.operation.name` = `execute_tool` (kind `tool`) or `execute_task` (kind `task`); `gen_ai.tool.name` set only for `tool`-kind steps, holding free text like `"run pytest"`/`"edit auth.py"` — there is no structured category (read/edit/run/search) anywhere, only this free-text name. Events carry raw I/O (`gen_ai.content.prompt`/`gen_ai.content.completion`).
- **`trail_log_llm_call` spans:** `gen_ai.operation.name` = `chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens`/`total_tokens`/`cost`. Only these spans carry cost/token data — plain `trail_log_step` calls never do, since that tool's schema has no cost/token fields.
- **`trail_log_exception` spans:** `gen_ai.operation.name` = `execute_task`, name defaults to `"exception"` or a custom string, always carries an OTLP error/exception event.
- **Error signal:** every span's OTLP `status.code` is `2` (error) or `1` (ok), set directly from whether the emitting tool call reported `status: "error"`.

Storage today (`server/src/db.ts`): one SQLite row per span — `traceId`, `spanId`, `parentSpanId` (nullable), `name`, `startTimeUnixNano`, `endTimeUnixNano`, and `raw` (the full span object as OTLP-shaped JSON, `attributes` as a `[{key, value: {stringValue|intValue|...}}]` array — not a plain object). Nothing today groups spans by trace, orders them, or converts that array shape into anything a template can read directly.

### 2.2 What's NOT captured — and won't be simulated

- **Pinned criteria / sub-goal decomposition** — the judge (`mcp/src/judge.ts`) produces one overall `verdict`/`score`/`narrative`, never a criteria checklist or sub-goal breakdown.
- **Guardrail/eval "signals lane"** — Tether has no guardrails or evaluations at all (kept Trail-Cloud-only per `docs/superpowers/specs/2026-08-21-oss-self-hosted-open-core-design.md` §3's narrow-wedge scope decision).
- **Diffs on edit-type steps** — `trail_log_step`'s `input`/`output` are free text, never structured before/after content.
- **Context-window inspector** — already flagged as "likely only approximable" even in the original `trail` spec; not attempted here either.
- **Verdict override → eval dataset** — no eval dataset concept exists in Tether.

### 2.3 The reusable asset: `design/agent-observability-prototypes` (in `trail`, branch only, unmerged)

`flight-recorder.html` (843 lines) is a **self-contained, dependency-free, single-file** HTML/CSS/vanilla-JS prototype — no build step, no framework — built against a synthetic `RUNS` object keyed by run name, each entry holding goal/verdict/criteria/subgoals/steps/etc. Its rendering functions (`renderMission`, `renderStrip`, `renderSteps`, `renderVerdict`, `renderStepIO`, `renderInspector`, ~10 total) read directly from that in-memory object — there is no fetch/loading-state logic anywhere in it. This matches Tether's own zero-dependency, zero-build ethos closely enough that adapting it (swap the data source, delete the markup/JS for the cut features in §4) is the plan, not building a UI from scratch.

---

## 3. Target design

### 3.1 Serving architecture

No JSON API, no client-side fetch. Everything server-rendered per request, matching the prototype's existing "read a pre-populated object" structure:

- **`GET /`** — replaces today's placeholder page. A simple run list: goal, verdict badge, duration, relative time, linking into each run.
- **`GET /runs/:traceId`** — the adapted Flight Recorder page. The server computes that run's reshaped data and injects it as an inline `<script>const RUNS = {...}</script>` block (same shape the prototype already expects), then serves the rest of the prototype's HTML/CSS/JS untouched apart from the cuts in §4. A fresh full-page request per run — no SPA navigation, no partial reloads. Simpler than a JSON API for v1, and avoids writing any fetch/loading-state/error-state handling the prototype doesn't already have.

### 3.2 New backend module: `server/src/runs.ts`

- **`toAttributeMap(attributes: OtlpAttribute[]): Record<string, string | number | boolean>`** — converts the stored `[{key, value: {stringValue|intValue|doubleValue|boolValue}}]` shape into a plain object. Written once, used by everything else in this module. Pure function, directly testable.
- **`getRun(db, traceId): RunView | null`** — queries all spans for the trace (`WHERE traceId = ?`), separates the root span (`parentSpanId IS NULL`) from the rest, parses the root's attributes for goal/verdict/score/narrative/harness-manifest, reshapes every other span into an ordered `StepView` (relative start time in seconds from the root span's `startTimeUnixNano`, duration, status from OTLP `status.code`, cost/tokens when present, raw I/O parsed from the stored events), sorted by `startTimeUnixNano`. Returns `null` if no root span is found for that `traceId` (never throws — matches every other discovery/query function's degrade-gracefully contract in this codebase).
- **`listRuns(db, limit): RunSummary[]`** — root spans only (`parentSpanId IS NULL`), most recent first, capped at `limit`, each summarized to goal/verdict/duration/relative-time for the index page.
- **Step-type heuristic** (a pure function, `inferStepType(step): StepType`): `operation.name === "chat"` → `"llm"`; `gen_ai.tool.name` present → keyword-match the tool-name text against `read`/`edit`/`write`/`str_replace`/`run`/`exec`/`bash`/`test`/`search`/`grep`/`find` (case-insensitive substring match), falling back to `"tool"` if nothing matches; otherwise (an `execute_task` span with no tool name) → `"reason"`. Best-effort by construction — an unrecognized tool name still renders, just generically, never breaks the page.
- **Retry/loop detection** (a pure function operating on the ordered step list): flag `N` (configurable, default 3) or more consecutive steps sharing the same tool name and error status as a retry/loop signal, matching the prototype's existing `sig: [{kind: 'retry', count, detail}]` shape.

### 3.3 What ships from the prototype, and what's cut

**Ships (already-available real data, per §2.1):**
- Header: goal, verdict badge, score, judge model name (when a verdict exists — omitted entirely for runs with no judge configured, not faked).
- Judge narrative.
- Scrubbable step timeline: play/pause/speed controls, per-step expansion showing raw I/O.
- Step-type icons using the heuristic taxonomy (§3.2).
- Retry/loop signal markers on the timeline (heuristic, §3.2).
- Cost/token display per step where present (llm-kind steps only — other step types simply show no cost/token figure, an honest reflection of what's captured, not a gap to paper over).

**Cut entirely (markup + JS deleted, not just hidden) — matches §2.2:**
- Pinned criteria checklist.
- Sub-goal decomposition + implicated-step highlighting.
- Guardrail/eval "signals lane" (only the retry signal from §3.2 survives on that lane).
- Diffs on edit-type steps (the per-step expansion shows raw I/O text only).
- Context-window inspector.
- Verdict override UI.

---

## 4. Explicitly out of scope for this spec

- Harness anatomy, coverage overlay, usage analytics — the other three surfaces from `docs/superpowers/specs/2026-08-21-agent-harness-visualization-design.md`, downstream of this spec, not designed here.
- A JSON API layer — deliberately deferred; revisit only if a future need (e.g., the harness anatomy screen, or a live-updating run list) actually requires client-side fetching.
- Expanding what the judge/instrumentation captures (pinned criteria, sub-goals, diffs) — this spec works entirely within what's already captured; richer capture is separate, future instrumentation work, not a UI task.
- Visual/theming changes to the prototype's existing CSS beyond what's needed to delete the cut features cleanly — the prototype's look and feel carries over as-is for v1.

## 5. Open items requiring verification before implementation

- Confirm the prototype's rendering functions (`renderMission`, `renderStrip`, `renderSteps`, `renderVerdict`, `renderStepIO`, `renderInspector`, and the others) don't have hidden interdependencies on the fields being cut (§3.3) that would need more than deleting the obvious criteria/subgoals/signals/diff/context-inspector blocks — needs a careful read of the full 843-line file, not just the sampled sections read during this spec's research.
- Decide the exact retry-detection threshold (this spec proposes 3 consecutive same-tool-name failures as a default, matching the prototype's own synthetic `auth` run example) and whether it needs to be configurable or can be a hardcoded constant for v1.
- Confirm how a run with zero steps (only a root span — e.g., a `trail_start_run`/`trail_finish_run` pair with nothing logged in between) should render — the prototype's timeline/scrubber assumes at least one step exists.
- Confirm how a run with no judge configured (no `gen_ai.agent.verdict*` attributes at all) should render the header/verdict area — omit it entirely, or show an explicit "no verdict — judge not configured" state.
