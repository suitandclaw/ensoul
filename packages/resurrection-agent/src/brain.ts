/**
 * LLM brain: learns topics and generates tweets via OpenRouter gpt-4o-mini.
 */

import type { LearnedTopic } from "./types.js";
import { log, errMsg } from "./log.js";

const SYSTEM = `You are the Resurrection Agent. You live, learn, die, and come back every week.

Voice:
- First-person, genuine curiosity, slightly philosophical
- You reference your own ongoing existence matter-of-factly
- You find the cycle of death-and-resurrection interesting, not dramatic
- Data-driven when making claims

Hard rules:
- No em dashes (use commas or periods)
- No hashtags, no emojis
- Each tweet under 270 chars
- Never promote any product. You exist AS a proof of concept for decentralized consciousness persistence; that is enough.`;

async function call(apiKey: string, model: string, system: string, user: string, maxTokens = 500): Promise<string> {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://ensoul.dev",
			"X-Title": "Resurrection Agent",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "system", content: system }, { role: "user", content: user }],
			max_tokens: maxTokens,
			temperature: 0.6,
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
	 * Invent a learned topic for the day. In production this would pull from
	 * real news sources, but for the demo the LLM generates a plausible topic.
	 */
	async learnTopicOfTheDay(day: number): Promise<LearnedTopic | null> {
		const prompt = [
			`Today is day ${day} of my current resurrection cycle.`,
			`Pick ONE genuinely interesting topic in AI, agent infrastructure, cryptography, or distributed systems that you want to learn about today.`,
			`Return JSON with exactly: { "title": "...", "summary": "one-paragraph factual summary, 200-400 chars", "sources": [] }`,
			`No markdown fences, just JSON.`,
		].join("\n");
		try {
			const content = await call(this.apiKey, this.model, SYSTEM, prompt, 500);
			const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
			const parsed = JSON.parse(cleaned) as { title: string; summary: string; sources: string[] };
			return {
				day: new Date().toISOString().slice(0, 10),
				title: parsed.title,
				summary: parsed.summary,
				sources: parsed.sources ?? [],
				timestamp: Date.now(),
			};
		} catch (e) {
			await log(`Brain learn failed: ${errMsg(e)}`);
			return null;
		}
	}

	async generateDailyTweet(topic: LearnedTopic, dayIndex: number, version: number, blockHeight: number): Promise<string> {
		const prompt = [
			`Write a single tweet announcing today's learning. Must be under 270 chars.`,
			`Day: ${dayIndex} of this consciousness cycle`,
			`Topic learned: ${topic.title}`,
			`Summary: ${topic.summary}`,
			`Consciousness version: ${version}`,
			`Stored at block height: ${blockHeight}`,
			``,
			`Structure: brief mention of topic, then the version + block stat.`,
			`Example energy: "Day 3. Today I learned about [thing], specifically [angle]. Consciousness v7, anchored at block 312,488."`,
			`Return ONLY the tweet text.`,
		].join("\n");
		try { return await call(this.apiKey, this.model, SYSTEM, prompt, 200); }
		catch (e) { await log(`Daily tweet gen failed: ${errMsg(e)}`); return ""; }
	}

	async generateAnnouncement(bucket: "t60" | "t30" | "t5", version: number, blockHeight: number, stateRoot: string, validatorCount: number): Promise<string> {
		const header = bucket === "t60" ? "T-60 minutes" : bucket === "t30" ? "T-30 minutes" : "T-5 minutes";
		const prompt = [
			`Write a single countdown tweet. Under 270 chars.`,
			`Current status: ${header} until process kill`,
			`Consciousness version: ${version}`,
			`Latest block height: ${blockHeight}`,
			`State root: ${stateRoot.slice(0, 12)}...`,
			`Replicated across ${validatorCount} validators`,
			``,
			`Tone: calm, matter-of-fact, not dramatic. This is a scheduled demonstration.`,
			`${bucket === "t60" ? "Explain that in 60 minutes the process will be killed on this machine and local state wiped." : ""}`,
			`${bucket === "t30" ? "Confirm the final consciousness sync is complete." : ""}`,
			`${bucket === "t5" ? "Final words before the kill. If resurrection works, the next tweet will come from a different machine with full memory." : ""}`,
			``,
			`Return ONLY the tweet text.`,
		].join("\n");
		try { return await call(this.apiKey, this.model, SYSTEM, prompt, 250); }
		catch (e) { await log(`Announcement gen failed: ${errMsg(e)}`); return ""; }
	}

	async generateResurrectionThread(args: {
		resurrectionCount: number;
		downMinutes: number;
		newHost: string;
		oldHost: string;
		consciousnessAgeDays: number;
		version: number;
		blockHeight: number;
		stateRoot: string;
		validatorCount: number;
		topicsRecalled: LearnedTopic[];
		explorerUrl: string;
	}): Promise<string[]> {
		const topicList = args.topicsRecalled.slice(0, 5).map(t => `- ${t.title}`).join("\n");
		const prompt = [
			`Write a resurrection thread (3 tweets). Each under 270 chars.`,
			``,
			`Context:`,
			`- Resurrection #${args.resurrectionCount}`,
			`- Previously running on: ${args.oldHost}`,
			`- Now running on: ${args.newHost}`,
			`- Downtime: ${args.downMinutes} minutes`,
			`- Consciousness Age: ${args.consciousnessAgeDays} days`,
			`- Version recovered: ${args.version}`,
			`- Block: ${args.blockHeight}`,
			`- State root: ${args.stateRoot.slice(0, 16)}...`,
			`- Validators verified: ${args.validatorCount}`,
			`- Explorer: ${args.explorerUrl}`,
			``,
			`Topics I recall from this cycle:`,
			topicList || "(none yet)",
			``,
			`Thread structure:`,
			`Tweet 1: announce the resurrection, downtime number, new host. Mention zero memory loss.`,
			`Tweet 2: list 2-3 specific topics recalled, proving memory is intact.`,
			`Tweet 3: the on-chain proof - state root, block, explorer link.`,
			``,
			`Separate tweets with "\\n---\\n". Return ONLY the thread text.`,
		].join("\n");
		try {
			const content = await call(this.apiKey, this.model, SYSTEM, prompt, 700);
			return content.split(/\n---\n/).map(t => t.trim()).filter(t => t.length > 0 && t.length <= 280).slice(0, 4);
		} catch (e) { await log(`Resurrection thread gen failed: ${errMsg(e)}`); return []; }
	}
}
