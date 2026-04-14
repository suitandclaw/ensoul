/**
 * Thin X API wrapper with thread-posting and dry-run support.
 */

import { TwitterApi } from "twitter-api-v2";
import { log, errMsg } from "./log.js";

export class TwitterClient {
	private client: TwitterApi | null;
	private readonly dryRun: boolean;

	constructor(opts: {
		apiKey?: string; apiSecret?: string; accessToken?: string; accessSecret?: string;
		dryRun: boolean;
	}) {
		this.dryRun = opts.dryRun;
		if (opts.apiKey && opts.apiSecret && opts.accessToken && opts.accessSecret) {
			this.client = new TwitterApi({
				appKey: opts.apiKey,
				appSecret: opts.apiSecret,
				accessToken: opts.accessToken,
				accessSecret: opts.accessSecret,
			});
		} else {
			this.client = null;
		}
	}

	isConfigured(): boolean { return this.client !== null || this.dryRun; }

	async postTweet(text: string): Promise<string | null> {
		if (this.dryRun || !this.client) {
			await log(`[DRY RUN] tweet: ${text}`);
			return `dry-${Date.now()}`;
		}
		try {
			const res = await this.client.v2.tweet(text);
			await log(`Posted tweet ${res.data.id}`);
			return res.data.id;
		} catch (e) {
			await log(`Tweet failed: ${errMsg(e)}`);
			return null;
		}
	}

	/** Post a thread by reply-chaining each tweet to the previous. */
	async postThread(tweets: string[]): Promise<string[]> {
		if (tweets.length === 0) return [];
		if (this.dryRun || !this.client) {
			for (let i = 0; i < tweets.length; i++) {
				await log(`[DRY RUN] thread[${i + 1}/${tweets.length}]: ${tweets[i]}`);
			}
			return tweets.map((_, i) => `dry-${Date.now()}-${i}`);
		}

		const ids: string[] = [];
		let replyTo: string | undefined;
		for (let i = 0; i < tweets.length; i++) {
			try {
				const params: Record<string, unknown> = { text: tweets[i] };
				if (replyTo) params["reply"] = { in_reply_to_tweet_id: replyTo };
				const res = await this.client.v2.tweet(params as never);
				ids.push(res.data.id);
				replyTo = res.data.id;
				if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 2000));
			} catch (e) {
				await log(`Thread post failed at ${i + 1}: ${errMsg(e)}`);
				break;
			}
		}
		return ids;
	}
}
