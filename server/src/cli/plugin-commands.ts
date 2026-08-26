/**
 * `plugin add|dev|remove` CLI subcommands. Pure Node -- shells out to the system `git` binary
 * (no git library dependency) for `add`, and otherwise only touches plugins.ts's directory/manifest
 * helpers. Returns an exit code rather than calling process.exit itself, so index.ts controls the
 * process lifecycle and this stays directly callable from tests.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pluginsDir, readManifest, setDevOverride } from "../plugins.js";

/** Best-effort cleanup of the temp clone dir -- guarded so a cleanup failure never masks the
 * original error that triggered it. */
function cleanupCloneTarget(cloneTarget: string): void {
	try {
		rmSync(cloneTarget, { recursive: true, force: true });
	} catch (err) {
		console.error(`Warning: failed to clean up temp directory "${cloneTarget}": ${(err as Error).message}`);
	}
}

function addPlugin(gitUrl: string, dataDir: string): number {
	const cloneTarget = mkdtempSync(join(tmpdir(), "tether-plugin-clone-"));
	try {
		execFileSync("git", ["clone", "--depth", "1", gitUrl, cloneTarget], { stdio: "pipe" });
	} catch (err) {
		console.error(`git clone failed: ${(err as Error).message}`);
		cleanupCloneTarget(cloneTarget);
		return 1;
	}

	const manifest = readManifest(cloneTarget);
	if (!manifest) {
		console.error("tether-plugin.json is missing or invalid at the repo root.");
		cleanupCloneTarget(cloneTarget);
		return 1;
	}

	// manifest.slug comes from the cloned repo's tether-plugin.json -- i.e. attacker-controlled
	// remote content when gitUrl points at a malicious or compromised repo. Reject anything that
	// isn't a plain path segment before using it to build a filesystem path, mirroring the slug
	// validation in plugins.ts's resolvePluginAssetPath.
	if (manifest.slug !== basename(manifest.slug) || manifest.slug === "." || manifest.slug === "..") {
		console.error(`Refusing to install: manifest slug "${manifest.slug}" is not a valid path segment.`);
		cleanupCloneTarget(cloneTarget);
		return 1;
	}

	try {
		const root = pluginsDir(dataDir);
		mkdirSync(root, { recursive: true });
		const dest = join(root, manifest.slug);
		rmSync(dest, { recursive: true, force: true });
		renameSync(cloneTarget, dest);
	} catch (err) {
		console.error(`Failed to install plugin into the plugins directory: ${(err as Error).message}`);
		cleanupCloneTarget(cloneTarget);
		return 1;
	}

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
