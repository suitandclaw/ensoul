import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { MemoryLevel } from "memory-level";
import { createIdentity } from "@ensoul/identity";
import { StorageEngine } from "../src/storage/index.js";
import { ConsensusModule } from "../src/consensus/index.js";
import { generateChallenge, respondToChallenge } from "../src/challenge/index.js";
import type { Challenge } from "../src/challenge/index.js";
import { createApiServer } from "../src/api/index.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const AGENT_DID = "did:key:z6MkTestAgent";
const VALIDATOR_DID = "did:key:z6MkTestValidator";

let app: FastifyInstance;
let storage: StorageEngine;
let consensus: ConsensusModule;

function shardHex(size: number, fill = 0xab): string {
	const arr = new Uint8Array(size);
	arr.fill(fill);
	return bytesToHex(arr);
}

beforeEach(async () => {
	const db = new MemoryLevel<string, string>({ valueEncoding: "utf8" });
	storage = new StorageEngine(db);
	await storage.init();

	consensus = new ConsensusModule({ threshold: 1, minStake: 0 });
	const validatorId = await createIdentity({
		seed: new Uint8Array(32).fill(99),
	});
	consensus.registerValidator(
		VALIDATOR_DID,
		validatorId.publicKey,
		10000,
	);

	app = await createApiServer(storage, consensus, {
		rateLimit: 1000,
	});
});

afterEach(async () => {
	await app.close();
	await storage.close();
});

