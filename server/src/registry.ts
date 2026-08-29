/**
 * Registry-index schema/validation and the bundled-snapshot loader. The bundled snapshot at
 * ./registry/plugins.json (relative to this compiled module) is copied in from the repo-root
 * registry/plugins.json at build time -- see scripts/copy-registry-snapshot.mjs -- so it ships
 * inside the trailai-tether npm package for offline/first-run use.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
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

interface RegistryCache {
	fetchedAt: number;
	data: RegistryFile;
}

function registryCachePath(pluginsRoot: string): string {
	return join(pluginsRoot, "registry-cache.json");
}

function readRegistryCache(pluginsRoot: string): RegistryCache | null {
	try {
		const parsed = JSON.parse(readFileSync(registryCachePath(pluginsRoot), "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const { fetchedAt, data } = parsed as Record<string, unknown>;
		if (typeof fetchedAt !== "number" || !isValidRegistryFile(data)) return null;
		return { fetchedAt, data };
	} catch {
		return null;
	}
}

function writeRegistryCache(pluginsRoot: string, data: RegistryFile, fetchedAt: number): void {
	// mode 0o700 matches plugins.ts's data-directory convention -- this cache sits inside the same
	// plugins root as dev-overrides.json/analytics-dashboard.json.
	mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
	writeFileSync(registryCachePath(pluginsRoot), JSON.stringify({ fetchedAt, data }, null, 2));
}

/** The registry data to show right now: the disk cache (from a prior live refresh) if present and
 * valid, otherwise the snapshot bundled with this install. Never triggers a fetch itself -- call
 * refreshRegistryIfStale separately to opportunistically update the cache in the background; this
 * function only ever reads what's already on disk, so it's always safe to call synchronously from
 * a request handler. */
export function currentRegistry(pluginsRoot: string): RegistryFile {
	return readRegistryCache(pluginsRoot)?.data ?? loadBundledRegistry();
}

export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_REGISTRY_URL = "https://cdn.jsdelivr.net/gh/tmam-dev/tether@main/registry/plugins.json";

function registryUrl(): string {
	return process.env.TETHER_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

// Keyed by pluginsRoot rather than a single scalar so two different data directories (as in two
// concurrent test cases, each with their own temp pluginsRoot) never throttle each other.
const lastAttemptByRoot = new Map<string, number>();

/** Opportunistically refreshes the on-disk registry cache from the CDN when it's missing or older
 * than REGISTRY_TTL_MS, throttled to at most one attempt per REGISTRY_RETRY_MS per pluginsRoot so
 * a down/unreachable CDN isn't hit on every single request. Always resolves, never rejects --  a
 * failed fetch just leaves the existing cache (or bundled snapshot) in place for currentRegistry()
 * to keep serving. Real callers fire this without awaiting it (`void refreshRegistryIfStale(...)`);
 * it returns its promise only so tests can await the outcome deterministically. */
export function refreshRegistryIfStale(pluginsRoot: string): Promise<void> {
	const cached = readRegistryCache(pluginsRoot);
	const now = Date.now();
	if (cached && now - cached.fetchedAt < REGISTRY_TTL_MS) return Promise.resolve();
	const lastAttempt = lastAttemptByRoot.get(pluginsRoot) ?? 0;
	if (now - lastAttempt < REGISTRY_RETRY_MS) return Promise.resolve();
	lastAttemptByRoot.set(pluginsRoot, now);
	return fetch(registryUrl(), { signal: AbortSignal.timeout(5000) })
		.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`registry fetch failed: ${res.status}`))))
		.then((json) => {
			if (!isValidRegistryFile(json)) throw new Error("registry payload failed validation");
			writeRegistryCache(pluginsRoot, json, Date.now());
		})
		.catch(() => {
			/* best effort -- next stale check (after REGISTRY_RETRY_MS) retries */
		});
}
