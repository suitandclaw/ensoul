import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	AccountState,
	encodeTxPayload,
	REWARDS_POOL,
	PROTOCOL_TREASURY,
} from "@ensoul/ledger";
import type { GenesisConfig, Transaction, Block } from "@ensoul/ledger";
import { BlockStore } from "../src/chain/store.js";
import { NodeBlockProducer } from "../src/chain/producer.js";
import { GossipNetwork } from "../src/chain/gossip.js";

const DECIMALS = 10n ** 18n;

let tmpDir: string;
let v1: AgentIdentity;
let v2: AgentIdentity;
let v3: AgentIdentity;
let alice: AgentIdentity;
let bob: AgentIdentity;

function testGenesis(): GenesisConfig {
	return {
		chainId: "ensoul-test",
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

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "ensoul-store-test-"));
	v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
	alice = await createIdentity({ seed: new Uint8Array(32).fill(10) });
	bob = await createIdentity({ seed: new Uint8Array(32).fill(11) });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

// ── BlockStore basics ────────────────────────────────────────────────

describe("BlockStore", () => {
	it("stores and retrieves a block by height", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		const block: Block = {
			height: 0,
			previousHash: "0".repeat(64),
			stateRoot: "abc",
			transactionsRoot: "def",
			timestamp: 1700000000000,
			proposer: "genesis",
			transactions: [],
			attestations: [],
		};

		await store.putBlock(0, block);
		const loaded = await store.getBlock(0);
		expect(loaded).not.toBeNull();
		expect(loaded!.height).toBe(0);
		expect(loaded!.proposer).toBe("genesis");
		await store.close();
	});

	it("returns null for missing blocks", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		expect(await store.getBlock(99)).toBeNull();
		await store.close();
	});

	it("stores and retrieves blocks with transactions", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 50n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		const block: Block = {
			height: 1,
			previousHash: "a".repeat(64),
			stateRoot: "b".repeat(64),
			transactionsRoot: "c".repeat(64),
			timestamp: Date.now(),
			proposer: v1.did,
			transactions: [tx],
			attestations: [],
		};

		await store.putBlock(1, block);
		const loaded = await store.getBlock(1);
		expect(loaded!.transactions.length).toBe(1);
		expect(loaded!.transactions[0]!.amount).toBe(50n * DECIMALS);
		expect(loaded!.transactions[0]!.signature.length).toBe(64);
		expect(loaded!.transactions[0]!.from).toBe(alice.did);
		await store.close();
	});

	it("persists and restores account state", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		const state = new AccountState();
		state.credit(alice.did, 500n * DECIMALS);
		state.credit(bob.did, 200n * DECIMALS);
		state.stake(alice.did, 100n * DECIMALS);
		state.incrementNonce(alice.did);

		await store.putAccountState(state);
		const restored = await store.getAccountState();

		expect(restored).not.toBeNull();
		expect(restored!.getBalance(alice.did)).toBe(400n * DECIMALS);
		expect(restored!.getAccount(alice.did).stakedBalance).toBe(100n * DECIMALS);
		expect(restored!.getAccount(alice.did).nonce).toBe(1);
		expect(restored!.getBalance(bob.did)).toBe(200n * DECIMALS);
		await store.close();
	});

	it("returns null for missing account state", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		expect(await store.getAccountState()).toBeNull();
		await store.close();
	});

	it("stores and retrieves metadata", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		await store.putMetadata("height", "42");
		await store.putMetadata("totalEmitted", "100000000000000000000");

		expect(await store.getMetadata("height")).toBe("42");
		expect(await store.getMetadata("totalEmitted")).toBe("100000000000000000000");
		expect(await store.getMetadata("missing")).toBeNull();
		await store.close();
	});

	it("hasChain returns false for empty store", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		expect(await store.hasChain()).toBe(false);
		await store.close();
	});

	it("hasChain returns true after storing a block with height metadata", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		await store.putMetadata("height", "0");
		expect(await store.hasChain()).toBe(true);
		await store.close();
	});

	it("getLatestBlock returns the highest persisted block", async () => {
		const store = new BlockStore(join(tmpDir, "chain"));
		const b0: Block = {
			height: 0, previousHash: "0".repeat(64), stateRoot: "a",
			transactionsRoot: "b", timestamp: 100, proposer: "genesis",
			transactions: [], attestations: [],
		};
		const b1: Block = {
			height: 1, previousHash: "x".repeat(64), stateRoot: "c",
			transactionsRoot: "d", timestamp: 200, proposer: v1.did,
			transactions: [], attestations: [],
		};
		await store.putBlock(0, b0);
		await store.putBlock(1, b1);
		await store.putMetadata("height", "1");

		const latest = await store.getLatestBlock();
		expect(latest).not.toBeNull();
		expect(latest!.height).toBe(1);
		await store.close();
	});
});

// ── NodeBlockProducer with persistent BlockStore ─────────────────────

