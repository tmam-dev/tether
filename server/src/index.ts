#!/usr/bin/env node
/**
 * Tether — local, self-hosted agent-harness observability.
 * Accepts the OTLP traces trailai-mcp sends and stores them in embedded
 * SQLite. No auth, no network exposure -- binds 127.0.0.1 only.
 */

import { join } from "node:path";
import { openDatabase, resolveDataDir } from "./db.js";
import { createTetherServer } from "./server.js";
import { runPluginCommand } from "./cli/plugin-commands.js";
import { listInstalledPlugins, pluginsDir, TETHER_API_VERSION } from "./plugins.js";

/** Spec §3.3: a plugin whose `tetherApiVersion` doesn't match this server's stays installed on disk
 * but is skipped, "with a startup log line naming the plugin and the mismatch" -- otherwise it just
 * never appears in its slot's picker with no explanation anywhere. */
function warnAboutIncompatiblePlugins(pluginsRoot: string): void {
	for (const plugin of listInstalledPlugins(pluginsRoot)) {
		if (plugin.compatible) continue;
		console.warn(
			`Skipping plugin "${plugin.name}" (${plugin.slug}): targets Tether plugin API ` +
				`v${plugin.tetherApiVersion}, this server runs v${TETHER_API_VERSION}.`
		);
	}
}

process.on("unhandledRejection", (err) => {
	console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
	console.error("Uncaught exception:", err);
});

async function main(): Promise<void> {
	if (process.argv[2] === "plugin") {
		const code = await runPluginCommand(process.argv.slice(3), resolveDataDir());
		process.exit(code);
	}

	const DEFAULT_PORT = 4319;
	const port = Number(process.env.TETHER_PORT ?? DEFAULT_PORT);
	const dbPath = join(resolveDataDir(), "tether.sqlite");

	const db = openDatabase(dbPath);
	const pluginsRoot = pluginsDir(resolveDataDir());
	warnAboutIncompatiblePlugins(pluginsRoot);
	const server = createTetherServer(db, { pluginsRoot });

	server.listen(port, "127.0.0.1", () => {
		console.log(`trailai-tether ready at http://localhost:${port} (data: ${dbPath})`);
	});
}

main();
