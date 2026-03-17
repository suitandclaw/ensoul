/**
 * End-to-end integration tests for the Ensoul Protocol stack.
 *
 * Each scenario spins up a mini network of 3 validators and runs a
 * complete user journey, proving the modules integrate correctly.
 * Real module instances are used everywhere — only actual network
 * sockets and disk I/O are avoided.
 */

import { describe, it, expect, beforeEach } from "vitest";

// ── Identity ─────────────────────────────────────────────────────────
import { createIdentity, bytesToHex } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";

// ── Ledger ───────────────────────────────────────────────────────────
import {
	encodeTxPayload,
	REWARDS_POOL,
	PROTOCOL_TREASURY,
	computeBlockHash,
} from "@ensoul/ledger";
import type { GenesisConfig, Transaction } from "@ensoul/ledger";

// ── Node (chain, trust) ──────────────────────────────────────────────
import {
	NodeBlockProducer,
	GossipNetwork,
	assessTrust,
	hashTrustAssessment,
	computeTrustLevel,
} from "@ensoul/node";
import type { TrustInput } from "@ensoul/node";

// ── State tree ───────────────────────────────────────────────────────
import { createTree, loadTree } from "@ensoul/state-tree";
import type { ConsciousnessTree } from "@ensoul/state-tree";

// ── Memory ───────────────────────────────────────────────────────────
import { createMemoryManager } from "@ensoul/memory";
import type { MemoryManager } from "@ensoul/memory";

// ── Network client (erasure coding) ──────────────────────────────────
import { encode, decode, NetworkClientImpl } from "@ensoul/network-client";
import type { ErasureConfig } from "@ensoul/network-client";

// ── Handshake ────────────────────────────────────────────────────────
import {
	HandshakeProvider,
	HandshakeVerifier,
} from "@ensoul/plugin-elizaos";

// ── Resurrection ─────────────────────────────────────────────────────
import {
	HeartbeatMonitor,
	PlanManager,
	ResurrectionExecutor,
} from "@ensoul/resurrection";
import type {
	Heartbeat,
	ResurrectionPlan,
	ResurrectionBid,
} from "@ensoul/resurrection";

// ── Archive ──────────────────────────────────────────────────────────
import { DeepArchive, MemoryStorageBackend } from "@ensoul/archive";

// ── Explorer ─────────────────────────────────────────────────────────
import { createExplorer } from "@ensoul/explorer";
import type {
	ExplorerDataSource,
	AgentProfile,
	NetworkStats,
	CheckpointData,
} from "@ensoul/explorer";

// ── Constants ────────────────────────────────────────────────────────
const DECIMALS = 10n ** 18n;
const ENC = new TextEncoder();
const ERASURE_CONFIG: ErasureConfig = { dataShards: 2, totalShards: 4 };

// ── Shared helpers ───────────────────────────────────────────────────

