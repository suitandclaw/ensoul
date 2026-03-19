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
	GossipNetwork,
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
		timestamp: 1700000000000, // Fixed timestamp for deterministic genesis
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
		const dids = [validator1.did, validator2.did, validator3.did];
		const nodes = dids.map(() => {
			const p = new NodeBlockProducer(testGenesis());
			p.initGenesis(dids);
			return p;
		});
		for (const node of nodes) {
			expect(node.getHeight()).toBe(0);
		}
	});

	it("round-robin proposer selection", () => {
		const dids = [validator1.did, validator2.did, validator3.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		expect(producer.produceBlock(validator1.did)).toBeNull();
		const block = producer.produceBlock(validator2.did);
		expect(block).not.toBeNull();
		expect(block!.proposer).toBe(validator2.did);
	});

	it("produces block with transaction", async () => {
		const dids = [validator1.did, validator2.did, validator3.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		producer.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 10n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		producer.submitTransaction(tx);
		const block = producer.produceBlock(validator2.did);
		// 1 user tx + 1 block_reward tx
		expect(block!.transactions.length).toBe(2);
		expect(producer.getState().getBalance(bob.did)).toBe(10n * DECIMALS);
	});

	it("returns null for non-proposer", () => {
		const dids = [validator1.did, validator2.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		expect(producer.produceBlock("did:nobody")).toBeNull();
	});

	it("returns null with no validators", () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([]);
		expect(producer.produceBlock("did:any")).toBeNull();
	});

	it("getters work correctly", () => {
		const dids = [validator1.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		expect(producer.getValidators()).toEqual(dids);
		expect(producer.getMempool()).toBeDefined();
		expect(producer.getWatchdog()).toBeDefined();
		expect(producer.getState()).toBeDefined();
		expect(producer.getBlock(0)).not.toBeNull();
		expect(producer.getBlock(99)).toBeNull();
		expect(producer.getLatestBlock()?.height).toBe(0);
	});

	it("onBlock callback fires", () => {
		const dids = [validator1.did, validator2.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		let captured = false;
		producer.onBlock = () => { captured = true; };
		producer.produceBlock(validator2.did);
		expect(captured).toBe(true);
	});
});

// ── BlockSync ────────────────────────────────────────────────────────

describe("BlockSync", () => {
	it("syncs a block between two nodes", async () => {
		const dids = [validator1.did, validator2.did];
		const node1 = new NodeBlockProducer(testGenesis());
		node1.initGenesis(dids);
		const node2 = new NodeBlockProducer(testGenesis());
		node2.initGenesis(dids);
		node1.getState().credit(alice.did, 100n * DECIMALS);
		node2.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 10n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		node1.submitTransaction(tx);
		const block = node1.produceBlock(validator2.did)!;

		const sync2 = new BlockSync(node2);
		const syncResult = sync2.handleBlock(serializeBlock(block));
		expect(syncResult.error).toBeUndefined();
		expect(syncResult.applied).toBe(true);
		expect(node2.getHeight()).toBe(1);
	});

	it("rejects duplicate block", async () => {
		const dids = [validator1.did, validator2.did];
		const node1 = new NodeBlockProducer(testGenesis());
		node1.initGenesis(dids);
		const node2 = new NodeBlockProducer(testGenesis());
		node2.initGenesis(dids);
		node1.getState().credit(alice.did, 100n * DECIMALS);
		node2.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 1n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		node1.submitTransaction(tx);
		const block = node1.produceBlock(validator2.did)!;
		const sync2 = new BlockSync(node2);
		sync2.handleBlock(serializeBlock(block));
		expect(sync2.handleBlock(serializeBlock(block)).applied).toBe(false);
	});

	it("handleSyncRequest returns chain history", () => {
		const dids = [validator1.did, validator2.did];
		const node = new NodeBlockProducer(testGenesis());
		node.initGenesis(dids);
		node.produceBlock(validator2.did);
		node.produceBlock(validator1.did);
		const sync = new BlockSync(node);
		expect(sync.handleSyncRequest(0).length).toBe(3);
		expect(sync.getHeight()).toBe(2);
	});

	it("applySyncBlocks applies a batch", () => {
		const dids = [validator1.did, validator2.did];
		const node1 = new NodeBlockProducer(testGenesis());
		node1.initGenesis(dids);
		node1.produceBlock(validator2.did);
		node1.produceBlock(validator1.did);

		const node2 = new NodeBlockProducer(testGenesis());
		node2.initGenesis(dids);
		const sync2 = new BlockSync(node2);
		const blocks = new BlockSync(node1).handleSyncRequest(1);
		expect(sync2.applySyncBlocks(blocks).applied).toBe(2);
		expect(node2.getHeight()).toBe(2);
	});

	it("onBroadcastBlock callback fires on valid block", async () => {
		const dids = [validator1.did, validator2.did];
		const node1 = new NodeBlockProducer(testGenesis());
		node1.initGenesis(dids);
		const node2 = new NodeBlockProducer(testGenesis());
		node2.initGenesis(dids);

		// Add a tx so the block has deterministic content
		node1.getState().credit(alice.did, 100n * DECIMALS);
		node2.getState().credit(alice.did, 100n * DECIMALS);
		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 5n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		node1.submitTransaction(tx);
		const block = node1.produceBlock(validator2.did)!;

		const sync2 = new BlockSync(node2);
		let broadcasted = false;
		sync2.onBroadcastBlock = () => { broadcasted = true; };
		const result = sync2.handleBlock(serializeBlock(block));
		expect(result.applied).toBe(true);
		expect(broadcasted).toBe(true);
	});
});

// ── GossipNetwork ────────────────────────────────────────────────────

describe("GossipNetwork", () => {
	it("submits and deduplicates transactions", async () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did]);
		producer.getState().credit(alice.did, 100n * DECIMALS);
		const gossip = new GossipNetwork(producer);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 1n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		expect(gossip.submitTransaction(tx)).not.toBeNull();
		expect(gossip.submitTransaction(tx)).toBeNull(); // dedup
		expect(gossip.getSeenTxCount()).toBe(1);
	});

	it("handleGossipTx deduplicates", async () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did]);
		producer.getState().credit(alice.did, 100n * DECIMALS);
		const gossip = new GossipNetwork(producer);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 1n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		const { serializeTx } = await import("../src/chain/types.js");
		expect(gossip.handleGossipTx(serializeTx(tx))).toBe(true);
		expect(gossip.handleGossipTx(serializeTx(tx))).toBe(false);
	});

	it("handleGossipBlock deduplicates", async () => {
		const dids = [validator1.did, validator2.did];
		const node1 = new NodeBlockProducer(testGenesis());
		node1.initGenesis(dids);
		const node2 = new NodeBlockProducer(testGenesis());
		node2.initGenesis(dids);
		node1.getState().credit(alice.did, 100n * DECIMALS);
		node2.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 1n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		node1.submitTransaction(tx);
		const block = node1.produceBlock(validator2.did)!;

		const gossip2 = new GossipNetwork(node2);
		expect(gossip2.handleGossipBlock(serializeBlock(block)).applied).toBe(true);
		expect(gossip2.handleGossipBlock(serializeBlock(block)).applied).toBe(false);
	});

	it("tryProduceBlock produces and broadcasts", () => {
		const dids = [validator1.did, validator2.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		const gossip = new GossipNetwork(producer);
		let broadcasted = false;
		gossip.onBroadcastBlock = () => { broadcasted = true; };
		expect(gossip.tryProduceBlock(validator2.did)).not.toBeNull();
		expect(broadcasted).toBe(true);
	});

	it("tryProduceBlock returns null for non-proposer", () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did, validator2.did]);
		expect(new GossipNetwork(producer).tryProduceBlock("did:nobody")).toBeNull();
	});

	it("broadcasts transactions to peers", async () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did]);
		producer.getState().credit(alice.did, 100n * DECIMALS);
		const gossip = new GossipNetwork(producer);
		let txBroadcasted = false;
		gossip.onBroadcastTx = () => { txBroadcasted = true; };

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 1n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		gossip.submitTransaction(tx);
		expect(txBroadcasted).toBe(true);
	});

	it("rebroadcasts gossip txs", async () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did]);
		producer.getState().credit(alice.did, 100n * DECIMALS);
		const gossip = new GossipNetwork(producer);
		let rebroadcasted = false;
		gossip.onBroadcastTx = () => { rebroadcasted = true; };

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 1n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		const { serializeTx } = await import("../src/chain/types.js");
		gossip.handleGossipTx(serializeTx(tx));
		expect(rebroadcasted).toBe(true);
	});

	it("sync request/response works through gossip", () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did, validator2.did]);
		producer.produceBlock(validator2.did);
		const gossip = new GossipNetwork(producer);
		expect(gossip.handleSyncRequest(0).length).toBe(2);
	});

	it("applySyncBlocks works through gossip", () => {
		const dids = [validator1.did, validator2.did];
		const node1 = new NodeBlockProducer(testGenesis());
		node1.initGenesis(dids);
		node1.produceBlock(validator2.did);
		node1.produceBlock(validator1.did);

		const node2 = new NodeBlockProducer(testGenesis());
		node2.initGenesis(dids);
		const gossip2 = new GossipNetwork(node2);
		const blocks = new GossipNetwork(node1).handleSyncRequest(1);
		expect(gossip2.applySyncBlocks(blocks).applied).toBe(2);
	});

	it("getProducer and getSync return internals", () => {
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis([validator1.did]);
		const gossip = new GossipNetwork(producer);
		expect(gossip.getProducer()).toBe(producer);
		expect(gossip.getSync()).toBeDefined();
	});
});

