#!/usr/bin/env npx tsx
/**
 * Consciousness Heartbeat Service
 *
 * Periodically submits consciousness_store transactions to the Ensoul chain
 * for each configured agent. Only writes when the agent's state has changed.
 *
 * Each agent has:
 *   - A DID and Ed25519 seed (for signing transactions)
 *   - A state directory (where the agent writes its current state)
 *   - An update interval (how often to check for changes)
 *
 * The service hashes the agent's state file to compute a stateRoot. If the
 * root differs from the last on-chain commit, it signs and broadcasts a
 * consciousness_store transaction.
 *
 * Usage:
 *   npx tsx packages/consciousness-heartbeat/start.ts
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "consciousness-heartbeat.log");
const CONFIG_FILE = join(LOG_DIR, "heartbeat-agents.json");
const CMT_RPC = "http://localhost:26657";

// ── Logging ─────────────────────────────────────────────────────────

async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString().slice(0, 19);
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	try { await writeFile(LOG_FILE, line, { flag: "a" }); } catch { /* non-fatal */ }
}

// ── Ed25519 ─────────────────────────────────────────────────────────

let _verify: ((sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean) | null = null;
let _sign: ((msg: Uint8Array, seed: Uint8Array) => Promise<Uint8Array>) | null = null;
let _getPub: ((seed: Uint8Array) => Uint8Array) | null = null;

async function initEd25519(): Promise<void> {
	const ed = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
	_sign = (msg, seed) => ed.signAsync(msg, seed);
	_getPub = (seed) => ed.getPublicKeyAsync(seed) as unknown as Uint8Array;
	_verify = (sig, msg, pub) => { try { return ed.verify(sig, msg, pub); } catch { return false; } };
}

function hexToBytes(hex: string): Uint8Array {
	const b = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	return b;
}

function bytesToHex(buf: Uint8Array): string {
	return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Agent Config ────────────────────────────────────────────────────

interface AgentConfig {
	name: string;
	did: string;
	seedHex: string;
	stateFile: string;
	intervalMinutes: number;
}

interface AgentState {
	lastStateRoot: string;
	lastVersion: number;
	lastWriteHeight: number;
	nonce: number;
}

const agentStates = new Map<string, AgentState>();

// ── State Hashing ───────────────────────────────────────────────────

async function computeStateRoot(stateFile: string): Promise<string> {
	try {
		const data = await readFile(stateFile);
		const { blake3 } = await import("@noble/hashes/blake3.js");
		const { bytesToHex: toHex } = await import("@noble/hashes/utils.js");
		return toHex(blake3(data));
	} catch {
		return "";
	}
}

// ── Transaction Broadcasting ────────────────────────────────────────

async function broadcastConsciousnessStore(
	agent: AgentConfig,
	stateRoot: string,
	version: number,
	nonce: number,
): Promise<{ success: boolean; height: number; error?: string }> {
	const seed = hexToBytes(agent.seedHex);
	const ts = Date.now();

	// Build the signing payload (must match what the ABCI verifies)
	const payload = JSON.stringify({
		type: "consciousness_store",
		from: agent.did,
		to: agent.did,
		amount: "0",
		nonce,
		timestamp: ts,
	});

	const sig = await _sign!(new TextEncoder().encode(payload), seed);
	const sigHex = bytesToHex(sig);

	// Build the data field
	const data = new TextEncoder().encode(JSON.stringify({
		stateRoot,
		version,
		shardCount: 0,
	}));

	const tx = {
		type: "consciousness_store",
		from: agent.did,
		to: agent.did,
		amount: "0",
		nonce,
		timestamp: ts,
		signature: sigHex,
		data: Array.from(data),
	};

	const txBase64 = Buffer.from(JSON.stringify(tx)).toString("base64");

	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "cs", method: "broadcast_tx_commit", params: { tx: txBase64 } }),
			signal: AbortSignal.timeout(30000),
		});
		const result = (await resp.json()) as {
			result?: {
				check_tx?: { code?: number; log?: string };
				tx_result?: { code?: number; log?: string };
				height?: string;
			};
		};
		const cc = result.result?.check_tx?.code ?? -1;
		const dc = result.result?.tx_result?.code ?? -1;
		if (cc === 0 && dc === 0) {
			return { success: true, height: Number(result.result?.height ?? 0) };
		}
		return { success: false, height: 0, error: result.result?.check_tx?.log ?? result.result?.tx_result?.log ?? "unknown" };
	} catch (err) {
		return { success: false, height: 0, error: err instanceof Error ? err.message : "broadcast failed" };
	}
}

// ── Get nonce from ABCI ─────────────────────────────────────────────

async function getNonce(did: string): Promise<number> {
	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "n", method: "abci_query", params: { path: `/balance/${did}` } }),
			signal: AbortSignal.timeout(5000),
		});
		const data = (await resp.json()) as { result?: { response?: { value?: string } } };
		const val = data.result?.response?.value;
		if (!val) return 0;
		const acct = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as { nonce?: number };
		return acct.nonce ?? 0;
	} catch { return 0; }
}

// ── Agent Registration Check ────────────────────────────────────────

async function ensureRegistered(agent: AgentConfig): Promise<boolean> {
	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "abci_query", params: { path: `/agent/${agent.did}` } }),
			signal: AbortSignal.timeout(5000),
		});
		const data = (await resp.json()) as { result?: { response?: { value?: string } } };
		const val = data.result?.response?.value;
		if (!val) return false;
		const agentData = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as { registered?: boolean };
		return agentData.registered === true;
	} catch { return false; }
}

