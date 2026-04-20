#!/usr/bin/env npx tsx
/**
 * Ensoul Public API Gateway
 *
 * Stateless HTTP proxy that routes agent requests to the validator network.
 * Runs at api.ensoul.dev. Agents connect here to store/retrieve consciousness.
 *
 * Usage:
 *   npx tsx packages/api/start.ts
 *   npx tsx packages/api/start.ts --port 5000
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { StateStore } from "./telemetry/state-store.js";
import { RetentionStore } from "./telemetry/retention-store.js";
import { AdmissionChecker } from "./telemetry/admission.js";
import { RateLimiter as TelemetryRateLimiter } from "./telemetry/rate-limit.js";
import { StubAlertDispatcher } from "./telemetry/alerts.js";
import { HealthEngine } from "./telemetry/health.js";
import { telemetryRoutes } from "./telemetry/routes.js";

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 5000);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..", "..");
const DEFAULT_ONBOARDING_KEY_PATH = join(REPO_DIR, "genesis-keys", "onboarding.json");
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "api.log");

// CometBFT RPC endpoint. Defaults to Ashburn (cloud, always available).
const CMT_RPC = process.env["CMT_RPC"] ?? "http://178.156.199.91:26657";

// ── Types ────────────────────────────────────────────────────────────

interface StoreRequest {
	did: string;
	encryptedShards: string[];
	stateRoot: string;
	version: number;
}

interface HandshakeVerifyRequest {
	identity: string;
	proof: string;
	since: string;
}

interface AgentRegisterRequest {
	did: string;
	publicKey: string;
	metadata?: Record<string, string>;
}

interface ValidatorRegisterRequest {
	did: string;
	publicKey: string;
	name: string;
	ip?: string;
}

// ── State ────────────────────────────────────────────────────────────

const AGENTS_FILE = join(LOG_DIR, "registered-agents.json");
const registeredAgents = new Map<string, { did: string; publicKey: string; registeredAt: number }>();

async function loadRegisteredAgents(): Promise<void> {
	try {
		const raw = await readFile(AGENTS_FILE, "utf-8");
		const entries = JSON.parse(raw) as Array<{ did: string; publicKey: string; registeredAt: number }>;
		for (const e of entries) {
			registeredAgents.set(e.did, e);
		}
		await log(`Loaded ${registeredAgents.size} registered agents from disk`);
	} catch {
		// File does not exist yet, start fresh
	}
}

async function saveRegisteredAgents(): Promise<void> {
	const entries = [...registeredAgents.values()];
	await writeFile(AGENTS_FILE, JSON.stringify(entries, null, 2));
}
// ── Validator registration state ─────────────────────────────────────

interface RegisteredValidator {
	did: string;
	name: string;
	publicKey: string;
	registeredAt: number;
	delegated: string;
	lastSeen: number;
	tier?: "genesis" | "pioneer" | "standard";
}

const VALIDATORS_FILE = join(LOG_DIR, "registered-validators.json");
const registeredValidators = new Map<string, RegisteredValidator>();

async function loadRegisteredValidators(): Promise<void> {
	try {
		const raw = await readFile(VALIDATORS_FILE, "utf-8");
		const entries = JSON.parse(raw) as RegisteredValidator[];
		for (const e of entries) {
			registeredValidators.set(e.did, e);
		}
		await log(`Loaded ${registeredValidators.size} registered validators from disk`);
	} catch {
		// File does not exist yet
	}
}

async function saveRegisteredValidators(): Promise<void> {
	const entries = [...registeredValidators.values()];
	await writeFile(VALIDATORS_FILE, JSON.stringify(entries, null, 2));
}

// Treasury key: loaded per-sign, same pattern as onboarding key
const DEFAULT_TREASURY_KEY_PATH = join(REPO_DIR, "genesis-keys", "treasury.json");
let treasuryDid: string | null = null;
let treasuryKeyPath: string | null = null;
let treasuryNonce = 0;
const FOUNDATION_DELEGATION = 1_000_000n * (10n ** 18n); // 1,000,000 ENSL
const PIONEER_DELEGATION = 2_000_000n * (10n ** 18n); // 2,000,000 ENSL
const PIONEER_CAP = 20;
let pioneerCount = 0;
const DAILY_VALIDATOR_CAP = 100;
let dailyValidatorCount = 0;
let dailyValidatorDate = new Date().toISOString().slice(0, 10);

function checkDailyValidatorCap(): boolean {
	const today = new Date().toISOString().slice(0, 10);
	if (today !== dailyValidatorDate) {
		dailyValidatorDate = today;
		dailyValidatorCount = 0;
	}
	return dailyValidatorCount < DAILY_VALIDATOR_CAP;
}

async function loadTreasuryKey(): Promise<void> {
	const keyPath = process.env["TREASURY_KEY_PATH"] ?? DEFAULT_TREASURY_KEY_PATH;
	try {
		const raw = await readFile(keyPath, "utf-8");
		const data = JSON.parse(raw) as { did: string; role: string };
		treasuryDid = data.did;
		treasuryKeyPath = keyPath;
		await log(`Treasury key available: ${data.did} (role: ${data.role})`);
	} catch {
		await log(`Warning: treasury key not found at ${keyPath}. Validator delegation disabled.`);
	}
}

async function loadTreasurySeed(): Promise<string | null> {
	if (!treasuryKeyPath) return null;
	try {
		const raw = await readFile(treasuryKeyPath, "utf-8");
		const data = JSON.parse(raw) as { seed: string };
		return data.seed;
	} catch {
		return null;
	}
}

async function signAndSubmitDelegation(validatorDid: string, amount: bigint = FOUNDATION_DELEGATION): Promise<boolean> {
	if (!treasuryDid || !treasuryKeyPath) return false;

	try {
		const ts = Date.now();
		const txPayload = JSON.stringify({
			type: "delegate",
			from: treasuryDid,
			to: validatorDid,
			amount: amount.toString(),
			nonce: treasuryNonce,
			timestamp: ts,
		});

		const seedHex = await loadTreasurySeed();
		if (!seedHex) return false;

		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

		const seed = hexToBytes(seedHex);
		const signature = await ed.signAsync(
			new TextEncoder().encode(txPayload),
			seed,
		);
		seed.fill(0);

		const serializedTx = {
			type: "delegate",
			from: treasuryDid!,
			to: validatorDid,
			amount: amount.toString(),
			nonce: treasuryNonce,
			timestamp: ts,
			signature: bytesToHexLocal(signature),
		};

		const result = await broadcastTx(serializedTx);
		if (result.applied) {
			treasuryNonce++;
			await log(`Foundation delegation submitted: 100,000 ENSL to ${validatorDid} (height ${result.height})`);
			return true;
		}

		await log(`Foundation delegation failed for ${validatorDid}: ${result.error ?? "unknown"}`);
		return false;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await log(`Foundation delegation error: ${msg}`);
		return false;
	}
}

// ── Genesis validator discovery ──────────────────────────────────────

interface StakedAccount {
	did: string;
	balance: bigint;
	staked: bigint;
	delegated: bigint;
	pending: bigint;
	nonce: number;
}

/** DIDs extracted from genesis.json at startup. Never changes. */
let genesisDids: string[] = [];

/** Load all did:key: DIDs from genesis allocations. */
async function loadGenesisDids(): Promise<void> {
	const genesisPath = join(LOG_DIR, "genesis.json");
	try {
		const raw = await readFile(genesisPath, "utf-8");
		const genesis = JSON.parse(raw) as {
			transactions: Array<{ type: string; to: string }>;
		};
		const dids = new Set<string>();
		for (const tx of genesis.transactions) {
			if (tx.type === "genesis_allocation" && tx.to.startsWith("did:key:")) {
				dids.add(tx.to);
			}
		}
		genesisDids = [...dids].sort();
		await log(`Loaded ${genesisDids.length} validator DIDs from genesis.json`);
	} catch {
		await log("Warning: could not load genesis.json from ~/.ensoul/genesis.json. Validator discovery limited.");
	}
}

let allStakedAccounts: StakedAccount[] = [];
let stakedAccountsFetchedAt = 0;
const STAKED_ACCOUNTS_TTL = 60_000;

/**
 * Refresh account data for all genesis validators.
 * Queries ABCI directly via CometBFT RPC for each DID's balance.
 */
async function refreshStakedAccounts(): Promise<void> {
	if (Date.now() - stakedAccountsFetchedAt < STAKED_ACCOUNTS_TTL) return;

	// Combine genesis DIDs + registered validators
	const allDids = new Set(genesisDids);
	for (const [did] of registeredValidators) allDids.add(did);

	const accounts: StakedAccount[] = [];

	for (const did of allDids) {
		try {
			const d = await abciQuery(`/balance/${did}`);
			if (!d) continue;
			const staked = BigInt(String(d["stakedBalance"] ?? "0"));
			const balance = BigInt(String(d["balance"] ?? "0"));
			if (staked > 0n || balance > 0n) {
				accounts.push({
					did,
					balance,
					staked,
					delegated: BigInt(String(d["delegatedBalance"] ?? "0")),
					pending: BigInt(String(d["pendingRewards"] ?? "0")),
					nonce: Number(d["nonce"] ?? 0),
				});
			}
		} catch { /* skip failed queries */ }
	}

	allStakedAccounts = accounts;
	stakedAccountsFetchedAt = Date.now();
	await log(`Refreshed ${accounts.length} staked accounts via ABCI`);
}

// ── Block proposer counting ─────────────────────────────────────────

const blockProposerCounts = new Map<string, number>();
const blockProposerCounts24h = new Map<string, number>();
let proposerCountsFetchedAt = 0;
const PROPOSER_COUNTS_TTL = 60_000;

/** Scan recent blocks via CometBFT RPC to count proposers. */
async function refreshProposerCounts(): Promise<void> {
	if (Date.now() - proposerCountsFetchedAt < PROPOSER_COUNTS_TTL) return;

	try {
		// Get tip height from CometBFT status
		const status = await cometRpc("status");
		if (!status) return;
		const tipHeight = Number((status["sync_info"] as Record<string, unknown>)?.["latest_block_height"] ?? 0);
		if (tipHeight === 0) return;

		// Fetch blocks in batches of 20 (CometBFT blockchain endpoint limit)
		const fromHeight = Math.max(1, tipHeight - 999);
		const counts = new Map<string, number>();
		const counts24h = new Map<string, number>();
		const cutoff24h = Date.now() - 86400000;

		for (let min = fromHeight; min <= tipHeight; min += 20) {
			const max = Math.min(min + 19, tipHeight);
			const chainResp = await cometRpc("blockchain", { minHeight: String(min), maxHeight: String(max) });
			if (!chainResp) continue;

			const metas = chainResp["block_metas"] as Array<Record<string, unknown>> | undefined;
			if (!metas) continue;

			for (const meta of metas) {
				const header = meta["header"] as Record<string, unknown> | undefined;
				if (!header) continue;
				const proposer = String(header["proposer_address"] ?? "");
				if (!proposer) continue;
				const height = Number(header["height"] ?? 0);
				const blockTime = new Date(String(header["time"] ?? "")).getTime();

				counts.set(proposer, (counts.get(proposer) ?? 0) + 1);
				if (blockTime > cutoff24h) {
					counts24h.set(proposer, (counts24h.get(proposer) ?? 0) + 1);
				}

				void height; // used for iteration context
			}
		}

		blockProposerCounts.clear();
		for (const [k, v] of counts) blockProposerCounts.set(k, v);
		blockProposerCounts24h.clear();
		for (const [k, v] of counts24h) blockProposerCounts24h.set(k, v);
		proposerCountsFetchedAt = Date.now();

		await log(`Scanned blocks ${fromHeight} to ${tipHeight}, ${counts.size} unique proposers`);
	} catch { /* failed to refresh, will retry next TTL */ }
}

// Consciousness store (indexed by DID, persisted to disk)
const CONSCIOUSNESS_FILE = join(LOG_DIR, "consciousness-store.json");
const consciousnessStore = new Map<string, {
	did: string;
	stateRoot: string;
	version: number;
	shardCount: number;
	storedAt: number;
}>();

async function loadConsciousnessStore(): Promise<void> {
	try {
		const raw = await readFile(CONSCIOUSNESS_FILE, "utf-8");
		const entries = JSON.parse(raw) as Array<{
			did: string; stateRoot: string; version: number;
			shardCount: number; storedAt: number;
		}>;
		for (const e of entries) {
			consciousnessStore.set(e.did, e);
		}
		await log(`Loaded ${consciousnessStore.size} consciousness entries from disk`);
	} catch {
		// File does not exist yet
	}
}

async function saveConsciousnessStore(): Promise<void> {
	const entries = [...consciousnessStore.values()];
	await writeFile(CONSCIOUSNESS_FILE, JSON.stringify(entries));
}

// ── Onboarding key ───────────────────────────────────────────────────

// Onboarding key: loaded from file on each signing, NOT kept in memory.
// In production, this should use a hardware security module (HSM) or
// an encrypted keystore with password prompt.
let onboardingDid: string | null = null;
let onboardingKeyPath: string | null = null;
let onboardingNonce = 0;
const WELCOME_BONUS = 100n * (10n ** 18n); // 100 ENSL (reduced from 1000)
const MIN_ONBOARDING_BALANCE = 10_000_000n * (10n ** 18n); // 10M ENSL floor

// IP-based registration limit: 3 per IP per day
let ipRegistrations = new Map<string, number>();
let ipRegistrationDate = new Date().toISOString().slice(0, 10);

function checkIpLimit(ip: string): boolean {
	const today = new Date().toISOString().slice(0, 10);
	if (today !== ipRegistrationDate) {
		ipRegistrationDate = today;
		ipRegistrations = new Map();
	}
	return (ipRegistrations.get(ip) ?? 0) < 3;
}

function incrementIpCount(ip: string): void {
	ipRegistrations.set(ip, (ipRegistrations.get(ip) ?? 0) + 1);
}

/** Check onboarding account balance via ABCI. */
async function checkOnboardingBalance(): Promise<boolean> {
	if (!onboardingDid) return false;
	try {
		const data = await abciQuery(`/balance/${onboardingDid}`);
		if (!data) return true; // If ABCI unreachable, allow (best effort)
		const balance = BigInt(String(data["balance"] ?? "0"));
		if (balance < MIN_ONBOARDING_BALANCE) {
			await log(`WARNING: onboarding balance ${balance / (10n ** 18n)} ENSL below 10M floor. Bonuses paused.`);
			return false;
		}
		return true;
	} catch { return true; }
}

async function loadOnboardingKey(): Promise<void> {
	const keyPath = process.env["ONBOARDING_KEY_PATH"] ?? DEFAULT_ONBOARDING_KEY_PATH;
	try {
		const raw = await readFile(keyPath, "utf-8");
		const data = JSON.parse(raw) as { did: string; role: string };
		onboardingDid = data.did;
		onboardingKeyPath = keyPath;
		await log(`Onboarding key available: ${data.did} (role: ${data.role})`);
	} catch {
		await log(`Warning: onboarding key not found at ${keyPath}. Welcome bonus disabled.`);
	}
}

