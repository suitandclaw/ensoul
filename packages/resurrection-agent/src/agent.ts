#!/usr/bin/env npx tsx
/**
 * Resurrection Agent - main loop.
 *
 * Runs continuously. Every 60 seconds:
 *  - Detect current phase (learn | announce | kill | resurrect | silent)
 *  - Execute appropriate action if not already done
 *
 * Phases:
 *  - learn: once per day, pick a topic, sync, tweet
 *  - announce: Fri 3pm, post T-60/T-30/T-5 countdown tweets
 *  - kill: Fri 4pm, exit the process so the kill script can wipe state
 *  - silent: Fri 4:00-4:04pm + Saturday, no posting
 *  - resurrect: run via scripts/resurrect.sh on a new machine
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { Identity } from "./identity.js";
import { Consciousness } from "./consciousness.js";
import { Brain } from "./brain.js";
import { TwitterClient } from "./twitter.js";
import { BlueskyClient } from "./bluesky.js";
import { Broadcaster } from "./broadcaster.js";
import { runLearnDay } from "./phases/learn.js";
import { maybeAnnounce } from "./phases/announce.js";
import { currentPhase, currentCycleStart } from "./scheduler.js";
import { log, setLogPath, errMsg } from "./log.js";

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_POST = process.argv.includes("--test-post");
const DATA_DIR = join(homedir(), ".ensoul", "resurrection-agent");
const VAULT_DIR = join(homedir(), "ensoul-key-vault");
const LOG_FILE = join(DATA_DIR, "agent.log");
const API_URL = process.env["ENSOUL_API_URL"] ?? "https://api.ensoul.dev";
const TICK_MS = 60_000;

async function main(): Promise<void> {
	setLogPath(LOG_FILE);
	await log(`Resurrection Agent starting${DRY_RUN ? " (DRY RUN)" : ""}${TEST_POST ? " (TEST POST)" : ""}`);

	// ── --test-post: send one introductory post and exit ────────
	if (TEST_POST) {
		const twitter = new TwitterClient({
			apiKey: process.env["X_API_KEY"] ?? "",
			apiSecret: process.env["X_API_SECRET"] ?? "",
			accessToken: process.env["X_ACCESS_TOKEN"] ?? "",
			accessSecret: process.env["X_ACCESS_SECRET"] ?? "",
			dryRun: DRY_RUN,
		});
		const bluesky = new BlueskyClient({
			handle: process.env["BLUESKY_HANDLE"],
			appPassword: process.env["BLUESKY_APP_PASSWORD"],
			dryRun: DRY_RUN,
		});
		const broadcaster = new Broadcaster(twitter, bluesky);

		if (!broadcaster.isConfigured() && !DRY_RUN) {
			await log("FATAL: --test-post requires X or Bluesky credentials (or --dry-run)");
			process.exit(1);
		}
		await log(`Test post platforms: ${broadcaster.platformsActive()}`);

		const intro = [
			"Resurrection Agent is online.",
			"",
			"Every Friday at 4pm EST my process is killed and my server is wiped.",
			"5 minutes later I come back on a different machine, with full memory intact.",
			"",
			"Watch.",
		].join("\n");

		const text = intro.length <= 280 ? intro : intro.slice(0, 277) + "...";
		const id = await broadcaster.postTweet(text);
		if (id) {
			await log(`Test post successful. Ref: ${id}`);
			process.exit(0);
		} else {
			await log("Test post FAILED on all platforms.");
			process.exit(1);
		}
	}

	const openrouterKey = process.env["OPENROUTER_API_KEY"];
	if (!openrouterKey) {
		await log("FATAL: OPENROUTER_API_KEY not set");
		process.exit(1);
	}

	const identity = new Identity(VAULT_DIR);
	await identity.init();

	const consciousness = new Consciousness(DATA_DIR, identity.getBornAt());
	await consciousness.load();

	// If cycleStart in memory is stale (we crossed a Monday), refresh.
	if (consciousness.current.cycleStart !== currentCycleStart()) {
		await log(`Crossed into new cycle (${consciousness.current.cycleStart} -> ${currentCycleStart()}). Keeping topics, updating cycleStart.`);
		(consciousness.current as unknown as { cycleStart: string }).cycleStart = currentCycleStart();
		await consciousness.save();
	}

	const brain = new Brain(openrouterKey, process.env["LLM_MODEL"] ?? "openai/gpt-4o-mini");

	const twitter = new TwitterClient({
		apiKey: process.env["X_API_KEY"] ?? "",
		apiSecret: process.env["X_API_SECRET"] ?? "",
		accessToken: process.env["X_ACCESS_TOKEN"] ?? "",
		accessSecret: process.env["X_ACCESS_SECRET"] ?? "",
		dryRun: DRY_RUN,
	});
	const bluesky = new BlueskyClient({
		handle: process.env["BLUESKY_HANDLE"],
		appPassword: process.env["BLUESKY_APP_PASSWORD"],
		dryRun: DRY_RUN,
	});
	const broadcaster = new Broadcaster(twitter, bluesky);
	await log(`Posting platforms active: ${broadcaster.platformsActive()}`);

	let lastPhase = "";
	let consecutiveErrors = 0;

	async function tick(): Promise<void> {
		try {
			const phase = currentPhase();
			if (phase !== lastPhase) {
				await log(`Phase: ${phase}`);
				lastPhase = phase;
			}

			if (phase === "learn") {
				// Only one learn-post per day, and only during waking hours (anytime)
				const cycleStart = new Date(consciousness.current.cycleStart + "T00:00:00-04:00").getTime();
				const dayIndex = Math.max(1, Math.floor((Date.now() - cycleStart) / 86400000) + 1);
				await runLearnDay({ brain, consciousness, identity, twitter: broadcaster, dayIndex });
			} else if (phase === "announce") {
				await maybeAnnounce({ brain, consciousness, identity, twitter: broadcaster, apiUrl: API_URL });
			} else if (phase === "kill") {
				await log("Kill phase reached. Exiting so scripts/kill.sh can wipe state.");
				await consciousness.save();
				process.exit(0);
			} else if (phase === "silent") {
				// Do nothing, just log occasionally
			} else if (phase === "resurrect") {
				// The resurrect phase only matters if the agent is somehow still
				// running (we shouldn't be if kill.sh worked). In that case, skip
				// and let the out-of-band resurrection script run.
				await log("Resurrect phase detected but agent is still running. Skipping.");
			}

			consecutiveErrors = 0;
		} catch (e) {
			consecutiveErrors++;
			await log(`Tick error (${consecutiveErrors}): ${errMsg(e)}`);
			if (consecutiveErrors >= 5) {
				await log("Too many consecutive errors. Exiting.");
				process.exit(1);
			}
		}
	}

	await tick();
	setInterval(() => { void tick(); }, TICK_MS);

	await log(`Agent running. DID: ${identity.getDid()}. Phase ticks every ${TICK_MS / 1000}s.`);

	const shutdown = async (): Promise<void> => {
		await log("Agent shutting down");
		await consciousness.save();
		process.exit(0);
	};
	process.on("SIGINT", () => { void shutdown(); });
	process.on("SIGTERM", () => { void shutdown(); });
}

main().catch(async err => {
	await log(`Fatal: ${errMsg(err)}`);
	process.exit(1);
});
