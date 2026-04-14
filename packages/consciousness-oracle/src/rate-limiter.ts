/**
 * Persistent rate limiter. State survives process restarts.
 * Tracks daily post/reply counts + last-action cooldown.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errMsg, log } from "./log.js";

interface LimiterState {
	date: string;
	postsToday: number;
	repliesToday: number;
	lastActionTime: number;
}

export class RateLimiter {
	private readonly file: string;
	private readonly maxPostsPerDay: number;
	private readonly maxRepliesPerDay: number;
	private readonly cooldownMs: number;
	private state: LimiterState;

	constructor(
		dataDir: string,
		opts: { maxPostsPerDay: number; maxRepliesPerDay: number; cooldownMs: number },
	) {
		this.file = join(dataDir, "rate-limiter.json");
		this.maxPostsPerDay = opts.maxPostsPerDay;
		this.maxRepliesPerDay = opts.maxRepliesPerDay;
		this.cooldownMs = opts.cooldownMs;
		this.state = this.fresh();
	}

	private fresh(): LimiterState {
		return {
			date: new Date().toISOString().slice(0, 10),
			postsToday: 0,
			repliesToday: 0,
			lastActionTime: 0,
		};
	}

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.file, "utf-8");
			const loaded = JSON.parse(raw) as LimiterState;
			const today = new Date().toISOString().slice(0, 10);
			if (loaded.date === today) {
				this.state = loaded;
			} else {
				this.state = this.fresh();
				await this.save();
			}
		} catch { /* first run */ }
	}

	private async save(): Promise<void> {
		try {
			await writeFile(this.file, JSON.stringify(this.state, null, "\t"));
		} catch (e) {
			await log(`RateLimiter save failed: ${errMsg(e)}`);
		}
	}

	canPost(): { allowed: boolean; reason?: string } {
		if (this.state.postsToday >= this.maxPostsPerDay) {
			return { allowed: false, reason: `daily post cap (${this.maxPostsPerDay})` };
		}
		const elapsed = Date.now() - this.state.lastActionTime;
		if (elapsed < this.cooldownMs) {
			const mins = Math.ceil((this.cooldownMs - elapsed) / 60_000);
			return { allowed: false, reason: `cooldown ${mins}m remaining` };
		}
		return { allowed: true };
	}

	canReply(): { allowed: boolean; reason?: string } {
		if (this.state.repliesToday >= this.maxRepliesPerDay) {
			return { allowed: false, reason: `daily reply cap (${this.maxRepliesPerDay})` };
		}
		const elapsed = Date.now() - this.state.lastActionTime;
		if (elapsed < this.cooldownMs) {
			const mins = Math.ceil((this.cooldownMs - elapsed) / 60_000);
			return { allowed: false, reason: `cooldown ${mins}m remaining` };
		}
		return { allowed: true };
	}

	async recordPost(): Promise<void> {
		this.state.postsToday++;
		this.state.lastActionTime = Date.now();
		await this.save();
	}

	async recordReply(): Promise<void> {
		this.state.repliesToday++;
		this.state.lastActionTime = Date.now();
		await this.save();
	}

	stats(): string {
		return `posts ${this.state.postsToday}/${this.maxPostsPerDay}, replies ${this.state.repliesToday}/${this.maxRepliesPerDay}`;
	}
}
