# Tether — File Diffs Design Spec (v1)

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-09-03
- **Scope:** Phase 4 of the rich-debug-data roadmap, promoted ahead of Phase 2 (see §2.1). Give edit-type steps a first-class, structured record of what actually changed on disk: a new optional `diffs` parameter on `trail_log_step`, hunk-aware sanitization, a first-class `StepView.diffs` field, and a diff renderer in the Flight Recorder. Additive on every boundary — no existing caller or plugin breaks. Shipped as `trailai-mcp` 0.4.0.

---

## 1. Why

Tether's pitch is "see behind the scenes" for developers debugging their own agent harnesses. The single most common thing an agent does that a developer needs to audit is **change a file** — and today that change is invisible. `inferStepType` (`server/src/runs.ts:93`) already classifies a step as `edit` from its tool name, so the UI knows an edit happened; it just has nothing to show about *what* the edit was beyond whatever prose the harness passed as `output`.

Phase 1 made step output real structured JSON, which is what makes this cheap: a diff is a structured field on a step, not a new mechanism. This spec adds the field, the size policy it needs, and the rendering.

## 2. Where things stand today

Verified directly against source on 2026-09-03:

- **No diff handling exists anywhere.** A repo-wide search over `mcp/src` and `server/src` finds no diff/patch/hunk logic. The only `diff` identifiers are unrelated (relative-time arithmetic in `server/src/templates/rail.ts`).
- **`trail_log_step`** (`mcp/src/tools.ts:212`) takes `input?: unknown` / `output?: unknown` post-Phase-1, built into a span by `buildStepSpan` (`mcp/src/tools.ts:50`).
- **`sanitize()`** (`mcp/src/sanitize.ts:30`) redacts and truncates every string leaf, defaulting to `maxBytes = 16384`. `truncate` (`sanitize.ts:23`) cuts mid-string and appends `…[truncated, Nb]`; `redact` (`sanitize.ts:15`) applies secret patterns.
- **`StepView`** (`server/src/runs.ts:18`) carries `io: [string, string | unknown][]` (`runs.ts:36`), assembled by `buildStepIo` (`runs.ts:180`).
- **The UI already dispatches on value shape.** `renderIoPair` (`server/src/static/app.ts:69`) branches: string → block, `isMessageList` (`app.ts:43`) → `renderMessages` (`app.ts:47`), else → `renderJsonNode` (`app.ts:51`).

### 2.1 Why this is Phase 4 and not Phase 2

The roadmap sequenced the call tree second on the belief it was near-free — "`parentSpanId` is already stored, just not surfaced, API/UI-only." That premise proved false: all three span builders in `mcp/src/tools.ts` hardcode `parentSpanId: run.rootSpanId` (lines 70, 124, 155), so every span is a direct child of the root and there is no hierarchy in the data to surface. A real tree needs producer changes, a breaking API reshape, and edits across coverage and the timeline — to display a structure nothing populates.

Phase 2 was therefore reduced to its one honest, non-breaking piece — exposing `StepView.id`/`parentId` so hierarchy is *expressible* (commit `a015b7c`) — and Phase 4 promoted ahead of it. Phase 4's premise was re-verified rather than inherited, and it holds with one caveat, which §3.2 addresses.

## 3. Target design

### 3.1 MCP tool schema change (`mcp/src/tools.ts`)

`trail_log_step` gains:

```ts
diffs: z.array(z.object({
  path: z.string().describe("File path the change applies to"),
  diff: z.string().describe("Unified diff of the change"),
})).optional().describe("File changes this step made, as unified diffs")
```

An **array**, because one refactor step legitimately touches several files; adding multi-file support later would be a breaking reshape.

An **explicit schema parameter**, not a convention inside `output`. The `isMessageList` precedent looks like shape-detection, but the shape it detects was guaranteed by a schema'd parameter on `trail_log_llm_call` — the schema defines, the renderer detects. This matters beyond style: agents populate what the tool schema advertises, so a docs-only convention would go unpopulated.

Only `trail_log_step` gains this. LLM calls and exceptions do not make file changes.

### 3.2 Hunk-aware sanitization (`mcp/src/sanitize.ts`)

The generic 16KB-per-leaf rule is wrong for diffs in two ways: real diffs routinely exceed it, and a mid-string cut leaves a mangled half-hunk that is unreadable rather than merely partial.

A diff-specific path, used only for the `diffs` field:

1. Split the diff into its file header (the `---`/`+++` lines, where present) and its hunks, on `@@` boundaries.
2. **Redact the header and each hunk** with the existing `redact` — a diff of a `.env` or a credentials file must not bypass secret scrubbing. This is not optional and must be covered by a test.
3. **Always keep the file header**, outside the budget. It is a bounded handful of bytes, and a diff without it is ambiguous about what it applies to.

   This holds only when the input actually parses as a unified diff. A `diff` string containing no `@@` hunk at all is not a header — it is unstructured text of unknown size, so it is byte-truncated to the entry budget like any other string, with `hunksTotal: 0`. Treating it as a header would let malformed input bypass the budget entirely.
