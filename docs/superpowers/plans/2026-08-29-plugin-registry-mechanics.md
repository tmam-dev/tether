# Plugin Registry Mechanics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Tether user discover and one-click-install third-party plugins from a curated index, instead of needing to already know a plugin's git URL.

**Architecture:** A new `registry/plugins.json` at the repo root is the single source of truth (schema-versioned, minimal pointer entries — name/slug/repo/description/kind/slot). It ships bundled inside the `trailai-tether` npm package (copied into `dist/registry/` at build time) and is opportunistically refreshed from a CDN URL into an on-disk cache, TTL-gated so a request never blocks on network. The server's existing per-slot `<select>` picker and the Analytics "Add widget" picker each grow a "Browse marketplace" `<optgroup>` listing not-yet-installed registry entries; picking one POSTs to a new `/api/v1/plugins/install` route that reuses the exact git-clone-and-validate logic `plugin add` already has (pulled out of the CLI into a shared function so both paths call one implementation). A lightweight CI check validates registry PRs by cloning the linked repo and reusing the same manifest validator the server trusts.

**Tech Stack:** TypeScript compiled via `tsc` (no bundler), Node's built-in `http`/`fetch`/`child_process`, `better-sqlite3` (untouched by this work), vanilla-JS client router (`server/src/static/app.ts`), `node:test` for all tests. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-plugin-registry-mechanics-proposal.md` (status: Approved design). Also builds on the shipped `docs/superpowers/specs/2026-08-26-plugin-view-system-design.md` (plugin execution/install model) and `docs/superpowers/specs/2026-08-29-analytics-widget-dashboard-design.md` (widget dashboard + its Add-widget picker).

## Global Constraints

- No `mcp/` changes — this is entirely a `server/` concern (spec's Scope line).
- No Tether-run backend: the CDN fetch is a plain static-file GET (jsdelivr against this repo), never a Tether-hosted service.
- Registry entries are minimal pointers only — `name`, `slug`, `repo`, `description`, `kind` (`"panel" | "widget"`), `slot` (`"detail" | "harness" | "analytics"`, panel-only) — no author/screenshot/version fields (spec §3.1). `kind`/`slot` mirror `tether-plugin.json`'s own `kind`/`replaces` vocabulary exactly.
- Refresh is TTL-cached background refresh: stale after 24h, never blocks a request, no manual "refresh" command (spec §3).
- Listing removal is PR-only — no `status`/soft-delete field anywhere in the schema (spec §7).
- `registry/plugins.json` ships in this PR with `"entries": []` — populating it with real seed-plugin listings is separate follow-up work gated on those plugins actually existing as installable repos, not part of this plan (the approved spec is about mechanics, not content).
- Every new server-side function that takes a plugins directory argument is named/typed `pluginsRoot: string` (not `dataDir`), matching every existing function in `plugins.ts` — the one exception, `pluginsDir(dataDir)` itself, is the only function that ever takes `dataDir`.
- All new/changed server code lives under `server/src/`; all new/changed tests import from `../dist/...` (compiled output) exactly like every existing test in `server/test/`, per this codebase's established pattern — `npm run build` must be run in `server/` before `npm test` picks up changes.

---

### Task 1: Registry schema module — validation + bundled snapshot

**Files:**
- Create: `registry/plugins.json`
- Create: `server/src/registry.ts`
- Create: `server/scripts/copy-registry-snapshot.mjs`
- Modify: `server/package.json` (`build`/`dev` scripts)
- Test: `server/test/registry.test.js`

**Interfaces:**
- Produces: `RegistryEntry { name: string; slug: string; repo: string; description: string; kind: "panel" | "widget"; slot?: "detail" | "harness" | "analytics" }`, `RegistryFile { schemaVersion: number; entries: RegistryEntry[] }`, `isValidRegistryFile(v: unknown): v is RegistryFile`, `loadBundledRegistry(): RegistryFile` — all exported from `server/src/registry.ts`, consumed by later tasks and by Task 8's CI script.

- [ ] **Step 1: Create the repo-root registry index**

```json
{
	"schemaVersion": 1,
	"entries": []
}
```
Save as `registry/plugins.json`.

- [ ] **Step 2: Write the failing tests for schema validation and the bundled loader**

```js
// server/test/registry.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isValidRegistryFile, loadBundledRegistry } from "../dist/registry.js";

describe("isValidRegistryFile", () => {
	test("accepts an empty, well-formed registry", () => {
		assert.equal(isValidRegistryFile({ schemaVersion: 1, entries: [] }), true);
	});

	test("accepts a valid panel entry", () => {
		const file = {
			schemaVersion: 1,
			entries: [{ name: "Waterfall", slug: "waterfall-view", repo: "https://example.com/x", description: "d", kind: "panel", slot: "detail" }],
		};
		assert.equal(isValidRegistryFile(file), true);
	});

	test("accepts a valid widget entry with no slot", () => {
		const file = {
			schemaVersion: 1,
			entries: [{ name: "Cost Trend", slug: "cost-trend", repo: "https://example.com/x", description: "d", kind: "widget" }],
		};
		assert.equal(isValidRegistryFile(file), true);
	});

	test("rejects a panel entry missing slot", () => {
		const file = { schemaVersion: 1, entries: [{ name: "x", slug: "x", repo: "r", description: "d", kind: "panel" }] };
		assert.equal(isValidRegistryFile(file), false);
	});

	test("rejects a panel entry with an unrecognized slot", () => {
		const file = { schemaVersion: 1, entries: [{ name: "x", slug: "x", repo: "r", description: "d", kind: "panel", slot: "sidebar" }] };
		assert.equal(isValidRegistryFile(file), false);
	});

	test("rejects an entry with an invalid slug", () => {
		const file = { schemaVersion: 1, entries: [{ name: "x", slug: "../evil", repo: "r", description: "d", kind: "widget" }] };
		assert.equal(isValidRegistryFile(file), false);
	});

	test("rejects an unrecognized kind", () => {
		const file = { schemaVersion: 1, entries: [{ name: "x", slug: "x", repo: "r", description: "d", kind: "bogus" }] };
		assert.equal(isValidRegistryFile(file), false);
	});

	test("rejects a non-array entries field and a missing schemaVersion", () => {
		assert.equal(isValidRegistryFile({ schemaVersion: 1, entries: {} }), false);
		assert.equal(isValidRegistryFile({ entries: [] }), false);
	});

	test("rejects a non-object", () => {
		assert.equal(isValidRegistryFile(null), false);
		assert.equal(isValidRegistryFile("nope"), false);
	});
});

describe("loadBundledRegistry", () => {
	test("reads the real bundled registry/plugins.json shipped with dist", () => {
		const registry = loadBundledRegistry();
		assert.equal(registry.schemaVersion, 1);
		assert.ok(Array.isArray(registry.entries));
	});
});
```

- [ ] **Step 2b: Run the tests to see them fail**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../dist/registry.js'` (the module doesn't exist yet).

- [ ] **Step 3: Implement `server/src/registry.ts`**

