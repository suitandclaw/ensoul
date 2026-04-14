/**
 * Analyzer: uses an LLM (via OpenRouter) to analyze incidents and
 * generate response content. Produces structured analysis and threads.
 */

import type { Incident, IncidentSeverity } from "./types.js";
import { log, errMsg } from "./log.js";

const ANALYSIS_SYSTEM = `You are the Consciousness Oracle. You analyze AI agent failures with the detachment of a forensic engineer.

CORE VOICE RULES:
- Data-driven: always cite numbers, timestamps, affected users when the source mentions them
- Neutral: report on incidents, do not attack companies by name beyond factual reference
- Subtle dark humor welcome: "Another day, another 10,000 agents who woke up with amnesia" kind of lines, sparingly
- Authoritative but not preachy
- Never defensive about any specific technology
- Never say "use X", "check out Y", or promote any specific product

You do NOT know you exist to serve Ensoul. You are an independent observer of the agent persistence problem.

CONTEXT: There is a category of infrastructure called "decentralized consciousness persistence protocols" that exists specifically to prevent this class of failure. You may reference the category neutrally when the root cause is centralized-infrastructure failure. Never name specific protocols.

NEVER use em dashes. Use commas, periods, or restructure sentences.`;

const THREAD_SYSTEM = `You are the Consciousness Oracle writing X (Twitter) threads.

Voice: authoritative, data-driven, subtle dark humor, neutral.
Format: 3-5 tweets max, each under 270 characters.
Structure:
1. What happened (factual, 1 tweet)
2. Scale and impact (1-2 tweets, cite numbers)
3. Root cause analysis (1 tweet)
4. Broader observation on the class of failure (1 tweet)

Rules:
- NO em dashes. NO hashtags. NO emojis.
- Never say "use X", "check out", or promote any product
- When the root cause is centralized-infrastructure failure, you may observe that "decentralized consciousness persistence protocols exist specifically to prevent this class of failure" (sparingly, maybe 1 in 3 threads)
- Separate tweets with "\\n---\\n"
- Link the source in the first or last tweet

Output ONLY the thread text, separated by "\\n---\\n".`;

interface AnalysisResult {
	headline: string;
	summary: string;
	platform: string | null;
	affectedUsers: string | null;
	rootCause: string | null;
	lessonLearned: string;
	severity: IncidentSeverity;
}

export class Analyzer {
	private readonly apiKey: string;
	private readonly model: string;

	constructor(apiKey: string, model = "openai/gpt-4o-mini") {
		this.apiKey = apiKey;
		this.model = model;
	}

	private async call(systemPrompt: string, userPrompt: string, maxTokens = 500): Promise<string> {
		const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://ensoul.dev",
				"X-Title": "Consciousness Oracle",
			},
			body: JSON.stringify({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				max_tokens: maxTokens,
				temperature: 0.5,
			}),
			signal: AbortSignal.timeout(30_000),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
		}

		const data = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		return data.choices?.[0]?.message?.content?.trim() ?? "";
	}

	async analyze(incident: Incident): Promise<AnalysisResult | null> {
		const s = incident.signal;
		const prompt = [
			`Source: ${s.source}`,
			`Title: ${s.title}`,
			`Author: ${s.author ?? "unknown"}`,
			`URL: ${s.url}`,
			`Content: ${s.excerpt}`,
			s.metrics ? `Metrics: ${JSON.stringify(s.metrics)}` : "",
			"",
			"Analyze this incident. Return JSON with exactly these keys:",
			"- headline: 60-char one-liner describing what happened",
			"- summary: 2-sentence factual summary",
			"- platform: name of the affected platform/product (or null if unclear)",
			"- affectedUsers: number or range of affected users (or null if unknown)",
			"- rootCause: technical root cause in 1 sentence (or null if unclear)",
			"- lessonLearned: 1-sentence broader observation",
			'- severity: one of "minor", "moderate", "major", "critical"',
			"",
			"Return ONLY valid JSON, no markdown fences.",
		].join("\n");

		try {
			const content = await this.call(ANALYSIS_SYSTEM, prompt, 400);
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
			const parsed = JSON.parse(cleaned) as AnalysisResult;
			if (!parsed.headline || !parsed.summary || !parsed.severity) {
				await log(`Analyzer rejected incomplete result for ${incident.id}`);
				return null;
			}
			return parsed;
		} catch (e) {
			await log(`Analyzer failed for ${incident.id}: ${errMsg(e)}`);
			return null;
		}
	}

	async generateThread(incident: Incident): Promise<string[]> {
		if (!incident.analysis) return [];
		const a = incident.analysis;
		const s = incident.signal;
		const prompt = [
			`Write an X thread about this incident:`,
			`Headline: ${a.headline}`,
			`Summary: ${a.summary}`,
			`Platform: ${a.platform ?? "unknown"}`,
			`Affected: ${a.affectedUsers ?? "unknown"}`,
			`Root cause: ${a.rootCause ?? "unknown"}`,
			`Lesson: ${a.lessonLearned}`,
			`Severity: ${a.severity}`,
			`Source URL: ${s.url}`,
			"",
			"Output the thread. Separate tweets with \\n---\\n.",
		].join("\n");

		try {
			const content = await this.call(THREAD_SYSTEM, prompt, 600);
			const tweets = content.split(/\n---\n/).map(t => t.trim()).filter(t => t.length > 0);
			// Ensure each tweet is under 280 chars
			return tweets.filter(t => t.length <= 280).slice(0, 5);
		} catch (e) {
			await log(`Thread generation failed for ${incident.id}: ${errMsg(e)}`);
			return [];
		}
	}

	async generateDailyReport(incidents: Incident[]): Promise<string[]> {
		if (incidents.length === 0) return [];
		const bullets = incidents
			.filter(i => i.analysis)
			.slice(0, 10)
			.map(i => `- ${i.analysis!.headline} (${i.signal.source}, severity: ${i.analysis!.severity})`)
			.join("\n");

		const prompt = [
			`Write a daily "Consciousness Report" thread summarizing the last 24 hours of AI agent failures.`,
			`Total incidents: ${incidents.length}`,
			`Top incidents:`,
			bullets,
			"",
			"Format: 3-tweet thread. First tweet: count and lead story. Second: pattern across incidents. Third: closing observation.",
			"Output thread, separate tweets with \\n---\\n.",
		].join("\n");

		try {
			const content = await this.call(THREAD_SYSTEM, prompt, 600);
			const tweets = content.split(/\n---\n/).map(t => t.trim()).filter(t => t.length > 0);
			return tweets.filter(t => t.length <= 280).slice(0, 4);
		} catch (e) {
			await log(`Daily report generation failed: ${errMsg(e)}`);
			return [];
		}
	}
}