4. Fill the byte budget with **whole hunks only**, never a partial one, admitting them in file order.
5. Record what was dropped as structured fields on the entry: `hunksShown`, `hunksTotal`, `bytesOmitted`, and `partialHunk` (a boolean, see below).

**Two budgets, both required:**

- **256KB per diff entry**, so one enormous file cannot crowd out every other file's changes.
- **1MB per step across all entries combined.** Without this, a step touching 50 files could emit 12.8MB into a single span. Entries are filled in array order; once the step budget is exhausted, later entries keep their header and record `hunksShown: 0` rather than vanishing — a file that was changed must still appear as changed.

A single hunk larger than the *entry* budget is the one case where a partial hunk is unavoidable: it falls back to byte truncation and sets `partialHunk: true`, so the UI can distinguish "some hunks omitted" from "this hunk itself was cut mid-way." It is never dropped silently.

Other string leaves keep the existing 16KB rule unchanged. This is producer-side only, consistent with Phase 1's decision that truncation and redaction happen before the wire.

### 3.3 Wire encoding

Reuse Phase 1's JSON-string-in-attribute encoding. No second mechanism, no `otlp.ts` core change.

### 3.4 Server-side decode (`server/src/runs.ts`)

`StepView` gains a first-class optional `diffs` field carrying `path`, `diff`, and the truncation counts.

Deliberately **not** folded into `io`. `io` is free-form "what went in and out"; diffs are structured and first-class, and overloading `io` would make both harder for a plugin to consume. Absent field means absent — legacy runs and non-edit steps simply have none, with no fallback shape to guess at.

Decoding follows the file's stated contract: degrade, never throw. A `diffs` value that isn't the expected shape is ignored rather than crashing the run.

### 3.5 UI (`server/src/static/app.ts`)

A dedicated `renderDiffs` function called from `renderStepIO` (`app.ts:262`), rendered as its own block in the step's I/O panel.

Note this is *not* a branch inside `renderIoPair` (`app.ts:69`): that function renders `io` pairs, and §3.4 deliberately keeps `diffs` out of `io`. The shape-dispatch pattern is the precedent being followed, not the function being extended.

- Per-file header showing `path`.
- `+`/`-` line coloring, using the existing theme tokens.
- A truncation banner whenever anything was dropped, reading like **"3 of 11 hunks shown, 47KB omitted"** — and, when `partialHunk` is set, saying that the last shown hunk is itself cut, since a hunk that ends mid-context is otherwise easy to misread as complete.
- An entry with `hunksShown: 0` still renders its header, marked as changed-but-not-shown, so a file dropped by the step budget is visible rather than absent.

**Truncation must always announce itself.** Omitted data that looks complete is worse than visibly partial data — a developer who cannot tell a diff was cut will draw wrong conclusions from it.

A `diff` string that is not valid unified format renders as plain text rather than being dropped or throwing, matching `runs.ts`'s degrade-never-throw contract.

### 3.6 Plugin contract

`StepView.diffs` is additive: `steps` keeps its shape, order, and every existing field. `server/README.md`'s "What a plugin can read" section is updated **in the same change**, not afterward — Phase 1's final review caught a silently widened plugin contract, and this spec does not repeat that.

### 3.7 Versioning

`trailai-mcp` 0.3.0 → 0.4.0. Additive and non-breaking: callers that pass no `diffs` behave exactly as before.

### 3.8 Testing

- **`sanitize`:** hunk budgeting at the boundary; redaction inside hunks *and* in the file header; a single hunk larger than the entry budget (sets `partialHunk`); the per-step budget exhausting across multiple entries (later entries keep headers, `hunksShown: 0`); malformed/non-diff input; an empty diff.
- **`tools.ts`:** `diffs` threaded into the span; absent `diffs` produces a span identical to today's.
- **`runs.ts`:** decode; absent field; malformed shape ignored; a legacy pre-0.4.0 run.
- **UI:** diff rendering, the truncation banner, and non-unified text falling back to plain rendering.

## 4. Explicitly out of scope for v1

- **Verifying diffs against disk.** The MCP server is an out-of-band recorder, not in the execution path. Diffs are agent-reported, and the design is honest about that rather than pretending to observe them.
- **Deriving diffs from git.** Misses uncommitted intermediate states, breaks in non-git projects, races with concurrent edits.
- **Aggregating diffs across steps** into a per-run changeset — a plausible follow-up, not needed to make a single step legible.
- **Retention/size policy for the span store** as diffs grow it. Real, but a storage concern spanning every payload type, not a diff feature.
- **Rendering diffs anywhere but the step I/O panel.**

## 5. Known limitation, stated rather than buried

This shares Phase 2's dependency on agent cooperation: if harnesses never pass `diffs`, the feature stays empty. The difference is that an explicit, described schema parameter is self-advertising, where Phase 2 required agents to thread span ids across separate calls with nothing prompting them to. That is a real difference in likelihood, not a guarantee — and if adoption does not materialize, that is evidence about the instrumentation surface, not a reason to add a mechanism that fabricates the data.
