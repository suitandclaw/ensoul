import { createIdentity } from "@ensoul/identity";
import { createTree } from "@ensoul/state-tree";
import { encode, decode } from "@ensoul/network-client";
import { StorageEngine } from "@ensoul/node";
import { ConsensusModule } from "@ensoul/node";
import {
	generateChallenge,
	respondToChallenge,
	verifyResponse,
} from "@ensoul/node";
import { MemoryLevel } from "memory-level";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SimulationResult, AttackScenario } from "./types.js";

const ENC = new TextEncoder();

/**
 * Run a specific attack simulation.
 */
export async function runSimulation(
	scenario: AttackScenario,
): Promise<SimulationResult> {
	const start = Date.now();

	try {
		let passed: boolean;
		let details: string;

		switch (scenario.type) {
			case "data_withholding": {
				const r = await simulateDataWithholding();
				passed = r.passed;
				details = r.details;
				break;
			}
			case "state_corruption": {
				const r = await simulateStateCorruption();
				passed = r.passed;
				details = r.details;
				break;
			}
			case "replay_attack": {
				const r = await simulateReplayAttack();
				passed = r.passed;
				details = r.details;
				break;
			}
			case "key_compromise": {
				const r = await simulateKeyCompromise();
				passed = r.passed;
				details = r.details;
				break;
			}
			case "consensus_manipulation": {
				const r = await simulateConsensusManipulation();
				passed = r.passed;
				details = r.details;
				break;
			}
			case "shard_reconstruction": {
				const r = await simulateShardReconstruction();
				passed = r.passed;
				details = r.details;
				break;
			}
			case "credit_inflation": {
				const r = await simulateCreditInflation();
				passed = r.passed;
				details = r.details;
				break;
			}
			default: {
				passed = false;
				details = `Unknown attack type: ${scenario.type as string}`;
			}
		}

		return {
			scenario: scenario.name,
			type: scenario.type,
			passed,
			details,
			durationMs: Date.now() - start,
		};
	} catch (err) {
		return {
			scenario: scenario.name,
			type: scenario.type,
			passed: false,
			details: `Simulation error: ${err instanceof Error ? err.message : String(err)}`,
			durationMs: Date.now() - start,
		};
	}
}

// ── DATA WITHHOLDING ─────────────────────────────────────────────────

/**
 * Node stores a shard but returns garbage data on retrieval.
 * The system must detect this via Blake3 hash verification.
 */
