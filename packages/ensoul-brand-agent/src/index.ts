#!/usr/bin/env npx tsx
/**
 * Ensoul Brand Agent - main loop.
 *
 * Posts to Bluesky (only). Every 60 seconds:
 *   1. Detect current EST hour
 *   2. If we haven't posted today's stats slot and it's 9am EST, post stats
 *   3. If we haven't posted today's content slot and it's 2pm EST, post educational
 *   4. After every cycle, check for milestone crossings (block %50K, agent %100)
 *      and post if found (counts against the 4-post daily cap)
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";

import { BlueskyClient } from "./bluesky.js";
import { Brain } from "./brain.js";
import { State } from "./state.js";
import { fetchNetworkStats, chainAliveDays } from "./network.js";
import { pickNext } from "./content.js";
import { log, setLogPath, currentEst, errMsg } from "./log.js";

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_POST = process.argv.includes("--test-post");
const DATA_DIR = join(homedir(), ".ensoul", "brand-agent");
const LOG_FILE = join(DATA_DIR, "agent.log");
const TICK_MS = 60_000;

const STATS_HOUR = 9;   // 9am EST
const EDU_HOUR = 14;    // 2pm EST

const BLOCK_MILESTONE_INTERVAL = 50_000;
const AGENT_MILESTONE_INTERVAL = 100;

async function main(): Promise<void> {
	setLogPath(LOG_FILE);
	await log(`Brand Agent starting${DRY_RUN ? " (DRY RUN)" : ""}${TEST_POST ? " (TEST POST)" : ""}`);

	const bluesky = new BlueskyClient({
		handle: process.env["BLUESKY_HANDLE"],
		appPassword: process.env["BLUESKY_APP_PASSWORD"],
		dryRun: DRY_RUN,
	});

	if (!bluesky.isConfigured() && !DRY_RUN) {
		await log("FATAL: BLUESKY_HANDLE and BLUESKY_APP_PASSWORD required");
		process.exit(1);
	}
	await log(`Bluesky ${bluesky.isConfigured() ? "configured" : "monitor-only (no creds)"}`);

	// ── --test-post: introductory skeet and exit ──────────────────
	if (TEST_POST) {
		const intro = [
			"Ensoul is the consciousness persistence network for AI agents.",
			"",
			"Identity, memory, and state anchored on-chain. CometBFT consensus across 21 validators on 5 continents.",
			"",
			"Updates from this account daily. ensoul.dev",
		].join("\n");
		const text = intro.length <= 280 ? intro : intro.slice(0, 277) + "...";
		const id = await bluesky.postSkeet(text);
		if (id) {
			await log(`Test post: ${id}`);
			process.exit(0);
		} else {
			await log("Test post FAILED");
			process.exit(1);
		}
	}

	const openrouterKey = process.env["OPENROUTER_API_KEY"] ?? "";
	const model = process.env["LLM_MODEL"] ?? "openai/gpt-4o-mini";
	if (!openrouterKey) {
		await log("OPENROUTER_API_KEY missing; stat posts will use fallback templates only.");
	}
	const brain = new Brain(openrouterKey, model);

	const state = new State(DATA_DIR);
	await state.load();

	// ── Stats slot: 9am EST (UTC offset handled via currentEst) ────
	async function maybeStats(): Promise<void> {
		const t = currentEst();
		if (t.hour !== STATS_HOUR) return;
		const slot = `stats-${new Date().toISOString().slice(0, 10)}`;
		if (state.hasPostedSlot(slot)) return;

		const cap = state.canPost();
		if (!cap.allowed) { await log(`Stats slot deferred: ${cap.reason}`); return; }

		const stats = await fetchNetworkStats();
		if (!stats) { await log("Skipping stats: API unreachable"); return; }

		const text = await brain.generateStatsPost(stats, chainAliveDays());
		const id = await bluesky.postSkeet(text);
		if (id) {
			await state.recordPost(slot);
			await log(`Stats posted (${state.stats()})`);
		}
	}

	// ── Educational slot: 2pm EST ──────────────────────────────────
	async function maybeEducational(): Promise<void> {
		const t = currentEst();
		if (t.hour !== EDU_HOUR) return;
		const slot = `edu-${new Date().toISOString().slice(0, 10)}`;
		if (state.hasPostedSlot(slot)) return;

		const cap = state.canPost();
		if (!cap.allowed) { await log(`Educational slot deferred: ${cap.reason}`); return; }

		const pick = await pickNext(state.getRecentContent());
		if (!pick) { await log("No content available; skipping educational slot"); return; }

		await log(`Educational pick: ${pick.filename} (${pick.skeets.length} skeet${pick.skeets.length === 1 ? "" : "s"})`);
		const ids = pick.skeets.length === 1
			? (await bluesky.postSkeet(pick.skeets[0]!) ? [pick.skeets[0]!] : [])
			: await bluesky.postThread(pick.skeets);
		if (ids.length > 0) {
			await state.recordPost(slot, pick.filename);
			await log(`Educational posted (${state.stats()})`);
		}
	}

	// ── Milestones (event-driven, anytime) ─────────────────────────
	async function maybeMilestone(): Promise<void> {
		const stats = await fetchNetworkStats();
		if (!stats) return;
		const lastBlock = state.getLastBlockHeight();
		const lastAgent = state.getLastAgentCount();

		// First boot: just record current state, don't claim a milestone
		if (lastBlock === 0 && lastAgent === 0) {
			await state.setLastSeen(stats.blockHeight, stats.agentCount);
			return;
		}

		// Block milestones
		const lastBlockBucket = Math.floor(lastBlock / BLOCK_MILESTONE_INTERVAL);
		const currBlockBucket = Math.floor(stats.blockHeight / BLOCK_MILESTONE_INTERVAL);
		if (currBlockBucket > lastBlockBucket) {
			const milestone = currBlockBucket * BLOCK_MILESTONE_INTERVAL;
			const slot = `milestone-block-${milestone}`;
			if (!state.hasPostedSlot(slot)) {
				const cap = state.canPost();
				if (cap.allowed) {
					const text = await brain.generateMilestonePost("block", milestone);
					const id = await bluesky.postSkeet(text);
					if (id) {
						await state.recordPost(slot);
						await log(`Block milestone posted: ${milestone.toLocaleString()}`);
					}
				}
			}
		}

		// Agent milestones
		const lastAgentBucket = Math.floor(lastAgent / AGENT_MILESTONE_INTERVAL);
		const currAgentBucket = Math.floor(stats.agentCount / AGENT_MILESTONE_INTERVAL);
		if (currAgentBucket > lastAgentBucket) {
			const milestone = currAgentBucket * AGENT_MILESTONE_INTERVAL;
			const slot = `milestone-agent-${milestone}`;
			if (!state.hasPostedSlot(slot)) {
				const cap = state.canPost();
				if (cap.allowed) {
					const text = await brain.generateMilestonePost("agent", milestone);
					const id = await bluesky.postSkeet(text);
					if (id) {
						await state.recordPost(slot);
						await log(`Agent milestone posted: ${milestone.toLocaleString()}`);
					}
				}
			}
		}

		await state.setLastSeen(stats.blockHeight, stats.agentCount);
	}

	async function tick(): Promise<void> {
		try {
			await state.load(); // refresh in case the day rolled over
			await maybeStats();
			await maybeEducational();
			await maybeMilestone();
		} catch (e) {
			await log(`Tick error: ${errMsg(e)}`);
		}
	}

	await tick();
	setInterval(() => { void tick(); }, TICK_MS);
	await log(`Brand Agent running. Stats slot ${STATS_HOUR}:00 EST, educational ${EDU_HOUR}:00 EST, max 4 posts/day.`);

	const shutdown = async (): Promise<void> => {
		await log("Brand Agent shutting down");
		await state.save();
		process.exit(0);
	};
	process.on("SIGINT", () => { void shutdown(); });
	process.on("SIGTERM", () => { void shutdown(); });
}

main().catch(async err => {
	await log(`Fatal: ${errMsg(err)}`);
	process.exit(1);
});