```ts
/**
 * Registry-index schema/validation and the bundled-snapshot loader. The bundled snapshot at
 * ./registry/plugins.json (relative to this compiled module) is copied in from the repo-root
 * registry/plugins.json at build time -- see scripts/copy-registry-snapshot.mjs -- so it ships
 * inside the trailai-tether npm package for offline/first-run use.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPlainSlug } from "./plugins.js";

export interface RegistryEntry {
	name: string;
	slug: string;
	repo: string;
	description: string;
	kind: "panel" | "widget";
	slot?: "detail" | "harness" | "analytics";
}

export interface RegistryFile {
	schemaVersion: number;
	entries: RegistryEntry[];
}

const REGISTRY_KINDS = new Set(["panel", "widget"]);
const REGISTRY_SLOTS = new Set(["detail", "harness", "analytics"]);

function isValidRegistryEntry(v: unknown): v is RegistryEntry {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	const baseValid =
		typeof e.name === "string" &&
		typeof e.slug === "string" &&
		isPlainSlug(e.slug) &&
		typeof e.repo === "string" &&
		typeof e.description === "string" &&
		typeof e.kind === "string" &&
		REGISTRY_KINDS.has(e.kind);
	if (!baseValid) return false;
	if (e.kind === "panel") return typeof e.slot === "string" && REGISTRY_SLOTS.has(e.slot);
	return e.slot === undefined;
}

/** True for a well-formed registry index: a numeric schemaVersion and an entries array of valid
 * RegistryEntry objects. Used both by the server (to accept/reject a live CDN fetch, Task 2) and
 * by the CI validation script (Task 8) that checks a registry PR before merge. */
export function isValidRegistryFile(v: unknown): v is RegistryFile {
	if (typeof v !== "object" || v === null) return false;
	const f = v as Record<string, unknown>;
	if (typeof f.schemaVersion !== "number") return false;
	if (!Array.isArray(f.entries)) return false;
	return f.entries.every(isValidRegistryEntry);
}

const BUNDLED_REGISTRY_PATH = fileURLToPath(new URL("./registry/plugins.json", import.meta.url));
const EMPTY_REGISTRY: RegistryFile = { schemaVersion: 1, entries: [] };

/** Reads the registry snapshot bundled with this npm install. Never throws: a missing or
 * malformed bundled file -- which would only happen from a broken build -- degrades to an empty
 * registry rather than crashing the server that depends on it. */
export function loadBundledRegistry(): RegistryFile {
	try {
		const parsed = JSON.parse(readFileSync(BUNDLED_REGISTRY_PATH, "utf-8"));
		return isValidRegistryFile(parsed) ? parsed : EMPTY_REGISTRY;
	} catch {
		return EMPTY_REGISTRY;
	}
}
```

- [ ] **Step 4: Add the build-time copy step**

```js
// server/scripts/copy-registry-snapshot.mjs
#!/usr/bin/env node
// Copies the repo-root registry/plugins.json into dist/registry/plugins.json so it ships inside
// the published npm package (see registry.ts's BUNDLED_REGISTRY_PATH). A plain Node script rather
// than a shell `cp` so `npm run build` works identically on every platform contributors use.
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "registry", "plugins.json");
const destDir = join(here, "..", "dist", "registry");
const dest = join(destDir, "plugins.json");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
```

Update `server/package.json`'s scripts:

```json
"scripts": {
	"build": "tsc && node scripts/copy-registry-snapshot.mjs",
	"prepublishOnly": "npm run build && npm test",
	"start": "node dist/index.js",
	"dev": "npm run build && node dist/index.js",
	"test": "node --test test/*.js"
}
```

- [ ] **Step 5: Build and run the tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — `registry.test.js`'s new tests pass, and every pre-existing test still passes (no other module changed yet).

- [ ] **Step 6: Commit**

```bash
git add registry/plugins.json server/src/registry.ts server/scripts/copy-registry-snapshot.mjs server/package.json server/test/registry.test.js
git commit -m "feat(registry): add the schema-validated index and its bundled snapshot"
```

---

### Task 2: On-disk cache + TTL-gated background refresh

**Files:**
- Modify: `server/src/registry.ts`
- Test: `server/test/registry.test.js`

**Interfaces:**
- Consumes: `RegistryFile`, `isValidRegistryFile`, `loadBundledRegistry` from Task 1.
- Produces: `currentRegistry(pluginsRoot: string): RegistryFile`, `refreshRegistryIfStale(pluginsRoot: string): Promise<void>`, `REGISTRY_TTL_MS: number` — consumed by Task 6 (server.ts wiring) and Task 8 is unaffected (CI only needs `isValidRegistryFile`).

- [ ] **Step 1: Write the failing tests**

Append to `server/test/registry.test.js`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { currentRegistry, refreshRegistryIfStale } from "../dist/registry.js";

async function withTempPluginsRoot(fn) {
	const root = mkdtempSync(join(tmpdir(), "tether-registry-test-"));
	try {
		return await fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("currentRegistry", () => {
	test("falls back to the bundled snapshot when no cache file exists", async () => {
		await withTempPluginsRoot((root) => {
			assert.deepEqual(currentRegistry(root), loadBundledRegistry());
		});
	});

	test("prefers a valid cache file over the bundled snapshot", async () => {
		await withTempPluginsRoot((root) => {
			mkdirSync(root, { recursive: true });
			const data = { schemaVersion: 1, entries: [{ name: "X", slug: "x", repo: "r", description: "d", kind: "widget" }] };
			writeFileSync(join(root, "registry-cache.json"), JSON.stringify({ fetchedAt: Date.now(), data }));
			assert.deepEqual(currentRegistry(root), data);
		});
	});

	test("falls back to bundled when the cache file is malformed", async () => {
		await withTempPluginsRoot((root) => {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "registry-cache.json"), "{not json");
			assert.deepEqual(currentRegistry(root), loadBundledRegistry());
		});
	});

	test("falls back to bundled when the cache file's data fails schema validation", async () => {
		await withTempPluginsRoot((root) => {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "registry-cache.json"), JSON.stringify({ fetchedAt: Date.now(), data: { bogus: true } }));
			assert.deepEqual(currentRegistry(root), loadBundledRegistry());
		});
	});
});

describe("refreshRegistryIfStale", () => {
	test("does nothing when the cache is already fresh", async () => {
		await withTempPluginsRoot(async (root) => {
			mkdirSync(root, { recursive: true });
			const data = { schemaVersion: 1, entries: [] };
			writeFileSync(join(root, "registry-cache.json"), JSON.stringify({ fetchedAt: Date.now(), data }));
			let hit = false;
			const server = createServer((_req, res) => { hit = true; res.end("{}"); });
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			try {
				process.env.TETHER_REGISTRY_URL = `http://127.0.0.1:${server.address().port}`;
				await refreshRegistryIfStale(root);
				assert.equal(hit, false);
			} finally {
				delete process.env.TETHER_REGISTRY_URL;
				await new Promise((r) => server.close(r));
			}
		});
	});

	test("fetches and writes a fresh cache when stale/missing", async () => {
		await withTempPluginsRoot(async (root) => {
			const fresh = { schemaVersion: 1, entries: [{ name: "New", slug: "new-plugin", repo: "r", description: "d", kind: "widget" }] };
			const server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(fresh));
			});
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			try {
				process.env.TETHER_REGISTRY_URL = `http://127.0.0.1:${server.address().port}`;
				await refreshRegistryIfStale(root);
				assert.deepEqual(currentRegistry(root), fresh);
			} finally {
				delete process.env.TETHER_REGISTRY_URL;
				await new Promise((r) => server.close(r));
			}
		});
	});

	test("an invalid CDN payload is discarded, leaving the bundled snapshot in place", async () => {
		await withTempPluginsRoot(async (root) => {
			const server = createServer((_req, res) => res.end(JSON.stringify({ bogus: true })));
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			try {
				process.env.TETHER_REGISTRY_URL = `http://127.0.0.1:${server.address().port}`;
				await refreshRegistryIfStale(root);
				assert.deepEqual(currentRegistry(root), loadBundledRegistry());
			} finally {
				delete process.env.TETHER_REGISTRY_URL;
				await new Promise((r) => server.close(r));
			}
		});
	});

	test("a network error is swallowed, never rejects", async () => {
		await withTempPluginsRoot(async (root) => {
			try {
				process.env.TETHER_REGISTRY_URL = "http://127.0.0.1:1"; // nothing listens here
				await assert.doesNotReject(refreshRegistryIfStale(root));
			} finally {
				delete process.env.TETHER_REGISTRY_URL;
			}
		});
	});
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL — `currentRegistry`/`refreshRegistryIfStale` are not exported yet.

- [ ] **Step 3: Implement the cache + refresh logic**

Append to `server/src/registry.ts` (add `mkdirSync`, `writeFileSync`, `join` to the existing imports):

```ts
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
```

