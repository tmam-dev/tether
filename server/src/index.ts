#!/usr/bin/env node
/**
 * Tether — local, self-hosted agent-harness observability.
 * Accepts the OTLP traces trailai-mcp sends and stores them in embedded
 * SQLite. No auth, no network exposure -- binds 127.0.0.1 only.
 */

import { join } from "node:path";
import { openDatabase, resolveDataDir } from "./db.js";
import { createTetherServer } from "./server.js";
import { pluginsDir } from "./plugins.js";

process.on("unhandledRejection", (err) => {
	console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
	console.error("Uncaught exception:", err);
});

const DEFAULT_PORT = 4319;
const port = Number(process.env.TETHER_PORT ?? DEFAULT_PORT);
const dbPath = join(resolveDataDir(), "tether.sqlite");

const db = openDatabase(dbPath);
const server = createTetherServer(db, { pluginsRoot: pluginsDir(resolveDataDir()) });

server.listen(port, "127.0.0.1", () => {
	console.log(`trailai-tether ready at http://localhost:${port} (data: ${dbPath})`);
});
