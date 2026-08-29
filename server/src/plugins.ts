/**
 * Plugin manifest/directory logic shared by the CLI (plugin-commands.ts)
 * and the server's /api and /plugins routes. Degrades gracefully -- a
 * missing or malformed manifest is skipped (null / omitted from a list),
 * never thrown, matching this codebase's runs.ts/harness.ts convention.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

export const TETHER_API_VERSION = 1;

const REPLACES_SLOTS = new Set(["detail", "harness", "analytics"]);
const KINDS = new Set(["panel", "widget"]);
const SIZES = new Set(["small", "medium", "large"]);

// isPlainSlug also refuses these outright: readDevOverrides already installs entries via
// defineProperty so `overrides[slug]` can never resolve to something inherited from
// Object.prototype, but setDevOverride's write side (`overrides[slug] = url`) is a plain
// assignment -- on a plain object, assigning to "__proto__" changes the prototype instead of
// creating an own property, silently discarding the value rather than storing it. Rejecting these
// names at the one shared validation point means no plugin can ever be installed under one, so the
// write side never has to reason about it either.
const RESERVED_SLUGS = new Set(["__proto__", "constructor", "prototype"]);

export interface PluginManifest {
	name: string;
	slug: string;
	version: string;
	author: string;
	description: string;
	entry: string;
	icon?: string;
	replaces?: "detail" | "harness" | "analytics";
	kind?: "panel" | "widget";
	size?: "small" | "medium" | "large";
	tetherApiVersion: number;
}

export interface InstalledPlugin extends PluginManifest {
	compatible: boolean;
}

export function pluginsDir(dataDir: string): string {
	return join(dataDir, "plugins");
}

/** True only for a slug safe to use as a single path segment under the plugins root.
 *
 * The single source of truth for slug validation -- used by every place that turns a slug into a
 * filesystem path: the three CLI subcommands (whose slugs come from argv or, for `add`, from the
 * cloned repo's own manifest, i.e. remote attacker-controlled content) and the server's
 * `/plugins/:slug/*` asset route (whose slug comes off the URL). Rejects anything containing a
 * path separator (so `join` can't escape the plugins root), `.`/`..`, the empty string, and any
 * dot-prefixed name -- the latter both because a hidden plugin directory is meaningless and
 * because `.tmp-install-*` is reserved for `plugin add`'s staging directories -- and a handful of
 * JS-prototype-related names (see RESERVED_SLUGS) that are safe as directory names but confusing
 * or silently-wrong as object keys elsewhere in this module. */
export function isPlainSlug(slug: string): boolean {
	if (typeof slug !== "string" || slug === "") return false;
	if (slug.includes("/") || slug.includes("\\") || slug.includes("\0")) return false;
	if (slug !== basename(slug)) return false;
	if (RESERVED_SLUGS.has(slug)) return false;
	return !slug.startsWith(".");
}

function isValidManifest(v: unknown): v is PluginManifest {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	const baseValid =
		typeof m.name === "string" &&
		typeof m.slug === "string" &&
		typeof m.version === "string" &&
		typeof m.author === "string" &&
		typeof m.description === "string" &&
		typeof m.entry === "string" &&
		typeof m.tetherApiVersion === "number";
	if (!baseValid) return false;
	if (m.kind !== undefined && !KINDS.has(m.kind as string)) return false;
	const kind = (m.kind as "panel" | "widget" | undefined) ?? "panel";
	if (kind === "widget") return typeof m.size === "string" && SIZES.has(m.size);
	return typeof m.replaces === "string" && REPLACES_SLOTS.has(m.replaces);
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
		// Skips dot-directories -- notably `plugin add`'s in-progress `.tmp-install-*` staging dirs,
		// which briefly hold a valid manifest but aren't installed plugins yet (and whose directory
		// name doesn't match their manifest slug, so nothing could serve their assets anyway).
		if (!isPlainSlug(slug)) continue;
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
	// Guard against path traversal in slug -- shared with the CLI's own slug checks.
	if (!isPlainSlug(slug)) return null;
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
 * missing or malformed -- this is a convenience dev-mode file, never load-bearing enough to throw.
 *
 * Only own, string-valued entries are kept, and each is installed with `defineProperty` so a key
 * like `__proto__` becomes a real own data property rather than walking (or poisoning) the
 * prototype chain -- callers do `overrides[slug]` with a slug off the URL, and that lookup must
 * never resolve to something inherited from Object.prototype. */
export function readDevOverrides(pluginsRoot: string): Record<string, string> {
	const overrides: Record<string, string> = {};
	try {
		const raw = readFileSync(devOverridesPath(pluginsRoot), "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return overrides;
		for (const [slug, url] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof url !== "string" || url === "") continue;
			Object.defineProperty(overrides, slug, { value: url, writable: true, enumerable: true, configurable: true });
		}
	} catch {
		/* fall through to whatever was collected */
	}
	return overrides;
}

/** Sets (or, when `url` is null, clears) the dev-server override for `slug`. */
export function setDevOverride(pluginsRoot: string, slug: string, url: string | null): void {
	// mode 0o700 matches db.ts's data-directory convention -- this sits inside the same data dir,
	// which holds prompts and model outputs and must not be world-readable. (Ignored when the
	// directory already exists, which is why every creator of it has to agree on the mode.)
	mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
	const overrides = readDevOverrides(pluginsRoot);
	if (url === null) delete overrides[slug];
	else overrides[slug] = url;
	writeFileSync(devOverridesPath(pluginsRoot), JSON.stringify(overrides, null, 2));
}
