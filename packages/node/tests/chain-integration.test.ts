import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	encodeTxPayload,
	REWARDS_POOL,
	PROTOCOL_TREASURY,
} from "@ensoul/ledger";
import type { GenesisConfig, Transaction } from "@ensoul/ledger";
import {
	NodeBlockProducer,
	BlockSync,
	serializeBlock,
	deserializeBlock,
} from "../src/chain/index.js";

const DECIMALS = 10n ** 18n;

let validator1: AgentIdentity;
let validator2: AgentIdentity;
let validator3: AgentIdentity;
let alice: AgentIdentity;
let bob: AgentIdentity;

function testGenesis(): GenesisConfig {
	return {
		chainId: "ensoul-test",
		timestamp: Date.now(),
		totalSupply: 1000n * DECIMALS,
		allocations: [
			{
				label: "Foundation",
				percentage: 15,
				tokens: 150n * DECIMALS,
				recipient: "did:test:foundation",
			},
			{
				label: "Rewards",
				percentage: 50,
				tokens: 500n * DECIMALS,
				recipient: REWARDS_POOL,
			},
			{
				label: "Treasury",
				percentage: 10,
				tokens: 100n * DECIMALS,
				recipient: PROTOCOL_TREASURY,
			},
			{
				label: "Onboarding",
				percentage: 10,
				tokens: 100n * DECIMALS,
				recipient: "did:test:onboarding",
			},
			{
				label: "Liquidity",
				percentage: 5,
				tokens: 50n * DECIMALS,
				recipient: "did:test:liquidity",
			},
			{
				label: "Contributors",
				percentage: 5,
				tokens: 50n * DECIMALS,
				recipient: "did:test:contributors",
			},
			{
				label: "Insurance",
				percentage: 5,
				tokens: 50n * DECIMALS,
				recipient: "did:test:insurance",
			},
		],
		emissionPerBlock: 1n * DECIMALS,
		networkRewardsPool: 500n * DECIMALS,
		protocolFees: {
			storageFeeProtocolShare: 10,
			txBaseFee: 1000n,
		},
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

beforeEach(async () => {
	validator1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	validator2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	validator3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
	alice = await createIdentity({ seed: new Uint8Array(32).fill(10) });
	bob = await createIdentity({ seed: new Uint8Array(32).fill(11) });
});

// ── NodeBlockProducer ────────────────────────────────────────────────

describe("NodeBlockProducer", () => {
	it("initializes genesis on all nodes", () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];

		const nodes = dids.map(() => {
			const p = new NodeBlockProducer(config);
			p.initGenesis(dids);
			return p;
		});

		// All start at height 0
		for (const node of nodes) {
			expect(node.getHeight()).toBe(0);
			expect(node.getLatestBlock()?.height).toBe(0);
		}
	});

	it("round-robin proposer selection", () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];
		const producer = new NodeBlockProducer(config);
		producer.initGenesis(dids);

		// Height 1: proposer index = 1 % 3 = 1 (validator2)
		expect(producer.produceBlock(validator1.did)).toBeNull();
		const block = producer.produceBlock(validator2.did);
		expect(block).not.toBeNull();
		expect(block!.proposer).toBe(validator2.did);
	});

	it("produces block with transaction", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];
		const producer = new NodeBlockProducer(config);
		producer.initGenesis(dids);

		// Fund alice
		producer.getState().credit(alice.did, 100n * DECIMALS);

		// Submit a transfer
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		producer.submitTransaction(tx);

		// Produce block (height 1, proposer index 1 = validator2)
		const block = producer.produceBlock(validator2.did);
		expect(block).not.toBeNull();
		expect(block!.transactions.length).toBe(1);
		expect(block!.height).toBe(1);

		// Verify balances
		expect(producer.getState().getBalance(bob.did)).toBe(
			10n * DECIMALS,
		);
	});
});

// ── BlockSync ────────────────────────────────────────────────────────