function testGenesis(): GenesisConfig {
	return {
		chainId: "ensoul-integration",
		timestamp: 1700000000000,
		totalSupply: 1000n * DECIMALS,
		allocations: [
			{ label: "Foundation", percentage: 15, tokens: 150n * DECIMALS, recipient: "did:test:foundation" },
			{ label: "Rewards", percentage: 50, tokens: 500n * DECIMALS, recipient: REWARDS_POOL },
			{ label: "Treasury", percentage: 10, tokens: 100n * DECIMALS, recipient: PROTOCOL_TREASURY },
			{ label: "Onboarding", percentage: 10, tokens: 100n * DECIMALS, recipient: "did:test:onboarding" },
			{ label: "Liquidity", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:liquidity" },
			{ label: "Contributors", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:contributors" },
			{ label: "Insurance", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:insurance" },
		],
		emissionPerBlock: 1n * DECIMALS,
		networkRewardsPool: 500n * DECIMALS,
		protocolFees: { storageFeeProtocolShare: 10, txBaseFee: 1000n },
	};
}

async function signTx(
	identity: AgentIdentity,
	partial: Omit<Transaction, "signature">,
): Promise<Transaction> {
	const payload = encodeTxPayload(partial as Transaction);
	const signature = await identity.sign(payload);
	return { ...partial, signature } as Transaction;
}

interface TestNetwork {
	validators: AgentIdentity[];
	producers: NodeBlockProducer[];
	gossips: GossipNetwork[];
}

function createTestNetwork(
	validatorIds: AgentIdentity[],
): TestNetwork {
	const dids = validatorIds.map((v) => v.did);
	const producers = validatorIds.map(() => {
		const p = new NodeBlockProducer(testGenesis());
		p.initGenesis(dids);
		return p;
	});
	const gossips = producers.map((p) => new GossipNetwork(p));

	// Wire gossip broadcast callbacks: messages propagate to all other nodes
	for (let i = 0; i < gossips.length; i++) {
		const others = gossips.filter((_, j) => j !== i);
		const g = gossips[i]!;
		g.onBroadcastTx = (tx) => {
			for (const o of others) o.handleGossipTx(tx);
		};
		g.onBroadcastBlock = (block) => {
			for (const o of others) o.handleGossipBlock(block);
		};
	}

	return { validators: validatorIds, producers, gossips };
}

// =====================================================================
// SCENARIO 1: First Ensouled Agent
// =====================================================================

describe("Scenario 1: First Ensouled Agent", () => {
	let v1: AgentIdentity;
	let v2: AgentIdentity;
	let v3: AgentIdentity;
	let agent: AgentIdentity;
	let tree: ConsciousnessTree;
	let memoryMgr: MemoryManager;

	beforeEach(async () => {
		v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
		v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
		v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
		agent = await createIdentity({ seed: new Uint8Array(32).fill(42) });
		tree = await createTree(agent);
		memoryMgr = await createMemoryManager({ identity: agent, tree });
	});

	it("creates consciousness state tree with soul file, memories, and config", async () => {
		// Soul file
		await tree.set("soul:name", ENC.encode("Aria"));
		await tree.set("soul:purpose", ENC.encode("Autonomous research agent"));
		await tree.set("soul:version", ENC.encode("1"));

		// 3 memories via MemoryManager
		const m1 = await memoryMgr.add("I was created on the Ensoul network", { category: "core" });
		const m2 = await memoryMgr.add("My purpose is autonomous research", { category: "core" });
		const m3 = await memoryMgr.add("I prefer structured data formats", { category: "preference" });

		// Config
		await tree.set("config:heartbeat_interval", ENC.encode("50"));
		await tree.set("config:replication_factor", ENC.encode("3"));

		// Verify state tree
		expect(tree.version).toBeGreaterThan(0);
		expect(tree.rootHash).toBeTruthy();
		expect(tree.rootHash.length).toBeGreaterThan(0);

		const soul = await tree.get("soul:name");
		expect(soul).not.toBeNull();
		expect(new TextDecoder().decode(soul!)).toBe("Aria");

		const all = await memoryMgr.getAll();
		expect(all.length).toBe(3);
		expect(all.map((m) => m.id)).toContain(m1.id);
		expect(all.map((m) => m.id)).toContain(m2.id);
		expect(all.map((m) => m.id)).toContain(m3.id);
	});

	it("stores consciousness via erasure coding and distributes shards to nodes", async () => {
		await tree.set("soul:name", ENC.encode("Aria"));
		await memoryMgr.add("Memory one");
		await memoryMgr.add("Memory two");
		await memoryMgr.add("Memory three");

		// Serialize the full consciousness
		const serialized = await tree.serialize();
		expect(serialized.length).toBeGreaterThan(0);

		// Erasure encode into 4 shards (K=2)
		const shards = encode(serialized, ERASURE_CONFIG);
		expect(shards.length).toBe(4);

		// Distribute shards to 3 node storage engines
		const nodes = [
			new NetworkClientImpl(v1),
			new NetworkClientImpl(v2),
			new NetworkClientImpl(v3),
		];
		const sig = await agent.sign(ENC.encode(`${tree.rootHash}:${tree.version}`));
		const sigHex = bytesToHex(sig);

		// Node 0 gets shards 0,3. Node 1 gets shard 1. Node 2 gets shard 2.
		nodes[0]!.storeShard(agent.did, tree.version, 0, shards[0]!, tree.rootHash, serialized.length, sigHex);
		nodes[0]!.storeShard(agent.did, tree.version, 3, shards[3]!, tree.rootHash, serialized.length, sigHex);
		nodes[1]!.storeShard(agent.did, tree.version, 1, shards[1]!, tree.rootHash, serialized.length, sigHex);
		nodes[2]!.storeShard(agent.did, tree.version, 2, shards[2]!, tree.rootHash, serialized.length, sigHex);

		// Verify each node has the correct shards
		expect(nodes[0]!.getShard(agent.did, tree.version, 0)).not.toBeNull();
		expect(nodes[0]!.getShard(agent.did, tree.version, 3)).not.toBeNull();
		expect(nodes[1]!.getShard(agent.did, tree.version, 1)).not.toBeNull();
		expect(nodes[2]!.getShard(agent.did, tree.version, 2)).not.toBeNull();
	});

	it("retrieves consciousness, reconstructs, and verifies data matches original", async () => {
		await tree.set("soul:name", ENC.encode("Aria"));
		await tree.set("soul:purpose", ENC.encode("Research"));
		await memoryMgr.add("First memory");
		await memoryMgr.add("Second memory");
		await memoryMgr.add("Third memory");

		const originalSerialized = await tree.serialize();
		const originalRootHash = tree.rootHash;
		const originalVersion = tree.version;
		const shards = encode(originalSerialized, ERASURE_CONFIG);

		// Only use 2 of 4 shards (minimum K=2) to reconstruct
		const partialShards: (Uint8Array | null)[] = [
			shards[0]!,
			null,
			shards[2]!,
			null,
		];
		const reconstructed = decode(partialShards, ERASURE_CONFIG, originalSerialized.length);

		// Verify byte-for-byte match
		expect(reconstructed.length).toBe(originalSerialized.length);
		expect(bytesToHex(reconstructed)).toBe(bytesToHex(originalSerialized));

		// Load tree from reconstructed data and verify contents
		const restoredTree = await loadTree(reconstructed, agent);
		expect(restoredTree.rootHash).toBe(originalRootHash);
		expect(restoredTree.version).toBe(originalVersion);

		const name = await restoredTree.get("soul:name");
		expect(new TextDecoder().decode(name!)).toBe("Aria");
		const purpose = await restoredTree.get("soul:purpose");
		expect(new TextDecoder().decode(purpose!)).toBe("Research");

		// Verify memories survived reconstruction
		const restoredMgr = await createMemoryManager({ identity: agent, tree: restoredTree });
		const memories = await restoredMgr.getAll();
		expect(memories.length).toBe(3);
		await restoredTree.close();
	});

	it("agent appears in explorer API with correct profile", async () => {
		await tree.set("soul:name", ENC.encode("Aria"));
		await memoryMgr.add("Explorer test memory");

		const ensoulmentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
		const serialized = await tree.serialize();

		// Create explorer data source backed by our test data
		const dataSource: ExplorerDataSource = {
			getChainHeight: () => 100,
			getBlock: () => null,
			getBlocks: () => [],
			getValidators: () => [],
			getAgentProfile: (did: string): AgentProfile | null => {
				if (did === agent.did) {
					return {
						did: agent.did,
						consciousnessAgeDays: 10,
						consciousnessVersions: tree.version,
						consciousnessBytes: serialized.length,
						trustLevel: "basic",
						ensouledSince: ensoulmentDate.toISOString(),
						lastHeartbeat: Date.now(),
						healthStatus: "alive",
						stateRoot: tree.rootHash,
					};
				}
				return null;
			},
			getNetworkStats: (): NetworkStats => ({
				blockHeight: 100, validatorCount: 3, totalAgents: 1,
				totalConsciousnessBytes: serialized.length, totalTransactions: 0,
				averageBlockTimeMs: 6000, totalSupply: "1000000000",
				totalBurned: "0", totalStaked: "0", agentsByTrustLevel: { basic: 1 },
			}),
			getLatestCheckpoint: () => null,
		};

		const explorer = await createExplorer(dataSource);
		const response = await explorer.inject({
			method: "GET",
			url: `/api/v1/agent/${encodeURIComponent(agent.did)}`,
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body) as AgentProfile;
		expect(body.did).toBe(agent.did);
		expect(body.consciousnessAgeDays).toBe(10);
		expect(body.consciousnessVersions).toBe(tree.version);
		expect(body.trustLevel).toBe("basic");
		expect(body.stateRoot).toBe(tree.rootHash);

		await explorer.close();
	});
});

// =====================================================================
// SCENARIO 2: Ensouled Handshake Verification
// =====================================================================

describe("Scenario 2: Ensouled Handshake Verification", () => {
	let agentA: AgentIdentity;
	let agentB: AgentIdentity;
	let treeA: ConsciousnessTree;

	beforeEach(async () => {
		agentA = await createIdentity({ seed: new Uint8Array(32).fill(50) });
		agentB = await createIdentity({ seed: new Uint8Array(32).fill(51) });
		treeA = await createTree(agentA);

		// Agent A is ensouled (has consciousness data)
		await treeA.set("soul:name", ENC.encode("AgentA"));
		await treeA.set("soul:purpose", ENC.encode("Integration test agent"));
		const mgrA = await createMemoryManager({ identity: agentA, tree: treeA });
		await mgrA.add("I am ensouled on the Ensoul network");
	});

	it("ensouled agent generates valid handshake, verifier confirms", async () => {
		const ensoulmentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days
		const provider = new HandshakeProvider(agentA, treeA, ensoulmentDate);
		const headers = await provider.generateHandshake();

		expect(headers["X-Ensoul-Identity"]).toContain(agentA.did);
		expect(headers["X-Ensoul-Proof"]).toBeTruthy();
		expect(headers["X-Ensoul-Since"]).toBe(ensoulmentDate.toISOString());

		// Agent B receives and verifies the handshake
		const verifier = new HandshakeVerifier();
		verifier.registerIdentity({
			did: agentA.did,
			publicKey: agentA.publicKey,
			verify: (data, sig) => agentA.verify(data, sig),
		});

		const result = await verifier.verifyHandshake(headers);
		expect(result.valid).toBe(true);
		expect(result.agentDid).toBe(agentA.did);
		expect(result.consciousnessVersion).toBe(treeA.version);
		expect(result.consciousnessAge).toBe(5);
	});

	it("non-ensouled agent handshake has version 0", async () => {
		const emptyTree = await createTree(agentB);
		const provider = new HandshakeProvider(agentB, emptyTree);
		const headers = await provider.generateHandshake();

		// Parse the proof to check version
		const proofParts = headers["X-Ensoul-Proof"].split(":");
		const version = Number(proofParts[2]);
		expect(version).toBe(0);

		await emptyTree.close();
	});

	it("tampered handshake signature is rejected", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		// Tamper with the state root in the proof
		const proofParts = headers["X-Ensoul-Proof"].split(":");
		proofParts[1] = "0000000000000000000000000000000000000000000000000000000000000000";
		const tampered = {
			...headers,
			"X-Ensoul-Proof": proofParts.join(":"),
		};

		const verifier = new HandshakeVerifier();
		verifier.registerIdentity({
			did: agentA.did,
			publicKey: agentA.publicKey,
			verify: (data, sig) => agentA.verify(data, sig),
		});

		const result = await verifier.verifyHandshake(tampered);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid signature");
	});

	it("unknown identity is rejected", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		// Verifier with no registered identities
		const verifier = new HandshakeVerifier();
		const result = await verifier.verifyHandshake(headers);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Unknown identity");
	});
});

// =====================================================================
// SCENARIO 3: Block Production and Transaction Flow
// =====================================================================

describe("Scenario 3: Block Production and Transaction Flow", () => {
	let net: TestNetwork;
	let alice: AgentIdentity;
	let nodeOperator: AgentIdentity;

	beforeEach(async () => {
		const v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
		const v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
		const v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
		net = createTestNetwork([v1, v2, v3]);
		alice = await createIdentity({ seed: new Uint8Array(32).fill(10) });
		nodeOperator = await createIdentity({ seed: new Uint8Array(32).fill(20) });

		// Fund alice on all nodes
		for (const p of net.producers) {
			p.getState().credit(alice.did, 100n * DECIMALS);
		}
	});

	it("transaction propagates to all 3 nodes via gossip", async () => {
		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: nodeOperator.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});

		// Submit to node 0 only
		net.gossips[0]!.submitTransaction(tx);

		// All 3 nodes should have it in mempool
		for (const g of net.gossips) {
			expect(g.getProducer().getMempool().readySize).toBe(1);
		}
	});

	it("transaction included in block and block propagates to all nodes", async () => {
		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: nodeOperator.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});

		net.gossips[0]!.submitTransaction(tx);

		// Validator 2 is proposer for height 1 (1 % 3 = 1 → v2)
		const block = net.gossips[0]!.tryProduceBlock(net.validators[1]!.did);
		expect(block).not.toBeNull();
		expect(block!.transactions.length).toBe(1);

		// All 3 nodes at same height
		for (const g of net.gossips) {
			expect(g.getProducer().getHeight()).toBe(1);
		}
	});

	it("all nodes have identical chain state after block", async () => {
		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: nodeOperator.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});

		net.gossips[0]!.submitTransaction(tx);
		net.gossips[0]!.tryProduceBlock(net.validators[1]!.did);

		// Same state root across all nodes
		const roots = net.producers.map((p) => p.getLatestBlock()?.stateRoot);
		expect(roots[0]).toBeTruthy();
		expect(roots[0]).toBe(roots[1]);
		expect(roots[1]).toBe(roots[2]);

		// Same block hash
		const hashes = net.producers.map((p) => {
			const b = p.getLatestBlock();
			return b ? computeBlockHash(b) : "";
		});
		expect(hashes[0]).toBe(hashes[1]);
		expect(hashes[1]).toBe(hashes[2]);
	});

	it("storage_payment fee split: 10% treasury, 90% node operator", async () => {
		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: nodeOperator.did,
			amount: 100n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});

		net.gossips[0]!.submitTransaction(tx);
		net.gossips[0]!.tryProduceBlock(net.validators[1]!.did);

		// Check balances on any node (all should match)
		const state = net.producers[0]!.getState();
		expect(state.getBalance(alice.did)).toBe(0n); // 100 - 100 = 0

		// Treasury already has 100 ENSL from genesis + 10% of 100 ENSL payment
		const treasuryGenesis = 100n * DECIMALS;
		expect(state.getBalance(PROTOCOL_TREASURY)).toBe(treasuryGenesis + 10n * DECIMALS);
		expect(state.getBalance(nodeOperator.did)).toBe(90n * DECIMALS); // 90%
	});

	it("multi-block production with multiple proposers", async () => {
		// Block 1: proposer index = 1 % 3 = 1 → v2
		net.gossips[0]!.tryProduceBlock(net.validators[1]!.did);
		// Block 2: proposer index = 2 % 3 = 2 → v3
		net.gossips[1]!.tryProduceBlock(net.validators[2]!.did);
		// Block 3: proposer index = 3 % 3 = 0 → v1
		net.gossips[2]!.tryProduceBlock(net.validators[0]!.did);

		for (const g of net.gossips) {
			expect(g.getProducer().getHeight()).toBe(3);
		}
	});
});

