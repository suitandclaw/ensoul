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
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 4000);
const POLL_INTERVAL = 30_000;
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "monitor.log");
const AGENT_LOG = join(LOG_DIR, "agent.log");
const WEBHOOK_URL = process.env["ALERT_WEBHOOK_URL"] ?? "";

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
		uptime: number;
	};
	checkedAt: number;
}

// ── State ────────────────────────────────────────────────────────────

let health: HealthResponse = {
	overall: "down",
	services: [],
	aggregate: { blockHeight: 0, validatorCount: 35, blocksPerMinute: 0, uptime: 0 },
	checkedAt: 0,
};

const startedAt = Date.now();
let lastHeight = 0;
let lastHeightAt = Date.now();
const previousStatuses = new Map<string, "healthy" | "down" | "degraded">();

// ── Polling ──────────────────────────────────────────────────────────

const VALIDATORS = [
	{ name: "Validator v0 (MacBook Pro)", url: "https://v0.ensoul.dev" },
	{ name: "Validator v1 (Mac Mini 1)", url: "https://v1.ensoul.dev" },
	{ name: "Validator v2 (Mac Mini 2)", url: "https://v2.ensoul.dev" },
	{ name: "Validator v3 (Mac Mini 3)", url: "https://v3.ensoul.dev" },
];

async function checkValidator(name: string, url: string): Promise<ServiceStatus> {
	try {
		const resp = await fetch(`${url}/peer/status`, { signal: AbortSignal.timeout(10_000) });
		if (!resp.ok) return { name, url, status: "down", lastSeen: 0, details: { error: `HTTP ${resp.status}` } };
		const data = (await resp.json()) as { height: number; peerCount: number; did: string };
		const shortDid = data.did.length > 24 ? `${data.did.slice(0, 16)}...${data.did.slice(-6)}` : data.did;
		return {
			name, url, status: "healthy", lastSeen: Date.now(),
			details: { height: data.height, peers: data.peerCount, did: shortDid },
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

	health = {
		overall,
		services,
		aggregate: {
			blockHeight: maxHeight,
			validatorCount: 35,
			blocksPerMinute: bpm,
			uptime: Math.round((now - startedAt) / 1000),
		},
		checkedAt: now,
	};

	// Alerts
	for (const s of services) {
		const prev = previousStatuses.get(s.name);
		if (prev && prev !== s.status) {
			const msg = s.status === "down"
				? `[DOWN] ${s.name} is unreachable`
				: s.status === "healthy" && prev === "down"
					? `[UP] ${s.name} is back online`
					: `[${s.status.toUpperCase()}] ${s.name} status changed`;
			await logAlert(msg);
			await sendWebhook(msg);
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

// ── Dashboard HTML ───────────────────────────────────────────────────

function renderDashboard(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ensoul Network Status</title>
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
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
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
<div class="footer"><a href="https://ensoul.dev">ensoul.dev</a> | <a href="https://explorer.ensoul.dev">Explorer</a> | <a href="https://github.com/suitandclaw/ensoul">GitHub</a></div>
</div>
<script>
function shortTime(ts){if(!ts)return"never";var d=new Date(ts);return d.toLocaleTimeString()}
function render(h){
var o=h.overall==="operational"?"All systems operational":h.overall==="degraded"?"Some services degraded":"Network issues detected";
var s='<div class="overall '+h.overall+'">'+o+'</div>';
s+='<div class="stats">';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.blockHeight+'</div><div class="stat-lbl">Block Height</div></div>';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.validatorCount+'</div><div class="stat-lbl">Validators</div></div>';
s+='<div class="stat-box"><div class="stat-val">'+h.aggregate.blocksPerMinute+'</div><div class="stat-lbl">Blocks/min</div></div>';
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
function poll(){fetch("/api/health").then(function(r){return r.json()}).then(render).catch(function(){});}
poll();
setInterval(poll,30000);
</script>
</body>
</html>`;
}

// ── Server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });

	const app = Fastify({ logger: false });

	app.get("/", async (_req, reply) => {
		return reply.type("text/html").send(renderDashboard());
	});

	app.get("/api/health", async () => {
		return health;
	});

	// Initial poll
	await pollAll();

	// Start polling loop
	const timer = setInterval(() => void pollAll(), POLL_INTERVAL);

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
