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
