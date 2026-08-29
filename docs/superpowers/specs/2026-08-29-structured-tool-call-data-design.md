# Tether — Structured Tool-Call & LLM-Call Data Design Spec (v1)

- **Status:** Approved — ready for implementation planning
- **Date:** 2026-08-29
- **Scope:** Phase 1 of the rich-debug-data roadmap. Replace the opaque free-text `input`/`output` (steps) and `prompt`/`completion` (LLM calls) strings with real structured JSON, and add stack trace / structured context to exceptions. This is a breaking change to the public `trail_log_step` / `trail_log_llm_call` / `trail_log_exception` MCP tool schemas, shipped as a `trailai-mcp` major version bump. Phases 2–6 (call tree, LLM telemetry, file diffs, retry-diff, run comparison) are out of scope here — see the memory note this spec traces back to for the full roadmap.

---

## 1. Why

Tether's pitch is "see behind the scenes" for sophisticated developers debugging their own agent harnesses. Today the richest data a run can carry — what a tool was actually called with, what it actually returned, what an LLM actually saw and said — is a pre-truncated free-text string the harness author chose to pass in (`mcp/src/index.ts`'s tool descriptions literally say "truncated result, diff summary…"). That's a lossy summary by construction, not the actual event. A developer trying to understand why a tool call went wrong, or why an LLM response was malformed, can't see the real arguments or the real message structure — only whatever prose the harness happened to log.

