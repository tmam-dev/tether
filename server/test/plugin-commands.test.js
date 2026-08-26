import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

async function withDataDir(fn) {
	const dataDir = mkdtempSync(join(tmpdir(), "tether-data-test-"));
	try {
		return await fn(dataDir);
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

	test("rejects a manifest slug containing '..' and writes nothing outside the plugins directory", async () => {
		await withDataDir(async (dataDir) => {
			const repoDir = makeFixtureRepo("../../../evil");
			const code = await runPluginCommand(["add", repoDir], dataDir);
			assert.equal(code, 1);

			// The escape target -- resolved the same way a naive join(pluginsRoot, slug) would --
			// must not exist. dataDir's tmp-dir depth is shallow enough that three ".." segments
			// land above dataDir itself, which is safe to assert doesn't contain the escaped write.
			const escaped = resolve(pluginsDir(dataDir), "../../../evil");
			assert.ok(!existsSync(escaped));

			// The slug is rejected before the plugins directory is even created, so nothing was
			// installed anywhere.
			assert.ok(!existsSync(pluginsDir(dataDir)));
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
