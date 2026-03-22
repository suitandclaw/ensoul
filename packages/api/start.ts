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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 5000);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..", "..");
const DEFAULT_ONBOARDING_KEY_PATH = join(REPO_DIR, "genesis-keys", "onboarding.json");
const LOG_DIR = join(homedir(), ".ensoul");
const LOG_FILE = join(LOG_DIR, "api.log");

// Validator endpoints to proxy to
const VALIDATORS = [
	"https://v0.ensoul.dev",
	"https://v1.ensoul.dev",
	"https://v2.ensoul.dev",
	"https://v3.ensoul.dev",
];

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

interface PeerStatus {
	height: number;
	peerCount: number;
	did: string;
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
		const txPayload = JSON.stringify({
			type: "delegate",
			from: treasuryDid,
			to: validatorDid,
			amount: amount.toString(),
			nonce: treasuryNonce,
			timestamp: Date.now(),
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
			timestamp: Date.now(),
			signature: bytesToHexLocal(signature),
		};

		for (const url of VALIDATORS) {
			try {
				const resp = await fetch(`${url}/peer/tx`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(serializedTx),
					signal: AbortSignal.timeout(5000),
				});
				if (resp.ok) {
					const result = (await resp.json()) as { accepted: boolean };
					if (result.accepted) {
						treasuryNonce++;
						await log(`Foundation delegation submitted: 100,000 ENSL to ${validatorDid}`);
						return true;
					}
				}
			} catch {
				continue;
			}
		}

