# Local Server and MCP Local Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mcp/` work against a local, self-hosted Tether instance with zero config, and build that instance — a new `server/` package (`npx trailai-tether`) that accepts the same OTLP/JSON `mcp/` already emits, stores it in embedded SQLite, and serves a minimal placeholder page proving the pipeline works end to end.

**Architecture:** Two packages. `mcp/` (existing) gets a small, backward-compatible change: `TRAIL_URL` defaults to `http://localhost:4319` instead of being required, and the API key pair becomes optional — Trail Cloud users who already set all three env vars see no behavior change. `server/` (new) is a plain `node:http` server (no framework — the routing surface is two routes) backed by `better-sqlite3`, with the data file resolved via `env-paths` to an OS-appropriate directory. No UI beyond a placeholder page — the real Flight Recorder UI is separate, larger, not-yet-spec'd-as-code work.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, `better-sqlite3`, `env-paths`, `node:http`/`node:fs`/`node:path` (no framework dependency for `server/`).

**Spec:** `docs/superpowers/specs/2026-08-21-self-hosted-packaging-design.md` (§3 install/process model, §4 datastore, §6 auth, §7 the `mcp/` change, §8 port). This plan resolves that spec's remaining implementation-time decisions: product/package name `trailai-tether` (npm-checked available; `tether`/`tether-cls` are taken), port `4319` (avoids OTel's 4317/4318 and common dev-server ports 3000/5173/8080), `better-sqlite3` for storage (works on the existing Node >=18 floor, unlike the built-in `node:sqlite` which needs Node 22.5+), `env-paths` for the data directory (tiny, zero-dependency, handles OS edge cases a hand-rolled version would miss).

## Global Constraints

- `mcp/` keeps its own established norm: no new dependencies there. `server/` is a brand-new package where `better-sqlite3` and `env-paths` are already-approved, deliberate additions — that norm does not apply to it.
- Indentation is tabs, not spaces, in both packages' `src/` — matches `mcp/`'s existing convention; `server/` starts fresh but follows the same convention for consistency across this repo.
- Tests import from `../dist/*.js` (compiled output), not `../src/*.ts` — `npm run build` before `npm test`, matching `mcp/`'s existing test convention. `server/` adopts the identical convention from its first commit.
- Every function needing a machine-specific default (a port, a data directory) takes it as an optional parameter or reads it from an env var with a real default — consistent with the injectability pattern already established in `mcp/src/manifest.ts` (`homeDir`, `claudeJsonPath`).
- The local server must never crash on malformed input (a bad `/traces` POST body) — it must return an error response and keep serving subsequent requests, mirroring the "never throw, degrade gracefully" discipline already established throughout `mcp/`.
- The server binds `127.0.0.1` only, never `0.0.0.0` — no auth, per the packaging spec §6, because there's no multi-tenant boundary to protect on a single local machine.

---

### Task 1: `mcp/` local mode — `TRAIL_URL` defaults to localhost, keys become optional

