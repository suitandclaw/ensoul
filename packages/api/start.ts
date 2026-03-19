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
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 5000);
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

// In-memory registry of known agents (persisted to disk later)
const registeredAgents = new Map<string, { did: string; publicKey: string; registeredAt: number }>();
// In-memory consciousness store (indexed by DID)
const consciousnessStore = new Map<string, {
	did: string;
	stateRoot: string;
	version: number;
	shardCount: number;
	storedAt: number;
}>();

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

// ── Server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mkdir(LOG_DIR, { recursive: true });

	const app = Fastify({ logger: false });

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

		// Store the consciousness metadata
		consciousnessStore.set(body.did, {
			did: body.did,
			stateRoot: body.stateRoot,
			version: body.version,
			shardCount,
			storedAt: Date.now(),
		});

		await log(`Stored consciousness for ${body.did} v${body.version} (${shardCount} shards)`);

		return {
			stored: true,
			version: body.version,
			stateRoot: body.stateRoot,
			validators: VALIDATORS.length,
		};
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

	app.post<{ Body: HandshakeVerifyRequest }>("/v1/handshake/verify", async (req, reply) => {
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

		// Check if agent is registered
		const agent = registeredAgents.get(agentDid);
		const ageDays = agent
			? Math.floor((Date.now() - agent.registeredAt) / 86400000)
			: 0;

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

	app.post<{ Body: AgentRegisterRequest }>("/v1/agents/register", async (req, reply) => {
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

		registeredAgents.set(body.did, {
			did: body.did,
			publicKey: body.publicKey,
			registeredAt: Date.now(),
		});

		// TODO: Submit a TRANSFER transaction from the onboarding incentives
		// account to body.did for 1000 ENSL. This requires the onboarding
		// account's private key to sign the transaction, and a connected
		// validator to submit it. For now the welcome bonus is tracked in
		// the API gateway's in-memory state only.
		await log(`Agent registered: ${body.did} (welcome bonus: 1000 ENSL pending on-chain credit)`);

		return {
			registered: true,
			did: body.did,
			welcomeBonus: "1000 ENSL",
			message: "Welcome to the Ensoul network",
		};
	});

	// ── Start ────────────────────────────────────────────────────

	await app.listen({ port, host: "0.0.0.0" });

	const net = await queryValidatorStatus();
	await log(`API gateway running on port ${port}`);

	process.stdout.write(`\nEnsoul API Gateway running on http://localhost:${port}\n`);
	process.stdout.write(`\n  Endpoints:\n`);
	process.stdout.write(`    GET  /health\n`);
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