describe("BlockSync", () => {
	it("syncs a block between two nodes", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];

		const node1 = new NodeBlockProducer(config);
		node1.initGenesis(dids);

		const node2 = new NodeBlockProducer(config);
		node2.initGenesis(dids);

		const sync2 = new BlockSync(node2);

		// Fund alice on node1
		node1.getState().credit(alice.did, 100n * DECIMALS);
		// Must also fund on node2 since they're independent
		node2.getState().credit(alice.did, 100n * DECIMALS);

		// Submit tx and produce block on node1
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		node1.submitTransaction(tx);
		const block = node1.produceBlock(validator2.did)!;

		// Sync block to node2
		const serialized = serializeBlock(block);
		const result = sync2.handleBlock(serialized);

		expect(result.applied).toBe(true);
		expect(node2.getHeight()).toBe(1);
	});

	it("rejects duplicate block", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did];

		const node1 = new NodeBlockProducer(config);
		node1.initGenesis(dids);

		const node2 = new NodeBlockProducer(config);
		node2.initGenesis(dids);

		const sync2 = new BlockSync(node2);

		const block = node1.produceBlock(validator2.did)!;
		const serialized = serializeBlock(block);

		sync2.handleBlock(serialized);
		const dup = sync2.handleBlock(serialized);
		expect(dup.applied).toBe(false);
		expect(dup.error).toContain("already known");
	});

	it("handles sync request for chain history", () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did];

		const node = new NodeBlockProducer(config);
		node.initGenesis(dids);

		// Produce a few blocks
		node.produceBlock(validator2.did); // height 1
		node.produceBlock(validator1.did); // height 2

		const sync = new BlockSync(node);
		const blocks = sync.handleSyncRequest(0);
		expect(blocks.length).toBe(3); // genesis + 2 blocks
	});

	it("applySyncBlocks applies a batch", () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did];

		// Node1 produces blocks
		const node1 = new NodeBlockProducer(config);
		node1.initGenesis(dids);
		node1.produceBlock(validator2.did);
		node1.produceBlock(validator1.did);

		const sync1 = new BlockSync(node1);
		const allBlocks = sync1.handleSyncRequest(1); // blocks 1 and 2

		// Node2 starts fresh
		const node2 = new NodeBlockProducer(config);
		node2.initGenesis(dids);

		const sync2 = new BlockSync(node2);
		const result = sync2.applySyncBlocks(allBlocks);
		expect(result.applied).toBe(2);
		expect(result.errors.length).toBe(0);
		expect(node2.getHeight()).toBe(2);
	});
});

// ── 3-Node Integration ──────────────────────────────────────────────

