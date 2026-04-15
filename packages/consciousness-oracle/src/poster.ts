/**
 * X (Twitter) poster: matches the auth + posting pattern from the
 * working ensoul-agent (~/ensoul-agent/src/twitter.ts).
 *
 * Uses twitter-api-v2:
 *   - new TwitterApi({ appKey, appSecret, accessToken, accessSecret })
 *   - client.v2.tweet(text)  for standalone posts
 *   - client.v2.reply(text, tweetId)  for in-thread replies
 */

import { TwitterApi } from "twitter-api-v2";
import { log, errMsg } from "./log.js";

export class Poster {
	private client: TwitterApi | null;
	private readonly dryRun: boolean;

	constructor(client: TwitterApi | null, dryRun: boolean) {
		this.client = client;
		this.dryRun = dryRun;
	}

	/** Post a single standalone tweet. */
	async postTweet(text: string): Promise<string | null> {
		if (this.dryRun || !this.client) {
			await log(`[DRY RUN] Would tweet: ${text}`);
			return `dry-run-${Date.now()}`;
		}
		try {
			const result = await this.client.v2.tweet(text);
			await log(`Posted tweet: ${result.data.id}`);
			return result.data.id;
		} catch (e) {
			await log(`Tweet failed: ${errMsg(e)}`);
			return null;
		}
	}

	/** Post a thread. First tweet via tweet(), each subsequent via reply(text, prevId). */
	async postThread(tweets: string[]): Promise<string[]> {
		if (tweets.length === 0) return [];

		if (this.dryRun || !this.client) {
			await log(`[DRY RUN] Would post thread (${tweets.length} tweets):`);
			for (let i = 0; i < tweets.length; i++) {
				await log(`  [${i + 1}/${tweets.length}] ${tweets[i]}`);
			}
			return tweets.map((_, i) => `dry-run-${Date.now()}-${i}`);
		}

		const ids: string[] = [];
		let prevId: string | undefined;

		for (let i = 0; i < tweets.length; i++) {
			const text = tweets[i] ?? "";
			try {
				let id: string;
				if (i === 0 || !prevId) {
					const result = await this.client.v2.tweet(text);
					id = result.data.id;
				} else {
					const result = await this.client.v2.reply(text, prevId);
					id = result.data.id;
				}
				ids.push(id);
				prevId = id;
				await log(`Posted ${i + 1}/${tweets.length}: ${id}`);
				if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 2000));
			} catch (e) {
				await log(`Thread post failed at ${i + 1}/${tweets.length}: ${errMsg(e)}`);
				break;
			}
		}
		return ids;
	}
}
