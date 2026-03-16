import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { StorageEngine } from "../storage/index.js";
import type { ConsensusModule } from "../consensus/index.js";
import { verifyResponse } from "../challenge/index.js";
import type { Challenge, ChallengeResponse } from "../challenge/index.js";
import type { ApiServerConfig } from "./types.js";

const DEFAULT_CONFIG: ApiServerConfig = {
	port: 3000,
	host: "127.0.0.1",
	rateLimit: 100,
};

/** In-memory attestation store keyed by "agentDid:version" */
type AttestationEntry = {
	validatorDid: string;
	signature: string;
	timestamp: number;
};

/** In-memory credit ledger. */
type CreditLedger = Map<string, number>;

/** Pending challenges keyed by challenge ID. */
type PendingChallenges = Map<string, Challenge>;

/**
 * Create and configure the Fastify API server.
 * Wires together storage engine, consensus module, and challenge module.
 */
export async function createApiServer(
	storage: StorageEngine,
	consensus: ConsensusModule,
	config?: Partial<ApiServerConfig>,
): Promise<FastifyInstance> {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	const app = Fastify({ logger: false });

	// Rate limiting
	await app.register(rateLimit, {
		max: cfg.rateLimit,
		timeWindow: 60_000,
	});

	// State
	const attestationStore = new Map<string, AttestationEntry[]>();
	const credits: CreditLedger = new Map();
	const pendingChallenges: PendingChallenges = new Map();

	// ── POST /shards/store ───────────────────────────────────────

	app.post<{
		Body: {
			agentDid: string;
			version: number;
			shardIndex: number;
			data: string; // hex-encoded shard data
			ttlMs?: number;
		};
	}>("/shards/store", async (request, reply) => {
		const { agentDid, version, shardIndex, data, ttlMs } =
			request.body;

		if (!agentDid || version === undefined || shardIndex === undefined || !data) {
			return reply
				.status(400)
				.send({ error: "Missing required fields" });
		}

		const dataBytes = hexToBytes(data);

		try {
			const storeReq: import("../storage/index.js").StoreShardRequest = {
				agentDid,
				version,
				shardIndex,
				data: dataBytes,
			};
			if (ttlMs !== undefined) {
				storeReq.ttlMs = ttlMs;
			}
			const metadata = await storage.store(storeReq);

			// Award credits for storage
			const current = credits.get(agentDid) ?? 0;
			credits.set(agentDid, current);

			return reply.status(201).send({
				status: "stored",
				hash: metadata.hash,
				size: metadata.size,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Store failed";
			return reply.status(400).send({ error: msg });
		}
	});

	// ── GET /shards/:agentDid/:version/:shardIndex ───────────────

	app.get<{
		Params: {
			agentDid: string;
			version: string;
			shardIndex: string;
		};
	}>("/shards/:agentDid/:version/:shardIndex", async (request, reply) => {
		const { agentDid } = request.params;
		const version = Number(request.params.version);
		const shardIndex = Number(request.params.shardIndex);

		if (Number.isNaN(version) || Number.isNaN(shardIndex)) {
			return reply
				.status(400)
				.send({ error: "Invalid version or shardIndex" });
		}

		try {
			const shard = await storage.retrieve({
				agentDid,
				version,
				shardIndex,
			});
			return reply.status(200).send({
				agentDid,
				version,
				shardIndex,
				data: bytesToHex(shard.data),
				hash: shard.metadata.hash,
				size: shard.metadata.size,
			});
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Retrieve failed";
			if (msg.includes("not found") || msg.includes("expired")) {
				return reply.status(404).send({ error: msg });
			}
			return reply.status(500).send({ error: msg });
		}
	});

	// ── POST /attestations ───────────────────────────────────────

	app.post<{
		Body: {
			validatorDid: string;
			agentDid: string;
			stateRoot: string;
			version: number;
			signature: string; // hex
			timestamp: number;
		};
	}>("/attestations", async (request, reply) => {
		const { validatorDid, agentDid, stateRoot, version, signature, timestamp } =
			request.body;

		if (!validatorDid || !agentDid || !stateRoot || version === undefined || !signature) {
			return reply
				.status(400)
				.send({ error: "Missing required fields" });
		}

		// Verify the validator is registered
		if (!consensus.isValidator(validatorDid)) {
			return reply
				.status(403)
				.send({ error: "Unknown validator" });
		}

		const key = `${agentDid}:${version}`;
		const existing = attestationStore.get(key) ?? [];
		existing.push({
			validatorDid,
			signature,
			timestamp: timestamp ?? Date.now(),
		});
		attestationStore.set(key, existing);

		return reply.status(201).send({
			status: "accepted",
			attestationCount: existing.length,
		});
	});

	// ── GET /attestations/:agentDid/:version ─────────────────────

	app.get<{
		Params: { agentDid: string; version: string };
	}>("/attestations/:agentDid/:version", async (request, reply) => {
		const { agentDid } = request.params;
		const version = Number(request.params.version);

		if (Number.isNaN(version)) {
			return reply.status(400).send({ error: "Invalid version" });
		}

		const key = `${agentDid}:${version}`;
		const attestations = attestationStore.get(key) ?? [];

		return reply.status(200).send({
			agentDid,
			version,
			attestations,
			count: attestations.length,
		});
	});

	// ── POST /challenges/respond ─────────────────────────────────

	app.post<{
		Body: {
			challengeId: string;
			hash: string;
		};
	}>("/challenges/respond", async (request, reply) => {
		const { challengeId, hash } = request.body;

		if (!challengeId || !hash) {
			return reply
				.status(400)
				.send({ error: "Missing required fields" });
		}

		const challenge = pendingChallenges.get(challengeId);
		if (!challenge) {
			return reply
				.status(404)
				.send({ error: "Challenge not found or expired" });
		}

		const response: ChallengeResponse = {
			challengeId,
			hash,
			respondedAt: Date.now(),
		};

		// Get the shard to verify against
		try {
			const shard = await storage.retrieve({
				agentDid: challenge.agentDid,
				version: challenge.version,
				shardIndex: challenge.shardIndex,
			});

			const result = verifyResponse(challenge, response, shard.data);
			pendingChallenges.delete(challengeId);

			if (result.valid) {
				// Award credits for passing
				const nodeDid = challenge.nodeDid;
				const current = credits.get(nodeDid) ?? 0;
				credits.set(nodeDid, current + 1);

				return reply.status(200).send({
					status: "passed",
					creditsEarned: 1,
				});
			}
			return reply.status(200).send({
				status: "failed",
				reason: result.reason,
			});
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Verification failed";
			return reply.status(500).send({ error: msg });
		}
	});

	// ── GET /status ──────────────────────────────────────────────

	app.get("/status", async (_request, reply) => {
		const stats = storage.getStats();
		return reply.status(200).send({
			status: "ok",
			storage: {
				totalBytes: stats.totalBytes,
				totalShards: stats.totalShards,
				agentCount: stats.agentCount,
			},
			validators: consensus.getValidatorCount(),
			pendingChallenges: pendingChallenges.size,
		});
	});

	// ── GET /credits/:did ────────────────────────────────────────

	app.get<{
		Params: { did: string };
	}>("/credits/:did", async (request, reply) => {
		const { did } = request.params;
		const balance = credits.get(did) ?? 0;
		return reply.status(200).send({ did, balance });
	});

	// ── Challenge management (internal, exposed for wiring) ──────

	// Expose challenge registration via decorate
	app.decorate("registerChallenge", (c: Challenge) => {
		pendingChallenges.set(c.id, c);
	});

	return app;
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}