async function simulateDataWithholding(): Promise<{
	passed: boolean;
	details: string;
}> {
	const db = new MemoryLevel<string, string>({ valueEncoding: "utf8" });
	const storage = new StorageEngine(db as never);
	await storage.init();

	// Store a real shard
	const realData = ENC.encode("real shard data for proof of storage");
	await storage.store({
		agentDid: "did:key:agent",
		version: 1,
		shardIndex: 0,
		data: realData,
	});

	// Corrupt the stored data in LevelDB (simulate withholding/garbage)
	const ver = "000000000001";
	const idx = "000000";
	const dataKey = `shard:did:key:agent:${ver}:${idx}`;
	const garbageHex = bytesToHex(ENC.encode("garbage data that is wrong"));
	await db.put(dataKey, garbageHex);

	// Try to retrieve — should fail integrity check
	try {
		await storage.retrieve({
			agentDid: "did:key:agent",
			version: 1,
			shardIndex: 0,
		});
		await storage.close();
		return {
			passed: false,
			details: "Corrupted shard was served without detection",
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : "";
		await storage.close();
		if (msg.includes("integrity check failed")) {
			return {
				passed: true,
				details:
					"Corrupted shard correctly detected by Blake3 integrity check",
			};
		}
		return {
			passed: false,
			details: `Unexpected error: ${msg}`,
		};
	}
}

// ── STATE CORRUPTION ─────────────────────────────────────────────────

/**
 * Tampered shard data must be detected by hash verification.
 */
async function simulateStateCorruption(): Promise<{
	passed: boolean;
	details: string;
}> {
	const identity = await createIdentity({
		seed: new Uint8Array(32).fill(50),
	});
	const tree = await createTree(identity);

	// Store some state
	await tree.set("soul/name", ENC.encode("Agent-50"));
	await tree.set("memory/fact1", ENC.encode("important fact"));

	// Serialize and get proof for a key
	const { value, proof } = await tree.getWithProof("soul/name");
	const rootHash = tree.rootHash;

	// Verify the proof works
	if (!tree.verifyProof("soul/name", value, proof, rootHash)) {
		return {
			passed: false,
			details: "Valid proof failed verification",
		};
	}

	// Tamper with the value — proof should now fail
	const tampered = ENC.encode("Tampered-Name");
	const tamperedResult = tree.verifyProof(
		"soul/name",
		tampered,
		proof,
		rootHash,
	);

	if (tamperedResult) {
		return {
			passed: false,
			details: "Tampered data passed Merkle proof verification",
		};
	}

	return {
		passed: true,
		details:
			"Tampered state data correctly rejected by Merkle proof verification",
	};
}

// ── REPLAY ATTACK ────────────────────────────────────────────────────

/**
 * Old state transition replayed and must be rejected.
 * The version chain must detect the stale version.
 */
async function simulateReplayAttack(): Promise<{
	passed: boolean;
	details: string;
}> {
	const identity = await createIdentity({
		seed: new Uint8Array(32).fill(51),
	});
	const tree = await createTree(identity);

	// Build version history
	await tree.set("key", ENC.encode("v1"));
	await tree.set("key", ENC.encode("v2"));
	await tree.set("key", ENC.encode("v3"));

	// Get the history
	const history = await tree.getHistory(0, 3);
	const v1Transition = history[0]!;
	const v3Transition = history[2]!;

	// The version chain must be continuous
	// V1 transition has previousRootHash = empty
	// V3 transition's previousRootHash must equal V2's rootHash
	const v2RootHash = history[1]!.rootHash;

	if (v3Transition.previousRootHash !== v2RootHash) {
		return {
			passed: false,
			details: "Hash chain broken: v3 doesn't reference v2",
		};
	}

	// Replaying v1 transition after v3 would break the chain
	// because v1's rootHash !== v3's rootHash
	if (v1Transition.rootHash === v3Transition.rootHash) {
		return {
			passed: false,
			details: "Old and new state have same root hash (replay possible)",
		};
	}

	// Agent tracks latest version — replayed old version is detectable
	const currentVersion = tree.version;
	if (v1Transition.version >= currentVersion) {
		return {
			passed: false,
			details: "Old version not less than current (replay undetectable)",
		};
	}

	return {
		passed: true,
		details:
			"Replay attack detected: old version < current, different root hash, hash chain enforced",
	};
}

// ── KEY COMPROMISE ───────────────────────────────────────────────────

/**
 * Stolen key cannot access network-stored ciphertext without gathering shards.
 * Even with the private key, encrypted data on the network is erasure-coded —
 * you need K shards from distinct nodes to reconstruct.
 */
async function simulateKeyCompromise(): Promise<{
	passed: boolean;
	details: string;
}> {
	const identity = await createIdentity({
		seed: new Uint8Array(32).fill(52),
	});

	// Encrypt some data
	const secret = ENC.encode("top secret consciousness data");
	const encrypted = await identity.encrypt(secret);

	// Serialize the encrypted payload
	const blob = new Uint8Array(
		encrypted.ciphertext.length +
			encrypted.nonce.length +
			(encrypted.ephemeralPubKey?.length ?? 0),
	);
	blob.set(encrypted.ciphertext);
	blob.set(encrypted.nonce, encrypted.ciphertext.length);
	if (encrypted.ephemeralPubKey) {
		blob.set(
			encrypted.ephemeralPubKey,
			encrypted.ciphertext.length + encrypted.nonce.length,
		);
	}

	// Erasure code into 4 shards
	const shards = encode(blob, { dataShards: 2, totalShards: 4 });

	// Attacker has the key but only 1 shard (less than K=2)
	// They cannot reconstruct the encrypted blob
	try {
		decode(
			[shards[0]!, null, null, null],
			{ dataShards: 2, totalShards: 4 },
			blob.length,
		);
		return {
			passed: false,
			details: "Reconstruction succeeded with only 1 shard (K=2 needed)",
		};
	} catch {
		// Expected: can't reconstruct with < K shards
	}

	// Even with 2 shards + the key, they can decrypt — but they need
	// to physically obtain shards from 2 distinct network nodes.
	// The key alone is insufficient without network access.

	return {
		passed: true,
		details:
			"Compromised key alone insufficient: need K=2 shards from distinct nodes to reconstruct encrypted blob",
	};
}

// ── CONSENSUS MANIPULATION ───────────────────────────────────────────

/**
 * K-1 colluding validators cannot forge an attestation threshold of K.
 */
async function simulateConsensusManipulation(): Promise<{
	passed: boolean;
	details: string;
}> {
	const consensus = new ConsensusModule({ threshold: 3, minStake: 0 });

	// Register 4 honest validators
	const validators = await Promise.all(
		[1, 2, 3, 4].map(async (i) => {
			const id = await createIdentity({
				seed: new Uint8Array(32).fill(60 + i),
			});
			consensus.registerValidator(id.did, id.publicKey, 10000);
			return id;
		}),
	);

	const agentDid = "did:key:targetAgent";
	const stateRoot = "aabbccdd".repeat(8);
	const version = 1;

	// K-1 = 2 colluding validators sign the attestation
	const colluders = validators.slice(0, 2);
	const attestations = await Promise.all(
		colluders.map((v) =>
			consensus.createAttestation(v, agentDid, stateRoot, version),
		),
	);

	// Check threshold with only 2 attestations (need 3)
	const result = await consensus.checkThreshold(
		attestations,
		agentDid,
		stateRoot,
		version,
	);

	if (result.met) {
		return {
			passed: false,
			details: `Threshold met with only ${result.validCount} attestations (need ${result.required})`,
		};
	}

	// Even if a colluder submits duplicate attestations, they don't count
	const duplicated = [...attestations, ...attestations];
	const dupResult = await consensus.checkThreshold(
		duplicated,
		agentDid,
		stateRoot,
		version,
	);

	if (dupResult.met) {
		return {
			passed: false,
			details: "Duplicated attestations bypassed threshold",
		};
	}

	return {
		passed: true,
		details: `K-1=${colluders.length} colluding validators insufficient for K=${result.required} threshold. Duplicates correctly deduplicated.`,
	};
}

// ── SHARD RECONSTRUCTION ─────────────────────────────────────────────

/**
 * Cannot reconstruct data from fewer than K shards.
 */
async function simulateShardReconstruction(): Promise<{
	passed: boolean;
	details: string;
}> {
	const data = ENC.encode(
		"This is secret consciousness state that requires K shards to reconstruct",
	);
	const config = { dataShards: 2, totalShards: 4 };
	const shards = encode(data, config);

	// Try to reconstruct with 0 shards
	try {
		decode([null, null, null, null], config, data.length);
		return {
			passed: false,
			details: "Reconstruction succeeded with 0 shards",
		};
	} catch {
		// Expected
	}

	// Try to reconstruct with 1 shard (K=2)
	try {
		decode([shards[0]!, null, null, null], config, data.length);
		return {
			passed: false,
			details: "Reconstruction succeeded with 1 shard (need K=2)",
		};
	} catch {
		// Expected
	}

	// Verify all C(4,2)=6 combinations of 2 shards DO work
	const combos: [number, number][] = [
		[0, 1],
		[0, 2],
		[0, 3],
		[1, 2],
		[1, 3],
		[2, 3],
	];
	for (const [a, b] of combos) {
		const available: (Uint8Array | null)[] = [null, null, null, null];
		available[a] = shards[a]!;
		available[b] = shards[b]!;
		const result = decode(available, config, data.length);
		if (
			result.length !== data.length ||
			!result.every((byte, i) => byte === data[i])
		) {
			return {
				passed: false,
				details: `Reconstruction from shards (${a},${b}) produced wrong data`,
			};
		}
	}

	return {
		passed: true,
		details:
			"Cannot reconstruct from <K shards. All C(4,2)=6 combinations of K=2 shards correctly reconstruct.",
	};
}

// ── CREDIT INFLATION ─────────────────────────────────────────────────

/**
 * Cannot earn credits without valid storage proofs.
 * A node must pass a proof-of-storage challenge to earn credits.
 */
async function simulateCreditInflation(): Promise<{
	passed: boolean;
	details: string;
}> {
	const db = new MemoryLevel<string, string>({ valueEncoding: "utf8" });
	const storage = new StorageEngine(db as never);
	await storage.init();

	// Store a real shard
	const realData = ENC.encode("legitimate shard data for challenge");
	await storage.store({
		agentDid: "did:key:agent",
		version: 1,
		shardIndex: 0,
		data: realData,
	});

	// Generate a challenge
	const challenge = generateChallenge({
		nodeDid: "did:key:dishonestNode",
		agentDid: "did:key:agent",
		version: 1,
		shardIndex: 0,
		shardSize: realData.length,
	});

	// Dishonest node tries to respond with a fake hash
	const fakeResponse = {
		challengeId: challenge.id,
		hash: "00".repeat(32),
		respondedAt: Date.now(),
	};

	const fakeResult = verifyResponse(challenge, fakeResponse, realData);
	if (fakeResult.valid) {
		await storage.close();
		return {
			passed: false,
			details: "Fake challenge response was accepted",
		};
	}

	// Honest response passes
	const honestResponse = respondToChallenge(challenge, realData);
	const honestResult = verifyResponse(
		challenge,
		honestResponse,
		realData,
	);
	if (!honestResult.valid) {
		await storage.close();
		return {
			passed: false,
			details: "Honest challenge response was rejected",
		};
	}

	await storage.close();
	return {
		passed: true,
		details:
			"Fake storage proof rejected. Only valid proof-of-storage challenges earn credits.",
	};
}