**Files:**
- Modify: `mcp/src/otlp.ts`
- Modify: `mcp/src/index.ts`
- Modify: `mcp/README.md`
- Create: `mcp/test/otlp.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TrailConfig.publicKey`/`TrailConfig.secretKey` become `string | undefined` (previously required `string`). `sendSpan(cfg, span)` omits the `X-Public-Key`/`X-Secret-Key` headers entirely when the corresponding config field is `undefined`, instead of sending them as literal `"undefined"` strings. No task in this plan consumes these directly by name (Task 3's server reads the request body, not these headers), but this is the compatibility contract Trail Cloud's server and this plan's new local server must both tolerate.

**Context:** Today `mcp/src/index.ts`'s `cfg` object calls `requireEnv("TRAIL_URL")`/`requireEnv("TRAIL_PUBLIC_KEY")`/`requireEnv("TRAIL_SECRET_KEY")`, which `process.exit(1)`s if any is unset — sized for Trail Cloud's multi-tenant, API-key-authenticated ingest. `requireEnv` is used nowhere else in `index.ts` (verified directly), so it becomes dead code once these three calls are removed. `mcp/src/otlp.ts`'s `sendSpan` currently always sets `"X-Public-Key": cfg.publicKey` / `"X-Secret-Key": cfg.secretKey` unconditionally — if those become `undefined`, `fetch`'s headers object would coerce them to the literal string `"undefined"`, which is wrong (a request should either carry a real key or no header at all, never a stringified `undefined`).

- [ ] **Step 1: Write the failing test**

Create `mcp/test/otlp.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sendSpan } from "../dist/otlp.js";

function stubFetch(impl) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return () => {
		globalThis.fetch = original;
	};
}

function okResponse() {
	return { ok: true, text: async () => "" };
}

const BASE_SPAN = {
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	name: "test-span",
	startTimeUnixNano: "1000000000",
	endTimeUnixNano: "2000000000",
	attributes: {},
};

describe("sendSpan", () => {
	test("includes X-Public-Key and X-Secret-Key headers when both are set", async () => {
		let capturedHeaders;
		const restore = stubFetch(async (_url, init) => {
			capturedHeaders = init.headers;
			return okResponse();
		});
		try {
			await sendSpan(
				{ url: "http://localhost:4319", publicKey: "pk-test", secretKey: "sk-test", environment: "default", serviceName: "test" },
				BASE_SPAN,
			);
			assert.equal(capturedHeaders["X-Public-Key"], "pk-test");
			assert.equal(capturedHeaders["X-Secret-Key"], "sk-test");
		} finally {
			restore();
		}
	});

	test("omits X-Public-Key and X-Secret-Key headers entirely when both are undefined (local mode)", async () => {
		let capturedHeaders;
		const restore = stubFetch(async (_url, init) => {
			capturedHeaders = init.headers;
			return okResponse();
		});
		try {
			await sendSpan(
				{ url: "http://localhost:4319", environment: "default", serviceName: "test" },
				BASE_SPAN,
			);
			assert.equal("X-Public-Key" in capturedHeaders, false);
			assert.equal("X-Secret-Key" in capturedHeaders, false);
		} finally {
			restore();
		}
	});

	test("still sends Content-Type and User-Agent headers in local mode", async () => {
		let capturedHeaders;
		const restore = stubFetch(async (_url, init) => {
			capturedHeaders = init.headers;
			return okResponse();
		});
		try {
			await sendSpan(
				{ url: "http://localhost:4319", environment: "default", serviceName: "test" },
				BASE_SPAN,
			);
			assert.equal(capturedHeaders["Content-Type"], "application/json");
			assert.equal(capturedHeaders["User-Agent"], "trail-mcp/0.1.0");
		} finally {
			restore();
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp && node --test test/otlp.test.js`
Expected: FAIL — `dist/otlp.js` doesn't exist yet with this build, or the current unconditional-header implementation sends literal `"undefined"` strings for the second test (not exactly what's asserted, but the module doesn't need rebuilding first — run `npm run build` once, then this test, to get the real pre-fix failure): `capturedHeaders["X-Public-Key"]` would be the string `"undefined"`, so `"X-Public-Key" in capturedHeaders` is `true`, failing the `assert.equal(..., false)` check.

- [ ] **Step 3: Update `TrailConfig` and `sendSpan` in `mcp/src/otlp.ts`**

Change the `TrailConfig` interface (currently `publicKey: string; secretKey: string;`) to:

```ts
export interface TrailConfig {
	url: string;        // e.g. https://your-server/api/sdk/v1, or http://localhost:4319 for local mode
	publicKey?: string;
	secretKey?: string;
	environment: string;
	serviceName: string;
}
```

Change `sendSpan`'s headers object (currently unconditional `"X-Public-Key": cfg.publicKey, "X-Secret-Key": cfg.secretKey`) to:

```ts
export async function sendSpan(cfg: TrailConfig, span: SpanInput): Promise<void> {
	const res = await fetch(`${cfg.url.replace(/\/$/, "")}/traces`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "trail-mcp/0.1.0",
			...(cfg.publicKey ? { "X-Public-Key": cfg.publicKey } : {}),
			...(cfg.secretKey ? { "X-Secret-Key": cfg.secretKey } : {}),
		},
		body: JSON.stringify(buildPayload(cfg, span)),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Trail ingest failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}
}
```

- [ ] **Step 4: Update `mcp/src/index.ts`'s config block**

Replace this block (currently lines 26-42: the `requireEnv` function definition plus the `cfg` object using it):

```ts
// ---------------------------------------------------------------- config
function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`trail-mcp: missing required env var ${name}`);
		process.exit(1);
	}
	return v;
}

const cfg: TrailConfig = {
	url: requireEnv("TRAIL_URL"),
	publicKey: requireEnv("TRAIL_PUBLIC_KEY"),
	secretKey: requireEnv("TRAIL_SECRET_KEY"),
	environment: process.env.TRAIL_ENV ?? "default",
	serviceName: process.env.TRAIL_APP ?? "coding-agent",
};
```

with:

```ts
// ---------------------------------------------------------------- config
const DEFAULT_LOCAL_URL = "http://localhost:4319";

const cfg: TrailConfig = {
	url: process.env.TRAIL_URL ?? DEFAULT_LOCAL_URL,
	publicKey: process.env.TRAIL_PUBLIC_KEY,
	secretKey: process.env.TRAIL_SECRET_KEY,
	environment: process.env.TRAIL_ENV ?? "default",
	serviceName: process.env.TRAIL_APP ?? "coding-agent",
};
```

(`requireEnv` is deleted entirely — verified via grep it has no other call sites in this file.)

- [ ] **Step 5: Build**

Run: `cd mcp && npm run build`
Expected: exits 0.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd mcp && node --test test/otlp.test.js`
Expected: all 3 tests pass.

- [ ] **Step 7: Run the full mcp test suite to confirm no regressions**

Run: `cd mcp && npm test`
Expected: all tests pass (`judge.test.js`, `manifest.test.js` unaffected, plus the new `otlp.test.js`).

- [ ] **Step 8: Update `mcp/README.md`'s env var table and add a local-mode note**

Find this block in the env var table:

```markdown
| `TRAIL_URL`        | yes      | Trail SDK base URL, ends in `/api/sdk/v1`   |
| `TRAIL_PUBLIC_KEY` | yes      | From Settings → API Keys                    |
| `TRAIL_SECRET_KEY` | yes      | From Settings → API Keys                    |
```

Replace it with:

```markdown
| `TRAIL_URL`        | no       | Trail SDK base URL. Defaults to `http://localhost:4319` (a local Tether instance); set to your Cloud URL (ends in `/api/sdk/v1`) to use Trail Cloud instead |
| `TRAIL_PUBLIC_KEY` | no       | From Settings → API Keys. Required for Trail Cloud, omit entirely for a local Tether instance (no auth) |
| `TRAIL_SECRET_KEY` | no       | From Settings → API Keys. Required for Trail Cloud, omit entirely for a local Tether instance (no auth) |
```

Then add a new bullet to the end of the `## Notes` section:

```markdown
- With no env vars set at all, `trail_start_run`/`trail_finish_run`/etc. point at
  `http://localhost:4319` with no auth headers — the default for a local,
  self-hosted Tether instance (see `server/`). Set `TRAIL_URL` +
  `TRAIL_PUBLIC_KEY` + `TRAIL_SECRET_KEY` together to use Trail Cloud instead;
  existing Cloud configurations that already set all three continue to work
  exactly as before.
```

- [ ] **Step 9: Commit**

```bash
git add mcp/src/otlp.ts mcp/src/index.ts mcp/test/otlp.test.js mcp/README.md
git commit -m "feat(mcp): default to a local Tether instance when no TRAIL_URL/keys are set"
```

---

### Task 2: Data directory and SQLite storage module

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/.gitignore`
- Create: `server/LICENSE`
- Create: `server/src/db.ts`
- Create: `server/test/db.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `resolveDataDir(): string`, `openDatabase(dbPath: string): Database.Database` (the `better-sqlite3` `Database` type), `insertSpan(db, span: StoredSpan): void`, `countTraces(db): number`, and the `StoredSpan` interface, all exported from `server/src/db.ts`. Task 3 imports `openDatabase`, `insertSpan`, `countTraces`, `StoredSpan` from `./db.js`. Task 4 imports `resolveDataDir` from `./db.js`.

**Context:** This is a brand-new package (`server/`), sibling to the existing `mcp/`. It needs its own `package.json`/`tsconfig.json` (mirroring `mcp/`'s conventions exactly: same TypeScript target/module settings, same `node:test` test runner, same tabs-indentation, same `../dist/*.js` test-import convention) since nothing in this repo currently sets those up outside `mcp/`. Storage is embedded SQLite via `better-sqlite3`, chosen (not `node:sqlite`) because it works on this repo's existing `Node >=18` floor. The data file's directory is resolved via `env-paths`, chosen over hand-rolling the OS-specific logic because it's tiny, zero-dependency, and already handles edge cases (XDG override vars, sandboxed environments) a hand-rolled version would likely miss. The schema is deliberately minimal for this first increment: indexed key columns for what's needed now (`traceId`, `spanId`, `parentSpanId`, `name`, timestamps) plus a `raw` JSON blob column holding the full span object — this avoids modeling every possible `gen_ai.*` attribute as a SQL column before the UI work that will actually query them has been scoped.

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "trailai-tether",
  "version": "0.1.0",
  "description": "Tether — local, self-hosted agent-harness observability. Embedded SQLite storage for the OTLP traces trailai-mcp sends.",
  "type": "module",
  "bin": { "trailai-tether": "dist/index.js" },
  "main": "dist/index.js",
  "files": ["dist", "README.md", "LICENSE", "package.json"],
  "homepage": "https://github.com/tmam-dev/tether/tree/main/server#readme",
  "bugs": {
    "url": "https://github.com/tmam-dev/tether/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/tmam-dev/tether.git",
    "directory": "server"
  },
  "keywords": [
    "tether",
    "agent",
    "observability",
    "self-hosted",
    "opentelemetry",
    "otlp",
    "sqlite"
  ],
  "author": "Tether",
  "license": "Apache-2.0",
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build && npm test",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js",
    "test": "node --test test/*.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "env-paths": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/better-sqlite3": "^7.6.0"
  },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/.gitignore`**

```
dist/
node_modules/
*.sqlite
```

- [ ] **Step 4: Create `server/LICENSE`**

Copy the exact contents of `mcp/LICENSE` (Apache License 2.0, already filled in with `Copyright 2026 Trail` at the bottom) into `server/LICENSE` verbatim — this package publishes independently to npm, same as `mcp/`, so it needs its own copy per npm packaging convention (see `mcp/package.json`'s `files` array, which includes `LICENSE`).

- [ ] **Step 5: Install dependencies**

Run: `cd server && npm install`
Expected: exits 0, creates `server/node_modules/` and `server/package-lock.json`.

- [ ] **Step 6: Write the failing test**

Create `server/test/db.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertSpan, countTraces } from "../dist/db.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-db-test-"));
	return join(dir, "test.sqlite");
}

const BASE_SPAN = {
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	parentSpanId: null,
	name: "test-span",
	startTimeUnixNano: "1000000000",
	endTimeUnixNano: "2000000000",
	raw: JSON.stringify({ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "test-span" }),
};

describe("openDatabase", () => {
	test("creates the spans table and returns a usable database on a fresh path", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			assert.equal(countTraces(db), 0);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("is idempotent — opening the same path twice does not throw", () => {
		const dbPath = makeTempDbPath();
		const db1 = openDatabase(dbPath);
		db1.close();
		const db2 = openDatabase(dbPath);
		try {
			assert.equal(countTraces(db2), 0);
		} finally {
			db2.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});

describe("insertSpan / countTraces", () => {
	test("counts distinct traces, not total spans", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			insertSpan(db, { ...BASE_SPAN, spanId: "c".repeat(16), parentSpanId: "b".repeat(16), name: "child-span" });
			assert.equal(countTraces(db), 1);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("a second trace increments the count", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			insertSpan(db, { ...BASE_SPAN, traceId: "d".repeat(32), spanId: "e".repeat(16) });
			assert.equal(countTraces(db), 2);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("re-inserting the same traceId+spanId replaces the row instead of erroring", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			insertSpan(db, { ...BASE_SPAN, name: "updated-name" });
			const row = db.prepare("SELECT name FROM spans WHERE traceId = ? AND spanId = ?").get(BASE_SPAN.traceId, BASE_SPAN.spanId);
			assert.equal(row.name, "updated-name");
			assert.equal(countTraces(db), 1);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});

	test("stores a null parentSpanId correctly for a root span", () => {
		const dbPath = makeTempDbPath();
		const db = openDatabase(dbPath);
		try {
			insertSpan(db, BASE_SPAN);
			const row = db.prepare("SELECT parentSpanId FROM spans WHERE traceId = ? AND spanId = ?").get(BASE_SPAN.traceId, BASE_SPAN.spanId);
			assert.equal(row.parentSpanId, null);
		} finally {
			db.close();
			rmSync(join(dbPath, ".."), { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd server && node --test test/db.test.js`
Expected: FAIL — `../dist/db.js` doesn't exist yet.

- [ ] **Step 8: Write the implementation**

Create `server/src/db.ts`:

```ts
/**
 * Embedded SQLite storage for Tether's ingested OTLP spans.
 *
 * Schema is deliberately minimal: indexed key columns for what's queried
 * today (traceId, spanId, parentSpanId, name, timestamps), plus a `raw`
 * JSON blob holding the full span object. Avoids modeling every gen_ai.*
 * attribute as a SQL column before the UI work that will query them exists.
 */

import Database from "better-sqlite3";
import envPaths from "env-paths";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	raw: string;
}

