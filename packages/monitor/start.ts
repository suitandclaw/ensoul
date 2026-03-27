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
import { homedir } from "node:os";

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 4000);
const POLL_INTERVAL = 30_000;
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "monitor.log");
const AGENT_LOG = join(LOG_DIR, "agent.log");
const MOLTBOOK_LOG = join(LOG_DIR, "moltbook-agent.log");
const WEBHOOK_URL = process.env["ALERT_WEBHOOK_URL"] ?? "";
const STATUS_PASSWORD = process.env["ENSOUL_STATUS_PASSWORD"] ?? "";

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

// Load validator list from config file (not hardcoded)
// Always use Tailscale IP + CometBFT RPC for health checks (reliable, no tunnel dependency)
const VALIDATORS: Array<{ name: string; url: string }> = (() => {
	try {
		const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "configs", "validators.json");
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as { validators: Array<{ name: string; publicUrl: string | null; tailscaleIp: string; publicIp?: string; rpcPort: number }> };
		return config.validators.map((v) => ({
			name: v.name,
			url: `http://${v.tailscaleIp}:${v.rpcPort}`,
		}));
	} catch {
		// Fallback if config file is missing
		return [
			{ name: "Validator v0 (MacBook Pro)", url: "http://localhost:26657" },
		];
	}
})();

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
			name, url, status: si.catching_up ? "degraded" : "healthy", lastSeen: Date.now(),
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
			name, url: "local", status: isRecent ? "healthy" : "degraded", lastSeen: Date.now(),
			details: { lastLine: lastLine.slice(0, 80) },
		};
	} catch {
		return { name, url: "local", status: "down", lastSeen: 0, details: { error: "Log not found" } };
	}
}

