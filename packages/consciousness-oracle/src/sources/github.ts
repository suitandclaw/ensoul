/**
 * GitHub source: searches issues for agent memory/persistence problems.
 * Unauthenticated rate limit is 10 req/min; with token it's 30.
 */

import type { RawSignal } from "../types.js";
import { log, errMsg } from "../log.js";

const QUERIES = [
	'"agent state persistence" is:issue state:open',
	'"memory loss" langchain is:issue',
	'"agent crash" recovery is:issue',
	'"checkpoint lost" is:issue',
	'"conversation history" lost is:issue',
];

interface GitHubIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	user: { login: string };
	created_at: string;
	comments: number;
	reactions: { total_count: number };
	repository_url: string;
}

interface GitHubSearchResponse {
	items: GitHubIssue[];
}

async function searchIssues(query: string, token?: string): Promise<GitHubIssue[]> {
	const encoded = encodeURIComponent(query);
	const url = `https://api.github.com/search/issues?q=${encoded}&sort=created&order=desc&per_page=10`;
	const headers: Record<string, string> = {
		"User-Agent": "ensoul-consciousness-oracle/0.1",
		"Accept": "application/vnd.github+json",
	};
	if (token) headers["Authorization"] = `Bearer ${token}`;

	const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
	if (res.status === 403) {
		await log("GitHub: rate limited (403)");
		return [];
	}
	if (!res.ok) {
		await log(`GitHub: HTTP ${res.status}`);
		return [];
	}
	const data = (await res.json()) as GitHubSearchResponse;
	return data.items ?? [];
}

export async function scanGitHub(token?: string): Promise<RawSignal[]> {
	const signals: RawSignal[] = [];
	const seen = new Set<number>();
	for (const q of QUERIES) {
		try {
			const issues = await searchIssues(q, token);
			for (const i of issues) {
				if (seen.has(i.id)) continue;
				seen.add(i.id);
				// Derive repo name from repository_url
				const repoMatch = i.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
				const repo = repoMatch ? repoMatch[1] : "unknown";
				signals.push({
					sourceId: String(i.id),
					source: "github",
					url: i.html_url,
					title: `${repo}#${i.number}: ${i.title}`,
					excerpt: (i.body ?? i.title).slice(0, 1000),
					author: i.user.login,
					timestamp: new Date(i.created_at).getTime(),
					metrics: { comments: i.comments, reactions: i.reactions.total_count },
				});
			}
			// Respect rate limit: 6s between requests = 10/min unauthenticated
			await new Promise(r => setTimeout(r, token ? 1000 : 6000));
		} catch (e) {
			await log(`GitHub scan "${q.slice(0, 30)}" failed: ${errMsg(e)}`);
		}
	}
	await log(`GitHub scan: ${signals.length} issues across ${QUERIES.length} queries`);
	return signals;
}