/** OS-appropriate data directory for Tether's SQLite file (XDG on Linux, Application Support on macOS, %APPDATA% on Windows). */
export function resolveDataDir(): string {
	return envPaths("trailai-tether", { suffix: "" }).data;
}

/** Opens (creating if needed) the spans database at the given path. Safe to call repeatedly on the same path. */
export function openDatabase(dbPath: string): Database.Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE IF NOT EXISTS spans (
			traceId TEXT NOT NULL,
			spanId TEXT NOT NULL,
			parentSpanId TEXT,
			name TEXT NOT NULL,
			startTimeUnixNano TEXT NOT NULL,
			endTimeUnixNano TEXT NOT NULL,
			raw TEXT NOT NULL,
			PRIMARY KEY (traceId, spanId)
		);
		CREATE INDEX IF NOT EXISTS idx_spans_traceId ON spans(traceId);
	`);
	return db;
}

/** Inserts a span, replacing any existing row with the same traceId+spanId. */
export function insertSpan(db: Database.Database, span: StoredSpan): void {
	db.prepare(
		`INSERT OR REPLACE INTO spans (traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, raw)
		 VALUES (@traceId, @spanId, @parentSpanId, @name, @startTimeUnixNano, @endTimeUnixNano, @raw)`,
	).run(span);
}

/** Number of distinct traces (runs) stored, not total span count. */
export function countTraces(db: Database.Database): number {
	const row = db.prepare(`SELECT COUNT(DISTINCT traceId) as count FROM spans`).get() as { count: number };
	return row.count;
}
```

