# File Diffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give edit-type steps a first-class, structured record of what changed on disk — an optional `diffs` parameter on `trail_log_step`, hunk-aware sanitization, a `StepView.diffs` field, and a diff renderer in the Flight Recorder.

**Architecture:** Additive on every boundary. The agent supplies unified diffs; the MCP client redacts and budget-truncates them at whole-hunk boundaries; they travel as a JSON-string-in-attribute span event exactly like Phase 1's structured io; the server decodes them into a first-class `StepView.diffs` field (deliberately not into `io`); the UI renders them as their own block with an explicit truncation banner.

**Tech Stack:** TypeScript, zod (MCP tool schemas), `node --test` (both suites), plain `node:http` + vanilla DOM on the server side. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-file-diffs-design.md`

## Global Constraints

- **Additive only.** `steps` keeps its shape, order, and every existing field. A caller that passes no `diffs` must produce a span byte-identical to today's.
- **`trailai-mcp` version:** 0.3.0 → **0.4.0** (additive feature, pre-1.0).
- **Redaction is never bypassed.** Every diff string — file header included — goes through the existing `redact` before it leaves the process.
- **Truncation always announces itself.** Any dropped content must be visible in the UI. Data that looks complete but isn't is worse than data that is visibly partial.
- **Degrade, never throw.** `server/src/runs.ts` and `mcp/src/sanitize.ts` must return sane values on malformed input rather than raising — malformed data arrives from unauthenticated ingest.
- **Budgets:** 256KB per diff entry (`DIFF_ENTRY_BUDGET`), 1MB per step across all entries (`DIFF_STEP_BUDGET`).
- **Build before test.** Both suites run against `dist/`. `npm test` does **not** build. Always `npm run build && npm test`.
- **`server/tsconfig.json` needs `moduleDetection: "legacy"`** and `app.ts` must have zero top-level `import`/`export` statements — it is loaded as a classic browser script. Use `import(...)` type-queries inside type positions only. See root `CLAUDE.md`.

---

### Task 1: Hunk-aware diff sanitization

**Files:**
- Modify: `mcp/src/sanitize.ts`
- Test: `mcp/test/sanitize.test.js`

**Interfaces:**
- Consumes: existing `redact()` and `truncate()` (module-private, `sanitize.ts:15` and `:23`).
- Produces: `export interface DiffInput { path: string; diff: string }`, `export interface DiffEntry { path: string; diff: string; hunksShown: number; hunksTotal: number; bytesOmitted: number; partialHunk: boolean }`, and `export function sanitizeDiffs(entries: DiffInput[]): DiffEntry[]`. Tasks 2 and 3 depend on these exact names and field names.

- [ ] **Step 1: Write the failing tests**

First change the existing import at the top of `mcp/test/sanitize.test.js` from `import { sanitize } from "../dist/sanitize.js";` to:

```js
import { sanitize, sanitizeDiffs } from "../dist/sanitize.js";
```

Then append to the same file (do not add a second import):

```js
const HUNK_A = "@@ -1,3 +1,3 @@\n-old line\n+new line\n context\n";
const HUNK_B = "@@ -10,2 +10,3 @@\n context\n+added line\n";
const HEADER = "--- a/auth.py\n+++ b/auth.py\n";