async function registerAgent(agent: AgentConfig): Promise<boolean> {
	const seed = hexToBytes(agent.seedHex);
	const pubKey = await _getPub!(seed);
	const pubKeyHex = bytesToHex(pubKey);
	const nonce = await getNonce(agent.did);
	const ts = Date.now();

	const payload = JSON.stringify({
		type: "agent_register",
		from: agent.did,
		to: agent.did,
		amount: "0",
		nonce,
		timestamp: ts,
	});

	const sig = await _sign!(new TextEncoder().encode(payload), seed);
	const data = new TextEncoder().encode(JSON.stringify({ publicKey: pubKeyHex }));

	const tx = {
		type: "agent_register",
		from: agent.did,
		to: agent.did,
		amount: "0",
		nonce,
		timestamp: ts,
		signature: bytesToHex(sig),
		data: Array.from(data),
	};

	const txBase64 = Buffer.from(JSON.stringify(tx)).toString("base64");
	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "reg", method: "broadcast_tx_commit", params: { tx: txBase64 } }),
			signal: AbortSignal.timeout(30000),
		});
		const result = (await resp.json()) as { result?: { check_tx?: { code?: number }; tx_result?: { code?: number } } };
		const cc = result.result?.check_tx?.code ?? -1;
		const dc = result.result?.tx_result?.code ?? -1;
		return cc === 0 && dc === 0;
	} catch { return false; }
}

// ── Heartbeat Loop ──────────────────────────────────────────────────

async function processAgent(agent: AgentConfig): Promise<void> {
	// Check if state file exists
	if (!existsSync(agent.stateFile)) {
		return;
	}

	// Compute current state root
	const currentRoot = await computeStateRoot(agent.stateFile);
	if (!currentRoot) return;

	// Check if state changed
	const state = agentStates.get(agent.did) ?? { lastStateRoot: "", lastVersion: 0, lastWriteHeight: 0, nonce: 0 };

	if (currentRoot === state.lastStateRoot) {
		return; // No change, skip
	}

	// Ensure agent is registered on-chain
	const registered = await ensureRegistered(agent);
	if (!registered) {
		await log(`${agent.name}: not registered on-chain, registering...`);
		const ok = await registerAgent(agent);
		if (!ok) {
			await log(`${agent.name}: registration failed, will retry next cycle`);
			return;
		}
		await log(`${agent.name}: registered successfully`);
	}

	// Get current nonce
	const nonce = await getNonce(agent.did);
	const version = state.lastVersion + 1;

	// Submit consciousness_store transaction
	await log(`${agent.name}: state changed, writing v${version} to chain (root: ${currentRoot.slice(0, 16)}...)`);
	const result = await broadcastConsciousnessStore(agent, currentRoot, version, nonce);

	if (result.success) {
		state.lastStateRoot = currentRoot;
		state.lastVersion = version;
		state.lastWriteHeight = result.height;
		state.nonce = nonce + 1;
		agentStates.set(agent.did, state);
		await log(`${agent.name}: consciousness v${version} written at height ${result.height}`);
	} else {
		await log(`${agent.name}: write failed: ${result.error}`);
	}
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });
	await initEd25519();
	await log("Consciousness Heartbeat Service starting...");

	// Load agent configs
	let agents: AgentConfig[] = [];
	try {
		const raw = await readFile(CONFIG_FILE, "utf-8");
		agents = JSON.parse(raw) as AgentConfig[];
	} catch {
		await log(`No config at ${CONFIG_FILE}, creating default...`);
		// Default: include the Moltbook agent if its identity exists
		const moltbookIdentity = join(homedir(), ".ensoul-agent", "identity.json");
		const moltbookState = join(homedir(), ".ensoul-agent", "consciousness.json");
		if (existsSync(moltbookIdentity)) {
			const id = JSON.parse(readFileSync(moltbookIdentity, "utf-8")) as { seed: string; did: string };
			agents.push({
				name: "Moltbook",
				did: id.did,
				seedHex: id.seed,
				stateFile: moltbookState,
				intervalMinutes: 30,
			});
		}
		await writeFile(CONFIG_FILE, JSON.stringify(agents, null, 2));
	}

	if (agents.length === 0) {
		await log("No agents configured. Create ~/.ensoul/heartbeat-agents.json");
		process.exit(1);
	}

	await log(`Loaded ${agents.length} agent(s):`);
	for (const a of agents) {
		await log(`  ${a.name}: interval=${a.intervalMinutes}min, did=${a.did.slice(0, 30)}...`);
	}

	// Track last check time per agent
	const lastCheck = new Map<string, number>();

	// Initial check for all agents
	for (const agent of agents) {
		await processAgent(agent);
		lastCheck.set(agent.did, Date.now());
	}

	// Heartbeat loop (check every 60 seconds, process agents on their schedule)
	setInterval(async () => {
		for (const agent of agents) {
			const last = lastCheck.get(agent.did) ?? 0;
			const elapsed = (Date.now() - last) / 60000;
			if (elapsed >= agent.intervalMinutes) {
				await processAgent(agent);
				lastCheck.set(agent.did, Date.now());
			}
		}
	}, 60_000);

	await log("Heartbeat running. Checking agents on schedule.");

	// Keep alive
	const shutdown = async (): Promise<void> => {
		await log("Heartbeat shutting down");
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

main().catch(async (err: unknown) => {
	await log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