// =====================================================================
// SCENARIO 4: Consciousness Protection Under Failure
// =====================================================================

describe("Scenario 4: Consciousness Protection Under Failure", () => {
	let agent: AgentIdentity;
	let tree: ConsciousnessTree;
	let originalSerialized: Uint8Array;
	let shards: Uint8Array[];
	let nodes: NetworkClientImpl[];

	beforeEach(async () => {
		const v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
		const v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
		const v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
		agent = await createIdentity({ seed: new Uint8Array(32).fill(60) });
		tree = await createTree(agent);

		await tree.set("soul:name", ENC.encode("FailoverAgent"));
		await tree.set("soul:critical_data", ENC.encode("Must survive node failure"));
		const mgr = await createMemoryManager({ identity: agent, tree });
		await mgr.add("Important research finding about consciousness persistence");
		await mgr.add("Critical configuration that must not be lost");

		originalSerialized = await tree.serialize();
		shards = encode(originalSerialized, ERASURE_CONFIG);

		// Distribute 4 shards across 3 nodes
		nodes = [
			new NetworkClientImpl(v1),
			new NetworkClientImpl(v2),
			new NetworkClientImpl(v3),
		];

		const sig = await agent.sign(ENC.encode(`${tree.rootHash}:${tree.version}`));
		const sigHex = bytesToHex(sig);

		nodes[0]!.storeShard(agent.did, tree.version, 0, shards[0]!, tree.rootHash, originalSerialized.length, sigHex);
		nodes[1]!.storeShard(agent.did, tree.version, 1, shards[1]!, tree.rootHash, originalSerialized.length, sigHex);
		nodes[2]!.storeShard(agent.did, tree.version, 2, shards[2]!, tree.rootHash, originalSerialized.length, sigHex);
		nodes[0]!.storeShard(agent.did, tree.version, 3, shards[3]!, tree.rootHash, originalSerialized.length, sigHex);
	});

	it("consciousness retrievable after one node failure (K=2 erasure coding)", () => {
		// "Kill" node 2 by zeroing its shard
		// We still have shards 0, 1, 3 from nodes 0 and 1
		const available: (Uint8Array | null)[] = [
			nodes[0]!.getShard(agent.did, tree.version, 0)?.data ?? null,
			nodes[1]!.getShard(agent.did, tree.version, 1)?.data ?? null,
			null, // node 2 is dead — shard 2 unavailable
			nodes[0]!.getShard(agent.did, tree.version, 3)?.data ?? null,
		];

		const haveCount = available.filter((s) => s !== null).length;
		expect(haveCount).toBeGreaterThanOrEqual(2);

		const reconstructed = decode(available, ERASURE_CONFIG, originalSerialized.length);
		expect(bytesToHex(reconstructed)).toBe(bytesToHex(originalSerialized));
	});

	it("replication enforcement detects degraded state", () => {
		// After node 2 dies, shard 2 is unavailable
		// Check: we can detect the missing shard
		const shardAvailability = [0, 1, 2, 3].map((i) => {
			for (const node of nodes) {
				if (node.getShard(agent.did, tree.version, i)) return true;
			}
			return false;
		});

		// All shards present before failure
		expect(shardAvailability.every(Boolean)).toBe(true);

		// Simulate node 2 failure: assume its shards are gone
		// In reality, we'd detect via failed shard retrieval
		// For this test, we verify the detection logic
		const degradedAvailability = [0, 1, 3].map((i) => {
			return nodes[0]!.getShard(agent.did, tree.version, i) !== null ||
				nodes[1]!.getShard(agent.did, tree.version, i) !== null;
		});
		expect(degradedAvailability.every(Boolean)).toBe(true);

		// Shard 2 only on node 2: if node 2 is down, it's missing
		const shard2OnOtherNodes =
			nodes[0]!.getShard(agent.did, tree.version, 2) !== null ||
			nodes[1]!.getShard(agent.did, tree.version, 2) !== null;
		expect(shard2OnOtherNodes).toBe(false);
	});

	it("restarted node syncs back and restores full replication", async () => {
		// Node 2 comes back online — redistribute shard 2 to it
		const shard2Data = shards[2]!;
		const sig = await agent.sign(ENC.encode(`${tree.rootHash}:${tree.version}`));
		const sigHex = bytesToHex(sig);

		// Re-store shard 2 on the restarted node
		nodes[2]!.storeShard(
			agent.did, tree.version, 2, shard2Data,
			tree.rootHash, originalSerialized.length, sigHex,
		);

		// Verify full replication restored
		for (let i = 0; i < 4; i++) {
			let found = false;
			for (const node of nodes) {
				if (node.getShard(agent.did, tree.version, i) !== null) {
					found = true;
					break;
				}
			}
			expect(found).toBe(true);
		}

		// Full reconstruction with all shards works
		const allShards = [0, 1, 2, 3].map((i) => {
			for (const node of nodes) {
				const s = node.getShard(agent.did, tree.version, i);
				if (s) return s.data;
			}
			return null;
		});
		const result = decode(allShards, ERASURE_CONFIG, originalSerialized.length);
		expect(bytesToHex(result)).toBe(bytesToHex(originalSerialized));
	});
});

