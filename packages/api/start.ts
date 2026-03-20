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
// In-memory consciousness store (indexed by DID)
const consciousnessStore = new Map<string, {
	did: string;
	stateRoot: string;
	version: number;
	shardCount: number;
	storedAt: number;
}>();

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
	await loadRegisteredAgents();
	await loadOnboardingKey();

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
		return {
			blockHeight: net.height,
			validatorCount: net.validatorCount,
			agentCount: registeredAgents.size,
			totalConsciousnessStored: consciousnessStore.size,
			validators: net.alive,
		};
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
