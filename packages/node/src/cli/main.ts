#!/usr/bin/env node

import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs, printHelp, expandHome } from "./args.js";
import { isWalletCommand, parseWalletArgs, runWalletCommand } from "./wallet.js";
import { EnsoulNodeRunner } from "./node-runner.js";
import { PeerNetwork, parsePeerAddresses } from "../chain/peer-network.js";
import { runGenesisCommand, loadGenesisBlock } from "./genesis-cmd.js";
import { installService, uninstallService, checkServiceStatus } from "./service.js";
import { VERSION } from "../version.js";

/**
 * Main entry point for the ensoul-node CLI.
 */
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(printHelp());
		return;
	}

	// ── Service management flags (exit early) ────────────────────

	if (args.uninstall) {
		const result = await uninstallService();
		console.log(result.message);
		process.exit(result.ok ? 0 : 1);
	}

	if (args.mode === "status") {
		const result = checkServiceStatus();
		console.log(result.message);
		if (!result.ok || result.message.includes("not installed")) {
			console.log("\nValidator is not installed as a service. Use --install.");
		}
		return;
	}

	// ── Seed export/import (exit early) ──────────────────────────

	if (args.exportSeed) {
		await handleExportSeed(args.dataDir);
		return;
	}

	if (args.importSeed) {
		await handleImportSeed(args.importSeed, args.dataDir);
		return;
	}

	// Auto-update install
	if (args.autoUpdate) {
		await installAutoUpdate();
		return;
	}

	// Snapshot and rollback
	if (args.snapshot) {
		const { createSnapshot } = await import("../chain/snapshot.js");
		const dataDir = expandHome(args.dataDir);
		const snap = await createSnapshot(dataDir, 0, "manual");
		console.log(`[ensoul] Snapshot created: ${snap}`);
		return;
	}

	if (args.rollback) {
		const { rollbackToLatest } = await import("../chain/snapshot.js");
		const dataDir = expandHome(args.dataDir);
		const result = await rollbackToLatest(dataDir);
		if (result.restored) {
			console.log(`[ensoul] Rolled back to snapshot: ${result.snapshot}`);
			console.log(`[ensoul] Version: ${result.meta?.version}, Height: ${result.meta?.height}`);
		} else {
			console.log("[ensoul] No snapshots available to roll back to.");
		}
		return;
	}

	// Wallet commands: query RPC and exit (no node startup)
	if (isWalletCommand(process.argv.slice(2))) {
		const walletCmd = parseWalletArgs(process.argv.slice(2));
		await runWalletCommand(walletCmd);
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

	// ── Install as service (generates plist, exits) ──────────────

	if (args.install) {
		const result = await installService(args);
		console.log(result.message);
		process.exit(result.ok ? 0 : 1);
	}

	// ── Foreground mode warning ──────────────────────────────────

	console.log("╔═══════════════════════════════════════╗");
	console.log("║         ENSOUL NODE v0.1.0            ║");
	console.log("║   Sovereign L1 for Agent Consciousness ║");
	console.log("╚═══════════════════════════════════════╝");
	console.log();

	if (args.mode === "validate") {
		console.log("[ensoul] Running in foreground mode. Close this terminal and the validator stops.");
		console.log("[ensoul] Use --install for background mode.\n");
	}

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

	// Display seed prominently on first run (check if identity was just created)
	await displaySeedIfNew(args.dataDir);

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

	// Version check against peers
	if (peerNet) {
		await checkPeerVersions(peerNet, args.peers);
	}

	// Step 4: Start consensus engine (after sync is complete)
	if (args.mode === "validate") {
		const syncedHeight = runner.getStatus().chainHeight;
		console.log(`\n  Mode: VALIDATOR (Tendermint consensus) v${VERSION}`);
		console.log(`  Synced to height: ${syncedHeight}\n`);
		runner.startBlockLoop();

		// Wire consensus to peer network for message broadcasting
		const consensus = runner.getConsensus();
		if (consensus && peerNet) {
			consensus.onBroadcast = (msg) => {
				void peerNet!.broadcastConsensus(msg);
			};
			peerNet.onConsensusMessage = (msg) => {
				consensus.handleMessage(msg);
			};
			console.log(`  Consensus: Tendermint (threshold=${consensus.getThreshold()})`);
		}
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

// ── Seed management helpers ─────────────────────────────────────────

interface PersistedIdentity {
	seed?: string;
	publicKey: string;
	did: string;
	encrypted?: string;
	nonce?: string;
	salt?: string;
}

/**
 * Display seed on first run. Checks for a ".seed-shown" marker file.
 */
async function displaySeedIfNew(dataDir: string): Promise<void> {
	const dir = expandHome(dataDir);
	const markerPath = join(dir, ".seed-shown");
	const idPath = join(dir, "identity.json");

	try {
		await readFile(markerPath, "utf-8");
		return; // Already shown
	} catch {
		// Marker doesn't exist, this is a new identity
	}

	try {
		const raw = await readFile(idPath, "utf-8");
		const stored = JSON.parse(raw) as PersistedIdentity;

		if (stored.seed) {
			console.log("\n┌─────────────────────────────────────────────────────────────────────┐");
			console.log("│  SAVE YOUR VALIDATOR SEED                                           │");
			console.log("├─────────────────────────────────────────────────────────────────────┤");
			console.log(`│  ${stored.seed}  │`);
			console.log("├─────────────────────────────────────────────────────────────────────┤");
			console.log("│  Import this seed into your wallet at ensoul.dev/wallet.html        │");
			console.log("│  to manage your stake and rewards.                                  │");
			console.log("└─────────────────────────────────────────────────────────────────────┘\n");
		} else if (stored.encrypted) {
			console.log("\n[ensoul] Your validator seed is encrypted. Use --export-seed to display it.");
			console.log("[ensoul] Import the seed into your wallet at ensoul.dev/wallet.html to manage stake and rewards.\n");
		}

		// Write marker so we don't show this again
		await writeFile(markerPath, new Date().toISOString());
	} catch {
		// No identity file yet
	}
}

/**
 * Export seed from an existing identity file.
 */
async function handleExportSeed(dataDir: string): Promise<void> {
	const dir = expandHome(dataDir);
	const idPath = join(dir, "identity.json");

	try {
		const raw = await readFile(idPath, "utf-8");
		const stored = JSON.parse(raw) as PersistedIdentity;

		if (stored.seed) {
			console.log(`\n[ensoul] Your validator seed (SAVE THIS): ${stored.seed}`);
			console.log("[ensoul] Import this seed into your wallet at ensoul.dev/wallet.html to manage your stake and rewards.\n");
			return;
		}

		if (stored.encrypted && stored.nonce && stored.salt) {
			const password = process.env["ENSOUL_KEY_PASSWORD"] ?? "";
			if (!password) {
				console.error("[ensoul] Identity is encrypted. Set ENSOUL_KEY_PASSWORD to decrypt.");
				process.exit(1);
			}

			const { loadIdentity, hexToBytes } = await import("@ensoul/identity");
			const identity = await loadIdentity(
				{
					encrypted: hexToBytes(stored.encrypted),
					nonce: hexToBytes(stored.nonce),
					salt: hexToBytes(stored.salt),
				},
				password,
			);
			// The identity was loaded from encrypted storage. We cannot
			// extract the raw seed, only show the public key and DID.
			const idJson = identity.toJSON();
			console.log(`\n[ensoul] Your validator seed is encrypted. DID: ${idJson.did}`);
			console.log("[ensoul] Public key: " + idJson.publicKey);
			console.log("[ensoul] To use this identity in the wallet, import using the public key.\n");
			return;
		}

		console.error("[ensoul] No seed found in identity file.");
		process.exit(1);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[ensoul] Failed to read identity: ${msg}`);
		process.exit(1);
	}
}

/**
 * Import a seed to create a new identity.json.
 */
async function handleImportSeed(seedHex: string, dataDir: string): Promise<void> {
	if (seedHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(seedHex)) {
		console.error("[ensoul] Seed must be exactly 64 hex characters (32 bytes).");
		process.exit(1);
	}

	const dir = expandHome(dataDir);
	await mkdir(dir, { recursive: true });
	const idPath = join(dir, "identity.json");

	// Check if identity already exists
	try {
		await readFile(idPath, "utf-8");
		console.error(`[ensoul] Identity already exists at ${idPath}`);
		console.error("[ensoul] Remove it first if you want to import a new seed.");
		process.exit(1);
	} catch {
		// Good, no existing identity
	}

	const { createIdentity, hexToBytes, bytesToHex } = await import("@ensoul/identity");
	const seed = hexToBytes(seedHex);
	const identity = await createIdentity({ seed });
	const password = process.env["ENSOUL_KEY_PASSWORD"] ?? "";

	if (password) {
		const bundle = await identity.export(password);
		const persisted: PersistedIdentity = {
			publicKey: identity.toJSON().publicKey,
			did: identity.did,
			encrypted: bytesToHex(bundle.encrypted),
			nonce: bytesToHex(bundle.nonce),
			salt: bytesToHex(bundle.salt),
		};
		await writeFile(idPath, JSON.stringify(persisted, null, 2));
		console.log(`[ensoul] Imported identity (encrypted): ${identity.did}`);
	} else {
		const persisted: PersistedIdentity = {
			seed: seedHex,
			publicKey: identity.toJSON().publicKey,
			did: identity.did,
		};
		await writeFile(idPath, JSON.stringify(persisted, null, 2));
		console.log(`[ensoul] Imported identity: ${identity.did}`);
		console.log("[ensoul] WARNING: stored in plaintext. Set ENSOUL_KEY_PASSWORD to encrypt.");
	}

	console.log(`[ensoul] Saved to ${idPath}`);
	console.log("[ensoul] Your validator will use this identity on next start.");
}

// ── Version check ───────────────────────────────────────────────────

/**
 * Compare local version with connected peers. Warn if any peer is newer.
 */
async function checkPeerVersions(peerNet: PeerNetwork, _peerAddrs: string[]): Promise<void> {
	const peers = peerNet.getPeers();
	for (const peer of peers) {
		try {
			const resp = await fetch(`${peer.address}/peer/status`, { signal: AbortSignal.timeout(3000) });
			if (!resp.ok) continue;
			const status = (await resp.json()) as { version?: string };
			if (status.version && status.version !== VERSION && status.version > VERSION) {
				console.log(`\n[ensoul] WARNING: Peer ${peer.address} is running v${status.version} but you are on v${VERSION}.`);
				console.log("[ensoul] Run: cd ~/ensoul && git pull && pnpm build");
				console.log("[ensoul] Then restart your validators.\n");
			}
		} catch { /* peer unreachable */ }
	}
}

// ── Auto-update install ─────────────────────────────────────────────

/**
 * Install the auto-update launchd job.
 */
async function installAutoUpdate(): Promise<void> {
	const { homedir, platform } = await import("node:os");
	const { execSync } = await import("node:child_process");

	if (platform() !== "darwin") {
		console.error("[ensoul] Auto-update is only supported on macOS.");
		process.exit(1);
	}

	const home = homedir();
	const launchDir = join(home, "Library", "LaunchAgents");
	const logDir = join(home, ".ensoul");
	const scriptPath = join(process.cwd(), "scripts", "auto-update.sh");
	const plistPath = join(launchDir, "dev.ensoul.auto-update.plist");
	const logFile = join(logDir, "auto-update.log");

	await mkdir(launchDir, { recursive: true });
	await mkdir(logDir, { recursive: true });

	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ensoul.auto-update</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${scriptPath}</string>
  </array>

  <key>StartInterval</key>
  <integer>900</integer>

  <key>StandardOutPath</key>
  <string>${logFile}</string>

  <key>StandardErrorPath</key>
  <string>${logFile}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

	// Unload existing
	try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null`, { stdio: "ignore" }); } catch { /* ok */ }

	await writeFile(plistPath, plist);
	execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: "ignore" });

	console.log("[ensoul] Auto-update installed. Your validator will check for updates every 15 minutes and restart automatically if needed.");
	console.log(`[ensoul] Plist: ${plistPath}`);
	console.log(`[ensoul] Log: ${logFile}`);
	console.log(`[ensoul] Script: ${scriptPath}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
