#!/usr/bin/env npx tsx
/**
 * Ensoul Research Agents
 *
 * Three lightweight agents that monitor specific topics, accumulate
 * findings in local state files, and write consciousness to the chain
 * via the heartbeat service.
 *
 * Agents:
 *   1. ai-news: AI research, model releases, industry developments
 *   2. defi-news: DeFi protocols, governance proposals, yield strategies
 *   3. infra: Blockchain infrastructure, L1/L2 developments, tooling
 *
 * Each runs on a 60-minute cycle with GPT-4o-mini via OpenRouter.
 * Combined spend cap: $1/day.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".ensoul", "research-agents");
const LOG_FILE = join(homedir(), ".ensoul", "research-agents.log");
const COST_FILE = join(DATA_DIR, "daily-cost.json");
const DAILY_BUDGET_USD = 1.0;
const CYCLE_MINUTES = 60;

// Load OpenRouter API key from the Moltbook agent's env file
const ENV_FILE = join(homedir(), "ensoul-agent", ".env");
let OPENROUTER_KEY = "";
try {
	const envRaw = readFileSync(ENV_FILE, "utf-8");
	for (const line of envRaw.split("\n")) {
		if (line.startsWith("OPENROUTER_API_KEY=")) {
			OPENROUTER_KEY = line.split("=").slice(1).join("=").trim();
		}
	}
} catch { /* will fail gracefully */ }

// ── Ed25519 ─────────────────────────────────────────────────────────

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

function hexToBytes(hex: string): Uint8Array {
	const b = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	return b;
}

// ── Logging ─────────────────────────────────────────────────────────

async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString().slice(0, 19);
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	try { await writeFile(LOG_FILE, line, { flag: "a" }); } catch { /* non-fatal */ }
}

// ── Cost Tracking ───────────────────────────────────────────────────

interface DailyCost {
	date: string;
	totalUsd: number;
	calls: number;
}

async function getDailyCost(): Promise<DailyCost> {
	const today = new Date().toISOString().slice(0, 10);
	try {
		const raw = await readFile(COST_FILE, "utf-8");
		const cost = JSON.parse(raw) as DailyCost;
		if (cost.date === today) return cost;
	} catch { /* new day or no file */ }
	return { date: today, totalUsd: 0, calls: 0 };
}

async function recordCost(usd: number): Promise<void> {
	const cost = await getDailyCost();
	cost.totalUsd += usd;
	cost.calls += 1;
	await writeFile(COST_FILE, JSON.stringify(cost, null, 2));
}

async function withinBudget(): Promise<boolean> {
	const cost = await getDailyCost();
	return cost.totalUsd < DAILY_BUDGET_USD;
}

// ── LLM Call ────────────────────────────────────────────────────────

async function queryLLM(systemPrompt: string, userPrompt: string): Promise<string> {
	if (!OPENROUTER_KEY) {
		return "(No API key available. Using placeholder research data.)";
	}

	if (!(await withinBudget())) {
		return "(Daily budget reached. Skipping LLM call.)";
	}

	try {
		const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${OPENROUTER_KEY}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://ensoul.dev",
				"X-Title": "Ensoul Research Agent",
			},
			body: JSON.stringify({
				model: "openai/gpt-4o-mini",
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				max_tokens: 500,
				temperature: 0.7,
			}),
			signal: AbortSignal.timeout(30000),
		});

		const data = (await resp.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
		};

		const content = data.choices?.[0]?.message?.content ?? "(no response)";
		const tokens = data.usage?.total_tokens ?? 0;

		// GPT-4o-mini: ~$0.15/1M input tokens, ~$0.60/1M output tokens
		// Approximate: $0.30/1M tokens average
		const estimatedCost = (tokens / 1_000_000) * 0.30;
		await recordCost(estimatedCost);
		await log(`  LLM call: ${tokens} tokens, $${estimatedCost.toFixed(6)}`);

		return content;
	} catch (err) {
		await log(`  LLM error: ${err instanceof Error ? err.message : String(err)}`);
		return "(LLM call failed)";
	}
}

// ── Agent Definition ────────────────────────────────────────────────

interface AgentDef {
	id: string;
	name: string;
	topic: string;
	systemPrompt: string;
	queryPrompt: string;
}

const AGENTS: AgentDef[] = [
	{
		id: "ai-news",
		name: "AI News",
		topic: "artificial intelligence",
		systemPrompt: "You are a research analyst tracking AI developments. Summarize the most significant recent developments in AI, including model releases, research breakthroughs, policy changes, and industry trends. Be concise and factual. Focus on what happened in the last week.",
		queryPrompt: "What are the 3 most significant AI developments this week? Include: what happened, who was involved, and why it matters. Format as a numbered list with brief explanations.",
	},
	{
		id: "defi-news",
		name: "DeFi News",
		topic: "decentralized finance",
		systemPrompt: "You are a DeFi research analyst tracking decentralized finance developments. Cover protocol launches, governance proposals, significant TVL changes, security incidents, and yield strategy innovations. Be concise and factual.",
		queryPrompt: "What are the 3 most significant DeFi developments this week? Include: protocol name, what changed, and the impact. Format as a numbered list.",
	},
	{
		id: "infra",
		name: "Blockchain Infra",
		topic: "blockchain infrastructure",
		systemPrompt: "You are a blockchain infrastructure analyst tracking L1/L2 developments, consensus mechanism changes, tooling releases, and performance improvements across the ecosystem. Focus on technical developments, not price movements.",
		queryPrompt: "What are the 3 most significant blockchain infrastructure developments this week? Include: the project, what changed technically, and why it matters. Format as a numbered list.",
	},
];

