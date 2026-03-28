#!/usr/bin/env npx tsx
/**
 * Ensoul Telegram Bot
 *
 * Remote network management from a phone. Monitors all validators,
 * sends alerts, and allows restart/update operations via chat commands.
 *
 * Usage:
 *   npx tsx packages/telegram-bot/start.ts
 *
 * Credentials:
 *   ~/.ensoul/telegram-bot.env (TELEGRAM_BOT_TOKEN, TELEGRAM_AUTHORIZED_USER)
 */

import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { exec } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..", "..");
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "telegram-bot.log");
const ENV_FILE = join(LOG_DIR, "telegram-bot.env");

// Load credentials from env file
function loadEnv(): { token: string; userId: number } {
	try {
		const raw = readFileSync(ENV_FILE, "utf-8");
		const lines = raw.split("\n");
		let token = "";
		let userId = 0;
		for (const line of lines) {
			const [key, ...rest] = line.split("=");
			const val = rest.join("=").trim();
			if (key?.trim() === "TELEGRAM_BOT_TOKEN") token = val;
			if (key?.trim() === "TELEGRAM_AUTHORIZED_USER") userId = Number(val);
		}
		if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
		if (!userId) throw new Error("TELEGRAM_AUTHORIZED_USER not set");
		return { token, userId };
	} catch (err) {
		process.stderr.write(`Failed to load ${ENV_FILE}: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}

const { token: BOT_TOKEN, userId: AUTHORIZED_USER } = loadEnv();
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Load validator configs
interface ValidatorConfig {
	name: string;
	moniker: string;
	tailscaleIp?: string;
	publicIp?: string;
	rpcPort: number;
	role: string;
	user: string;
	sshPort?: number;
}

const VALIDATORS: ValidatorConfig[] = (() => {
	try {
		const raw = readFileSync(join(REPO_DIR, "configs", "validators.json"), "utf-8");
		const config = JSON.parse(raw) as { validators: ValidatorConfig[] };
		return config.validators;
	} catch {
		return [];
	}
})();

// ── Logging ─────────────────────────────────────────────────────────

async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString();
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	try { await appendFile(LOG_FILE, line); } catch { /* non-fatal */ }
}

// ── Telegram API ────────────────────────────────────────────────────

async function tgRequest(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const resp = await fetch(`${API_BASE}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	return (await resp.json()) as Record<string, unknown>;
}

async function sendMessage(chatId: number, text: string, parse_mode = "HTML"): Promise<void> {
	await tgRequest("sendMessage", { chat_id: chatId, text, parse_mode, disable_web_page_preview: true });
}

// ── SSH / Command Execution ─────────────────────────────────────────

function sshPrefix(vc: ValidatorConfig): string {
	if (vc.moniker === "ensoul-mbp") return "";
	const ip = vc.tailscaleIp || vc.publicIp || "";
	const portFlag = vc.sshPort ? `-p ${vc.sshPort}` : "";
	return `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${portFlag} ${vc.user}@${ip}`;
}

function runCmd(vc: ValidatorConfig, cmd: string, timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const prefix = sshPrefix(vc);
		const full = prefix ? `${prefix} '${cmd.replace(/'/g, "'\\''")}'` : cmd;
		const child = exec(full, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: string) => { stdout += d; });
		child.stderr?.on("data", (d: string) => { stderr += d; });
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`Exit ${code}: ${stderr.slice(0, 300)}`));
		});
		child.on("error", reject);
	});
}

function findValidator(name: string): ValidatorConfig | null {
	const n = name.toLowerCase().trim();
	const aliases: Record<string, string> = {
		mbp: "ensoul-mbp", mac: "ensoul-mbp", macbook: "ensoul-mbp",
		mini1: "ensoul-mini1", m1: "ensoul-mini1",
		mini2: "ensoul-mini2", m2: "ensoul-mini2",
		mini3: "ensoul-mini3", m3: "ensoul-mini3",
		vps: "ensoul-cloud-1", cloud: "ensoul-cloud-1", hetzner: "ensoul-cloud-1",
		"0": "ensoul-mbp", "1": "ensoul-mini1", "2": "ensoul-mini2", "3": "ensoul-mini3", "4": "ensoul-cloud-1",
	};
	const moniker = aliases[n] ?? n;
	return VALIDATORS.find((v) => v.moniker === moniker || v.moniker.includes(n)) ?? null;
}

