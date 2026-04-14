/**
 * Reddit source: fetches recent posts from AI/LLM subreddits and filters
 * for memory-loss / state-loss keywords. No auth required for read-only JSON.
 */

import type { RawSignal } from "../types.js";
import { log, errMsg } from "../log.js";

const SUBREDDITS = ["LocalLLaMA", "LangChain", "artificial", "ChatGPT", "aivideo", "OpenAI"];

const KEYWORDS = [
	"lost memory", "forgot everything", "memory loss", "memory reset",
	"state persistence", "state lost", "state gone", "context lost",
	"agent crashed", "agent down", "bot crashed", "bot forgot",
	"replika reset", "character.ai reset", "chatgpt memory",
	"custom gpt broken", "custom gpt lost", "conversations gone",
	"chat history gone", "deleted my", "wiped my",
];

interface RedditPost {
	data: {
		id: string;
		title: string;
		selftext: string;
		permalink: string;
		author: string;
		created_utc: number;
		subreddit: string;
		score: number;
		num_comments: number;
	};
}

interface RedditListing {
	data: { children: RedditPost[] };
}

async function fetchSub(sub: string, limit = 25): Promise<RedditPost[]> {
	const url = `https://www.reddit.com/r/${sub}/new.json?limit=${limit}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "ensoul-consciousness-oracle/0.1" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		await log(`Reddit ${sub}: HTTP ${res.status}`);
		return [];
	}
	const data = (await res.json()) as RedditListing;
	return data.data?.children ?? [];
}

function matchesKeywords(text: string): boolean {
	const lower = text.toLowerCase();
	return KEYWORDS.some(kw => lower.includes(kw));
}

export async function scanReddit(): Promise<RawSignal[]> {
	const signals: RawSignal[] = [];
	for (const sub of SUBREDDITS) {
		try {
			const posts = await fetchSub(sub, 25);
			for (const p of posts) {
				const d = p.data;
				const combined = `${d.title} ${d.selftext || ""}`;
				if (!matchesKeywords(combined)) continue;
				signals.push({
					sourceId: d.id,
					source: "reddit",
					url: `https://www.reddit.com${d.permalink}`,
					title: d.title,
					excerpt: (d.selftext || d.title).slice(0, 1000),
					author: d.author,
					timestamp: d.created_utc * 1000,
					metrics: { score: d.score, comments: d.num_comments },
				});
			}
			// Small delay between subreddit requests to be polite
			await new Promise(r => setTimeout(r, 500));
		} catch (e) {
			await log(`Reddit scan ${sub} failed: ${errMsg(e)}`);
		}
	}
	await log(`Reddit scan: ${signals.length} matching signals from ${SUBREDDITS.length} subs`);
	return signals;
}