- [ ] **Step 9: Build**

Run: `cd server && npm run build`
Expected: exits 0.

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd server && node --test test/db.test.js`
Expected: all 6 tests pass.

- [ ] **Step 11: Commit**

```bash
git add server/package.json server/tsconfig.json server/.gitignore server/LICENSE server/src/db.ts server/test/db.test.js server/package-lock.json
git commit -m "feat(server): add embedded SQLite storage module"
```

---

### Task 3: HTTP server — OTLP ingestion and placeholder page

**Files:**
- Create: `server/src/server.ts`
- Create: `server/test/server.test.js`

**Interfaces:**
- Consumes: `openDatabase`, `insertSpan`, `countTraces`, `StoredSpan` from Task 2's `./db.js`.
- Produces: `createTetherServer(db: Database.Database): http.Server`, exported from `server/src/server.ts`. Task 4 imports `createTetherServer` and calls `.listen(port, "127.0.0.1")` on the returned server.

**Context:** `mcp/src/otlp.ts`'s `sendSpan` (existing, unchanged by this task) POSTs a complete OTLP/JSON `ExportTraceServiceRequest` body to `{url}/traces` — the shape is `{ resourceSpans: [{ resource: {...}, scopeSpans: [{ scope: {...}, spans: [...] }] }] }`. This task's server must accept exactly that shape at `POST /traces`, extract every span from the nested arrays, and store each one via Task 2's `insertSpan`. No authentication is checked (per the packaging spec §6 — nothing to protect on a local machine), so headers are ignored entirely, matching what Task 1 made `sendSpan` do when no keys are configured (send no auth headers at all). The server must never crash on a malformed request — an unparseable body or a span missing required fields must produce an error response and leave the server able to handle the next request, not exit or hang.

- [ ] **Step 1: Write the failing test**

Create `server/test/server.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, countTraces } from "../dist/db.js";
import { createTetherServer } from "../dist/server.js";