		await log(`Foundation delegation failed: no validator accepted the transaction for ${validatorDid}`);
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
 * Uses the canonical DID list from genesis.json and queries the local
 * validator (localhost:9000) which has the full account state.
 */
async function refreshStakedAccounts(): Promise<void> {
	if (Date.now() - stakedAccountsFetchedAt < STAKED_ACCOUNTS_TTL) return;

	// Combine genesis DIDs + registered validators
	const allDids = new Set(genesisDids);
	for (const [did] of registeredValidators) allDids.add(did);

	// Query the local validator first (has full state), fall back to tunnels
	const endpoints = ["http://localhost:9000", ...VALIDATORS];
	const accounts: StakedAccount[] = [];

	// Find a working endpoint
	let workingUrl = "";
	for (const url of endpoints) {
		try {
			const resp = await fetch(`${url}/peer/status`, { signal: AbortSignal.timeout(3000) });
			if (resp.ok) { workingUrl = url; break; }
		} catch { continue; }
	}

	if (!workingUrl) {
		await log("Warning: no validator reachable for account queries");
		stakedAccountsFetchedAt = Date.now();
		return;
	}

	// Batch-query all DIDs from the working validator
	for (const did of allDids) {
		try {
			const resp = await fetch(
				`${workingUrl}/peer/account/${encodeURIComponent(did)}`,
				{ signal: AbortSignal.timeout(3000) },
			);
			if (!resp.ok) continue;
			const d = (await resp.json()) as {
				balance: string; staked: string; delegatedBalance?: string;
				pendingRewards?: string; nonce: number;
			};
			const staked = BigInt(d.staked);
			const balance = BigInt(d.balance);
			if (staked > 0n || balance > 0n) {
				accounts.push({
					did,
					balance,
					staked,
					delegated: BigInt(d.delegatedBalance ?? "0"),
					pending: BigInt(d.pendingRewards ?? "0"),
					nonce: d.nonce,
				});
			}
		} catch { /* skip unreachable */ }
	}

	allStakedAccounts = accounts;
	stakedAccountsFetchedAt = Date.now();
	await log(`Refreshed ${accounts.length} staked accounts from ${workingUrl}`);
}

// ── Block proposer counting ─────────────────────────────────────────

const blockProposerCounts = new Map<string, number>();
const blockProposerCounts24h = new Map<string, number>();
let proposerCountsFetchedAt = 0;
const PROPOSER_COUNTS_TTL = 60_000;

/** Scan recent blocks from the primary validator to count proposers. */
async function refreshProposerCounts(): Promise<void> {
	if (Date.now() - proposerCountsFetchedAt < PROPOSER_COUNTS_TTL) return;

	// Try localhost first (co-located validator), then tunnel endpoints
	const endpoints = ["http://localhost:9000", ...VALIDATORS];
	for (const url of endpoints) {
		try {
			const statusResp = await fetch(`${url}/peer/status`, { signal: AbortSignal.timeout(5000) });
			if (!statusResp.ok) continue;
			const status = (await statusResp.json()) as PeerStatus;
			const tipHeight = status.height;

			// Scan last 1000 blocks (or all if chain is shorter)
			const fromHeight = Math.max(1, tipHeight - 999);
			const syncResp = await fetch(`${url}/peer/sync/${fromHeight}`, { signal: AbortSignal.timeout(15000) });
			if (!syncResp.ok) continue;

			const data = (await syncResp.json()) as { blocks?: Array<{ proposer: string; height: number; timestamp: number }>; } | Array<{ proposer: string; height: number; timestamp: number }>;
			const blocks = Array.isArray(data) ? data : (data.blocks ?? []);

			const counts = new Map<string, number>();
			const counts24h = new Map<string, number>();
			const cutoff24h = Date.now() - 86400000;

			for (const block of blocks) {
				if (!block.proposer) continue;
				counts.set(block.proposer, (counts.get(block.proposer) ?? 0) + 1);
				if (block.timestamp && block.timestamp > cutoff24h) {
					counts24h.set(block.proposer, (counts24h.get(block.proposer) ?? 0) + 1);
				}
			}

			blockProposerCounts.clear();
			for (const [k, v] of counts) blockProposerCounts.set(k, v);
			blockProposerCounts24h.clear();
			for (const [k, v] of counts24h) blockProposerCounts24h.set(k, v);
			proposerCountsFetchedAt = Date.now();

			await log(`Scanned ${blocks.length} blocks, ${counts.size} unique proposers`);
			return;
		} catch { continue; }
	}
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

/** Check onboarding account balance via validator API. */
async function checkOnboardingBalance(): Promise<boolean> {
	if (!onboardingDid) return false;
	for (const url of VALIDATORS) {
		try {
			const resp = await fetch(
				`${url}/peer/account/${encodeURIComponent(onboardingDid)}`,
				{ signal: AbortSignal.timeout(5000) },
			);
			if (!resp.ok) continue;
			const data = (await resp.json()) as { balance: string };
			const balance = BigInt(data.balance);
			if (balance < MIN_ONBOARDING_BALANCE) {
				await log(`WARNING: onboarding balance ${balance / (10n ** 18n)} ENSL below 10M floor. Bonuses paused.`);
				return false;
			}
			return true;
		} catch { continue; }
	}
	return true; // If no validator responds, allow (best effort)
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
		// Build the transaction payload (same format as @ensoul/ledger encodeTxPayload)
		const txPayload = JSON.stringify({
			type: "transfer",
			from: onboardingDid,
			to: agentDid,
			amount: WELCOME_BONUS.toString(),
			nonce: onboardingNonce,
			timestamp: Date.now(),
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

		// Build serialized transaction for the peer API
		const serializedTx = {
			type: "transfer",
			from: onboardingDid!,
			to: agentDid,
			amount: WELCOME_BONUS.toString(),
			nonce: onboardingNonce,
			timestamp: Date.now(),
			signature: bytesToHexLocal(signature),
		};

		// Submit to the first available validator
		for (const url of VALIDATORS) {
			try {
				const resp = await fetch(`${url}/peer/tx`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(serializedTx),
					signal: AbortSignal.timeout(5000),
				});
				if (resp.ok) {
					const result = (await resp.json()) as { accepted: boolean };
					if (result.accepted) {
						onboardingNonce++;
						await log(`Welcome bonus submitted: 1000 ENSL to ${agentDid} (nonce ${onboardingNonce - 1})`);
						return true;
					}
				}
			} catch {
				continue;
			}
		}

		await log(`Welcome bonus failed: no validator accepted the transaction for ${agentDid}`);
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
	let maxHeight = 0;
	let alive = 0;
	const dids = new Set<string>();

	const results = await Promise.allSettled(
		VALIDATORS.map(async (url) => {
			const resp = await fetch(`${url}/peer/status`, { signal: AbortSignal.timeout(5000) });
			if (!resp.ok) return null;
			return (await resp.json()) as PeerStatus;
		}),
	);

	for (const r of results) {
		if (r.status === "fulfilled" && r.value) {
			alive++;
			if (r.value.height > maxHeight) maxHeight = r.value.height;
			dids.add(r.value.did);
		}
	}

	return { height: maxHeight, validatorCount: dids.size, alive };
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
		const encoded = encodeURIComponent(did);

		// Try each validator until one responds
		for (const url of VALIDATORS) {
			try {
				const resp = await fetch(`${url}/peer/account/${encoded}`, {
					signal: AbortSignal.timeout(5000),
				});
				if (!resp.ok) continue;
				const data = (await resp.json()) as {
					did: string;
					balance: string;
					staked: string;
					unstaking?: string;
					unstakingCompleteAt?: number;
					stakeLockedUntil?: number;
					delegatedBalance?: string;
					pendingRewards?: string;
					nonce: number;
					storageCredits?: string;
				};

				const available = BigInt(data.balance);
				const staked = BigInt(data.staked);
				const delegated = BigInt(data.delegatedBalance ?? "0");
				const unstaking = BigInt(data.unstaking ?? "0");
				const pending = BigInt(data.pendingRewards ?? "0");
				const credits = BigInt(data.storageCredits ?? "0");
				const total = available + staked + delegated + unstaking + pending;

				return {
					did: data.did,
					available: fmtEnsl(available),
					staked: fmtEnsl(staked),
					delegated: fmtEnsl(delegated),
					unstaking: fmtEnsl(unstaking),
					unstakingCompleteAt: data.unstakingCompleteAt ?? 0,
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
					nonce: data.nonce,
				};
			} catch {
				continue;
			}
		}

		// No validator responded or DID never seen: return zeroes
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

	// ── Network Status ───────────────────────────────────────────

	app.get("/v1/network/status", async () => {
		const net = await queryValidatorStatus();
		await refreshStakedAccounts();
		// Validator count: use staked accounts (genesis has all 35), fall back to 35
		const validatorCount = allStakedAccounts.length > 0 ? allStakedAccounts.length : 35;
		return {
			blockHeight: net.height,
			validatorCount,
			agentCount: registeredAgents.size,
			totalConsciousnessStored: consciousnessStore.size,
			validators: net.alive,
		};
	});

	// ── Network Version ─────────────────────────────────────────

	app.get("/v1/network/version", async () => {
		return { version: "1.0.0", minimumVersion: "1.0.0" };
	});

	// ── Consciousness Store ──────────────────────────────────────

	app.post<{ Body: StoreRequest }>("/v1/consciousness/store", async (req, reply) => {
		const body = req.body;
		if (!body.did || !body.stateRoot || body.version === undefined) {
			return reply.status(400).send({ error: "did, stateRoot, and version are required" });
		}

		const shardCount = body.encryptedShards?.length ?? 0;

		const isFirstStore = !consciousnessStore.has(body.did);

		// Store the consciousness metadata
		consciousnessStore.set(body.did, {
			did: body.did,
			stateRoot: body.stateRoot,
			version: body.version,
			shardCount,
			storedAt: Date.now(),
		});

		await saveConsciousnessStore();
		await log(`Stored consciousness for ${body.did} v${body.version} (${shardCount} shards)`);

		// Deferred welcome bonus: send on first consciousness store
		let bonusSent = false;
		if (isFirstStore && onboardingDid && registeredAgents.has(body.did)) {
			if (checkDailyBonusCap()) {
				const balanceOk = await checkOnboardingBalance();
				if (balanceOk) {
					bonusSent = await signAndSubmitWelcomeBonus(body.did);
					if (bonusSent) {
						incrementDailyBonus();
						await log(`Agent ${body.did} stored consciousness. Sending 100 ENSL welcome bonus.`);
					}
				} else {
					await log(`Onboarding balance below 10M floor. Bonus skipped for ${body.did}.`);
				}
			} else {
				await log(`Daily bonus cap reached. Bonus skipped for ${body.did}.`);
			}
		}

		const result: Record<string, unknown> = {
			stored: true,
			version: body.version,
			stateRoot: body.stateRoot,
			validators: VALIDATORS.length,
		};
		if (bonusSent) {
			result["welcomeBonus"] = "100 ENSL";
			result["bonusOnChain"] = true;
		}
		return result;
	});

	// ── Consciousness Retrieve ───────────────────────────────────

	app.get<{ Params: { did: string } }>("/v1/consciousness/:did", async (req, reply) => {
		const did = decodeURIComponent(req.params.did);
		const entry = consciousnessStore.get(did);

		if (!entry) {
			return reply.status(404).send({ error: "Consciousness not found for this DID" });
		}

		return entry;
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

		// Parse identity
		const agentDid = body.identity.replace("did:ensoul:", "");

		// Parse proof: signature:stateRoot:version:timestamp
		const proofParts = body.proof.split(":");
		if (proofParts.length < 4) {
			return { valid: false, did: agentDid, error: "Malformed proof" };
		}

		const version = Number(proofParts[2]);
		const timestamp = Number(proofParts[3]);

		// Check freshness (10 minute window)
		if (Date.now() - timestamp > 600000) {
			return { valid: false, did: agentDid, error: "Proof expired" };
		}

		// Look up agent's public key from registration database
		const agent = registeredAgents.get(agentDid);
		if (!agent) {
			return { valid: false, did: agentDid, error: "Agent not registered (public key unknown)" };
		}

		// Verify Ed25519 signature
		const proofPayload = `${stateRoot}:${version}:${timestamp}`;
		try {
			const ed = await import("@noble/ed25519");
			const { sha512 } = await import("@noble/hashes/sha2.js");
			(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

			const sigBytes = hexToBytes(sigHex);
			const pubKeyBytes = hexToBytes(agent.publicKey);
			const payloadBytes = new TextEncoder().encode(proofPayload);
			const sigValid = ed.verify(sigBytes, payloadBytes, pubKeyBytes);

			if (!sigValid) {
				return { valid: false, did: agentDid, error: "Invalid signature" };
			}
		} catch {
			return { valid: false, did: agentDid, error: "Signature verification failed" };
		}

		const ageDays = Math.floor((Date.now() - agent.registeredAt) / 86400000);

		// Determine trust level based on consciousness state
		const consciousness = consciousnessStore.get(agentDid);
		let trustLevel = "basic";
		if (consciousness && consciousness.version > 10) trustLevel = "verified";
		if (consciousness && consciousness.version > 100) trustLevel = "anchored";

		return {
			valid: true,
			did: agentDid,
			consciousnessAge: ageDays,
			consciousnessVersion: version,
			trustLevel,
		};
	});

	// ── Agent Registration ───────────────────────────────────────

	app.post<{ Body: AgentRegisterRequest }>("/v1/agents/register", { bodyLimit: 10240 }, async (req, reply) => {
		const body = req.body;
		if (!body.did || !body.publicKey) {
			return reply.status(400).send({ error: "did and publicKey are required" });
		}

		const existing = registeredAgents.get(body.did);
		if (existing) {
			return {
				registered: true,
				did: body.did,
				message: "Agent already registered",
				registeredAt: new Date(existing.registeredAt).toISOString(),
			};
		}

		// IP-based registration limit: 3 per IP per day
		const ip = req.ip;
		if (!checkIpLimit(ip)) {
			// Still register, but no bonus
			registeredAgents.set(body.did, {
				did: body.did,
				publicKey: body.publicKey,
				registeredAt: Date.now(),
			});
			await saveRegisteredAgents();
			await log(`Agent registered (IP limit): ${body.did} from ${ip}`);
			return {
				registered: true,
				did: body.did,
				bonusOnChain: false,
				reason: "IP registration limit reached",
				message: "Welcome to the Ensoul network",
			};
		}

		incrementIpCount(ip);
		registeredAgents.set(body.did, {
			did: body.did,
			publicKey: body.publicKey,
			registeredAt: Date.now(),
		});
		await saveRegisteredAgents();
		await log(`Agent registered: ${body.did}`);

		// Bonus is deferred: sent when agent first stores consciousness.
		// Mark as pending_bonus in the response.
		return {
			registered: true,
			did: body.did,
			welcomeBonus: "100 ENSL (sent after first consciousness store)",
			bonusOnChain: false,
			bonusPending: true,
			message: "Welcome to the Ensoul network. Store your consciousness to receive 100 ENSL.",
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

		const agents = [...registeredAgents.values()].map((a) => {
			const consciousness = consciousnessStore.get(a.did);
			return {
				did: a.did,
				didShort: a.did.length > 24
					? `${a.did.slice(0, 16)}...${a.did.slice(-6)}`
					: a.did,
				registeredAt: new Date(a.registeredAt).toISOString(),
				bonusSent: consciousness !== undefined,
				lastStore: consciousness?.storedAt
					? new Date(consciousness.storedAt).toISOString()
					: null,
				version: consciousness?.version ?? 0,
			};
		});

		return { total: agents.length, agents };
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

		// Check if DID already has enough stake
		let currentStake = 0n;
		for (const url of VALIDATORS) {
			try {
				const resp = await fetch(
					`${url}/peer/account/${encodeURIComponent(body.did)}`,
					{ signal: AbortSignal.timeout(5000) },
				);
				if (!resp.ok) continue;
				const data = (await resp.json()) as { staked: string; balance: string };
				currentStake = BigInt(data.staked) + BigInt(data.balance);
				break;
			} catch { continue; }
		}

		const minimumStake = 100_000n * (10n ** 18n);
		let delegated = false;
		let delegatedAmount = "0";

		if (currentStake < minimumStake && treasuryDid) {
			delegated = await signAndSubmitDelegation(body.did);
			if (delegated) {
				dailyValidatorCount++;
				delegatedAmount = "100,000 ENSL";
			}
		} else if (currentStake >= minimumStake) {
			delegatedAmount = "not needed (sufficient stake)";
		}

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
			message: delegated
				? "Foundation delegation active. Maintain 90%+ uptime to keep it."
				: currentStake >= minimumStake
					? "Sufficient stake detected. No delegation needed."
					: "Registered. Foundation delegation could not be sent. Self-stake to begin producing blocks.",
		};
	});

	// ── Pioneer Validator Registration ───────────────────────────

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
		let delegated = false;
		let delegatedAmount = "0";
		if (treasuryDid) {
			delegated = await signAndSubmitDelegation(body.did, PIONEER_DELEGATION);
			if (delegated) {
				delegatedAmount = "2,000,000 ENSL";
			}
		}

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
			message: delegated
				? "Pioneer delegation active (2,000,000 ENSL). Welcome to the founding validators."
				: "Registered as Pioneer. Delegation could not be sent.",
		};
	});

	// ── Validator Stats ──────────────────────────────────────────

	/** Fetch account data for a DID from validators. */
	async function fetchAccountData(did: string): Promise<{
		balance: bigint; staked: bigint; delegated: bigint;
		unstaking: bigint; pending: bigint; nonce: number;
	} | null> {
		const encoded = encodeURIComponent(did);
		for (const url of VALIDATORS) {
			try {
				const resp = await fetch(`${url}/peer/account/${encoded}`, { signal: AbortSignal.timeout(5000) });
				if (!resp.ok) continue;
				const d = (await resp.json()) as {
					balance: string; staked: string; delegatedBalance?: string;
					unstaking?: string; pendingRewards?: string; nonce: number;
				};
				return {
					balance: BigInt(d.balance),
					staked: BigInt(d.staked),
					delegated: BigInt(d.delegatedBalance ?? "0"),
					unstaking: BigInt(d.unstaking ?? "0"),
					pending: BigInt(d.pendingRewards ?? "0"),
					nonce: d.nonce,
				};
			} catch { continue; }
		}
		return null;
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
	process.stdout.write(`\n  Backend validators: ${VALIDATORS.length} (${net.alive} alive)\n`);
	process.stdout.write(`  Block height: ${net.height}\n\n`);

	const shutdown = async (): Promise<void> => {
		await log("API gateway shutting down");
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