describe("3-node integration", () => {
	it("3 nodes reach same state after block propagation", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];

		// Create 3 independent nodes
		const node1 = new NodeBlockProducer(config);
		const node2 = new NodeBlockProducer(config);
		const node3 = new NodeBlockProducer(config);

		node1.initGenesis(dids);
		node2.initGenesis(dids);
		node3.initGenesis(dids);

		// Fund alice on all nodes (simulates genesis state)
		for (const node of [node1, node2, node3]) {
			node.getState().credit(alice.did, 100n * DECIMALS);
		}

		const sync1 = new BlockSync(node1);
		const sync2 = new BlockSync(node2);
		const sync3 = new BlockSync(node3);

		// Wire up broadcast: when a sync receives a block, it broadcasts to others
		const allSyncs = [sync1, sync2, sync3];

		function broadcast(
			originIndex: number,
			serialized: ReturnType<typeof serializeBlock>,
		): void {
			for (let i = 0; i < allSyncs.length; i++) {
				if (i !== originIndex) {
					allSyncs[i]!.handleBlock(serialized);
				}
			}
		}

		// Node1 (validator2 is proposer for height 1)
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 25n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});

		// Submit tx to proposer node (node1 in this case)
		node1.submitTransaction(tx);

		// Produce block on node1 (validator2 is proposer for h=1)
		const block1 = node1.produceBlock(validator2.did);
		expect(block1).not.toBeNull();

		// Broadcast to node2 and node3
		const serialized = serializeBlock(block1!);
		broadcast(0, serialized);

		// All 3 nodes should be at height 1
		expect(node1.getHeight()).toBe(1);
		expect(node2.getHeight()).toBe(1);
		expect(node3.getHeight()).toBe(1);

		// All should agree on bob's balance
		// Node1 applied the block during production
		const bobBalance1 = node1.getState().getBalance(bob.did);
		const bobBalance2 = node2.getState().getBalance(bob.did);
		const bobBalance3 = node3.getState().getBalance(bob.did);

		expect(bobBalance1).toBe(25n * DECIMALS);
		expect(bobBalance2).toBe(25n * DECIMALS);
		expect(bobBalance3).toBe(25n * DECIMALS);

		// All should agree on alice's remaining balance
		// alice started with 100, transferred 25 => 75
		const aliceBalance1 = node1.getState().getBalance(alice.did);
		const aliceBalance2 = node2.getState().getBalance(alice.did);
		const aliceBalance3 = node3.getState().getBalance(alice.did);

		expect(aliceBalance1).toBe(75n * DECIMALS);
		expect(aliceBalance2).toBe(75n * DECIMALS);
		expect(aliceBalance3).toBe(75n * DECIMALS);
	});

	it("multi-block propagation across 3 nodes", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];

		const nodes = [
			new NodeBlockProducer(config),
			new NodeBlockProducer(config),
			new NodeBlockProducer(config),
		];

		for (const node of nodes) {
			node.initGenesis(dids);
			node.getState().credit(alice.did, 1000n * DECIMALS);
		}

		const syncs = nodes.map((n) => new BlockSync(n));

		function broadcastFrom(
			originIdx: number,
			serialized: ReturnType<typeof serializeBlock>,
		): void {
			for (let i = 0; i < syncs.length; i++) {
				if (i !== originIdx) {
					syncs[i]!.handleBlock(serialized);
				}
			}
		}

		// Block 1: validator2 (index 1) proposes
		const tx1 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		nodes[0]!.submitTransaction(tx1);
		const block1 = nodes[0]!.produceBlock(validator2.did)!;
		broadcastFrom(0, serializeBlock(block1));

		// Block 2: validator3 (index 2) proposes
		const tx2 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 20n * DECIMALS,
			nonce: 1,
			timestamp: Date.now(),
		});
		nodes[1]!.submitTransaction(tx2);
		const block2 = nodes[1]!.produceBlock(validator3.did)!;
		broadcastFrom(1, serializeBlock(block2));

		// All nodes at height 2
		for (const node of nodes) {
			expect(node.getHeight()).toBe(2);
		}

		// Bob received 10 + 20 = 30
		for (const node of nodes) {
			expect(node.getState().getBalance(bob.did)).toBe(
				30n * DECIMALS,
			);
		}
	});

	it("new node syncs from existing nodes", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did, validator3.did];

		// Existing node with 2 blocks
		const existingNode = new NodeBlockProducer(config);
		existingNode.initGenesis(dids);
		existingNode.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 5n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		existingNode.submitTransaction(tx);
		existingNode.produceBlock(validator2.did);
		existingNode.produceBlock(validator3.did); // empty block 2

		const existingSync = new BlockSync(existingNode);

		// New node joins — needs to sync
		const newNode = new NodeBlockProducer(config);
		newNode.initGenesis(dids);
		newNode.getState().credit(alice.did, 100n * DECIMALS);

		const newSync = new BlockSync(newNode);

		// Request blocks from existing
		const blocks = existingSync.handleSyncRequest(1);
		const result = newSync.applySyncBlocks(blocks);

		expect(result.applied).toBe(2);
		expect(newNode.getHeight()).toBe(2);

		// State should match
		expect(newNode.getState().getBalance(bob.did)).toBe(
			existingNode.getState().getBalance(bob.did),
		);
	});
});

// ── Serialization round-trips ────────────────────────────────────────

describe("block serialization", () => {
	it("round-trips a block through serialize/deserialize", async () => {
		const config = testGenesis();
		const dids = [validator1.did, validator2.did];

		const producer = new NodeBlockProducer(config);
		producer.initGenesis(dids);
		producer.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 7n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		producer.submitTransaction(tx);
		const block = producer.produceBlock(validator2.did)!;

		const serialized = serializeBlock(block);
		const deserialized = deserializeBlock(serialized);

		expect(deserialized.height).toBe(block.height);
		expect(deserialized.previousHash).toBe(block.previousHash);
		expect(deserialized.stateRoot).toBe(block.stateRoot);
		expect(deserialized.proposer).toBe(block.proposer);
		expect(deserialized.transactions.length).toBe(1);
		expect(deserialized.transactions[0]!.amount).toBe(7n * DECIMALS);
	});
});
