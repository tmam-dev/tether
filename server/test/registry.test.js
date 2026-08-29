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
