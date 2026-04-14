#!/usr/bin/env npx tsx
/**
 * Ensoul Network Monitor
 *
 * Real-time status dashboard for all Ensoul services.
 * Polls validators, explorer, website, and agent every 30 seconds.
 *
 * Usage:
 *   npx tsx packages/monitor/start.ts
 *   npx tsx packages/monitor/start.ts --port 4000
 *
 * Env:
 *   ALERT_WEBHOOK_URL - Discord/Slack webhook for up/down alerts
 */

import Fastify from "fastify";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkValidatorHealth } from "../shared/validator-health.js";
import { homedir } from "node:os";
import { exec } from "node:child_process";

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 4000);
const POLL_INTERVAL = 30_000;
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "monitor.log");
const AGENT_LOG = join(LOG_DIR, "agent.log");
const MOLTBOOK_LOG = join(LOG_DIR, "moltbook-agent.log");
const WEBHOOK_URL = process.env["ALERT_WEBHOOK_URL"] ?? "";
const STATUS_PASSWORD = process.env["ENSOUL_STATUS_PASSWORD"] ?? "";
const CMT_RPC = process.env["CMT_RPC"] ?? "http://178.156.199.91:26657";

// ── Types ────────────────────────────────────────────────────────────

interface ServiceStatus {
	name: string;
	url: string;
	status: "healthy" | "down" | "degraded";
	lastSeen: number;
	details: Record<string, string | number>;
}

interface HealthResponse {
	overall: "operational" | "degraded" | "down";
	services: ServiceStatus[];
	aggregate: {
		blockHeight: number;
		validatorCount: number;
		blocksPerMinute: number;
		ensouledAgents: number;
		consciousnessStored: number;
		uptime: number;
	};
	checkedAt: number;
}

// ── State ────────────────────────────────────────────────────────────

let health: HealthResponse = {
	overall: "down",
	services: [],
	aggregate: { blockHeight: 0, validatorCount: 0, blocksPerMinute: 0, ensouledAgents: 0, consciousnessStored: 0, uptime: 0 },
	checkedAt: 0,
};

const startedAt = Date.now();
let lastHeight = 0;
let lastHeightAt = Date.now();
const previousStatuses = new Map<string, "healthy" | "down" | "degraded">();

// Alert history (kept in memory, shown on dashboard)
interface AlertEntry {
	timestamp: string;
	message: string;
	level: "up" | "down" | "degraded" | "info";
}
const alertHistory: AlertEntry[] = [];
const MAX_ALERT_HISTORY = 100;

// Alert deduplication: same validator alert at most once per hour
const lastAlertedAt = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Read ntfy topic from disk. */
function getNtfyTopic(): string {
	try {
		return readFileSync(join(homedir(), ".ensoul", "ntfy-topic.txt"), "utf-8").trim();
	} catch { return ""; }
}

/** Send push notification via ntfy.sh. */
async function sendNtfy(msg: string, priority = "default"): Promise<void> {
	const topic = getNtfyTopic();
	if (!topic) return;
	try {
		await fetch(`https://ntfy.sh/${topic}`, {
			method: "POST",
			headers: { "Title": "Ensoul Monitor", "Priority": priority },
			body: msg,
			signal: AbortSignal.timeout(5000),
		});
	} catch { /* non-fatal */ }
}

// ── Polling ──────────────────────────────────────────────────────────

// Full validator config with SSH info for remote management
interface ValidatorConfig {
	name: string;
	moniker: string;
	tailscaleIp: string;
	publicUrl: string | null;
	publicIp?: string;
	rpcPort: number;
	role: string;
	ssh: string;
	sshPort?: number;
	user: string;
	cometbftAddress?: string;
	did?: string;
}

const VALIDATOR_CONFIGS: ValidatorConfig[] = (() => {
	try {
		const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "configs", "validators.json");
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as { validators: ValidatorConfig[] };
		return config.validators;
	} catch {
		return [];
	}
})();

// Load validator list from config file (not hardcoded)
// Use Tailscale IP for health checks, fall back to public IP for cloud validators without Tailscale
const VALIDATORS: Array<{ name: string; url: string }> = VALIDATOR_CONFIGS.map((v) => ({
	name: v.name,
	url: `http://${v.tailscaleIp || v.publicIp || "localhost"}:${v.rpcPort}`,
}));

/** Build an SSH command prefix for a validator. */
function sshCmd(vc: ValidatorConfig): string {
	if (vc.ssh === "localhost") return "";
	const ip = vc.tailscaleIp || vc.publicIp || "";
	const portFlag = vc.sshPort ? `-p ${vc.sshPort}` : "";
	return `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${portFlag} ${vc.user}@${ip}`;
}

/** Run a command on a validator (local or remote via SSH). Returns stdout. */
function runOnValidator(vc: ValidatorConfig, cmd: string, timeoutMs = 120_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const prefix = sshCmd(vc);
		const fullCmd = prefix ? `${prefix} '${cmd.replace(/'/g, "'\\''")}'` : cmd;
		const child = exec(fullCmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: string) => { stdout += d; });
		child.stderr?.on("data", (d: string) => { stderr += d; });
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`Exit ${code}: ${stderr.slice(0, 500)}`));
		});
		child.on("error", reject);
	});
}

/** Check if a validator is signing blocks by querying CometBFT RPC. */
async function waitForBlock(vc: ValidatorConfig, timeoutSec = 60): Promise<boolean> {
	const url = `http://${vc.tailscaleIp}:${vc.rpcPort}`;
	const deadline = Date.now() + timeoutSec * 1000;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(`${url}/status`, { signal: AbortSignal.timeout(5000) });
			if (resp.ok) {
				const data = (await resp.json()) as { result: { sync_info: { catching_up: boolean; latest_block_height: string } } };
				if (!data.result.sync_info.catching_up && Number(data.result.sync_info.latest_block_height) > 0) {
					return true;
				}
			}
		} catch { /* not ready yet */ }
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

/** In-progress admin operations tracked for polling. */
const adminOps: Map<string, { status: string; log: string[]; done: boolean; success: boolean }> = new Map();

/** Check a validator via CometBFT RPC /status endpoint (not the compat proxy). */
async function checkValidator(name: string, url: string): Promise<ServiceStatus> {
	try {
		const resp = await fetch(`${url}/status`, { signal: AbortSignal.timeout(10_000) });
		if (!resp.ok) return { name, url, status: "down", lastSeen: 0, details: { error: `HTTP ${resp.status}` } };
		const data = (await resp.json()) as {
			result: {
				node_info: { id: string; moniker: string };
				sync_info: { latest_block_height: string; catching_up: boolean };
				validator_info: { address: string; voting_power: string };
			};
		};
		const si = data.result.sync_info;
		const ni = data.result.node_info;
		const height = Number(si.latest_block_height);
		// Also fetch peer count from /net_info
		let peers = 0;
		try {
			const netResp = await fetch(`${url}/net_info`, { signal: AbortSignal.timeout(5_000) });
			if (netResp.ok) {
				const netData = (await netResp.json()) as { result: { n_peers: string } };
				peers = Number(netData.result.n_peers);
			}
		} catch { /* peer count is best-effort */ }
		return {
			name, url, status: "healthy", lastSeen: Date.now(),
			details: { height, peers, moniker: ni.moniker, catchingUp: si.catching_up },
		};
	} catch {
		return { name, url, status: "down", lastSeen: 0, details: {} };
	}
}

async function checkExplorer(): Promise<ServiceStatus> {
	const url = "https://explorer.ensoul.dev";
	try {
		const resp = await fetch(`${url}/api/v1/status`, { signal: AbortSignal.timeout(10_000) });
		if (!resp.ok) return { name: "Explorer", url, status: "down", lastSeen: 0, details: {} };
		const data = (await resp.json()) as { blockHeight: number; validatorCount: number; totalAgents: number };
		return {
			name: "Explorer", url, status: "healthy", lastSeen: Date.now(),
			details: { height: data.blockHeight, validators: data.validatorCount, agents: data.totalAgents },
		};
	} catch {
		return { name: "Explorer", url, status: "down", lastSeen: 0, details: {} };
	}
}

async function checkWebsite(): Promise<ServiceStatus> {
	const url = "https://ensoul.dev";
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
		return {
			name: "Website", url, status: resp.ok ? "healthy" : "down", lastSeen: resp.ok ? Date.now() : 0,
			details: { httpStatus: resp.status },
		};
	} catch {
		return { name: "Website", url, status: "down", lastSeen: 0, details: {} };
	}
}