This spec makes the captured data structured (real JSON, not prose) and complete (full values, not pre-truncated summaries), while keeping the local-first, no-account, one-`spans`-table architecture intact. It also directly unlocks three of the five remaining roadmap phases: file diffs (a diff is just a structured field once output is real JSON), retry-diff capture (meaningfully comparing two attempts needs structured data), and better MCP-server-scoped debugging (structured tool args make per-call detail visible even though MCP servers stay name-only at the manifest level — an unrelated, deliberate scoping decision this spec doesn't revisit).

## 2. Where things stand today

Verified directly (2026-08-29) against `mcp/src/index.ts`, `mcp/src/otlp.ts`, and `server/src/runs.ts`:

- **`trail_log_step`** (`index.ts:123-177`) takes `input?: string` / `output?: string`. If present, each becomes a separate span *event* — `gen_ai.content.prompt` with attribute `gen_ai.prompt`, `gen_ai.content.completion` with attribute `gen_ai.completion` (`index.ts:169-171`).
- **`trail_log_llm_call`** (`index.ts:179-238`) takes `prompt?: string` / `completion?: string`, encoded the same way via the same two event names/attribute keys (`index.ts:230-232`).
- **`trail_log_exception`** (`index.ts:240-275`) takes `message: string`, `type?: string`, `name?: string` — no stack trace, no structured context. It sets `SpanInput.error = { message, type }` (`otlp.ts`'s `SpanInput.error` field, `otlp.ts:60`), which `buildPayload` turns into an `exception` event with `exception.type` / `exception.message` attributes (`otlp.ts:71-80`).
- **`otlp.ts`'s `AttrValue` type is `string | number | boolean`** (`otlp.ts:21`) — OTLP attributes are flat scalars today; there is no nested-object encoding anywhere in this codebase.
- **Server-side, `server/src/runs.ts`'s `buildStepIo`** (`runs.ts:158-170`) reads exactly those three event/attribute pairs back out — `gen_ai.content.prompt`/`gen_ai.prompt` → `io.push(["Input", …])`, `gen_ai.content.completion`/`gen_ai.completion` → `io.push(["Output", …])`, `exception`/`exception.message` → `io.push(["Error", …])` — and only accepts the value if `typeof === "string"` (`runs.ts:161,163,165`). `StepView.io` is typed `[string, string][]` (`runs.ts:26`).
- **Storage is schema-free below the attribute layer**: the `spans` table (`server/src/db.ts`) has exactly one JSON blob column, `raw`, holding the full OTLP span. Nothing here requires a table migration — every change in this spec is encode-side (mcp/) and decode-side (`runs.ts`) only.

## 3. Target design

### 3.1 MCP tool schema changes (`mcp/src/index.ts`)

- **`trail_log_step`**: `input`/`output` change from `z.string().optional()` to `z.unknown().optional()` — any JSON-serializable value (object, array, string, number, boolean).
- **`trail_log_llm_call`**: `prompt` changes from `z.string().optional()` to a messages array —
  ```ts
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
  })).optional()
  ```
  `completion` changes to a single assistant-shaped message: `z.object({ role: z.literal("assistant"), content: z.string(), tool_calls: z.unknown().optional() }).optional()`.
- **`trail_log_exception`**: two new optional fields — `stack?: z.string()` and `context?: z.unknown()`.

This is a breaking change: a caller still passing `prompt: "some string"` or `input: "some string"` will fail Zod validation against the new schemas. No dual-shape acceptance — see §6 for why.

### 3.2 Sanitization pipeline — new `mcp/src/sanitize.ts`

Before any structured value is sent, it passes through one new function, `sanitize(value: unknown): unknown`, applied at each of the six call sites (`trail_log_step`'s `input`/`output`, `trail_log_llm_call`'s `messages`/`completion`, `trail_log_exception`'s `stack`/`context`):

- Walks the value recursively. For every string leaf:
  1. **Redact** — checks against a fixed list of common secret patterns (API-key prefixes like `sk-`, `ghp_`, `AKIA`; `Bearer <token>`; `KEY=value`-shaped text where the key name contains `secret`/`password`/`token`/`api_key`). A match is replaced with `[REDACTED]`. This is best-effort pattern matching, not a guarantee — documented as such in `mcp/README.md`.
  2. **Truncate** — any string leaf over **16KB** is cut to that length with a trailing marker: `…[truncated, {originalBytes}b]`. Applied after redaction so a redacted marker is never itself truncated.
- Non-string leaves (numbers, booleans, null) and the object/array structure itself pass through unchanged — only string content is capped, so the shape of the data (which keys exist, how many array items) is always preserved even when a value inside it is cut.

### 3.3 Wire encoding — unchanged `otlp.ts` core

`AttrValue` stays `string | number | boolean` (`otlp.ts:21`) — no change to `toOtlpValue`/`toAttributes`. Each call site `JSON.stringify`s the sanitized value and sends it as the string value of the *same* event/attribute pairs that exist today:

| Field | Event name | Attribute key |
|---|---|---|
| step `input` | `gen_ai.content.prompt` | `gen_ai.prompt` |
| step `output` | `gen_ai.content.completion` | `gen_ai.completion` |
| llm `messages` | `gen_ai.content.prompt` | `gen_ai.prompt` |
| llm `completion` | `gen_ai.content.completion` | `gen_ai.completion` |
| exception `stack` | *(folded into the existing `exception` event)* | `exception.stacktrace` *(new attribute, matches OTel semantic-convention naming)* |
| exception `context` | `gen_ai.content.context` *(new event name)* | `gen_ai.context` *(new attribute)* |

`otlp.ts`'s `SpanInput.error` type gains one optional field: `stack?: string`, and `buildPayload`'s existing exception-event construction (`otlp.ts:71-80`) adds `"exception.stacktrace": span.error.stack` when present — reusing the event OTel's own semantic conventions already define for exceptions, rather than inventing a parallel one. `context` has no natural home in the existing `error` object (it's specific to `trail_log_exception`, not the generic step/llm-call error path), so it's sent as its own event, following the same pattern `gen_ai.content.prompt`/`completion` already establish.

### 3.4 Server-side read/parse changes (`server/src/runs.ts`)

`buildStepIo` (`runs.ts:158-170`) changes its string-handling to attempt structured decoding first:

```ts
function decodeIoValue(raw: string): string | unknown {
  try {
    return JSON.parse(raw); // new-format: sanitized structured value, JSON.stringify'd
  } catch {
    return raw; // legacy: a plain string sent by a pre-Phase-1 client, stored as-is
  }
}
```

This distinguishes the two cases correctly because `JSON.stringify` always quotes string values — a new-format string field arrives as `"hello"` (parses back to the string `hello`), while a legacy plain-text value like `password=abc123` is not valid JSON and falls through to the catch branch unchanged. Old spans already in someone's local `spans.raw` continue to render exactly as they do today; nothing is migrated or rewritten.

`StepView.io`'s type changes from `[string, string][]` to `[string, string | unknown][]` to carry the decoded value through. The same `decodeIoValue` treatment applies to the new `exception.stacktrace` attribute and `gen_ai.content.context`/`gen_ai.context` event, added as two more `io.push([...])` branches in `buildStepIo` (`["Stack", …]`, `["Context", …]`).

### 3.5 UI rendering (`server/src/static/app.ts` + templates)

The Flight Recorder inspector's Input/Output/Error blocks (plus the new Stack/Context entries) branch on `typeof value`:

- `string` → renders exactly as today, as plain text.
- anything else (object, array, number, boolean) → renders as a small hand-rolled collapsible JSON tree: indented, expand/collapse per object/array node, syntax-colored by value type (string/number/boolean/null). No third-party library — this codebase has no bundler (per `CLAUDE.md`'s build-config note) and the existing UI is vanilla JS/CSS throughout, so this is a new, self-contained renderer function alongside the existing template code, not a dependency addition.
- LLM-call `messages[]` specifically render as a role-labeled list (a small header per message: `system`/`user`/`assistant`/`tool`), each with its own collapsible `content` block if long — distinguishing it from the generic JSON-tree treatment because the role structure is meaningful and worth surfacing directly rather than as generic nested JSON.

### 3.6 Versioning

`trailai-mcp` ships this as a **major version bump** (breaking tool-schema change) with a `CHANGELOG.md` entry and a `README.md` migration note showing the old vs. new shapes for all three affected tools. `trailai-tether` (the server) needs no version coupling — it already renders whatever it finds in `raw` (§3.4's fallback), so an old `trailai-mcp` client and a new one can point at the same running server without issue; only the *producer* package version matters to a given caller's integration.

### 3.7 Testing

- **`mcp/test/`**: schema-validation tests for the new `input`/`output`/`messages`/`completion`/`stack`/`context` shapes (accepts structured JSON, rejects the old bare-string-as-prompt shape where the schema now expects an array/object). Dedicated tests for `sanitize.ts`: redaction pattern hits and near-miss non-matches, truncation at/under/over the 16KB boundary, and confirming object/array shape survives truncation of a nested string leaf.
- **`server/test/`**: `buildStepIo`/`decodeIoValue` tests covering (a) a legacy plain-string event (pre-Phase-1 shape), (b) a new JSON-stringified structured value, (c) a new JSON-stringified plain string value (the `"hello"` case, confirming it decodes to `hello` not `"hello"`), and (d) the new `exception.stacktrace`/`gen_ai.content.context` branches.

## 4. Data flow summary

```
harness code
     │  calls trail_log_step({ input: {...}, output: {...} })
     ▼
mcp/src/index.ts tool handler
     │  sanitize(value)  ──▶  redact secret patterns, truncate long strings
     ▼
JSON.stringify(sanitized)
     │
     ▼
otlp.ts buildPayload()  ──  unchanged AttrValue = string|number|boolean,
     │                      structured value now travels as a JSON string
     ▼
POST /traces  ──▶  server/src/db.ts  spans.raw  (unchanged JSON blob column)
     │
     ▼
server/src/runs.ts buildStepIo() / decodeIoValue()
     │  JSON.parse succeeds → structured value
     │  JSON.parse throws   → legacy plain string, pass through
     ▼
StepView.io: [string, string | unknown][]
     │
     ▼
Flight Recorder inspector — string ⇒ plain text, else ⇒ collapsible JSON tree
```

## 5. Explicitly out of scope for v1

- **Call tree / parent-child step hierarchy** (Phase 2) — `parentSpanId` is already stored but this spec doesn't change how steps are flattened into `RunView.steps`.
- **Context-window composition and per-call latency breakdown** (Phase 3) — no new fields added to `trail_log_llm_call` beyond `messages`/`completion` restructuring; token/timing telemetry is untouched.
- **File-diff-specific rendering** (Phase 4) — a diff can now travel as a structured `output` value (e.g. `{ type: "diff", unified: "..." }`), but this spec adds no dedicated diff UI treatment or convention for what shape an edit-tool's output should take. That's Phase 4's job.
- **Retry-diff capture** (Phase 5) — `detectRetries` (`runs.ts:174+`) is untouched; it still only compares step title/status, not the new structured `input`/`output` between repeated attempts.
- **Run-to-run comparison** (Phase 6) — no comparison UI added.
- **True nested OTLP `AnyValue` encoding** (kvlist/array value types) — considered and explicitly rejected for v1 (§6) in favor of JSON-string-in-attribute.
- **Any redaction/size-cap enforcement on the server side** — both are producer-side (`mcp/`) only; a non-Tether OTLP client sending directly to `POST /traces` bypasses them entirely. Documented as a known limitation, not silently assumed away.
- **Migrating or rewriting already-ingested `spans` rows** — old data stays in its original shape forever; only the read path gained a fallback.

## 6. Open items resolved during this spec's authoring

- **Backward compatibility strategy** — resolved as a hard break on the MCP tool schema (major version bump, no dual-shape acceptance in `mcp/`) paired with permanent read-side tolerance in `server/` for already-ingested legacy data. A dual-shape *producer*-side schema was considered and rejected: accepting `z.union([z.string(), z.unknown()])` on every field would keep every downstream consumer (UI, future Phase 2-6 work) branching on shape indefinitely, for the sole benefit of not requiring a version bump on a tool that's still pre-1.0 and narrow in current install base.
- **Wire encoding: JSON-string-in-attribute vs. true nested OTLP `AnyValue`** — resolved in favor of JSON-string-in-attribute. Tether owns both ends of this wire (its own MCP client, its own ingestion endpoint), so `AnyValue`'s spec-correctness benefit (better interop with a generic third-party OTel collector someone might point at the same data) doesn't pay for the larger `otlp.ts`/decode-side change it would require.
- **Size limits** — resolved as producer-side-only enforcement (`sanitize.ts`, 16KB per string leaf) rather than no cap or server-side enforcement, to keep the local SQLite file and HTTP payload sizes bounded regardless of what a harness passes in, without adding ingest-side validation logic to `server/`.
- **Secret redaction** — resolved as best-effort pattern matching on the producer side, explicitly documented as imperfect rather than promised as a guarantee, matching this codebase's existing posture on MCP-server manifest data ("those routinely hold secrets" — `mcp/src/manifest.ts`'s comment on why command/args/env are excluded from the harness manifest).
- **Whether to fold exception enrichment into this phase** — resolved yes: `stack`/`context` added to `trail_log_exception` now rather than as a separate future breaking change, since this spec already forces one `trailai-mcp` major version bump and exceptions are a core debugging surface for the tool's target audience.
