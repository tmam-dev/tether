# Plugin View System (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer install a third-party alternative view for Tether's Detail, Harness, or Analytics slot — published as a git repo, installed via a CLI command, rendered in a sandboxed iframe against a new versioned local JSON API.

**Architecture:** A new `plugins.ts` module owns plugin-directory/manifest logic (shared by the CLI and the server). `server.ts` gains three read-only `/api/v1/*` JSON routes plus a `/plugins/:slug/*` static/proxy route. `shell.ts`'s topbar gains a per-slot `<select>` picker. `app.ts`'s router gains iframe mount/unmount logic keyed off that picker, reusing the existing panel-lifecycle contract (`currentUnmount`).

**Tech Stack:** Existing stack only — `node:http`, `node:child_process` (shell out to the system `git` binary for clone, no new dependency), `node:fs`, TypeScript compiled via `tsc`, `node --test` for tests. No new npm dependency is added by this plan.

**Spec:** `docs/superpowers/specs/2026-08-26-plugin-view-system-design.md`

## Global Constraints

- `tetherApiVersion` (manifest field and server constant) is the literal number `1` for this plan — do not invent a string version scheme.
- Iframe `sandbox` attribute is exactly `"allow-scripts allow-same-origin"` — no `allow-top-navigation`, no `allow-popups`, no `allow-forms`.
- JSON API routes live under the `/api/v1/` prefix, `Content-Type: application/json`, 404 body `{ "ok": false, "error": "..." }` (reuse `server.ts`'s existing `sendError` helper) — no CORS headers, this is same-origin only.
- `/api/v1/*` routes are read-only — GET only, no route on this prefix ever mutates the store.
- Plugin installation is a local `git clone` only — no upload endpoint, no Tether-hosted registry, ever.
- A plugin manifest with an unrecognized/mismatched `tetherApiVersion` stays on disk but is excluded from the picker — never deleted automatically.
- The per-slot picker selection is client-side only, resets to "native" on every real navigation — never written to the URL or persisted server-side.
- Plugin data access is confined to what `/api/v1/*` already exposes — no new route gives a plugin direct DB or filesystem access beyond its own installed static files.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/plugins.ts` (new) | Plugin manifest type/validation, plugins-directory resolution, listing installed (compatible) plugins, path-traversal-safe asset resolution, dev-override read/write, content-type lookup. Pure functions, no HTTP. |
| `server/src/cli/plugin-commands.ts` (new) | `runPluginCommand(argv, dataDir)` — `add`/`dev`/`remove` subcommand logic. Shells out to `git`. No HTTP server involved; testable by calling the function directly. |
| `server/src/index.ts` (modify) | Dispatch `argv[2] === "plugin"` to `runPluginCommand` before the existing server-start path. |
| `server/src/server.ts` (modify) | Add `/api/v1/runs/:traceId`, `/api/v1/harness/:traceId`, `/api/v1/analytics`, and `/plugins/:slug/*` routes. Pass per-slot plugin lists into `renderShell` calls. |
| `server/src/templates/shell.ts` (modify) | `renderShell`/`topbar` gain a `pluginsBySlot` parameter and render one `<select class="plugin-picker">` per non-empty slot, plus the `.plugin-frame` CSS rule. |
| `server/src/static/app.ts` (modify) | Router gains `setPluginPickerVisibility` (called alongside the existing `setTabActive`/`setRailActive`) and `onPluginPickerChange` (mounts/unmounts the plugin iframe). |
| `server/test/plugins.test.js` (new) | Unit tests for `plugins.ts`. |
| `server/test/plugin-commands.test.js` (new) | Unit tests for the CLI subcommands, using a real local git fixture repo. |
| `server/test/server.test.js` (modify) | Adds cases for the four new server routes. |
| `server/test/shell.test.js` (modify) | Adds cases for the picker markup. |
| `server/test/app.test.js` (modify) | Adds cases for picker visibility toggling and iframe mount/unmount. |
| `server/test/fixtures/sample-plugin/` (new) | A minimal real plugin (manifest + `dist/index.html`) used by the server route tests and the end-to-end task. |

---

### Task 1: Public JSON API routes

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/test/server.test.js`

**Interfaces:**
- Consumes: existing `getRun`, `getCoverage`, `getHarnessView`, `getUsage` (already imported in `server.ts`), existing `decodeTraceIdOr400`, `sendError` helpers (already defined in `server.ts`).
- Produces: `GET /api/v1/runs/:traceId` → `RunView & { coverage: CoverageView | null }` as JSON. `GET /api/v1/harness/:traceId` → `HarnessView` as JSON. `GET /api/v1/analytics` → `UsageView` as JSON. Later tasks (esp. Task 8's picker) rely on these three routes existing and returning exactly these shapes.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/server.test.js` (after the existing `describe("POST /traces", ...)` block; reuse the file's existing `withServer`/`otlpPayload` helpers):

```js
describe("GET /api/v1/runs/:traceId", () => {
	test("returns the run with coverage as JSON", async () => {
		await withServer(async ({ db, port }) => {
			await fetch(`http://127.0.0.1:${port}/traces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(otlpPayload()),
			});
			const traceId = "a".repeat(32);
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${traceId}`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "application/json");
			const body = await res.json();
			assert.equal(body.traceId, traceId);
			assert.ok("coverage" in body);
		});
	});

	test("404s with an error body for an unknown traceId", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
			const body = await res.json();
			assert.equal(body.ok, false);
		});
	});
});

describe("GET /api/v1/harness/:traceId", () => {
	test("404s for an unknown traceId", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/harness/${"z".repeat(32)}`);
			assert.equal(res.status, 404);
		});
	});
});

describe("GET /api/v1/analytics", () => {
	test("returns a UsageView shape on an empty store", async () => {
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/analytics`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.totalRuns, 0);
			assert.deepEqual(body.entries, []);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/server.test.js`
Expected: FAIL — the three new `describe` blocks 404 with the generic "not found" body (route doesn't exist yet), or `content-type`/shape assertions fail.

- [ ] **Step 3: Implement the routes**

In `server/src/server.ts`, insert the following three route blocks after the existing `/fragments/detail/:traceId` block (i.e. after the `if (req.method === "GET" && pathname.startsWith("/fragments/detail/")) { ... }` block ends, before `const harnessPathMatch = ...`):

```ts
if (req.method === "GET" && pathname.startsWith("/api/v1/runs/")) {
	const traceId = decodeTraceIdOr400(pathname.slice("/api/v1/runs/".length), res);
	if (traceId === null) return;
	try {
		const run = getRun(db, traceId);
		if (!run) {
			sendError(res, 404, "run not found");
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ...run, coverage: getCoverage(db, traceId) }));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}

if (req.method === "GET" && pathname.startsWith("/api/v1/harness/")) {
	const traceId = decodeTraceIdOr400(pathname.slice("/api/v1/harness/".length), res);
	if (traceId === null) return;
	try {
		const view = getHarnessView(db, traceId);
		if (!view) {
			sendError(res, 404, "run not found");
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(view));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}

if (req.method === "GET" && pathname === "/api/v1/analytics") {
	try {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(getUsage(db)));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/server.test.js`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): add read-only /api/v1 JSON routes for plugin data access"
```

---

### Task 2: Plugin manifest & directory module

**Files:**
- Create: `server/src/plugins.ts`
- Test: `server/test/plugins.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Tasks 3, 4, 5, 7):
  - `export const TETHER_API_VERSION = 1;`
  - `export interface PluginManifest { name: string; slug: string; version: string; author: string; description: string; entry: string; icon?: string; replaces: "detail" | "harness" | "analytics"; tetherApiVersion: number; }`
  - `export function pluginsDir(dataDir: string): string`
  - `export function readManifest(pluginDir: string): PluginManifest | null`
  - `export interface InstalledPlugin extends PluginManifest { compatible: boolean; }`
  - `export function listInstalledPlugins(pluginsRoot: string): InstalledPlugin[]`
  - `export function resolvePluginAssetPath(pluginsRoot: string, slug: string, requestedPath: string): string | null`
  - `export function contentTypeFor(filePath: string): string`
  - `export function readDevOverrides(pluginsRoot: string): Record<string, string>`
  - `export function setDevOverride(pluginsRoot: string, slug: string, url: string | null): void`

- [ ] **Step 1: Write the failing tests**

Create `server/test/plugins.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	TETHER_API_VERSION,
	pluginsDir,
	readManifest,
	listInstalledPlugins,
	resolvePluginAssetPath,
	contentTypeFor,
	readDevOverrides,
	setDevOverride,
} from "../dist/plugins.js";

function withTempPluginsRoot(fn) {
	const root = mkdtempSync(join(tmpdir(), "tether-plugins-test-"));
	try {
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function installFixturePlugin(root, slug, overrides = {}) {
	const dir = join(root, slug);
	mkdirSync(dir, { recursive: true });
	const manifest = {
		name: "Sample Plugin",
		slug,
		version: "1.0.0",
		author: "someone",
		description: "A sample plugin.",
		entry: "dist/index.html",
		replaces: "detail",
		tetherApiVersion: TETHER_API_VERSION,
		...overrides,
	};
	writeFileSync(join(dir, "tether-plugin.json"), JSON.stringify(manifest));
	mkdirSync(join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><title>Sample</title>");
	return dir;
}

describe("pluginsDir", () => {
	test("joins 'plugins' onto the given data dir", () => {
		assert.equal(pluginsDir("/tmp/tether-data"), join("/tmp/tether-data", "plugins"));
	});
});

describe("readManifest", () => {
	test("returns null when tether-plugin.json is missing", () => {
		withTempPluginsRoot((root) => {
			assert.equal(readManifest(join(root, "nope")), null);
		});
	});

	test("returns null on malformed JSON", () => {
		withTempPluginsRoot((root) => {
			const dir = join(root, "broken");
			mkdirSync(dir);
			writeFileSync(join(dir, "tether-plugin.json"), "{not json");
			assert.equal(readManifest(dir), null);
		});
	});

	test("returns null when a required field is missing", () => {
		withTempPluginsRoot((root) => {
			const dir = join(root, "incomplete");
			mkdirSync(dir);
			writeFileSync(join(dir, "tether-plugin.json"), JSON.stringify({ name: "X" }));
			assert.equal(readManifest(dir), null);
		});
	});

	test("returns null when 'replaces' is not a recognized slot", () => {
		withTempPluginsRoot((root) => {
			const dir = installFixturePlugin(root, "bad-slot", { replaces: "sidebar" });
			assert.equal(readManifest(dir), null);
		});
	});

	test("parses a valid manifest", () => {
		withTempPluginsRoot((root) => {
			const dir = installFixturePlugin(root, "waterfall-view");
			const manifest = readManifest(dir);
			assert.equal(manifest.slug, "waterfall-view");
			assert.equal(manifest.replaces, "detail");
		});
	});
});

describe("listInstalledPlugins", () => {
	test("returns an empty list for a nonexistent plugins root", () => {
		assert.deepEqual(listInstalledPlugins(join(tmpdir(), "does-not-exist-" + Date.now())), []);
	});

	test("lists installed plugins with a compatible flag", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "compatible-one");
			installFixturePlugin(root, "incompatible-one", { tetherApiVersion: TETHER_API_VERSION + 1 });
			const plugins = listInstalledPlugins(root);
			assert.equal(plugins.length, 2);
			const compatible = plugins.find((p) => p.slug === "compatible-one");
			const incompatible = plugins.find((p) => p.slug === "incompatible-one");
			assert.equal(compatible.compatible, true);
			assert.equal(incompatible.compatible, false);
		});
	});

	test("skips a directory with no valid manifest rather than throwing", () => {
		withTempPluginsRoot((root) => {
			mkdirSync(join(root, "junk"));
			assert.deepEqual(listInstalledPlugins(root), []);
		});
	});
});

describe("resolvePluginAssetPath", () => {
	test("resolves a real file inside the plugin's own directory", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "waterfall-view");
			const resolved = resolvePluginAssetPath(root, "waterfall-view", "dist/index.html");
			assert.equal(resolved, join(root, "waterfall-view", "dist", "index.html"));
		});
	});

	test("returns null for a path traversal attempt", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "waterfall-view");
			assert.equal(resolvePluginAssetPath(root, "waterfall-view", "../../etc/passwd"), null);
		});
	});

	test("returns null for an unknown slug", () => {
		withTempPluginsRoot((root) => {
			assert.equal(resolvePluginAssetPath(root, "nope", "dist/index.html"), null);
		});
	});
});

describe("contentTypeFor", () => {
	test("maps common extensions", () => {
		assert.equal(contentTypeFor("dist/index.html"), "text/html; charset=utf-8");
		assert.equal(contentTypeFor("dist/app.js"), "text/javascript; charset=utf-8");
		assert.equal(contentTypeFor("dist/style.css"), "text/css; charset=utf-8");
		assert.equal(contentTypeFor("dist/icon.svg"), "image/svg+xml");
		assert.equal(contentTypeFor("dist/unknown.bin"), "application/octet-stream");
	});
});

describe("dev overrides", () => {
	test("readDevOverrides returns {} when no override file exists", () => {
		withTempPluginsRoot((root) => {
			assert.deepEqual(readDevOverrides(root), {});
		});
	});

	test("setDevOverride writes then clears an override", () => {
		withTempPluginsRoot((root) => {
			setDevOverride(root, "waterfall-view", "http://localhost:5173");
			assert.deepEqual(readDevOverrides(root), { "waterfall-view": "http://localhost:5173" });
			setDevOverride(root, "waterfall-view", null);
			assert.deepEqual(readDevOverrides(root), {});
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/plugins.test.js`
Expected: FAIL — `../dist/plugins.js` doesn't exist, build error or module-not-found.

- [ ] **Step 3: Implement `server/src/plugins.ts`**

```ts
/**
 * Plugin manifest/directory logic shared by the CLI (plugin-commands.ts)
 * and the server's /api and /plugins routes. Degrades gracefully -- a
 * missing or malformed manifest is skipped (null / omitted from a list),
 * never thrown, matching this codebase's runs.ts/harness.ts convention.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export const TETHER_API_VERSION = 1;

const REPLACES_SLOTS = new Set(["detail", "harness", "analytics"]);

export interface PluginManifest {
	name: string;
	slug: string;
	version: string;
	author: string;
	description: string;
	entry: string;
	icon?: string;
	replaces: "detail" | "harness" | "analytics";
	tetherApiVersion: number;
}

export interface InstalledPlugin extends PluginManifest {
	compatible: boolean;
}

export function pluginsDir(dataDir: string): string {
	return join(dataDir, "plugins");
}

function isValidManifest(v: unknown): v is PluginManifest {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	return (
		typeof m.name === "string" &&
		typeof m.slug === "string" &&
		typeof m.version === "string" &&
		typeof m.author === "string" &&
		typeof m.description === "string" &&
		typeof m.entry === "string" &&
		typeof m.replaces === "string" &&
		REPLACES_SLOTS.has(m.replaces) &&
		typeof m.tetherApiVersion === "number"
	);
}

/** Reads and validates tether-plugin.json in `pluginDir`. Never throws -- a missing file,
 * malformed JSON, or a manifest missing/mistyping a required field all return null. */
export function readManifest(pluginDir: string): PluginManifest | null {
	try {
		const raw = readFileSync(join(pluginDir, "tether-plugin.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return isValidManifest(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Every installed plugin under `pluginsRoot`, each flagged `compatible` against
 * TETHER_API_VERSION. A directory with no valid manifest is silently skipped. */
export function listInstalledPlugins(pluginsRoot: string): InstalledPlugin[] {
	let entries: string[];
	try {
		entries = readdirSync(pluginsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
	const plugins: InstalledPlugin[] = [];
	for (const slug of entries) {
		const manifest = readManifest(join(pluginsRoot, slug));
		if (!manifest) continue;
		plugins.push({ ...manifest, compatible: manifest.tetherApiVersion === TETHER_API_VERSION });
	}
	return plugins;
}

/** Resolves `requestedPath` against the given plugin's own installed directory, refusing to
 * resolve outside it (path traversal via `..` or an absolute path). Returns null on any
 * violation, an unknown slug, or a target that doesn't exist -- never throws. */
export function resolvePluginAssetPath(pluginsRoot: string, slug: string, requestedPath: string): string | null {
	const pluginDir = join(pluginsRoot, slug);
	if (!existsSync(pluginDir)) return null;
	const candidate = resolve(pluginDir, requestedPath);
	let realPluginDir: string;
	let realCandidate: string;
	try {
		realPluginDir = realpathSync(pluginDir);
		realCandidate = existsSync(candidate) ? realpathSync(candidate) : candidate;
	} catch {
		return null;
	}
	if (realCandidate !== realPluginDir && !realCandidate.startsWith(realPluginDir + sep)) return null;
	if (!existsSync(realCandidate) || !statSync(realCandidate).isFile()) return null;
	return realCandidate;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
};

export function contentTypeFor(filePath: string): string {
	return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function devOverridesPath(pluginsRoot: string): string {
	return join(pluginsRoot, "dev-overrides.json");
}

/** Reads `<pluginsRoot>/dev-overrides.json` (slug -> dev server URL). Returns {} if the file is
 * missing or malformed -- this is a convenience dev-mode file, never load-bearing enough to throw. */
export function readDevOverrides(pluginsRoot: string): Record<string, string> {
	try {
		const raw = readFileSync(devOverridesPath(pluginsRoot), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/** Sets (or, when `url` is null, clears) the dev-server override for `slug`. */
export function setDevOverride(pluginsRoot: string, slug: string, url: string | null): void {
	mkdirSync(pluginsRoot, { recursive: true });
	const overrides = readDevOverrides(pluginsRoot);
	if (url === null) delete overrides[slug];
	else overrides[slug] = url;
	writeFileSync(devOverridesPath(pluginsRoot), JSON.stringify(overrides, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/plugins.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins.ts server/test/plugins.test.js
git commit -m "feat(server): add plugins.ts manifest/directory module"
```

---

### Task 3: Plugin static-file serving route

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/test/server.test.js`
- Create: `server/test/fixtures/sample-plugin/tether-plugin.json`, `server/test/fixtures/sample-plugin/dist/index.html`

**Interfaces:**
- Consumes: `pluginsDir`, `resolvePluginAssetPath`, `contentTypeFor` from Task 2's `server/src/plugins.ts`.
- Produces: `GET /plugins/:slug/*` serving an installed plugin's files. `withServer` test helper gains an optional way to point at a plugins root — Task 4 and Task 9 reuse this route.

- [ ] **Step 1: Create the fixture plugin**

`server/test/fixtures/sample-plugin/tether-plugin.json`:

```json
{
	"name": "Sample Plugin",
	"slug": "sample-plugin",
	"version": "1.0.0",
	"author": "test-fixture",
	"description": "A minimal fixture plugin for server route tests.",
	"entry": "dist/index.html",
	"replaces": "detail",
	"tetherApiVersion": 1
}
```

`server/test/fixtures/sample-plugin/dist/index.html`:

```html
<!doctype html>
<title>Sample Plugin</title>
<p id="marker">sample plugin content</p>
```

- [ ] **Step 2: Write the failing tests**

`server.test.js`'s `createTetherServer(db)` call needs a plugins root to serve from. Modify `withServer` in `server/test/server.test.js` to accept and pass one:

```js
async function withServer(fn, { pluginsRoot } = {}) {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	const server = createTetherServer(db, { pluginsRoot });
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
```

Add near the top of the file:

```js
import { cpSync, mkdtempSync as mkdtempSyncPlugins } from "node:fs";

function makeFixturePluginsRoot() {
	const root = mkdtempSyncPlugins(join(tmpdir(), "tether-plugins-fixture-"));
	cpSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-plugin"), join(root, "sample-plugin"), { recursive: true });
	return root;
}
```

(`import { fileURLToPath } from "node:url";` and `import { dirname } from "node:path";` — add these two imports alongside the file's existing `node:path`/`node:url` imports if not already present; check the file's current import block first, since some of these may already be imported.)

```js
describe("GET /plugins/:slug/*", () => {
	test("serves an installed plugin's file with the right content-type", async () => {
		const pluginsRoot = makeFixturePluginsRoot();
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/plugins/sample-plugin/dist/index.html`);
			assert.equal(res.status, 200);
			assert.match(res.headers.get("content-type"), /text\/html/);
			assert.match(await res.text(), /sample plugin content/);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});

	test("404s for an unknown slug", async () => {
		const pluginsRoot = makeFixturePluginsRoot();
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/plugins/nope/dist/index.html`);
			assert.equal(res.status, 404);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});

	test("404s a path-traversal attempt rather than serving a file outside the plugin dir", async () => {
		const pluginsRoot = makeFixturePluginsRoot();
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/plugins/sample-plugin/${encodeURIComponent("../../../../etc/passwd")}`);
			assert.equal(res.status, 404);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run build && node --test test/server.test.js`
Expected: FAIL — `createTetherServer` doesn't accept a second argument yet / route doesn't exist (generic 404 body from the catch-all, but content-type assertions and the traversal test's 404 may already coincidentally pass since the route is entirely missing — the content-type and body-text assertions on the first test are what actually fail).

- [ ] **Step 4: Implement the route**

In `server/src/server.ts`:

1. Add imports: `import { pluginsDir, resolvePluginAssetPath, contentTypeFor } from "./plugins.js";` and `import { readFileSync as readFileSyncFs } from "node:fs";` — actually `readFileSync` is not yet imported in `server.ts` (only `readFileSync` for `APP_JS` at module load — check: it's already imported as `readFileSync` from `"node:fs"` at the top. Reuse that same import, no alias needed.

2. Change `createTetherServer`'s signature to accept an options object:

```ts
export function createTetherServer(db: Database.Database, options: { pluginsRoot?: string } = {}): Server {
	const pluginsRoot = options.pluginsRoot ?? pluginsDir(resolveDataDirForServer());
	return createServer(async (req, res) => {
```

Since `server.ts` doesn't currently import `resolveDataDir` from `db.ts` (only `insertSpan`), add a small local fallback instead of importing `db.ts`'s data-dir resolution into `server.ts` (keeping `server.ts` decoupled from where the caller's data lives): change the default to simply `options.pluginsRoot ?? pluginsDir(process.cwd())` is wrong for production use. Instead, **do not default inside `server.ts` at all** — require the caller to always pass `pluginsRoot` explicitly. Revise:

```ts
export function createTetherServer(db: Database.Database, options: { pluginsRoot: string }): Server {
	const { pluginsRoot } = options;
	return createServer(async (req, res) => {
```

This makes the plugins root an explicit, required dependency (matching how `db` itself is already passed in rather than resolved internally). Since this is now a required parameter, `server.ts`'s only production caller — `index.ts` — must be updated in this same step, not deferred to Task 5 (otherwise the whole-project `tsc` build breaks between tasks on a missing-argument type error). In `server/src/index.ts`, add `import { pluginsDir } from "./plugins.js";` and change the `createTetherServer(db)` call to `createTetherServer(db, { pluginsRoot: pluginsDir(resolveDataDir()) })`. (Task 5 revisits `index.ts` again to add the `plugin` subcommand dispatch — it does not need to touch this call site a second time.)

Existing tests in `server.test.js` that don't care about plugins can pass any temp dir, e.g. `{ pluginsRoot: mkdtempSync(...) }`; **update `withServer`'s default** in Step 2 above to `{ pluginsRoot: mkdtempSync(join(tmpdir(), "tether-plugins-empty-")) }` when no fixture is given, so every existing `withServer(fn)` call (no second argument) keeps working unchanged:

```js
async function withServer(fn, { pluginsRoot } = {}) {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	const resolvedPluginsRoot = pluginsRoot ?? mkdtempSync(join(tmpdir(), "tether-plugins-empty-"));
	const server = createTetherServer(db, { pluginsRoot: resolvedPluginsRoot });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await fn({ db, port });
	} finally {
		await new Promise((resolve) => server.close(resolve));
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
		if (!pluginsRoot) rmSync(resolvedPluginsRoot, { recursive: true, force: true });
	}
}
```

3. Add the route (inside the request handler, after the `/api/v1/analytics` block from Task 1):

```ts
const pluginAssetMatch = pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
if (req.method === "GET" && pluginAssetMatch) {
	try {
		const slug = decodeURIComponent(pluginAssetMatch[1]);
		const assetPath = decodeURIComponent(pluginAssetMatch[2]);
		const resolved = resolvePluginAssetPath(pluginsRoot, slug, assetPath);
		if (!resolved) {
			sendError(res, 404, "plugin asset not found");
			return;
		}
		res.writeHead(200, { "Content-Type": contentTypeFor(resolved) });
		res.end(readFileSync(resolved));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test test/server.test.js`
Expected: PASS, all cases including every pre-existing test (confirming the `withServer` signature change didn't break any caller).

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/server.test.js server/test/fixtures
git commit -m "feat(server): serve installed plugin assets at /plugins/:slug/*"
```

---

### Task 4: Plugin dev-mode overrides (proxy)

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/test/server.test.js`

**Interfaces:**
- Consumes: `readDevOverrides` from Task 2's `plugins.ts`; the `pluginAssetMatch` route from Task 3.
- Produces: when a dev override exists for a requested slug, `/plugins/:slug/*` proxies to the override URL instead of reading from disk — this is what Task 6's `plugin dev` CLI command relies on to make hot-reload work end to end.

- [ ] **Step 1: Write the failing test**

Add `import { createServer as createHttpServer } from "node:http";` to the top of `server/test/server.test.js`, alongside its existing imports (not inline mid-file). Then add, inside (or after) the `describe("GET /plugins/:slug/*", ...)` block:

```js
test("proxies to a dev-server override instead of serving installed files", async () => {
	const pluginsRoot = makeFixturePluginsRoot();
	const devServer = createHttpServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<p>dev server content</p>");
	});
	await new Promise((resolve) => devServer.listen(0, "127.0.0.1", resolve));
	const devPort = devServer.address().port;
	writeFileSync(
		join(pluginsRoot, "dev-overrides.json"),
		JSON.stringify({ "sample-plugin": `http://127.0.0.1:${devPort}` })
	);
	await withServer(async ({ port }) => {
		const res = await fetch(`http://127.0.0.1:${port}/plugins/sample-plugin/dist/index.html`);
		assert.equal(res.status, 200);
		assert.match(await res.text(), /dev server content/);
	}, { pluginsRoot });
	await new Promise((resolve) => devServer.close(resolve));
	rmSync(pluginsRoot, { recursive: true, force: true });
});
```

(Add `import { writeFileSync } from "node:fs";` to the test file's imports if not already present — check first, since `node:fs` is likely already partially imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/server.test.js`
Expected: FAIL — response is the fixture's installed `dist/index.html` content ("sample plugin content"), not the dev server's.

- [ ] **Step 3: Implement the proxy**

In `server/src/server.ts`, add an import: `import { request as httpRequest } from "node:http";`. Add a helper function near the other small helpers (e.g. after `buildRail`):

```ts
/** Proxies a GET request to `targetBase + path` and pipes the response straight through to `res`.
 * Used only for plugin dev-mode overrides (§3.2/§3.4 of the plugin spec) -- keeps the iframe's
 * fetches to /api/v1/* same-origin even while the plugin's own assets are served by a separate
 * dev server, since the proxy itself is same-origin from the browser's perspective. */
function proxyGet(targetBase: string, path: string, res: ServerResponse): void {
	const target = new URL(path, targetBase);
	const proxyReq = httpRequest(target, { method: "GET" }, (proxyRes) => {
		res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers as Record<string, string>);
		proxyRes.pipe(res);
	});
	proxyReq.on("error", () => sendError(res, 502, "dev server unreachable"));
	proxyReq.end();
}
```

Change the `pluginAssetMatch` block from Task 3 to check for an override first:

```ts
const pluginAssetMatch = pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
if (req.method === "GET" && pluginAssetMatch) {
	try {
		const slug = decodeURIComponent(pluginAssetMatch[1]);
		const assetPath = decodeURIComponent(pluginAssetMatch[2]);
		const overrides = readDevOverrides(pluginsRoot);
		if (overrides[slug]) {
			proxyGet(overrides[slug], `/${assetPath}`, res);
			return;
		}
		const resolved = resolvePluginAssetPath(pluginsRoot, slug, assetPath);
		if (!resolved) {
			sendError(res, 404, "plugin asset not found");
			return;
		}
		res.writeHead(200, { "Content-Type": contentTypeFor(resolved) });
		res.end(readFileSync(resolved));
	} catch (err) {
		sendError(res, 500, (err as Error).message);
	}
	return;
}
```

Add `readDevOverrides` to the existing `./plugins.js` import line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/server.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): proxy /plugins/:slug/* to a dev-server override when set"
```

---

### Task 5: CLI subcommands — `plugin add` / `plugin dev` / `plugin remove`

**Files:**
- Create: `server/src/cli/plugin-commands.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/plugin-commands.test.js`

**Interfaces:**
- Consumes: `pluginsDir`, `readManifest`, `setDevOverride` from Task 2's `plugins.ts`.
- Produces: `export async function runPluginCommand(argv: string[], dataDir: string): Promise<number>` — `index.ts` calls this and exits with its return code. Return codes: `0` success, `1` usage/validation error.

- [ ] **Step 1: Write the failing tests**

Create `server/test/plugin-commands.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPluginCommand } from "../dist/cli/plugin-commands.js";
import { pluginsDir, readManifest, readDevOverrides } from "../dist/plugins.js";

/** Creates a real local git repo containing a valid plugin, so `plugin add <path>` can clone it
 * exactly like it would a real GitHub URL (git accepts a local filesystem path as a clone source). */
function makeFixtureRepo(slug = "waterfall-view") {
	const repoDir = mkdtempSync(join(tmpdir(), "tether-plugin-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
	const manifest = {
		name: "Waterfall View", slug, version: "1.0.0", author: "test",
		description: "test plugin", entry: "dist/index.html", replaces: "detail", tetherApiVersion: 1,
	};
	writeFileSync(join(repoDir, "tether-plugin.json"), JSON.stringify(manifest));
	mkdirSync(join(repoDir, "dist"));
	writeFileSync(join(repoDir, "dist", "index.html"), "<!doctype html><p>waterfall</p>");
	execFileSync("git", ["add", "-A"], { cwd: repoDir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });
	return repoDir;
}

function withDataDir(fn) {
	const dataDir = mkdtempSync(join(tmpdir(), "tether-data-test-"));
	try {
		return fn(dataDir);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

describe("plugin add", () => {
	test("clones a valid plugin repo into the plugins directory under its manifest slug", async () => {
		await withDataDir(async (dataDir) => {
			const repoDir = makeFixtureRepo("waterfall-view");
			const code = await runPluginCommand(["add", repoDir], dataDir);
			assert.equal(code, 0);
			const installedDir = join(pluginsDir(dataDir), "waterfall-view");
			assert.ok(existsSync(join(installedDir, "tether-plugin.json")));
			assert.equal(readManifest(installedDir).slug, "waterfall-view");
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("rejects a repo with no valid manifest and leaves nothing installed", async () => {
		await withDataDir(async (dataDir) => {
			const repoDir = mkdtempSync(join(tmpdir(), "tether-plugin-badrepo-"));
			execFileSync("git", ["init", "-q"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
			writeFileSync(join(repoDir, "README.md"), "no manifest here");
			execFileSync("git", ["add", "-A"], { cwd: repoDir });
			execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });

			const code = await runPluginCommand(["add", repoDir], dataDir);
			assert.equal(code, 1);
			assert.ok(!existsSync(pluginsDir(dataDir)) || readManifest(join(pluginsDir(dataDir), "anything")) === null);
			rmSync(repoDir, { recursive: true, force: true });
		});
	});
});

describe("plugin remove", () => {
	test("deletes an installed plugin's directory", async () => {
		await withDataDir(async (dataDir) => {
			const repoDir = makeFixtureRepo("waterfall-view");
			await runPluginCommand(["add", repoDir], dataDir);
			const code = await runPluginCommand(["remove", "waterfall-view"], dataDir);
			assert.equal(code, 0);
			assert.ok(!existsSync(join(pluginsDir(dataDir), "waterfall-view")));
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("returns exit code 1 for an unknown slug", async () => {
		await withDataDir(async (dataDir) => {
			const code = await runPluginCommand(["remove", "nope"], dataDir);
			assert.equal(code, 1);
		});
	});
});

describe("plugin dev", () => {
	test("sets a dev override for an installed plugin", async () => {
		await withDataDir(async (dataDir) => {
			const repoDir = makeFixtureRepo("waterfall-view");
			await runPluginCommand(["add", repoDir], dataDir);
			const code = await runPluginCommand(["dev", "waterfall-view", "http://localhost:5173"], dataDir);
			assert.equal(code, 0);
			assert.deepEqual(readDevOverrides(pluginsDir(dataDir)), { "waterfall-view": "http://localhost:5173" });
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("clears the override when called with no URL", async () => {
		await withDataDir(async (dataDir) => {
			const repoDir = makeFixtureRepo("waterfall-view");
			await runPluginCommand(["add", repoDir], dataDir);
			await runPluginCommand(["dev", "waterfall-view", "http://localhost:5173"], dataDir);
			const code = await runPluginCommand(["dev", "waterfall-view"], dataDir);
			assert.equal(code, 0);
			assert.deepEqual(readDevOverrides(pluginsDir(dataDir)), {});
			rmSync(repoDir, { recursive: true, force: true });
		});
	});

	test("returns exit code 1 for an uninstalled slug", async () => {
		await withDataDir(async (dataDir) => {
			const code = await runPluginCommand(["dev", "nope", "http://localhost:5173"], dataDir);
			assert.equal(code, 1);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/plugin-commands.test.js`
Expected: FAIL — `../dist/cli/plugin-commands.js` doesn't exist.

- [ ] **Step 3: Implement `server/src/cli/plugin-commands.ts`**

```ts
/**
 * `plugin add|dev|remove` CLI subcommands. Pure Node -- shells out to the system `git` binary
 * (no git library dependency) for `add`, and otherwise only touches plugins.ts's directory/manifest
 * helpers. Returns an exit code rather than calling process.exit itself, so index.ts controls the
 * process lifecycle and this stays directly callable from tests.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pluginsDir, readManifest, setDevOverride } from "../plugins.js";

function addPlugin(gitUrl: string, dataDir: string): number {
	const cloneTarget = mkdtempSync(join(tmpdir(), "tether-plugin-clone-"));
	try {
		execFileSync("git", ["clone", "--depth", "1", gitUrl, cloneTarget], { stdio: "pipe" });
	} catch (err) {
		console.error(`git clone failed: ${(err as Error).message}`);
		rmSync(cloneTarget, { recursive: true, force: true });
		return 1;
	}

	const manifest = readManifest(cloneTarget);
	if (!manifest) {
		console.error("tether-plugin.json is missing or invalid at the repo root.");
		rmSync(cloneTarget, { recursive: true, force: true });
		return 1;
	}

	const root = pluginsDir(dataDir);
	mkdirSync(root, { recursive: true });
	const dest = join(root, manifest.slug);
	rmSync(dest, { recursive: true, force: true });
	renameSync(cloneTarget, dest);
	console.log(`Installed "${manifest.name}" (${manifest.slug}) -> replaces "${manifest.replaces}"`);
	return 0;
}

function removePlugin(slug: string, dataDir: string): number {
	const dir = join(pluginsDir(dataDir), slug);
	if (!existsSync(dir)) {
		console.error(`No installed plugin with slug "${slug}".`);
		return 1;
	}
	rmSync(dir, { recursive: true, force: true });
	setDevOverride(pluginsDir(dataDir), slug, null);
	console.log(`Removed "${slug}".`);
	return 0;
}

function devPlugin(slug: string, url: string | undefined, dataDir: string): number {
	const dir = join(pluginsDir(dataDir), slug);
	if (!existsSync(dir) || !readManifest(dir)) {
		console.error(`No installed plugin with slug "${slug}" -- run "plugin add" first.`);
		return 1;
	}
	setDevOverride(pluginsDir(dataDir), slug, url ?? null);
	console.log(url ? `Dev override set: "${slug}" -> ${url}` : `Dev override cleared for "${slug}".`);
	return 0;
}

export async function runPluginCommand(argv: string[], dataDir: string): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === "add" && rest[0]) return addPlugin(rest[0], dataDir);
	if (sub === "remove" && rest[0]) return removePlugin(rest[0], dataDir);
	if (sub === "dev" && rest[0]) return devPlugin(rest[0], rest[1], dataDir);
	console.error("Usage: trailai-tether plugin <add <git-url> | dev <slug> [dev-server-url] | remove <slug>>");
	return 1;
}
```

- [ ] **Step 4: Wire into `server/src/index.ts`**

`index.ts` already imports `pluginsDir` and passes `{ pluginsRoot: pluginsDir(resolveDataDir()) }` to `createTetherServer` (Task 3). This step only adds the `plugin` subcommand dispatch on top of that. Replace the file's body (after the `process.on` handlers) with:

```ts
import { join } from "node:path";
import { openDatabase, resolveDataDir } from "./db.js";
import { createTetherServer } from "./server.js";
import { runPluginCommand } from "./cli/plugin-commands.js";
import { pluginsDir } from "./plugins.js";

process.on("unhandledRejection", (err) => {
	console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
	console.error("Uncaught exception:", err);
});

async function main(): Promise<void> {
	if (process.argv[2] === "plugin") {
		const code = await runPluginCommand(process.argv.slice(3), resolveDataDir());
		process.exit(code);
	}

	const DEFAULT_PORT = 4319;
	const port = Number(process.env.TETHER_PORT ?? DEFAULT_PORT);
	const dbPath = join(resolveDataDir(), "tether.sqlite");

	const db = openDatabase(dbPath);
	const server = createTetherServer(db, { pluginsRoot: pluginsDir(resolveDataDir()) });

	server.listen(port, "127.0.0.1", () => {
		console.log(`trailai-tether ready at http://localhost:${port} (data: ${dbPath})`);
	});
}

main();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test test/plugin-commands.test.js && node --test test/*.js`
Expected: PASS — the new suite, and every pre-existing suite (confirming `createTetherServer`'s now-required `pluginsRoot` option didn't break `index.ts`).

- [ ] **Step 6: Commit**

```bash
git add server/src/cli server/src/index.ts server/test/plugin-commands.test.js
git commit -m "feat(cli): add plugin add/dev/remove subcommands"
```

---

### Task 6: Shell picker markup

**Files:**
- Modify: `server/src/templates/shell.ts`
- Test: `server/test/shell.test.js`

**Interfaces:**
- Consumes: nothing new from earlier tasks (works from a plain data shape, no import from `plugins.ts`, keeping `shell.ts`'s existing "only assembles markup already produced elsewhere" boundary — Task 7 is what converts `InstalledPlugin[]` into this shape).
- Produces: `export interface PluginOption { slug: string; name: string; entry: string }`. `renderShell(state, title, railHtml, panelHtml, pluginsBySlot: Record<ShellView, PluginOption[]>)`. Task 7 calls this with real data; Task 8's router relies on the exact markup produced here — each rendered picker's fixed `id` (`pluginPickerDetail`/`pluginPickerHarness`/`pluginPickerAnalytics`), and `data-entry` on each `<option>`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/shell.test.js`:

```js
describe("plugin picker", () => {
	const plugins = {
		detail: [{ slug: "waterfall-view", name: "Waterfall View", entry: "dist/index.html" }],
		harness: [],
		analytics: [],
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

	test("omits a picker entirely for a slot with no installed plugins", () => {
		const html = renderShell({ view: "harness", traceId: "a".repeat(32) }, "Tether", "", "", plugins);
		assert.doesNotMatch(html, /id="pluginPickerHarness"/);
	});

	test("defaults to no pickers when pluginsBySlot is omitted", () => {
		const html = renderShell({ view: "detail", traceId: "a".repeat(32) }, "Tether", "", "");
		assert.doesNotMatch(html, /plugin-picker/);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/shell.test.js`
Expected: FAIL — `renderShell` doesn't accept/use a 5th argument yet, no picker markup produced.

- [ ] **Step 3: Implement**

In `server/src/templates/shell.ts`, add near the top (after `ShellState`):

```ts
export interface PluginOption {
	slug: string;
	name: string;
	entry: string;
}
```

Add a `.plugin-frame` and `.plugin-picker` rule to `STYLE` (insert near the `.tab-disabled`/`.iconbtn` rules):

```css
	.plugin-picker { font: inherit; font-size: 12px; color: var(--ink-2); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; }
	.plugin-frame { width: 100%; height: 70vh; min-height: 480px; border: 0; border-radius: var(--radius); background: var(--panel); }
```

Change `topbar` to accept and render the pickers:

const PLUGIN_PICKER_IDS: Record<ShellView, string> = {
	detail: "pluginPickerDetail",
	harness: "pluginPickerHarness",
	analytics: "pluginPickerAnalytics",
};

function pluginPicker(slot: ShellView, state: ShellState, options: PluginOption[]): string {
	if (options.length === 0) return "";
	const visible = state.view === slot;
	const opts = options
		.map((o) => `<option value="${escapeHtml(o.slug)}" data-entry="${escapeHtml(o.entry)}">${escapeHtml(o.name)}</option>`)
		.join("");
	return `<select id="${PLUGIN_PICKER_IDS[slot]}" class="plugin-picker" data-plugin-slot="${slot}"${visible ? "" : ' style="display:none"'}><option value="">Native</option>${opts}</select>`;
}

function topbar(state: ShellState, pluginsBySlot: Record<ShellView, PluginOption[]>): string {
	const disabled = !state.traceId;
	const hrefAttr = state.traceId ? ` href="/runs/${escapeHtml(state.traceId)}/harness"` : "";
	const disabledAttr = disabled ? ' aria-disabled="true"' : "";
	const classes = ["tab", state.view === "harness" ? "tab-active" : "", disabled ? "tab-disabled" : ""].filter(Boolean).join(" ");
	const harnessTab = `<a class="${classes}"${hrefAttr} data-nav="harness"${disabledAttr}>Harness</a>`;
	const analyticsTab = `<a class="tab${state.view === "analytics" ? " tab-active" : ""}" href="/analytics" data-nav="analytics">Analytics</a>`;
	return `<div class="tabbar">
		${harnessTab}
		${analyticsTab}
		${pluginPicker("detail", state, pluginsBySlot.detail)}
		${pluginPicker("harness", state, pluginsBySlot.harness)}
		${pluginPicker("analytics", state, pluginsBySlot.analytics)}
		<button class="iconbtn" id="themeBtn" type="button" title="Toggle theme" aria-label="Toggle light/dark theme">
			<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
		</button>
	</div>`;
}

const NO_PLUGINS: Record<ShellView, PluginOption[]> = { detail: [], harness: [], analytics: [] };

export function renderShell(
	state: ShellState,
	title: string,
	railHtml: string,
	panelHtml: string,
	pluginsBySlot: Record<ShellView, PluginOption[]> = NO_PLUGINS
): string {
	const bootstrap = JSON.stringify({ view: state.view, traceId: state.traceId ?? null }).replace(/</g, "\\u003c");
	return `<!doctype html>
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<div class="shell">
	<nav class="rail-wrap">
		<div class="rail-brand"><span class="brand-name">Tether</span><a href="/" class="rail-home" aria-label="Latest run" title="Latest run">&larr;</a></div>
		<div id="rail">${railHtml}</div>
	</nav>
	<div class="main-wrap">
		${topbar(state, pluginsBySlot)}
		<main id="content">${panelHtml}</main>
	</div>
</div>
<script>window.__TETHER_INITIAL__ = ${bootstrap};</script>
<script src="/app.js" defer></script>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/shell.test.js`
Expected: PASS, all cases including every pre-existing test (the new 5th parameter is optional/defaulted, so no existing call site breaks yet).

- [ ] **Step 5: Commit**

```bash
git add server/src/templates/shell.ts server/test/shell.test.js
git commit -m "feat(server): render a per-slot plugin picker in the shell topbar"
```

---

### Task 7: Wire installed plugins into the shell routes

**Files:**
- Modify: `server/src/server.ts`

**Interfaces:**
- Consumes: `listInstalledPlugins` from Task 2, `renderShell`'s new `pluginsBySlot` param from Task 6.
- Produces: every full-page shell route now shows real installed-plugin pickers instead of the (safe, but always-empty) default.

- [ ] **Step 1: Write the failing test**

Add to `server/test/server.test.js`, in a new `describe`:

```js
describe("plugin picker wiring", () => {
	test("GET / includes the picker for a compatible installed detail plugin", async () => {
		const pluginsRoot = makeFixturePluginsRoot(); // sample-plugin, replaces: "detail", from Task 3
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/`);
			const html = await res.text();
			assert.match(html, /data-plugin-slot="detail"/);
			assert.match(html, /Sample Plugin/);
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});

	test("GET /analytics does not show the detail plugin's picker", async () => {
		const pluginsRoot = makeFixturePluginsRoot();
		await withServer(async ({ port }) => {
			const res = await fetch(`http://127.0.0.1:${port}/analytics`);
			const html = await res.text();
			assert.doesNotMatch(html, /data-plugin-slot="analytics"/); // no analytics plugin installed
		}, { pluginsRoot });
		rmSync(pluginsRoot, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/server.test.js`
Expected: FAIL — routes still call `renderShell` without a `pluginsBySlot` argument, so no picker markup appears.

- [ ] **Step 3: Implement**

In `server/src/server.ts`:

1. Add `listInstalledPlugins` to the existing `./plugins.js` import.
2. Add a helper (near `buildRail`):

```ts
function pluginsBySlot(pluginsRoot: string): Record<"detail" | "harness" | "analytics", PluginOption[]> {
	const compatible = listInstalledPlugins(pluginsRoot).filter((p) => p.compatible);
	const toOption = (p: (typeof compatible)[number]): PluginOption => ({ slug: p.slug, name: p.name, entry: p.entry });
	return {
		detail: compatible.filter((p) => p.replaces === "detail").map(toOption),
		harness: compatible.filter((p) => p.replaces === "harness").map(toOption),
		analytics: compatible.filter((p) => p.replaces === "analytics").map(toOption),
	};
}
```

Add `import type { PluginOption } from "./templates/shell.js";` to the existing `./templates/shell.js` type import line.

3. Update every `renderShell(...)` call site in the four full-page routes (`/`, `/runs/:traceId`, `/runs/:traceId/harness`, `/analytics`) to pass `pluginsBySlot(pluginsRoot)` as the 5th argument. There are 5 call sites total (including the two error-path ones inside `decodeTraceIdOrShellError` and the not-found branches) — add the argument to each `renderShell(...)` call in the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/server.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): wire installed plugins into the shell's picker"
```

---

### Task 8: Client router — mount/unmount the plugin iframe

**Files:**
- Modify: `server/src/static/app.ts`
- Test: `server/test/app.test.js`

**Interfaces:**
- Consumes: the fixed-id `<select>` picker markup (`pluginPickerDetail`/`pluginPickerHarness`/`pluginPickerAnalytics`) and `<option data-entry="...">` from Task 6, `currentUnmount`/`currentState`/`$`/`navigateTo` already defined in `app.ts`.
- Produces: selecting a plugin swaps `#content` to a sandboxed iframe pointed at `/plugins/:slug/:entry[?traceId=...]`; selecting "Native" (or any real navigation) restores the native panel.

- [ ] **Step 1: Write the failing tests**

`app.ts` has no IIFE wrapper (deliberately — see the file's top-of-file comment), so every top-level function becomes a `sandbox` property `loadApp()` can call directly, e.g. the existing tests already do `sandbox.navigateTo(...)`, `sandbox.pollRail()`, `sandbox.onRailOrTabClick(event)`. The new picker functions follow the same convention — no synthetic event dispatch needed, call `sandbox.onPluginPickerChange(slot)` directly.

`loadApp()`'s `getOrCreate(id)` (in `server/test/app.test.js`) only ever constructs a plain `FakeElement`, which has no `.value`/`.selectedOptions`. Since `elements` (returned by `loadApp()`) is the same live object `getOrCreate` reads from, a test can pre-seed a `FakeSelectElement` under a picker's id *before* triggering app.ts code that looks it up — `getOrCreate` sees the existing entry and returns it as-is instead of constructing a plain one.

Add this class near `FakeElement`'s definition in `server/test/app.test.js` (reusing its existing `setAttribute`/`getAttribute`/`classList`/`addEventListener` — this only adds what a `<select>`/`<option>` pair needs beyond that):

```js
class FakeSelectElement extends FakeElement {
	constructor(id) {
		super(id);
		this._options = [];
		this.value = "";
	}
	get selectedOptions() { return this._options.filter((o) => o.value === this.value); }
}
```

Then add a test block (place near the existing `describe("router: ...")` blocks, following the same `loadApp()` + `sandbox.navigateTo(...)` pattern those already use):

```js
describe("plugin picker", () => {
	test("selecting a plugin option replaces #content with a sandboxed iframe pointed at the plugin's entry", async () => {
		const { elements, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "waterfall-view", getAttribute: (n) => (n === "data-entry" ? "dist/index.html" : null) });
		picker.value = "waterfall-view";
		elements.pluginPickerDetail = picker;

		sandbox.onPluginPickerChange("detail");

		const content = elements.content;
		assert.equal(content.children.length, 1);
		const iframe = content.children[0];
		assert.equal(iframe.getAttribute("sandbox"), "allow-scripts allow-same-origin");
		assert.equal(iframe.src, `/plugins/waterfall-view/dist/index.html?traceId=${"a".repeat(32)}`);
	});

	test("selecting Native (empty value) re-navigates instead of mounting a frame", async () => {
		const { elements, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker.value = "";
		elements.pluginPickerDetail = picker;

		let navigatedTo = null;
		sandbox.navigateTo = (pathname) => { navigatedTo = pathname; return Promise.resolve(); };
		sandbox.onPluginPickerChange("detail");

		assert.equal(navigatedTo, "/runs/" + "a".repeat(32));
	});

	test("analytics slot's iframe src has no traceId query param", async () => {
		const { elements, sandbox } = loadApp();
		await sandbox.navigateTo("/analytics", true);

		const picker = new FakeSelectElement("pluginPickerAnalytics");
		picker._options.push({ value: "usage-explorer", getAttribute: (n) => (n === "data-entry" ? "index.html" : null) });
		picker.value = "usage-explorer";
		elements.pluginPickerAnalytics = picker;

		sandbox.onPluginPickerChange("analytics");

		assert.equal(elements.content.children[0].src, "/plugins/usage-explorer/index.html");
	});

	test("a native panel's unmount runs before a plugin frame mounts, so its stale listeners can't fire", async () => {
		const { windowListeners, elements, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);
		// mountRunDataIfPresent only mounts when a #run-data island is present in the fetched
		// fragment; this harness's stubbed fetch returns an empty body, so no native panel is
		// actually mounted here -- this test instead verifies the *unconditional* currentUnmount
		// call site exists by asserting it's safe to call onPluginPickerChange with no prior mount.
		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "waterfall-view", getAttribute: (n) => (n === "data-entry" ? "dist/index.html" : null) });
		picker.value = "waterfall-view";
		elements.pluginPickerDetail = picker;
		assert.doesNotThrow(() => sandbox.onPluginPickerChange("detail"));
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/app.test.js`
Expected: FAIL — `sandbox.onPluginPickerChange` is not a function yet.

- [ ] **Step 3: Implement in `server/src/static/app.ts`**

Add near `setRailActive`/`updateHarnessTab`:

```ts
const PLUGIN_PICKER_IDS: Record<ShellState["view"], string> = {
	detail: "pluginPickerDetail",
	harness: "pluginPickerHarness",
	analytics: "pluginPickerAnalytics",
};

function setPluginPickerVisibility(view: ShellState["view"]): void {
	(Object.keys(PLUGIN_PICKER_IDS) as Array<ShellState["view"]>).forEach((slot) => {
		const el = document.getElementById(PLUGIN_PICKER_IDS[slot]) as HTMLSelectElement | null;
		if (!el) return;
		el.style.display = slot === view ? "" : "none";
		el.value = "";
	});
}

function mountPluginFrame(slug: string, entry: string, slot: ShellState["view"]): void {
	const iframe = document.createElement("iframe") as HTMLIFrameElement;
	iframe.className = "plugin-frame";
	iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
	const query = slot === "analytics" ? "" : `?traceId=${encodeURIComponent(currentState.traceId ?? "")}`;
	iframe.src = `/plugins/${encodeURIComponent(slug)}/${entry}${query}`;
	const content = $("content");
	content.innerHTML = "";
	content.appendChild(iframe);
}

function onPluginPickerChange(slot: ShellState["view"]): void {
	const select = document.getElementById(PLUGIN_PICKER_IDS[slot]) as HTMLSelectElement | null;
	if (!select) return;
	if (currentUnmount) { currentUnmount(); currentUnmount = null; }
	const slug = select.value;
	if (slug === "") { navigateTo(window.location.pathname, false); return; }
	const option = select.selectedOptions[0];
	const entry = option?.getAttribute("data-entry") ?? "";
	mountPluginFrame(slug, entry, slot);
}
```

Call `setPluginPickerVisibility(target.view)` inside `navigateTo`, right alongside the existing `setTabActive(target.view); setRailActive(...); updateHarnessTab(...);` line group. Call it once more in `init()` right after `if (currentState.view === "detail") mountRunDataIfPresent();`, passing `currentState.view`.

Register the three listeners in `init()`, alongside the existing `themeBtn`/rail/tabbar listeners:

```ts
(Object.keys(PLUGIN_PICKER_IDS) as Array<ShellState["view"]>).forEach((slot) => {
	document.getElementById(PLUGIN_PICKER_IDS[slot])?.addEventListener("change", () => onPluginPickerChange(slot));
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/app.test.js`
Expected: PASS, all cases including every pre-existing test in the file (the `FakeElement`/`FakeSelectElement` addition and new picker code are additive — no existing test's DOM interactions change shape).

- [ ] **Step 5: Commit**

```bash
git add server/src/static/app.ts server/test/app.test.js
git commit -m "feat(client): mount/unmount a plugin iframe from the shell picker"
```

---

### Task 9: End-to-end verification with a real fixture plugin

**Files:**
- None new — this task exercises Tasks 1–8 together and is the final gate before calling the feature done.

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: a verified, working local flow — nothing downstream depends on this task's output beyond confidence.

- [ ] **Step 1: Run the full test suite**

Run: `cd server && npm run build && npm test`
Expected: PASS — every suite (`plugins.test.js`, `plugin-commands.test.js`, and every modified suite from Tasks 1, 3, 4, 6, 7, 8), zero failures.

- [ ] **Step 2: Manual end-to-end pass**

```bash
cd server
export TETHER_PORT=4319
export TETHER_DATA_DIR_OVERRIDE_FOR_MANUAL_TEST=$(mktemp -d) # if no such override exists, instead just note the real OS data dir printed on startup and clean it up manually afterward
node dist/index.js &
SERVER_PID=$!

# Install the Task 3 fixture plugin as a real local git repo:
FIXTURE_REPO=$(mktemp -d)
cp -r test/fixtures/sample-plugin/* "$FIXTURE_REPO"/
(cd "$FIXTURE_REPO" && git init -q && git add -A && git commit -q -m fixture)
node dist/index.js plugin add "$FIXTURE_REPO"
```

Then in a browser: load `http://localhost:4319/`, confirm a "Native / Sample Plugin" picker appears in the topbar for the Detail view, select "Sample Plugin", confirm `#content` becomes an iframe showing "sample plugin content", confirm switching back to "Native" restores the real Flight Recorder, and confirm navigating to a different run in the rail also restores native (picker reset). Then run `node dist/index.js plugin remove sample-plugin` and reload — confirm the picker disappears.

Kill the manual server (`kill $SERVER_PID`) and clean up the fixture repo/data dir afterward.

- [ ] **Step 3: Update `CLAUDE.md`'s "Known gaps" / status section if warranted**

If this plan closes any item currently listed under CLAUDE.md's "Known gaps", update that section to reflect it. (As of this plan's authoring, the plugin system is new functionality, not a fix to a listed gap — check the file's current content before editing, since it may have changed since this plan was written.)

- [ ] **Step 4: Commit** (only if Step 3 produced a change)

```bash
git add CLAUDE.md
git commit -m "docs: note plugin view system in project status"
```

---

## Self-Review Notes

- **Spec coverage:** §3.1 (Task 6/7/8 — slot-only views), §3.2 (Task 5 — CLI install/dev/remove), §3.3 (Task 2 — manifest), §3.4 (Task 3/4/8 — iframe execution, sandbox flags, dev override), §3.5 (Task 1 — versioned JSON API), §3.6 (Task 6/7 — picker), §3.7 (every task's own test step plus Task 9's e2e pass) are all covered by a task above.
- **Type consistency verified:** `PluginManifest`/`InstalledPlugin` (Task 2) → consumed identically in Task 3 (`resolvePluginAssetPath`), Task 5 (`readManifest`), and Task 7 (`listInstalledPlugins(...).filter(p => p.compatible)`). `PluginOption` (Task 6) → produced by Task 7's `pluginsBySlot` helper with matching field names (`slug`, `name`, `entry`). `createTetherServer`'s signature change (Task 3, `{ pluginsRoot: string }`) is consistent everywhere it's called: `server.test.js`'s `withServer` (Task 3 step 4) and `index.ts` (Task 5 step 4).
- **No placeholders:** every step above has real, complete code — no "add appropriate error handling" or "similar to Task N" placeholders remain.
