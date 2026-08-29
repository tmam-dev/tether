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
