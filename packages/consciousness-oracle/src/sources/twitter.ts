/**
 * Twitter/X source: searches recent tweets matching failure keywords.
 * Requires X API credentials. Basic tier: 10K tweets/month read.
 */

import { TwitterApi } from "twitter-api-v2";
import type { RawSignal } from "../types.js";
import { log, errMsg } from "../log.js";

const QUERIES = [
	'"agent crashed" OR "bot crashed" -is:retweet lang:en',
	'"lost my memory" OR "lost all memory" AI -is:retweet lang:en',
	'"Replika reset" OR "Replika wiped" -is:retweet lang:en',
	'"Character.AI" broken OR reset OR "destroyed my" -is:retweet lang:en',
	'"ChatGPT memory" cleared OR wiped OR lost -is:retweet lang:en',
	'"my bot forgot" OR "my agent forgot" -is:retweet lang:en',
];

export class TwitterSource {
	private client: TwitterApi | null;

	constructor(client: TwitterApi | null) {
		this.client = client;
	}

	async scan(maxPerQuery = 10): Promise<RawSignal[]> {
		if (!this.client) {
			await log("Twitter scan skipped: no credentials");
			return [];
		}

		const signals: RawSignal[] = [];
		const seen = new Set<string>();

		for (const q of QUERIES) {
			try {
				const result = await this.client.v2.search(q, {
					"tweet.fields": "created_at,public_metrics,author_id",
					"user.fields": "username",
					expansions: "author_id",
					max_results: maxPerQuery,
				});

				const data = (result as unknown as {
					data: {
						data?: Array<{
							id: string;
							text: string;
							author_id?: string;
							created_at?: string;
							public_metrics?: Record<string, number>;
						}>;
					};
					includes?: { users?: Array<{ id: string; username: string }> };
				}).data;

				const tweets = data?.data ?? [];
				const users = new Map<string, string>();
				const includes = (result as unknown as { includes?: { users?: Array<{ id: string; username: string }> } }).includes;
				if (includes?.users) {
					for (const u of includes.users) users.set(u.id, u.username);
				}

				for (const t of tweets) {
					if (seen.has(t.id)) continue;
					seen.add(t.id);
					const author = users.get(t.author_id ?? "") ?? "unknown";
					signals.push({
						sourceId: t.id,
						source: "twitter",
						url: `https://twitter.com/${author}/status/${t.id}`,
						title: t.text.slice(0, 200),
						excerpt: t.text.slice(0, 1000),
						author,
						timestamp: t.created_at ? new Date(t.created_at).getTime() : Date.now(),
						metrics: t.public_metrics ?? {},
					});
				}

				// Respect rate limits: space queries 2s apart
				await new Promise(r => setTimeout(r, 2000));
			} catch (e) {
				await log(`Twitter scan "${q.slice(0, 40)}" failed: ${errMsg(e)}`);
			}
		}

		await log(`Twitter scan: ${signals.length} tweets across ${QUERIES.length} queries`);
		return signals;
	}
}