describe("API Server", () => {
	// ── POST /shards/store ───────────────────────────────────────

	describe("POST /shards/store", () => {
		it("stores a shard and returns metadata", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: {
					agentDid: AGENT_DID,
					version: 1,
					shardIndex: 0,
					data: shardHex(256),
				},
			});

			expect(response.statusCode).toBe(201);
			const body = response.json();
			expect(body.status).toBe("stored");
			expect(body.hash).toBeTruthy();
			expect(body.size).toBe(256);
		});

		it("stores shard with TTL", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: {
					agentDid: AGENT_DID,
					version: 1,
					shardIndex: 0,
					data: shardHex(100),
					ttlMs: 60000,
				},
			});

			expect(response.statusCode).toBe(201);
		});

		it("rejects missing fields", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: { agentDid: AGENT_DID },
			});

			expect(response.statusCode).toBe(400);
		});

		it("rejects empty shard data", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: {
					agentDid: AGENT_DID,
					version: 1,
					shardIndex: 0,
					data: "",
				},
			});

			expect(response.statusCode).toBe(400);
		});
	});

	// ── GET /shards/:agentDid/:version/:shardIndex ───────────────

	describe("GET /shards/:agentDid/:version/:shardIndex", () => {
		it("retrieves a stored shard", async () => {
			const hexData = shardHex(128);
			await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: {
					agentDid: AGENT_DID,
					version: 1,
					shardIndex: 0,
					data: hexData,
				},
			});

			const response = await app.inject({
				method: "GET",
				url: `/shards/${AGENT_DID}/1/0`,
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.data).toBe(hexData);
			expect(body.agentDid).toBe(AGENT_DID);
			expect(body.version).toBe(1);
			expect(body.shardIndex).toBe(0);
		});

		it("returns 404 for non-existent shard", async () => {
			const response = await app.inject({
				method: "GET",
				url: `/shards/${AGENT_DID}/99/0`,
			});

			expect(response.statusCode).toBe(404);
		});

		it("returns 400 for invalid version", async () => {
			const response = await app.inject({
				method: "GET",
				url: `/shards/${AGENT_DID}/abc/0`,
			});

			expect(response.statusCode).toBe(400);
		});
	});

	// ── POST /attestations ───────────────────────────────────────

	describe("POST /attestations", () => {
		it("accepts attestation from registered validator", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/attestations",
				payload: {
					validatorDid: VALIDATOR_DID,
					agentDid: AGENT_DID,
					stateRoot: "abc123",
					version: 1,
					signature: "ff".repeat(64),
					timestamp: Date.now(),
				},
			});

			expect(response.statusCode).toBe(201);
			const body = response.json();
			expect(body.status).toBe("accepted");
			expect(body.attestationCount).toBe(1);
		});

		it("rejects attestation from unknown validator", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/attestations",
				payload: {
					validatorDid: "did:key:unknown",
					agentDid: AGENT_DID,
					stateRoot: "abc123",
					version: 1,
					signature: "ff".repeat(64),
					timestamp: Date.now(),
				},
			});

			expect(response.statusCode).toBe(403);
		});

		it("rejects missing fields", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/attestations",
				payload: { validatorDid: VALIDATOR_DID },
			});

			expect(response.statusCode).toBe(400);
		});

		it("accumulates multiple attestations", async () => {
			for (let i = 0; i < 3; i++) {
				await app.inject({
					method: "POST",
					url: "/attestations",
					payload: {
						validatorDid: VALIDATOR_DID,
						agentDid: AGENT_DID,
						stateRoot: "root",
						version: 1,
						signature: `${"ff".repeat(63)}0${i}`,
						timestamp: Date.now(),
					},
				});
			}

			const response = await app.inject({
				method: "GET",
				url: `/attestations/${AGENT_DID}/1`,
			});

			const body = response.json();
			expect(body.count).toBe(3);
		});
	});

	// ── GET /attestations/:agentDid/:version ─────────────────────

	describe("GET /attestations/:agentDid/:version", () => {
		it("returns attestations for stored state", async () => {
			await app.inject({
				method: "POST",
				url: "/attestations",
				payload: {
					validatorDid: VALIDATOR_DID,
					agentDid: AGENT_DID,
					stateRoot: "root-v5",
					version: 5,
					signature: "aa".repeat(64),
					timestamp: Date.now(),
				},
			});

			const response = await app.inject({
				method: "GET",
				url: `/attestations/${AGENT_DID}/5`,
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.attestations.length).toBe(1);
			expect(body.attestations[0].validatorDid).toBe(VALIDATOR_DID);
		});

		it("returns empty array for no attestations", async () => {
			const response = await app.inject({
				method: "GET",
				url: `/attestations/${AGENT_DID}/99`,
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.count).toBe(0);
			expect(body.attestations).toEqual([]);
		});
	});

	// ── POST /challenges/respond ─────────────────────────────────

	describe("POST /challenges/respond", () => {
		it("accepts valid challenge response", async () => {
			// Store a shard first
			const shardData = new Uint8Array(256);
			for (let i = 0; i < 256; i++) shardData[i] = i;

			await storage.store({
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				data: shardData,
			});

			// Generate and register a challenge
			const challenge = generateChallenge({
				nodeDid: "did:key:nodeA",
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				shardSize: 256,
			});

			// Register the challenge via the decorated method
			const registerFn = (app as unknown as Record<string, (c: Challenge) => void>)
				["registerChallenge"];
			registerFn(challenge);

			// Compute correct response
			const correctResponse = respondToChallenge(
				challenge,
				shardData,
			);

			const response = await app.inject({
				method: "POST",
				url: "/challenges/respond",
				payload: {
					challengeId: challenge.id,
					hash: correctResponse.hash,
				},
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.status).toBe("passed");
			expect(body.creditsEarned).toBe(1);
		});

		it("rejects invalid hash", async () => {
			const shardData = new Uint8Array(100);
			shardData.fill(0xab);

			await storage.store({
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				data: shardData,
			});

			const challenge = generateChallenge({
				nodeDid: "did:key:nodeA",
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				shardSize: 100,
			});

			const registerFn = (app as unknown as Record<string, (c: Challenge) => void>)
				["registerChallenge"];
			registerFn(challenge);

			const response = await app.inject({
				method: "POST",
				url: "/challenges/respond",
				payload: {
					challengeId: challenge.id,
					hash: "00".repeat(32),
				},
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.status).toBe("failed");
			expect(body.reason).toContain("Hash mismatch");
		});

		it("returns 404 for unknown challenge", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/challenges/respond",
				payload: {
					challengeId: "nonexistent",
					hash: "ab".repeat(32),
				},
			});

			expect(response.statusCode).toBe(404);
		});

		it("rejects missing fields", async () => {
			const response = await app.inject({
				method: "POST",
				url: "/challenges/respond",
				payload: {},
			});

			expect(response.statusCode).toBe(400);
		});
	});

	// ── GET /status ──────────────────────────────────────────────

	describe("GET /status", () => {
		it("returns node health status", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/status",
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.status).toBe("ok");
			expect(body.storage).toBeDefined();
			expect(body.storage.totalBytes).toBe(0);
			expect(body.storage.totalShards).toBe(0);
			expect(body.validators).toBe(1);
		});

		it("reflects stored shards in status", async () => {
			await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: {
					agentDid: AGENT_DID,
					version: 1,
					shardIndex: 0,
					data: shardHex(500),
				},
			});

			const response = await app.inject({
				method: "GET",
				url: "/status",
			});

			const body = response.json();
			expect(body.storage.totalShards).toBe(1);
			expect(body.storage.totalBytes).toBe(500);
			expect(body.storage.agentCount).toBe(1);
		});
	});

	// ── GET /credits/:did ────────────────────────────────────────

	describe("GET /credits/:did", () => {
		it("returns zero for unknown DID", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/credits/did:key:unknown",
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.did).toBe("did:key:unknown");
			expect(body.balance).toBe(0);
		});

		it("credits increase after passing challenge", async () => {
			const nodeDid = "did:key:nodeEarner";
			const shardData = new Uint8Array(100);
			shardData.fill(0xab);

			await storage.store({
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				data: shardData,
			});

			const challenge = generateChallenge({
				nodeDid,
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				shardSize: 100,
			});

			const registerFn = (app as unknown as Record<string, (c: Challenge) => void>)
				["registerChallenge"];
			registerFn(challenge);

			const correctResponse = respondToChallenge(
				challenge,
				shardData,
			);

			await app.inject({
				method: "POST",
				url: "/challenges/respond",
				payload: {
					challengeId: challenge.id,
					hash: correctResponse.hash,
				},
			});

			const response = await app.inject({
				method: "GET",
				url: `/credits/${nodeDid}`,
			});

			const body = response.json();
			expect(body.balance).toBe(1);
		});
	});

	// ── Full workflow ────────────────────────────────────────────

	describe("full workflow", () => {
		it("store shard → attest → challenge → earn credits", async () => {
			// 1. Store shard
			const hexData = shardHex(512);
			const storeRes = await app.inject({
				method: "POST",
				url: "/shards/store",
				payload: {
					agentDid: AGENT_DID,
					version: 1,
					shardIndex: 0,
					data: hexData,
				},
			});
			expect(storeRes.statusCode).toBe(201);

			// 2. Submit attestation
			const attestRes = await app.inject({
				method: "POST",
				url: "/attestations",
				payload: {
					validatorDid: VALIDATOR_DID,
					agentDid: AGENT_DID,
					stateRoot: "full-workflow-root",
					version: 1,
					signature: "cc".repeat(64),
					timestamp: Date.now(),
				},
			});
			expect(attestRes.statusCode).toBe(201);

			// 3. Verify attestation exists
			const getAttRes = await app.inject({
				method: "GET",
				url: `/attestations/${AGENT_DID}/1`,
			});
			expect(getAttRes.json().count).toBe(1);

			// 4. Retrieve shard
			const getShardRes = await app.inject({
				method: "GET",
				url: `/shards/${AGENT_DID}/1/0`,
			});
			expect(getShardRes.statusCode).toBe(200);
			expect(getShardRes.json().data).toBe(hexData);

			// 5. Challenge and respond
			const shardBytes = new Uint8Array(512);
			shardBytes.fill(0xab);

			const challenge = generateChallenge({
				nodeDid: "did:key:fullWorkflowNode",
				agentDid: AGENT_DID,
				version: 1,
				shardIndex: 0,
				shardSize: 512,
			});

			const registerFn = (app as unknown as Record<string, (c: Challenge) => void>)
				["registerChallenge"];
			registerFn(challenge);

			const correctHash = respondToChallenge(
				challenge,
				shardBytes,
			);

			const challengeRes = await app.inject({
				method: "POST",
				url: "/challenges/respond",
				payload: {
					challengeId: challenge.id,
					hash: correctHash.hash,
				},
			});
			expect(challengeRes.json().status).toBe("passed");

			// 6. Check credits earned
			const creditsRes = await app.inject({
				method: "GET",
				url: "/credits/did:key:fullWorkflowNode",
			});
			expect(creditsRes.json().balance).toBe(1);

			// 7. Status reflects everything
			const statusRes = await app.inject({
				method: "GET",
				url: "/status",
			});
			expect(statusRes.json().storage.totalShards).toBe(1);
		});
	});
});