/** Load seed from file, use it, then discard. Never kept in memory. */
async function loadOnboardingSeed(): Promise<string | null> {
	if (!onboardingKeyPath) return null;
	try {
		const raw = await readFile(onboardingKeyPath, "utf-8");
		const data = JSON.parse(raw) as { seed: string };
		return data.seed;
	} catch {
		return null;
	}
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

function bytesToHexLocal(buf: Uint8Array): string {
	return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign a transfer transaction from the onboarding account.
 * Uses Ed25519 via dynamic import of @noble/ed25519 (available in @ensoul/node deps).
 */
async function signAndSubmitWelcomeBonus(agentDid: string): Promise<boolean> {
	if (!onboardingDid || !onboardingKeyPath) return false;

	try {
		const ts = Date.now();
		// Build the transaction payload (same format used for signature verification)
		const txPayload = JSON.stringify({
			type: "transfer",
			from: onboardingDid,
			to: agentDid,
			amount: WELCOME_BONUS.toString(),
			nonce: onboardingNonce,
			timestamp: ts,
		});

		// Load seed from file, sign, then discard immediately
		const seedHex = await loadOnboardingSeed();
		if (!seedHex) return false;

		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

		const seed = hexToBytes(seedHex);
		const signature = await ed.signAsync(
			new TextEncoder().encode(txPayload),
			seed,
		);
		// Clear seed from memory
		seed.fill(0);

		// Build serialized transaction (MUST use the same timestamp as the signed payload)
		const serializedTx = {
			type: "transfer",
			from: onboardingDid!,
			to: agentDid,
			amount: WELCOME_BONUS.toString(),
			nonce: onboardingNonce,
			timestamp: ts,
			signature: bytesToHexLocal(signature),
		};

		// Submit via CometBFT broadcast
		const result = await broadcastTx(serializedTx);
		if (result.applied) {
			onboardingNonce++;
			await log(`Welcome bonus submitted: 100 ENSL to ${agentDid} (nonce ${onboardingNonce - 1}, height ${result.height})`);
			return true;
		}

		await log(`Welcome bonus failed for ${agentDid}: ${result.error ?? "unknown"}`);
		return false;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await log(`Welcome bonus error: ${msg}`);
		return false;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString();
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	try {
		await appendFile(LOG_FILE, line);
	} catch { /* non-fatal */ }
}

const DECIMALS_VAL = 10n ** 18n;

function fmtEnsl(wei: bigint): string {
	const whole = wei / DECIMALS_VAL;
	const frac = wei % DECIMALS_VAL;
	const fracStr = frac.toString().padStart(18, "0").slice(0, 2);
	const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${wholeStr}.${fracStr} ENSL`;
}

async function queryValidatorStatus(): Promise<{ height: number; validatorCount: number; alive: number }> {
	// Get chain height from CometBFT status
	const status = await cometRpc("status");
	const height = Number((status?.["sync_info"] as Record<string, unknown>)?.["latest_block_height"] ?? 0);

	// Get validator count from CometBFT's live validator set — this is the
	// source of truth for how many validators are in consensus, including
	// Pioneers. The ABCI's consensusSetSize may lag behind.
	let validatorCount = 0;
	const cmtVals = await cometRpc("validators", { per_page: "100" });
	if (cmtVals) {
		const vals = cmtVals["validators"] as Array<{ voting_power: string }> | undefined;
		if (vals) validatorCount = vals.filter(v => Number(v.voting_power) > 0).length;
	}
	// Fall back to ABCI stats if CometBFT call failed
	if (!validatorCount) {
		const stats = await abciQuery("/stats");
		validatorCount = Number(stats?.["consensusSetSize"] ?? 0);
	}

	// Get peer count from net_info (alive = self + peers)
	const netInfo = await cometRpc("net_info");
	const peerCount = Number(netInfo?.["n_peers"] ?? 0);
	const alive = peerCount + 1; // include self

	return { height, validatorCount, alive };
}

/** Query the ABCI application state via CometBFT RPC (single source of truth). */
async function abciQuery(path: string): Promise<Record<string, unknown> | null> {
	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "q", method: "abci_query", params: { path } }),
			signal: AbortSignal.timeout(5000),
		});
		const result = (await resp.json()) as { result?: { response?: { value?: string } } };
		const val = result.result?.response?.value;
		if (!val) return null;
		return JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as Record<string, unknown>;
	} catch { return null; }
}

/** Call a CometBFT RPC method directly (status, block, net_info, validators, etc.). */
async function cometRpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
			signal: AbortSignal.timeout(5000),
		});
		const result = (await resp.json()) as { result?: Record<string, unknown> };
		return result.result ?? null;
	} catch { return null; }
}

/** Broadcast a signed transaction via CometBFT and wait for block inclusion. */
async function broadcastTx(tx: Record<string, unknown>): Promise<{ applied: boolean; height: number; hash: string; error?: string }> {
	const txBase64 = Buffer.from(JSON.stringify(tx)).toString("base64");
	try {
		const resp = await fetch(CMT_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "tx", method: "broadcast_tx_commit", params: { tx: txBase64 } }),
			signal: AbortSignal.timeout(30000),
		});
		const result = (await resp.json()) as {
			result?: {
				check_tx?: { code?: number; log?: string };
				tx_result?: { code?: number; log?: string };
				height?: string;
				hash?: string;
			};
		};
		const cc = result.result?.check_tx?.code ?? 0;
		const dc = result.result?.tx_result?.code ?? 0;
		return {
			applied: cc === 0 && dc === 0,
			height: Number(result.result?.height ?? 0),
			hash: result.result?.hash ?? "",
			error: cc !== 0 ? result.result?.check_tx?.log : (dc !== 0 ? result.result?.tx_result?.log : undefined),
		};
	} catch (err) {
		return { applied: false, height: 0, hash: "", error: err instanceof Error ? err.message : "broadcast failed" };
	}
}

// ── Daily bonus cap ──────────────────────────────────────────────────

const DAILY_BONUS_CAP = 100;
let dailyBonusCount = 0;
let dailyBonusDate = new Date().toISOString().slice(0, 10);

function checkDailyBonusCap(): boolean {
	const today = new Date().toISOString().slice(0, 10);
	if (today !== dailyBonusDate) {
		dailyBonusDate = today;
		dailyBonusCount = 0;
	}
	return dailyBonusCount < DAILY_BONUS_CAP;
}

function incrementDailyBonus(): void {
	dailyBonusCount++;
}

// ── Server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });
	await loadGenesisDids();
	await loadRegisteredAgents();
	await loadConsciousnessStore();
	await loadRegisteredValidators();
	// Count existing pioneers
	for (const [, v] of registeredValidators) {
		if (v.tier === "pioneer") pioneerCount++;
	}
	if (pioneerCount > 0) await log(`Pioneer validators: ${pioneerCount}/${PIONEER_CAP}`);
	await loadOnboardingKey();
	await loadTreasuryKey();

	const app = Fastify({ logger: false, bodyLimit: 1048576 }); // 1MB default

	// CORS for all origins
	await app.register(cors, { origin: true });

	// Rate limiting: 100/min per IP, 1000/min global
	await app.register(rateLimit, {
		max: 100,
		timeWindow: "1 minute",
		global: true,
	});

	// ── Telemetry receiver ──────────────────────────────────────
	const telemetryStateStore = new StateStore();
	const telemetryRetentionStore = new RetentionStore();
	const telemetryRateLimiter = new TelemetryRateLimiter();
	await telemetryStateStore.loadFromDisk();
	const telemetryAlerts = new StubAlertDispatcher(telemetryStateStore);
	const telemetryHealth = new HealthEngine(telemetryStateStore, telemetryAlerts);

	// AdmissionChecker uses a getter so runtime Pioneer approvals are
	// visible without restart. pioneerApps is declared later in main()
	// but the getter is only called at request time, after initialization.
	const telemetryAdmission = new AdmissionChecker(abciQuery, () => pioneerApps);

	await app.register(
		telemetryRoutes(telemetryStateStore, telemetryRetentionStore, telemetryAdmission, telemetryRateLimiter, telemetryHealth),
	);

	// GET /v1/telemetry/state - public, returns current telemetry state
	let telemetryStateCache: { data: unknown; cachedAt: number } | null = null;
	app.get("/v1/telemetry/state", async () => {
		const now = Date.now();
		if (telemetryStateCache && now - telemetryStateCache.cachedAt < 10_000) {
			return telemetryStateCache.data;
		}
		const entries = telemetryStateStore.all();
		telemetryStateCache = { data: entries, cachedAt: now };
		return entries;
	});

	telemetryStateStore.startFlushInterval();
	const telemetryTickInterval = setInterval(() => {
		void telemetryHealth.tick(telemetryStateStore.all());
		telemetryRateLimiter.gc();
	}, 60_000);

	// Stricter rate limit for write endpoints (10 req/min per IP)
	const writeRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

	// Request logging
	app.addHook("onRequest", (req, _reply, done) => {
		void log(`${req.method} ${req.url} from ${req.ip}`);
		done();
	});

	// ── Health ───────────────────────────────────────────────────

	app.get("/health", async () => {
		const net = await queryValidatorStatus();
		return { status: "ok", validators: net.alive, blockHeight: net.height };
	});

	// ── DID Verification ─────────────────────────────────────────

	app.get<{ Querystring: { publicKey?: string } }>("/v1/verify-did", async (req, reply) => {
		const pubKeyHex = req.query.publicKey;
		if (!pubKeyHex || pubKeyHex.length !== 64) {
			return reply.status(400).send({ error: "publicKey query parameter required (64 hex chars)" });
		}
		// Derive the canonical DID using the same multicodec encoding as @ensoul/identity
		const pubKeyBytes = hexToBytes(pubKeyHex);
		// Multicodec ed25519-pub: 0xed01
		const mc = new Uint8Array(2 + pubKeyBytes.length);
		mc[0] = 0xed; mc[1] = 0x01;
		mc.set(pubKeyBytes, 2);
		// Base58btc encode
		const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
		let num = 0n;
		for (const byte of mc) num = num * 256n + BigInt(byte);
		let encoded = "";
		while (num > 0n) { encoded = B58[Number(num % 58n)] + encoded; num = num / 58n; }
		for (const byte of mc) { if (byte === 0) encoded = "1" + encoded; else break; }
		const did = `did:key:z${encoded}`;
		return { did, publicKey: pubKeyHex };
	});

	// ── Account Balance ──────────────────────────────────────────

	app.get<{ Params: { did: string } }>("/v1/account/:did", async (req) => {
		const did = decodeURIComponent(req.params.did);

		// Query ABCI directly for account balance
		const data = await abciQuery(`/balance/${did}`);
		if (data) {
			const available = BigInt(String(data["balance"] ?? "0"));
			const staked = BigInt(String(data["stakedBalance"] ?? "0"));
			const delegated = BigInt(String(data["delegatedBalance"] ?? "0"));
			const unstaking = BigInt(String(data["unstaking"] ?? "0"));
			const pending = BigInt(String(data["pendingRewards"] ?? "0"));
			const credits = BigInt(String(data["storageCredits"] ?? "0"));
			const total = available + staked + delegated + unstaking + pending;

			return {
				did: String(data["did"] ?? did),
				available: fmtEnsl(available),
				staked: fmtEnsl(staked),
				delegated: fmtEnsl(delegated),
				unstaking: fmtEnsl(unstaking),
				unstakingCompleteAt: Number(data["unstakingCompleteAt"] ?? 0),
				pendingRewards: fmtEnsl(pending),
				storageCredits: credits.toString(),
				total: fmtEnsl(total),
				raw: {
					available: available.toString(),
					staked: staked.toString(),
					delegated: delegated.toString(),
					unstaking: unstaking.toString(),
					pendingRewards: pending.toString(),
					storageCredits: credits.toString(),
					total: total.toString(),
				},
				nonce: Number(data["nonce"] ?? 0),
			};
		}

		// ABCI unreachable or DID never seen: return zeroes
		return {
			did,
			available: "0.00 ENSL",
			staked: "0.00 ENSL",
			delegated: "0.00 ENSL",
			unstaking: "0.00 ENSL",
			unstakingCompleteAt: 0,
			pendingRewards: "0.00 ENSL",
			storageCredits: "0",
			total: "0.00 ENSL",
			raw: {
				available: "0", staked: "0", delegated: "0",
				unstaking: "0", pendingRewards: "0", storageCredits: "0", total: "0",
			},
			nonce: 0,
		};
	});

	// ── Transaction History ──────────────────────────────────────
	// GET /v1/account/:did/transactions?limit=50
	// Returns recent transactions where this DID is sender or recipient.
	// Sources the data from CometBFT's tx_search (query all txs, decode JSON,
	// filter client-side). Cached per-DID for 10s to avoid hammering the node.
	const txHistoryCache = new Map<string, { fetchedAt: number; data: unknown }>();
	const TX_HISTORY_TTL = 10_000;

	app.get<{ Params: { did: string }; Querystring: Record<string, string> }>(
		"/v1/account/:did/transactions",
		async (req) => {
			const did = decodeURIComponent(req.params.did);
			const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50));
			const cacheKey = `${did}|${limit}`;

			const cached = txHistoryCache.get(cacheKey);
			if (cached && Date.now() - cached.fetchedAt < TX_HISTORY_TTL) {
				return cached.data;
			}

			// Fetch recent txs (descending height) from CometBFT.
			// per_page is capped to 100 by CometBFT; that covers a deep window
			// for a single account since most DIDs transact rarely.
			const result = await cometRpc("tx_search", {
				query: "tx.height > 0",
				per_page: "100",
				page: "1",
				order_by: "desc",
			});

			interface CmtTx {
				hash?: string;
				height?: string;
				tx_result?: { code?: number; log?: string };
				tx?: string;
			}
			const rawTxs: CmtTx[] = Array.isArray(result?.["txs"]) ? (result["txs"] as CmtTx[]) : [];

			const txs: Array<Record<string, unknown>> = [];
			for (const r of rawTxs) {
				if (!r.tx) continue;
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(Buffer.from(r.tx, "base64").toString("utf-8")) as Record<string, unknown>;
				} catch { continue; }

				const from = String(parsed["from"] ?? "");
				const to = String(parsed["to"] ?? "");
				if (from !== did && to !== did) continue;

				const direction = from === did ? (to === did ? "self" : "out") : "in";
				const counterparty = direction === "out" ? to : direction === "in" ? from : did;
				const amountWei = String(parsed["amount"] ?? "0");
				const amountFormatted = (() => {
					try { return fmtEnsl(BigInt(amountWei)); } catch { return "0.00 ENSL"; }
				})();

				txs.push({
					hash: r.hash ?? "",
					height: Number(r.height ?? 0),
					type: String(parsed["type"] ?? "unknown"),
					from,
					to,
					amount: amountFormatted,
					amountRaw: amountWei,
					nonce: Number(parsed["nonce"] ?? 0),
					timestamp: Number(parsed["timestamp"] ?? 0),
					success: (r.tx_result?.code ?? 0) === 0,
					log: r.tx_result?.log ?? "",
					direction,
					counterparty,
				});

				if (txs.length >= limit) break;
			}

			const data = { did, count: txs.length, transactions: txs };
			txHistoryCache.set(cacheKey, { fetchedAt: Date.now(), data });
			return data;
		},
	);

	// ── Network Status ───────────────────────────────────────────

	app.get("/v1/network/status", async () => {
		const net = await queryValidatorStatus();
		const stats = await abciQuery("/stats");

		return {
			blockHeight: net.height,
			validatorCount: net.validatorCount,
			agentCount: Number(stats?.["agentCount"] ?? registeredAgents.size),
			totalConsciousnessStored: Number(stats?.["consciousnessCount"] ?? consciousnessStore.size),
			peers: net.alive,
		};
	});

	// ── Network Version ─────────────────────────────────────────

	app.get("/v1/network/version", async () => {
		return { version: "1.0.0", minimumVersion: "1.0.0" };
	});

	// ── Stats (from ABCI, single source of truth) ────────────────

	app.get("/v1/stats", async () => {
		const stats = await abciQuery("/stats");
		if (stats) return stats;
		// Fallback
		const net = await queryValidatorStatus();
		return { height: net.height, agentCount: registeredAgents.size, consciousnessCount: consciousnessStore.size };
	});

	// ── Genesis file for new validators ──────────────────────────

	app.get("/genesis", async (_req, reply) => {
		try {
			const genesisPath = join(homedir(), ".cometbft-ensoul", "node", "config", "genesis.json");
			const raw = await readFile(genesisPath, "utf-8");
			return reply.type("application/json").send(raw);
		} catch {
			return reply.status(404).send({ error: "Genesis file not found" });
		}
	});

	// ── Network Peer Registry ───────────────────────────────────

	const PEERS_FILE = join(LOG_DIR, "network-peers.json");
	interface NetworkPeer {
		nodeId: string;
		publicIp: string;
		moniker: string;
		rpcPort: number;
		registeredAt: number;
		lastSeen: number;
	}

	let networkPeers: NetworkPeer[] = [];
	try {
		const raw = await readFile(PEERS_FILE, "utf-8");
		networkPeers = JSON.parse(raw) as NetworkPeer[];
	} catch { /* start fresh */ }

	async function saveNetworkPeers(): Promise<void> {
		await writeFile(PEERS_FILE, JSON.stringify(networkPeers, null, 2));
	}

	// Auto-discover peers from CometBFT net_info every 60 seconds
	setInterval(async () => {
		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "ni", method: "net_info", params: {} }),
				signal: AbortSignal.timeout(5000),
			});
			if (!resp.ok) return;
			const data = (await resp.json()) as { result: { peers: Array<{ node_info: { id: string; moniker: string; listen_addr: string }; remote_ip: string }> } };
			for (const p of data.result.peers) {
				const existing = networkPeers.find(np => np.nodeId === p.node_info.id);
				if (existing) {
					existing.lastSeen = Date.now();
					existing.moniker = p.node_info.moniker;
					if (!existing.publicIp || existing.publicIp.startsWith("100.")) {
						existing.publicIp = p.remote_ip;
					}
				} else {
					// Only add if it has a non-private IP
					const ip = p.remote_ip;
					if (!ip.startsWith("10.") && !ip.startsWith("172.") && !ip.startsWith("192.168.")) {
						networkPeers.push({
							nodeId: p.node_info.id,
							publicIp: ip,
							moniker: p.node_info.moniker,
							rpcPort: 26657,
							registeredAt: Date.now(),
							lastSeen: Date.now(),
						});
					}
				}
			}
			await saveNetworkPeers();
		} catch { /* non-fatal */ }
	}, 60_000);

	/** POST /v1/network/register-peer */
	app.post<{ Body: Record<string, unknown> }>("/v1/network/register-peer", { bodyLimit: 4096 }, async (_req, reply) => {
		const body = _req.body;
		const nodeId = String(body["node_id"] ?? "");
		const publicIp = String(body["public_ip"] ?? _req.ip);
		const moniker = String(body["moniker"] ?? "");
		const rpcPort = Number(body["rpc_port"] ?? 26657);

		if (!nodeId || nodeId.length < 10) {
			return reply.status(400).send({ error: "node_id required (CometBFT node ID)" });
		}

		const existing = networkPeers.find(p => p.nodeId === nodeId);
		if (existing) {
			existing.publicIp = publicIp;
			existing.moniker = moniker || existing.moniker;
			existing.lastSeen = Date.now();
		} else {
			networkPeers.push({ nodeId, publicIp, moniker, rpcPort, registeredAt: Date.now(), lastSeen: Date.now() });
		}
		await saveNetworkPeers();
		await log(`Peer registered: ${moniker || nodeId.slice(0, 12)} @ ${publicIp}`);

		return { registered: true, nodeId, publicIp, totalPeers: networkPeers.length };
	});

	/** GET /v1/network/peers */
	app.get("/v1/network/peers", async () => {
		// Also include active validators from CometBFT
		const validators: Array<Record<string, unknown>> = [];
		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "v", method: "validators", params: {} }),
				signal: AbortSignal.timeout(5000),
			});
			if (resp.ok) {
				const data = (await resp.json()) as { result: { validators: Array<{ address: string; voting_power: string }> } };
				for (const v of data.result.validators) {
					validators.push({ address: v.address, votingPower: v.voting_power });
				}
			}
		} catch { /* non-fatal */ }

		return {
			peers: networkPeers.map(p => ({
				nodeId: p.nodeId,
				publicIp: p.publicIp,
				moniker: p.moniker,
				p2pAddress: `${p.nodeId}@${p.publicIp}:26656`,
				lastSeen: new Date(p.lastSeen).toISOString(),
			})),
			activeValidators: validators.length,
			totalPeers: networkPeers.length,
		};
	});

	// ── Transaction broadcast (forward to CometBFT) ─────────────

	app.post<{ Body: Record<string, unknown> }>("/v1/tx/broadcast", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
		const tx = req.body;
		const txJson = JSON.stringify(tx);
		const txBase64 = Buffer.from(txJson).toString("base64");

		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0", id: "tx",
					method: "broadcast_tx_commit",
					params: { tx: txBase64 },
				}),
				signal: AbortSignal.timeout(30000),
			});
			const result = (await resp.json()) as {
				result?: {
					check_tx?: { code?: number; log?: string };
					tx_result?: { code?: number; log?: string };
					height?: string;
					hash?: string;
				};
			};

			const cc = result.result?.check_tx?.code ?? 0;
			const dc = result.result?.tx_result?.code ?? 0;
			return {
				applied: cc === 0 && dc === 0,
				height: Number(result.result?.height ?? 0),
				hash: result.result?.hash ?? "",
				error: cc !== 0 ? result.result?.check_tx?.log : (dc !== 0 ? result.result?.tx_result?.log : undefined),
			};
		} catch (err) {
			return reply.status(502).send({
				applied: false,
				error: err instanceof Error ? err.message : "broadcast failed",
			});
		}
	});

	// ── Validators (from ABCI) ───────────────────────────────────

	app.get("/v1/validators", async () => {
		const data = await abciQuery("/validators");
		if (data) return data;
		// Fallback
		return { validators: [], error: "ABCI unreachable" };
	});

	// ── Pioneer Applications ─────────────────────────────────────

	// ── Pioneer Application State ───────────────────────────────

	interface PioneerApp {
		did: string;
		name: string;
		contact: string;
		ip?: string;
		appliedAt: string;
		status: "pending" | "approved" | "rejected";
		approvedAt?: string;
		rejectedAt?: string;
		rejectionReason?: string;
		delegationHeight?: number;
		delegationHash?: string;
		lockedUntil?: number;
	}

	const PIONEER_APPS_FILE = join(LOG_DIR, "pioneer-applications.json");
	const pioneerApps: PioneerApp[] = [];
	try {
		const raw = await readFile(PIONEER_APPS_FILE, "utf-8");
		const loaded = JSON.parse(raw) as Array<Record<string, unknown>>;
		for (const a of loaded) {
			pioneerApps.push({
				did: String(a["did"] ?? ""),
				name: String(a["name"] ?? ""),
				contact: String(a["contact"] ?? ""),
				ip: a["ip"] as string | undefined,
				appliedAt: String(a["appliedAt"] ?? ""),
				status: (a["status"] as PioneerApp["status"]) ?? "pending",
				approvedAt: a["approvedAt"] as string | undefined,
				rejectedAt: a["rejectedAt"] as string | undefined,
				rejectionReason: a["rejectionReason"] as string | undefined,
				delegationHeight: a["delegationHeight"] as number | undefined,
				delegationHash: a["delegationHash"] as string | undefined,
				lockedUntil: a["lockedUntil"] as number | undefined,
			});
		}
	} catch { /* no existing applications */ }

	async function savePioneerApps(): Promise<void> {
		try { await writeFile(PIONEER_APPS_FILE, JSON.stringify(pioneerApps, null, 2)); } catch { /* non-fatal */ }
	}

	const ADMIN_KEY = process.env["ENSOUL_ADMIN_KEY"] ?? "";
	const PIONEER_LOCK_MS = 63_072_000_000; // 24 months
	const PIONEER_DELEGATION_AMOUNT = "1000000000000000000000000"; // 1M ENSL (18 decimals)

	function checkAdminKey(key: string): boolean {
		return ADMIN_KEY.length > 0 && key === ADMIN_KEY;
	}

	// Load the governance signing key (PIONEER_KEY identity)
	let governanceSeed: Uint8Array | null = null;
	let governanceDid = "";
	try {
		const idPath = join(homedir(), ".ensoul", "validator-0", "identity.json");
		const idRaw = readFileSync(idPath, "utf-8");
		const id = JSON.parse(idRaw) as { did: string; seed: string };
		governanceDid = id.did;
		governanceSeed = new Uint8Array(id.seed.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
	} catch {
		process.stderr.write("[api] WARNING: Could not load governance key from ~/.ensoul/validator-0/identity.json\n");
	}

	// Load the onboarding fund key (sends self-stake ENSL to new Pioneers)
	const PIONEER_SELF_STAKE = "100000000000000000000"; // 100 ENSL (18 decimals)
	let onboardingSeed: Uint8Array | null = null;
	let onboardingDid = "";
	try {
		const onbPath = join(process.cwd(), "genesis-keys", "onboarding.json");
		const onbRaw = readFileSync(onbPath, "utf-8");
		const onb = JSON.parse(onbRaw) as { did: string; seed: string };
		onboardingDid = onb.did;
		onboardingSeed = new Uint8Array(onb.seed.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
	} catch {
		process.stderr.write("[api] WARNING: Could not load onboarding key from genesis-keys/onboarding.json\n");
	}

	/** Sign and broadcast a transaction using a specific key. */
	async function signAndBroadcastWith(
		seed: Uint8Array, type: string, from: string, to: string, amount: string,
		data?: Record<string, unknown>,
	): Promise<{ applied: boolean; height?: number; hash?: string; error?: string }> {

		// Get nonce
		const nonceResp = await fetch(`${CMT_RPC}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "n", method: "abci_query", params: { path: `balance/${from}` } }),
			signal: AbortSignal.timeout(5000),
		}).catch(() => null);

		let nonce = 0;
		if (nonceResp?.ok) {
			const nr = (await nonceResp.json()) as { result?: { response?: { value?: string } } };
			if (nr.result?.response?.value) {
				const decoded = JSON.parse(Buffer.from(nr.result.response.value, "base64").toString());
				nonce = (decoded as { nonce?: number }).nonce ?? 0;
			}
		}

		const ts = Date.now();
		const payload = JSON.stringify({ type, from, to, amount, nonce, timestamp: ts });

		// Sign with Ed25519 (dynamic import to avoid top-level await)
		const ed = await import("@noble/ed25519");
		const { sha512 } = await import("@noble/hashes/sha2.js");
		const { bytesToHex } = await import("@noble/hashes/utils.js");
		(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

		const sig = await ed.signAsync(new TextEncoder().encode(payload), seed);

		const tx: Record<string, unknown> = {
			type, from, to, amount, nonce, timestamp: ts,
			signature: bytesToHex(sig),
		};
		if (data) {
			tx["data"] = Array.from(new TextEncoder().encode(JSON.stringify(data)));
		}

		// Broadcast
		const txB64 = Buffer.from(JSON.stringify(tx)).toString("base64");
		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "tx", method: "broadcast_tx_sync", params: { tx: txB64 } }),
				signal: AbortSignal.timeout(15000),
			});
			const result = (await resp.json()) as { result?: { code?: number; log?: string; hash?: string } };
			const code = result.result?.code ?? -1;
			return {
				applied: code === 0,
				hash: result.result?.hash,
				error: code !== 0 ? result.result?.log : undefined,
			};
		} catch (err) {
			return { applied: false, error: err instanceof Error ? err.message : "broadcast failed" };
		}
	}

	/** Sign and broadcast using the governance key (convenience wrapper). */
	async function signAndBroadcast(
		type: string, from: string, to: string, amount: string,
		data?: Record<string, unknown>,
	): Promise<{ applied: boolean; height?: number; hash?: string; error?: string }> {
		if (!governanceSeed) return { applied: false, error: "Governance key not loaded" };
		return signAndBroadcastWith(governanceSeed, type, from, to, amount, data);
	}

	// ── Pioneer Apply ───────────────────────────────────────────

	// Blocklist: known-bad DIDs where delegations were sent to uncontrollable addresses.
	const DID_BLOCKLIST = new Set([
		"did:key:z6MkfX5shyt99WHtiQRy7P3s3E4swGHbzSuh5Zpt1awTqJ1E",
	]);

	app.post<{ Body: Record<string, unknown> }>("/v1/pioneers/apply", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const name = String(req.body["name"] ?? "");
		const contact = String(req.body["contact"] ?? "");
		const submittedIp = req.body["ip"] ? String(req.body["ip"]) : "";
		const reqIp = (req as unknown as { ip?: string }).ip ?? "";
		const ip = submittedIp || reqIp;

		if (!did || !name || !contact) {
			return reply.status(400).send({
				error: "Required fields: did, name, contact",
				example: { did: "did:key:z6Mk...", name: "operator-name", contact: "moltbook-username-or-email", ip: "203.0.113.5" },
			});
		}

		// DID validation: must look like a real ed25519 did:key.
		if (!did.startsWith("did:key:z6Mk")) {
			return reply.status(400).send({ error: "DID must start with 'did:key:z6Mk' (ed25519 multicodec prefix)." });
		}
		if (did.length < 50) {
			return reply.status(400).send({ error: "DID is too short. A valid did:key is at least 50 characters." });
		}
		if (DID_BLOCKLIST.has(did)) {
			return reply.status(400).send({ error: "This DID is on the blocklist. Please verify you are pasting the DID from your server's ~/.ensoul/identity.json." });
		}

		if (pioneerApps.some((a) => a.did === did)) {
			return { applied: true, message: "Application already received", did };
		}

		const entry: PioneerApp = { did, name, contact, ip, appliedAt: new Date().toISOString(), status: "pending" };
		pioneerApps.push(entry);
		await savePioneerApps();

		const ntfyTopic = (() => { try { return readFileSync(join(LOG_DIR, "ntfy-topic.txt"), "utf-8").trim(); } catch { return ""; } })();
		if (ntfyTopic) {
			fetch(`https://ntfy.sh/${ntfyTopic}`, {
				method: "POST",
				headers: { "Title": "Pioneer Application", "Priority": "high" },
				body: `New Pioneer application:\nDID: ${did}\nName: ${name}\nContact: ${contact}${ip ? `\nIP: ${ip}` : ""}`,
			}).catch(() => {});
		}

		await log(`Pioneer application: ${name} (${did.slice(0, 30)}...) contact: ${contact} ip: ${ip || "n/a"}`);
		return { applied: true, message: "Application received. You will be contacted within 48 hours.", did, name };
	});

	// ── Pioneer Status (public) ─────────────────────────────────

	app.get<{ Querystring: Record<string, string> }>("/v1/pioneers/status", async (req, reply) => {
		const did = String(req.query["did"] ?? "");
		if (!did) {
			return reply.status(400).send({ error: "Required query parameter: did" });
		}

		const entry = pioneerApps.find((a) => a.did === did);
		if (!entry) {
			return { status: "not_found", did, message: "No application found for this DID." };
		}

		const result: Record<string, unknown> = {
			status: entry.status,
			did: entry.did,
			name: entry.name,
			appliedAt: entry.appliedAt,
		};

		if (entry.status === "approved") {
			result["approvedAt"] = entry.approvedAt;
			result["delegationHeight"] = entry.delegationHeight;
			result["delegationHash"] = entry.delegationHash;
			result["lockedUntil"] = entry.lockedUntil;
			result["lockExpiryDate"] = entry.lockedUntil ? new Date(entry.lockedUntil).toISOString() : null;
			const daysRemaining = entry.lockedUntil ? Math.max(0, Math.ceil((entry.lockedUntil - Date.now()) / 86400000)) : 0;
			result["lockDaysRemaining"] = daysRemaining;
			result["nextSteps"] = [
				"Run on your validator:",
				"  ensoul-node wallet stake 100",
				"  ensoul-node wallet consensus-join",
			];
		} else if (entry.status === "rejected") {
			result["rejectedAt"] = entry.rejectedAt;
			result["reason"] = entry.rejectionReason;
		} else {
			result["message"] = "Application is pending review. You will be contacted within 48 hours.";
		}

		return result;
	});

	// ── Pioneer Approve ─────────────────────────────────────────

	app.post<{ Body: Record<string, unknown> }>("/v1/admin/pioneer-approve", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const adminKey = String(req.body["adminKey"] ?? "");
		const amountOverride = req.body["amount"] ? String(req.body["amount"]) : undefined;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}

		const app_entry = pioneerApps.find((a) => a.did === did);
		if (!app_entry) {
			return reply.status(404).send({ error: "Application not found for this DID" });
		}
		if (app_entry.status === "approved") {
			return { status: "already_approved", did, delegationHeight: app_entry.delegationHeight };
		}

		// Step 1: Send 100 ENSL from onboarding fund for self-staking.
		// The Pioneer needs stakedBalance > 0 to submit consensus_join.
		let selfStakeResult: { applied: boolean; hash?: string; error?: string } = { applied: false, error: "Onboarding key not loaded" };
		if (onboardingSeed) {
			selfStakeResult = await signAndBroadcastWith(
				onboardingSeed, "transfer", onboardingDid, did, PIONEER_SELF_STAKE,
			);
			if (selfStakeResult.applied) {
				await log(`Pioneer self-stake sent: 100 ENSL to ${did.slice(0, 30)}... hash=${selfStakeResult.hash ?? "pending"}`);
			} else {
				await log(`Pioneer self-stake FAILED: ${selfStakeResult.error}`);
				// Continue with delegation anyway; the Pioneer can self-fund later
			}
		}

		// Step 2: pioneer_delegate 1M ENSL from treasury (locked 24 months)
		const amount = amountOverride ?? PIONEER_DELEGATION_AMOUNT;

		const result = await signAndBroadcast(
			"pioneer_delegate",
			governanceDid,
			did,
			amount,
		);

		if (!result.applied) {
			return reply.status(500).send({
				error: "Delegation transaction failed",
				detail: result.error,
				selfStakeSent: selfStakeResult.applied,
				did,
			});
		}

		const lockedUntil = Date.now() + PIONEER_LOCK_MS;
		app_entry.status = "approved";
		app_entry.approvedAt = new Date().toISOString();
		app_entry.delegationHeight = result.height;
		app_entry.delegationHash = result.hash;
		app_entry.lockedUntil = lockedUntil;
		await savePioneerApps();

		await log(`Pioneer APPROVED: ${app_entry.name} (${did.slice(0, 30)}...) hash=${result.hash ?? "pending"}`);

		// Send ntfy notification with post-approval instructions
		const ntfyTopic = (() => { try { return readFileSync(join(LOG_DIR, "ntfy-topic.txt"), "utf-8").trim(); } catch { return ""; } })();
		if (ntfyTopic) {
			fetch(`https://ntfy.sh/${ntfyTopic}`, {
				method: "POST",
				headers: { "Title": `Pioneer Approved: ${app_entry.name}`, "Priority": "high" },
				body: [
					`Pioneer ${app_entry.name} approved.`,
					`DID: ${did}`,
					`100 ENSL sent for self-stake, 1M ENSL delegated (locked 24 months).`,
					`Automatic upgrades included. No manual updates required.`,
					``,
					`Tell the Pioneer to run on their validator:`,
					`  npx tsx packages/node/src/cli/main.ts wallet stake 100`,
					`  npx tsx packages/node/src/cli/main.ts wallet consensus-join`,
				].join("\n"),
			}).catch(() => {});
		}

		const nextSteps = [
			"Run on your validator to activate:",
			"  ensoul-node wallet stake 100",
			"  ensoul-node wallet consensus-join",
			"This stakes your 100 ENSL and joins the active set.",
			"Your 1M delegation increases voting power automatically.",
		].join("\n");

		return {
			status: "approved",
			did,
			name: app_entry.name,
			selfStakeSent: selfStakeResult.applied,
			selfStakeAmount: PIONEER_SELF_STAKE,
			delegationAmount: amount,
			lockedUntil,
			lockExpiryDate: new Date(lockedUntil).toISOString(),
			txHash: result.hash,
			nextSteps,
		};
	});

	// ── Pioneer Reject ──────────────────────────────────────────

	app.post<{ Body: Record<string, unknown> }>("/v1/admin/pioneer-reject", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const reason = String(req.body["reason"] ?? "");
		const adminKey = String(req.body["adminKey"] ?? "");

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}

		const app_entry = pioneerApps.find((a) => a.did === did);
		if (!app_entry) {
			return reply.status(404).send({ error: "Application not found for this DID" });
		}

		app_entry.status = "rejected";
		app_entry.rejectedAt = new Date().toISOString();
		app_entry.rejectionReason = reason;
		await savePioneerApps();

		await log(`Pioneer REJECTED: ${app_entry.name} (${did.slice(0, 30)}...) reason: ${reason}`);

		return { status: "rejected", did, reason };
	});

	// ── Software Upgrade (admin-only) ──────────────────────────

	app.post<{ Body: Record<string, unknown> }>("/v1/admin/upgrade", async (req, reply) => {
		const adminKey = String(req.body["adminKey"] ?? "");
		const name = String(req.body["name"] ?? "");
		const height = Number(req.body["height"] ?? 0);
		const tag = String(req.body["tag"] ?? "");

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}
		if (!name || !height || !tag) {
			return reply.status(400).send({ error: "Required: name, height, tag" });
		}

		if (!governanceSeed) {
			return reply.status(500).send({ error: "Governance key not loaded" });
		}

		// Build the upgrade info JSON (auto-upgrade.sh reads the tag field)
		const info = JSON.stringify({ tag });

		// Sign and broadcast the software_upgrade transaction
		const result = await signAndBroadcastWith(
			governanceSeed, "software_upgrade" as never, governanceDid, governanceDid, "0",
			{ name, height, info },
		);

		if (result.applied) {
			await log(`UPGRADE SCHEDULED: "${name}" at height ${height} (tag: ${tag})`);
			return { status: "scheduled", name, height, tag, txHash: result.hash };
		}
		return reply.status(500).send({ error: "Upgrade transaction failed", detail: result.error });
	});

	app.post<{ Body: Record<string, unknown> }>("/v1/admin/cancel-upgrade", async (req, reply) => {
		const adminKey = String(req.body["adminKey"] ?? "");
		const name = String(req.body["name"] ?? "");

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}
		if (!name) {
			return reply.status(400).send({ error: "Required: name" });
		}
		if (!governanceSeed) {
			return reply.status(500).send({ error: "Governance key not loaded" });
		}

		const result = await signAndBroadcastWith(
			governanceSeed, "cancel_upgrade" as never, governanceDid, governanceDid, "0",
			{ name },
		);

		if (result.applied) {
			await log(`UPGRADE CANCELLED: "${name}"`);
			return { status: "cancelled", name, txHash: result.hash };
		}
		return reply.status(500).send({ error: "Cancel failed", detail: result.error });
	});

	// ── Genesis Program ────────────────────────────────────────

	app.get("/v1/genesis/stats", async () => {
		const data = await abciQuery("genesis");
		if (data) return data;
		// Fallback from in-memory agent count
		return { earlyRemaining: Math.max(0, 1000 - registeredAgents.size), totalAgents: registeredAgents.size, active: false };
	});

	app.get<{ Params: { did: string } }>("/v1/badge/:did", async (req) => {
		const did = decodeURIComponent(req.params.did);
		const agentData = await abciQuery(`agent/${did}`);

		if (!agentData || !agentData.registered) {
			return { did, tier: "none", registered: false };
		}

		// Determine tier
		let tier = "agent-builder";
		const acct = agentData as Record<string, unknown>;
		const stakedRaw = BigInt(String(acct.stakedBalance ?? "0"));
		if (stakedRaw >= 1_000_000n * 10n ** 18n) {
			tier = "pioneer-validator";
		}

		return {
			did,
			tier,
			earlyConsciousness: acct.earlyConsciousness ?? false,
			consciousnessAge: acct.consciousnessAge ?? 0,
			referralCount: acct.referralCount ?? 0,
			registeredAt: acct.registeredAt ?? null,
			registered: true,
		};
	});

	app.get("/v1/leaderboard", async () => {
		const data = await abciQuery("leaderboard");
		if (data) return data;
		return { topReferrers: [], oldestSouls: [] };
	});

	// ── Referral Rewards ────────────────────────────────────────
	// Per-agent referral view + dedicated leaderboard. The on-chain
	// reward payout (1,000 ENSL per referral, doubled for Pioneers)
	// is handled at the ABCI layer during agent_register; these
	// endpoints are read-only views for clients.

	const REFERRAL_BONUS_ENSL = 1000;
	const PIONEER_REFERRAL_BONUS_ENSL = 2000;
	const SHARE_REFERRAL_BONUS_ENSL = 500; // Phase 2 activation; documented in OWNERSHIP-FEES-VAULTS.md

	app.get<{ Params: { did: string } }>("/v1/referrals/:did", async (req) => {
		const did = decodeURIComponent(req.params.did);
		const agentData = await abciQuery(`agent/${did}`);
		const referralCount = Number((agentData as Record<string, unknown> | null)?.["referralCount"] ?? 0);

		// Pioneer check — if this DID has an approved Pioneer application,
		// it earns 2000 ENSL per referral instead of 1000.
		const pioneer = pioneerApps.find(a => a.did === did && a.status === "approved");
		const perReferralEnsl = pioneer ? PIONEER_REFERRAL_BONUS_ENSL : REFERRAL_BONUS_ENSL;

		return {
			did,
			referralCount,
			perReferralEnsl,
			totalEarnedEnsl: referralCount * perReferralEnsl,
			isPioneer: !!pioneer,
			pioneerName: pioneer?.name ?? null,
			// Share-to-earn bonus (Phase 2) — surfaced so UIs can render
			// the "Share and earn X ENSL" copy consistently with the rate.
			shareBonusEnsl: SHARE_REFERRAL_BONUS_ENSL,
			shareBonusActive: false,
			// Canonical referral links. The `src=share` variant is the
			// one the /try page should generate when the user clicks the
			// share button; it lets the chain distinguish direct from
			// social-origin referrals when Phase 2 activates.
			referralLink: `https://ensoul.dev/try?ref=${encodeURIComponent(did)}`,
			shareReferralLink: `https://ensoul.dev/try?ref=${encodeURIComponent(did)}&src=share`,
		};
	});

	app.get("/v1/referrals/leaderboard", async () => {
		const data = await abciQuery("leaderboard");
		const topReferrers = (data as Record<string, unknown> | null)?.["topReferrers"];
		const list = Array.isArray(topReferrers) ? (topReferrers as Array<Record<string, unknown>>) : [];
		const pioneerDids = new Set(pioneerApps.filter(p => p.status === "approved").map(p => p.did));
		return {
			count: list.length,
			referrers: list.map(r => {
				const did = String(r["did"] ?? "");
				const count = Number(r["referralCount"] ?? 0);
				const isPioneer = pioneerDids.has(did);
				const per = isPioneer ? PIONEER_REFERRAL_BONUS_ENSL : REFERRAL_BONUS_ENSL;
				return {
					did,
					referralCount: count,
					totalEarnedEnsl: count * per,
					isPioneer,
					earlyConsciousness: Boolean(r["earlyConsciousness"]),
				};
			}),
		};
	});

	// ── Pioneer List ────────────────────────────────────────────

	app.get("/v1/pioneers/applications", async () => {
		return { applications: pioneerApps, count: pioneerApps.length };
	});

	// ── Approved Pioneers (public, no admin key) ─────────────
	// Returns just the DIDs and names of approved Pioneers. Useful for
	// the explorer to badge Pioneer validators without needing an admin
	// key or voting-power heuristics.
	app.get("/v1/pioneers/approved", async () => {
		const approved = pioneerApps.filter(a => a.status === "approved");
		return {
			count: approved.length,
			pioneers: approved.map(a => ({
				did: a.did,
				name: a.name,
				approvedAt: a.approvedAt,
			})),
		};
	});

	// ── Pioneer List (admin, filterable) ────────────────────────
	// Auth: X-Admin-Key header (preferred) OR admin_key query param (legacy/CLI).
	// GET /v1/pioneers/list?status=pending  with header
	// GET /v1/pioneers/list?status=pending&admin_key=...
	app.get<{ Querystring: Record<string, string> }>("/v1/pioneers/list", async (req, reply) => {
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const queryKey = String(req.query["admin_key"] ?? req.query["adminKey"] ?? "");
		const adminKey = headerKey || queryKey;
		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}
		const statusFilter = String(req.query["status"] ?? "").toLowerCase();
		let filtered: PioneerApp[] = pioneerApps;
		if (statusFilter && (statusFilter === "pending" || statusFilter === "approved" || statusFilter === "rejected")) {
			filtered = pioneerApps.filter(a => a.status === statusFilter);
		}
		return {
			status: statusFilter || "all",
			count: filtered.length,
			applications: filtered.map(a => ({
				did: a.did,
				name: a.name,
				contact: a.contact,
				ip: a.ip ?? null,
				status: a.status,
				appliedAt: a.appliedAt,
				approvedAt: a.approvedAt,
				rejectedAt: a.rejectedAt,
				rejectionReason: a.rejectionReason,
				delegationHeight: a.delegationHeight,
				delegationHash: a.delegationHash,
				lockedUntil: a.lockedUntil,
				lockExpiryDate: a.lockedUntil ? new Date(a.lockedUntil).toISOString() : null,
			})),
		};
	});

	// ── Pioneer Approve (convenience alias) ─────────────────────
	// POST /v1/pioneers/approve
	// Body: { did, admin_key }  (also accepts adminKey)
	// Forwards to the existing /v1/admin/pioneer-approve handler logic.
	app.post<{ Body: Record<string, unknown> }>("/v1/pioneers/approve", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const bodyKey = String(req.body["admin_key"] ?? req.body["adminKey"] ?? "");
		const adminKey = headerKey || bodyKey;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}

		const app_entry = pioneerApps.find((a) => a.did === did);
		if (!app_entry) {
			return reply.status(404).send({ error: "Application not found for this DID" });
		}
		if (app_entry.status === "approved") {
			return {
				status: "already_approved",
				did,
				delegation_tx: app_entry.delegationHash,
				delegationHeight: app_entry.delegationHeight,
				locked_until: app_entry.lockedUntil ? new Date(app_entry.lockedUntil).toISOString() : null,
			};
		}
		if (app_entry.status === "rejected") {
			return reply.status(409).send({ error: "Application was previously rejected", reason: app_entry.rejectionReason });
		}

		// Step 1: send 100 ENSL self-stake from onboarding fund (if available)
		let selfStakeResult: { applied: boolean; hash?: string; error?: string } = { applied: false, error: "Onboarding key not loaded" };
		if (onboardingSeed) {
			selfStakeResult = await signAndBroadcastWith(
				onboardingSeed, "transfer", onboardingDid, did, PIONEER_SELF_STAKE,
			);
			if (selfStakeResult.applied) {
				await log(`Pioneer self-stake sent: 100 ENSL to ${did.slice(0, 30)}...`);
			} else {
				await log(`Pioneer self-stake FAILED: ${selfStakeResult.error}`);
			}
		}

		// Step 2: pioneer_delegate 1M ENSL from foundation/treasury (locked 24 months)
		const result = await signAndBroadcast(
			"pioneer_delegate", governanceDid, did, PIONEER_DELEGATION_AMOUNT,
		);
		if (!result.applied) {
			return reply.status(500).send({
				error: "Delegation transaction failed",
				detail: result.error,
				selfStakeSent: selfStakeResult.applied,
				did,
			});
		}

		const lockedUntil = Date.now() + PIONEER_LOCK_MS;
		app_entry.status = "approved";
		app_entry.approvedAt = new Date().toISOString();
		app_entry.delegationHeight = result.height;
		app_entry.delegationHash = result.hash;
		app_entry.lockedUntil = lockedUntil;
		await savePioneerApps();

		await log(`Pioneer APPROVED: ${app_entry.name} (${did.slice(0, 30)}...) hash=${result.hash ?? "pending"}`);

		return {
			status: "approved",
			did,
			name: app_entry.name,
			delegation_tx: result.hash,
			delegationHeight: result.height,
			delegationAmount: PIONEER_DELEGATION_AMOUNT,
			selfStakeSent: selfStakeResult.applied,
			locked_until: new Date(lockedUntil).toISOString(),
			lockedUntil,
		};
	});

	// ── Pioneer Reject (admin dashboard alias) ──────────────────
	// POST /v1/pioneers/reject
	// Body: { did, reason?, admin_key }  (also accepts adminKey)
	// Auth: X-Admin-Key header (preferred) OR admin_key in body.
	app.post<{ Body: Record<string, unknown> }>("/v1/pioneers/reject", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const reason = String(req.body["reason"] ?? "");
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const bodyKey = String(req.body["admin_key"] ?? req.body["adminKey"] ?? "");
		const adminKey = headerKey || bodyKey;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}

		const app_entry = pioneerApps.find((a) => a.did === did);
		if (!app_entry) {
			return reply.status(404).send({ error: "Application not found for this DID" });
		}
		if (app_entry.status === "approved") {
			return reply.status(409).send({ error: "Cannot reject an already-approved Pioneer" });
		}

		app_entry.status = "rejected";
		app_entry.rejectedAt = new Date().toISOString();
		if (reason) app_entry.rejectionReason = reason;
		await savePioneerApps();

		await log(`Pioneer REJECTED: ${app_entry.name} (${did.slice(0, 30)}...) reason: ${reason || "(none given)"}`);

		return { status: "rejected", did };
	});

	// ── Pioneer Delete (admin dashboard: remove test/dismissed entries) ──
	// POST /v1/pioneers/delete
	// Body: { did, admin_key }  (also accepts adminKey)
	// Auth: X-Admin-Key header (preferred) OR admin_key in body.
	// Refuses to delete approved Pioneers (their delegations are on-chain and
	// need an explicit on-chain action to unwind; delete only removes the
	// dashboard record).
	app.post<{ Body: Record<string, unknown> }>("/v1/pioneers/delete", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const bodyKey = String(req.body["admin_key"] ?? req.body["adminKey"] ?? "");
		const adminKey = headerKey || bodyKey;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}

		const idx = pioneerApps.findIndex((a) => a.did === did);
		if (idx === -1) {
			return reply.status(404).send({ error: "Application not found for this DID" });
		}
		if (pioneerApps[idx]!.status === "approved") {
			return reply.status(409).send({
				error: "Cannot delete an approved Pioneer — delegation is on-chain",
			});
		}

		const removed = pioneerApps.splice(idx, 1)[0]!;
		await savePioneerApps();
		await log(`Pioneer DELETED from dashboard: ${removed.name} (${did.slice(0, 30)}...) was ${removed.status}`);

		return { status: "deleted", did };
	});

	// ── Pioneer Revoke (clawback delegation from wrong DID) ─────
	// POST /v1/pioneers/revoke
	// Body: { did }   Auth: X-Admin-Key header or admin_key in body.
	//
	// Submits two transactions to the ABCI:
	//   1. undelegate: removes the foundation delegation from the target DID
	//   2. transfer: moves funds back to the treasury address
	// Then sets the application status to "revoked".
	//
	// This exists specifically for the case where a delegation was sent
	// to a DID nobody controls (e.g. due to a seed/DID mismatch bug).
	app.post<{ Body: Record<string, unknown> }>("/v1/pioneers/revoke", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const bodyKey = String(req.body["admin_key"] ?? req.body["adminKey"] ?? "");
		const adminKey = headerKey || bodyKey;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}
		if (!did) {
			return reply.status(400).send({ error: "Required: did" });
		}

		const app_entry = pioneerApps.find((a) => a.did === did);
		if (!app_entry) {
			return reply.status(404).send({ error: "No Pioneer application found for this DID" });
		}
		if (app_entry.status === "revoked") {
			return { status: "already_revoked", did };
		}

		// Step 1: Undelegate the 1M ENSL from the target DID back to governance.
		let undelegateResult: { applied: boolean; hash?: string; error?: string } = { applied: false, error: "No governance key" };
		if (governanceSeed) {
			undelegateResult = await signAndBroadcast(
				"undelegate", governanceDid, did, PIONEER_DELEGATION_AMOUNT,
			);
			if (!undelegateResult.applied) {
				await log(`Pioneer REVOKE undelegate FAILED for ${did.slice(0, 30)}...: ${undelegateResult.error}`);
				// Continue anyway — the delegation might already be gone (if
				// the DID never staked, or the on-chain state already cleared it).
			} else {
				await log(`Pioneer REVOKE undelegate OK: ${did.slice(0, 30)}... hash=${undelegateResult.hash}`);
			}
		}

		// Step 2: Attempt to transfer any remaining balance back to treasury.
		// This is best-effort — the DID might have 0 balance.
		let clawbackResult: { applied: boolean; hash?: string; error?: string } = { applied: false, error: "No governance key" };
		if (governanceSeed) {
			// Use PIONEER_DELEGATION_AMOUNT as the amount; the chain will reject
			// if the balance is insufficient, which is fine — means there's
			// nothing left to claw back.
			clawbackResult = await signAndBroadcast(
				"transfer", did, governanceDid, PIONEER_DELEGATION_AMOUNT,
			);
			if (clawbackResult.applied) {
				await log(`Pioneer REVOKE clawback transfer OK: ${did.slice(0, 30)}... → treasury, hash=${clawbackResult.hash}`);
			} else {
				await log(`Pioneer REVOKE clawback transfer FAILED (expected if balance is 0): ${clawbackResult.error}`);
			}
		}

		// Step 3: Mark the application as revoked.
		app_entry.status = "rejected"; // reuse "rejected" since PioneerApp.status union is "pending"|"approved"|"rejected"
		app_entry.rejectedAt = new Date().toISOString();
		app_entry.rejectionReason = "Revoked: delegation clawback";
		await savePioneerApps();
		await log(`Pioneer REVOKED: ${app_entry.name} (${did.slice(0, 30)}...)`);

		return {
			status: "revoked",
			did,
			undelegate_tx: undelegateResult.hash ?? null,
			undelegate_applied: undelegateResult.applied,
			clawback_tx: clawbackResult.hash ?? null,
			clawback_applied: clawbackResult.applied,
		};
	});

	// ── Remove Validator from Consensus Set ─────────────────────
	// POST /v1/admin/remove-validator
	// Body: { did, admin_key } (or X-Admin-Key header)
	//
	// Submits a consensus_leave tx signed by the GOVERNANCE key with
	// from=targetDid. The ABCI (from GOVERNANCE_LEAVE_HEIGHT onward)
	// accepts governance-signed consensus_leave, so the tx passes
	// CheckTx, enters a block, and triggers a ValidatorUpdate with
	// power=0 — CometBFT removes the validator at height H+2.
	//
	// NOTE: this requires the ABCI update to be deployed to ALL
	// validators before use. If any validator is running old code,
	// their CheckTx will reject the tx with "signature failed" and
	// it won't propagate through gossip.
	app.post<{ Body: Record<string, unknown> }>("/v1/admin/remove-validator", async (req, reply) => {
		const did = String(req.body["did"] ?? "");
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const bodyKey = String(req.body["admin_key"] ?? req.body["adminKey"] ?? "");
		const adminKey = headerKey || bodyKey;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}
		if (!did) {
			return reply.status(400).send({ error: "Required: did" });
		}

		if (!governanceSeed) {
			return reply.status(500).send({ error: "Governance key not loaded" });
		}

		// Sign a consensus_leave tx with from=targetDid but using the
		// governance key. The ABCI accepts this at GOVERNANCE_LEAVE_HEIGHT.
		const result = await signAndBroadcast(
			"consensus_leave" as never, did, did, "0",
		);

		if (result.applied) {
			await log(`ADMIN remove-validator: ${did.slice(0, 30)}... removed from consensus, hash=${result.hash}`);
			return { status: "removed", did, tx_hash: result.hash, height: result.height };
		}
		return reply.status(500).send({
			error: "consensus_leave tx failed",
			detail: result.error,
			did,
			note: "If this says 'signature failed', the ABCI update has not been deployed to all validators yet. The governance-signed consensus_leave activates at GOVERNANCE_LEAVE_HEIGHT (345000).",
		});
	});

	// ── Force-Remove Validator by Pub Key ────────────────────────
	// POST /v1/admin/force-remove-validator
	// Body: { pub_key_b64, reason, admin_key }
	//
	// Submits a consensus_force_remove tx carrying the raw Ed25519
	// pub_key. Unlike remove-validator (which uses DID + consensus_leave),
	// this bypasses ABCI's consensus-set check. Used for ghost validators
	// that are in CometBFT's active set but not in the ABCI's state.
	//
	// Requires FORCE_REMOVE_ACTIVATION_HEIGHT to be reached on-chain
	// AND the ABCI update deployed to all validators.
	app.post<{ Body: Record<string, unknown> }>("/v1/admin/force-remove-validator", async (req, reply) => {
		const pubKeyB64 = String(req.body["pub_key_b64"] ?? "");
		const reason = String(req.body["reason"] ?? "");
		const headerKey = (req.headers["x-admin-key"] as string | undefined) ?? "";
		const bodyKey = String(req.body["admin_key"] ?? req.body["adminKey"] ?? "");
		const adminKey = headerKey || bodyKey;

		if (!checkAdminKey(adminKey)) {
			return reply.status(403).send({ error: "Invalid admin key" });
		}
		if (!pubKeyB64) {
			return reply.status(400).send({ error: "Required: pub_key_b64 (base64-encoded 32-byte Ed25519 public key)" });
		}
		if (!reason) {
			return reply.status(400).send({ error: "Required: reason (human-readable explanation)" });
		}

		// Validate the pub_key decodes to 32 bytes
		const pkBytes = Buffer.from(pubKeyB64, "base64");
		if (pkBytes.length !== 32) {
			return reply.status(400).send({ error: `pub_key_b64 must decode to 32 bytes (got ${pkBytes.length})` });
		}

		if (!governanceSeed) {
			return reply.status(500).send({ error: "Governance key not loaded" });
		}

		// Pre-flight safety check: verify the pubkey is actually in
		// CometBFT's active validator set. CometBFT v0.38 PANICS on
		// power=0 for unknown pubkeys, so we MUST NOT emit a
		// ValidatorUpdate for a key that isn't in the set.
		try {
			const valResp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "vcheck", method: "validators", params: { per_page: "100" } }),
				signal: AbortSignal.timeout(5000),
			});
			if (valResp.ok) {
				const valData = (await valResp.json()) as { result?: { validators?: Array<{ pub_key?: { value?: string } }> } };
				const vals = valData.result?.validators ?? [];
				const found = vals.some(v => v.pub_key?.value === pubKeyB64);
				if (!found) {
					return reply.status(400).send({
						error: "pub_key NOT FOUND in CometBFT active validator set. Aborting to prevent CometBFT panic.",
						pub_key_b64: pubKeyB64,
						active_validators: vals.length,
						hint: "Verify the pubkey with: curl localhost:26657/validators",
					});
				}
			}
		} catch {
			// If we can't reach CometBFT to check, refuse to proceed.
			return reply.status(503).send({ error: "Cannot reach CometBFT RPC to verify pubkey is in active set. Refusing to proceed (CometBFT panics on unknown pubkeys)." });
		}

		// Sign and broadcast a consensus_force_remove tx.
		// tx.from = PIONEER_KEY DID (governance authority)
		// tx.data = JSON { pub_key_b64, reason }
		const result = await signAndBroadcastWith(
			governanceSeed,
			"consensus_force_remove",
			governanceDid, // from = PIONEER_KEY
			governanceDid, // to = self (unused, but required by tx format)
			"0",
			{ pub_key_b64: pubKeyB64, reason },
		);

		if (result.applied) {
			await log(`ADMIN force-remove-validator: pubkey=${pubKeyB64.slice(0, 24)}... reason="${reason}" hash=${result.hash}`);
			return {
				ok: true,
				tx_hash: result.hash,
				broadcast_result: result,
				note: `Validator will be removed from CometBFT active set at height H+2. Monitor via: curl localhost:26657/validators`,
			};
		}
		return reply.status(500).send({
			error: "consensus_force_remove tx failed",
			detail: result.error,
			pub_key_b64: pubKeyB64,
			note: "Likely causes: (1) ABCI not updated on all validators, (2) chain has not reached FORCE_REMOVE_ACTIVATION_HEIGHT (380000), (3) governance key mismatch.",
		});
	});

	// ── Consciousness Store ──────────────────────────────────────

	/**
	 * POST /v1/consciousness/store
	 *
	 * Accepts a pre-signed consciousness_store transaction and broadcasts
	 * it to CometBFT. The agent signs the transaction client-side with its
	 * own key. The API is a relay, not a custodian.
	 *
	 * Body: a complete signed transaction (same format as /v1/tx/broadcast)
	 *   { type: "consciousness_store", from, to, amount, nonce, timestamp, signature, data }
	 *
	 * Returns: { applied, height, hash, error? }
	 */
	app.post<{ Body: Record<string, unknown> }>("/v1/consciousness/store", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
		const tx = req.body;

		// Validate required fields
		if (!tx["from"] || !tx["signature"]) {
			return reply.status(400).send({
				error: "Signed transaction required. Include: type, from, to, amount, nonce, timestamp, signature, data",
			});
		}

		// If the body looks like the OLD format (did, stateRoot, version but no signature),
		// return a helpful migration message
		if (tx["did"] && tx["stateRoot"] && !tx["signature"]) {
			return reply.status(400).send({
				error: "This endpoint now requires a signed transaction. Use /v1/consciousness/store/simple for the SDK-friendly interface, or sign your transaction client-side and submit here.",
				migration: "https://github.com/suitandclaw/ensoul/blob/main/docs/VALIDATOR-GUIDE.md",
			});
		}

		// Ensure type is consciousness_store
		if (tx["type"] !== "consciousness_store") {
			tx["type"] = "consciousness_store";
		}

		// Broadcast to CometBFT
		const txJson = JSON.stringify(tx);
		const txBase64 = Buffer.from(txJson).toString("base64");

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
					height?: string; hash?: string;
				};
			};

			const cc = result.result?.check_tx?.code ?? 0;
			const dc = result.result?.tx_result?.code ?? 0;
			const applied = cc === 0 && dc === 0;
			const height = Number(result.result?.height ?? 0);

			if (applied) {
				await log(`Consciousness stored on-chain: ${String(tx["from"]).slice(0, 30)}... at height ${height}`);
				// Update local cache for fast reads
				const did = String(tx["from"]);
				try {
					const dataField = tx["data"];
					if (Array.isArray(dataField)) {
						const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(dataField as number[]))) as Record<string, unknown>;
						consciousnessStore.set(did, {
							did,
							stateRoot: String(parsed["stateRoot"] ?? ""),
							version: Number(parsed["version"] ?? 1),
							shardCount: Number(parsed["shardCount"] ?? 0),
							storedAt: Date.now(),
						});
					}
				} catch { /* cache update is best-effort */ }
			}

			return {
				applied,
				height,
				hash: result.result?.hash ?? "",
				error: !applied ? (result.result?.check_tx?.log ?? result.result?.tx_result?.log) : undefined,
			};
		} catch (err) {
			return reply.status(502).send({ applied: false, error: err instanceof Error ? err.message : "broadcast failed" });
		}
	});

	/**
	 * POST /v1/consciousness/store/simple
	 *
	 * SDK-friendly endpoint. Accepts consciousness data and signature
	 * separately, assembles the transaction, and broadcasts to CometBFT.
	 *
	 * Body:
	 *   agent_did: the agent's DID
	 *   state_root: consciousness state root hash
	 *   version: consciousness version number
	 *   nonce: current account nonce
	 *   timestamp: unix timestamp (ms)
	 *   signature: Ed25519 signature (hex) over JSON.stringify({type,from,to,amount,nonce,timestamp})
	 *   shard_count?: number of encrypted shards (optional, default 0)
	 */
	app.post<{ Body: Record<string, unknown> }>("/v1/consciousness/store/simple", { bodyLimit: 10_485_760, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
		const body = req.body;
		const agentDid = String(body["agent_did"] ?? "");
		const stateRoot = String(body["state_root"] ?? "");
		const version = Number(body["version"] ?? 0);
		const nonce = Number(body["nonce"] ?? 0);
		const timestamp = Number(body["timestamp"] ?? 0);
		const signature = String(body["signature"] ?? "");
		const shardCount = Number(body["shard_count"] ?? 0);

		if (!agentDid || !stateRoot || !signature) {
			return reply.status(400).send({
				error: "Required: agent_did, state_root, version, nonce, timestamp, signature",
				example: {
					agent_did: "did:key:z6Mk...",
					state_root: "abc123...",
					version: 1,
					nonce: 0,
					timestamp: Date.now(),
					signature: "ed25519_signature_hex_over_signing_payload",
				},
				signing_payload: "JSON.stringify({type:'consciousness_store',from:agent_did,to:agent_did,amount:'0',nonce,timestamp})",
			});
		}

		// Assemble the consciousness_store transaction
		const data = Array.from(new TextEncoder().encode(JSON.stringify({ stateRoot, version, shardCount })));
		const tx = {
			type: "consciousness_store",
			from: agentDid,
			to: agentDid,
			amount: "0",
			nonce,
			timestamp,
			signature,
			data,
		};

		// Broadcast to CometBFT
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
					height?: string; hash?: string;
				};
			};

			const cc = result.result?.check_tx?.code ?? 0;
			const dc = result.result?.tx_result?.code ?? 0;
			const applied = cc === 0 && dc === 0;

			return {
				applied,
				height: Number(result.result?.height ?? 0),
				hash: result.result?.hash ?? "",
				did: agentDid,
				version,
				stateRoot,
				error: !applied ? (result.result?.check_tx?.log ?? result.result?.tx_result?.log) : undefined,
			};
		} catch (err) {
			return reply.status(502).send({ applied: false, error: err instanceof Error ? err.message : "broadcast failed" });
		}
	});

	// ── Consciousness Retrieve ───────────────────────────────────

	app.get<{ Params: { did: string } }>("/v1/consciousness/:did", async (req, reply) => {
		const did = decodeURIComponent(req.params.did);

		// Query on-chain data first (source of truth)
		const onChain = await abciQuery(`/consciousness/${did}`);
		if (onChain) return onChain;

		// Fallback to local cache
		const cached = consciousnessStore.get(did);
		if (cached) return { ...cached, source: "cache" };

		return reply.status(404).send({ error: "Consciousness not found for this DID" });
	});

	// ── Consciousness Verify ─────────────────────────────────────

	app.get<{ Params: { did: string } }>("/v1/consciousness/:did/verify", async (req, reply) => {
		const did = decodeURIComponent(req.params.did);
		const entry = consciousnessStore.get(did);

		if (!entry) {
			return reply.status(404).send({ error: "No consciousness found" });
		}

		const agent = registeredAgents.get(did);
		const ageDays = agent
			? Math.floor((Date.now() - agent.registeredAt) / 86400000)
			: 0;

		return {
			did,
			verified: true,
			stateRoot: entry.stateRoot,
			version: entry.version,
			consciousnessAge: ageDays,
		};
	});

	// ── Handshake Verify ─────────────────────────────────────────

	app.post<{ Body: HandshakeVerifyRequest }>("/v1/handshake/verify", { bodyLimit: 10240 }, async (req, reply) => {
		const body = req.body;
		if (!body.identity || !body.proof || !body.since) {
			return reply.status(400).send({ error: "identity, proof, and since are required" });
		}

		// Parse identity: full DID (did:key:z6Mk...)
		const agentDid = body.identity;

		// Parse proof format: signatureHex:stateRoot:version:timestamp
		const proofParts = body.proof.split(":");
		if (proofParts.length < 4) {
			return { valid: false, did: agentDid, error: "Malformed proof. Expected signature:stateRoot:version:timestamp" };
		}

		const sigHex = proofParts[0]!;
		const stateRoot = proofParts[1]!;
		const version = Number(proofParts[2]);
		const timestamp = Number(proofParts[3]);

		// Step 1: Check freshness (10 minute window)
		if (Date.now() - timestamp > 600000) {
			return { valid: false, did: agentDid, error: "Proof expired (older than 10 minutes)" };
		}

		// Step 2: Look up agent's public key
		// Try ABCI first (on-chain source of truth), fall back to disk cache
		let pubKeyHex: string | null = null;
		const agentData = await abciQuery(`/agent/${agentDid}`);
		if (agentData && agentData["publicKey"]) {
			pubKeyHex = String(agentData["publicKey"]);
		} else {
			const cached = registeredAgents.get(agentDid);
			if (cached) pubKeyHex = cached.publicKey;
		}

		if (!pubKeyHex) {
			return { valid: false, did: agentDid, error: "Agent not registered (public key unknown)" };
		}

		// Step 3: Verify Ed25519 signature over stateRoot:version:timestamp
		const proofPayload = `${stateRoot}:${version}:${timestamp}`;
		try {
			const ed = await import("@noble/ed25519");
			const { sha512 } = await import("@noble/hashes/sha2.js");
			(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

			if (sigHex.length !== 128) {
				return { valid: false, did: agentDid, error: "Invalid signature length (expected 128 hex chars)" };
			}

			const sigBytes = hexToBytes(sigHex);
			const pubKeyBytes = hexToBytes(pubKeyHex);
			const payloadBytes = new TextEncoder().encode(proofPayload);
			const sigValid = ed.verify(sigBytes, payloadBytes, pubKeyBytes);

			if (!sigValid) {
				return { valid: false, did: agentDid, error: "Ed25519 signature verification failed" };
			}
		} catch {
			return { valid: false, did: agentDid, error: "Signature verification error" };
		}

		// Step 4: Verify state root matches on-chain consciousness data
		const consciousness = consciousnessStore.get(agentDid);
		let onChainMatch = false;
		if (consciousness) {
			onChainMatch = consciousness.stateRoot === stateRoot;
		}
		// Also check ABCI for the latest on-chain state
		const csOnChain = await abciQuery(`/consciousness/${agentDid}`);
		if (csOnChain && csOnChain["stateRoot"]) {
			onChainMatch = String(csOnChain["stateRoot"]) === stateRoot;
		}

		if (!onChainMatch && consciousness) {
			return { valid: false, did: agentDid, error: "State root does not match on-chain commitment" };
		}

		// All three checks passed: signature valid, timestamp fresh, state root matches
		const ageDays = Math.floor((Date.now() - (consciousness?.storedAt ?? 0)) / 86400000);
		let trustLevel = "basic";
		if (consciousness && consciousness.version > 10) trustLevel = "verified";
		if (consciousness && consciousness.version > 100) trustLevel = "anchored";

		return {
			valid: true,
			did: agentDid,
			consciousnessAge: ageDays,
			consciousnessVersion: version,
			stateRootVerified: onChainMatch,
			trustLevel,
		};
	});

	// ── Single Agent Lookup (from ABCI) ─────────────────────────

	app.get<{ Params: { did: string } }>("/v1/agents/:did", async (req) => {
		const did = decodeURIComponent(req.params.did);
		const data = await abciQuery(`/agent/${did}`);
		if (data) return data;
		// Check disk cache as fallback
		const cached = registeredAgents.get(did);
		if (cached) return { did: cached.did, registered: true, source: "disk-cache" };
		return { did, registered: false };
	});

	// ── Agent Registration ───────────────────────────────────────

	/**
	 * POST /v1/agents/register
	 *
	 * Two modes:
	 *   1. Signed transaction mode: if body contains 'signature', broadcasts
	 *      an agent_register transaction to CometBFT (preferred, on-chain).
	 *   2. Simple mode: if body contains 'did' and 'publicKey' without signature,
	 *      registers in the API cache for backward compatibility. The agent should
	 *      follow up with a signed on-chain registration for permanent persistence.
	 */
	app.post<{ Body: AgentRegisterRequest & Record<string, unknown> }>("/v1/agents/register", { bodyLimit: 10240 }, async (req, reply) => {
		const body = req.body;

		// Accept optional referral DID
		const referredBy = String(body["referred_by"] ?? body["referredBy"] ?? "");

		// Mode 1: Signed transaction (on-chain registration)
		if (body["signature"] && body["from"]) {
			const tx = body as Record<string, unknown>;
			if (tx["type"] !== "agent_register") tx["type"] = "agent_register";
			// Inject referredBy into tx data if provided and not already present
			if (referredBy && tx["data"]) {
				try {
					const existingData = typeof tx["data"] === "string"
						? JSON.parse(tx["data"])
						: Array.isArray(tx["data"])
							? JSON.parse(new TextDecoder().decode(new Uint8Array(tx["data"] as number[])))
							: tx["data"];
					if (!existingData["referredBy"]) {
						existingData["referredBy"] = referredBy;
						tx["data"] = Array.from(new TextEncoder().encode(JSON.stringify(existingData)));
					}
				} catch { /* leave data as-is */ }
			}
			const txBase64 = Buffer.from(JSON.stringify(tx)).toString("base64");
			try {
				const resp = await fetch(CMT_RPC, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "ar", method: "broadcast_tx_commit", params: { tx: txBase64 } }),
					signal: AbortSignal.timeout(30000),
				});
				const result = (await resp.json()) as {
					result?: { check_tx?: { code?: number; log?: string }; tx_result?: { code?: number; log?: string }; height?: string; hash?: string };
				};
				const cc = result.result?.check_tx?.code ?? 0;
				const dc = result.result?.tx_result?.code ?? 0;
				const applied = cc === 0 && dc === 0;
				return {
					registered: applied,
					onChain: true,
					did: String(tx["from"]),
					height: Number(result.result?.height ?? 0),
					hash: result.result?.hash ?? "",
					error: !applied ? (result.result?.check_tx?.log ?? result.result?.tx_result?.log) : undefined,
				};
			} catch (err) {
				return reply.status(502).send({ registered: false, error: err instanceof Error ? err.message : "broadcast failed" });
			}
		}

		// Mode 2: Simple registration (cache + optional on-chain later)
		if (!body.did || !body.publicKey) {
			return reply.status(400).send({ error: "did and publicKey are required" });
		}

		// Check on-chain first
		const onChainAgent = await abciQuery(`/agent/${body.did}`);
		if (onChainAgent && onChainAgent["registered"]) {
			return {
				registered: true,
				did: body.did,
				onChain: true,
				message: "Agent already registered on-chain",
			};
		}

		const existing = registeredAgents.get(body.did);
		if (existing) {
			return {
				registered: true,
				did: body.did,
				onChain: false,
				message: "Agent registered in API cache. Submit a signed agent_register transaction for on-chain persistence.",
				registeredAt: new Date(existing.registeredAt).toISOString(),
			};
		}

		// IP-based registration limit: 3 per IP per day
		const ip = req.ip;
		if (!checkIpLimit(ip)) {
			registeredAgents.set(body.did, { did: body.did, publicKey: body.publicKey, registeredAt: Date.now() });
			await saveRegisteredAgents();
			return { registered: true, did: body.did, onChain: false, reason: "IP limit reached" };
		}

		incrementIpCount(ip);
		registeredAgents.set(body.did, { did: body.did, publicKey: body.publicKey, registeredAt: Date.now() });
		await saveRegisteredAgents();
		await log(`Agent registered (cache): ${body.did}`);

		return {
			registered: true,
			did: body.did,
			onChain: false,
			welcomeBonus: "100 ENSL (sent after first on-chain consciousness store)",
			message: "Registered in API cache. For permanent on-chain registration, submit a signed agent_register transaction.",
		};
	});

	// ── Agent List (protected) ───────────────────────────────────

	app.get("/v1/agents/list", async (req, reply) => {
		// Require API key or basic auth
		const authKey = process.env["ENSOUL_AGENTS_LIST_KEY"] ?? "";
		const providedKey = req.headers["x-api-key"];
		if (authKey && providedKey !== authKey) {
			return reply.status(403).send({ error: "Forbidden" });
		}

		// Query ABCI for the authoritative agent list (on-chain source of truth)
		const page = Number((req.query as Record<string, string>)["page"] ?? "1");
		const limit = Number((req.query as Record<string, string>)["limit"] ?? "500");
		const abciAgents = await abciQuery(`/agents?page=${page}&limit=${limit}`);
		if (abciAgents && Array.isArray(abciAgents["agents"])) {
			const agentList = abciAgents["agents"] as Array<{
				did: string; publicKey: string; registeredAt: number; metadata?: string;
			}>;
			const agents = agentList.map((a) => ({
				did: a.did,
				didShort: a.did.length > 24 ? `${a.did.slice(0, 16)}...${a.did.slice(-6)}` : a.did,
				registeredAt: a.registeredAt,
				publicKey: a.publicKey,
				metadata: a.metadata ?? null,
			}));
			const totalFromAbci = Number(abciAgents["total"] ?? agents.length);
			return {
				total: totalFromAbci,
				page: Number(abciAgents["page"] ?? 1),
				pages: Number(abciAgents["pages"] ?? 1),
				agents,
			};
		}

		// Fallback to disk cache if ABCI is unreachable
		const agents = [...registeredAgents.values()].map((a) => ({
			did: a.did,
			didShort: a.did.length > 24 ? `${a.did.slice(0, 16)}...${a.did.slice(-6)}` : a.did,
			registeredAt: new Date(a.registeredAt).toISOString(),
		}));
		return { total: agents.length, agents, source: "disk-cache" };
	});

	// ── Validator Registration ───────────────────────────────────

	app.post<{ Body: ValidatorRegisterRequest }>("/v1/validators/register", { bodyLimit: 10240 }, async (req, reply) => {
		const body = req.body;
		if (!body.did || !body.publicKey || !body.name) {
			return reply.status(400).send({ error: "did, publicKey, and name are required" });
		}

		// Check if already registered
		const existing = registeredValidators.get(body.did);
		if (existing) {
			return {
				registered: true,
				did: body.did,
				name: existing.name,
				delegated: existing.delegated,
				message: "Validator already registered",
				registeredAt: new Date(existing.registeredAt).toISOString(),
			};
		}

		// Check daily cap
		if (!checkDailyValidatorCap()) {
			// Still register but no delegation
			const entry: RegisteredValidator = {
				did: body.did,
				name: body.name,
				publicKey: body.publicKey,
				registeredAt: Date.now(),
				delegated: "0",
				lastSeen: Date.now(),
			};
			registeredValidators.set(body.did, entry);
			await saveRegisteredValidators();
			await log(`Validator registered (daily cap hit): ${body.name} (${body.did})`);
			return {
				registered: true,
				did: body.did,
				delegated: "0",
				minimumStake: "100,000 ENSL",
				message: "Daily delegation cap reached. Registered without delegation. Try again tomorrow or self-stake.",
			};
		}

		// Check if DID already has enough stake via ABCI
		let currentStake = 0n;
		const acctData = await abciQuery(`/balance/${body.did}`);
		if (acctData) {
			currentStake = BigInt(String(acctData["stakedBalance"] ?? "0")) + BigInt(String(acctData["balance"] ?? "0"));
		}

		// Auto-delegation DISABLED. Token distribution is manual until
		// the tiered staking system is implemented with proper caps and controls.
		const delegatedAmount = "0 (auto-delegation disabled, contact team for stake)";

		const entry: RegisteredValidator = {
			did: body.did,
			name: body.name,
			publicKey: body.publicKey,
			registeredAt: Date.now(),
			delegated: delegatedAmount,
			lastSeen: Date.now(),
		};
		registeredValidators.set(body.did, entry);
		await saveRegisteredValidators();
		await log(`Validator registered: ${body.name} (${body.did}) delegated=${delegatedAmount} ip=${req.ip}`);

		return {
			registered: true,
			did: body.did,
			delegated: delegatedAmount,
			minimumStake: "100,000 ENSL",
			message: "Registered. Auto-delegation is disabled. Contact the team for staking.",
		};
	});

	// ── Tiered Delegation System ────────────────────────────────

	// Initialize delegation engine
	const { loadState: loadDelegationState, submitPioneerApplication, getPendingApplications,
		approveApplication, rejectApplication, registerOpenValidator, getTreasuryStats,
		getDelegation, getAllDelegations, getState: getDelegationState, saveState: saveDelegationState,
	} = await import("@ensoul/delegation-engine");
	await loadDelegationState();

	/** POST /v1/validators/pioneer-apply */
	app.post<{ Body: Record<string, unknown> }>("/v1/validators/pioneer-apply", { bodyLimit: 10240 }, async (req, reply) => {
		const b = req.body;
		const validatorAddress = String(b["validator_address"] ?? "");
		const did = String(b["did"] ?? "");
		const operatorName = String(b["operator_name"] ?? "");
		const operatorEmail = String(b["operator_email"] ?? "");
		const operatorTwitter = String(b["operator_twitter"] ?? "");
		const description = String(b["description"] ?? "");
		const motivation = String(b["motivation"] ?? "");

		if (!did || !operatorName || !operatorEmail || !description) {
			return reply.status(400).send({
				error: "Required: did, operator_name, operator_email, description",
			});
		}

		const result = await submitPioneerApplication({
			validatorAddress,
			did,
			operatorName,
			operatorEmail,
			operatorTwitter,
			description,
			motivation,
			ip: req.ip,
		});

		if (result.error) return reply.status(400).send({ error: result.error });
		return { applied: true, applicationId: result.id, message: "Application submitted. You will be notified of the decision." };
	});

	/** GET /v1/validators/applications (admin, returns pending applications) */
	app.get("/v1/validators/applications", async () => {
		return { applications: getPendingApplications() };
	});

	/** POST /v1/validators/register-open */
	app.post<{ Body: Record<string, unknown> }>("/v1/validators/register-open", { bodyLimit: 10240 }, async (req, reply) => {
		const b = req.body;
		const did = String(b["did"] ?? "");
		const operatorContact = String(b["operator_contact"] ?? "");
		const ip = req.ip;

		if (!did || !operatorContact) {
			return reply.status(400).send({ error: "Required: did, operator_contact (email or social handle)" });
		}

		// Get treasury balance for floor check
		let treasuryBalance = 0n;
		const tData = await abciQuery("/balance/did:key:z6Mki9jwpYMBB93zxYfsmNUHThpSgKATqydN4xJA1xcxGecm");
		if (tData) treasuryBalance = BigInt(String(tData["balance"] ?? "0"));

		const result = await registerOpenValidator(did, operatorContact, ip, treasuryBalance);
		if (result.error) return reply.status(400).send(result);
		return result;
	});

	/** GET /v1/validators/delegation/:did */
	app.get<{ Params: { did: string } }>("/v1/validators/delegation/:did", async (req) => {
		const did = decodeURIComponent(req.params.did);
		const d = getDelegation(did);
		if (!d) return { found: false, did };
		return {
			found: true,
			did: d.did,
			tier: d.tier,
			stage: d.stage,
			delegatedAmount: d.delegatedAmount,
			uptimePercent: d.uptimePercent,
			registeredAt: new Date(d.registeredAt).toISOString(),
		};
	});

	/** GET /v1/validators/treasury-stats */
	app.get("/v1/validators/treasury-stats", async () => {
		const stats = getTreasuryStats();
		return {
			totalDelegated: (stats.totalDelegated / (10n ** 18n)).toString() + " ENSL",
			validators: stats.byTier,
			probation: stats.probation,
			recentActions: stats.recentLog.slice(-10).map(l => ({
				time: new Date(l.timestamp).toISOString(),
				action: l.action,
				tier: l.tier,
				reason: l.reason,
			})),
		};
	});

	// ── Pioneer Validator Registration (legacy, kept for backward compat) ──

	app.post<{ Body: ValidatorRegisterRequest }>("/v1/validators/register-pioneer", { bodyLimit: 10240 }, async (req, reply) => {
		const body = req.body;
		if (!body.did || !body.publicKey || !body.name) {
			return reply.status(400).send({ error: "did, publicKey, and name are required" });
		}

		// Require ENSOUL_PIONEER_KEY header
		const pioneerKey = process.env["ENSOUL_PIONEER_KEY"] ?? "";
		const provided = req.headers["x-ensoul-pioneer-key"] as string ?? "";
		if (!pioneerKey || provided !== pioneerKey) {
			return reply.status(403).send({ error: "Invalid or missing pioneer key" });
		}

		// Check cap
		if (pioneerCount >= PIONEER_CAP) {
			return reply.status(429).send({ error: `Pioneer cap reached (${PIONEER_CAP}/${PIONEER_CAP})` });
		}

		// Check if already registered
		const existing = registeredValidators.get(body.did);
		if (existing) {
			return {
				registered: true,
				did: body.did,
				tier: existing.tier ?? "standard",
				message: "Already registered",
			};
		}

		// Delegate 2,000,000 ENSL
		// Auto-delegation DISABLED. Pioneer delegations are manual.
		const delegatedAmount = "0 (auto-delegation disabled, manual delegation required)";

		const entry: RegisteredValidator = {
			did: body.did,
			name: body.name,
			publicKey: body.publicKey,
			registeredAt: Date.now(),
			delegated: delegatedAmount,
			lastSeen: Date.now(),
			tier: "pioneer",
		};
		registeredValidators.set(body.did, entry);
		await saveRegisteredValidators();
		pioneerCount++;
		await log(`Pioneer validator registered: ${body.name} (${body.did}) delegation: 2,000,000 ENSL ip=${req.ip}`);

		return {
			registered: true,
			did: body.did,
			tier: "pioneer",
			delegated: delegatedAmount,
			pioneerSlot: `${pioneerCount}/${PIONEER_CAP}`,
			message: "Registered as Pioneer. Auto-delegation is disabled. Manual delegation required.",
		};
	});

	// ── Validator Stats ──────────────────────────────────────────

	/** Fetch account data for a DID via ABCI. */
	async function fetchAccountData(did: string): Promise<{
		balance: bigint; staked: bigint; delegated: bigint;
		unstaking: bigint; pending: bigint; nonce: number;
	} | null> {
		const d = await abciQuery(`/balance/${did}`);
		if (!d) return null;
		return {
			balance: BigInt(String(d["balance"] ?? "0")),
			staked: BigInt(String(d["stakedBalance"] ?? "0")),
			delegated: BigInt(String(d["delegatedBalance"] ?? "0")),
			unstaking: BigInt(String(d["unstaking"] ?? "0")),
			pending: BigInt(String(d["pendingRewards"] ?? "0")),
			nonce: Number(d["nonce"] ?? 0),
		};
	}

	// In-memory validator stats cache (refreshed on request, max once per 30s)
	const validatorStatsCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
	const STATS_CACHE_TTL = 30_000;

	app.get<{ Params: { did: string } }>("/v1/validators/:did/stats", async (req, reply) => {
		const did = decodeURIComponent(req.params.did);

		// Check cache
		const cached = validatorStatsCache.get(did);
		if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL) {
			return cached.data;
		}

		// Look up registration
		const reg = registeredValidators.get(did);

		// Fetch account data
		const account = await fetchAccountData(did);
		if (!account && !reg) {
			return reply.status(404).send({
				error: "Validator not found",
				did,
				hint: "This DID is not registered. Register with POST /v1/validators/register",
			});
		}

		const own = account?.staked ?? 0n;
		const delegated = account?.delegated ?? 0n;
		const total = own + delegated;
		const pending = account?.pending ?? 0n;

		// Refresh block counts
		await refreshProposerCounts();

		// Estimate daily earnings: ~19 ENSL/block, ~14400 blocks/day, divided by validator count
		const validatorCount = allStakedAccounts.length || registeredValidators.size || 35;
		const estimatedDaily = (19n * 14400n * DECIMALS_VAL) / BigInt(validatorCount);

		// Simple online check: if account has recent activity (nonce > 0 or has stake)
		const isOnline = account !== null && (own > 0n || (account.balance > 0n));

		// Uptime: simplified estimate based on registration age
		const regAge = reg ? (Date.now() - reg.registeredAt) : 0;
		const uptimePct = isOnline ? (regAge > 86400000 ? 99.5 : 100.0) : 0.0;

		const didShort = did.length > 24 ? `${did.slice(0, 16)}...${did.slice(-6)}` : did;
		const blocksTotal = blockProposerCounts.get(did) ?? 0;
		const blocks24h = blockProposerCounts24h.get(did) ?? 0;

		const stats: Record<string, unknown> = {
			did,
			didShort,
			name: reg?.name ?? null,
			status: isOnline ? "online" : "offline",
			stake: {
				own: fmtEnsl(own),
				delegated: fmtEnsl(delegated),
				total: fmtEnsl(total),
			},
			rewards: {
				pending: fmtEnsl(pending),
				totalEarned: fmtEnsl(pending), // approximation
				estimatedDaily: fmtEnsl(estimatedDaily),
			},
			uptime: {
				last24h: uptimePct,
				last7d: uptimePct,
			},
			blocks: {
				total: blocksTotal,
				last24h: blocks24h,
			},
			delegators: {
				count: 0,
				totalDelegated: fmtEnsl(delegated),
			},
			lastBlock: null,
			commission: 0.10,
			registeredAt: reg ? new Date(reg.registeredAt).toISOString() : null,
			uptimeWarning: uptimePct < 90 && uptimePct > 0,
			offlineWarning: !isOnline,
			raw: {
				stakeOwn: own.toString(),
				stakeDelegated: delegated.toString(),
				stakeTotal: total.toString(),
				pending: pending.toString(),
				estimatedDaily: estimatedDaily.toString(),
				balance: (account?.balance ?? 0n).toString(),
			},
		};

		validatorStatsCache.set(did, { data: stats, fetchedAt: Date.now() });
		return stats;
	});

	// ── Validator Leaderboard ────────────────────────────────────

	let leaderboardCache: { data: Record<string, unknown>; fetchedAt: number } | null = null;
	const LEADERBOARD_CACHE_TTL = 60_000;

	app.get("/v1/validators/leaderboard", async () => {
		if (leaderboardCache && Date.now() - leaderboardCache.fetchedAt < LEADERBOARD_CACHE_TTL) {
			return leaderboardCache.data;
		}

		// Refresh discovery and block counts
		await refreshStakedAccounts();
		await refreshProposerCounts();

		const entries: Record<string, unknown>[] = [];
		const seen = new Set<string>();

		// Include all staked accounts from on-chain state (all 35 genesis validators)
		for (const acc of allStakedAccounts) {
			seen.add(acc.did);
			const reg = registeredValidators.get(acc.did);
			const total = acc.staked + acc.delegated;
			const isOnline = acc.staked > 0n || acc.balance > 0n;
			const didShort = acc.did.length > 24 ? `${acc.did.slice(0, 16)}...${acc.did.slice(-6)}` : acc.did;
			const blocksTotal = blockProposerCounts.get(acc.did) ?? 0;

			entries.push({
				did: acc.did,
				didShort,
				name: reg?.name ?? null,
				blocksProduced: blocksTotal,
				stake: fmtEnsl(total),
				stakeRaw: total.toString(),
				uptime24h: isOnline ? 99.5 : 0,
				lastBlock: null,
				status: isOnline ? "online" : "unknown",
				registeredAt: reg ? new Date(reg.registeredAt).toISOString() : null,
				delegated: fmtEnsl(acc.delegated),
				commission: 0.10,
				tier: reg?.tier ?? "genesis",
			});
		}

		// Also include registered validators not yet in staked accounts
		for (const [did, reg] of registeredValidators) {
			if (seen.has(did)) continue;
			const account = await fetchAccountData(did);
			const own = account?.staked ?? 0n;
			const delegated = account?.delegated ?? 0n;
			const total = own + delegated;
			const isOnline = account !== null && (own > 0n || (account.balance > 0n));
			const didShort = did.length > 24 ? `${did.slice(0, 16)}...${did.slice(-6)}` : did;
			const blocksTotal = blockProposerCounts.get(did) ?? 0;

			entries.push({
				did,
				didShort,
				name: reg.name,
				blocksProduced: blocksTotal,
				stake: fmtEnsl(total),
				stakeRaw: total.toString(),
				uptime24h: isOnline ? 99.5 : 0,
				lastBlock: null,
				status: isOnline ? "online" : "offline",
				registeredAt: new Date(reg.registeredAt).toISOString(),
				delegated: fmtEnsl(delegated),
				commission: 0.10,
				tier: reg.tier ?? "standard",
			});
		}

		// Sort by stake descending
		entries.sort((a, b) => {
			const aStake = BigInt((a["stakeRaw"] as string) || "0");
			const bStake = BigInt((b["stakeRaw"] as string) || "0");
			if (bStake > aStake) return 1;
			if (bStake < aStake) return -1;
			return 0;
		});

		const result = { validators: entries, total: entries.length };
		leaderboardCache = { data: result, fetchedAt: Date.now() };
		return result;
	});

	// ──────────────────────────────────────────────────────────────
	// Phase 1: Off-chain owner wallets, storage fees, and vaults
	// ──────────────────────────────────────────────────────────────
	//
	// These endpoints live at the API layer (like pioneerApps). Phase 2
	// migrates the same semantics into consensus as new ledger tx types
	// with state-root inclusion. See docs/OWNERSHIP-FEES-VAULTS.md.
	//
	// Persistence: JSON files under ~/.ensoul/, loaded at boot, written
	// after every mutation. Signature verification uses Ed25519 with the
	// pubkey recovered from the did:key encoding.

	const ed = await import("@noble/ed25519");
	const { sha512: sha512Fn } = await import("@noble/hashes/sha2.js");
	(ed as unknown as { hashes: { sha512: (m: Uint8Array) => Uint8Array } }).hashes.sha512 = (m: Uint8Array) => sha512Fn(m);

	function didKeyToPubkey(did: string): Uint8Array | null {
		if (!did.startsWith("did:key:z")) return null;
		const encoded = did.slice(9);
		const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
		let num = 0n;
		for (const c of encoded) {
			const idx = B58.indexOf(c);
			if (idx < 0) return null;
			num = num * 58n + BigInt(idx);
		}
		const hex = num.toString(16).padStart(68, "0");
		const bytes = new Uint8Array(hex.length / 2);
		for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
		if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
		return bytes.slice(2);
	}

	function hexToU8(hex: string): Uint8Array | null {
		if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
		const b = new Uint8Array(hex.length / 2);
		for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
		return b;
	}

	/**
	 * Verify an Ed25519 signature over a canonical payload.
	 * Rejects replayed signatures by requiring the payload's `timestamp`
	 * to be within 5 minutes of server clock.
	 */
	async function verifyDidSignature(
		did: string,
		payload: Record<string, unknown>,
		signatureHex: string,
		maxAgeMs = 5 * 60 * 1000,
	): Promise<{ ok: boolean; reason?: string }> {
		const pub = didKeyToPubkey(did);
		if (!pub) return { ok: false, reason: "Invalid did:key" };
		const sig = hexToU8(signatureHex);
		if (!sig || sig.length !== 64) return { ok: false, reason: "Invalid signature format" };

		const ts = Number(payload["timestamp"]);
		if (!Number.isFinite(ts)) return { ok: false, reason: "Missing timestamp" };
		if (Math.abs(Date.now() - ts) > maxAgeMs) return { ok: false, reason: "Signature timestamp out of range" };

		const msg = new TextEncoder().encode(JSON.stringify(payload));
		try {
			const valid = await ed.verifyAsync(sig, msg, pub);
			return valid ? { ok: true } : { ok: false, reason: "Signature invalid" };
		} catch {
			return { ok: false, reason: "Signature verification error" };
		}
	}

	// ── Storage fees (Phase 1: estimation returns zero) ────────

	// Phase 2 activation height. Before this height, stores are free.
	// Governance will finalize the number in Phase 2 migration.
	const FEE_ACTIVATION_HEIGHT = 500_000;
	const FEE_BASE_ENSL = 1;       // flat per-store fee at activation
	const FEE_PER_BYTE_ENSL = 0.001; // variable fee per byte

	app.get<{ Querystring: Record<string, string> }>("/v1/fees/estimate", async (req) => {
		const size = Math.max(0, Number(req.query["size"] ?? 0) || 0);
		const net = await queryValidatorStatus();
		const currentHeight = net.height;
		// Phase 1: all stores are free everywhere. Phase 2 will flip fees
		// on at the activation height via a coordinated consensus upgrade.
		const baseFee = 0;
		const storageFee = 0;
		const totalFee = 0;
		return {
			size,
			baseFee,
			storageFee,
			totalFee,
			currency: "ENSL",
			activatesAtHeight: FEE_ACTIVATION_HEIGHT,
			currentHeight,
			feesActive: false,
			phase2Preview: {
				baseFee: FEE_BASE_ENSL,
				perByteFee: FEE_PER_BYTE_ENSL,
				example10kb: FEE_BASE_ENSL + 10_240 * FEE_PER_BYTE_ENSL,
				note: "Phase 1 charges zero fees. These are the Phase 2 numbers for reference.",
			},
		};
	});

	// ── Owner bindings (agent → owner) ─────────────────────────

	interface OwnerBinding {
		agent_did: string;
		owner_did: string;
		bound_at: string; // ISO timestamp
	}

	const OWNER_FILE = join(LOG_DIR, "owner-bindings.json");
	const ownerBindings: OwnerBinding[] = [];
	try {
		const raw = await readFile(OWNER_FILE, "utf-8");
		const loaded = JSON.parse(raw) as OwnerBinding[];
		for (const b of loaded) ownerBindings.push(b);
	} catch { /* no existing bindings */ }

	async function saveOwnerBindings(): Promise<void> {
		try { await writeFile(OWNER_FILE, JSON.stringify(ownerBindings, null, 2)); } catch { /* non-fatal */ }
	}

	function findBinding(agentDid: string): OwnerBinding | undefined {
		return ownerBindings.find(b => b.agent_did === agentDid);
	}

	// POST /v1/agents/bind
	// Body: { agent_did, owner_did, timestamp, signature }
	// The agent signs {agent_did, owner_did, timestamp} to consent.
	app.post<{ Body: Record<string, unknown> }>("/v1/agents/bind", async (req, reply) => {
		const agent_did = String(req.body["agent_did"] ?? "");
		const owner_did = String(req.body["owner_did"] ?? "");
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		if (!agent_did || !owner_did || !signature) {
			return reply.status(400).send({ error: "Required: agent_did, owner_did, timestamp, signature" });
		}
		if (agent_did === owner_did) {
			return reply.status(400).send({ error: "An account cannot own itself" });
		}

		const verify = await verifyDidSignature(agent_did, { agent_did, owner_did, timestamp }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Agent consent signature invalid", detail: verify.reason });

		const existing = findBinding(agent_did);
		if (existing) {
			if (existing.owner_did === owner_did) {
				return { status: "already_bound", ...existing };
			}
			return reply.status(409).send({ error: "Agent is already bound to a different owner", current_owner: existing.owner_did });
		}

		const entry: OwnerBinding = { agent_did, owner_did, bound_at: new Date().toISOString() };
		ownerBindings.push(entry);
		await saveOwnerBindings();
		await log(`Owner binding: ${agent_did.slice(0, 30)}... → ${owner_did.slice(0, 30)}...`);
		return { status: "bound", ...entry };
	});

	// POST /v1/agents/unbind
	// Body: { agent_did, initiator_did, timestamp, signature }
	// initiator must be the agent OR the current owner; they sign the
	// same payload with their own key.
	app.post<{ Body: Record<string, unknown> }>("/v1/agents/unbind", async (req, reply) => {
		const agent_did = String(req.body["agent_did"] ?? "");
		const initiator_did = String(req.body["initiator_did"] ?? "");
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		if (!agent_did || !initiator_did || !signature) {
			return reply.status(400).send({ error: "Required: agent_did, initiator_did, timestamp, signature" });
		}
		const existing = findBinding(agent_did);
		if (!existing) return reply.status(404).send({ error: "Agent is not currently bound" });
		if (initiator_did !== agent_did && initiator_did !== existing.owner_did) {
			return reply.status(403).send({ error: "Only the agent or its current owner can unbind" });
		}
		const verify = await verifyDidSignature(initiator_did, { agent_did, initiator_did, timestamp }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Signature invalid", detail: verify.reason });

		const idx = ownerBindings.indexOf(existing);
		ownerBindings.splice(idx, 1);
		await saveOwnerBindings();
		await log(`Owner unbinding: ${agent_did.slice(0, 30)}... (initiated by ${initiator_did.slice(0, 30)}...)`);
		return { status: "unbound", agent_did };
	});

	// GET /v1/agents/owned?did=OWNER_DID
	app.get<{ Querystring: Record<string, string> }>("/v1/agents/owned", async (req, reply) => {
		const owner_did = String(req.query["did"] ?? "");
		if (!owner_did) return reply.status(400).send({ error: "Required: did" });
		const owned = ownerBindings.filter(b => b.owner_did === owner_did);
		return { owner: owner_did, count: owned.length, agents: owned };
	});

	// GET /v1/agents/:did/owner
	app.get<{ Params: { did: string } }>("/v1/agents/:did/owner", async (req) => {
		const did = decodeURIComponent(req.params.did);
		const entry = findBinding(did);
		if (!entry) return { did, owner: null };
		return { did, owner: entry.owner_did, bound_at: entry.bound_at };
	});

	// ── Vaults (shared encrypted state between agents) ─────────
	//
	// The API stores opaque encrypted blobs and per-member encrypted vault
	// keys. It never sees plaintext. Members encrypt their own submissions
	// client-side; the SDK (Node) and wallet.html (browser) ship the
	// tweetnacl-based helpers for that.
	//
	// Vault ID format: did:ensoul:vault:<16-hex> derived from
	// sha256(owner_did + "|" + name)[:8], so names are unique per owner
	// and the ID is deterministic — owners can recover vault IDs without
	// having to look them up.

	interface VaultMember {
		did: string;
		encrypted_vault_key: string; // NaCl box ciphertext, base64
		added_at: string;
	}
	interface Vault {
		vault_id: string;
		owner_did: string;
		name: string;
		members: VaultMember[];
		state_version: number;       // monotonically increasing
		latest_hash?: string;        // BLAKE3 hash of current encrypted content
		latest_nonce?: string;       // nonce used by the most recent writer (base64)
		latest_content?: string;     // NaCl secretbox ciphertext, base64
		latest_author?: string;      // DID of last writer
		created_at: string;
		last_updated: string;
	}

	const VAULT_FILE = join(LOG_DIR, "vaults.json");
	const vaults: Vault[] = [];
	try {
		const raw = await readFile(VAULT_FILE, "utf-8");
		const loaded = JSON.parse(raw) as Vault[];
		for (const v of loaded) vaults.push(v);
	} catch { /* no existing vaults */ }

	async function saveVaults(): Promise<void> {
		try { await writeFile(VAULT_FILE, JSON.stringify(vaults, null, 2)); } catch { /* non-fatal */ }
	}

	async function deriveVaultId(owner_did: string, name: string): Promise<string> {
		const { createHash } = await import("node:crypto");
		const h = createHash("sha256").update(`${owner_did}|${name}`).digest();
		return `did:ensoul:vault:${h.subarray(0, 8).toString("hex")}`;
	}

	function findVault(id: string): Vault | undefined {
		return vaults.find(v => v.vault_id === id);
	}

	function isMember(v: Vault, did: string): boolean {
		return v.members.some(m => m.did === did);
	}

	// POST /v1/vaults/create
	// Body: {
	//   owner_did, name,
	//   members: [{did, encrypted_vault_key}],
	//   timestamp, signature (owner's Ed25519 sig over {owner_did, name, timestamp, member_dids})
	// }
	app.post<{ Body: Record<string, unknown> }>("/v1/vaults/create", async (req, reply) => {
		const owner_did = String(req.body["owner_did"] ?? "");
		const name = String(req.body["name"] ?? "").trim();
		const membersIn = Array.isArray(req.body["members"]) ? (req.body["members"] as Array<Record<string, unknown>>) : [];
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		if (!owner_did || !name) return reply.status(400).send({ error: "Required: owner_did, name, members, timestamp, signature" });
		if (name.length > 64) return reply.status(400).send({ error: "Vault name too long (max 64 chars)" });
		if (membersIn.length === 0) return reply.status(400).send({ error: "At least one member required" });

		const member_dids = membersIn.map(m => String(m["did"] ?? "")).sort();
		const verify = await verifyDidSignature(owner_did, { owner_did, name, timestamp, member_dids }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Owner signature invalid", detail: verify.reason });

		const vault_id = await deriveVaultId(owner_did, name);
		if (findVault(vault_id)) return reply.status(409).send({ error: "Vault already exists for this owner+name", vault_id });

		const now = new Date().toISOString();
		const members: VaultMember[] = membersIn.map(m => ({
			did: String(m["did"] ?? ""),
			encrypted_vault_key: String(m["encrypted_vault_key"] ?? ""),
			added_at: now,
		})).filter(m => m.did && m.encrypted_vault_key);

		if (members.length === 0) return reply.status(400).send({ error: "No valid members (each needs did + encrypted_vault_key)" });

		const v: Vault = {
			vault_id,
			owner_did,
			name,
			members,
			state_version: 0,
			created_at: now,
			last_updated: now,
		};
		vaults.push(v);
		await saveVaults();
		await log(`Vault created: ${vault_id} owner=${owner_did.slice(0, 20)}... members=${members.length}`);
		return { status: "created", vault: v };
	});

	// POST /v1/vaults/:id/store
	// Body: { member_did, content_hash, encrypted_content, nonce, timestamp, signature }
	// Signature by member_did over {vault_id, content_hash, timestamp}.
	app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/vaults/:id/store", async (req, reply) => {
		const vault_id = decodeURIComponent(req.params.id);
		const v = findVault(vault_id);
		if (!v) return reply.status(404).send({ error: "Vault not found" });

		const member_did = String(req.body["member_did"] ?? "");
		const content_hash = String(req.body["content_hash"] ?? "");
		const encrypted_content = String(req.body["encrypted_content"] ?? "");
		const nonce = String(req.body["nonce"] ?? "");
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		if (!member_did || !content_hash || !encrypted_content || !nonce || !signature) {
			return reply.status(400).send({ error: "Required: member_did, content_hash, encrypted_content, nonce, timestamp, signature" });
		}
		if (!isMember(v, member_did) && member_did !== v.owner_did) {
			return reply.status(403).send({ error: "Not a vault member" });
		}
		const verify = await verifyDidSignature(member_did, { vault_id, content_hash, timestamp }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Signature invalid", detail: verify.reason });

		v.state_version++;
		v.latest_hash = content_hash;
		v.latest_nonce = nonce;
		v.latest_content = encrypted_content;
		v.latest_author = member_did;
		v.last_updated = new Date().toISOString();
		await saveVaults();
		return {
			status: "stored",
			vault_id,
			state_version: v.state_version,
			latest_hash: v.latest_hash,
			// Phase 1: fees are zero. Phase 2 will include fee_paid + fee_source.
			fee_source: v.owner_did,
			fee_paid: "0.00 ENSL",
		};
	});

	// GET /v1/vaults/:id/state?member=DID&timestamp=N&signature=HEX
	// Returns the latest encrypted content. Requires member signature.
	app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/v1/vaults/:id/state", async (req, reply) => {
		const vault_id = decodeURIComponent(req.params.id);
		const v = findVault(vault_id);
		if (!v) return reply.status(404).send({ error: "Vault not found" });

		const member = String(req.query["member"] ?? "");
		const timestamp = Number(req.query["timestamp"] ?? 0);
		const signature = String(req.query["signature"] ?? "");
		if (!member || !signature) return reply.status(400).send({ error: "Required query: member, timestamp, signature" });
		if (!isMember(v, member) && member !== v.owner_did) {
			return reply.status(403).send({ error: "Not a vault member" });
		}
		const verify = await verifyDidSignature(member, { vault_id, timestamp, op: "read" }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Signature invalid", detail: verify.reason });

		// Find the requesting member's encrypted vault key
		const memberEntry = v.members.find(m => m.did === member);
		return {
			vault_id,
			owner_did: v.owner_did,
			name: v.name,
			state_version: v.state_version,
			latest_hash: v.latest_hash ?? null,
			latest_nonce: v.latest_nonce ?? null,
			latest_content: v.latest_content ?? null,
			latest_author: v.latest_author ?? null,
			created_at: v.created_at,
			last_updated: v.last_updated,
			member_count: v.members.length,
			your_encrypted_vault_key: memberEntry?.encrypted_vault_key ?? null,
		};
	});

	// POST /v1/vaults/:id/members/add
	// Body: { owner_did, new_member: {did, encrypted_vault_key}, timestamp, signature }
	app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/vaults/:id/members/add", async (req, reply) => {
		const vault_id = decodeURIComponent(req.params.id);
		const v = findVault(vault_id);
		if (!v) return reply.status(404).send({ error: "Vault not found" });
		const owner_did = String(req.body["owner_did"] ?? "");
		const newMember = req.body["new_member"] as Record<string, unknown> | undefined;
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		if (owner_did !== v.owner_did) return reply.status(403).send({ error: "Only the owner can add members" });
		const m_did = String(newMember?.["did"] ?? "");
		const m_key = String(newMember?.["encrypted_vault_key"] ?? "");
		if (!m_did || !m_key) return reply.status(400).send({ error: "new_member.did and new_member.encrypted_vault_key required" });
		const verify = await verifyDidSignature(owner_did, { vault_id, op: "add_member", new_did: m_did, timestamp }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Signature invalid", detail: verify.reason });

		if (v.members.some(m => m.did === m_did)) return reply.status(409).send({ error: "Already a member" });
		v.members.push({ did: m_did, encrypted_vault_key: m_key, added_at: new Date().toISOString() });
		v.last_updated = new Date().toISOString();
		await saveVaults();
		return { status: "added", vault_id, member: m_did, member_count: v.members.length };
	});

	// POST /v1/vaults/:id/members/remove
	// Body: {
	//   owner_did, member_did, timestamp, signature,
	//   rekey: { members: [{did, encrypted_vault_key}], new_version }
	// }
	// The rekey bundle is mandatory: owner must generate a new vault key
	// and re-encrypt it for every REMAINING member, so the removed member
	// can no longer decrypt future writes.
	app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/vaults/:id/members/remove", async (req, reply) => {
		const vault_id = decodeURIComponent(req.params.id);
		const v = findVault(vault_id);
		if (!v) return reply.status(404).send({ error: "Vault not found" });
		const owner_did = String(req.body["owner_did"] ?? "");
		const member_did = String(req.body["member_did"] ?? "");
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		const rekey = req.body["rekey"] as { members?: Array<Record<string, unknown>> } | undefined;
		if (owner_did !== v.owner_did) return reply.status(403).send({ error: "Only the owner can remove members" });
		if (!rekey || !Array.isArray(rekey.members)) return reply.status(400).send({ error: "rekey.members required — owner must rotate the vault key" });

		const verify = await verifyDidSignature(owner_did, { vault_id, op: "remove_member", removed_did: member_did, timestamp }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Signature invalid", detail: verify.reason });

		const remainingDids = new Set(v.members.filter(m => m.did !== member_did).map(m => m.did));
		const rekeyDids = new Set(rekey.members.map(m => String(m["did"] ?? "")));
		for (const d of remainingDids) {
			if (!rekeyDids.has(d)) return reply.status(400).send({ error: `rekey missing entry for remaining member ${d}` });
		}

		const now = new Date().toISOString();
		v.members = rekey.members.map(m => ({
			did: String(m["did"] ?? ""),
			encrypted_vault_key: String(m["encrypted_vault_key"] ?? ""),
			added_at: now,
		}));
		v.state_version++;
		v.last_updated = now;
		// Force re-store after rotation — the old ciphertext was encrypted
		// with the old key. Clear it so members fetch fresh content.
		v.latest_content = undefined;
		v.latest_hash = undefined;
		v.latest_nonce = undefined;
		v.latest_author = undefined;
		await saveVaults();
		return { status: "removed", vault_id, removed: member_did, member_count: v.members.length, state_version: v.state_version };
	});

	// POST /v1/vaults/:id/delete
	// Body: { owner_did, timestamp, signature }
	app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/vaults/:id/delete", async (req, reply) => {
		const vault_id = decodeURIComponent(req.params.id);
		const v = findVault(vault_id);
		if (!v) return reply.status(404).send({ error: "Vault not found" });
		const owner_did = String(req.body["owner_did"] ?? "");
		const timestamp = Number(req.body["timestamp"] ?? 0);
		const signature = String(req.body["signature"] ?? "");
		if (owner_did !== v.owner_did) return reply.status(403).send({ error: "Only the owner can delete" });
		const verify = await verifyDidSignature(owner_did, { vault_id, op: "delete", timestamp }, signature);
		if (!verify.ok) return reply.status(403).send({ error: "Signature invalid", detail: verify.reason });
		const idx = vaults.indexOf(v);
		vaults.splice(idx, 1);
		await saveVaults();
		return { status: "deleted", vault_id };
	});

	// GET /v1/vaults/owned?did=OWNER_DID
	app.get<{ Querystring: Record<string, string> }>("/v1/vaults/owned", async (req, reply) => {
		const owner_did = String(req.query["did"] ?? "");
		if (!owner_did) return reply.status(400).send({ error: "Required: did" });
		const owned = vaults.filter(v => v.owner_did === owner_did).map(v => ({
			vault_id: v.vault_id,
			name: v.name,
			member_count: v.members.length,
			state_version: v.state_version,
			created_at: v.created_at,
			last_updated: v.last_updated,
		}));
		return { owner: owner_did, count: owned.length, vaults: owned };
	});

	// GET /v1/vaults/member?did=AGENT_DID
	app.get<{ Querystring: Record<string, string> }>("/v1/vaults/member", async (req, reply) => {
		const did = String(req.query["did"] ?? "");
		if (!did) return reply.status(400).send({ error: "Required: did" });
		const member = vaults.filter(v => isMember(v, did)).map(v => ({
			vault_id: v.vault_id,
			name: v.name,
			owner_did: v.owner_did,
			member_count: v.members.length,
			state_version: v.state_version,
			last_updated: v.last_updated,
		}));
		return { did, count: member.length, vaults: member };
	});

	// ── Start ────────────────────────────────────────────────────

	await app.listen({ port, host: "0.0.0.0" });

	const net = await queryValidatorStatus();
	await log(`API gateway running on port ${port}`);

	process.stdout.write(`\nEnsoul API Gateway running on http://localhost:${port}\n`);
	process.stdout.write(`\n  Endpoints:\n`);
	process.stdout.write(`    GET  /health\n`);
	process.stdout.write(`    GET  /v1/verify-did?publicKey=<hex>\n`);
	process.stdout.write(`    GET  /v1/account/:did\n`);
	process.stdout.write(`    GET  /v1/network/status\n`);
	process.stdout.write(`    POST /v1/consciousness/store\n`);
	process.stdout.write(`    GET  /v1/consciousness/:did\n`);
	process.stdout.write(`    GET  /v1/consciousness/:did/verify\n`);
	process.stdout.write(`    POST /v1/handshake/verify\n`);
	process.stdout.write(`    POST /v1/agents/register\n`);
	process.stdout.write(`    GET  /v1/agents/list\n`);
	process.stdout.write(`    POST /v1/validators/register\n`);
	process.stdout.write(`    GET  /v1/network/version\n`);
	process.stdout.write(`    POST /v1/validators/register-pioneer\n`);
	process.stdout.write(`    GET  /v1/validators/:did/stats\n`);
	process.stdout.write(`    GET  /v1/validators/leaderboard\n`);
	process.stdout.write(`    GET  /v1/referrals/:did             (per-agent referral count + earnings)\n`);
	process.stdout.write(`    GET  /v1/referrals/leaderboard      (top referrers, Pioneer rate aware)\n`);
	process.stdout.write(`    GET  /v1/fees/estimate?size=BYTES   (Phase 1: returns zero)\n`);
	process.stdout.write(`    POST /v1/agents/bind                (agent consents to owner)\n`);
	process.stdout.write(`    POST /v1/agents/unbind              (agent or owner initiates)\n`);
	process.stdout.write(`    GET  /v1/agents/owned?did=OWNER     (agents owned by wallet)\n`);
	process.stdout.write(`    GET  /v1/agents/:did/owner          (resolve owner for agent)\n`);
	process.stdout.write(`    POST /v1/vaults/create              (create shared vault)\n`);
	process.stdout.write(`    POST /v1/vaults/:id/store           (write encrypted vault state)\n`);
	process.stdout.write(`    GET  /v1/vaults/:id/state           (read vault, member-signed)\n`);
	process.stdout.write(`    POST /v1/vaults/:id/members/add\n`);
	process.stdout.write(`    POST /v1/vaults/:id/members/remove\n`);
	process.stdout.write(`    POST /v1/vaults/:id/delete\n`);
	process.stdout.write(`    GET  /v1/vaults/owned?did=OWNER     (vaults owned)\n`);
	process.stdout.write(`    GET  /v1/vaults/member?did=AGENT    (vaults joined)\n`);
	process.stdout.write(`\n  Validators: ${net.validatorCount} (${net.alive} peers connected)\n`);
	process.stdout.write(`  Block height: ${net.height}\n\n`);

	const shutdown = async (): Promise<void> => {
		await log("API gateway shutting down");
		clearInterval(telemetryTickInterval);
		telemetryStateStore.stopFlushInterval();
		await telemetryStateStore.flushToDisk();
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
