/**
 * `plugin add|dev|remove` CLI subcommands. Pure Node -- shells out to the system `git` binary
 * (no git library dependency) for `add`, and otherwise only touches plugins.ts's directory/manifest
 * helpers. Returns an exit code rather than calling process.exit itself, so index.ts controls the
 * process lifecycle and this stays directly callable from tests.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isPlainSlug, pluginsDir, readManifest, setDevOverride, TETHER_API_VERSION } from "../plugins.js";

/** Best-effort cleanup of the temp clone dir -- guarded so a cleanup failure never masks the
 * original error that triggered it. */
function cleanupCloneTarget(cloneTarget: string): void {
	try {
		rmSync(cloneTarget, { recursive: true, force: true });
	} catch (err) {
		console.error(`Warning: failed to clean up temp directory "${cloneTarget}": ${(err as Error).message}`);
	}
}

/** Removes any `.tmp-install-*` staging directory left behind under `root` -- normally cleaned up
 * by `cleanupCloneTarget` on every failure path, but a process kill (SIGKILL, a crash) mid-install
 * skips that cleanup entirely. These are already invisible to `listInstalledPlugins` and
 * unservable by `resolvePluginAssetPath` (both refuse dot-prefixed names), so a leftover one is
 * inert disk usage, not a correctness or security issue -- this just stops it from accumulating.
 * Best-effort: a sweep failure is not a reason to fail the install that triggered it. */
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
			/* best effort -- an install in progress under this exact name is vanishingly unlikely
			 * given plugin add isn't expected to run concurrently with itself, and even then the
			 * worst case is this sweep skipping that one directory, not corrupting it. */
		}
	}
}

/** Rejects a slug that isn't usable as a single path segment under the plugins root. Shared by all
 * three subcommands -- `remove`'s consequence in particular is a recursive force-delete. */
function rejectBadSlug(slug: string, what: string): boolean {
	if (isPlainSlug(slug)) return false;
	console.error(`Refusing to continue: ${what} "${slug}" is not a valid plugin slug.`);
	return true;
}

function addPlugin(gitUrl: string, dataDir: string): number {
	// Stage the clone INSIDE the plugins root, not in the OS temp dir: the final install is a
	// renameSync into this same directory, and rename(2) fails with EXDEV across filesystems
	// (tmpfs /tmp vs. a home-directory data dir is the common case on Linux). Staging here makes
	// that rename same-filesystem, so it can't fail for filesystem-boundary reasons -- which also
	// means a same-slug reinstall's `rmSync(dest)` + `renameSync` pair can't strand the user with
	// the old install deleted and the new one unmoved. The `.tmp-install-` prefix is reserved:
	// listInstalledPlugins skips dot-directories, so an in-progress clone is never picked up as an
	// installed plugin, and isPlainSlug refuses any slug that could collide with one.
	const root = pluginsDir(dataDir);
	let cloneTarget: string;
	try {
		// mode 0o700 matches db.ts's data-directory convention (the data dir holds prompts and
		// model outputs). Ignored if the directory already exists, so every creator must agree.
		mkdirSync(root, { recursive: true, mode: 0o700 });
		sweepStaleInstallDirs(root);
		cloneTarget = mkdtempSync(join(root, ".tmp-install-"));
	} catch (err) {
		console.error(`Failed to prepare the plugins directory: ${(err as Error).message}`);
		return 1;
	}

	try {
		// `-c protocol.ext.allow=never` disables git's `ext::` transport, which executes an
		// arbitrary shell command by design and is permitted by git's default `protocol.ext.allow=user`.
		// `--` stops a gitUrl beginning with `-` from being parsed as a git option.
		execFileSync("git", ["-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--", gitUrl, cloneTarget], {
			stdio: "pipe",
		});
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
	// isn't a plain path segment before using it to build a filesystem path.
	if (rejectBadSlug(manifest.slug, "manifest slug")) {
		cleanupCloneTarget(cloneTarget);
		return 1;
	}

	try {
		const dest = join(root, manifest.slug);
		rmSync(dest, { recursive: true, force: true });
		renameSync(cloneTarget, dest);
	} catch (err) {
		console.error(`Failed to install plugin into the plugins directory: ${(err as Error).message}`);
		cleanupCloneTarget(cloneTarget);
		return 1;
	}

	const target = manifest.kind === "widget" ? `analytics widget (${manifest.size})` : `replaces "${manifest.replaces}"`;
	console.log(`Installed "${manifest.name}" (${manifest.slug}) -> ${target}`);
	// Spec §3.3: a version-mismatched plugin still installs (nothing is deleted), but the mismatch
	// has to be surfaced -- otherwise the author sees a clean install and a plugin that silently
	// never appears in any picker.
	if (manifest.tetherApiVersion !== TETHER_API_VERSION) {
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
