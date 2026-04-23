/**
 * Ensoul ABCI 2.0 Server -- Entry Point
 *
 * Starts a Tendermint Socket Protocol (TSP) server that CometBFT
 * connects to for consensus. CometBFT handles P2P, gossip, voting,
 * block storage. This server handles application logic only.
 *
 * Usage:
 *   npx tsx packages/abci-server/src/index.ts [--port 26658]
 */

import { loadProto, startTSPServer } from "./tsp.js";
import { createApplication } from "./application.js";
import { startHealer, stopHealer } from "./self-heal.js";

async function main(): Promise<void> {
	const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 26658);

	process.stdout.write("\n");
	process.stdout.write("  ENSOUL ABCI 2.0 SERVER\n");
	process.stdout.write("  CometBFT Application Interface\n");
	process.stdout.write("\n");

	// Load protobuf definitions
	process.stdout.write("[abci] Loading protobuf definitions...\n");
	await loadProto();
	process.stdout.write("[abci] Protobuf loaded\n");

	// Create application with persistent state directory
	const home = process.env["HOME"] ?? "/tmp";
	const dataDir = process.argv.find((_, i, a) => a[i - 1] === "--data-dir")
		?? `${home}/.cometbft-ensoul/abci-state`;
	const app = createApplication(dataDir);
	process.stdout.write(`[abci] Application created (state: ${dataDir})\n`);

	// Start self-heal watchdog (checks service files hourly, Linux only)
	startHealer();

	// Start TSP server
	const server = startTSPServer(port, app.handler);
	process.stdout.write(`[abci] Waiting for CometBFT on port ${port}...\n`);

	// Handle shutdown
	const shutdown = (): void => {
		process.stdout.write("\n[abci] Shutting down...\n");
		stopHealer();
		server.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