describe("NodeBlockProducer with BlockStore", () => {
	it("produces blocks and persists them to disk", async () => {
		const storePath = join(tmpDir, "chain");
		const store = new BlockStore(storePath);
		const dids = [v1.did, v2.did, v3.did];

		const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
		await producer.initGenesisAsync(dids);

		// Produce 5 blocks
		for (let i = 0; i < 5; i++) {
			const h = producer.getHeight() + 1;
			const proposer = dids[h % dids.length]!;
			producer.produceBlock(proposer);
			// Wait for each persist to complete
			await new Promise((r) => setTimeout(r, 30));
		}

		// Wait for final persistence
		await new Promise((r) => setTimeout(r, 100));

		expect(producer.getHeight()).toBe(5);

		// Verify blocks are on disk
		for (let h = 0; h <= 5; h++) {
			const block = await store.getBlock(h);
			expect(block).not.toBeNull();
			expect(block!.height).toBe(h);
		}

		// Verify metadata
		expect(await store.getMetadata("height")).toBe("5");
		expect(await store.getMetadata("totalEmitted")).toBeTruthy();

		// Verify account state persisted
		const savedState = await store.getAccountState();
		expect(savedState).not.toBeNull();

		await store.close();
	});

	it("resumes from persisted state on restart", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did, v3.did];

		// First run: produce 10 blocks
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);

			for (let i = 0; i < 10; i++) {
				const h = producer.getHeight() + 1;
				const proposer = dids[h % dids.length]!;
				producer.produceBlock(proposer);
			}
			await new Promise((r) => setTimeout(r, 100));

			expect(producer.getHeight()).toBe(10);
			await store.close();
		}

		// Second run: resume from height 10
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			const result = await producer.initGenesisAsync(dids);

			expect(result.resumed).toBe(true);
			expect(result.height).toBe(10);
			expect(producer.getHeight()).toBe(10);

			// Produce 10 more blocks
			for (let i = 0; i < 10; i++) {
				const h = producer.getHeight() + 1;
				const proposer = dids[h % dids.length]!;
				producer.produceBlock(proposer);
			}
			await new Promise((r) => setTimeout(r, 100));

			expect(producer.getHeight()).toBe(20);

			// Verify continuous chain
			for (let h = 0; h <= 20; h++) {
				const block = producer.getBlock(h);
				expect(block).not.toBeNull();
				expect(block!.height).toBe(h);
			}

			await store.close();
		}
	});

	it("account balances survive restart", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did];

		// First run
		let v1BalanceBeforeRestart: bigint;
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);

			producer.getState().credit(alice.did, 1000n * DECIMALS);
			const tx = await signTx(alice, {
				type: "transfer", from: alice.did, to: bob.did,
				amount: 300n * DECIMALS, nonce: 0, timestamp: Date.now(),
			});
			producer.submitTransaction(tx);
			producer.produceBlock(v2.did);
			await new Promise((r) => setTimeout(r, 100));

			expect(producer.getState().getBalance(alice.did)).toBe(700n * DECIMALS);
			expect(producer.getState().getBalance(bob.did)).toBe(300n * DECIMALS);
			v1BalanceBeforeRestart = producer.getState().getBalance(v1.did);
			await store.close();
		}

		// Second run: balances should survive
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			const result = await producer.initGenesisAsync(dids);

			expect(result.resumed).toBe(true);
			expect(producer.getState().getBalance(alice.did)).toBe(700n * DECIMALS);
			expect(producer.getState().getBalance(bob.did)).toBe(300n * DECIMALS);
			expect(producer.getState().getBalance(v1.did)).toBe(v1BalanceBeforeRestart);
			await store.close();
		}
	});

	it("genesis is only created on first run", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did];

		// First run
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			const result = await producer.initGenesisAsync(dids);
			expect(result.resumed).toBe(false);
			expect(result.height).toBe(0);
			expect(producer.getBlock(0)!.proposer).toBe("genesis");
			await store.close();
		}

		// Second run: should resume, not create new genesis
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			const result = await producer.initGenesisAsync(dids);
			expect(result.resumed).toBe(true);
			expect(producer.getBlock(0)!.proposer).toBe("genesis");
			await store.close();
		}
	});

	it("without BlockStore, behavior is unchanged (in-memory only)", () => {
		const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n });
		const dids = [v1.did, v2.did];
		producer.initGenesis(dids);
		producer.produceBlock(v2.did);
		expect(producer.getHeight()).toBe(1);
	});

	it("blocks with transactions round-trip through persistence", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did];

		// First run: produce block with tx
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);
			producer.getState().credit(alice.did, 500n * DECIMALS);

			const tx = await signTx(alice, {
				type: "transfer", from: alice.did, to: bob.did,
				amount: 100n * DECIMALS, nonce: 0, timestamp: Date.now(),
			});
			producer.submitTransaction(tx);
			producer.produceBlock(v2.did);
			await new Promise((r) => setTimeout(r, 100));
			await store.close();
		}

		// Second run: verify tx in persisted block
		{
			const store = new BlockStore(storePath);
			const block = await store.getBlock(1);
			expect(block).not.toBeNull();
			// 1 user tx + 1 block_reward tx
			expect(block!.transactions.length).toBe(2);
			expect(block!.transactions[0]!.amount).toBe(100n * DECIMALS);
			expect(block!.transactions[0]!.from).toBe(alice.did);
			expect(block!.transactions[0]!.to).toBe(bob.did);
			expect(block!.transactions[0]!.signature.length).toBe(64);
			await store.close();
		}
	});

	it("applied blocks (from peers) are also persisted", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did];

		// Node 1: produce a block
		const producer1 = new NodeBlockProducer(testGenesis(), { minimumStake: 0n });
		producer1.initGenesis(dids);
		const block = producer1.produceBlock(v2.did)!;

		// Node 2: apply the block from node 1
		const store = new BlockStore(storePath);
		const producer2 = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
		await producer2.initGenesisAsync(dids);
		const result = producer2.applyBlock(block);
		expect(result.valid).toBe(true);
		await new Promise((r) => setTimeout(r, 100));

		// Verify persisted
		const persisted = await store.getBlock(1);
		expect(persisted).not.toBeNull();
		expect(persisted!.height).toBe(1);
		expect(persisted!.proposer).toBe(v2.did);
		await store.close();
	});

	it("validator DIDs are preserved across restarts", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did, v3.did];

		// First run
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);
			expect(producer.getValidators()).toEqual(dids);
			await store.close();
		}

		// Second run: validators should be restored from metadata
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			// Pass empty array -- the persisted validators should take precedence
			await producer.initGenesisAsync([]);
			expect(producer.getValidators()).toEqual(dids);
			await store.close();
		}
	});

	it("totalEmitted counter survives restart and continues correctly", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did];

		// First run: produce 3 blocks, each gets emission rewards
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);
			for (let i = 0; i < 3; i++) {
				const h = producer.getHeight() + 1;
				producer.produceBlock(dids[h % dids.length]!);
				// Wait for each persist to complete
				await new Promise((r) => setTimeout(r, 50));
			}
			await new Promise((r) => setTimeout(r, 200));
			await store.close();
		}

		// Second run: produce more blocks, emission should be continuous
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			const result = await producer.initGenesisAsync(dids);
			expect(result.height).toBe(3);

			// The rewards pool should reflect 3 blocks of emission already spent
			const poolBefore = producer.getState().getBalance(REWARDS_POOL);

			const h = producer.getHeight() + 1;
			producer.produceBlock(dids[h % dids.length]!);
			await new Promise((r) => setTimeout(r, 100));

			const poolAfter = producer.getState().getBalance(REWARDS_POOL);
			// Pool should decrease by the block reward (1 ENSL in test genesis)
			expect(poolBefore - poolAfter).toBe(1n * DECIMALS);

			await store.close();
		}
	});

	it("state roots match between original and resumed chain", async () => {
		const storePath = join(tmpDir, "chain");
		const dids = [v1.did, v2.did];

		let stateRootAtHeight5: string;

		// First run
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);
			for (let i = 0; i < 5; i++) {
				const h = producer.getHeight() + 1;
				producer.produceBlock(dids[h % dids.length]!);
			}
			await new Promise((r) => setTimeout(r, 100));
			stateRootAtHeight5 = producer.getState().computeStateRoot();
			await store.close();
		}

		// Second run
		{
			const store = new BlockStore(storePath);
			const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
			await producer.initGenesisAsync(dids);
			const resumedRoot = producer.getState().computeStateRoot();
			expect(resumedRoot).toBe(stateRootAtHeight5);
			await store.close();
		}
	});
});