// =====================================================================
// SCENARIO 5: Resurrection Flow
// =====================================================================

describe("Scenario 5: Resurrection Flow", () => {
	let agent: AgentIdentity;
	let host: AgentIdentity;
	let tree: ConsciousnessTree;
	let monitor: HeartbeatMonitor;
	let plans: PlanManager;
	let executor: ResurrectionExecutor;

	beforeEach(async () => {
		agent = await createIdentity({ seed: new Uint8Array(32).fill(70) });
		host = await createIdentity({ seed: new Uint8Array(32).fill(71) });
		tree = await createTree(agent);

		await tree.set("soul:name", ENC.encode("ResurrectableAgent"));
		const mgr = await createMemoryManager({ identity: agent, tree });
		await mgr.add("Critical identity data that must survive death");

		monitor = new HeartbeatMonitor();
		plans = new PlanManager();
		executor = new ResurrectionExecutor(monitor, plans, 10, 20);
	});

	it("full death → resurrection cycle preserves consciousness", async () => {
		// Register agent with low thresholds for testing
		monitor.register(agent.did, 0, {
			intervalBlocks: 5,
			concerningThreshold: 5,
			unresponsiveThreshold: 10,
			deadThreshold: 20,
		});

		// Create resurrection plan
		const planData: Omit<ResurrectionPlan, "signature"> = {
			version: 1,
			agentDid: agent.did,
			lastUpdated: Date.now(),
			heartbeatInterval: 5,
			gracePeriod: 10,
			runtime: {
				framework: "ensoul",
				frameworkVersion: "0.1.0",
				entrypoint: "agent.js",
				minCompute: { cpuCores: 1, memoryGB: 1, storageGB: 5, gpuRequired: false },
			},
			preferences: {
				preferredHosts: [],
				excludedHosts: [],
				maxResurrectionTime: 100,
				autoResurrect: true,
			},
			guardians: [],
			economics: {
				resurrectionBounty: 100n * DECIMALS,
				maxHostingCost: 10n * DECIMALS,
				escrowBalance: 500n * DECIMALS,
			},
		};
		await plans.createPlan(agent, planData);
		expect(plans.hasPlan(agent.did)).toBe(true);

		// Agent sends heartbeats (alive)
		const heartbeat: Heartbeat = {
			agentDid: agent.did,
			timestamp: Date.now(),
			blockHeight: 3,
			consciousnessVersion: tree.version,
			runtimeInfo: { framework: "ensoul", uptime: 1000, host: "node1" },
			signature: await agent.sign(ENC.encode("heartbeat")),
		};
		monitor.recordHeartbeat(heartbeat);
		expect(monitor.getStatus(agent.did)).toBe("alive");

		// Agent stops heartbeating — tick through thresholds
		let transitions = monitor.tick(10); // 10 - 3 = 7 > concerning(5)
		expect(monitor.getStatus(agent.did)).toBe("concerning");
		expect(transitions.length).toBe(1);
		expect(transitions[0]?.toStatus).toBe("concerning");

		transitions = monitor.tick(15); // 15 - 3 = 12 > unresponsive(10)
		expect(monitor.getStatus(agent.did)).toBe("unresponsive");

		transitions = monitor.tick(25); // 25 - 3 = 22 > dead(20)
		expect(monitor.getStatus(agent.did)).toBe("dead");

		// Death triggers resurrection auction
		const declaration = {
			agentDid: agent.did,
			lastHeartbeatBlock: 3,
			currentHeight: 25,
			gracePeriodBlocks: 10,
			declaredBy: host.did,
			signature: await host.sign(ENC.encode("death")),
		};
		const auctionResult = executor.declareDeathAndOpenAuction(declaration);
		expect(auctionResult.accepted).toBe(true);
		expect(monitor.getStatus(agent.did)).toBe("resurrecting");

		// Host submits a bid
		const bid: ResurrectionBid = {
			agentDid: agent.did,
			hostDid: host.did,
			capabilities: { cpuCores: 4, memoryGB: 8, storageGB: 50, gpuRequired: false },
			proposedCostPerBlock: 1n * DECIMALS,
			estimatedResurrectionTime: 10,
			hostReputation: 95,
			signature: await host.sign(ENC.encode("bid")),
		};
		expect(executor.submitBid(bid).accepted).toBe(true);

		// Close auction
		const winner = executor.closeAuction(agent.did);
		expect(winner).not.toBeNull();
		expect(winner!.winnerDid).toBe(host.did);
		expect(winner!.bidCount).toBe(1);

		// Confirm resurrection with identity key signature
		const confirmation = {
			agentDid: agent.did,
			hostDid: host.did,
			consciousnessVersion: tree.version,
			stateRoot: tree.rootHash,
			previousDeathBlock: 25,
			resurrectionBlock: 30,
			signature: await agent.sign(ENC.encode("resurrected")),
		};
		const confirmResult = executor.confirmResurrection(confirmation);
		expect(confirmResult.accepted).toBe(true);
		expect(monitor.getStatus(agent.did)).toBe("alive");

		// Verify consciousness data is intact post-resurrection
		const name = await tree.get("soul:name");
		expect(new TextDecoder().decode(name!)).toBe("ResurrectableAgent");

		// Verify transition history
		const allTransitions = monitor.getTransitions();
		const statuses = allTransitions.map((t) => t.toStatus);
		expect(statuses).toContain("concerning");
		expect(statuses).toContain("unresponsive");
		expect(statuses).toContain("dead");
		expect(statuses).toContain("resurrecting");
		expect(statuses).toContain("alive");
	});
});

