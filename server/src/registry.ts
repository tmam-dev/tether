/**
 * Registry-index schema/validation and the bundled-snapshot loader. The bundled snapshot at
 * ./registry/plugins.json (relative to this compiled module) is copied in from the repo-root
 * registry/plugins.json at build time -- see scripts/copy-registry-snapshot.mjs -- so it ships
 * inside the trailai-tether npm package for offline/first-run use.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPlainSlug } from "./plugins.js";

export interface RegistryEntry {
	name: string;
	slug: string;
	repo: string;
	description: string;
	kind: "panel" | "widget";
	slot?: "detail" | "harness" | "analytics";
}

export interface RegistryFile {
	schemaVersion: number;
	entries: RegistryEntry[];
}

const REGISTRY_KINDS = new Set(["panel", "widget"]);
const REGISTRY_SLOTS = new Set(["detail", "harness", "analytics"]);

function isValidRegistryEntry(v: unknown): v is RegistryEntry {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	const baseValid =
		typeof e.name === "string" &&
		typeof e.slug === "string" &&
		isPlainSlug(e.slug) &&
		typeof e.repo === "string" &&
		typeof e.description === "string" &&
		typeof e.kind === "string" &&
		REGISTRY_KINDS.has(e.kind);
	if (!baseValid) return false;
	if (e.kind === "panel") return typeof e.slot === "string" && REGISTRY_SLOTS.has(e.slot);
	return e.slot === undefined;
}

/** True for a well-formed registry index: a numeric schemaVersion and an entries array of valid
 * RegistryEntry objects. Used both by the server (to accept/reject a live CDN fetch, Task 2) and
 * by the CI validation script (Task 8) that checks a registry PR before merge. */
export function isValidRegistryFile(v: unknown): v is RegistryFile {
	if (typeof v !== "object" || v === null) return false;
	const f = v as Record<string, unknown>;
	if (typeof f.schemaVersion !== "number") return false;
	if (!Array.isArray(f.entries)) return false;
	return f.entries.every(isValidRegistryEntry);
}

const BUNDLED_REGISTRY_PATH = fileURLToPath(new URL("./registry/plugins.json", import.meta.url));
const EMPTY_REGISTRY: RegistryFile = { schemaVersion: 1, entries: [] };

/** Reads the registry snapshot bundled with this npm install. Never throws: a missing or
 * malformed bundled file -- which would only happen from a broken build -- degrades to an empty
 * registry rather than crashing the server that depends on it. */
export function loadBundledRegistry(): RegistryFile {
	try {
		const parsed = JSON.parse(readFileSync(BUNDLED_REGISTRY_PATH, "utf-8"));
		return isValidRegistryFile(parsed) ? parsed : EMPTY_REGISTRY;
	} catch {
		return EMPTY_REGISTRY;
	}
}
