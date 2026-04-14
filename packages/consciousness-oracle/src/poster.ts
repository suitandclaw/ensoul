/**
 * X (Twitter) poster: posts threads with proper reply-chaining.
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

	/** Post a thread. Returns array of tweet IDs (or fake IDs in dry-run). */
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
		let replyTo: string | undefined;

		for (let i = 0; i < tweets.length; i++) {
			try {
				const params: Record<string, unknown> = { text: tweets[i] };
				if (replyTo) {
					params["reply"] = { in_reply_to_tweet_id: replyTo };
				}
				const result = await this.client.v2.tweet(params as never);
				const id = result.data.id;
				ids.push(id);
				replyTo = id;
				await log(`Posted ${i + 1}/${tweets.length}: ${id}`);
				// Space out the tweets to avoid rate limits
				if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 2000));
			} catch (e) {
				await log(`Thread post failed at ${i + 1}/${tweets.length}: ${errMsg(e)}`);
				break;
			}
		}
		return ids;
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
}