describe("sanitizeDiffs", () => {
	test("keeps a small diff whole and reports no omission", () => {
		const [e] = sanitizeDiffs([{ path: "auth.py", diff: HEADER + HUNK_A + HUNK_B }]);
		assert.equal(e.path, "auth.py");
		assert.equal(e.hunksShown, 2);
		assert.equal(e.hunksTotal, 2);
		assert.equal(e.bytesOmitted, 0);
		assert.equal(e.partialHunk, false);
		assert.ok(e.diff.includes("--- a/auth.py"));
		assert.ok(e.diff.includes("+added line"));
	});

	test("redacts secrets inside a hunk body", () => {
		const [e] = sanitizeDiffs([{ path: ".env", diff: HEADER + "@@ -1 +1 @@\n+api_key=\"abc123def456\"\n" }]);
		assert.ok(!e.diff.includes("abc123def456"), "secret must not survive");
		assert.ok(e.diff.includes("[REDACTED]"));
	});

	test("redacts secrets in the file header too", () => {
		const [e] = sanitizeDiffs([{ path: "x", diff: "--- a/sk-abcdefghij1234567890\n+++ b/x\n" + HUNK_A }]);
		assert.ok(!e.diff.includes("sk-abcdefghij1234567890"));
	});

	test("drops whole hunks past the entry budget and never emits a partial one", () => {
		const big = "@@ -1,1 +1,1 @@\n+" + "x".repeat(300 * 1024) + "\n";
		const [e] = sanitizeDiffs([{ path: "big.txt", diff: HEADER + HUNK_A + big + HUNK_B }]);
		assert.equal(e.hunksTotal, 3);
		assert.ok(e.hunksShown < 3, "the oversized hunk must not all fit");
		assert.ok(e.bytesOmitted > 0);
		assert.equal(e.partialHunk, false, "whole hunks fit, so nothing is cut mid-hunk");
	});

	test("falls back to a partial hunk only when one hunk alone exceeds the entry budget", () => {
		const huge = "@@ -1,1 +1,1 @@\n+" + "y".repeat(300 * 1024) + "\n";
		const [e] = sanitizeDiffs([{ path: "huge.txt", diff: HEADER + huge }]);
		assert.equal(e.partialHunk, true);
		assert.equal(e.hunksShown, 1);
		assert.ok(e.bytesOmitted > 0);
	});

	test("exhausts the per-step budget across entries, keeping later headers with hunksShown 0", () => {
		const heavy = HEADER + "@@ -1,1 +1,1 @@\n+" + "z".repeat(250 * 1024) + "\n";
		const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ path: `f${n}.txt`, diff: heavy }));
		const out = sanitizeDiffs(entries);
		assert.equal(out.length, 6, "every changed file still appears");
		const last = out[out.length - 1];
		assert.equal(last.hunksShown, 0, "step budget exhausted");
		assert.ok(last.diff.includes("--- a/auth.py"), "header survives so the file is still identifiable");
		assert.ok(last.bytesOmitted > 0);
	});

	test("byte-truncates a string with no @@ hunk instead of exempting it as a header", () => {
		const [e] = sanitizeDiffs([{ path: "notadiff.txt", diff: "q".repeat(400 * 1024) }]);
		assert.equal(e.hunksTotal, 0);
		assert.ok(Buffer.byteLength(e.diff, "utf8") < 300 * 1024, "must not bypass the budget");
		assert.ok(e.bytesOmitted > 0);
	});

	test("handles an empty diff without throwing", () => {
		const [e] = sanitizeDiffs([{ path: "empty", diff: "" }]);
		assert.equal(e.hunksTotal, 0);
		assert.equal(e.diff, "");
		assert.equal(e.bytesOmitted, 0);
	});

	test("returns an empty array for an empty entry list", () => {
		assert.deepEqual(sanitizeDiffs([]), []);
	});
});
```

Replace the existing `import { sanitize } from "../dist/sanitize.js";` line at the top of the file with the combined import shown above — do not add a second import statement.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: FAIL — `sanitizeDiffs is not a function` (the build succeeds; the export does not exist yet).

- [ ] **Step 3: Implement `sanitizeDiffs`**

Append to `mcp/src/sanitize.ts`:

```ts
/** 256KB per diff entry, so one enormous file can't crowd out every other file's changes. */
const DIFF_ENTRY_BUDGET = 262144;
/** 1MB per step across all entries, so a step touching many files can't emit megabytes into one span. */
const DIFF_STEP_BUDGET = 1048576;

export interface DiffInput {
	path: string;
	diff: string;
}

export interface DiffEntry {
	path: string;
	diff: string;
	hunksShown: number;
	hunksTotal: number;
	bytesOmitted: number;
	partialHunk: boolean;
}

/**
 * Splits a unified diff into its leading file header (the ---/+++ lines) and its @@ hunks.
 * A string with no @@ at all has no header by definition -- it's unstructured text of unknown
 * size, so it comes back as `hunks: []` with the whole string as `body` for the caller to
 * budget-truncate. Treating it as a header would let malformed input bypass the budget.
 */
function splitHunks(diff: string): { header: string; hunks: string[]; body: string | null } {
	const idx = diff.search(/^@@/m);
	if (idx === -1) return { header: "", hunks: [], body: diff };
	return {
		header: diff.slice(0, idx),
		hunks: diff.slice(idx).split(/^(?=@@)/m).filter((h) => h.length > 0),
		body: null,
	};
}