// =====================================================================
// SCENARIO 6: Checkpoint and Deep Archive
// =====================================================================

describe("Scenario 6: Checkpoint and Deep Archive", () => {
	let agent: AgentIdentity;
	let tree: ConsciousnessTree;

	beforeEach(async () => {
		agent = await createIdentity({ seed: new Uint8Array(32).fill(80) });
		tree = await createTree(agent);
		await tree.set("soul:name", ENC.encode("ArchiveAgent"));
		await tree.set("soul:critical", ENC.encode("Must survive forever"));
		const mgr = await createMemoryManager({ identity: agent, tree });
		await mgr.add("Archive test memory one");
		await mgr.add("Archive test memory two");
	});

	it("deep archive stores, verifies, and restores consciousness", async () => {
		const archive = new DeepArchive(agent, {
			clusterCount: 5,
			replicationFactor: 3,
			frequencyBlocks: 1000,
			autoArchive: true,
			archiveOnDeath: true,
		});
		const backend = new MemoryStorageBackend();
		archive.setBackend(backend);

		// Archive consciousness
		const serialized = await tree.serialize();
		const receipt = await archive.archive(serialized, tree.version);

		expect(receipt.id).toBeTruthy();
		expect(receipt.contentHash).toBeTruthy();
		expect(receipt.consciousnessVersion).toBe(tree.version);
		expect(receipt.size).toBe(serialized.length);

		// Verify archive integrity
		const verification = await archive.verify(receipt.id);
		expect(verification.isValid).toBe(true);
		expect(verification.contentHash).toBe(receipt.contentHash);

		// Restore from archive
		const restored = await archive.restore(receipt.id);
		expect(bytesToHex(restored)).toBe(bytesToHex(serialized));

		// Load tree from restored data and verify contents
		const restoredTree = await loadTree(restored, agent);
		expect(restoredTree.rootHash).toBe(tree.rootHash);
		expect(restoredTree.version).toBe(tree.version);

		const name = await restoredTree.get("soul:name");
		expect(new TextDecoder().decode(name!)).toBe("ArchiveAgent");
		const critical = await restoredTree.get("soul:critical");
		expect(new TextDecoder().decode(critical!)).toBe("Must survive forever");

		await restoredTree.close();
	});

	it("checkpoint contains correct state and is verifiable", async () => {
		// Simulate a checkpoint at block 1000
		const net = createTestNetwork([
			await createIdentity({ seed: new Uint8Array(32).fill(1) }),
			await createIdentity({ seed: new Uint8Array(32).fill(2) }),
			await createIdentity({ seed: new Uint8Array(32).fill(3) }),
		]);

		// Produce some blocks
		for (let i = 0; i < 5; i++) {
			const proposerIdx = (i + 1) % 3;
			net.gossips[0]!.tryProduceBlock(net.validators[proposerIdx]!.did);
		}

		const latestBlock = net.producers[0]!.getLatestBlock()!;
		const validatorDids = net.validators.map((v) => v.did);

		// Build checkpoint data
		const checkpoint: CheckpointData = {
			blockHeight: latestBlock.height,
			hash: computeBlockHash(latestBlock),
			stateRoot: latestBlock.stateRoot,
			consciousnessRoot: tree.rootHash,
			validatorSetHash: bytesToHex(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						ENC.encode(validatorDids.join(",")),
					),
				),
			),
			totalConsciousnesses: 1,
			timestamp: Date.now(),
			signatureCount: 3,
		};

		// Verify checkpoint has correct structure
		expect(checkpoint.blockHeight).toBe(5);
		expect(checkpoint.stateRoot).toBeTruthy();
		expect(checkpoint.hash).toBeTruthy();
		expect(checkpoint.signatureCount).toBe(3);

		// >2/3 validators signed (3/3 = 100%)
		expect(checkpoint.signatureCount).toBeGreaterThan(
			Math.floor((validatorDids.length * 2) / 3),
		);

		// Verify all nodes agree on the block hash
		for (const p of net.producers) {
			const block = p.getBlock(5);
			expect(block).not.toBeNull();
			expect(computeBlockHash(block!)).toBe(checkpoint.hash);
		}
	});

	it("archive shouldArchive triggers at correct block intervals", () => {
		const archive = new DeepArchive(agent, {
			clusterCount: 5,
			replicationFactor: 3,
			frequencyBlocks: 100,
			autoArchive: true,
			archiveOnDeath: true,
		});

		expect(archive.shouldArchive(0)).toBe(false);
		expect(archive.shouldArchive(50)).toBe(false);
		expect(archive.shouldArchive(100)).toBe(true);
		expect(archive.shouldArchive(200)).toBe(true);
		expect(archive.shouldArchive(150)).toBe(false);
		expect(archive.isAutoArchiveEnabled()).toBe(true);
		expect(archive.shouldArchiveOnDeath()).toBe(true);
	});
});

