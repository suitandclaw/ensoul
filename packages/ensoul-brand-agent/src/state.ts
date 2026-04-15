/**
 * Persistent state for the brand agent.
 *
 * Tracks:
 *   - Posts per day (rate cap)
 *   - Slot tags posted today (so we don't post stats twice)
 *   - Recently used content filenames (so we rotate)
 *   - Last seen block height + agent count (for milestone detection)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { log, errMsg } from "./log.js";

interface AgentState {
	dateUtc: string;
	postsToday: number;
	slotsPostedToday: string[]; // e.g. ["stats-morning", "edu-afternoon"]
	recentContent: string[];     // most-recent first, capped at 10
	lastBlockHeight: number;
	lastAgentCount: number;
}

const MAX_POSTS_PER_DAY = 4;
const RECENT_CONTENT_WINDOW = 10;

export class State {
	private file: string;
	private state: AgentState;

	constructor(dataDir: string) {
		this.file = join(dataDir, "state.json");
		this.state = this.fresh();
	}

	private fresh(): AgentState {
		return {
			dateUtc: new Date().toISOString().slice(0, 10),
			postsToday: 0,
			slotsPostedToday: [],
			recentContent: [],
			lastBlockHeight: 0,
			lastAgentCount: 0,
		};
	}

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.file, "utf-8");
			const loaded = JSON.parse(raw) as AgentState;
			const today = new Date().toISOString().slice(0, 10);
			if (loaded.dateUtc !== today) {
				// New day: reset daily counters but keep recent content + last seen
				this.state = {
					dateUtc: today,
					postsToday: 0,
					slotsPostedToday: [],
					recentContent: loaded.recentContent ?? [],
					lastBlockHeight: loaded.lastBlockHeight ?? 0,
					lastAgentCount: loaded.lastAgentCount ?? 0,
				};
				await this.save();
			} else {
				this.state = loaded;
			}
		} catch { /* first run */ }
	}

	async save(): Promise<void> {
		try {
			await mkdir(dirname(this.file), { recursive: true });
			await writeFile(this.file, JSON.stringify(this.state, null, "\t"));
		} catch (e) {
			await log(`State save failed: ${errMsg(e)}`);
		}
	}

	canPost(): { allowed: boolean; reason?: string } {
		if (this.state.postsToday >= MAX_POSTS_PER_DAY) {
			return { allowed: false, reason: `daily cap (${MAX_POSTS_PER_DAY})` };
		}
		return { allowed: true };
	}

	hasPostedSlot(slot: string): boolean {
		return this.state.slotsPostedToday.includes(slot);
	}

	async recordPost(slot: string, contentFile?: string): Promise<void> {
		this.state.postsToday++;
		this.state.slotsPostedToday.push(slot);
		if (contentFile) {
			this.state.recentContent = [contentFile, ...this.state.recentContent.filter(f => f !== contentFile)]
				.slice(0, RECENT_CONTENT_WINDOW);
		}
		await this.save();
	}

	getRecentContent(): string[] { return this.state.recentContent.slice(); }

	stats(): string {
		return `posts ${this.state.postsToday}/${MAX_POSTS_PER_DAY}, slots: [${this.state.slotsPostedToday.join(", ")}]`;
	}

	getLastBlockHeight(): number { return this.state.lastBlockHeight; }
	getLastAgentCount(): number { return this.state.lastAgentCount; }

	async setLastSeen(blockHeight: number, agentCount: number): Promise<void> {
		this.state.lastBlockHeight = blockHeight;
		this.state.lastAgentCount = agentCount;
		await this.save();
	}
}