/**
 * Redacts and budget-truncates agent-supplied file diffs at whole-hunk boundaries. A diff cut
 * mid-hunk is unreadable rather than merely partial, so hunks are admitted whole and what was
 * dropped is reported rather than hidden -- the UI is required to surface it.
 */
export function sanitizeDiffs(entries: DiffInput[]): DiffEntry[] {
	let remaining = DIFF_STEP_BUDGET;
	const out: DiffEntry[] = [];

	for (const entry of entries) {
		const path = redact(entry.path);
		const { header, hunks, body } = splitHunks(entry.diff);
		const budget = Math.min(DIFF_ENTRY_BUDGET, remaining);

		if (body !== null) {
			// No hunks: unstructured text. Byte-truncate like any other string.
			const safe = redact(body);
			const size = Buffer.byteLength(safe, "utf8");
			const kept = size <= budget ? safe : truncate(safe, budget);
			const used = Buffer.byteLength(kept, "utf8");
			remaining = Math.max(0, remaining - used);
			out.push({ path, diff: kept, hunksShown: 0, hunksTotal: 0, bytesOmitted: Math.max(0, size - used), partialHunk: false });
			continue;
		}

		const safeHeader = redact(header);
		const kept: string[] = [];
		let used = 0, shown = 0, omitted = 0, partial = false;

		for (const hunk of hunks) {
			const safe = redact(hunk);
			const size = Buffer.byteLength(safe, "utf8");
			if (used + size <= budget) {
				kept.push(safe);
				used += size;
				shown += 1;
				continue;
			}
			if (shown === 0 && budget > 0) {
				// One hunk alone exceeds the entry budget -- the only case where a partial hunk
				// beats showing nothing. Flagged so the UI can say the hunk itself is cut.
				const cut = truncate(safe, budget);
				const cutSize = Buffer.byteLength(cut, "utf8");
				kept.push(cut);
				used += cutSize;
				shown += 1;
				partial = true;
				omitted += Math.max(0, size - cutSize);
				continue;
			}
			omitted += size;
		}

		remaining = Math.max(0, remaining - used);
		out.push({
			path,
			diff: safeHeader + kept.join(""),
			hunksShown: shown,
			hunksTotal: hunks.length,
			bytesOmitted: omitted,
			partialHunk: partial,
		});
	}

	return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/sanitize.ts mcp/test/sanitize.test.js
git commit -m "feat(mcp): add hunk-aware sanitization for file diffs"
```

---

### Task 2: Accept `diffs` on `trail_log_step`

**Files:**
- Modify: `mcp/src/tools.ts` (`buildStepSpan` at `:50`, `trail_log_step` registration at `:212`)
- Test: `mcp/test/tools.test.js`

**Interfaces:**
- Consumes: `sanitizeDiffs`, `DiffInput` from Task 1.
- Produces: span event `gen_ai.content.diffs` carrying attribute `gen_ai.diffs` = `JSON.stringify(DiffEntry[])`. Task 3 decodes exactly this event and attribute name.

- [ ] **Step 1: Write the failing tests**

Append to `mcp/test/tools.test.js`. The file already defines a module-level `RUN` constant (`{ traceId: "t".repeat(32), rootSpanId: "r".repeat(16), agent: "coding-agent" }`) — reuse it, do not redefine it:

```js
describe("buildStepSpan — diffs", () => {
	const base = { name: "edit auth.py", kind: "tool", status: "ok" };

	test("emits a gen_ai.content.diffs event carrying sanitized entries", () => {
		const span = buildStepSpan(RUN, "s1", "1000", "2000", {
			...base,
			diffs: [{ path: "auth.py", diff: "--- a/auth.py\n+++ b/auth.py\n@@ -1 +1 @@\n-a\n+b\n" }],
		});
		const ev = span.events.find((e) => e.name === "gen_ai.content.diffs");
		assert.ok(ev, "diffs event must be present");
		const parsed = JSON.parse(ev.attributes["gen_ai.diffs"]);
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].path, "auth.py");
		assert.equal(parsed[0].hunksTotal, 1);
		assert.equal(parsed[0].hunksShown, 1);
	});

	test("omits the event entirely when diffs is absent", () => {
		const span = buildStepSpan(RUN, "s1", "1000", "2000", base);
		assert.equal(span.events.find((e) => e.name === "gen_ai.content.diffs"), undefined);
	});

	test("omits the event when diffs is an empty array", () => {
		const span = buildStepSpan(RUN, "s1", "1000", "2000", { ...base, diffs: [] });
		assert.equal(span.events.find((e) => e.name === "gen_ai.content.diffs"), undefined);
	});

	test("a span with no diffs is unchanged from a span built without the field", () => {
		const withField = buildStepSpan(RUN, "s1", "1000", "2000", { ...base, diffs: undefined });
		const without = buildStepSpan(RUN, "s1", "1000", "2000", base);
		assert.deepEqual(withField, without);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: FAIL — the `gen_ai.content.diffs` event is missing.

- [ ] **Step 3: Thread `diffs` through `buildStepSpan` and the tool schema**

In `mcp/src/tools.ts`, add `sanitizeDiffs` and `DiffInput` to the existing import from `./sanitize.js`.

Add to `buildStepSpan`'s `args` object type (after `output?: unknown;`):

```ts
		diffs?: DiffInput[];
```

Add to `buildStepSpan`'s `events` array, after the `gen_ai.content.completion` entry:

```ts
			...(args.diffs !== undefined && args.diffs.length > 0
				? [{ name: "gen_ai.content.diffs", attributes: { "gen_ai.diffs": JSON.stringify(sanitizeDiffs(args.diffs)) } }]
				: []),
```

Add to `trail_log_step`'s `inputSchema`, after `output`:

```ts
				diffs: z.array(z.object({
					path: z.string().describe("File path the change applies to"),
					diff: z.string().describe("Unified diff of the change"),
				})).optional().describe("File changes this step made, as unified diffs — large diffs are truncated at whole-hunk boundaries"),
```

Destructure `diffs` in the handler's parameter list and pass it through to `buildStepSpan`:

```ts
			await sendSpan(cfg, buildStepSpan(run, hexId(8), start, end, { name, kind, input, output, status, error_message, source_type, source_name, diffs }));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools.ts mcp/test/tools.test.js
git commit -m "feat(mcp): accept file diffs on trail_log_step"
```

---

### Task 3: Decode diffs into `StepView.diffs` and document the contract

**Files:**
- Modify: `server/src/runs.ts` (`StepView` at `:18`, near `buildStepIo` at `:180`, and the `steps.push` in `getRun`)
- Modify: `server/README.md` ("What a plugin can read" section)
- Test: `server/test/runs.test.js`

**Interfaces:**
- Consumes: the `gen_ai.content.diffs` event / `gen_ai.diffs` attribute from Task 2.
- Produces: `export interface DiffView { path: string; diff: string; hunksShown: number; hunksTotal: number; bytesOmitted: number; partialHunk: boolean }` and an optional `diffs?: DiffView[]` field on `StepView`. Task 4 renders exactly these field names.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/runs.test.js`, inside the existing `describe("getRun", ...)` block. Note the existing `stepSpan` helper does not build diff events, so this test constructs the span directly in the same style the file already uses for its other raw-span helpers:

```js
	function diffStepSpan({ traceId, spanId, parentSpanId, name, startNs, endNs, diffs }) {
		const attrs = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name };
		const events = diffs === undefined ? [] : [{ name: "gen_ai.content.diffs", attributes: otlpAttrs({ "gen_ai.diffs": JSON.stringify(diffs) }) }];
		const raw = { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, attributes: otlpAttrs(attrs), events, status: { code: 1 } };
		return { traceId, spanId, parentSpanId, name, startTimeUnixNano: startNs, endTimeUnixNano: endNs, raw: JSON.stringify(raw) };
	}

	test("decodes a step's file diffs into StepView.diffs", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "td", spanId: "rd", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1030000000000" }));
			insertSpan(db, diffStepSpan({
				traceId: "td", spanId: "s1", parentSpanId: "rd", name: "edit auth.py",
				startNs: "1005000000000", endNs: "1010000000000",
				diffs: [{ path: "auth.py", diff: "@@ -1 +1 @@\n-a\n+b\n", hunksShown: 1, hunksTotal: 3, bytesOmitted: 900, partialHunk: false }],
			}));
			const run = getRun(db, "td");
			assert.equal(run.steps[0].diffs.length, 1);
			assert.equal(run.steps[0].diffs[0].path, "auth.py");
			assert.equal(run.steps[0].diffs[0].hunksTotal, 3);
			assert.equal(run.steps[0].diffs[0].bytesOmitted, 900);
			assert.equal(run.steps[0].diffs[0].partialHunk, false);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("leaves diffs undefined for a step that logged none, and keeps io untouched", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "td2", spanId: "rd2", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1030000000000" }));
			insertSpan(db, stepSpan({ traceId: "td2", spanId: "s1", parentSpanId: "rd2", name: "read auth.py", startNs: "1005000000000", endNs: "1010000000000", toolName: "read auth.py" }));
			const run = getRun(db, "td2");
			assert.equal(run.steps[0].diffs, undefined);
			assert.ok(Array.isArray(run.steps[0].io), "io must be unaffected by this change");
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("ignores a malformed diffs payload rather than throwing", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, rootSpan({ traceId: "td3", spanId: "rd3", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1030000000000" }));
			insertSpan(db, diffStepSpan({ traceId: "td3", spanId: "s1", parentSpanId: "rd3", name: "edit x", startNs: "1005000000000", endNs: "1010000000000", diffs: { not: "an array" } }));
			insertSpan(db, diffStepSpan({ traceId: "td3", spanId: "s2", parentSpanId: "rd3", name: "edit y", startNs: "1011000000000", endNs: "1012000000000", diffs: [{ path: 42, diff: null }] }));
			const run = getRun(db, "td3");
			assert.equal(run.steps.length, 2, "malformed diffs must not drop the steps");
			assert.equal(run.steps[0].diffs, undefined);
			assert.equal(run.steps[1].diffs, undefined);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: FAIL — `run.steps[0].diffs` is `undefined` in the first test.

- [ ] **Step 3: Implement the decode**

In `server/src/runs.ts`, add above `StepView`:

```ts
export interface DiffView {
	path: string;
	diff: string;
	hunksShown: number;
	hunksTotal: number;
	bytesOmitted: number;
	partialHunk: boolean;
}
```

Add to `StepView` (after `io`):

```ts
	/** File changes this step reported, already redacted and hunk-truncated by the producer. Absent when the step logged none. */
	diffs?: DiffView[];
```

Add next to `buildStepIo`:

```ts
/** Returns v as a DiffView if it has the exact expected shape, otherwise null -- payloads arrive from unauthenticated ingest, so anything unexpected is ignored rather than trusted or thrown on. */
function asDiffView(v: unknown): DiffView | null {
	if (v === null || typeof v !== "object") return null;
	const d = v as Record<string, unknown>;
	if (typeof d.path !== "string" || typeof d.diff !== "string") return null;
	if (typeof d.hunksShown !== "number" || typeof d.hunksTotal !== "number" || typeof d.bytesOmitted !== "number") return null;
	if (typeof d.partialHunk !== "boolean") return null;
	return { path: d.path, diff: d.diff, hunksShown: d.hunksShown, hunksTotal: d.hunksTotal, bytesOmitted: d.bytesOmitted, partialHunk: d.partialHunk };
}

/** Decodes the gen_ai.content.diffs event into DiffViews, or undefined if the step logged none / the payload is unusable. */
function buildStepDiffs(events: { name: string; attributes: AttrMap }[]): DiffView[] | undefined {
	for (const e of events) {
		if (e.name !== "gen_ai.content.diffs" || typeof e.attributes["gen_ai.diffs"] !== "string") continue;
		const decoded = decodeIoValue(e.attributes["gen_ai.diffs"] as string);
		if (!Array.isArray(decoded)) return undefined;
		const views = decoded.map(asDiffView).filter((d): d is DiffView => d !== null);
		return views.length > 0 ? views : undefined;
	}
	return undefined;
}
```

In `getRun`, immediately before the `steps.push({...})` call, add:

```ts
		const diffs = buildStepDiffs(parsed.events);
```

Then add this line to the pushed object, after `io: buildStepIo(parsed.events),`:

```ts
			...(diffs ? { diffs } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Document the plugin contract**

In `server/README.md`, in the `GET /api/v1/runs/:traceId` bullet under "What a plugin can read", add after the `id`/`parentId` paragraph:

```markdown
  A step that changed files also carries `diffs`: an array of
  `{ path, diff, hunksShown, hunksTotal, bytesOmitted, partialHunk }`. The
  `diff` is unified-diff text, already secret-redacted and truncated at
  whole-hunk boundaries by the producer. When `hunksShown < hunksTotal` or
  `bytesOmitted > 0` the diff is incomplete, and `partialHunk` means the last
  hunk shown is itself cut mid-way — a plugin displaying a diff must surface
  that rather than presenting it as the whole change. The field is absent for
  steps that logged no diffs, including every run logged before
  `trailai-mcp` 0.4.0.
```

- [ ] **Step 6: Commit**

```bash
git add server/src/runs.ts server/test/runs.test.js server/README.md
git commit -m "feat(server): decode step file diffs and document the contract"
```

---

### Task 4: Render diffs in the Flight Recorder

**Files:**
- Modify: `server/src/static/app.ts` (`renderStepIO` at `:262`)
- Modify: `server/src/templates/shell.ts` (styles, near the existing `.io-*` rules)
- Test: `server/test/app.test.js`

**Interfaces:**
- Consumes: `DiffView` fields from Task 3 (`path`, `diff`, `hunksShown`, `hunksTotal`, `bytesOmitted`, `partialHunk`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing tests**

`server/test/app.test.js` already has a `loadApp()` helper (`app.test.js:105`) that evaluates the built `dist/static/app.js` in a `vm` sandbox and returns it as `sandbox`. Because `renderDiffs` is a top-level function declaration in `app.ts`, it is reachable as `sandbox.renderDiffs`. Add:

```js
describe("renderDiffs", () => {
	const render = (entries) => loadApp().sandbox.renderDiffs(entries);

	test("renders the file path and +/- lines", () => {
		const html = render([{ path: "auth.py", diff: "@@ -1 +1 @@\n-old\n+new\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 0, partialHunk: false }]);
		assert.ok(html.includes("auth.py"));
		assert.ok(html.includes("diff-add"), "added lines need their own class");
		assert.ok(html.includes("diff-del"), "removed lines need their own class");
	});

	test("shows a truncation banner naming hunks shown and bytes omitted", () => {
		const html = render([{ path: "big.py", diff: "@@ -1 +1 @@\n+x\n", hunksShown: 3, hunksTotal: 11, bytesOmitted: 48128, partialHunk: false }]);
		assert.ok(html.includes("3 of 11 hunks"));
		assert.ok(/47(\.\d+)?\s?KB|48128/.test(html), "omitted size must be stated");
	});

	test("says so when the last shown hunk is itself cut", () => {
		const html = render([{ path: "huge.py", diff: "@@ -1 +1 @@\n+y\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 90000, partialHunk: true }]);
		assert.ok(/cut|truncated/i.test(html), "a mid-hunk cut must be stated, not implied");
	});

	test("renders a header-only entry squeezed out by the step budget as changed-but-not-shown", () => {
		const html = render([{ path: "skipped.py", diff: "--- a/skipped.py\n+++ b/skipped.py\n", hunksShown: 0, hunksTotal: 4, bytesOmitted: 30000, partialHunk: false }]);
		assert.ok(html.includes("skipped.py"), "a changed file must stay visible");
		assert.ok(/not shown|0 of 4/i.test(html));
	});

	test("renders text that is not a unified diff as plain lines instead of dropping it", () => {
		const html = render([{ path: "weird.txt", diff: "this is not a diff at all", hunksShown: 0, hunksTotal: 0, bytesOmitted: 0, partialHunk: false }]);
		assert.ok(html.includes("this is not a diff at all"), "unparseable content must still be shown");
		assert.ok(html.includes("weird.txt"));
	});

	test("escapes HTML in diff content", () => {
		const html = render([{ path: "x.html", diff: "@@ -1 +1 @@\n+<script>alert(1)</script>\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 0, partialHunk: false }]);
		assert.ok(!html.includes("<script>alert(1)</script>"), "diff text is attacker-controlled and must be escaped");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: FAIL — `renderDiffs` is not defined.

- [ ] **Step 3: Implement the renderer**

In `server/src/static/app.ts`, add near `renderIoPair` (`:69`). This is a top-level function declaration with no `import`/`export` — `app.ts` is loaded as a classic browser script:

```ts
function fmtBytes(n: number): string {
	return n >= 1024 ? (n / 1024).toFixed(n >= 10240 ? 0 : 1).replace(/\.0$/, "") + "KB" : n + "B";
}

/**
 * Renders agent-reported file diffs. Truncation is stated explicitly rather than implied: a diff
 * that looks complete but isn't will send a developer down the wrong path, so every omission gets
 * a banner and a mid-hunk cut says so in its own words.
 */
function renderDiffs(diffs: { path: string; diff: string; hunksShown: number; hunksTotal: number; bytesOmitted: number; partialHunk: boolean }[]): string {
	return diffs.map((d) => {
		const lines = d.diff.split("\n").map((ln) => {
			const cls = ln.startsWith("+") && !ln.startsWith("+++") ? "diff-add"
				: ln.startsWith("-") && !ln.startsWith("---") ? "diff-del"
				: ln.startsWith("@@") ? "diff-hunk"
				: "diff-ctx";
			return '<div class="' + cls + '">' + escapeHtml(ln) + "</div>";
		}).join("");

		const incomplete = d.hunksShown < d.hunksTotal || d.bytesOmitted > 0;
		let banner = "";
		if (d.hunksTotal > 0 && d.hunksShown === 0) {
			banner = "Changed, but not shown — " + d.hunksTotal + " hunks omitted (" + fmtBytes(d.bytesOmitted) + ") to stay within this step's diff budget.";
		} else if (incomplete) {
			banner = d.hunksShown + " of " + d.hunksTotal + " hunks shown, " + fmtBytes(d.bytesOmitted) + " omitted."
				+ (d.partialHunk ? " The last hunk shown is itself cut mid-way." : "");
		}

		return '<div class="io-kind">' + escapeHtml(d.path) + "</div>"
			+ (banner ? '<div class="diff-banner">' + escapeHtml(banner) + "</div>" : "")
			+ '<div class="io-diff">' + lines + "</div>";
	}).join("");
}
```

In `renderStepIO`, add immediately after the `s.sig` block and before the `s.io` block:

```ts
		if (s.diffs && s.diffs.length) inner += renderDiffs(s.diffs);
```

Change the empty-state condition so a step with diffs but no io doesn't claim nothing was recorded:

```ts
		if (s.io && s.io.length) inner += s.io.map((p) => renderIoPair(p)).join("");
		else if (!s.diffs || !s.diffs.length) inner += '<div class="insp-empty">No input/output recorded for this step.</div>';
```

In `server/src/templates/shell.ts`, add beside the existing `.io-*` rules:

```css
	.io-diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; margin: 4px 0 10px; }
	.io-diff > div { padding: 0 8px; white-space: pre; }
	.diff-add { background: var(--met-wash); color: var(--met); }
	.diff-del { background: var(--failed-wash); color: var(--failed); }
	.diff-hunk { background: var(--panel-2); color: var(--ink-3); }
	.diff-ctx { color: var(--ink-2); }
	.diff-banner { font-size: 11px; color: var(--partial); background: var(--partial-wash); border-radius: 5px; padding: 4px 8px; margin: 4px 0; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/src/static/app.ts server/src/templates/shell.ts server/test/app.test.js
git commit -m "feat(server): render step file diffs with explicit truncation banners"
```

---

### Task 5: Version bump and migration docs

**Files:**
- Modify: `mcp/package.json` (`version`)
- Modify: `mcp/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing.

- [ ] **Step 1: Bump the version**

In `mcp/package.json`, change `"version": "0.3.0"` to `"version": "0.4.0"`.

- [ ] **Step 2: Document the new parameter**

In `mcp/README.md`, alongside the existing `trail_log_step` documentation and the "Migrating from 0.2.x" section, add a short "What's new in 0.4.0" note:

```markdown
### What's new in 0.4.0

`trail_log_step` accepts an optional `diffs` array — `{ path, diff }` entries
holding unified-diff text for files the step changed. Purely additive: a
caller that passes no `diffs` behaves exactly as it did in 0.3.0, and no
upgrade step is required.

Diffs are redacted and truncated **before** they leave the process, the same
as every other structured payload. Large diffs are cut at whole-hunk
boundaries (256KB per file, 1MB per step) so a truncated diff stays readable
instead of ending mid-hunk, and what was dropped is reported alongside it so
the UI can say so.

Diffs are agent-reported. Tether records what the harness passes; it does not
read the filesystem to verify a diff against what actually changed on disk.
```

- [ ] **Step 3: Verify both suites still pass**

Run: `cd mcp && npm run build && npm test 2>&1 | grep -E "^# (tests|pass|fail)"` then the same in `server/`.
Expected: PASS in both, `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add mcp/package.json mcp/README.md
git commit -m "chore(mcp): bump to 0.4.0 for agent-reported file diffs"
```

---

## Verification

After all five tasks:

```bash
cd mcp && npm run build && npm test
cd ../server && npm run build && npm test
```

Both suites must report `# fail 0`. Baseline before this work: mcp 86 tests, server 302 tests — both counts should have grown, and neither should have shrunk.
