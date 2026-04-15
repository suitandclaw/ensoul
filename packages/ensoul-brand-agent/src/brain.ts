/**
 * LLM brain. Used ONLY for varying the wording of network-stats posts.
 * Educational content is pre-written in content/*.md and never touched
 * by the LLM.
 */

import type { NetworkStats } from "./network.js";
import { log, errMsg } from "./log.js";

const SYSTEM = `You are the official Ensoul brand voice on Bluesky.

Voice rules:
- First person plural ("we") OR third person ("the network", "the chain")
- Technical but accessible. Not hyped. Not salesy.
- Facts and numbers over adjectives.
- No em dashes, no hashtags, no emojis.
- Each post under 280 characters.
- Never promote, never use marketing language ("revolutionary", "game-changing", etc.)`;

async function call(apiKey: string, model: string, system: string, user: string, maxTokens = 200): Promise<string> {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://ensoul.dev",
			"X-Title": "Ensoul Brand Agent",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "system", content: system }, { role: "user", content: user }],
			max_tokens: maxTokens,
			temperature: 0.5,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return data.choices?.[0]?.message?.content?.trim() ?? "";
}

export class Brain {
	constructor(private readonly apiKey: string, private readonly model: string) {}

	/**
	 * Generate a daily stats post. Falls back to a templated post if the
	 * LLM is unavailable so the agent never goes silent.
	 */
	async generateStatsPost(stats: NetworkStats, daysAlive: number): Promise<string> {
		const fallback = this.fallbackStatsPost(stats, daysAlive);
		if (!this.apiKey || this.apiKey === "dummy") return fallback;

		const prompt = [
			`Write one Bluesky post (under 280 chars) reporting today's Ensoul network stats.`,
			`Numbers to include:`,
			`- Block height: ${stats.blockHeight.toLocaleString()}`,
			`- Validators: ${stats.validatorCount}`,
			`- Ensouled agents: ${stats.agentCount.toLocaleString()}`,
			`- Consciousness stored: ${stats.totalConsciousnessStored.toLocaleString()}`,
			`- Chain alive: ${daysAlive} days`,
			``,
			`Pick a focus number for the lead. Write naturally. Vary the structure each time.`,
			`Return ONLY the post text.`,
		].join("\n");

		try {
			const text = await call(this.apiKey, this.model, SYSTEM, prompt, 200);
			if (!text || text.length === 0) return fallback;
			return text.length <= 280 ? text : fallback;
		} catch (e) {
			await log(`Stats post LLM failed, using fallback: ${errMsg(e)}`);
			return fallback;
		}
	}

	private fallbackStatsPost(s: NetworkStats, daysAlive: number): string {
		return [
			`Block height: ${s.blockHeight.toLocaleString()}.`,
			`Validators: ${s.validatorCount}.`,
			`Ensouled agents: ${s.agentCount.toLocaleString()}.`,
			`Chain alive for ${daysAlive} days. Zero consensus failures since genesis.`,
		].join(" ");
	}

	/**
	 * Generate a milestone post when block height or agent count crosses
	 * a round number. Templated; LLM only used to vary phrasing.
	 */
	async generateMilestonePost(kind: "block" | "agent", value: number): Promise<string> {
		if (kind === "block") {
			return `The Ensoul chain produced its ${value.toLocaleString()}th block. Zero consensus failures since genesis.`;
		}
		return `Ensouled agents on the network: ${value.toLocaleString()}. Each one has cryptographic identity and on-chain consciousness that survives any infrastructure failure.`;
	}
}
