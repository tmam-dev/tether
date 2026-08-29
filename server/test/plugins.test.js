import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
	TETHER_API_VERSION,
	pluginsDir,
	readManifest,
	listInstalledPlugins,
	resolvePluginAssetPath,
	contentTypeFor,
	readDevOverrides,
	setDevOverride,
	isPlainSlug,
	readDashboardSlugs,
	writeDashboardSlugs,
	installPluginFromGitUrl,
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

	describe("manifest kind/size validation", () => {
		test("a manifest with no kind field validates as a panel (backward compatible) and still requires replaces", () => {
			withTempPluginsRoot((root) => {
				installFixturePlugin(root, "legacy-panel");
				const [plugin] = listInstalledPlugins(root);
				assert.equal(plugin.replaces, "detail");
				assert.equal(plugin.kind, undefined);
			});
		});

		test("a panel manifest missing replaces is rejected", () => {
			withTempPluginsRoot((root) => {
				installFixturePlugin(root, "broken-panel", { replaces: undefined });
				assert.equal(listInstalledPlugins(root).length, 0);
			});
		});

		test("a widget manifest with a valid size and no replaces is accepted", () => {
			withTempPluginsRoot((root) => {
				installFixturePlugin(root, "cost-trend", { kind: "widget", size: "medium", replaces: undefined });
				const [plugin] = listInstalledPlugins(root);
				assert.equal(plugin.kind, "widget");
				assert.equal(plugin.size, "medium");
			});
		});

		test("a widget manifest missing size is rejected", () => {
			withTempPluginsRoot((root) => {
				installFixturePlugin(root, "no-size", { kind: "widget", replaces: undefined });
				assert.equal(listInstalledPlugins(root).length, 0);
			});
		});

		test("a widget manifest with an invalid size is rejected", () => {
			withTempPluginsRoot((root) => {
				installFixturePlugin(root, "bad-size", { kind: "widget", size: "huge", replaces: undefined });
				assert.equal(listInstalledPlugins(root).length, 0);
			});
		});

		test("a manifest with an unrecognized kind is rejected", () => {
			withTempPluginsRoot((root) => {
				installFixturePlugin(root, "bad-kind", { kind: "bogus" });
				assert.equal(listInstalledPlugins(root).length, 0);
			});
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
			const expected = realpathSync(join(root, "waterfall-view", "dist", "index.html"));
			assert.equal(resolved, expected);
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

	test("returns null for a slug containing path traversal segments", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "waterfall-view");
			assert.equal(resolvePluginAssetPath(root, "../../../../etc", "passwd"), null);
		});
	});

	test("returns null for a slug containing a literal forward slash", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "waterfall-view");
			assert.equal(resolvePluginAssetPath(root, "foo/bar", "dist/index.html"), null);
		});
	});

	test("returns null for a slug that is exactly '..'", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "waterfall-view");
			assert.equal(resolvePluginAssetPath(root, "..", "dist/index.html"), null);
		});
	});

	test("returns null for a reserved slug even if a directory with that name exists", () => {
		withTempPluginsRoot((root) => {
			installFixturePlugin(root, "__proto__");
			assert.equal(resolvePluginAssetPath(root, "__proto__", "dist/index.html"), null);
		});
	});
});

describe("isPlainSlug", () => {
	test("accepts an ordinary slug", () => {
		assert.equal(isPlainSlug("waterfall-view"), true);
	});

	test("rejects '__proto__', 'constructor', and 'prototype'", () => {
		// These are safe as directory names but silently wrong as plain-object keys elsewhere in
		// this module (setDevOverride's `overrides[slug] = url` assignment): rejecting them here,
		// the single shared validation point, means a plugin can never be installed under one.
		assert.equal(isPlainSlug("__proto__"), false);
		assert.equal(isPlainSlug("constructor"), false);
		assert.equal(isPlainSlug("prototype"), false);
	});

	test("rejects a dot-prefixed name, an empty string, and a non-string", () => {
		assert.equal(isPlainSlug(".tmp-install-abc123"), false);
		assert.equal(isPlainSlug(""), false);
		assert.equal(isPlainSlug(undefined), false);
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

describe("dashboard slug persistence", () => {
	test("returns an empty list when no dashboard file exists yet", () => {
		withTempPluginsRoot((root) => {
			assert.deepEqual(readDashboardSlugs(root), []);
		});
	});

	test("a write/read round-trip preserves order", () => {
		withTempPluginsRoot((root) => {
			assert.equal(writeDashboardSlugs(root, ["cost-trend", "latency-p95"]), true);
			assert.deepEqual(readDashboardSlugs(root), ["cost-trend", "latency-p95"]);
		});
	});

	test("a malformed dashboard file reads back as an empty list, never throws", () => {
		withTempPluginsRoot((root) => {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "analytics-dashboard.json"), "{not json");
			assert.doesNotThrow(() => readDashboardSlugs(root));
			assert.deepEqual(readDashboardSlugs(root), []);
		});
	});

	test("writing a slug that fails isPlainSlug is rejected and nothing is written", () => {
		withTempPluginsRoot((root) => {
			assert.equal(writeDashboardSlugs(root, ["cost-trend", "../escape"]), false);
			assert.deepEqual(readDashboardSlugs(root), []);
		});
	});
});

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