async function checkAgent(): Promise<ServiceStatus> {
	const name = "Twitter Agent";

	// Check if the agent is explicitly disabled via flag file
	const { access } = await import("node:fs/promises");
	const disabledPath = join(LOG_DIR, "x-agent-disabled");
	try {
		await access(disabledPath);
		// Flag file exists: agent is intentionally disabled
		return { name, url: "local", status: "down", lastSeen: 0, details: { note: "Disabled via x-agent-disabled" } };
	} catch {
		// Flag file does not exist, continue checking
	}

	try {
		const raw = await readFile(AGENT_LOG, "utf-8");
		const lines = raw.trim().split("\n");
		const last = lines[lines.length - 1] ?? "";
		const timeMatch = last.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
		const statsMatch = last.match(/v(\d+), (\d+) interactions, (\d+) posts, (\d+) replies/);

		if (statsMatch) {
			return {
				name, url: "local", status: "healthy", lastSeen: Date.now(),
				details: {
					version: Number(statsMatch[1]),
					interactions: Number(statsMatch[2]),
					posts: Number(statsMatch[3]),
					replies: Number(statsMatch[4]),
					lastLog: timeMatch ? timeMatch[1]! : "unknown",
				},
			};
		}

		// Log exists but no stats line, check recency
		const lastLine = lines[lines.length - 1] ?? "";
		const isRecent = lastLine.includes("[agent]");
		return {
			name, url: "local", status: "healthy", lastSeen: Date.now(),
			details: { lastLine: lastLine.slice(0, 80) },
		};
	} catch {
		return { name, url: "local", status: "down", lastSeen: 0, details: { error: "Log not found" } };
	}
}

async function pollAll(): Promise<void> {
	const services: ServiceStatus[] = [];

	// Build the validator list from CometBFT active set (source of truth),
	// supplemented with connection info from static config and net_info peers.
	// This ensures ALL active validators appear regardless of config file state.
	const checkedAddresses = new Set<string>();

	// Step 1: Get active validator set from CometBFT
	let activeValidators: Array<{ address: string; votingPower: string }> = [];
	try {
		const valResp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "v", method: "validators", params: {} }),
			signal: AbortSignal.timeout(5000),
		});
		if (valResp.ok) {
			const valData = (await valResp.json()) as { result: { validators: Array<{ address: string; voting_power: string }> } };
			activeValidators = valData.result.validators
				.filter(v => Number(v.voting_power) > 0)
				.map(v => ({ address: v.address, votingPower: v.voting_power }));
		}
	} catch { /* fall back to static config */ }

	// Step 2: Get peer IPs from net_info for address resolution
	const peerIps = new Map<string, string>(); // moniker -> IP
	try {
		const netResp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "n", method: "net_info", params: {} }),
			signal: AbortSignal.timeout(5000),
		});
		if (netResp.ok) {
			const netData = (await netResp.json()) as { result: { peers: Array<{ node_info: { moniker: string }; remote_ip: string }> } };
			for (const p of netData.result.peers) {
				peerIps.set(p.node_info.moniker, p.remote_ip);
			}
		}
	} catch { /* non-fatal */ }

	// Step 3: Determine validator health using shared block-signature check.
	// Scans last 20 blocks from local CometBFT. Never reaches remote RPCs.
	const healthResult = await checkValidatorHealth();
	const signingAddresses = new Set<string>();
	for (const [addr, vh] of healthResult.validators) {
		if (vh.status === "signing") signingAddresses.add(addr);
	}
	const localHeight = healthResult.height;

	// Build a name lookup from static config
	const addrToConfig = new Map<string, ValidatorConfig>();
	for (const vc of VALIDATOR_CONFIGS) {
		if (vc.cometbftAddress) addrToConfig.set(vc.cometbftAddress, vc);
	}

	// For each active validator, determine health from block signatures
	for (const av of activeValidators) {
		const isSigning = signingAddresses.has(av.address);
		const config = addrToConfig.get(av.address);
		const name = config?.name ?? `Validator ${av.address.slice(0, 8)}...`;

		// Try to get extra info (height, peers) from remote RPC if configured
		let extraHeight = localHeight;
		let extraPeers: number | string = "N/A";
		let moniker = "";
		if (config) {
			const ip = config.tailscaleIp || config.publicIp || "";
			if (ip) {
				try {
					const resp = await fetch(`http://${ip}:${config.rpcPort}/status`, { signal: AbortSignal.timeout(3000) });
					if (resp.ok) {
						const d = (await resp.json()) as { result: { sync_info: { latest_block_height: string; catching_up: boolean }; node_info: { moniker: string } } };
						extraHeight = Number(d.result.sync_info.latest_block_height);
						moniker = d.result.node_info.moniker;
					}
				} catch { /* RPC unreachable, use local data */ }
				try {
					const netResp = await fetch(`http://${ip}:${config.rpcPort}/net_info`, { signal: AbortSignal.timeout(2000) });
					if (netResp.ok) {
						const nd = (await netResp.json()) as { result: { n_peers: string } };
						extraPeers = Number(nd.result.n_peers);
					}
				} catch { /* best effort */ }
			}
		}

		services.push({
			name,
			url: config ? `http://${config.tailscaleIp || config.publicIp}:${config.rpcPort}` : "",
			status: isSigning ? "healthy" : "down",
			lastSeen: isSigning ? Date.now() : 0,
			details: {
				height: extraHeight,
				peers: extraPeers,
				moniker: moniker || (config?.moniker ?? av.address.slice(0, 12)),
				signing: isSigning,
				votingPower: av.votingPower,
			},
		});
	}

	// Non-validator peers (full nodes)
	const fullNodes: Array<{ moniker: string; ip: string; nodeId: string; version: string }> = [];
	try {
		const netResp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "n", method: "net_info", params: {} }),
			signal: AbortSignal.timeout(5000),
		});
		if (netResp.ok) {
			const netData = (await netResp.json()) as { result: { peers: Array<{ node_info: { id: string; moniker: string; version: string; network: string }; remote_ip: string }> } };
			// Get active validator addresses to filter them out
			const valAddrs = new Set(activeValidators.map(v => v.address));
			for (const p of netData.result.peers) {
				// Check if this peer is a validator by querying its RPC
				let isValidator = false;
				const ip = p.remote_ip;
				if (!ip.startsWith("100.") && !ip.startsWith("10.") && !ip.startsWith("192.168.")) {
					try {
						const sr = await fetch(`http://${ip}:26657/status`, { signal: AbortSignal.timeout(2000) });
						if (sr.ok) {
							const sd = (await sr.json()) as { result: { validator_info: { voting_power: string } } };
							isValidator = Number(sd.result.validator_info.voting_power) > 0;
						}
					} catch { /* RPC unreachable, check by address match */ }
				}
				// Also check by exclusion: if peer is in the services list, it's a validator
				if (!isValidator) {
					const inServices = services.some(s => {
						const det = s.details as Record<string, unknown>;
						return det?.["moniker"] === p.node_info.moniker;
					});
					isValidator = inServices;
				}
				if (!isValidator && p.node_info.network === "ensoul-1") {
					fullNodes.push({
						moniker: p.node_info.moniker,
						ip: p.remote_ip,
						nodeId: p.node_info.id,
						version: p.node_info.version,
					});
				}
			}
		}
	} catch { /* non-fatal */ }

	// Explorer
	services.push(await checkExplorer());

	// Website
	services.push(await checkWebsite());

	// Agent
	services.push(await checkAgent());

	// Compute aggregate
	let maxHeight = 0;
	for (const s of services) {
		const h = Number(s.details["height"] ?? 0);
		if (h > maxHeight) maxHeight = h;
	}

	const now = Date.now();
	let bpm = 0;
	if (maxHeight > lastHeight && lastHeightAt > 0) {
		const elapsed = (now - lastHeightAt) / 60_000;
		if (elapsed > 0) bpm = Math.round((maxHeight - lastHeight) / elapsed);
	}
	if (maxHeight > lastHeight) {
		lastHeight = maxHeight;
		lastHeightAt = now;
	}

	// Chain stall detection: alert if no new block in 3 minutes
	const stallMinutes = Math.round((now - lastHeightAt) / 60_000);
	if (stallMinutes >= 3 && lastHeight > 0) {
		const stallKey = "chain-stall";
		const lastStallAlert = lastAlertedAt.get(stallKey) ?? 0;
		if (now - lastStallAlert >= ALERT_COOLDOWN_MS) {
			lastAlertedAt.set(stallKey, now);
			const msg = `[STALL] Chain stuck at height ${lastHeight} for ${stallMinutes} minutes`;
			alertHistory.unshift({ timestamp: new Date().toISOString(), message: msg, level: "down" });
			if (alertHistory.length > MAX_ALERT_HISTORY) alertHistory.pop();
			await logAlert(msg);
			await sendWebhook(msg);
			await sendNtfy(msg, "urgent");
		}
	}

	const downCount = services.filter((s) => s.status === "down").length;
	const overall = downCount === 0 ? "operational" : downCount >= services.length / 2 ? "down" : "degraded";

	// Fetch agent/consciousness counts and validator count from ABCI chain state
	let ensouledAgents = 0;
	let consciousnessStored = 0;
	let validatorCount = 0;
	try {
		const statsResp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "stats", method: "abci_query", params: { path: "/stats" } }),
			signal: AbortSignal.timeout(5000),
		});
		if (statsResp.ok) {
			const result = (await statsResp.json()) as { result?: { response?: { value?: string } } };
			const val = result.result?.response?.value;
			if (val) {
				const statsData = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as {
					agentCount?: number;
					consciousnessCount?: number;
					consensusSetSize?: number;
				};
				ensouledAgents = statsData.agentCount ?? 0;
				consciousnessStored = statsData.consciousnessCount ?? 0;
				validatorCount = statsData.consensusSetSize ?? 0;
			}
		}
	} catch { /* non-fatal */ }

	health = {
		overall,
		services,
		fullNodes,
		aggregate: {
			blockHeight: maxHeight,
			validatorCount: validatorCount || 5,
			blocksPerMinute: bpm,
			ensouledAgents,
			consciousnessStored,
			fullNodeCount: fullNodes.length,
			uptime: Math.round((now - startedAt) / 1000),
		},
		checkedAt: now,
	};

	// Alerts: only fire on genuine failures, not normal fluctuations.
	// Alertable conditions:
	//   1. Validator transitions from signing to not_signing (once per hour max)
	//   2. Validator recovery: not_signing back to signing (once per hour max)
	// NOT alertable: "degraded", peer count changes, syncing status.
	for (const s of services) {
		const prev = previousStatuses.get(s.name);
		previousStatuses.set(s.name, s.status);

		// Only alert on transitions between "healthy" and "down"
		if (!prev || prev === s.status) continue;

		let msg: string | null = null;
		let level: AlertEntry["level"] = "info";
		let priority = "default";

		if (s.status === "down" && prev === "healthy") {
			msg = `[DOWN] ${s.name} is not signing`;
			level = "down";
			priority = "high";
		} else if (s.status === "healthy" && prev === "down") {
			msg = `[UP] ${s.name} is back online`;
			level = "up";
			priority = "low";
		}
		// All other transitions (degraded, etc.) are silently recorded, no push notification

		if (!msg) continue;

		// Deduplicate: same alert for the same service at most once per hour
		const alertKey = `${s.name}:${level}`;
		const lastSent = lastAlertedAt.get(alertKey) ?? 0;
		const now = Date.now();
		if (now - lastSent < ALERT_COOLDOWN_MS) continue;
		lastAlertedAt.set(alertKey, now);

		const ts = new Date().toISOString();
		alertHistory.unshift({ timestamp: ts, message: msg, level });
		if (alertHistory.length > MAX_ALERT_HISTORY) alertHistory.pop();

		await logAlert(msg);
		await sendWebhook(msg);
		await sendNtfy(msg, priority);
	}
}

