#!/usr/bin/env node
// Copies the repo-root registry/plugins.json into dist/registry/plugins.json so it ships inside
// the published npm package (see registry.ts's BUNDLED_REGISTRY_PATH). A plain Node script rather
// than a shell `cp` so `npm run build` works identically on every platform contributors use.
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "registry", "plugins.json");
const destDir = join(here, "..", "dist", "registry");
const dest = join(destDir, "plugins.json");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
