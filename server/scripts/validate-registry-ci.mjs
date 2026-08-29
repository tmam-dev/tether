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
	// Enforced here (the trust-boundary layer every real, merged listing must pass through), not in
	// registry.ts's runtime schema validation -- the existing server.test.js/plugins.test.js fixtures
	// deliberately use local filesystem paths as `repo` values so they can clone a local repo instead
	// of hitting the network, and a scheme restriction in isValidRegistryEntry would break those.
	if (!entry.repo.startsWith("https://")) {
		fail(`"${entry.slug}": repo "${entry.repo}" must be an https:// URL`);
		continue;
	}
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
		} else if (manifest.slug !== entry.slug) {
			// Mirrors server.ts's runtime install-route check: the registry entry's own slug (what
			// the "not yet installed" pickers key on) must match the slug the plugin actually installs
			// under (the manifest's slug) -- otherwise a listed entry could silently overwrite an
			// unrelated already-installed plugin.
			fail(`"${entry.slug}": registry slug doesn't match the manifest's own slug "${manifest.slug}".`);
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