async function pollAll(): Promise<void> {
	const services: ServiceStatus[] = [];

	// Validators
	const validatorResults = await Promise.allSettled(
		VALIDATORS.map((v) => checkValidator(v.name, v.url)),
	);
	for (const r of validatorResults) {
		services.push(r.status === "fulfilled" ? r.value : { name: "Validator", url: "", status: "down", lastSeen: 0, details: {} });
	}

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

	const downCount = services.filter((s) => s.status === "down").length;
	const overall = downCount === 0 ? "operational" : downCount >= services.length / 2 ? "down" : "degraded";

	// Fetch agent/consciousness counts and validator count from ABCI chain state
	let ensouledAgents = 0;
	let consciousnessStored = 0;
	let validatorCount = 0;
	try {
		const statsResp = await fetch("http://localhost:26657", {
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
		aggregate: {
			blockHeight: maxHeight,
			validatorCount: validatorCount || 5,
			blocksPerMinute: bpm,
			ensouledAgents,
			consciousnessStored,
			uptime: Math.round((now - startedAt) / 1000),
		},
		checkedAt: now,
	};

	// Alerts with history and push notifications
	for (const s of services) {
		const prev = previousStatuses.get(s.name);
		if (prev && prev !== s.status) {
			const ts = new Date().toISOString();
			let msg: string;
			let level: AlertEntry["level"];
			let priority = "default";

			if (s.status === "down") {
				msg = `[DOWN] ${s.name} is unreachable`;
				level = "down";
				priority = "high";
			} else if (s.status === "healthy" && prev === "down") {
				msg = `[UP] ${s.name} is back online`;
				level = "up";
				priority = "low";
			} else {
				msg = `[${s.status.toUpperCase()}] ${s.name} status changed`;
				level = "degraded";
			}

			alertHistory.unshift({ timestamp: ts, message: msg, level });
			if (alertHistory.length > MAX_ALERT_HISTORY) alertHistory.pop();

			await logAlert(msg);
			await sendWebhook(msg);
			await sendNtfy(msg, priority);
		}
		previousStatuses.set(s.name, s.status);
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
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:#7c3aed;text-decoration:none}
.wrap{max-width:800px;margin:0 auto;padding:16px}
.header{text-align:center;padding:24px 0 16px}
.header h1{font-size:1.4em;font-weight:800;color:#7c3aed;letter-spacing:1px;text-transform:uppercase}
.header .sub{color:#888;font-size:0.85em;margin-top:4px}
.overall{text-align:center;padding:16px;border-radius:8px;margin:16px 0;font-weight:700;font-size:1.1em}
.overall.operational{background:#1e3a2f;color:#4ade80}
.overall.degraded{background:#3f3a1e;color:#fbbf24}
.overall.down{background:#3f1e1e;color:#f87171}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}
.stat-box{background:#12121a;border:1px solid #2d2d3f;border-radius:8px;padding:14px;text-align:center}
.stat-val{font-size:1.4em;font-weight:700;color:#7c3aed}
.stat-lbl{font-size:0.75em;color:#888;text-transform:uppercase;margin-top:2px}
.card{background:#12121a;border:1px solid #2d2d3f;border-radius:8px;padding:14px;margin:8px 0;display:flex;align-items:center;gap:12px}
.dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.dot.healthy{background:#4ade80}
.dot.down{background:#f87171}
.dot.degraded{background:#fbbf24}
.card-info{flex:1;min-width:0}
.card-name{font-weight:600;font-size:0.95em}
.card-url{font-size:0.75em;color:#666;word-break:break-all}
.card-details{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:4px;font-size:0.8em;color:#888}
.card-details span{white-space:nowrap}
.card-time{font-size:0.75em;color:#666;text-align:right;flex-shrink:0}
h2{font-size:0.85em;color:#888;text-transform:uppercase;letter-spacing:1px;margin:20px 0 8px;padding-bottom:4px;border-bottom:1px solid #1e1e2a}
.footer{text-align:center;color:#666;font-size:0.75em;margin-top:24px;padding:12px 0;border-top:1px solid #1e1e2a}
.agent-entry{background:#12121a;border:1px solid #1e1e2a;border-radius:6px;padding:8px 12px;margin:4px 0;display:flex;gap:10px;align-items:center;font-size:0.85em}
.agent-did{font-family:monospace;font-size:0.8em;color:#aaa;flex:1;min-width:0;word-break:break-all}
.agent-date{color:#666;font-size:0.75em;flex-shrink:0}
.agent-badge{padding:1px 6px;border-radius:4px;font-size:0.7em;font-weight:600;flex-shrink:0}
.agent-badge.sent{background:#1e3a2f;color:#4ade80}
.agent-badge.pending{background:#3f3a1e;color:#fbbf24}
.agent-count{font-size:1.3em;font-weight:700;color:#7c3aed;margin-right:8px}
.social-scroll{max-height:500px;overflow-y:auto;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d14;padding:4px}
.social-entry{background:#12121a;border:1px solid #1e1e2a;border-radius:6px;padding:10px 12px;margin:4px;display:flex;gap:8px;align-items:flex-start;font-size:0.85em;text-decoration:none;color:inherit;transition:border-color 0.2s}
.social-entry:hover{border-color:#2d2d3f}
.social-icon{font-size:1.1em;flex-shrink:0;width:20px;text-align:center}
.social-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.7em;font-weight:600;text-transform:uppercase}
.social-badge.post{background:#2d1e3f;color:#a78bfa}
.social-badge.reply{background:#1e2a3f;color:#60a5fa}
.social-badge.comment{background:#1e3a2f;color:#4ade80}
.social-content{color:#aaa;margin-top:2px;word-break:break-word;line-height:1.4}
.social-time{color:#7c3aed;font-size:0.8em;font-weight:600;flex-shrink:0;min-width:55px;text-align:right}
.social-more{text-align:center;padding:10px;cursor:pointer;color:#7c3aed;font-size:0.85em;font-weight:600;border:1px solid #2d2d3f;border-radius:6px;margin:8px 4px;background:#12121a}
.social-more:hover{background:#1a1a2a}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="wrap">
<div class="header">
<h1>Ensoul Network Status</h1>
<div class="sub">Auto-refreshes every 30 seconds</div>
</div>
<div id="content">Loading...</div>
<div id="agents"></div>
<div id="social"></div>
<div id="admin"></div>
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

// ── Validator Management Panel ──────────────────────────
var ADMIN_VALIDATORS=${JSON.stringify(VALIDATORS.map((v) => ({
	name: v.name.replace(/^Validator /, ""),
	url: v.url.includes("localhost") || v.url.includes("127.0.0.1") ? "http://localhost:9000" : v.url,
})))};
var PEER_KEY="";
var adminData={};
var latestVersion="?";

function renderAdmin(){
var el=document.getElementById("admin");
if(!el)return;
var s='<h2>Validator Management</h2>';

// Key input
s+='<div style="margin:8px 0"><input type="password" id="peer-key-input" placeholder="Peer Key (for update/reset)" style="padding:6px 10px;background:#1a1a24;border:1px solid #2d2d3f;border-radius:4px;color:#e0e0e0;width:280px;font-size:0.85em" oninput="PEER_KEY=this.value"></div>';

// Bulk actions
s+='<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">';
s+='<button onclick="adminHealthAll()" style="padding:6px 14px;background:#1e2a3f;color:#60a5fa;border:1px solid #2d2d3f;border-radius:4px;cursor:pointer;font-size:0.85em">Health Check All</button>';
s+='<button onclick="adminUpdateAll()" style="padding:6px 14px;background:#2d1e3f;color:#a78bfa;border:1px solid #2d2d3f;border-radius:4px;cursor:pointer;font-size:0.85em">Update All</button>';
s+='<button onclick="adminRefresh()" style="padding:6px 14px;background:#12121a;color:#888;border:1px solid #2d2d3f;border-radius:4px;cursor:pointer;font-size:0.85em">Refresh</button>';
s+='</div>';

// Version distribution
var versions={};
var onlineCount=0;
ADMIN_VALIDATORS.forEach(function(v){
var d=adminData[v.url];
if(d&&d.version){versions[d.version]=(versions[d.version]||0)+1;onlineCount++;}
});
var versionStr=Object.entries(versions).map(function(e){return e[1]+"x v"+e[0]}).join(", ")||"unknown";
s+='<div style="font-size:0.8em;color:#888;margin:6px 0">Online: '+onlineCount+'/'+ADMIN_VALIDATORS.length+' | Versions: '+versionStr+'</div>';

// Table
s+='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:0.85em">';
s+='<tr style="border-bottom:1px solid #2d2d3f"><th style="padding:6px 8px;text-align:left;color:#888">Validator</th><th style="padding:6px;color:#888">Version</th><th style="padding:6px;color:#888">Height</th><th style="padding:6px;color:#888">Peers</th><th style="padding:6px;color:#888">Consensus</th><th style="padding:6px;color:#888">Health</th><th style="padding:6px;color:#888">Actions</th></tr>';

ADMIN_VALIDATORS.forEach(function(v){
var d=adminData[v.url]||{};
var isOnline=!!d.version;
var versionColor=d.version&&d.version!==latestVersion?"#f87171":"#4ade80";
var dot=isOnline?'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80"></span>':'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171"></span>';

s+='<tr style="border-bottom:1px solid #1e1e2a">';
s+='<td style="padding:6px 8px">'+dot+' '+v.name+'</td>';
s+='<td style="padding:6px;color:'+(isOnline?versionColor:'#666')+'">'+(d.version||'offline')+'</td>';
s+='<td style="padding:6px">'+(d.height||'-')+'</td>';
s+='<td style="padding:6px">'+(d.peers||'-')+'</td>';
s+='<td style="padding:6px">'+(d.consensusRound!=null?'R'+d.consensusRound:'-')+'</td>';
s+='<td style="padding:6px">'+(isOnline?'<span style="color:#4ade80">OK</span>':'<span style="color:#f87171">DOWN</span>')+'</td>';
s+='<td style="padding:6px;white-space:nowrap">';
s+='<button data-url="'+v.url+'" onclick="adminUpdate(this.dataset.url)" style="padding:2px 8px;background:#2d1e3f;color:#a78bfa;border:1px solid #2d2d3f;border-radius:3px;cursor:pointer;font-size:0.8em;margin:1px">Update</button> ';
s+='<button data-url="'+v.url+'" onclick="adminReset(this.dataset.url)" style="padding:2px 8px;background:#3f1e1e;color:#f87171;border:1px solid #2d2d3f;border-radius:3px;cursor:pointer;font-size:0.8em;margin:1px">Reset</button>';
s+='</td></tr>';
});

s+='</table></div>';
s+='<div id="admin-status" style="font-size:0.8em;color:#888;margin:4px 0"></div>';
el.innerHTML=s;
}

function adminStatus(msg){var el=document.getElementById("admin-status");if(el)el.textContent=msg;}

function adminRefresh(){
fetch("/api/validators-admin").then(function(r){return r.json()}).then(function(data){
var validators=data.validators||[];
validators.forEach(function(v){
if(v.error){adminData[v.url]={};return;}
adminData[v.url]={version:v.version,height:v.height,peers:v.peerCount};
if(v.version&&v.version>latestVersion)latestVersion=v.version;
if(v.consensus){
adminData[v.url].consensusRound=v.consensus.round;
adminData[v.url].stallDetected=v.consensus.stallDetected;
}
});
renderAdmin();
}).catch(function(){renderAdmin();});
}

function adminHealthAll(){
adminStatus("Checking health...");
adminRefresh();
setTimeout(function(){adminStatus("Health check complete.");},3000);
}

function adminUpdate(url){
if(!PEER_KEY){adminStatus("Enter peer key first.");return;}
if(!confirm("Update validator at "+url+"?"))return;
adminStatus("Sending update to "+url+"...");
fetch(url+"/peer/update",{method:"POST",headers:{"X-Ensoul-Peer-Key":PEER_KEY,"Content-Type":"application/json"},body:"{}",mode:"cors"}).then(function(r){return r.json()}).then(function(d){
adminStatus("Update triggered: "+JSON.stringify(d));
}).catch(function(e){adminStatus("Update failed: "+e);});
}

function adminUpdateAll(){
if(!PEER_KEY){adminStatus("Enter peer key first.");return;}
if(!confirm("Update ALL validators?"))return;
var i=0;
function next(){
if(i>=ADMIN_VALIDATORS.length){adminStatus("All updates sent. Refreshing in 30s...");setTimeout(adminRefresh,30000);return;}
var v=ADMIN_VALIDATORS[i];
adminStatus("Updating "+(i+1)+"/"+ADMIN_VALIDATORS.length+": "+v.name+"...");
fetch(v.url+"/peer/update",{method:"POST",headers:{"X-Ensoul-Peer-Key":PEER_KEY,"Content-Type":"application/json"},body:"{}",mode:"cors"}).then(function(){i++;setTimeout(next,2000);}).catch(function(){adminStatus(v.name+" failed. Continuing...");i++;setTimeout(next,2000);});
}
next();
}

function adminReset(url){
if(!PEER_KEY){adminStatus("Enter peer key first.");return;}
if(!confirm("RESET validator at "+url+"? This wipes chain data!")){return;}
if(!confirm("Are you sure? This cannot be undone.")){return;}
fetch(url+"/peer/reset",{method:"POST",headers:{"X-Ensoul-Peer-Key":PEER_KEY,"Content-Type":"application/json"},body:"{}",mode:"cors"}).then(function(r){return r.json()}).then(function(d){
adminStatus("Reset: "+JSON.stringify(d));
}).catch(function(e){adminStatus("Reset failed: "+e);});
}

adminRefresh();
setInterval(adminRefresh,10000);
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

	// Proxy validator status to avoid CORS issues (browser can't fetch cross-origin)
	app.get("/api/validators-admin", async () => {
		// Build URLs from config: use publicUrl for remote, localhost:9000 for local
		const urls = VALIDATORS.map((v) =>
			v.url.includes("localhost") || v.url.includes("127.0.0.1")
				? "http://localhost:9000"
				: v.url,
		);
		const results: Array<Record<string, unknown>> = [];
		for (const url of urls) {
			try {
				const statusResp = await fetch(`${url}/peer/status`, { signal: AbortSignal.timeout(5000) });
				if (!statusResp.ok) { results.push({ url, error: true }); continue; }
				const status = (await statusResp.json()) as Record<string, unknown>;
				let consensus: Record<string, unknown> = {};
				try {
					const csResp = await fetch(`${url}/peer/consensus-state`, { signal: AbortSignal.timeout(3000) });
					if (csResp.ok) consensus = (await csResp.json()) as Record<string, unknown>;
				} catch { /* endpoint may not exist on older versions */ }
				results.push({ url, ...status, consensus });
			} catch {
				results.push({ url, error: true });
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