// ── Agent State Management ──────────────────────────────────────────

interface AgentState {
	did: string;
	seedHex: string;
	pubKeyHex: string;
	findings: Array<{ timestamp: string; content: string }>;
	totalFindings: number;
	lastResearchAt: number;
}

async function loadOrCreateAgent(agentDef: AgentDef): Promise<AgentState> {
	const stateFile = join(DATA_DIR, `${agentDef.id}-state.json`);

	try {
		const raw = await readFile(stateFile, "utf-8");
		return JSON.parse(raw) as AgentState;
	} catch {
		// Create new agent identity
		const seed = new Uint8Array(32);
		crypto.getRandomValues(seed);
		const pubKey = await ed.getPublicKeyAsync(seed);

		// Derive DID
		const mc = new Uint8Array(34);
		mc[0] = 0xed; mc[1] = 0x01;
		mc.set(pubKey, 2);
		const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
		let num = 0n;
		for (const byte of mc) num = num * 256n + BigInt(byte);
		let encoded = "";
		while (num > 0n) { encoded = B58[Number(num % 58n)]! + encoded; num = num / 58n; }
		for (const byte of mc) { if (byte === 0) encoded = "1" + encoded; else break; }
		const did = `did:key:z${encoded}`;

		const state: AgentState = {
			did,
			seedHex: bytesToHex(seed),
			pubKeyHex: bytesToHex(pubKey),
			findings: [],
			totalFindings: 0,
			lastResearchAt: 0,
		};

		await writeFile(stateFile, JSON.stringify(state, null, 2));
		await log(`Created new agent: ${agentDef.name} (${did.slice(0, 30)}...)`);
		return state;
	}
}

async function saveAgentState(agentDef: AgentDef, state: AgentState): Promise<void> {
	const stateFile = join(DATA_DIR, `${agentDef.id}-state.json`);
	await writeFile(stateFile, JSON.stringify(state, null, 2));
}

// ── Research Cycle ──────────────────────────────────────────────────

async function runResearchCycle(agentDef: AgentDef, state: AgentState): Promise<void> {
	await log(`[${agentDef.name}] Starting research cycle...`);

	const content = await queryLLM(agentDef.systemPrompt, agentDef.queryPrompt);

	if (content.startsWith("(")) {
		await log(`[${agentDef.name}] Skipped: ${content}`);
		return;
	}

	// Append finding
	state.findings.push({
		timestamp: new Date().toISOString(),
		content,
	});
	state.totalFindings++;
	state.lastResearchAt = Date.now();

	// Keep last 100 findings
	if (state.findings.length > 100) {
		state.findings = state.findings.slice(-100);
	}

	await saveAgentState(agentDef, state);
	await log(`[${agentDef.name}] Finding #${state.totalFindings} recorded (${content.length} chars)`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	await log("Research Agents starting...");

	if (!OPENROUTER_KEY) {
		await log("WARNING: No OPENROUTER_API_KEY found. Agents will run with placeholder data.");
	}

	// Initialize all agents
	const states: Map<string, AgentState> = new Map();
	for (const agentDef of AGENTS) {
		const state = await loadOrCreateAgent(agentDef);
		states.set(agentDef.id, state);
		await log(`  ${agentDef.name}: did=${state.did.slice(0, 30)}... findings=${state.totalFindings}`);
	}

	// Run initial research cycle for all agents
	for (const agentDef of AGENTS) {
		const state = states.get(agentDef.id)!;
		await runResearchCycle(agentDef, state);
	}

	// Update heartbeat config to include all research agents
	await updateHeartbeatConfig(states);

	// Schedule recurring research cycles
	setInterval(async () => {
		for (const agentDef of AGENTS) {
			const state = states.get(agentDef.id)!;
			const elapsed = (Date.now() - state.lastResearchAt) / 60000;
			if (elapsed >= CYCLE_MINUTES) {
				await runResearchCycle(agentDef, state);
				await updateHeartbeatConfig(states);
			}
		}
	}, 60_000); // Check every minute

	await log("Research agents running. Cycles every 60 minutes.");

	const shutdown = async (): Promise<void> => {
		await log("Research agents shutting down");
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

async function updateHeartbeatConfig(states: Map<string, AgentState>): Promise<void> {
	const configFile = join(homedir(), ".ensoul", "heartbeat-agents.json");
	let existing: Array<{ name: string; did: string; seedHex: string; stateFile: string; intervalMinutes: number }> = [];

	try {
		existing = JSON.parse(await readFile(configFile, "utf-8"));
	} catch { /* start fresh */ }

	// Remove old research agents, keep Moltbook and others
	existing = existing.filter(a => !a.name.startsWith("Research:"));

	// Add current research agents
	for (const agentDef of AGENTS) {
		const state = states.get(agentDef.id)!;
		existing.push({
			name: `Research: ${agentDef.name}`,
			did: state.did,
			seedHex: state.seedHex,
			stateFile: join(DATA_DIR, `${agentDef.id}-state.json`),
			intervalMinutes: 60,
		});
	}

	await writeFile(configFile, JSON.stringify(existing, null, 2));
	await log("Updated heartbeat config with research agents");
}

main().catch(async (err: unknown) => {
	await log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