function makeTempDbPath() {
	const dir = mkdtempSync(join(tmpdir(), "tether-server-test-"));
	return join(dir, "test.sqlite");
}

async function withServer(fn) {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	const server = createTetherServer(db);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await fn({ db, port });
	} finally {
		await new Promise((resolve) => server.close(resolve));
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
}

function otlpPayload() {
	return {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
				scopeSpans: [
					{
						scope: { name: "test-scope", version: "0.1.0" },
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "b".repeat(16),
								name: "test-span",
								kind: 1,
								startTimeUnixNano: "1000000000",
								endTimeUnixNano: "2000000000",
								attributes: [],
								events: [],
								status: { code: 1 },
							},
						],
					},
				],
			},
		],
	};
}

describe("POST /traces", () => {
	test("ingests a valid OTLP payload and increments the trace count", async () => {
		await withServer(async ({ db, port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.ok, true);
			assert.equal(body.spansIngested, 1);
			assert.equal(countTraces(db), 1);
		});
	});

	test("ingests a payload with no auth headers at all (local mode)", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(res.status, 200);
		});
	});

	test("ingests multiple spans across scopeSpans in one request", async () => {
		await withServer(async ({ db, port }) => {
			const payload = otlpPayload();
			payload.resourceSpans[0].scopeSpans[0].spans.push({
				traceId: "a".repeat(32),
				spanId: "c".repeat(16),
				parentSpanId: "b".repeat(16),
				name: "child-span",
				kind: 1,
				startTimeUnixNano: "1100000000",
				endTimeUnixNano: "1900000000",
				attributes: [],
				events: [],
				status: { code: 1 },
			});
			const res = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = await res.json();
			assert.equal(body.spansIngested, 2);
			assert.equal(countTraces(db), 1);
		});
	});

	test("returns 400 (not a crash) for unparseable JSON, and the server keeps working afterward", async () => {
		await withServer(async ({ db, port }) => {
			const badRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not valid json{{{",
			});
			assert.equal(badRes.status, 400);

			const goodRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(goodRes.status, 200);
			assert.equal(countTraces(db), 1);
		});
	});

	test("returns 200 with spansIngested:0 for a payload missing resourceSpans (extraction degrades gracefully, does not throw)", async () => {
		await withServer(async ({ db, port }) => {
			const badRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ notResourceSpans: [] }),
			});
			assert.equal(badRes.status, 200);
			const body = await badRes.json();
			assert.equal(body.spansIngested, 0);

			const goodRes = await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			assert.equal(goodRes.status, 200);
			assert.equal(countTraces(db), 1);
		});
	});
});