// ── Full cycle: GossipNetwork with persistence ──────────────────────

describe("GossipNetwork with BlockStore persistence", () => {
	it("gossip-propagated blocks are persisted on all nodes", async () => {
		const dids = [v1.did, v2.did, v3.did];

		const stores = [
			new BlockStore(join(tmpDir, "node0")),
			new BlockStore(join(tmpDir, "node1")),
			new BlockStore(join(tmpDir, "node2")),
		];

		const producers = await Promise.all(
			stores.map(async (store) => {
				const p = new NodeBlockProducer(testGenesis(), { minimumStake: 0n }, store);
				await p.initGenesisAsync(dids);
				return p;
			}),
		);

		const gossips = producers.map((p) => new GossipNetwork(p));

		// Wire gossip
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

		// Produce 3 blocks via gossip
		for (let i = 0; i < 3; i++) {
			const h = producers[0]!.getHeight() + 1;
			const proposer = dids[h % dids.length]!;
			gossips[0]!.tryProduceBlock(proposer);
		}

		await new Promise((r) => setTimeout(r, 200));

		// All nodes at height 3
		for (const p of producers) {
			expect(p.getHeight()).toBe(3);
		}

		// All stores have the blocks
		for (const store of stores) {
			for (let h = 0; h <= 3; h++) {
				const block = await store.getBlock(h);
				expect(block).not.toBeNull();
				expect(block!.height).toBe(h);
			}
			await store.close();
		}
	});
});
