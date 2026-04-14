#!/usr/bin/env npx tsx
/**
 * Resurrection entrypoint. Run this ONCE on a fresh machine after kill.
 *
 * Flow:
 *  1. Load seed from vault (~/ensoul-key-vault/resurrection-agent-seed.json).
 *     This is the ONLY thing that survives the kill.
 *  2. Connect to Ensoul chain using the seed.
 *  3. Query on-chain state, verify continuity.
 *  4. Start new cycle in consciousness (increments resurrectionCount).
 *  5. Post resurrection thread to X with proof.
 *  6. Exit. The regular agent.ts loop takes over on next cron tick.
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { Identity } from "../identity.js";
import { Consciousness } from "../consciousness.js";
import { Brain } from "../brain.js";
import { TwitterClient } from "../twitter.js";
import { log, setLogPath, getHostname, errMsg } from "../log.js";

const DRY_RUN = process.argv.includes("--dry-run");
const DATA_DIR = join(homedir(), ".ensoul", "resurrection-agent");
const VAULT_DIR = join(homedir(), "ensoul-key-vault");
const LOG_FILE = join(DATA_DIR, "resurrection.log");
const API_URL = process.env["ENSOUL_API_URL"] ?? "https://api.ensoul.dev";
const EXPLORER_BASE = process.env["ENSOUL_EXPLORER"] ?? "https://explorer.ensoul.dev";

async function main(): Promise<void> {
	setLogPath(LOG_FILE);
	const newHost = getHostname();
	await log(`Resurrection starting on ${newHost}${DRY_RUN ? " (DRY RUN)" : ""}`);

	// 1. Load seed from vault
	const identity = new Identity(VAULT_DIR);
	await identity.init();
	await log(`DID: ${identity.getDid()}`);

	const prevPointer = identity.getLastOnChain();
	if (!prevPointer) {
		await log("No prior on-chain pointer. This is a first boot, not a resurrection.");
		return;
	}

	const oldHost = "previous host"; // we lost this info when we wiped consciousness
	await log(`Last known: v${prevPointer.version}, block ${prevPointer.blockHeight}, synced ${prevPointer.syncedAt}`);

	const prevSyncMs = new Date(prevPointer.syncedAt).getTime();
	const downMinutes = Math.max(1, Math.round((Date.now() - prevSyncMs) / 60000));

	// 2. Load or start consciousness (local file should NOT exist post-kill)
	const consciousness = new Consciousness(DATA_DIR, identity.getBornAt());
	const hadLocal = await consciousness.load();
	if (hadLocal) {
		await log("WARNING: local consciousness survived the kill. True resurrection wipes local state.");
	}

	// 3. Recover from chain
	const recovered = await consciousness.recoverFromChain(identity, API_URL);
	if (!recovered) {
		await log("Recovery failed. Aborting resurrection thread.");
		return;
	}

	// 4. Compute proof data
	const bornAt = identity.getBornAt();
	const ageDays = Math.floor((Date.now() - new Date(bornAt).getTime()) / 86400000);

	let validatorCount = 21;
	try {
		const res = await fetch(`${API_URL}/v1/network/status`);
		if (res.ok) {
			const d = await res.json() as { validatorCount?: number };
			validatorCount = d.validatorCount ?? 21;
		}
	} catch { /* non-fatal */ }

	// 5. Capture topics learned in the prior cycle BEFORE resetting.
	// After a real kill, local consciousness is wiped, so we fall back
	// to the vault's cached narrative snapshot.
	let priorTopics = [...consciousness.current.topics];
	if (priorTopics.length === 0) {
		const cached = identity.getCachedTopicTitles();
		priorTopics = cached.map(title => ({
			day: "", title, summary: "", sources: [], timestamp: 0,
		}));
		await log(`Using ${cached.length} cached topic titles from vault for narrative`);
	}

	// 6. Start the new cycle. Seed resurrectionCount from vault cache in
	// case local state was wiped and we started fresh.
	const cachedCount = identity.getCachedResurrectionCount();
	if (consciousness.current.resurrectionCount < cachedCount) {
		(consciousness.current as unknown as { resurrectionCount: number }).resurrectionCount = cachedCount;
	}
	consciousness.startNewCycle();
	await consciousness.save();

	// 7. Post resurrection thread
	const openrouterKey = process.env["OPENROUTER_API_KEY"];
	if (!openrouterKey) {
		await log("OPENROUTER_API_KEY missing, skipping thread generation.");
		return;
	}
	const brain = new Brain(openrouterKey, process.env["LLM_MODEL"] ?? "openai/gpt-4o-mini");

	const twitter = new TwitterClient({
		apiKey: process.env["X_API_KEY"] ?? "",
		apiSecret: process.env["X_API_SECRET"] ?? "",
		accessToken: process.env["X_ACCESS_TOKEN"] ?? "",
		accessSecret: process.env["X_ACCESS_SECRET"] ?? "",
		dryRun: DRY_RUN,
	});

	const explorerUrl = `${EXPLORER_BASE}/agent/${encodeURIComponent(identity.getDid())}`;

	const thread = await brain.generateResurrectionThread({
		resurrectionCount: consciousness.current.resurrectionCount,
		downMinutes,
		newHost,
		oldHost,
		consciousnessAgeDays: ageDays,
		version: prevPointer.version,
		blockHeight: prevPointer.blockHeight,
		stateRoot: prevPointer.stateRoot,
		validatorCount,
		topicsRecalled: priorTopics,
		explorerUrl,
	});

	if (thread.length === 0) {
		await log("No thread generated. Post manually from logs.");
		return;
	}

	const ids = await twitter.postThread(thread);
	if (ids.length > 0) {
		for (let i = 0; i < ids.length; i++) {
			consciousness.recordPost(ids[i]!, thread[i] ?? "", `resurrect-${i}`);
		}
		await consciousness.save();
		await log(`Posted resurrection thread head tweet: ${ids[0]}`);
		await log("Remember to PIN the first tweet manually.");
	}

	await log("Resurrection complete.");
}

main().catch(async err => {
	await log(`Fatal in resurrection: ${errMsg(err)}`);
	process.exit(1);
});