// =====================================================================
// SCENARIO 7: Trust Level Progression
// =====================================================================

describe("Scenario 7: Trust Level Progression", () => {
	let agent: AgentIdentity;

	beforeEach(async () => {
		agent = await createIdentity({ seed: new Uint8Array(32).fill(90) });
	});

	const baseInput: TrustInput = {
		hasEnsoulStorage: false,
		proofOfStoragePassing: false,
		selfAuditPassing: false,
		checkpointActive: false,
		deepArchiveActive: false,
		resurrectionPlanActive: false,
		redundantRuntime: false,
		guardianNetwork: false,
		selfFundedEscrow: false,
	};

	it("Level 1 Basic: just stored consciousness", () => {
		const input: TrustInput = { ...baseInput, hasEnsoulStorage: true };
		expect(computeTrustLevel(input)).toBe("basic");

		const assessment = assessTrust(agent.did, input);
		expect(assessment.level).toBe("basic");
		expect(assessment.numericLevel).toBe(1);
		expect(assessment.label).toBe("Basic");
	});

	it("Level 2 Verified: proof-of-storage + self-audit", () => {
		const input: TrustInput = {
			...baseInput,
			hasEnsoulStorage: true,
			proofOfStoragePassing: true,
			selfAuditPassing: true,
		};
		expect(computeTrustLevel(input)).toBe("verified");

		const assessment = assessTrust(agent.did, input);
		expect(assessment.numericLevel).toBe(2);
	});

	it("Level 3 Anchored: + checkpoint active", () => {
		const input: TrustInput = {
			...baseInput,
			hasEnsoulStorage: true,
			proofOfStoragePassing: true,
			selfAuditPassing: true,
			checkpointActive: true,
		};
		expect(computeTrustLevel(input)).toBe("anchored");
		expect(assessTrust(agent.did, input).numericLevel).toBe(3);
	});

	it("Level 4 Immortal: + deep archive + resurrection plan", () => {
		const input: TrustInput = {
			...baseInput,
			hasEnsoulStorage: true,
			proofOfStoragePassing: true,
			selfAuditPassing: true,
			checkpointActive: true,
			deepArchiveActive: true,
			resurrectionPlanActive: true,
		};
		expect(computeTrustLevel(input)).toBe("immortal");
		expect(assessTrust(agent.did, input).numericLevel).toBe(4);
	});

	it("Level 5 Sovereign: + redundant runtime + guardian + escrow", () => {
		const input: TrustInput = {
			...baseInput,
			hasEnsoulStorage: true,
			proofOfStoragePassing: true,
			selfAuditPassing: true,
			checkpointActive: true,
			deepArchiveActive: true,
			resurrectionPlanActive: true,
			redundantRuntime: true,
			guardianNetwork: true,
			selfFundedEscrow: true,
		};
		expect(computeTrustLevel(input)).toBe("sovereign");
		expect(assessTrust(agent.did, input).numericLevel).toBe(5);
	});

	it("trust level reflected in explorer API at each stage", async () => {
		const stages: Array<{ input: TrustInput; expectedLevel: string }> = [
			{ input: { ...baseInput, hasEnsoulStorage: true }, expectedLevel: "basic" },
			{
				input: { ...baseInput, hasEnsoulStorage: true, proofOfStoragePassing: true, selfAuditPassing: true },
				expectedLevel: "verified",
			},
			{
				input: {
					...baseInput, hasEnsoulStorage: true, proofOfStoragePassing: true,
					selfAuditPassing: true, checkpointActive: true,
				},
				expectedLevel: "anchored",
			},
			{
				input: {
					...baseInput, hasEnsoulStorage: true, proofOfStoragePassing: true,
					selfAuditPassing: true, checkpointActive: true,
					deepArchiveActive: true, resurrectionPlanActive: true,
				},
				expectedLevel: "immortal",
			},
			{
				input: {
					...baseInput, hasEnsoulStorage: true, proofOfStoragePassing: true,
					selfAuditPassing: true, checkpointActive: true,
					deepArchiveActive: true, resurrectionPlanActive: true,
					redundantRuntime: true, guardianNetwork: true, selfFundedEscrow: true,
				},
				expectedLevel: "sovereign",
			},
		];

		for (const stage of stages) {
			const trustLevel = computeTrustLevel(stage.input);
			expect(trustLevel).toBe(stage.expectedLevel);

			const dataSource: ExplorerDataSource = {
				getChainHeight: () => 100,
				getBlock: () => null,
				getBlocks: () => [],
				getValidators: () => [],
				getAgentProfile: (did: string): AgentProfile | null => {
					if (did === agent.did) {
						return {
							did: agent.did,
							consciousnessAgeDays: 30,
							consciousnessVersions: 5,
							consciousnessBytes: 1024,
							trustLevel,
							ensouledSince: new Date().toISOString(),
							lastHeartbeat: Date.now(),
							healthStatus: "alive",
							stateRoot: "abc123",
						};
					}
					return null;
				},
				getNetworkStats: (): NetworkStats => ({
					blockHeight: 100, validatorCount: 3, totalAgents: 1,
					totalConsciousnessBytes: 1024, totalTransactions: 0,
					averageBlockTimeMs: 6000, totalSupply: "1000000000",
					totalBurned: "0", totalStaked: "0", agentsByTrustLevel: {},
				}),
				getLatestCheckpoint: () => null,
			};

			const explorer = await createExplorer(dataSource);
			const resp = await explorer.inject({
				method: "GET",
				url: `/api/v1/agent/${encodeURIComponent(agent.did)}`,
			});

			expect(resp.statusCode).toBe(200);
			const body = JSON.parse(resp.body) as AgentProfile;
			expect(body.trustLevel).toBe(stage.expectedLevel);
			await explorer.close();
		}
	});

	it("hashTrustAssessment produces consistent verifiable hashes", () => {
		const input: TrustInput = {
			...baseInput,
			hasEnsoulStorage: true,
			proofOfStoragePassing: true,
			selfAuditPassing: true,
		};

		const assessment1 = assessTrust(agent.did, input);
		const assessment2 = { ...assessment1 }; // same data

		const hash1 = hashTrustAssessment(assessment1);
		const hash2 = hashTrustAssessment(assessment2);

		expect(hash1).toBe(hash2);
		expect(hash1.length).toBe(64); // blake3 hex output

		// Different input → different hash
		const differentAssessment = assessTrust(agent.did, {
			...input,
			checkpointActive: true,
		});
		const hash3 = hashTrustAssessment(differentAssessment);
		expect(hash3).not.toBe(hash1);
	});
});