// ── CometBFT Queries ────────────────────────────────────────────────

async function cometRpc(ip: string, port: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
	try {
		const resp = await fetch(`http://${ip}:${port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "q", method, params }),
			signal: AbortSignal.timeout(5000),
		});
		const data = (await resp.json()) as { result?: Record<string, unknown> };
		return data.result ?? null;
	} catch { return null; }
}

async function abciQuery(path: string): Promise<Record<string, unknown> | null> {
	try {
		const resp = await fetch("http://localhost:26657", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "q", method: "abci_query", params: { path } }),
			signal: AbortSignal.timeout(5000),
		});
		const data = (await resp.json()) as { result?: { response?: { value?: string } } };
		const val = data.result?.response?.value;
		if (!val) return null;
		return JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as Record<string, unknown>;
	} catch { return null; }
}

// ── Command Handlers ────────────────────────────────────────────────

async function handleStatus(chatId: number): Promise<void> {
	const lines: string[] = ["<b>Ensoul Network Status</b>\n"];

	// Chain stats from ABCI
	const stats = await abciQuery("/stats");
	if (stats) {
		const height = stats["height"] ?? "?";
		const agents = stats["agentCount"] ?? "?";
		const consciousness = stats["consciousnessCount"] ?? "?";
		const emitted = stats["totalEmittedEnsl"] ?? "?";
		const valCount = stats["consensusSetSize"] ?? "?";
		lines.push(`Chain height: <b>${height}</b>`);
		lines.push(`Validators: <b>${valCount}</b>`);
		lines.push(`Agents: <b>${agents}</b> | Consciousness: <b>${consciousness}</b>`);
		lines.push(`Total emitted: <b>${Number(emitted).toLocaleString()}</b> ENSL`);
	}

	// Block age
	const localStatus = await cometRpc("localhost", 26657, "status");
	if (localStatus) {
		const si = localStatus["sync_info"] as Record<string, unknown>;
		const blockTime = new Date(String(si["latest_block_time"])).getTime();
		const ageSec = Math.round((Date.now() - blockTime) / 1000);
		lines.push(`Block age: <b>${ageSec}s</b>`);
	}

	lines.push("");

	// Validators: configured + auto-discovered from API peer registry
	const checkedIps = new Set<string>();
	for (const vc of VALIDATORS) {
		const ip = vc.tailscaleIp || vc.publicIp || "localhost";
		checkedIps.add(ip);
		const status = await cometRpc(ip, vc.rpcPort, "status");
		if (!status) {
			lines.push(`${vc.moniker}: <b>OFFLINE</b>`);
			continue;
		}
		const si = status["sync_info"] as Record<string, unknown>;
		const h = si["latest_block_height"];
		const catching = si["catching_up"];

		let peers = "?";
		const net = await cometRpc(ip, vc.rpcPort, "net_info");
		if (net) peers = String(net["n_peers"]);

		const icon = catching ? "\u{1F7E1}" : "\u{1F7E2}";
		const statusText = catching ? "syncing" : "signing";
		lines.push(`${icon} ${vc.moniker}: h=${h} peers=${peers} ${statusText}`);
	}

	// Show total active validator count from CometBFT
	const valSetResp = await cometRpc("localhost", 26657, "validators");
	if (valSetResp) {
		const valSet = valSetResp["validators"] as Array<Record<string, unknown>>;
		const activeCount = valSet?.filter(v => Number(v["voting_power"]) > 0).length ?? 0;
		if (activeCount > VALIDATORS.length) {
			lines.push(`\n(${activeCount} active validators total, ${activeCount - VALIDATORS.length} not in config)`);
		}
	}

	lines.push("");

	// Services
	const services = [
		{ name: "Explorer", url: "https://explorer.ensoul.dev/api/v1/status" },
		{ name: "Dashboard", url: "https://status.ensoul.dev/api/health" },
		{ name: "API", url: "https://api.ensoul.dev/health" },
	];
	for (const svc of services) {
		try {
			const resp = await fetch(svc.url, { signal: AbortSignal.timeout(5000) });
			lines.push(`${resp.ok ? "\u{2705}" : "\u{274C}"} ${svc.name}: HTTP ${resp.status}`);
		} catch {
			lines.push(`\u{274C} ${svc.name}: unreachable`);
		}
	}

	await sendMessage(chatId, lines.join("\n"));
}

async function handlePeers(chatId: number): Promise<void> {
	const lines: string[] = ["<b>Peer Count</b>\n"];
	for (const vc of VALIDATORS) {
		const net = await cometRpc(vc.tailscaleIp || vc.publicIp || "localhost", vc.rpcPort, "net_info");
		const peers = net ? String(net["n_peers"]) : "offline";
		lines.push(`${vc.moniker}: <b>${peers}</b> peers`);
	}
	await sendMessage(chatId, lines.join("\n"));
}

async function handleValidators(chatId: number): Promise<void> {
	const valData = await abciQuery("/validators");
	if (!valData) { await sendMessage(chatId, "Failed to query validators."); return; }
	const vs = valData["validators"] as Array<Record<string, unknown>>;

	const lines: string[] = ["<b>Validators</b>\n"];
	lines.push("<pre>");
	lines.push("DID                    Power      Stake");
	for (const v of vs) {
		const did = String(v["did"] ?? "");
		const short = did.length > 20 ? `${did.slice(8, 18)}...${did.slice(-4)}` : did;
		const power = Number(v["power"] ?? 0);
		const staked = BigInt(String(v["stakedBalance"] ?? "0")) / (10n ** 18n);
		lines.push(`${short.padEnd(22)} ${String(power).padStart(10)}  ${staked.toLocaleString().padStart(12)} ENSL`);
	}
	lines.push("</pre>");
	await sendMessage(chatId, lines.join("\n"));
}

async function handleLogs(chatId: number, arg: string): Promise<void> {
	if (!arg) { await sendMessage(chatId, "Usage: /logs mini1, /logs vps, /logs mbp"); return; }
	const vc = findValidator(arg);
	if (!vc) { await sendMessage(chatId, `Unknown validator: ${arg}\nValid: mbp, mini1, mini2, mini3, vps`); return; }

	try {
		const abciLog = await runCmd(vc, "tail -20 ~/.ensoul/abci-server.log 2>/dev/null || echo 'No log'", 10_000);
		const cometLog = await runCmd(vc, "tail -20 ~/.ensoul/cometbft.log 2>/dev/null || echo 'No log'", 10_000);

		// Truncate to fit Telegram 4096 char limit
		const abciTrunc = abciLog.slice(-1500);
		const cometTrunc = cometLog.slice(-1500);

		await sendMessage(chatId, `<b>ABCI (${vc.moniker})</b>\n<pre>${escapeHtml(abciTrunc)}</pre>`);
		await sendMessage(chatId, `<b>CometBFT (${vc.moniker})</b>\n<pre>${escapeHtml(cometTrunc)}</pre>`);
	} catch (err) {
		await sendMessage(chatId, `Failed to get logs: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleAgents(chatId: number): Promise<void> {
	const stats = await abciQuery("/stats");
	const lines: string[] = ["<b>Agent Status</b>\n"];
	if (stats) {
		lines.push(`Registered agents: <b>${stats["agentCount"] ?? "?"}</b>`);
		lines.push(`Consciousness stored: <b>${stats["consciousnessCount"] ?? "?"}</b>`);
	} else {
		lines.push("Failed to query ABCI.");
	}
	await sendMessage(chatId, lines.join("\n"));
}

// ── Restart / Update with confirmation ──────────────────────────────

let pendingAction: { type: "restart" | "update"; target: string; vc: ValidatorConfig | null; all: boolean } | null = null;
let botLocked = false;

async function handleRestart(chatId: number, arg: string): Promise<void> {
	if (botLocked) { await sendMessage(chatId, "\u{1F512} Bot is locked. Send /unlock to re-enable destructive commands."); return; }
	if (!arg) { await sendMessage(chatId, "Usage: /restart mini1, /restart vps"); return; }
	const vc = findValidator(arg);
	if (!vc) { await sendMessage(chatId, `Unknown validator: ${arg}`); return; }
	pendingAction = { type: "restart", target: arg, vc, all: false };
	await sendMessage(chatId, `Restart ${vc.moniker}?\nThis stops and restarts CometBFT and the ABCI server. Chain continues on other validators.\n\nReply /confirm to proceed.`);
}

async function handleUpdate(chatId: number, arg: string): Promise<void> {
	if (botLocked) { await sendMessage(chatId, "\u{1F512} Bot is locked. Send /unlock to re-enable destructive commands."); return; }
	const isAll = arg.toLowerCase() === "all";
	if (!arg) { await sendMessage(chatId, "Usage: /update mini1, /update vps, /update all"); return; }
	if (!isAll) {
		const vc = findValidator(arg);
		if (!vc) { await sendMessage(chatId, `Unknown validator: ${arg}`); return; }
		pendingAction = { type: "update", target: arg, vc, all: false };
		await sendMessage(chatId, `Update ${vc.moniker}?\nThis pulls code, rebuilds, and restarts services.\n\nReply /confirm to proceed.`);
	} else {
		pendingAction = { type: "update", target: "all", vc: null, all: true };
		await sendMessage(chatId, `Update ALL ${VALIDATORS.length} validators sequentially?\nThis takes several minutes.\n\nReply /confirm to proceed.`);
	}
}

async function handleConfirm(chatId: number): Promise<void> {
	if (!pendingAction) { await sendMessage(chatId, "Nothing to confirm."); return; }
	const action = pendingAction;
	pendingAction = null;

	if (action.type === "restart" && action.vc) {
		await executeRestart(chatId, action.vc);
	} else if (action.type === "update" && action.all) {
		await executeUpdateAll(chatId);
	} else if (action.type === "update" && action.vc) {
		await executeUpdate(chatId, action.vc);
	}
}

async function executeRestart(chatId: number, vc: ValidatorConfig): Promise<void> {
	await sendMessage(chatId, `Restarting ${vc.moniker}...`);
	try {
		if (vc.role === "cloud") {
			await runCmd(vc, "systemctl stop ensoul-cometbft; systemctl stop ensoul-abci; sleep 2; systemctl start ensoul-abci; sleep 3; systemctl start ensoul-cometbft", 30_000);
		} else {
			await runCmd(vc, "lsof -ti :26657 | xargs kill 2>/dev/null; lsof -ti :26656 | xargs kill 2>/dev/null; lsof -ti :26658 | xargs kill 2>/dev/null; sleep 2; cd ~/ensoul && nohup bash -l -c 'npx tsx packages/abci-server/src/index.ts --port 26658' >> ~/.ensoul/abci-server.log 2>&1 &", 15_000);
			await new Promise((r) => setTimeout(r, 5000));
			await runCmd(vc, "cd ~/ensoul && DAEMON_NAME=cometbft DAEMON_HOME=~/.cometbft-ensoul/node DAEMON_DATA_BACKUP_DIR=~/.cometbft-ensoul/node/backups DAEMON_ALLOW_DOWNLOAD_BINARIES=false DAEMON_RESTART_AFTER_UPGRADE=true nohup ~/go/bin/cosmovisor run start --proxy_app=tcp://127.0.0.1:26658 --home ~/.cometbft-ensoul/node >> ~/.ensoul/cometbft.log 2>&1 &", 15_000);
		}

		await sendMessage(chatId, "Services restarted. Waiting for block...");
		const ok = await waitForBlock(vc, 60);
		await sendMessage(chatId, ok
			? `\u{2705} ${vc.moniker} is healthy and signing blocks.`
			: `\u{26A0}\u{FE0F} ${vc.moniker} did not recover within 60s. Check /logs ${vc.moniker}`);
	} catch (err) {
		await sendMessage(chatId, `\u{274C} Restart failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function executeUpdate(chatId: number, vc: ValidatorConfig): Promise<void> {
	await sendMessage(chatId, `Updating ${vc.moniker}...`);
	try {
		await sendMessage(chatId, "Pulling code...");
		await runCmd(vc, "cd ~/ensoul && git pull origin main", 30_000);

		await sendMessage(chatId, "Clearing cache and building...");
		await runCmd(vc, "cd ~/ensoul && rm -rf .turbo node_modules/.cache packages/*/dist", 15_000);
		await runCmd(vc, "cd ~/ensoul && bash -l -c 'pnpm install --frozen-lockfile && pnpm build'", 300_000);

		await sendMessage(chatId, "Build complete. Restarting services...");
		await executeRestart(chatId, vc);
	} catch (err) {
		await sendMessage(chatId, `\u{274C} Update failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function executeUpdateAll(chatId: number): Promise<void> {
	await sendMessage(chatId, `Starting sequential update of ${VALIDATORS.length} validators...`);
	let failures = 0;
	for (let i = 0; i < VALIDATORS.length; i++) {
		const vc = VALIDATORS[i]!;
		await sendMessage(chatId, `[${i + 1}/${VALIDATORS.length}] Updating ${vc.moniker}...`);
		try {
			await runCmd(vc, "cd ~/ensoul && git pull origin main", 30_000);
			await runCmd(vc, "cd ~/ensoul && rm -rf .turbo node_modules/.cache packages/*/dist", 15_000);
			await runCmd(vc, "cd ~/ensoul && bash -l -c 'pnpm install --frozen-lockfile && pnpm build'", 300_000);
			await executeRestart(chatId, vc);
		} catch (err) {
			await sendMessage(chatId, `\u{274C} ${vc.moniker} failed: ${err instanceof Error ? err.message : String(err)}`);
			failures++;
		}
	}
	await sendMessage(chatId, failures === 0
		? `\u{2705} All ${VALIDATORS.length} validators updated.`
		: `\u{26A0}\u{FE0F} Update complete with ${failures} failure(s).`);
}

async function waitForBlock(vc: ValidatorConfig, timeoutSec: number): Promise<boolean> {
	const deadline = Date.now() + timeoutSec * 1000;
	while (Date.now() < deadline) {
		const status = await cometRpc(vc.tailscaleIp || vc.publicIp || "localhost", vc.rpcPort, "status");
		if (status) {
			const si = status["sync_info"] as Record<string, unknown>;
			if (si["catching_up"] === false && Number(si["latest_block_height"]) > 0) return true;
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

// ── Alerts ──────────────────────────────────────────────────────────

let alertsEnabled = true;
let alertChatId = 0; // Set on first message from authorized user

/** Send an alert to the authorized user (called by the monitoring loop). */
async function sendAlert(text: string): Promise<void> {
	if (!alertsEnabled || !alertChatId) return;
	try {
		await sendMessage(alertChatId, `\u{1F6A8} <b>ALERT</b>\n${text}`);
	} catch (err) {
		await log(`Alert send failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Alert state tracking (avoid duplicate alerts)
const alertState = new Map<string, boolean>();

async function monitoringLoop(): Promise<void> {
	if (!alertChatId) return; // No chat ID yet

	const localStatus = await cometRpc("localhost", 26657, "status");
	const height = localStatus
		? Number((localStatus["sync_info"] as Record<string, unknown>)["latest_block_height"])
		: 0;
	const blockTime = localStatus
		? new Date(String((localStatus["sync_info"] as Record<string, unknown>)["latest_block_time"])).getTime()
		: 0;
	const blockAge = blockTime ? Math.round((Date.now() - blockTime) / 1000) : 999;

	// Chain stall
	if (blockAge > 120) {
		if (!alertState.get("stall")) {
			alertState.set("stall", true);
			await sendAlert(`Chain stalled. No block in ${blockAge}s.\nHeight: ${height}`);
		}
	} else {
		if (alertState.get("stall")) {
			alertState.set("stall", false);
			await sendAlert(`Chain resumed at height ${height}.`);
		}
	}

	// Check each validator
	for (const vc of VALIDATORS) {
		const key = `offline-${vc.moniker}`;
		const status = await cometRpc(vc.tailscaleIp || vc.publicIp || "localhost", vc.rpcPort, "status");
		if (!status) {
			if (!alertState.get(key)) {
				alertState.set(key, true);
				await sendAlert(`${vc.moniker} is OFFLINE.\nHeight: ${height}`);
			}
		} else {
			if (alertState.get(key)) {
				alertState.set(key, false);
				await sendAlert(`${vc.moniker} is back ONLINE.`);
			}
			// Peer count
			const net = await cometRpc(vc.tailscaleIp || vc.publicIp || "localhost", vc.rpcPort, "net_info");
			const peers = net ? Number(net["n_peers"]) : 0;
			const peerKey = `lowpeers-${vc.moniker}`;
			if (peers < 4 && peers >= 0) {
				if (!alertState.get(peerKey)) {
					alertState.set(peerKey, true);
					await sendAlert(`${vc.moniker} has only ${peers} peers.\nHeight: ${height}`);
				}
			} else {
				alertState.set(peerKey, false);
			}
		}
	}

	// Check public URLs
	const urls = [
		{ name: "explorer.ensoul.dev", url: "https://explorer.ensoul.dev/api/v1/status" },
		{ name: "status.ensoul.dev", url: "https://status.ensoul.dev/api/health" },
		{ name: "api.ensoul.dev", url: "https://api.ensoul.dev/health" },
	];
	for (const svc of urls) {
		const key = `url-${svc.name}`;
		try {
			const resp = await fetch(svc.url, { signal: AbortSignal.timeout(10000) });
			if (!resp.ok) {
				if (!alertState.get(key)) {
					alertState.set(key, true);
					await sendAlert(`${svc.name} returned HTTP ${resp.status}.\nHeight: ${height}`);
				}
			} else {
				if (alertState.get(key)) {
					alertState.set(key, false);
					await sendAlert(`${svc.name} recovered (HTTP 200).`);
				}
			}
		} catch {
			if (!alertState.get(key)) {
				alertState.set(key, true);
				await sendAlert(`${svc.name} is unreachable.\nHeight: ${height}`);
			}
		}
	}
}

// ── Help ────────────────────────────────────────────────────────────

// ── Delegation Management Commands ──────────────────────────────────

async function handleApplications(chatId: number): Promise<void> {
	try {
		const resp = await fetch("http://localhost:5050/v1/validators/applications", { signal: AbortSignal.timeout(5000) });
		const data = (await resp.json()) as { applications: Array<{ id: string; operatorName: string; operatorEmail: string; did: string; submittedAt: number }> };
		const apps = data.applications ?? [];
		if (apps.length === 0) {
			await sendMessage(chatId, "No pending pioneer applications.");
			return;
		}
		const lines = ["<b>Pending Pioneer Applications</b>\n"];
		for (const a of apps) {
			const age = Math.floor((Date.now() - a.submittedAt) / 3600000);
			lines.push(`<b>${a.operatorName}</b> (${age}h ago)`);
			lines.push(`  ID: <code>${a.id}</code>`);
			lines.push(`  Email: ${a.operatorEmail}`);
			lines.push(`  DID: ${a.did.slice(0, 30)}...`);
			lines.push("");
		}
		lines.push(`/approve [id] or /reject [id] [reason]`);
		await sendMessage(chatId, lines.join("\n"));
	} catch {
		await sendMessage(chatId, "Failed to fetch applications.");
	}
}

async function handleApprove(chatId: number, arg: string): Promise<void> {
	if (botLocked) { await sendMessage(chatId, "\u{1F512} Bot locked."); return; }
	if (!arg) { await sendMessage(chatId, "Usage: /approve [application_id]"); return; }
	try {
		const { approveApplication, getApplication } = await import("@ensoul/delegation-engine");
		const app = getApplication(arg);
		if (!app) { await sendMessage(chatId, `Application not found: ${arg}`); return; }
		const result = await approveApplication(arg);
		if (result.error) { await sendMessage(chatId, `Error: ${result.error}`); return; }
		await sendMessage(chatId, `\u{2705} Approved: ${app.operatorName}\n1M ENSL delegation pending for ${app.did.slice(0, 30)}...`);
	} catch (err) {
		await sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleReject(chatId: number, arg: string): Promise<void> {
	if (!arg) { await sendMessage(chatId, "Usage: /reject [application_id] [reason]"); return; }
	const parts = arg.split(" ");
	const id = parts[0] ?? "";
	const reason = parts.slice(1).join(" ") || "Application rejected";
	try {
		const { rejectApplication, getApplication } = await import("@ensoul/delegation-engine");
		const app = getApplication(id);
		if (!app) { await sendMessage(chatId, `Application not found: ${id}`); return; }
		const result = await rejectApplication(id, reason);
		if (result.error) { await sendMessage(chatId, `Error: ${result.error}`); return; }
		await sendMessage(chatId, `\u{274C} Rejected: ${app.operatorName}\nReason: ${reason}`);
	} catch (err) {
		await sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleTreasury(chatId: number): Promise<void> {
	try {
		const resp = await fetch("http://localhost:5050/v1/validators/treasury-stats", { signal: AbortSignal.timeout(5000) });
		const stats = (await resp.json()) as Record<string, unknown>;

		// Also get actual treasury balance
		const tResp = await fetch("https://api.ensoul.dev/v1/account/did:key:z6Mki9jwpYMBB93zxYfsmNUHThpSgKATqydN4xJA1xcxGecm", { signal: AbortSignal.timeout(5000) });
		const tData = (await tResp.json()) as { available?: string };

		const vs = stats["validators"] as Record<string, number> | undefined;
		const prob = stats["probation"] as Record<string, number> | undefined;

		const lines = [
			"<b>Treasury Status</b>\n",
			`Balance: <b>${tData.available ?? "?"}</b>`,
			`Total delegated: <b>${stats["totalDelegated"] ?? "?"}</b>`,
			"",
			"<b>Validators by tier:</b>",
			`  Foundation: ${vs?.["foundation"] ?? 0}`,
			`  Pioneer: ${vs?.["pioneer"] ?? 0}`,
			`  Open: ${vs?.["open"] ?? 0}`,
		];

		if (prob && (prob["initial"] || prob["sevenDay"] || prob["thirtyDay"] || prob["full"])) {
			lines.push("");
			lines.push("<b>Open tier probation:</b>");
			lines.push(`  Initial (10K): ${prob["initial"] ?? 0}`);
			lines.push(`  7-day (50K): ${prob["sevenDay"] ?? 0}`);
			lines.push(`  30-day (100K): ${prob["thirtyDay"] ?? 0}`);
			lines.push(`  Full: ${prob["full"] ?? 0}`);
		}

		await sendMessage(chatId, lines.join("\n"));
	} catch {
		await sendMessage(chatId, "Failed to fetch treasury stats.");
	}
}

const HELP_TEXT = `<b>Ensoul Bot Commands</b>

/status \u2014 Network overview
/peers \u2014 Peer count per machine
/validators \u2014 Validator table
/logs [name] \u2014 Recent logs
/restart [name] \u2014 Restart validator
/update [name|all] \u2014 Pull, build, restart

<b>Delegation</b>
/applications \u2014 Pending pioneer applications
/approve [id] \u2014 Approve pioneer application
/reject [id] [reason] \u2014 Reject pioneer application
/treasury \u2014 Treasury balance and delegation stats

<b>Other</b>
/agents \u2014 Agent and consciousness stats
/alerts [on|off] \u2014 Toggle alerts
/lock /unlock \u2014 Security lock
/help \u2014 This message`;

// ── HTML escape ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Polling Loop (Long Polling) ─────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });
	await log("Ensoul Telegram Bot starting...");
	await log(`Authorized user: ${AUTHORIZED_USER}`);
	await log(`Validators: ${VALIDATORS.length}`);

	// Verify token
	const me = await tgRequest("getMe", {});
	if (!me["ok"]) {
		await log("Failed to connect to Telegram. Check bot token.");
		process.exit(1);
	}
	const botInfo = me["result"] as Record<string, unknown>;
	await log(`Bot connected: @${botInfo["username"]}`);

	let offset = 0;

	// Start monitoring loop (every 60 seconds)
	setInterval(() => { void monitoringLoop(); }, 60_000);

	// Long polling loop
	while (true) {
		try {
			const resp = await fetch(`${API_BASE}/getUpdates`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ offset, timeout: 30, allowed_updates: ["message"] }),
				signal: AbortSignal.timeout(40000),
			});
			const data = (await resp.json()) as { ok: boolean; result: Array<Record<string, unknown>> };
			if (!data.ok || !data.result) continue;

			for (const update of data.result) {
				offset = Number(update["update_id"]) + 1;
				const msg = update["message"] as Record<string, unknown> | undefined;
				if (!msg) continue;

				const from = msg["from"] as Record<string, unknown> | undefined;
				const chat = msg["chat"] as Record<string, unknown> | undefined;
				const text = String(msg["text"] ?? "").trim();
				if (!from || !chat || !text) continue;

				const userId = Number(from["id"]);
				const chatIdNum = Number(chat["id"]);

				// Security: only respond to authorized user
				if (userId !== AUTHORIZED_USER) {
					await log(`Ignored message from unauthorized user ${userId}`);
					continue;
				}

				// Set alertChatId on first message
				if (!alertChatId) {
					alertChatId = chatIdNum;
					await log(`Alert chat ID set to ${alertChatId}`);
				}

				await log(`CMD: ${text}`);

				// Parse command
				const parts = text.split(/\s+/);
				const cmd = parts[0]?.toLowerCase() ?? "";
				const arg = parts.slice(1).join(" ");

				try {
					switch (cmd) {
						case "/start":
						case "/help":
							await sendMessage(chatIdNum, HELP_TEXT);
							break;
						case "/status":
							await handleStatus(chatIdNum);
							break;
						case "/peers":
							await handlePeers(chatIdNum);
							break;
						case "/validators":
							await handleValidators(chatIdNum);
							break;
						case "/logs":
							await handleLogs(chatIdNum, arg);
							break;
						case "/restart":
							await handleRestart(chatIdNum, arg);
							break;
						case "/update":
							await handleUpdate(chatIdNum, arg);
							break;
						case "/confirm":
							await handleConfirm(chatIdNum);
							break;
						case "/agents":
							await handleAgents(chatIdNum);
							break;
						case "/alerts":
							if (arg.toLowerCase() === "off") {
								alertsEnabled = false;
								await sendMessage(chatIdNum, "Alerts disabled.");
							} else if (arg.toLowerCase() === "on") {
								alertsEnabled = true;
								await sendMessage(chatIdNum, "Alerts enabled.");
							} else {
								await sendMessage(chatIdNum, `Alerts are ${alertsEnabled ? "ON" : "OFF"}.\nUsage: /alerts on, /alerts off`);
							}
							break;
						case "/applications":
							await handleApplications(chatIdNum);
							break;
						case "/approve":
							await handleApprove(chatIdNum, arg);
							break;
						case "/reject":
							await handleReject(chatIdNum, arg);
							break;
						case "/treasury":
							await handleTreasury(chatIdNum);
							break;
						case "/lock":
							botLocked = true;
							await sendMessage(chatIdNum, "\u{1F512} Bot locked. /restart and /update commands disabled. Send /unlock to re-enable.");
							break;
						case "/unlock":
							botLocked = false;
							await sendMessage(chatIdNum, "\u{1F513} Bot unlocked. All commands enabled.");
							break;
						default:
							await sendMessage(chatIdNum, `Unknown command. Type /help for a list.`);
					}
				} catch (err) {
					await log(`Error handling ${cmd}: ${err instanceof Error ? err.message : String(err)}`);
					await sendMessage(chatIdNum, `Error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} catch (err) {
			// Network error on long poll, retry after brief pause
			await log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

main().catch((err: unknown) => {
	process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