// ── 3-Node Full Integration ──────────────────────────────────────────

describe("3-node gossip integration", () => {
	function wireGossips(gossips: GossipNetwork[]): void {
		for (let i = 0; i < gossips.length; i++) {
			const others = gossips.filter((_, j) => j !== i);
			gossips[i]!.onBroadcastTx = (tx) => {
				for (const o of others) o.handleGossipTx(tx);
			};
			gossips[i]!.onBroadcastBlock = (block) => {
				for (const o of others) o.handleGossipBlock(block);
			};
		}
	}

	it("tx submitted to one node propagates and gets included in blocks on all", async () => {
		const dids = [validator1.did, validator2.did, validator3.did];
		const gossips = dids.map(() => {
			const p = new NodeBlockProducer(testGenesis());
			p.initGenesis(dids);
			p.getState().credit(alice.did, 100n * DECIMALS);
			return new GossipNetwork(p);
		});
		wireGossips(gossips);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 25n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		gossips[0]!.submitTransaction(tx);

		// All mempools have the tx
		for (const g of gossips) {
			expect(g.getProducer().getMempool().readySize).toBe(1);
		}

		// Produce block and propagate
		gossips[0]!.tryProduceBlock(validator2.did);

		// All at height 1 with matching state
		for (const g of gossips) {
			expect(g.getProducer().getHeight()).toBe(1);
			expect(g.getProducer().getState().getBalance(bob.did)).toBe(25n * DECIMALS);
			expect(g.getProducer().getState().getBalance(alice.did)).toBe(75n * DECIMALS);
		}
	});

	it("multi-block propagation across 3 nodes", async () => {
		const dids = [validator1.did, validator2.did, validator3.did];
		const gossips = dids.map(() => {
			const p = new NodeBlockProducer(testGenesis());
			p.initGenesis(dids);
			p.getState().credit(alice.did, 1000n * DECIMALS);
			return new GossipNetwork(p);
		});
		wireGossips(gossips);

		const tx1 = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 10n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		gossips[0]!.submitTransaction(tx1);
		gossips[0]!.tryProduceBlock(validator2.did);

		const tx2 = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 20n * DECIMALS, nonce: 1, timestamp: Date.now(),
		});
		gossips[1]!.submitTransaction(tx2);
		gossips[1]!.tryProduceBlock(validator3.did);

		for (const g of gossips) {
			expect(g.getProducer().getHeight()).toBe(2);
			expect(g.getProducer().getState().getBalance(bob.did)).toBe(30n * DECIMALS);
		}
	});

	it("new node syncs single block from existing network", async () => {
		const dids = [validator1.did, validator2.did, validator3.did];
		const existing = new NodeBlockProducer(testGenesis());
		existing.initGenesis(dids);
		existing.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 5n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		existing.submitTransaction(tx);
		existing.produceBlock(validator2.did);

		const existingGossip = new GossipNetwork(existing);
		const newNode = new NodeBlockProducer(testGenesis());
		newNode.initGenesis(dids);
		newNode.getState().credit(alice.did, 100n * DECIMALS);
		const newGossip = new GossipNetwork(newNode);

		const blocks = existingGossip.handleSyncRequest(1);
		expect(blocks.length).toBe(1);
		expect(newGossip.applySyncBlocks(blocks).applied).toBe(1);
		expect(newNode.getHeight()).toBe(1);
		expect(newNode.getState().getBalance(bob.did)).toBe(
			existing.getState().getBalance(bob.did),
		);
	});
});

// ── Block serialization ──────────────────────────────────────────────

describe("block serialization", () => {
	it("round-trips a block", async () => {
		const dids = [validator1.did, validator2.did];
		const producer = new NodeBlockProducer(testGenesis());
		producer.initGenesis(dids);
		producer.getState().credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer", from: alice.did, to: bob.did,
			amount: 7n * DECIMALS, nonce: 0, timestamp: Date.now(),
		});
		producer.submitTransaction(tx);
		const block = producer.produceBlock(validator2.did)!;

		const deserialized = deserializeBlock(serializeBlock(block));
		expect(deserialized.height).toBe(block.height);
		expect(deserialized.stateRoot).toBe(block.stateRoot);
		expect(deserialized.transactions[0]!.amount).toBe(7n * DECIMALS);
	});
});
