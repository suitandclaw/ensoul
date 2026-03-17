#!/usr/bin/env node

import { createIdentity, hexToBytes } from "@ensoul/identity";
import { EnsoulNodeRunner, parseArgs } from "@ensoul/node";
import type { WorkerMessage, WorkerStartMessage } from "./types.js";
import { deserializeGenesis } from "./types.js";

/**
 * Validator worker process.
 * Spawned by the ProcessManager via child_process.fork().
 * Receives configuration via IPC, runs an EnsoulNodeRunner.
 */
async function main(): Promise<void> {
	const config = await waitForStartMessage();

	// Recreate identity from saved seed
	const seedBytes = hexToBytes(config.seed);
	const identity = await createIdentity({ seed: seedBytes });

	// Build CLI args for the node runner
	const args = parseArgs([
		"--validate",
		"--data-dir",
		config.dataDir,
		"--port",
		String(config.port),
		"--api-port",
		String(config.apiPort),
		"--bootstrap",
		config.bootstrapPeer,
	]);

	// Deserialize genesis and create runner
	const genesis = deserializeGenesis(config.genesis);
	const runner = new EnsoulNodeRunner(args, genesis);

	runner.setIdentity(identity);
	runner.initChain(config.validatorDids);

	// Sync from bootstrap peer
	await runner.syncFromPeers();

	// Start block production
	runner.startBlockLoop();

	// Notify parent process that we're ready
	sendMessage({ type: "ready", did: identity.did });

	// Report status periodically
	const statusInterval = setInterval(() => {
		const status = runner.getStatus();
		sendMessage({
			type: "status",
			chainHeight: status.chainHeight,
			blocksProduced: status.blocksProduced,
		});
	}, 5000);

	// Graceful shutdown on signals
	const shutdown = (): void => {
		clearInterval(statusInterval);
		runner.stopBlockLoop();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

/**
 * Wait for the start message from the parent process via IPC.
 */
function waitForStartMessage(): Promise<WorkerStartMessage> {
	return new Promise((resolve) => {
		const handler = (msg: unknown): void => {
			process.removeListener("message", handler);
			resolve(msg as WorkerStartMessage);
		};
		process.on("message", handler);
	});
}

/**
 * Send a message to the parent process via IPC.
 */
function sendMessage(msg: WorkerMessage): void {
	if (process.send) {
		process.send(msg);
	}
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[worker] Fatal: ${message}\n`);
	process.exit(1);
});
