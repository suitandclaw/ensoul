#!/usr/bin/env node

import { join } from "node:path";
import { parseArgs, printHelp, expandHome } from "./args.js";
import { isWalletCommand, parseWalletArgs, runWalletCommand } from "./wallet.js";
import { EnsoulNodeRunner } from "./node-runner.js";
import { PeerNetwork, parsePeerAddresses } from "../chain/peer-network.js";
import { runGenesisCommand, loadGenesisBlock } from "./genesis-cmd.js";

/**
 * Main entry point for the ensoul-node CLI.
 */
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(printHelp());
		return;
	}

	// Wallet commands: query RPC and exit (no node startup)
	if (isWalletCommand(process.argv.slice(2))) {
		const walletCmd = parseWalletArgs(process.argv.slice(2));
		await runWalletCommand(walletCmd);
		return;
	}

	if (args.mode === "status") {
		// TODO: Read status from running node via API
		console.log("Status mode: connect to running node API at localhost:3000/status");
		return;
	}

	if (args.mode === "genesis") {
		if (!args.genesisConfig) {
			console.error("Error: --config is required for genesis subcommand");
			process.exit(1);
		}
		const output = args.genesisOutput || join(expandHome(args.dataDir), "genesis.json");
		await runGenesisCommand(args.genesisConfig, output);
		return;
	}

	console.log("╔═══════════════════════════════════════╗");
	console.log("║         ENSOUL NODE v0.1.0            ║");
	console.log("║   Sovereign L1 for Agent Consciousness ║");
	console.log("╚═══════════════════════════════════════╝");
	console.log();

	const chainConfig = args.noMinStake ? { minimumStake: 0n } : {};

	// Load genesis config from file if --genesis is provided
	let genesisConfig = undefined;
	if (args.genesisFile) {
		const loaded = await loadGenesisBlock(args.genesisFile);
		genesisConfig = loaded.config;
		console.log(`[ensoul] Loaded genesis from ${args.genesisFile} (${loaded.block.transactions.length} allocations)`);
	}

	const runner = new EnsoulNodeRunner(args, genesisConfig, chainConfig);
	runner.onLog = (msg) => console.log(`[ensoul] ${msg}`);

	if (args.noMinStake) {
		console.log("[ensoul] WARNING: minimum stake disabled. Blocks can be produced without stake.");
	}

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

		// Register with seed node for automatic peer discovery (if configured)
		if (args.seed) {
			const publicUrl = args.publicUrl || `http://localhost:${args.port}`;
			const seedConnected = await peerNet.registerWithSeed(args.seed, publicUrl);
			console.log(`  Seed: ${args.seed}`);
			console.log(`  Public URL: ${publicUrl}`);
			console.log(`  Peers via seed: ${seedConnected}\n`);
		}
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
