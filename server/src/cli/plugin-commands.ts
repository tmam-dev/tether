/**
 * `plugin add|dev|remove` CLI subcommands. Pure Node -- shells out to the system `git` binary
 * (no git library dependency) for `add`, and otherwise only touches plugins.ts's directory/manifest
 * helpers. Returns an exit code rather than calling process.exit itself, so index.ts controls the
 * process lifecycle and this stays directly callable from tests.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installPluginFromGitUrl, isPlainSlug, pluginsDir, readManifest, setDevOverride, TETHER_API_VERSION } from "../plugins.js";

/** Rejects a slug that isn't usable as a single path segment under the plugins root. Shared by all
 * three subcommands -- `remove`'s consequence in particular is a recursive force-delete. */
function rejectBadSlug(slug: string, what: string): boolean {
	if (isPlainSlug(slug)) return false;
	console.error(`Refusing to continue: ${what} "${slug}" is not a valid plugin slug.`);
	return true;
}

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

function removePlugin(slug: string, dataDir: string): number {
	if (rejectBadSlug(slug, "slug")) return 1;
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
	if (rejectBadSlug(slug, "slug")) return 1;
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