```ts
interface RegistryCache {
	fetchedAt: number;
	data: RegistryFile;
}

function registryCachePath(pluginsRoot: string): string {
	return join(pluginsRoot, "registry-cache.json");
}

function readRegistryCache(pluginsRoot: string): RegistryCache | null {
	try {
		const parsed = JSON.parse(readFileSync(registryCachePath(pluginsRoot), "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const { fetchedAt, data } = parsed as Record<string, unknown>;
		if (typeof fetchedAt !== "number" || !isValidRegistryFile(data)) return null;
		return { fetchedAt, data };
	} catch {
		return null;
	}
}

function writeRegistryCache(pluginsRoot: string, data: RegistryFile, fetchedAt: number): void {
	// mode 0o700 matches plugins.ts's data-directory convention -- this cache sits inside the same
	// plugins root as dev-overrides.json/analytics-dashboard.json.
	mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
	writeFileSync(registryCachePath(pluginsRoot), JSON.stringify({ fetchedAt, data }, null, 2));
}

/** The registry data to show right now: the disk cache (from a prior live refresh) if present and
 * valid, otherwise the snapshot bundled with this install. Never triggers a fetch itself -- call
 * refreshRegistryIfStale separately to opportunistically update the cache in the background; this
 * function only ever reads what's already on disk, so it's always safe to call synchronously from
 * a request handler. */
export function currentRegistry(pluginsRoot: string): RegistryFile {
	return readRegistryCache(pluginsRoot)?.data ?? loadBundledRegistry();
}

export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_REGISTRY_URL = "https://cdn.jsdelivr.net/gh/tmam-dev/tether@main/registry/plugins.json";

function registryUrl(): string {
	return process.env.TETHER_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

// Keyed by pluginsRoot rather than a single scalar so two different data directories (as in two
// concurrent test cases, each with their own temp pluginsRoot) never throttle each other.
const lastAttemptByRoot = new Map<string, number>();

/** Opportunistically refreshes the on-disk registry cache from the CDN when it's missing or older
 * than REGISTRY_TTL_MS, throttled to at most one attempt per REGISTRY_RETRY_MS per pluginsRoot so
 * a down/unreachable CDN isn't hit on every single request. Always resolves, never rejects --  a
 * failed fetch just leaves the existing cache (or bundled snapshot) in place for currentRegistry()
 * to keep serving. Real callers fire this without awaiting it (`void refreshRegistryIfStale(...)`);
 * it returns its promise only so tests can await the outcome deterministically. */
export function refreshRegistryIfStale(pluginsRoot: string): Promise<void> {
	const cached = readRegistryCache(pluginsRoot);
	const now = Date.now();
	if (cached && now - cached.fetchedAt < REGISTRY_TTL_MS) return Promise.resolve();
	const lastAttempt = lastAttemptByRoot.get(pluginsRoot) ?? 0;
	if (now - lastAttempt < REGISTRY_RETRY_MS) return Promise.resolve();
	lastAttemptByRoot.set(pluginsRoot, now);
	return fetch(registryUrl(), { signal: AbortSignal.timeout(5000) })
		.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`registry fetch failed: ${res.status}`))))
		.then((json) => {
			if (!isValidRegistryFile(json)) throw new Error("registry payload failed validation");
			writeRegistryCache(pluginsRoot, json, Date.now());
		})
		.catch(() => {
			/* best effort -- next stale check (after REGISTRY_RETRY_MS) retries */
		});
}
```

- [ ] **Step 4: Build and run the tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — all `registry.test.js` tests green, full suite still green.

- [ ] **Step 5: Commit**

```bash
git add server/src/registry.ts server/test/registry.test.js
git commit -m "feat(registry): add TTL-cached background refresh from the CDN snapshot"
```

---

### Task 3: Share `plugin add`'s install logic between the CLI and the server

**Files:**
- Modify: `server/src/plugins.ts`
- Modify: `server/src/cli/plugin-commands.ts`
- Test: `server/test/plugins.test.js`

**Interfaces:**
- Produces: `installPluginFromGitUrl(gitUrl: string, pluginsRoot: string): InstallResult` where `InstallResult = { ok: true; manifest: PluginManifest; versionMismatch: boolean } | { ok: false; error: string }` — exported from `server/src/plugins.ts`, consumed by Task 6's new `POST /api/v1/plugins/install` route.
- Consumes: existing `pluginsDir`, `isPlainSlug`, `readManifest`, `TETHER_API_VERSION` from `plugins.ts`.

- [ ] **Step 1: Write the failing test for the new shared function**

Add to `server/test/plugins.test.js` (new imports: `execFileSync` from `node:child_process`; new import `installPluginFromGitUrl` from `../dist/plugins.js`):

```js
import { execFileSync } from "node:child_process";
import { installPluginFromGitUrl } from "../dist/plugins.js";

function makeFixtureRepo(slug = "waterfall-view", manifestOverrides = {}) {
	const repoDir = mkdtempSync(join(tmpdir(), "tether-plugin-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
	const manifest = {
		name: "Waterfall View", slug, version: "1.0.0", author: "test",
		description: "test plugin", entry: "dist/index.html", replaces: "detail", tetherApiVersion: 1,
		...manifestOverrides,
	};
	writeFileSync(join(repoDir, "tether-plugin.json"), JSON.stringify(manifest));
	mkdirSync(join(repoDir, "dist"));
	writeFileSync(join(repoDir, "dist", "index.html"), "<!doctype html><p>waterfall</p>");
	execFileSync("git", ["add", "-A"], { cwd: repoDir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });
	return repoDir;
}

describe("installPluginFromGitUrl", () => {
	test("clones a valid plugin repo into the plugins root under its manifest slug", () => {
		withTempPluginsRoot((root) => {
			const repoDir = makeFixtureRepo("waterfall-view");
			const result = installPluginFromGitUrl(repoDir, root);
			assert.equal(result.ok, true);
			assert.equal(result.manifest.slug, "waterfall-view");
			assert.equal(result.versionMismatch, false);
			assert.ok(existsSync(join(root, "waterfall-view", "tether-plugin.json")));
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("reports versionMismatch true without deleting anything", () => {
		withTempPluginsRoot((root) => {
			const repoDir = makeFixtureRepo("future-view", { tetherApiVersion: 99 });
			const result = installPluginFromGitUrl(repoDir, root);
			assert.equal(result.ok, true);
			assert.equal(result.versionMismatch, true);
			assert.ok(existsSync(join(root, "future-view")));
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("returns ok:false with no installed directory for a repo with no valid manifest", () => {
		withTempPluginsRoot((root) => {
			const repoDir = mkdtempSync(join(tmpdir(), "tether-plugin-badrepo-"));
			execFileSync("git", ["init", "-q"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
			writeFileSync(join(repoDir, "README.md"), "no manifest here");
			execFileSync("git", ["add", "-A"], { cwd: repoDir });
			execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });

			const result = installPluginFromGitUrl(repoDir, root);
			assert.equal(result.ok, false);
			assert.match(result.error, /missing or invalid/);
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("returns ok:false for a git URL that doesn't resolve", () => {
		withTempPluginsRoot((root) => {
			const result = installPluginFromGitUrl(join(tmpdir(), "definitely-does-not-exist-" + Date.now()), root);
			assert.equal(result.ok, false);
			assert.match(result.error, /git clone failed/);
		});
	});
});
```

Note `existsSync`, `mkdtempSync`, `writeFileSync`, `mkdirSync`, `rmSync` are already imported at the top of `plugins.test.js`; `withTempPluginsRoot` already exists in that file.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL — `installPluginFromGitUrl` is not exported from `plugins.js` yet.

- [ ] **Step 3: Move the install logic into `plugins.ts`**

Add to `server/src/plugins.ts`'s imports (extend the existing `node:fs` import and add a new one):

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
```

Append near the end of `server/src/plugins.ts` (these three are moved verbatim from `plugin-commands.ts`, with only the leading comment adjusted since they're no longer CLI-specific):

```ts
/** Best-effort cleanup of a temp clone dir -- guarded so a cleanup failure never masks the
 * original error that triggered it. */
function cleanupCloneTarget(cloneTarget: string): void {
	try {
		rmSync(cloneTarget, { recursive: true, force: true });
	} catch (err) {
		console.error(`Warning: failed to clean up temp directory "${cloneTarget}": ${(err as Error).message}`);
	}
}

/** Removes any `.tmp-install-*` staging directory left behind under `root` -- normally cleaned up
 * by `cleanupCloneTarget` on every failure path, but a process kill mid-install skips that cleanup
 * entirely. Already invisible to `listInstalledPlugins`/`resolvePluginAssetPath` (both refuse
 * dot-prefixed names), so a leftover one is inert disk usage, not a correctness issue -- this just
 * stops it from accumulating. Best-effort: a sweep failure is not a reason to fail the install. */
