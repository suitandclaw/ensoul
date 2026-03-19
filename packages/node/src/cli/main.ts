#!/usr/bin/env node

import { parseArgs, printHelp } from "./args.js";
import { EnsoulNodeRunner } from "./node-runner.js";
import { PeerNetwork, parsePeerAddresses } from "../chain/peer-network.js";

/**
 * Main entry point for the ensoul-node CLI.
 */
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(printHelp());
		return;
	}

	if (args.mode === "status") {
		// TODO: Read status from running node via API
		console.log("Status mode: connect to running node API at localhost:3000/status");
		return;
	}

	console.log("╔═══════════════════════════════════════╗");
	console.log("║         ENSOUL NODE v0.1.0            ║");
	console.log("║   Sovereign L1 for Agent Consciousness ║");
	console.log("╚═══════════════════════════════════════╝");
	console.log();

	const runner = new EnsoulNodeRunner(args);
	runner.onLog = (msg) => console.log(`[ensoul] ${msg}`);

	// Step 1: Identity
	const identity = await runner.initIdentity();
	console.log(`\n  Your DID: ${identity.did}\n`);

	// Step 2: Initialize chain
	const validatorDids =
		args.mode === "validate" ? [identity.did] : [];
	runner.initChain(validatorDids);

	// Step 3: Peer networking
	let peerNet: PeerNetwork | null = null;

	const gossip = runner.getGossip();
	if (gossip) {
		const peerLog = (msg: string): void => {
			console.log(`[peers] ${msg}`);
		};

		peerNet = new PeerNetwork(gossip, identity.did, peerLog);
		await peerNet.startServer(args.port);

		if (args.peers.length > 0) {
			// Direct peer connections (--peers flag)
			const addresses = parsePeerAddresses(args.peers.join(","));
			const connected = await peerNet.connectToPeers(addresses);
			console.log(`\n  Peers: ${connected}/${addresses.length} connected`);
		}

		// Register with seed node for automatic peer discovery
		const publicUrl = args.publicUrl || `http://localhost:${args.port}`;
		const seedConnected = await peerNet.registerWithSeed(args.seed, publicUrl);
		console.log(`  Seed: ${args.seed}`);
		console.log(`  Public URL: ${publicUrl}`);
		console.log(`  Peers via seed: ${seedConnected}\n`);
	} else {
		await runner.syncFromPeers();
	}

	// Step 4: Start block loop
	if (args.mode === "validate") {
		console.log("\n  Mode: VALIDATOR (producing blocks)\n");
		runner.startBlockLoop();
	} else {
		console.log("\n  Mode: FULL NODE (syncing only)\n");
	}

	// Print periodic status
	const statusInterval = setInterval(() => {
		const status = runner.getStatus();
		const peerCount = peerNet?.getPeerCount() ?? status.peersConnected;
		console.log(
			`[status] height=${status.chainHeight} blocks=${status.blocksProduced} peers=${peerCount}`,
		);
	}, 30000);

	// Handle shutdown
	const shutdown = (): void => {
		console.log("\n[ensoul] Shutting down...");
		runner.stopBlockLoop();
		clearInterval(statusInterval);
		if (peerNet) void peerNet.stop();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