async function logAlert(msg: string): Promise<void> {
	const ts = new Date().toISOString();
	try {
		await mkdir(LOG_DIR, { recursive: true });
		await appendFile(LOG_FILE, `[${ts}] ${msg}\n`);
	} catch { /* non-fatal */ }
	process.stderr.write(`[monitor] ${msg}\n`);
}

async function sendWebhook(msg: string): Promise<void> {
	if (!WEBHOOK_URL) return;
	try {
		await fetch(WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: msg, text: msg }),
			signal: AbortSignal.timeout(5000),
		});
	} catch { /* non-fatal */ }
}

// ── Social activity parsing ──────────────────────────────────────────

interface SocialEntry {
	timestamp: string;
	platform: "twitter" | "moltbook";
	type: "post" | "reply" | "comment";
	content: string;
	detail: string;
	link: string;
}

let socialFeed: SocialEntry[] = [];

let socialLogDepth = 50;

async function parseSocialActivity(): Promise<void> {
	const entries: SocialEntry[] = [];

	const twitterLink = "https://twitter.com/ensoul_network";
	const moltbookBase = "https://www.moltbook.com";

	// Helper: split on " | " to get title and detail from new log format
	function splitContent(raw: string): { title: string; detail: string } {
		const idx = raw.indexOf(" | ");
		if (idx === -1) return { title: raw.slice(0, 280), detail: "" };
		return { title: raw.slice(0, idx), detail: raw.slice(idx + 3).slice(0, 280) };
	}

	// Parse Twitter agent log
	try {
		const raw = await readFile(AGENT_LOG, "utf-8");
		const lines = raw.trim().split("\n").slice(-socialLogDepth);
		for (const line of lines) {
			const timeMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
			const ts = timeMatch ? timeMatch[1]! : "";

			if (line.includes("[agent] Posted:")) {
				const content = line.split("Posted:")[1]?.trim() ?? "";
				entries.push({ timestamp: ts, platform: "twitter", type: "post", content: content.slice(0, 280), detail: "", link: twitterLink });
			} else if (line.includes("[agent] Replied to @")) {
				// Format: Replied to @user: <full reply>
				const match = line.match(/Replied to @(\S+?):\s*(.*)/);
				const user = match?.[1] ?? "unknown";
				const text = match?.[2] ?? "";
				entries.push({ timestamp: ts, platform: "twitter", type: "reply", content: `@${user}`, detail: text.slice(0, 280), link: twitterLink });
			} else if (line.includes("[agent] Engaged with @")) {
				// Format: Engaged with @user: <full reply>
				const match = line.match(/Engaged with @(\S+?):\s*(.*)/);
				const user = match?.[1] ?? "unknown";
				const text = match?.[2] ?? "";
				entries.push({ timestamp: ts, platform: "twitter", type: "reply", content: `@${user}`, detail: text.slice(0, 280), link: twitterLink });
			}
		}
	} catch { /* no twitter log */ }

	// Parse Moltbook agent log
	try {
		const raw = await readFile(MOLTBOOK_LOG, "utf-8");
		const lines = raw.trim().split("\n").slice(-socialLogDepth);
		for (const line of lines) {
			const timeMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
			const ts = timeMatch ? timeMatch[1]! : "";

			if (line.includes("[agent] Posted in m/")) {
				// Format: Posted in m/<submolt>: <title> | <content>
				const match = line.match(/Posted in (m\/\S+?):\s*(.*)/);
				const submolt = match?.[1] ?? "m/general";
				const rest = match?.[2] ?? "";
				const { title, detail } = splitContent(rest);
				const link = `${moltbookBase}/${submolt}`;
				entries.push({ timestamp: ts, platform: "moltbook", type: "post", content: title, detail, link });
			} else if (line.includes("[agent] Commented on")) {
				// Format: Commented on "<title>" | <comment content>
				const match = line.match(/Commented on "(.+?)"\s*\|\s*(.*)/);
				const postTitle = match?.[1] ?? "";
				const commentText = match?.[2]?.slice(0, 280) ?? "";
				entries.push({ timestamp: ts, platform: "moltbook", type: "comment", content: `re: "${postTitle}"`, detail: commentText, link: `${moltbookBase}/u/ensoulnetwork` });
			} else if (line.includes("[agent] Replied to")) {
				// Format: Replied to <author> on "<title>" | <reply content>
				const match = line.match(/Replied to (\S+) on "(.+?)"\s*\|\s*(.*)/);
				const author = match?.[1] ?? "";
				const postTitle = match?.[2] ?? "";
				const replyText = match?.[3]?.slice(0, 280) ?? "";
				entries.push({ timestamp: ts, platform: "moltbook", type: "reply", content: `@${author} re: "${postTitle}"`, detail: replyText, link: `${moltbookBase}/u/ensoulnetwork` });
			} else if (line.includes("[agent] Responded to mention")) {
				// Format: Responded to mention "<title>" | <comment content>
				const match = line.match(/Responded to mention "(.+?)"\s*\|\s*(.*)/);
				const postTitle = match?.[1] ?? "";
				const commentText = match?.[2]?.slice(0, 280) ?? "";
				entries.push({ timestamp: ts, platform: "moltbook", type: "comment", content: `mention: "${postTitle}"`, detail: commentText, link: `${moltbookBase}/u/ensoulnetwork` });
			}
		}
	} catch { /* no moltbook log */ }

	// Sort by timestamp (reverse chronological, most recent first)
	entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	socialFeed = entries.slice(0, 40);
}