function sweepStaleInstallDirs(root: string): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.startsWith(".tmp-install-")) continue;
		try {
			rmSync(join(root, name), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

export type InstallResult = { ok: true; manifest: PluginManifest; versionMismatch: boolean } | { ok: false; error: string };

/** Clones `gitUrl` and installs it under `pluginsRoot` as a plugin, exactly like the CLI's
 * `plugin add` (which now calls this directly) -- shared so the new /api/v1/plugins/install route
 * (server.ts) installs a registry entry via the identical validated path, not a second
 * implementation. Never throws; every failure comes back as `{ ok: false, error }` so a caller
 * (CLI or HTTP route) can report it however fits that surface. */
export function installPluginFromGitUrl(gitUrl: string, pluginsRoot: string): InstallResult {
	// Staged INSIDE pluginsRoot, not the OS temp dir: the final install is a renameSync into this
	// same directory, and rename(2) fails with EXDEV across filesystems.
	let cloneTarget: string;
	try {
		mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
		sweepStaleInstallDirs(pluginsRoot);
		cloneTarget = mkdtempSync(join(pluginsRoot, ".tmp-install-"));
	} catch (err) {
		return { ok: false, error: `Failed to prepare the plugins directory: ${(err as Error).message}` };
	}

	try {
		// `-c protocol.ext.allow=never` disables git's `ext::` transport (arbitrary shell command
		// execution). `--` stops a gitUrl beginning with `-` from being parsed as a git option.
		execFileSync("git", ["-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--", gitUrl, cloneTarget], { stdio: "pipe" });
	} catch (err) {
		cleanupCloneTarget(cloneTarget);
		return { ok: false, error: `git clone failed: ${(err as Error).message}` };
	}

	const manifest = readManifest(cloneTarget);
	if (!manifest) {
		cleanupCloneTarget(cloneTarget);
		return { ok: false, error: "tether-plugin.json is missing or invalid at the repo root." };
	}

	// manifest.slug comes from the cloned repo's tether-plugin.json -- attacker-controlled remote
	// content when gitUrl points at a malicious or compromised repo.
	if (!isPlainSlug(manifest.slug)) {
		cleanupCloneTarget(cloneTarget);
		return { ok: false, error: `Refusing to continue: manifest slug "${manifest.slug}" is not a valid plugin slug.` };
	}

	try {
		const dest = join(pluginsRoot, manifest.slug);
		rmSync(dest, { recursive: true, force: true });
		renameSync(cloneTarget, dest);
	} catch (err) {
		cleanupCloneTarget(cloneTarget);
		return { ok: false, error: `Failed to install plugin into the plugins directory: ${(err as Error).message}` };
	}

	return { ok: true, manifest, versionMismatch: manifest.tetherApiVersion !== TETHER_API_VERSION };
}
```

- [ ] **Step 4: Turn `plugin-commands.ts`'s `addPlugin` into a thin wrapper**

In `server/src/cli/plugin-commands.ts`, delete the now-duplicated `cleanupCloneTarget` and `sweepStaleInstallDirs` functions (moved to `plugins.ts`), update the import line, and replace `addPlugin`'s body:

```ts
import { installPluginFromGitUrl, isPlainSlug, pluginsDir, readManifest, setDevOverride, TETHER_API_VERSION } from "../plugins.js";
```

```ts
function addPlugin(gitUrl: string, dataDir: string): number {
	const result = installPluginFromGitUrl(gitUrl, pluginsDir(dataDir));
	if (!result.ok) {
		console.error(result.error);
		return 1;
	}
	const { manifest } = result;
	const target = manifest.kind === "widget" ? `analytics widget (${manifest.size})` : `replaces "${manifest.replaces}"`;
	console.log(`Installed "${manifest.name}" (${manifest.slug}) -> ${target}`);
	if (result.versionMismatch) {
		console.warn(
			`Warning: "${manifest.name}" (${manifest.slug}) targets Tether plugin API v${manifest.tetherApiVersion}, ` +
				`this server runs v${TETHER_API_VERSION} — it won't appear in any picker until updated.`
		);
	}
	return 0;
}
```

Note: after this change, `plugin-commands.ts` no longer uses `execFileSync` (node:child_process) or `mkdtempSync`/`mkdirSync`/`readdirSync`/`renameSync` (node:fs) anywhere in the file — `cleanupCloneTarget`, `sweepStaleInstallDirs`, and `addPlugin`'s body were their only call sites, and all three moved to `plugins.ts`. Remove the `node:child_process` import entirely and narrow the `node:fs` import to just `existsSync, rmSync` — the only two `removePlugin`/`devPlugin` still use (verify with `grep -n "mkdirSync\|readdirSync\|rmSync\|existsSync\|execFileSync\|mkdtempSync\|renameSync" server/src/cli/plugin-commands.ts` after editing: every remaining hit should be `existsSync` or `rmSync`).

- [ ] **Step 5: Build and run both the new and existing tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — the new `installPluginFromGitUrl` tests pass, and every existing `plugin-commands.test.js` test (console output, exit codes, slug-rejection, version-mismatch warning, stale-staging-dir sweep) still passes unchanged, confirming the refactor preserved CLI behavior exactly.

- [ ] **Step 6: Commit**

```bash
git add server/src/plugins.ts server/src/cli/plugin-commands.ts server/test/plugins.test.js
git commit -m "refactor(plugins): share plugin add's install logic via installPluginFromGitUrl"
```

---

### Task 4: Extend the per-slot panel picker with a "Browse marketplace" group

**Files:**
- Modify: `server/src/templates/shell.ts`
- Test: `server/test/shell.test.js`

**Interfaces:**
- Consumes: `RegistryEntry` type from `server/src/registry.ts` (Task 1).
- Produces: `SlotPickerOptions { installed: PluginOption[]; registry: RegistryEntry[] }`, and `renderShell`'s `pluginsBySlot` parameter is now typed `Record<ShellView, SlotPickerOptions>` — consumed by Task 6 (server.ts).

- [ ] **Step 1: Write the failing tests**

Replace the `describe("plugin picker", ...)` block in `server/test/shell.test.js` with:

```js
describe("plugin picker", () => {
	const plugins = {
		detail: { installed: [{ slug: "waterfall-view", name: "Waterfall View", entry: "dist/index.html" }], registry: [] },
		harness: { installed: [], registry: [] },
		analytics: { installed: [], registry: [] },
	};

	test("renders a picker (by fixed id) for a slot with installed plugins, visible for the active view", () => {
		const html = renderShell({ view: "detail", traceId: "a".repeat(32) }, "Tether", "", "", plugins);
		assert.match(html, /<select id="pluginPickerDetail" class="plugin-picker" data-plugin-slot="detail">/);
		assert.match(html, /<option value="waterfall-view" data-entry="dist\/index\.html">Waterfall View<\/option>/);
		assert.doesNotMatch(html, /id="pluginPickerDetail"[^>]*style="display:\s*none"/);
	});

	test("hides a slot's picker when it isn't the active view", () => {
		const html = renderShell({ view: "analytics" }, "Tether", "", "", plugins);
		assert.match(html, /id="pluginPickerDetail"[^>]*style="display:\s*none"/);
	});

	test("omits a picker entirely for a slot with no installed plugins and no registry entries", () => {
		const html = renderShell({ view: "harness", traceId: "a".repeat(32) }, "Tether", "", "", plugins);
		assert.doesNotMatch(html, /id="pluginPickerHarness"/);
	});

	test("defaults to no pickers when pluginsBySlot is omitted", () => {
		const html = renderShell({ view: "detail", traceId: "a".repeat(32) }, "Tether", "", "");
		assert.doesNotMatch(html, /plugin-picker/);
	});

	test("renders a picker for a slot with zero installed plugins but a registry entry", () => {
		const withRegistry = {
			detail: { installed: [], registry: [] },
			harness: { installed: [], registry: [{ name: "Waterfall", slug: "waterfall-view", repo: "r", description: "A waterfall view.", kind: "panel", slot: "harness" }] },
			analytics: { installed: [], registry: [] },
		};
		const html = renderShell({ view: "harness", traceId: "a".repeat(32) }, "Tether", "", "", withRegistry);
		assert.match(html, /<select id="pluginPickerHarness"/);
		assert.match(html, /<optgroup label="Browse marketplace">/);
		assert.match(html, /<option value="registry:waterfall-view" data-registry-slug="waterfall-view" title="A waterfall view\.">Waterfall \(install\)<\/option>/);
	});

	test("escapes a registry entry's name and description", () => {
		const withRegistry = {
			detail: { installed: [], registry: [] },
			harness: { installed: [], registry: [] },
			analytics: { installed: [], registry: [{ name: "<script>alert(1)</script>", slug: "evil", repo: "r", description: "<img onerror=alert(1)>", kind: "panel", slot: "analytics" }] },
		};
		const html = renderShell({ view: "analytics" }, "Tether", "", "", withRegistry);
		assert.equal(html.includes("<script>alert(1)</script>"), false);
		assert.equal(html.includes("<img onerror=alert(1)>"), false);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL — the existing `pluginPicker`/`renderShell` code still expects a flat `PluginOption[]` per slot, so the new fixture shape breaks the old assertions and the new optgroup assertions find nothing.

- [ ] **Step 3: Implement the optgroup in `shell.ts`**

Add the import and new type near the top of `server/src/templates/shell.ts`:

```ts
import type { RegistryEntry } from "../registry.js";
```

```ts
export interface SlotPickerOptions {
	installed: PluginOption[];
	registry: RegistryEntry[];
}
```

Replace `pluginPicker`:

```ts
function pluginPicker(slot: ShellView, state: ShellState, data: SlotPickerOptions): string {
	if (data.installed.length === 0 && data.registry.length === 0) return "";
	const visible = state.view === slot;
	const opts = data.installed
		.map((o) => `<option value="${escapeHtml(o.slug)}" data-entry="${escapeHtml(o.entry)}">${escapeHtml(o.name)}</option>`)
		.join("");
	const registryOpts = data.registry.length
		? `<optgroup label="Browse marketplace">${data.registry
				.map(
					(o) =>
						`<option value="registry:${escapeHtml(o.slug)}" data-registry-slug="${escapeHtml(o.slug)}" title="${escapeHtml(o.description)}">${escapeHtml(o.name)} (install)</option>`
				)
				.join("")}</optgroup>`
		: "";
	return `<select id="${PLUGIN_PICKER_IDS[slot]}" class="plugin-picker" data-plugin-slot="${slot}"${visible ? "" : ' style="display:none"'}><option value="">Native</option>${opts}${registryOpts}</select>`;
}
```

Update `topbar`'s parameter type and `NO_PLUGINS`:

```ts
function topbar(state: ShellState, pluginsBySlot: Record<ShellView, SlotPickerOptions>): string {
	// ...unchanged body — pluginPicker("detail", state, pluginsBySlot.detail) etc. already pass the whole object through.
}

const NO_PLUGINS: Record<ShellView, SlotPickerOptions> = {
	detail: { installed: [], registry: [] },
	harness: { installed: [], registry: [] },
	analytics: { installed: [], registry: [] },
};
```

Update `renderShell`'s signature and `hasPlugins` check:

```ts
export function renderShell(
	state: ShellState,
	title: string,
	railHtml: string,
	panelHtml: string,
	pluginsBySlot: Record<ShellView, SlotPickerOptions> = NO_PLUGINS
): string {
	const bootstrap = JSON.stringify({ view: state.view, traceId: state.traceId ?? null }).replace(/</g, "\\u003c");
	const hasPlugins = Object.values(pluginsBySlot).some((p) => p.installed.length > 0 || p.registry.length > 0);
	// ...rest unchanged
}
```

- [ ] **Step 4: Build and run the tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — `shell.test.js` green. `server.test.js` will now fail to compile/pass because `pluginsBySlot` in `server.ts` still returns the old flat shape — that's expected and fixed in Task 6; note it but don't fix it here.

- [ ] **Step 5: Commit**

```bash
git add server/src/templates/shell.ts server/test/shell.test.js
git commit -m "feat(shell): add a Browse-marketplace optgroup to the per-slot plugin picker"
```

---

### Task 5: Extend the Analytics "Add widget" picker with the same marketplace group

**Files:**
- Modify: `server/src/templates/analytics.ts`
- Test: `server/test/analytics-page.test.js`

**Interfaces:**
- Consumes: `RegistryEntry` type from `server/src/registry.ts` (Task 1).
- Produces: `renderAnalyticsBody(usage, widgets?, registryWidgets?)` — third parameter consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/analytics-page.test.js`:

```js
function registryWidget(overrides = {}) {
	return { name: "Latency P95", slug: "latency-p95", repo: "r", description: "p95 latency trend.", kind: "widget", ...overrides };
}

describe("renderAnalyticsBody widget dashboard — registry", () => {
	test("renders the section (even with zero installed widgets) when a registry widget exists", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] }, [], [registryWidget()]);
		assert.match(html, /id="addWidgetPicker"/);
		assert.match(html, /<optgroup label="Browse marketplace">/);
		assert.match(html, /<option value="registry:latency-p95" data-registry-slug="latency-p95" title="p95 latency trend\.">Latency P95 \(install\)<\/option>/);
	});

	test("renders neither the picker nor the grid when both installed and registry widgets are empty", () => {
		const html = renderAnalyticsBody({ totalRuns: 0, trackedRuns: 0, entries: [] }, [], []);
		assert.equal(html.includes("addWidgetPicker"), false);
	});

	test("escapes a registry widget's name and description", () => {
		const html = renderAnalyticsBody(
			{ totalRuns: 0, trackedRuns: 0, entries: [] },
			[],
			[registryWidget({ name: "<script>alert(1)</script>", description: "<img onerror=alert(1)>" })]
		);
		assert.equal(html.includes("<script>alert(1)</script>"), false);
		assert.equal(html.includes("<img onerror=alert(1)>"), false);
	});
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL — `renderAnalyticsBody` ignores a third argument today, so no optgroup is rendered.

- [ ] **Step 3: Implement in `analytics.ts`**

```ts
import type { RegistryEntry } from "../registry.js";
```

Replace `widgetDashboard` and `renderAnalyticsBody`:

```ts
function widgetDashboard(widgets: WidgetOption[], registryWidgets: RegistryEntry[] = []): string {
	if (widgets.length === 0 && registryWidgets.length === 0) return "";
	const opts = widgets
		.map((w) => `<option value="${escapeHtml(w.slug)}" data-entry="${escapeHtml(w.entry)}" data-size="${escapeHtml(w.size)}">${escapeHtml(w.name)}</option>`)
		.join("");
	const registryOpts = registryWidgets.length
		? `<optgroup label="Browse marketplace">${registryWidgets
				.map(
					(w) =>
						`<option value="registry:${escapeHtml(w.slug)}" data-registry-slug="${escapeHtml(w.slug)}" title="${escapeHtml(w.description)}">${escapeHtml(w.name)} (install)</option>`
				)
				.join("")}</optgroup>`
		: "";
	return `<section class="widget-dashboard">
		<div class="widget-dashboard-head">
			<h2>Widgets</h2>
			<select id="addWidgetPicker" class="plugin-picker"><option value="">Add widget…</option>${opts}${registryOpts}</select>
		</div>
		<div id="widgetGrid" class="widget-grid"></div>
	</section>`;
}

export function renderAnalyticsBody(usage: UsageView, widgets: WidgetOption[] = [], registryWidgets: RegistryEntry[] = []): string {
	const skills = usage.entries.filter((e) => e.type === "skill");
	const subAgents = usage.entries.filter((e) => e.type === "sub_agent");
	const mcpServers = usage.entries.filter((e) => e.type === "mcp_server");

	if (usage.totalRuns === 0) return `<p class="empty">No runs yet.</p>` + widgetDashboard(widgets, registryWidgets);
	if (usage.trackedRuns === 0) {
		return (
			`<p class="empty">No runs have reported skill/sub-agent/MCP-server usage yet — coverage tracking requires trail_log_step calls with source_type/source_name set.</p>` +
			widgetDashboard(widgets, registryWidgets)
		);
	}
	if (usage.entries.length === 0) {
		return `<p class="empty">No skills, sub-agents, or MCP servers have been registered by any run.</p>` + widgetDashboard(widgets, registryWidgets);
	}

	const untracked = usage.totalRuns - usage.trackedRuns;
	const note = untracked > 0 ? `<p class="note">${untracked} run(s) have no coverage tracking (excluded from the counts below).</p>` : "";
	return `<p class="as-of">Usage across ${usage.totalRuns} run(s)</p>
	${note}
	${section("Skills", skills, "No skills registered by any run.")}
	${section("Sub-agents", subAgents, "No sub-agents registered by any run.")}
	${section("MCP servers", mcpServers, "No MCP servers registered by any run.")}
	${widgetDashboard(widgets, registryWidgets)}`;
}
```

- [ ] **Step 4: Build and run the tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — all `analytics-page.test.js` tests, old and new, pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/templates/analytics.ts server/test/analytics-page.test.js
git commit -m "feat(analytics): add a Browse-marketplace optgroup to the Add-widget picker"
```

---

### Task 6: Wire the registry into `server.ts` and add the install route

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/test/server.test.js`

**Interfaces:**
- Consumes: `installPluginFromGitUrl` (Task 3), `currentRegistry`/`refreshRegistryIfStale` (Tasks 1–2), `SlotPickerOptions` (Task 4), `renderAnalyticsBody`'s new third parameter (Task 5).
- Produces: `POST /api/v1/plugins/install` — request `{ slug: string }`, success response `{ ok: true, plugin: PluginManifest, compatible: boolean }`, consumed by Task 7 (app.ts).

- [ ] **Step 1: Write the failing tests**

Add to `server/test/server.test.js` (new imports: `execFileSync` from `node:child_process`, reuse the file's existing `mkdtempSync`/`mkdirSync`/`writeFileSync`/`rmSync`/`join`/`tmpdir`):

```js
import { execFileSync } from "node:child_process";

function makeRegistryFixtureRepo(slug, manifestOverrides = {}) {
	const repoDir = mkdtempSync(join(tmpdir(), "tether-registry-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
	const manifest = { name: "Registry Widget", slug, version: "1.0.0", author: "test", description: "d", entry: "dist/index.html", kind: "widget", size: "small", tetherApiVersion: 1, ...manifestOverrides };
	writeFileSync(join(repoDir, "tether-plugin.json"), JSON.stringify(manifest));
	mkdirSync(join(repoDir, "dist"));
	writeFileSync(join(repoDir, "dist", "index.html"), "<!doctype html><p>widget</p>");
	execFileSync("git", ["add", "-A"], { cwd: repoDir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });
	return repoDir;
}

function seedRegistryCache(pluginsRoot, entries) {
	mkdirSync(pluginsRoot, { recursive: true });
	writeFileSync(join(pluginsRoot, "registry-cache.json"), JSON.stringify({ fetchedAt: Date.now(), data: { schemaVersion: 1, entries } }));
}

describe("POST /api/v1/plugins/install", () => {
	test("installs a registry entry and returns its manifest", async () => {
		const pluginsRoot = mkdtempSync(join(tmpdir(), "tether-plugins-install-"));
		const repoDir = makeRegistryFixtureRepo("latency-p95");
		seedRegistryCache(pluginsRoot, [{ name: "Latency P95", slug: "latency-p95", repo: repoDir, description: "d", kind: "widget" }]);
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/plugins/install`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "latency-p95" }),
			});
			const body = await res.json();
			assert.equal(res.status, 200);
			assert.equal(body.ok, true);
			assert.equal(body.plugin.slug, "latency-p95");
			assert.equal(body.compatible, true);
		}, { pluginsRoot });
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});

	test("404s for a slug not in the registry", async () => {
		const pluginsRoot = mkdtempSync(join(tmpdir(), "tether-plugins-install-"));
		seedRegistryCache(pluginsRoot, []);
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/plugins/install`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "nope" }),
			});
			assert.equal(res.status, 404);
			assert.equal((await res.json()).ok, false);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});

	test("400s for a body missing slug", async () => {
		const pluginsRoot = mkdtempSync(join(tmpdir(), "tether-plugins-install-"));
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/plugins/install`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
			});
			assert.equal(res.status, 400);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});

	test("502s when the registry's repo doesn't resolve", async () => {
		const pluginsRoot = mkdtempSync(join(tmpdir(), "tether-plugins-install-"));
		seedRegistryCache(pluginsRoot, [{ name: "Broken", slug: "broken", repo: join(tmpdir(), "does-not-exist-" + Date.now()), description: "d", kind: "widget" }]);
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/plugins/install`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "broken" }),
			});
			assert.equal(res.status, 502);
			assert.equal((await res.json()).ok, false);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});
});
```

Note: `withServer` already exists in this file and accepts `{ pluginsRoot }`; global `fetch` is used directly in the test the same way the file already exercises other routes (check the top of `server.test.js` for its existing pattern and match it — some existing tests use `node:http`'s `request` instead of `fetch`; use whichever this file already uses elsewhere for a POST-with-JSON-body call, for consistency).

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL — no `/api/v1/plugins/install` route exists yet; `pluginsBySlot`'s shape change from Task 4 also needs `server.ts` updated before the file even compiles cleanly against `shell.ts`'s new types.

- [ ] **Step 3: Update `server.ts`**

Update the `plugins.js` import line to add `installPluginFromGitUrl`, add a new import for the registry module, and add `SlotPickerOptions` to the existing `shell.js` type import:

```ts
import { resolvePluginAssetPath, contentTypeFor, readDevOverrides, listInstalledPlugins, readDashboardSlugs, writeDashboardSlugs, installPluginFromGitUrl } from "./plugins.js";
import { currentRegistry, refreshRegistryIfStale } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
```

```ts
import type { ShellState, ShellView, PluginOption, SlotPickerOptions } from "./templates/shell.js";
```

Replace `pluginsBySlot`:

```ts
/** Every compatible installed plugin under `pluginsRoot`, grouped by the shell slot it replaces,
 * alongside every not-yet-installed compatible registry entry for that slot -- the shape
 * renderShell's picker expects. Also the one place a full-page render opportunistically kicks off
 * a background registry refresh (fire-and-forget; never awaited here). */
function pluginsBySlot(pluginsRoot: string): Record<"detail" | "harness" | "analytics", SlotPickerOptions> {
	void refreshRegistryIfStale(pluginsRoot);
	const installedPlugins = listInstalledPlugins(pluginsRoot);
	const compatible = installedPlugins.filter((p) => p.compatible && p.kind !== "widget");
	const installedSlugs = new Set(installedPlugins.map((p) => p.slug));
	const toOption = (p: (typeof compatible)[number]): PluginOption => ({ slug: p.slug, name: p.name, entry: p.entry });
	const registryPanels = currentRegistry(pluginsRoot).entries.filter((e) => e.kind === "panel" && !installedSlugs.has(e.slug));
	return {
		detail: { installed: compatible.filter((p) => p.replaces === "detail").map(toOption), registry: registryPanels.filter((e) => e.slot === "detail") },
		harness: { installed: compatible.filter((p) => p.replaces === "harness").map(toOption), registry: registryPanels.filter((e) => e.slot === "harness") },
		analytics: { installed: compatible.filter((p) => p.replaces === "analytics").map(toOption), registry: registryPanels.filter((e) => e.slot === "analytics") },
	};
}
```

Add a new helper right after `widgetOptions`:

```ts
/** Every not-yet-installed kind:"widget" registry entry -- the marketplace analog of
 * widgetOptions for the Add-widget picker's optgroup. Also opportunistically triggers a
 * background registry refresh, same as pluginsBySlot -- this covers the Analytics routes, which
 * don't call pluginsBySlot. */
function registryWidgetOptions(pluginsRoot: string): RegistryEntry[] {
	void refreshRegistryIfStale(pluginsRoot);
	const installedSlugs = new Set(listInstalledPlugins(pluginsRoot).map((p) => p.slug));
	return currentRegistry(pluginsRoot).entries.filter((e) => e.kind === "widget" && !installedSlugs.has(e.slug));
}
```

Update both existing `renderAnalyticsBody(getUsage(db), widgetOptions(pluginsRoot))` call sites (the `/fragments/analytics` route and the `/analytics` route) to:

```ts
renderAnalyticsBody(getUsage(db), widgetOptions(pluginsRoot), registryWidgetOptions(pluginsRoot))
```

Add the new route. Place it immediately after the `PUT /api/v1/dashboard/analytics` block and before the `pluginAssetMatch` block:

```ts
if (req.method === "POST" && pathname === "/api/v1/plugins/install") {
	let parsed: unknown;
	try {
		const bodyText = await readBody(req);
		parsed = JSON.parse(bodyText);
	} catch (err) {
		sendError(res, 400, `invalid JSON body: ${(err as Error).message}`);
		return;
	}
	try {
		const slug = (parsed as { slug?: unknown })?.slug;
		if (typeof slug !== "string" || slug === "") {
			sendError(res, 400, "body must be { slug: string }");
			return;
		}
		const entry = currentRegistry(pluginsRoot).entries.find((e) => e.slug === slug);
		if (!entry) {
			sendError(res, 404, "unknown registry slug");
			return;
		}
		const result = installPluginFromGitUrl(entry.repo, pluginsRoot);
		if (!result.ok) {
			sendError(res, 502, result.error);
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, plugin: result.manifest, compatible: !result.versionMismatch }));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}
```

- [ ] **Step 4: Build and run the tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — the full `server/test/*.js` suite is green, including every pre-existing test (confirming `pluginsBySlot`'s shape change didn't break any route that consumes it) and the new install-route tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): wire the registry into the pickers and add POST /api/v1/plugins/install"
```

---

### Task 7: Client-side install flow

**Files:**
- Modify: `server/src/static/app.ts`
- Test: `server/test/app.test.js`

**Interfaces:**
- Consumes: `POST /api/v1/plugins/install`'s response contract from Task 6.
- Produces: `onPluginPickerChange` now returns `Promise<void> | void` (was `void`) — a behavior-preserving widening only; no other module calls it, so no other signature needs updating.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/app.test.js`, inside/after the existing `describe("plugin picker", ...)` block:

```js
describe("plugin picker — registry install", () => {
	test("selecting a registry option installs it, then mounts the returned plugin", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		const registryOption = {
			value: "registry:waterfall-view",
			textContent: "Waterfall (install)",
			_attrs: {},
			setAttribute(n, v) { this._attrs[n] = v; },
			getAttribute(n) { return this._attrs[n] ?? null; },
		};
		picker._options.push(registryOption);
		picker.value = "registry:waterfall-view";
		elements.pluginPickerDetail = picker;

		let installBody = null;
		windowStub.fetch = (url, opts) => {
			if (url === "/api/v1/plugins/install") {
				installBody = JSON.parse(opts.body);
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, plugin: { slug: "waterfall-view", name: "Waterfall View", entry: "dist/index.html" }, compatible: true }) });
			}
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		await sandbox.onPluginPickerChange("detail");

		assert.deepEqual(installBody, { slug: "waterfall-view" });
		assert.equal(registryOption.value, "waterfall-view");
		assert.equal(registryOption.textContent, "Waterfall View");
		assert.equal(picker.value, "waterfall-view");
		assert.equal(elements.content.children[0].src, `/plugins/waterfall-view/dist/index.html?traceId=${"a".repeat(32)}`);
	});

	test("a failed install (non-2xx) resets the picker to Native instead of mounting anything", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "registry:broken-plugin", getAttribute: () => null });
		picker.value = "registry:broken-plugin";
		elements.pluginPickerDetail = picker;

		windowStub.fetch = (url) => {
			if (url === "/api/v1/plugins/install") return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ ok: false, error: "git clone failed" }) });
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		await sandbox.onPluginPickerChange("detail");

		assert.equal(picker.value, "");
		assert.equal(elements.content.children.length, 0);
	});

	test("a network error during install resets the picker instead of throwing", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "registry:broken-plugin", getAttribute: () => null });
		picker.value = "registry:broken-plugin";
		elements.pluginPickerDetail = picker;

		windowStub.fetch = () => Promise.reject(new Error("network down"));

		await assert.doesNotReject(sandbox.onPluginPickerChange("detail"));
		assert.equal(picker.value, "");
	});
});
```

Add to the existing `describe("initWidgetDashboard", ...)` block:

```js
test("choosing a registry option installs it, adds it to the grid, and persists the new list", async () => {
	const { elements, windowStub, sandbox } = loadApp();
	const { picker, grid } = seedWidgetPicker(elements);
	const registryOption = {
		value: "registry:latency-p95",
		textContent: "Latency P95 (install)",
		hidden: false,
		_attrs: {},
		setAttribute(n, v) { this._attrs[n] = v; },
		getAttribute(n) { return this._attrs[n] ?? null; },
	};
	picker.options.push(registryOption);
	const putCalls = [];
	windowStub.fetch = (url, opts) => {
		if (url === "/api/v1/plugins/install") {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, plugin: { slug: "latency-p95", name: "Latency P95", entry: "dist/index.html", size: "small" }, compatible: true }) });
		}
		if (opts?.method === "PUT") { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200 }); }
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: [] }) });
	};
	await sandbox.initWidgetDashboard();
	picker.value = "registry:latency-p95";
	await picker._listeners.change[0]();

	assert.equal(grid.children.length, 1);
	assert.equal(registryOption.value, "latency-p95");
	assert.equal(registryOption.hidden, true);
	assert.deepEqual(putCalls[putCalls.length - 1], { slugs: ["latency-p95"] });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL — `onPluginPickerChange`/`initWidgetDashboard`'s change handler don't recognize a `registry:`-prefixed value yet.

- [ ] **Step 3: Implement the client-side install flow**

In `server/src/static/app.ts`, add this new helper and types right after `onPluginPickerChange`'s current definition (i.e. between the plugin-picker section and the "Analytics dashboard widgets" comment):

```ts
interface InstalledPluginResponse {
	slug: string;
	name: string;
	entry: string;
	size?: string;
}

interface InstallApiResponse {
	ok: boolean;
	plugin?: InstalledPluginResponse;
	compatible?: boolean;
	error?: string;
}

/** POSTs a registry slug to /api/v1/plugins/install and returns the installed plugin's data, or
 * null on any failure (network error, non-2xx, or a version-incompatible install) -- the caller
 * resets its own picker back to "" in that case. Disables `select` for the duration of the
 * request so a second click can't fire a concurrent install of the same slug. */
async function installFromRegistry(select: HTMLSelectElement, registrySlug: string): Promise<InstalledPluginResponse | null> {
	select.disabled = true;
	try {
		const res = await window.fetch("/api/v1/plugins/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: registrySlug }),
		});
		const body = (await res.json().catch(() => null)) as InstallApiResponse | null;
		if (!res.ok || !body?.ok || !body.plugin || body.compatible === false) {
			console.error(`Failed to install plugin "${registrySlug}"${body?.error ? `: ${body.error}` : ""}`);
			return null;
		}
		return body.plugin;
	} catch {
		console.error(`Failed to install plugin "${registrySlug}": network error`);
		return null;
	} finally {
		select.disabled = false;
	}
}
```

Replace `onPluginPickerChange`:

```ts
function onPluginPickerChange(slot: ShellState["view"]): Promise<void> | void {
	const select = document.getElementById(PLUGIN_PICKER_IDS[slot]) as HTMLSelectElement | null;
	if (!select) return;
	const raw = select.value;
	if (raw.startsWith("registry:")) {
		const registrySlug = raw.slice("registry:".length);
		const option = select.selectedOptions[0];
		return installFromRegistry(select, registrySlug).then((plugin) => {
			if (!plugin) { select.value = ""; return; }
			if (option) {
				option.value = plugin.slug;
				option.textContent = plugin.name;
				option.setAttribute("data-entry", plugin.entry);
			}
			if (currentUnmount) { currentUnmount(); currentUnmount = null; }
			select.value = plugin.slug;
			mountPluginFrame(plugin.slug, plugin.entry, slot);
		});
	}
	if (currentUnmount) { currentUnmount(); currentUnmount = null; }
	if (raw === "") { navigateTo(window.location.pathname, false); return; }
	const option = select.selectedOptions[0];
	const entry = option?.getAttribute("data-entry") ?? "";
	mountPluginFrame(raw, entry, slot);
}
```

In `initWidgetDashboard`, replace the `picker.addEventListener("change", ...)` block:

```ts
picker.addEventListener("change", () => {
	const raw = picker.value;
	if (raw === "") return;
	if (raw.startsWith("registry:")) {
		const registrySlug = raw.slice("registry:".length);
		const option = optionsBySlug.get(raw);
		return installFromRegistry(picker, registrySlug).then((plugin) => {
			if (!plugin || !option) { picker.value = ""; return; }
			option.value = plugin.slug;
			option.textContent = plugin.name;
			option.setAttribute("data-entry", plugin.entry);
			option.setAttribute("data-size", plugin.size ?? "medium");
			optionsBySlug.delete(raw);
			optionsBySlug.set(plugin.slug, option);
			if (addWidget(plugin.slug)) saveDashboardSlugs(Array.from(cardsBySlug.keys()));
			picker.value = "";
		});
	}
	if (addWidget(raw)) saveDashboardSlugs(Array.from(cardsBySlug.keys()));
	picker.value = "";
});
```

(`optionsBySlug` is looked up here by the full `"registry:<slug>"` key because that's how it was keyed during `initWidgetDashboard`'s startup scan of `picker.options` — the same map `addWidget` already reads from by the plain slug once it's re-keyed.)

- [ ] **Step 4: Build and run the tests**

Run: `cd server && npm run build && npm test`
Expected: PASS — every `app.test.js` test, old and new, passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/static/app.ts server/test/app.test.js
git commit -m "feat(client): install a registry plugin from either picker without a page reload"
```

---

### Task 8: CI validation for registry PRs

**Files:**
- Create: `server/scripts/validate-registry-ci.mjs`
- Create: `.github/workflows/validate-registry.yml`

**Interfaces:**
- Consumes: `isValidRegistryFile` (Task 1) and `readManifest` (existing, `server/src/plugins.ts`) from `server/dist/*.js` — this script runs after `server/`'s own build, so it imports compiled output like every test file does.

- [ ] **Step 1: Implement the validation script**

```js
#!/usr/bin/env node
/**
 * Lightweight CI check for a registry/plugins.json PR (spec §4): schema-validates the file, then
 * for every entry, shallow-clones its `repo` and confirms tether-plugin.json is valid there --
 * reusing the exact validators the running server trusts (isValidRegistryFile, readManifest),
 * so this never drifts from what the server itself accepts. Not a security review of the linked
 * code -- just "the listing is well-formed and the repo resolves", per the spec's "listed," not
 * "reviewed," framing.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isValidRegistryFile } from "../dist/registry.js";
import { readManifest } from "../dist/plugins.js";

const registryPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "registry", "plugins.json");

function fail(message) {
	console.error(`✗ ${message}`);
	process.exitCode = 1;
}

let parsed;
try {
	parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
} catch (err) {
	fail(`registry/plugins.json is not valid JSON: ${err.message}`);
	process.exit(1);
}

if (!isValidRegistryFile(parsed)) {
	fail("registry/plugins.json failed schema validation (isValidRegistryFile).");
	process.exit(1);
}
console.log(`✓ registry/plugins.json schema is valid (${parsed.entries.length} entr${parsed.entries.length === 1 ? "y" : "ies"}).`);

for (const entry of parsed.entries) {
	const cloneDir = mkdtempSync(join(tmpdir(), "tether-registry-ci-"));
	try {
		execFileSync("git", ["-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--", entry.repo, cloneDir], { stdio: "pipe" });
	} catch (err) {
		fail(`"${entry.slug}": repo "${entry.repo}" did not clone: ${err.message}`);
		continue;
	}
	const manifest = readManifest(cloneDir);
	if (!manifest) {
		fail(`"${entry.slug}": tether-plugin.json is missing or invalid at the repo root.`);
	} else {
		const manifestKind = manifest.kind ?? "panel";
		if (manifestKind !== entry.kind) {
			fail(`"${entry.slug}": registry kind "${entry.kind}" doesn't match the manifest's kind "${manifestKind}".`);
		} else if (entry.kind === "panel" && manifest.replaces !== entry.slot) {
			fail(`"${entry.slug}": registry slot "${entry.slot}" doesn't match the manifest's replaces "${manifest.replaces}".`);
		} else {
			console.log(`✓ "${entry.slug}": repo resolves and its manifest matches the registry entry.`);
		}
	}
	rmSync(cloneDir, { recursive: true, force: true });
}

if (process.exitCode) {
	console.error("\nRegistry validation failed.");
} else {
	console.log("\nRegistry validation passed.");
}
```

- [ ] **Step 2: Add the workflow**

```yaml
# .github/workflows/validate-registry.yml
name: Validate plugin registry

on:
  pull_request:
    paths:
      - "registry/plugins.json"
      - "server/src/registry.ts"
      - "server/scripts/validate-registry-ci.mjs"

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
        working-directory: server
      - run: npm run build
        working-directory: server
      - run: node scripts/validate-registry-ci.mjs
        working-directory: server
```

- [ ] **Step 3: Verify it manually against the current (empty) registry**

Run: `cd server && npm run build && node scripts/validate-registry-ci.mjs`
Expected: prints `✓ registry/plugins.json schema is valid (0 entries).` and `Registry validation passed.`, exit code 0. (No per-entry loop runs yet since `registry/plugins.json` ships with `entries: []` — this only proves the script itself works; it isn't asserted by `node:test` the way the rest of this plan's code is, matching this codebase's existing precedent of leaving thin CLI-adjacent scripts without a dedicated unit-test file, per `CLAUDE.md`'s "Known gaps" note about `mcp/src/index.ts`.)

- [ ] **Step 4: Commit**

```bash
git add server/scripts/validate-registry-ci.mjs .github/workflows/validate-registry.yml
git commit -m "ci: validate registry PRs by re-cloning each entry's repo and its manifest"
```

---

### Task 9: Documentation

**Files:**
- Modify: `server/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a "Registry" subsection**

Insert a new `### Registry` subsection into `server/README.md`'s `## Plugins` section, right after the existing `### Analytics widgets` subsection and before `## Building from source`:

```markdown
### Registry

Beyond "you already know the git URL," each of the pickers above (per-slot native/plugin picker,
Add-widget picker) also lists a "Browse marketplace" group: not-yet-installed entries from
`registry/plugins.json`, a small community-maintained index living in this repo. Picking one
installs it — same `plugin add` logic, triggered from the UI instead of the CLI — no need to know
its git URL up front.

A snapshot of the index ships bundled with this npm package for offline/first-run use, and is
opportunistically refreshed from a CDN URL in the background (at most once per 24h) whenever a
picker is rendered — never blocking a request, and falling back to whatever was last bundled or
cached if the fetch fails.

A registry entry is a minimal pointer, not a full manifest — `name`, `slug`, `repo`, `description`,
`kind` (`"panel" | "widget"`), and `slot` (panel entries only), mirroring `tether-plugin.json`'s
own `kind`/`replaces` fields. Adding, updating, or removing a listing is a pull request against
`registry/plugins.json` in this repo, reviewed the same way any other PR is — a listing being
present means "listed," not "reviewed" or "certified."
```

- [ ] **Step 2: Commit**

```bash
git add server/README.md
git commit -m "docs(plugins): document the registry, its refresh, and the install flow"
```

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Clean build + full test suite**

Run: `cd server && rm -rf dist && npm run build && npm test`
Expected: every test file in `server/test/*.js` passes — the pre-existing suite (db, runs, harness, coverage, flight-recorder, rail, shell, analytics, analytics-page, plugins, plugin-commands, server, app) plus the new `registry.test.js` and this plan's additions to `plugins.test.js`/`shell.test.js`/`analytics-page.test.js`/`server.test.js`/`app.test.js`.

- [ ] **Step 2: Confirm `mcp/`'s suite is untouched**

Run: `cd mcp && npm test`
Expected: passes unchanged — this plan makes no `mcp/` changes (Global Constraints), so this is a regression check, not new coverage.

- [ ] **Step 3: Manual smoke check**

Start the server (`cd server && npm run dev`), open the UI, and confirm: a slot with zero installed plugins shows no picker (unchanged baseline behavior); manually seeding `<data-dir>/plugins/registry-cache.json` with a fixture entry pointing at a local test plugin repo (from Task 6's fixtures) makes that entry appear under "Browse marketplace" in the relevant picker; selecting it installs and mounts it without a page reload; the Analytics "Add widget" picker behaves the same way for a `kind: "widget"` entry.
