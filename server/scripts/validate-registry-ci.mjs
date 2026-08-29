#!/usr/bin/env node
/**
 * Lightweight CI check for a registry/plugins.json PR (spec §4): schema-validates the file, then
 * for every entry, shallow-clones its `repo` and confirms tether-plugin.json is valid there --
 * reusing the exact validators the running server trusts (isValidRegistryFile, readManifest),
 * so this never drifts from what the server itself accepts. Not a security review of the linked
 * code -- just "the listing is well-formed and the repo resolves", per the spec's "listed," not
 * "reviewed," framing.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isValidRegistryFile } from "../dist/registry.js";
import { readManifest } from "../dist/plugins.js";

const registryPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "registry", "plugins.json");

function fail(message) {
	console.error(`✗ ${message}`);
	process.exitCode = 1;
}

let parsed;
try {
	parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
} catch (err) {
	fail(`registry/plugins.json is not valid JSON: ${err.message}`);
	process.exit(1);
}

if (!isValidRegistryFile(parsed)) {
	fail("registry/plugins.json failed schema validation (isValidRegistryFile).");
	process.exit(1);
}
console.log(`✓ registry/plugins.json schema is valid (${parsed.entries.length} entr${parsed.entries.length === 1 ? "y" : "ies"}).`);

for (const entry of parsed.entries) {
	const cloneDir = mkdtempSync(join(tmpdir(), "tether-registry-ci-"));
	try {
		try {
			execFileSync("git", ["-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--", entry.repo, cloneDir], { stdio: "pipe" });
		} catch (err) {
			fail(`"${entry.slug}": repo "${entry.repo}" did not clone: ${err.message}`);
			continue;
		}
		const manifest = readManifest(cloneDir);
		if (!manifest) {
			fail(`"${entry.slug}": tether-plugin.json is missing or invalid at the repo root.`);
		} else {
			const manifestKind = manifest.kind ?? "panel";
			if (manifestKind !== entry.kind) {
				fail(`"${entry.slug}": registry kind "${entry.kind}" doesn't match the manifest's kind "${manifestKind}".`);
			} else if (entry.kind === "panel" && manifest.replaces !== entry.slot) {
				fail(`"${entry.slug}": registry slot "${entry.slot}" doesn't match the manifest's replaces "${manifest.replaces}".`);
			} else {
				console.log(`✓ "${entry.slug}": repo resolves and its manifest matches the registry entry.`);
			}
		}
	} finally {
		rmSync(cloneDir, { recursive: true, force: true });
	}
}

if (process.exitCode) {
	console.error("\nRegistry validation failed.");
} else {
	console.log("\nRegistry validation passed.");
}