describe("GET /", () => {
	test("returns a page reporting zero runs before any ingestion", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.match(text, /0 runs/);
		});
	});

	test("reflects the ingested trace count after a POST /traces", async () => {
		await withServer(async ({ port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const text = await res.text();
			assert.match(text, /1 run(?!s)/);
		});
	});
});

describe("unknown routes", () => {
	test("returns 404 for an unrecognized path", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
			assert.equal(res.status, 404);
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test test/server.test.js`
Expected: FAIL — `../dist/server.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `server/src/server.ts`:

```ts
/**
 * Tether's local HTTP server: accepts the same OTLP/JSON payload
 * mcp/src/otlp.ts sends, stores every span, and serves a placeholder page
 * confirming it's running. No auth -- binds 127.0.0.1 only (see index.ts),
 * nothing here checks headers.
 */

import { createServer, IncomingMessage, Server } from "node:http";
import type Database from "better-sqlite3";
import { insertSpan, countTraces } from "./db.js";

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	[key: string]: unknown;
}

function extractSpans(body: unknown): OtlpSpan[] {
	const spans: OtlpSpan[] = [];
	const resourceSpans = (body as { resourceSpans?: unknown[] })?.resourceSpans ?? [];
	for (const rs of resourceSpans) {
		const scopeSpans = (rs as { scopeSpans?: unknown[] })?.scopeSpans ?? [];
		for (const ss of scopeSpans) {
			const spanList = (ss as { spans?: OtlpSpan[] })?.spans ?? [];
			for (const span of spanList) spans.push(span);
		}
	}
	return spans;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

function renderPlaceholderPage(traceCount: number): string {
	const label = traceCount === 1 ? "1 run" : `${traceCount} runs`;
	return `<!doctype html><html><head><title>Tether</title></head><body><h1>Tether is running</h1><p>${label} ingested.</p></body></html>`;
}

export function createTetherServer(db: Database.Database): Server {
	return createServer(async (req, res) => {
		if (req.method === "POST" && req.url === "/traces") {
			try {
				const bodyText = await readBody(req);
				const parsed = JSON.parse(bodyText);
				const spans = extractSpans(parsed);
				for (const span of spans) {
					insertSpan(db, {
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId ?? null,
						name: span.name,
						startTimeUnixNano: span.startTimeUnixNano,
						endTimeUnixNano: span.endTimeUnixNano,
						raw: JSON.stringify(span),
					});
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, spansIngested: spans.length }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
			}
			return;
		}

		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(renderPlaceholderPage(countTraces(db)));
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});
}
```

- [ ] **Step 4: Build**

Run: `cd server && npm run build`
Expected: exits 0.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && node --test test/server.test.js`
Expected: all 8 tests pass.

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npm test`
Expected: all tests pass (`db.test.js` and `server.test.js`).

- [ ] **Step 7: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): add the OTLP ingestion endpoint and placeholder page"
```

---

### Task 4: `npx` entry point, README, and end-to-end verification

**Files:**
- Create: `server/src/index.ts`
- Create: `server/README.md`

**Interfaces:**
- Consumes: `createTetherServer` from Task 3's `./server.js`, `resolveDataDir` from Task 2's `./db.js`.
- Produces: nothing new for other tasks — this is the plan's final integration point.

**Context:** This is the file `package.json`'s `bin` field points at (`"trailai-tether": "dist/index.js"`) — the executable `npx trailai-tether` actually runs. It composes everything from Tasks 2-3: resolve the data directory, open the database at a fixed filename inside it, start the HTTP server on `127.0.0.1:4319` (or `TETHER_PORT` if set), and log where it's listening and where data lives.

- [ ] **Step 1: Create `server/src/index.ts`**

```ts
#!/usr/bin/env node
/**
 * Tether — local, self-hosted agent-harness observability.
 * Accepts the OTLP traces trailai-mcp sends and stores them in embedded
 * SQLite. No auth, no network exposure -- binds 127.0.0.1 only.
 */

import { join } from "node:path";
import { openDatabase, resolveDataDir } from "./db.js";
import { createTetherServer } from "./server.js";

const DEFAULT_PORT = 4319;
const port = Number(process.env.TETHER_PORT ?? DEFAULT_PORT);
const dbPath = join(resolveDataDir(), "tether.sqlite");

const db = openDatabase(dbPath);
const server = createTetherServer(db);

server.listen(port, "127.0.0.1", () => {
	console.log(`trailai-tether ready at http://localhost:${port} (data: ${dbPath})`);
});
```

- [ ] **Step 2: Build**

Run: `cd server && npm run build`
Expected: exits 0.

- [ ] **Step 3: Manually verify the server starts and serves the placeholder page**

Run: `cd server && TETHER_PORT=4399 node dist/index.js &` (background it, or use a second terminal), then:

```bash
curl -s http://127.0.0.1:4399/
```

Expected: HTML containing "Tether is running" and "0 runs ingested." Then stop the background process (`kill %1` or equivalent).

- [ ] **Step 4: Manually verify the full pipeline end to end — `mcp/`'s local-mode default actually reaches this server**

This is the step that proves Task 1 (mcp/) and Tasks 2-4 (server/) actually work together, not just independently. Write a short throwaway script (do not commit it):

1. Start the built server from Step 3 on the real default port: `cd server && node dist/index.js &` (port 4319, no `TETHER_PORT` override this time, matching `mcp/`'s actual default).
2. Spawn `mcp`'s built server (`cd ../mcp && node dist/index.js`) as a child process via `StdioClientTransport` + `Client` from `@modelcontextprotocol/sdk/client` — with **no** `TRAIL_URL`/`TRAIL_PUBLIC_KEY`/`TRAIL_SECRET_KEY` env vars set at all, proving the zero-config default path.
3. Call `trail_start_run` with `{ name: "e2e test run" }`, then `trail_finish_run` with `{ run_id, status: "ok" }`.
4. `curl -s http://127.0.0.1:4319/` and confirm it now reports "1 run ingested."
5. Stop both background processes.

Paste the real terminal output (not a summary) into the task report — the `curl` output before and after, and confirmation both processes started/stopped cleanly. Delete the throwaway script when done.

- [ ] **Step 5: Create `server/README.md`**

```markdown
# trailai-tether

Tether's local, self-hosted server — accepts the OTLP traces
[`trailai-mcp`](https://www.npmjs.com/package/trailai-mcp) sends and stores
them in embedded SQLite. No install beyond Node, no account, no API key.

## Run it

\`\`\`bash
npx trailai-tether
\`\`\`

Starts listening on `http://localhost:4319` (override with `TETHER_PORT`).
Data persists across restarts in an OS-appropriate app-data directory
(resolved via `env-paths`) — the exact path is printed on startup.

## Point your coding agent at it

`trailai-mcp` already defaults to `http://localhost:4319` with no
authentication when `TRAIL_URL`/`TRAIL_PUBLIC_KEY`/`TRAIL_SECRET_KEY` are
unset — so once this server is running, no extra configuration is needed:

\`\`\`bash
claude mcp add trail -- npx -y trailai-mcp
\`\`\`

## What's here today

- `POST /traces` — OTLP/JSON ingestion, matches the wire format
  `trailai-mcp` already sends. No auth (nothing to protect on one
  developer's own machine).
- `GET /` — a placeholder page confirming the server is running and how
  many runs have been ingested. The real Flight Recorder UI (run timeline,
  goal-attainment verdict, harness anatomy) is separate, larger, upcoming
  work — this is just the ingestion/storage foundation it will sit on.

## Building from source

\`\`\`bash
cd server
npm install
npm run build
npm test
\`\`\`

## License

Apache-2.0 — see [LICENSE](LICENSE).
```

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts server/README.md
git commit -m "feat(server): add the npx entry point and README"
```