// ── Basic auth helper ────────────────────────────────────────────────

function checkBasicAuth(authHeader: string | undefined): boolean {
	if (!STATUS_PASSWORD) return true; // No password set, public access
	if (!authHeader) return false;
	const match = authHeader.match(/^Basic\s+(.+)$/);
	if (!match?.[1]) return false;
	const decoded = Buffer.from(match[1], "base64").toString("utf-8");
	return decoded === `admin:${STATUS_PASSWORD}`;
}

// ── Dashboard HTML ───────────────────────────────────────────────────

function renderDashboard(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ensoul Network Status</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:#09090b;color:#a1a1aa;line-height:1.6;-webkit-font-smoothing:antialiased;font-size:15px}
a{color:#7c5bf5;text-decoration:none;transition:color 0.2s}
a:hover{color:#fafafa}

/* Layout */
.wrap{max-width:960px;margin:0 auto;padding:24px}
.header{text-align:center;padding:32px 0 16px}
.header h1{font-family:'Plus Jakarta Sans',sans-serif;font-size:1.75rem;font-weight:800;color:#fafafa;letter-spacing:-0.02em;display:inline-flex;align-items:center;gap:12px}
.header .sub{color:#52525b;font-size:0.8125rem;margin-top:6px;font-family:'JetBrains Mono',monospace}

/* Overall status banner */
.overall{text-align:center;padding:20px;border-radius:12px;margin:24px 0;font-weight:600;font-size:1rem;border:1px solid}
.overall.operational{background:rgba(34,197,94,0.08);color:#22c55e;border-color:rgba(34,197,94,0.2)}
.overall.degraded{background:rgba(251,191,36,0.08);color:#fbbf24;border-color:rgba(251,191,36,0.2)}
.overall.down{background:rgba(239,68,68,0.08);color:#ef4444;border-color:rgba(239,68,68,0.2)}

/* Stats grid */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}
.stat-box{background:#111113;border:1px solid rgba(255,255,255,0.04);border-radius:12px;padding:20px;text-align:center;transition:all 0.2s}
.stat-box:hover{background:#161618;border-color:rgba(255,255,255,0.08)}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:500;color:#fafafa;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;line-height:1}
.stat-lbl{font-size:0.6875rem;color:#52525b;text-transform:uppercase;letter-spacing:0.08em;margin-top:6px}

/* Service cards */
.card{background:#111113;border:1px solid rgba(255,255,255,0.04);border-radius:12px;padding:16px 20px;margin:8px 0;display:flex;align-items:center;gap:14px;transition:all 0.2s}
.card:hover{background:#161618;border-color:rgba(255,255,255,0.08)}

/* Status dots - bigger, more prominent */
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot.healthy{background:#22c55e;box-shadow:0 0 12px rgba(34,197,94,0.4)}
.dot.down{background:#ef4444;box-shadow:0 0 12px rgba(239,68,68,0.4)}
.dot.degraded{background:#fbbf24;box-shadow:0 0 12px rgba(251,191,36,0.4)}

.card-info{flex:1;min-width:0}
.card-name{font-weight:600;font-size:0.9375rem;color:#fafafa}
.card-url{font-size:0.75rem;color:#52525b;word-break:break-all;font-family:'JetBrains Mono',monospace;margin-top:2px}
.card-details{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:6px;font-size:0.75rem;color:#a1a1aa;font-family:'JetBrains Mono',monospace}
.card-details b{color:#52525b;font-weight:500}
.card-details span{white-space:nowrap}
.card-time{font-size:0.75rem;color:#52525b;text-align:right;flex-shrink:0;font-family:'JetBrains Mono',monospace}

/* Section headers */
h2{font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:#52525b;text-transform:uppercase;letter-spacing:0.1em;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.04);font-weight:500}

/* Footer */
.footer{text-align:center;color:#52525b;font-size:0.8125rem;margin-top:48px;padding:24px 0;border-top:1px solid rgba(255,255,255,0.04);font-style:italic}
.footer a{color:#a1a1aa}
.footer a:hover{color:#fafafa}

/* Agents / pioneer entries */
.agent-entry{background:#111113;border:1px solid rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px;margin:6px 0;display:flex;gap:12px;align-items:center;font-size:0.875rem;transition:all 0.2s}
.agent-entry:hover{background:#161618;border-color:rgba(255,255,255,0.08)}
.agent-did{font-family:'JetBrains Mono',monospace;font-size:0.8125rem;color:#a1a1aa;flex:1;min-width:0;word-break:break-all}
.agent-date{color:#52525b;font-size:0.75rem;flex-shrink:0;font-family:'JetBrains Mono',monospace}
.agent-badge{padding:3px 10px;border-radius:100px;font-size:0.6875rem;font-weight:600;flex-shrink:0;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:0.05em}
.agent-badge.sent{background:rgba(34,197,94,0.1);color:#22c55e}
.agent-badge.pending{background:rgba(251,191,36,0.08);color:#fbbf24}
.agent-count{font-family:'JetBrains Mono',monospace;font-size:1.25rem;font-weight:500;color:#fafafa;margin-right:10px}

/* Social feed */
.social-scroll{max-height:500px;overflow-y:auto;border:1px solid rgba(255,255,255,0.04);border-radius:12px;background:#09090b;padding:4px}
.social-entry{background:#111113;border:1px solid rgba(255,255,255,0.04);border-radius:8px;padding:12px 14px;margin:4px;display:flex;gap:10px;align-items:flex-start;font-size:0.875rem;text-decoration:none;color:inherit;transition:all 0.2s}
.social-entry:hover{background:#161618;border-color:rgba(255,255,255,0.08)}
.social-icon{font-size:1.1em;flex-shrink:0;width:20px;text-align:center}
.social-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:100px;font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;font-family:'JetBrains Mono',monospace}
.social-badge.post{background:rgba(124,91,245,0.12);color:#9b7dff}
.social-badge.reply{background:rgba(96,165,250,0.1);color:#60a5fa}
.social-badge.comment{background:rgba(34,197,94,0.1);color:#22c55e}
.social-content{color:#a1a1aa;margin-top:4px;word-break:break-word;line-height:1.5;font-size:0.875rem}
.social-time{color:#52525b;font-size:0.75rem;font-weight:500;flex-shrink:0;min-width:55px;text-align:right;font-family:'JetBrains Mono',monospace}
.social-more{text-align:center;padding:10px;cursor:pointer;color:#a1a1aa;font-size:0.8125rem;font-weight:500;border:1px solid rgba(255,255,255,0.04);border-radius:8px;margin:8px 4px;background:#111113;transition:all 0.2s}
.social-more:hover{background:#161618;color:#fafafa;border-color:rgba(255,255,255,0.08)}

/* Tables (network peers) */
table{width:100%;border-collapse:collapse;font-size:0.8125rem}
th{padding:10px 12px;text-align:left;color:#52525b;font-family:'JetBrains Mono',monospace;text-transform:uppercase;font-size:0.6875rem;letter-spacing:0.08em;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.04)}
td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.04);color:#a1a1aa}
tbody tr{transition:background 0.15s}
tbody tr:hover{background:rgba(255,255,255,0.015)}

@media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}.wrap{padding:16px}.header h1{font-size:1.375rem}}
</style>
</head>
<body>
<div class="wrap">
<div class="header">
<h1 style="display:inline-flex;align-items:center;gap:10px"><svg viewBox="0 0 110 110" width="32" height="32"><circle cx="55" cy="55" r="42" fill="none" stroke="#7C6AE8" stroke-width="1.5"/><path d="M55 28 C55 28, 38 48, 38 60 C38 73, 45 82, 55 82 C65 82, 72 73, 72 60 C72 48, 55 28, 55 28 Z" fill="#7C6AE8"/><circle cx="55" cy="62" r="4" fill="white" opacity="0.9"/></svg>Ensoul Network Status</h1>
<div class="sub">Auto-refreshes every 30 seconds</div>
</div>
<div id="content">Loading...</div>
<div id="agents"></div>
<div id="social"></div>
<div id="admin"></div>
<div id="fullnodes"></div>
<div class="footer"><a href="https://ensoul.dev">ensoul.dev</a> | <a href="https://explorer.ensoul.dev">Explorer</a> | <a href="https://github.com/suitandclaw/ensoul">GitHub</a></div>
</div>
<script>
function shortTime(ts){if(!ts)return"never";var d=new Date(ts);return d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}
function utcToLocal(hms){if(!hms)return"";var p=hms.split(":");var d=new Date();d.setUTCHours(+p[0],+p[1],+p[2]||0,0);return d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}
function render(h){
var o=h.overall==="operational"?"All systems operational":h.overall==="degraded"?"Some services degraded":"Network issues detected";
var s='<div class="overall '+h.overall+'">'+o+'</div>';
s+='<div class="stats">';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.blockHeight+'</div><div class="stat-lbl">Block Height</div></div>';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.validatorCount+'</div><div class="stat-lbl">Validators</div></div>';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.blocksPerMinute+'</div><div class="stat-lbl">Blocks/min</div></div>';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.ensouledAgents+'</div><div class="stat-lbl">Ensouled Agents</div></div>';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.consciousnessStored+'</div><div class="stat-lbl">Consciousness Stored</div></div>';
var um=Math.floor(h.aggregate.uptime/60);var uh=Math.floor(um/60);
s+='<div class="stat-box"><div class="stat-val">'+(uh>0?uh+'h':um+'m')+'</div><div class="stat-lbl">Monitor Uptime</div></div>';
s+='</div>';
var groups={};
h.services.forEach(function(svc){
var g=svc.name.startsWith("Validator")?"Validators":svc.name;
if(!groups[g])groups[g]=[];
groups[g].push(svc);
});
for(var gn in groups){
s+='<h2>'+gn+'</h2>';
groups[gn].forEach(function(svc){
var dets='';
for(var k in svc.details){dets+='<span><b>'+k+':</b> '+svc.details[k]+'</span>';}
s+='<div class="card">';
s+='<div class="dot '+svc.status+'"></div>';
s+='<div class="card-info"><div class="card-name">'+svc.name+'</div>';
if(svc.url!=="local")s+='<div class="card-url">'+svc.url+'</div>';
if(dets)s+='<div class="card-details">'+dets+'</div>';
s+='</div>';
s+='<div class="card-time">'+shortTime(svc.lastSeen)+'</div>';
s+='</div>';
});
}
s+='<div style="text-align:center;color:#666;font-size:0.75em;margin-top:12px">Last check: '+shortTime(h.checkedAt)+'</div>';
document.getElementById("content").innerHTML=s;
renderAdmin(h);
// Render full nodes section
var fnEl=document.getElementById("fullnodes");
if(fnEl&&h.fullNodes&&h.fullNodes.length>0){
var fs='<h2>Network Peers ('+h.fullNodes.length+' full nodes)</h2>';
fs+='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.85em">';
fs+='<tr style="border-bottom:1px solid #2d2d3f"><th style="padding:6px;text-align:left;color:#888">Node</th><th style="padding:6px;color:#888">IP</th><th style="padding:6px;color:#888">Version</th><th style="padding:6px;color:#888">Type</th></tr>';
h.fullNodes.forEach(function(fn){
fs+='<tr style="border-bottom:1px solid #1e1e2a"><td style="padding:6px">'+fn.moniker+'</td><td style="padding:6px;font-family:monospace;font-size:0.8em">'+fn.ip+'</td><td style="padding:6px">'+fn.version+'</td><td style="padding:6px;color:#60a5fa">Full Node</td></tr>';
});
fs+='</table></div>';
fnEl.innerHTML=fs;
}else if(fnEl){fnEl.innerHTML='';}
}
function renderSocial(entries){
var el=document.getElementById("social");
if(!el)return;
if(!entries||entries.length===0){el.innerHTML='<h2>Social Activity</h2><div style="color:#666;font-size:0.85em;padding:12px">No recent activity detected in agent logs.</div>';return;}
var s='<div class="social-scroll">';
entries.forEach(function(e){
var icon=e.platform==='twitter'?'&#x1F426;':'&#x1F99E;';
var link=e.link||(e.platform==='twitter'?'https://twitter.com/ensoul_network':'https://www.moltbook.com/u/ensoulnetwork');
s+='<a class="social-entry" href="'+link+'" target="_blank" rel="noopener">';
s+='<span class="social-time">'+utcToLocal(e.timestamp)+'</span>';
s+='<span class="social-icon">'+icon+'</span>';
s+='<div style="flex:1;min-width:0"><span class="social-badge '+e.type+'">'+e.type+'</span> ';
s+='<span class="social-content">'+e.content+'</span>';
if(e.detail)s+='<div style="color:#777;font-size:0.85em;margin-top:3px;line-height:1.3">'+e.detail+'</div>';
s+='</div>';
s+='</a>';
});
s+='</div>';
s+='<div class="social-more" id="load-more-btn" onclick="loadMore()">Load more</div>';
el.innerHTML='<h2>Social Activity</h2>'+s;
}
function loadMore(){
var btn=document.getElementById("load-more-btn");
if(btn)btn.textContent="Loading...";
fetch("/api/social?depth=200").then(function(r){return r.json()}).then(function(d){
renderSocial(d);
var btn2=document.getElementById("load-more-btn");
if(btn2)btn2.style.display="none";
}).catch(function(){
var btn3=document.getElementById("load-more-btn");
if(btn3)btn3.textContent="Load failed. Try again.";
});
}
function renderAgents(data){
var el=document.getElementById("agents");
if(!el||!data)return;
var agents=data.agents||[];
if(agents.length===0){el.innerHTML='';return;}
var s='<h2><span class="agent-count">'+data.total+'</span>Ensouled Agents</h2>';
s+='<div class="social-scroll" style="max-height:300px">';
agents.forEach(function(a){
s+='<div class="agent-entry">';
s+='<span class="agent-did">'+a.didShort+'</span>';
s+='<span class="agent-badge '+(a.bonusSent?'sent':'pending')+'">'+(a.bonusSent?'bonus sent':'pending')+'</span>';
s+='<span class="agent-date">'+(a.lastStore?new Date(a.lastStore).toLocaleDateString():'no store')+'</span>';
s+='</div>';
});
s+='</div>';
el.innerHTML=s;
}
function poll(){
fetch("/api/health",{credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(render).catch(function(e){document.getElementById("content").innerHTML='<div class="overall down">Failed to load: '+e.message+'</div>';});
fetch("/api/social",{credentials:"same-origin"}).then(function(r){return r.json()}).then(renderSocial).catch(function(){});
fetch("https://api.ensoul.dev/v1/agents/list",{mode:"cors"}).then(function(r){return r.json()}).then(renderAgents).catch(function(){});
}
poll();
setInterval(poll,30000);

// ── Unified Validator Management Panel ──────────────────
// Merges health data from /api/health with admin actions from static config.
// Validators in configs get Update/Restart/Logs buttons. Auto-discovered ones show health only.
var CONFIGURED_INDICES=${JSON.stringify(Object.fromEntries(VALIDATOR_CONFIGS.map((v, i) => [v.moniker, i])))};
var currentOpId=null;
var logsModal={open:false,index:-1,timer:null};

function adminFetch(url,opts){
opts=opts||{};
opts.credentials="same-origin";
return fetch(url,opts);
}

function renderAdmin(healthData){
var el=document.getElementById("admin");
if(!el)return;
if(!healthData)return;

// Extract validator services from health data
var validators=(healthData.services||[]).filter(function(s){return s.name.indexOf("Validator")===0||s.name.indexOf("(discovered)")>-1;});
var onlineCount=validators.filter(function(v){return v.status==="healthy";}).length;

var s='<h2>Validators ('+onlineCount+'/'+validators.length+' online)</h2>';
s+='<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">';
s+='<button onclick="adminUpdateAll()" style="padding:6px 14px;background:#2d1e3f;color:#a78bfa;border:1px solid #2d2d3f;border-radius:4px;cursor:pointer;font-size:0.85em">Update All</button>';
s+='</div>';

s+='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:0.85em">';
s+='<tr style="border-bottom:1px solid #2d2d3f"><th style="padding:6px 8px;text-align:left;color:#888">Validator</th><th style="padding:6px;color:#888">Height</th><th style="padding:6px;color:#888">Peers</th><th style="padding:6px;color:#888">Health</th><th style="padding:6px;color:#888">Actions</th></tr>';

validators.forEach(function(v){
var det=v.details||{};
var isOnline=v.status==="healthy";
var dot=isOnline?'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80"></span>':'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171"></span>';
var statusText=det.catchingUp?'<span style="color:#fbbf24">SYNCING</span>':(isOnline?'<span style="color:#4ade80">OK</span>':'<span style="color:#f87171">DOWN</span>');
var name=v.name.replace("Validator ","").replace(" (discovered)","*");

// Check if this validator has SSH config (action buttons available)
var moniker=det.moniker||"";
var cfgIdx=CONFIGURED_INDICES[moniker];
var hasConfig=cfgIdx!==undefined;

s+='<tr style="border-bottom:1px solid #1e1e2a">';
s+='<td style="padding:6px 8px">'+dot+' '+name+'</td>';
s+='<td style="padding:6px">'+(det.height||'-')+'</td>';
s+='<td style="padding:6px">'+(det.peers!=null?det.peers:'-')+'</td>';
s+='<td style="padding:6px">'+statusText+'</td>';
s+='<td style="padding:6px;white-space:nowrap">';
if(hasConfig){
s+='<button onclick="adminUpdate('+cfgIdx+')" style="padding:2px 8px;background:#2d1e3f;color:#a78bfa;border:1px solid #2d2d3f;border-radius:3px;cursor:pointer;font-size:0.8em;margin:1px">Update</button> ';
s+='<button onclick="adminRestart('+cfgIdx+')" style="padding:2px 8px;background:#1e3f2d;color:#4ade80;border:1px solid #2d2d3f;border-radius:3px;cursor:pointer;font-size:0.8em;margin:1px">Restart</button> ';
s+='<button onclick="adminLogs('+cfgIdx+')" style="padding:2px 8px;background:#1e2a3f;color:#60a5fa;border:1px solid #2d2d3f;border-radius:3px;cursor:pointer;font-size:0.8em;margin:1px">Logs</button>';
}else{
s+='<span style="color:#555;font-size:0.8em" title="Add SSH config to enable management">no SSH config</span>';
}
s+='</td></tr>';
});

s+='</table></div>';
s+='<div id="admin-status" style="font-size:0.8em;color:#888;margin:4px 0"></div>';
s+='<pre id="admin-log" style="display:none;background:#0a0a0f;border:1px solid #2d2d3f;border-radius:6px;padding:12px;font-size:0.8em;max-height:300px;overflow-y:auto;white-space:pre-wrap;margin:8px 0"></pre>';
s+='<div id="logs-modal" style="display:none;background:#0a0a0f;border:1px solid #2d2d3f;border-radius:8px;padding:16px;margin:8px 0"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 id="logs-title" style="margin:0;font-size:0.95em;color:#60a5fa">Logs</h3><button onclick="closeLogs()" style="background:none;border:1px solid #2d2d3f;color:#888;border-radius:3px;cursor:pointer;padding:2px 8px">Close</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><div style="color:#888;font-size:0.75em;margin-bottom:4px">ABCI Server</div><pre id="logs-abci" style="background:#12121a;border:1px solid #1e1e2a;border-radius:4px;padding:8px;font-size:0.75em;max-height:250px;overflow-y:auto;white-space:pre-wrap;margin:0"></pre></div><div><div style="color:#888;font-size:0.75em;margin-bottom:4px">CometBFT</div><pre id="logs-cometbft" style="background:#12121a;border:1px solid #1e1e2a;border-radius:4px;padding:8px;font-size:0.75em;max-height:250px;overflow-y:auto;white-space:pre-wrap;margin:0"></pre></div></div></div>';
el.innerHTML=s;
}

function adminStatus(msg){var el=document.getElementById("admin-status");if(el)el.textContent=msg;}

function showOpLog(lines){
var el=document.getElementById("admin-log");
if(!el)return;
el.style.display="block";
el.textContent=lines.join("\\n");
el.scrollTop=el.scrollHeight;
}

function pollOp(opId){
currentOpId=opId;
var interval=setInterval(function(){
adminFetch("/admin/op/"+opId).then(function(r){return r.json()}).then(function(d){
showOpLog(d.log||[]);
adminStatus(d.status);
if(d.done){
clearInterval(interval);
currentOpId=null;
adminStatus(d.success?"Completed successfully.":"Completed with errors.");
}
}).catch(function(){clearInterval(interval);currentOpId=null;});
},2000);
}

function adminHealthAll(){
adminStatus("Refreshing...");
poll();
}

function adminUpdate(idx){
if(currentOpId){adminStatus("Another operation is in progress.");return;}
if(!confirm("Update validator "+idx+"? This will pull, build, and restart."))return;
adminStatus("Starting update...");
adminFetch("/admin/update/"+idx,{method:"POST"}).then(function(r){return r.json()}).then(function(d){
if(d.error){adminStatus("Error: "+d.error);return;}
adminStatus(d.message);
pollOp(d.opId);
}).catch(function(e){adminStatus("Failed: "+e);});
}

function adminRestart(idx){
if(currentOpId){adminStatus("Another operation is in progress.");return;}
if(!confirm("Restart CometBFT and ABCI on validator "+idx+"? The chain continues on other validators."))return;
adminStatus("Starting restart...");
adminFetch("/admin/restart/"+idx,{method:"POST"}).then(function(r){return r.json()}).then(function(d){
if(d.error){adminStatus("Error: "+d.error);return;}
adminStatus(d.message);
pollOp(d.opId);
}).catch(function(e){adminStatus("Failed: "+e);});
}

function adminUpdateAll(){
if(currentOpId){adminStatus("Another operation is in progress.");return;}
if(!confirm("Update ALL validators sequentially? This will take several minutes."))return;
adminStatus("Starting sequential update...");
adminFetch("/admin/update-all",{method:"POST"}).then(function(r){return r.json()}).then(function(d){
if(d.error){adminStatus("Error: "+d.error);return;}
adminStatus(d.message);
pollOp(d.opId);
}).catch(function(e){adminStatus("Failed: "+e);});
}

function adminLogs(idx){
var modal=document.getElementById("logs-modal");
var title=document.getElementById("logs-title");
if(!modal)return;
modal.style.display="block";
title.textContent="Logs: Validator "+idx;
logsModal.open=true;
logsModal.index=idx;
fetchLogs(idx);
if(logsModal.timer)clearInterval(logsModal.timer);
logsModal.timer=setInterval(function(){if(logsModal.open)fetchLogs(logsModal.index);},10000);
}

function fetchLogs(idx){
adminFetch("/admin/logs/"+idx).then(function(r){return r.json()}).then(function(d){
var a=document.getElementById("logs-abci");
var c=document.getElementById("logs-cometbft");
if(a)a.textContent=d.abci||"No data";
if(c)c.textContent=d.cometbft||"No data";
}).catch(function(){});
}

function closeLogs(){
logsModal.open=false;
if(logsModal.timer){clearInterval(logsModal.timer);logsModal.timer=null;}
var modal=document.getElementById("logs-modal");
if(modal)modal.style.display="none";
}

// Admin panel renders from the same health data as the main dashboard.
// No separate refresh needed.
</script>
</body>
</html>`;
}

// ── Server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });

	const app = Fastify({ logger: false });

	// Basic auth on all routes except /api/health
	if (STATUS_PASSWORD) {
		app.addHook("onRequest", (req, reply, done) => {
			// API endpoints are public (data only, no admin actions)
			if (req.url.startsWith("/api/")) { done(); return; }

			if (!checkBasicAuth(req.headers.authorization)) {
				void reply
					.status(401)
					.header("WWW-Authenticate", 'Basic realm="Ensoul Status"')
					.send("Unauthorized");
				return;
			}
			done();
		});
		await logAlert("Basic auth enabled (ENSOUL_STATUS_PASSWORD set)");
	}

	// ── Favicons ────────────────────────────────────────────────

	const faviconDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "favicons");
	const faviconFiles: Record<string, { file: string; mime: string }> = {
		"/favicon.ico": { file: "favicon.ico", mime: "image/x-icon" },
		"/favicon-32x32.png": { file: "favicon-32x32.png", mime: "image/png" },
		"/favicon-16x16.png": { file: "favicon-16x16.png", mime: "image/png" },
		"/apple-touch-icon.png": { file: "apple-touch-icon.png", mime: "image/png" },
		"/android-chrome-192x192.png": { file: "android-chrome-192x192.png", mime: "image/png" },
		"/android-chrome-512x512.png": { file: "android-chrome-512x512.png", mime: "image/png" },
	};

	for (const [route, info] of Object.entries(faviconFiles)) {
		app.get(route, async (_req, reply) => {
			try {
				const data = await readFile(join(faviconDir, info.file));
				return reply.type(info.mime).send(data);
			} catch {
				return reply.status(404).send("Not found");
			}
		});
	}

	app.get("/", async (_req, reply) => {
		return reply.type("text/html").send(renderDashboard());
	});

	app.get("/api/health", async () => {
		return health;
	});

	app.get("/api/alerts", async () => {
		return { alerts: alertHistory, count: alertHistory.length };
	});

	// Proxy validator status via CometBFT RPC on Tailscale IPs
	app.get("/api/validators-admin", async () => {
		const results: Array<Record<string, unknown>> = [];
		for (const vc of VALIDATOR_CONFIGS) {
			const url = `http://${vc.tailscaleIp}:${vc.rpcPort}`;
			try {
				const resp = await fetch(`${url}/status`, { signal: AbortSignal.timeout(5000) });
				if (!resp.ok) { results.push({ url, name: vc.name, error: true }); continue; }
				const data = (await resp.json()) as { result: { sync_info: { latest_block_height: string; catching_up: boolean }; node_info: { moniker: string } } };
				const si = data.result.sync_info;
				const ni = data.result.node_info;
				let peers = 0;
				try {
					const netResp = await fetch(`${url}/net_info`, { signal: AbortSignal.timeout(3000) });
					if (netResp.ok) {
						const nd = (await netResp.json()) as { result: { n_peers: string } };
						peers = Number(nd.result.n_peers);
					}
				} catch { /* non-fatal */ }
				results.push({ url, name: vc.name, moniker: ni.moniker, height: Number(si.latest_block_height), peerCount: peers, catchingUp: si.catching_up, version: "1.0" });
			} catch {
				results.push({ url, name: vc.name, error: true });
			}
		}
		return { validators: results };
	});

	// Agent analytics
	app.get("/api/agent-analytics", async () => {
		try {
			const { readFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const { homedir } = await import("node:os");
			const h = homedir();
			const results: Record<string, unknown> = {};
			for (const platform of ["twitter", "moltbook"]) {
				try {
					const raw = await readFile(join(h, ".ensoul", `${platform}-analytics.json`), "utf-8");
					const data = JSON.parse(raw) as { posts: Array<Record<string, unknown>>; dailyCounts: Record<string, unknown> };
					results[platform] = {
						totalPosts: data.posts.length,
						dailyCounts: data.dailyCounts,
						topPosts: data.posts
							.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
								(Number(b["likes"] ?? 0) + Number(b["replies"] ?? 0)) - (Number(a["likes"] ?? 0) + Number(a["replies"] ?? 0)))
							.slice(0, 5)
							.map((p: Record<string, unknown>) => ({
								content: String(p["content"] ?? "").slice(0, 100),
								likes: p["likes"],
								replies: p["replies"],
								topic: p["topic"],
							})),
					};
				} catch { results[platform] = { error: "No analytics data" }; }
			}
			return results;
		} catch {
			return { error: "Analytics not available" };
		}
	});

	// Network health (read from file written by network-monitor.sh)
	app.get("/api/network-health", async () => {
		try {
			const { readFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const { homedir } = await import("node:os");
			const raw = await readFile(join(homedir(), ".ensoul", "network-health.json"), "utf-8");
			return JSON.parse(raw);
		} catch {
			return { error: "Health data not available. Is network-monitor.sh running?" };
		}
	});

	app.get<{ Querystring: { depth?: string } }>("/api/social", async (req) => {
		const depth = Number(req.query.depth ?? 50);
		if (depth > socialLogDepth) {
			socialLogDepth = Math.min(depth, 500);
			await parseSocialActivity();
		}
		return socialFeed;
	});

	// ── Admin operations (require basic auth) ───────────────────

	/** Verify admin auth for POST admin routes. */
	function requireAdmin(authHeader: string | undefined): boolean {
		if (!STATUS_PASSWORD) return true;
		return checkBasicAuth(authHeader);
	}

	/** POST /admin/update/:index - Pull, build, restart a single validator. */
	app.post<{ Params: { index: string } }>("/admin/update/:index", async (req, reply) => {
		if (!requireAdmin(req.headers.authorization)) {
			return reply.status(401).send({ error: "Unauthorized" });
		}
		const idx = Number(req.params.index);
		const vc = VALIDATOR_CONFIGS[idx];
		if (!vc) return reply.status(404).send({ error: "Validator not found" });

		const opId = `update-${idx}-${Date.now()}`;
		const op = { status: "running", log: [] as string[], done: false, success: false };
		adminOps.set(opId, op);

		const addLog = (msg: string): void => { op.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); op.status = msg; };

		// Run in background so the response returns immediately
		void (async () => {
			try {
				addLog(`Starting update on ${vc.moniker}...`);

				addLog("Pulling latest code...");
				await runOnValidator(vc, "cd ~/ensoul && git pull origin main", 30_000);
				addLog("Pull complete.");

				addLog("Clearing build cache...");
				await runOnValidator(vc, "cd ~/ensoul && rm -rf .turbo node_modules/.cache packages/*/dist", 15_000);
				addLog("Cache cleared.");

				addLog("Building...");
				await runOnValidator(vc, "cd ~/ensoul && bash -l -c 'pnpm install --frozen-lockfile && pnpm build'", 300_000);
				addLog("Build complete.");

				addLog("Restarting ABCI server...");
				if (vc.role === "cloud") {
					await runOnValidator(vc, "systemctl restart ensoul-abci", 15_000);
				} else {
					// macOS: kill by port and restart via process-manager pattern
					await runOnValidator(vc, "lsof -ti :26658 | xargs kill 2>/dev/null; sleep 2; cd ~/ensoul && nohup bash -l -c 'npx tsx packages/abci-server/src/index.ts --port 26658' >> ~/.ensoul/abci-server.log 2>&1 &", 15_000);
				}
				addLog("ABCI restarted. Waiting 5s...");
				await new Promise((r) => setTimeout(r, 5000));

				addLog("Restarting CometBFT...");
				if (vc.role === "cloud") {
					await runOnValidator(vc, "systemctl restart ensoul-cometbft", 15_000);
				} else {
					await runOnValidator(vc, "lsof -ti :26657 | xargs kill 2>/dev/null; lsof -ti :26656 | xargs kill 2>/dev/null; sleep 2; cd ~/ensoul && DAEMON_NAME=cometbft DAEMON_HOME=~/.cometbft-ensoul/node DAEMON_DATA_BACKUP_DIR=~/.cometbft-ensoul/node/backups DAEMON_ALLOW_DOWNLOAD_BINARIES=false DAEMON_RESTART_AFTER_UPGRADE=true nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home ~/.cometbft-ensoul/node >> ~/.ensoul/cometbft.log 2>&1 &", 15_000);
				}
				addLog("CometBFT restarted. Waiting for block...");

				const healthy = await waitForBlock(vc, 90);
				if (healthy) {
					addLog("Validator is healthy and signing blocks.");
					op.success = true;
				} else {
					addLog("WARNING: Validator did not become healthy within 90 seconds.");
				}
			} catch (err) {
				addLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				op.done = true;
			}
		})();

		return { opId, message: `Update started on ${vc.moniker}` };
	});

	/** POST /admin/restart/:index - Restart ABCI and CometBFT. */
	app.post<{ Params: { index: string } }>("/admin/restart/:index", async (req, reply) => {
		if (!requireAdmin(req.headers.authorization)) {
			return reply.status(401).send({ error: "Unauthorized" });
		}
		const idx = Number(req.params.index);
		const vc = VALIDATOR_CONFIGS[idx];
		if (!vc) return reply.status(404).send({ error: "Validator not found" });

		const opId = `restart-${idx}-${Date.now()}`;
		const op = { status: "running", log: [] as string[], done: false, success: false };
		adminOps.set(opId, op);

		const addLog = (msg: string): void => { op.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); op.status = msg; };

		void (async () => {
			try {
				addLog(`Restarting services on ${vc.moniker}...`);

				addLog("Stopping CometBFT...");
				if (vc.role === "cloud") {
					await runOnValidator(vc, "systemctl stop ensoul-cometbft", 15_000);
				} else {
					await runOnValidator(vc, "lsof -ti :26657 | xargs kill 2>/dev/null; lsof -ti :26656 | xargs kill 2>/dev/null", 10_000);
				}

				addLog("Stopping ABCI...");
				if (vc.role === "cloud") {
					await runOnValidator(vc, "systemctl stop ensoul-abci", 15_000);
				} else {
					await runOnValidator(vc, "lsof -ti :26658 | xargs kill 2>/dev/null", 10_000);
				}

				await new Promise((r) => setTimeout(r, 2000));

				addLog("Starting ABCI...");
				if (vc.role === "cloud") {
					await runOnValidator(vc, "systemctl start ensoul-abci", 15_000);
				} else {
					await runOnValidator(vc, "cd ~/ensoul && nohup bash -l -c 'npx tsx packages/abci-server/src/index.ts --port 26658' >> ~/.ensoul/abci-server.log 2>&1 &", 15_000);
				}

				addLog("Waiting 3s for ABCI...");
				await new Promise((r) => setTimeout(r, 3000));

				addLog("Starting CometBFT...");
				if (vc.role === "cloud") {
					await runOnValidator(vc, "systemctl start ensoul-cometbft", 15_000);
				} else {
					await runOnValidator(vc, "cd ~/ensoul && DAEMON_NAME=cometbft DAEMON_HOME=~/.cometbft-ensoul/node DAEMON_DATA_BACKUP_DIR=~/.cometbft-ensoul/node/backups DAEMON_ALLOW_DOWNLOAD_BINARIES=false DAEMON_RESTART_AFTER_UPGRADE=true nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home ~/.cometbft-ensoul/node >> ~/.ensoul/cometbft.log 2>&1 &", 15_000);
				}

				addLog("Waiting for validator to sign a block...");
				const healthy = await waitForBlock(vc, 60);
				if (healthy) {
					addLog("Validator is healthy.");
					op.success = true;
				} else {
					addLog("WARNING: Validator did not recover within 60 seconds.");
				}
			} catch (err) {
				addLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				op.done = true;
			}
		})();

		return { opId, message: `Restart started on ${vc.moniker}` };
	});

	/** POST /admin/update-all - Sequential update across all validators. */
	app.post("/admin/update-all", async (req, reply) => {
		if (!requireAdmin(req.headers.authorization)) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const opId = `update-all-${Date.now()}`;
		const op = { status: "running", log: [] as string[], done: false, success: false };
		adminOps.set(opId, op);

		const addLog = (msg: string): void => { op.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); op.status = msg; };

		void (async () => {
			let allOk = true;
			for (let i = 0; i < VALIDATOR_CONFIGS.length; i++) {
				const vc = VALIDATOR_CONFIGS[i]!;
				addLog(`[${i + 1}/${VALIDATOR_CONFIGS.length}] Updating ${vc.moniker}...`);
				try {
					await runOnValidator(vc, "cd ~/ensoul && git pull origin main", 30_000);
					await runOnValidator(vc, "cd ~/ensoul && rm -rf .turbo node_modules/.cache packages/*/dist", 15_000);
					await runOnValidator(vc, "cd ~/ensoul && bash -l -c 'pnpm install --frozen-lockfile && pnpm build'", 300_000);
					addLog(`${vc.moniker} built. Restarting ABCI...`);

					if (vc.role === "cloud") {
						await runOnValidator(vc, "systemctl restart ensoul-abci", 15_000);
						await new Promise((r) => setTimeout(r, 5000));
						await runOnValidator(vc, "systemctl restart ensoul-cometbft", 15_000);
					} else {
						await runOnValidator(vc, "lsof -ti :26658 | xargs kill 2>/dev/null; sleep 2; cd ~/ensoul && nohup bash -l -c 'npx tsx packages/abci-server/src/index.ts --port 26658' >> ~/.ensoul/abci-server.log 2>&1 &", 15_000);
						await new Promise((r) => setTimeout(r, 5000));
						await runOnValidator(vc, "lsof -ti :26657 | xargs kill 2>/dev/null; lsof -ti :26656 | xargs kill 2>/dev/null; sleep 2; cd ~/ensoul && DAEMON_NAME=cometbft DAEMON_HOME=~/.cometbft-ensoul/node DAEMON_DATA_BACKUP_DIR=~/.cometbft-ensoul/node/backups DAEMON_ALLOW_DOWNLOAD_BINARIES=false DAEMON_RESTART_AFTER_UPGRADE=true nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home ~/.cometbft-ensoul/node >> ~/.ensoul/cometbft.log 2>&1 &", 15_000);
					}

					addLog(`${vc.moniker} restarted. Waiting for block...`);
					const healthy = await waitForBlock(vc, 90);
					if (healthy) {
						addLog(`${vc.moniker} healthy.`);
					} else {
						addLog(`WARNING: ${vc.moniker} did not recover. Continuing.`);
						allOk = false;
					}
				} catch (err) {
					addLog(`ERROR on ${vc.moniker}: ${err instanceof Error ? err.message : String(err)}`);
					allOk = false;
				}
			}
			op.success = allOk;
			addLog(allOk ? "All validators updated successfully." : "Update completed with errors.");
			op.done = true;
		})();

		return { opId, message: "Sequential update started" };
	});

	/** GET /admin/op/:id - Poll operation progress. */
	app.get<{ Params: { id: string } }>("/admin/op/:id", async (req, reply) => {
		if (!requireAdmin(req.headers.authorization)) {
			return reply.status(401).send({ error: "Unauthorized" });
		}
		const op = adminOps.get(req.params.id);
		if (!op) return reply.status(404).send({ error: "Operation not found" });
		return { status: op.status, log: op.log, done: op.done, success: op.success };
	});

	/** GET /admin/logs/:index - Retrieve recent logs from a validator. */
	app.get<{ Params: { index: string } }>("/admin/logs/:index", async (req, reply) => {
		if (!requireAdmin(req.headers.authorization)) {
			return reply.status(401).send({ error: "Unauthorized" });
		}
		const idx = Number(req.params.index);
		const vc = VALIDATOR_CONFIGS[idx];
		if (!vc) return reply.status(404).send({ error: "Validator not found" });

		try {
			const abciLog = await runOnValidator(vc, "tail -50 ~/.ensoul/abci-server.log 2>/dev/null || echo 'No ABCI log'", 10_000);
			const cometLog = await runOnValidator(vc, "tail -50 ~/.ensoul/cometbft.log 2>/dev/null || echo 'No CometBFT log'", 10_000);
			return { validator: vc.moniker, abci: abciLog, cometbft: cometLog };
		} catch (err) {
			return reply.status(500).send({ error: err instanceof Error ? err.message : "Failed to retrieve logs" });
		}
	});

	// Initial poll
	await pollAll();
	await parseSocialActivity();

	// Start polling loop
	const timer = setInterval(() => {
		void pollAll();
		void parseSocialActivity();
	}, POLL_INTERVAL);

	await app.listen({ port, host: "0.0.0.0" });

	process.stdout.write(`Ensoul Monitor running on http://localhost:${port}\n`);
	process.stdout.write(`  Dashboard: http://localhost:${port}/\n`);
	process.stdout.write(`  Health API: http://localhost:${port}/api/health\n`);
	if (WEBHOOK_URL) {
		process.stdout.write(`  Webhook: ${WEBHOOK_URL.slice(0, 40)}...\n`);
	}
	process.stdout.write(`\n  Polling ${VALIDATORS.length + 3} services every ${POLL_INTERVAL / 1000}s\n\n`);

	const shutdown = async (): Promise<void> => {
		clearInterval(timer);
		await app.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`Fatal: ${msg}\n`);
	process.exit(1);
});
