/**
 * Broadcaster: dual-posts to X and Bluesky in parallel.
 *
 * Either platform alone is sufficient. If both are configured, posts go
 * to both. Returns combined ID list (X IDs first, then Bluesky URIs).
 */

import { TwitterClient } from "./twitter.js";
import { BlueskyClient } from "./bluesky.js";
import { log } from "./log.js";

export class Broadcaster {
	private twitter: TwitterClient;
	private bluesky: BlueskyClient;

	constructor(twitter: TwitterClient, bluesky: BlueskyClient) {
		this.twitter = twitter;
		this.bluesky = bluesky;
	}

	isConfigured(): boolean {
		return this.twitter.isConfigured() || this.bluesky.isConfigured();
	}

	platformsActive(): string {
		const ps: string[] = [];
		if (this.twitter.isConfigured()) ps.push("X");
		if (this.bluesky.isConfigured()) ps.push("Bluesky");
		return ps.join(" + ") || "none";
	}

	async postTweet(text: string): Promise<string | null> {
		const [xId, bskyUri] = await Promise.all([
			this.twitter.postTweet(text),
			this.bluesky.postTweet(text),
		]);
		const xOk = xId !== "" && xId !== null;
		const bskyOk = bskyUri !== null;
		if (!xOk && !bskyOk) {
			await log("Broadcast failed on all platforms");
			return null;
		}
		await log(`Broadcast: X=${xOk ? "ok" : "skip"} Bluesky=${bskyOk ? "ok" : "skip"}`);
		return xOk ? xId : bskyUri;
	}

	async postThread(texts: string[]): Promise<string[]> {
		const [xIds, bskyUris] = await Promise.all([
			this.twitter.postThread(texts),
			this.bluesky.postThread(texts),
		]);
		await log(`Broadcast thread: X=${xIds.length} Bluesky=${bskyUris.length}`);
		return [...xIds, ...bskyUris];
	}
}
