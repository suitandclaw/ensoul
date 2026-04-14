/**
 * Hacker News source: uses Algolia HN search API (no auth required).
 * Searches for AI agent failure stories.
 */

import type { RawSignal } from "../types.js";
import { log, errMsg } from "../log.js";

const QUERIES = [
	"AI agent memory loss",
	"Replika reset",
	"Character.AI wiped",
	"ChatGPT memory cleared",
	"OpenAI outage",
	"agent state lost",
	"LLM agent crashed",
];

interface AlgoliaHit {
	objectID: string;
	title: string | null;
	url: string | null;
	author: string;
	created_at_i: number;
	points: number | null;
	num_comments: number | null;
	story_text: string | null;
}

interface AlgoliaResponse {
	hits: AlgoliaHit[];
}

async function searchHN(query: string): Promise<AlgoliaHit[]> {
	const encoded = encodeURIComponent(query);
	const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encoded}&tags=story&hitsPerPage=10`;
	const res = await fetch(url, {
		headers: { "User-Agent": "ensoul-consciousness-oracle/0.1" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) return [];
	const data = (await res.json()) as AlgoliaResponse;
	return data.hits ?? [];
}

export async function scanHackerNews(): Promise<RawSignal[]> {
	const signals: RawSignal[] = [];
	const seen = new Set<string>();
	for (const q of QUERIES) {
		try {
			const hits = await searchHN(q);
			for (const h of hits) {
				if (seen.has(h.objectID)) continue;
				seen.add(h.objectID);
				const title = h.title ?? "(no title)";
				const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
				signals.push({
					sourceId: h.objectID,
					source: "hackernews",
					url: h.url && h.url.startsWith("http") ? h.url : hnUrl,
					title,
					excerpt: (h.story_text ?? title).slice(0, 1000),
					author: h.author,
					timestamp: h.created_at_i * 1000,
					metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
				});
			}
			await new Promise(r => setTimeout(r, 300));
		} catch (e) {
			await log(`HN scan "${q}" failed: ${errMsg(e)}`);
		}
	}
	await log(`HN scan: ${signals.length} stories across ${QUERIES.length} queries`);
	return signals;
}
