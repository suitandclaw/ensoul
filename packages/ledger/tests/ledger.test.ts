import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	AccountState,
	Mempool,
	BlockProducer,
	computeTxHash,
	encodeTxPayload,
	validateTransaction,
	applyTransaction,
	computeBlockHash,
	computeTransactionsRoot,
	computeBlockReward,
	createDefaultGenesis,
	validateGenesis,
	PROTOCOL_TREASURY,
	BURN_ADDRESS,
	REWARDS_POOL,
} from "../src/index.js";
import type { Transaction, GenesisConfig } from "../src/index.js";

const DECIMALS = 10n ** 18n;

let alice: AgentIdentity;
let bob: AgentIdentity;

beforeEach(async () => {
	alice = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	bob = await createIdentity({ seed: new Uint8Array(32).fill(2) });
});

async function signTx(
	identity: AgentIdentity,
	tx: Omit<Transaction, "signature">,
): Promise<Transaction> {
	const payload = encodeTxPayload(tx as Transaction);
	const signature = await identity.sign(payload);
	return { ...tx, signature } as Transaction;
}

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

// ── AccountState ─────────────────────────────────────────────────────

describe("AccountState", () => {
	it("returns zero-balance for unknown account", () => {
		const state = new AccountState();
		const acc = state.getAccount("did:unknown");
		expect(acc.balance).toBe(0n);
		expect(acc.nonce).toBe(0);
	});

	it("credits and debits", () => {
		const state = new AccountState();
		state.credit("did:a", 100n);
		expect(state.getBalance("did:a")).toBe(100n);
		state.debit("did:a", 30n);
		expect(state.getBalance("did:a")).toBe(70n);
	});

	it("debit throws on insufficient balance", () => {
		const state = new AccountState();
		state.credit("did:a", 10n);
		expect(() => state.debit("did:a", 20n)).toThrow("Insufficient");
	});

	it("stake and unstake", () => {
		const state = new AccountState();
		state.credit("did:v", 100n);
		state.stake("did:v", 60n);
		expect(state.getBalance("did:v")).toBe(40n);
		expect(state.getAccount("did:v").stakedBalance).toBe(60n);
		state.unstake("did:v", 20n);
		expect(state.getBalance("did:v")).toBe(60n);
		expect(state.getAccount("did:v").stakedBalance).toBe(40n);
	});

	it("stake throws on insufficient balance", () => {
		const state = new AccountState();
		state.credit("did:v", 10n);
		expect(() => state.stake("did:v", 20n)).toThrow("Insufficient");
	});

	it("unstake throws on insufficient staked balance", () => {
		const state = new AccountState();
		state.credit("did:v", 100n);
		state.stake("did:v", 50n);
		expect(() => state.unstake("did:v", 60n)).toThrow("Insufficient");
	});

	it("slash reduces staked balance", () => {
		const state = new AccountState();
		state.credit("did:v", 100n);
		state.stake("did:v", 80n);
		const slashed = state.slash("did:v", 30n);
		expect(slashed).toBe(30n);
		expect(state.getAccount("did:v").stakedBalance).toBe(50n);
	});

	it("slash caps at available staked balance", () => {
		const state = new AccountState();
		state.credit("did:v", 100n);
		state.stake("did:v", 20n);
		const slashed = state.slash("did:v", 50n);
		expect(slashed).toBe(20n);
		expect(state.getAccount("did:v").stakedBalance).toBe(0n);
	});

	it("storage credits", () => {
		const state = new AccountState();
		state.addStorageCredits("did:a", 50n);
		expect(state.getAccount("did:a").storageCredits).toBe(50n);
	});

	it("nonce increments", () => {
		const state = new AccountState();
		state.credit("did:a", 100n);
		expect(state.getAccount("did:a").nonce).toBe(0);
		state.incrementNonce("did:a");
		expect(state.getAccount("did:a").nonce).toBe(1);
	});

	it("computeStateRoot is deterministic", () => {
		const s1 = new AccountState();
		s1.credit("did:a", 100n);
		s1.credit("did:b", 200n);

		const s2 = new AccountState();
		s2.credit("did:a", 100n);
		s2.credit("did:b", 200n);

		expect(s1.computeStateRoot()).toBe(s2.computeStateRoot());
	});

	it("clone creates independent copy", () => {
		const state = new AccountState();
		state.credit("did:a", 100n);
		const copy = state.clone();
		copy.credit("did:a", 50n);
		expect(state.getBalance("did:a")).toBe(100n);
		expect(copy.getBalance("did:a")).toBe(150n);
	});

	it("getAllAccounts returns all", () => {
		const state = new AccountState();
		state.credit("did:a", 100n);
		state.credit("did:b", 200n);
		expect(state.getAllAccounts().length).toBe(2);
	});

	it("hasAccount", () => {
		const state = new AccountState();
		expect(state.hasAccount("did:a")).toBe(false);
		state.credit("did:a", 1n);
		expect(state.hasAccount("did:a")).toBe(true);
	});
});

// ── Transaction validation ───────────────────────────────────────────

describe("transaction validation", () => {
	it("validates a transfer", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});

		const result = validateTransaction(tx, state);
		expect(result.valid).toBe(true);
	});

	it("rejects transfer with insufficient balance", async () => {
		const state = new AccountState();
		state.credit(alice.did, 10n);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});

		const result = validateTransaction(tx, state);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Insufficient");
	});

	it("rejects transfer to self", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: alice.did,
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
		});

		const result = validateTransaction(tx, state);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("self");
	});

	it("rejects wrong nonce", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 5,
			timestamp: Date.now(),
		});

		const result = validateTransaction(tx, state);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("nonce");
	});

	it("rejects invalid signature length", () => {
		const state = new AccountState();
		state.credit("did:a", 100n);

		const tx: Transaction = {
			type: "transfer",
			from: "did:a",
			to: "did:b",
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
			signature: new Uint8Array(32),
		};

		const result = validateTransaction(tx, state);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("signature");
	});

	it("validates burn to burn address", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "burn",
			from: alice.did,
			to: BURN_ADDRESS,
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
		});

		expect(validateTransaction(tx, state).valid).toBe(true);
	});

	it("rejects burn to non-burn address", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "burn",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
		});

		expect(validateTransaction(tx, state).valid).toBe(false);
	});

	it("rejects slash from non-protocol", async () => {
		const state = new AccountState();

		const tx = await signTx(alice, {
			type: "slash",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
		});

		expect(validateTransaction(tx, state).valid).toBe(false);
		expect(validateTransaction(tx, state).error).toContain("protocol");
	});

	it("rejects negative amount", async () => {
		const state = new AccountState();

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: -1n,
			nonce: 0,
			timestamp: Date.now(),
		});

		expect(validateTransaction(tx, state).valid).toBe(false);
	});

	it("validates stake transaction", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);
		const tx = await signTx(alice, {
			type: "stake",
			from: alice.did,
			to: alice.did,
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(true);
	});

	it("rejects stake with insufficient balance", async () => {
		const state = new AccountState();
		state.credit(alice.did, 10n);
		const tx = await signTx(alice, {
			type: "stake",
			from: alice.did,
			to: alice.did,
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(false);
	});

	it("validates unstake transaction", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);
		state.stake(alice.did, 50n);
		const tx = await signTx(alice, {
			type: "unstake",
			from: alice.did,
			to: alice.did,
			amount: 30n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(true);
	});

	it("rejects unstake with insufficient staked", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);
		state.stake(alice.did, 20n);
		const tx = await signTx(alice, {
			type: "unstake",
			from: alice.did,
			to: alice.did,
			amount: 30n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(false);
	});

	it("validates storage_payment", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);
		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: "did:node",
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(true);
	});

	it("rejects storage_payment with insufficient balance", async () => {
		const state = new AccountState();
		state.credit(alice.did, 10n);
		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: "did:node",
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(false);
	});

	it("rejects burn with insufficient balance", async () => {
		const state = new AccountState();
		state.credit(alice.did, 10n);
		const tx = await signTx(alice, {
			type: "burn",
			from: alice.did,
			to: BURN_ADDRESS,
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});
		expect(validateTransaction(tx, state).valid).toBe(false);
	});
});

describe("verifyTxSignature", () => {
	it("verifies a valid signature", async () => {
		const { verifyTxSignature } = await import("../src/index.js");
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: 1000,
		});
		const valid = await verifyTxSignature(tx, alice.publicKey);
		expect(valid).toBe(true);
	});

	it("rejects signature from wrong key", async () => {
		const { verifyTxSignature } = await import("../src/index.js");
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: 1000,
		});
		const valid = await verifyTxSignature(tx, bob.publicKey);
		expect(valid).toBe(false);
	});
});

// ── Transaction application ──────────────────────────────────────────

describe("applyTransaction", () => {
	it("transfer moves balance", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 40n,
			nonce: 0,
			timestamp: Date.now(),
		});

		applyTransaction(tx, state, 10);
		expect(state.getBalance(alice.did)).toBe(60n);
		expect(state.getBalance(bob.did)).toBe(40n);
		expect(state.getAccount(alice.did).nonce).toBe(1);
	});

	it("storage_payment splits fees", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: "did:node:operator",
			amount: 100n,
			nonce: 0,
			timestamp: Date.now(),
		});

		applyTransaction(tx, state, 10);
		expect(state.getBalance(PROTOCOL_TREASURY)).toBe(10n); // 10%
		expect(state.getBalance("did:node:operator")).toBe(90n); // 90%
		expect(state.getAccount(alice.did).storageCredits).toBe(100n);
	});

	it("burn removes tokens permanently", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "burn",
			from: alice.did,
			to: BURN_ADDRESS,
			amount: 30n,
			nonce: 0,
			timestamp: Date.now(),
		});

		applyTransaction(tx, state, 10);
		expect(state.getBalance(alice.did)).toBe(70n);
		expect(state.getBalance(BURN_ADDRESS)).toBe(0n);
	});

	it("reward_claim transfers from pool", async () => {
		const state = new AccountState();
		state.credit(REWARDS_POOL, 1000n);

		const tx = await signTx(alice, {
			type: "reward_claim",
			from: alice.did,
			to: alice.did,
			amount: 50n,
			nonce: 0,
			timestamp: Date.now(),
		});

		applyTransaction(tx, state, 10);
		expect(state.getBalance(alice.did)).toBe(50n);
		expect(state.getBalance(REWARDS_POOL)).toBe(950n);
	});

	it("stake locks tokens", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);
		const tx = await signTx(alice, {
			type: "stake",
			from: alice.did,
			to: alice.did,
			amount: 60n,
			nonce: 0,
			timestamp: Date.now(),
		});
		applyTransaction(tx, state, 10);
		expect(state.getBalance(alice.did)).toBe(40n);
		expect(state.getAccount(alice.did).stakedBalance).toBe(60n);
	});

	it("unstake unlocks tokens", async () => {
		const state = new AccountState();
		state.credit(alice.did, 100n);
		state.stake(alice.did, 60n);
		const tx = await signTx(alice, {
			type: "unstake",
			from: alice.did,
			to: alice.did,
			amount: 20n,
			nonce: 0,
			timestamp: Date.now(),
		});
		applyTransaction(tx, state, 10);
		expect(state.getBalance(alice.did)).toBe(60n);
		expect(state.getAccount(alice.did).stakedBalance).toBe(40n);
	});

	it("slash removes staked tokens", async () => {
		const state = new AccountState();
		state.credit(bob.did, 100n);
		state.stake(bob.did, 80n);
		state.credit(PROTOCOL_TREASURY, 0n);
		const tx: Transaction = {
			type: "slash",
			from: PROTOCOL_TREASURY,
			to: bob.did,
			amount: 30n,
			nonce: 0,
			timestamp: Date.now(),
			signature: new Uint8Array(64),
		};
		applyTransaction(tx, state, 10);
		expect(state.getAccount(bob.did).stakedBalance).toBe(50n);
	});
});

// ── Mempool ──────────────────────────────────────────────────────────

describe("Mempool", () => {
	it("adds and retrieves transactions", async () => {
		const pool = new Mempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
		});

		const hash = pool.add(tx);
		expect(hash.length).toBe(64);
		expect(pool.size).toBe(1);
		expect(pool.get(hash)).not.toBeNull();
	});

	it("rejects duplicates", async () => {
		const pool = new Mempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: 1000,
		});

		pool.add(tx);
		expect(() => pool.add(tx)).toThrow("Duplicate");
	});

	it("rejects when full", async () => {
		const pool = new Mempool(1);
		const tx1 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		pool.add(tx1);

		const tx2 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 2n,
			nonce: 1,
			timestamp: 2000,
		});
		expect(() => pool.add(tx2)).toThrow("full");
	});

	it("drain removes transactions", async () => {
		const pool = new Mempool();
		for (let i = 0; i < 5; i++) {
			const tx = await signTx(alice, {
				type: "transfer",
				from: alice.did,
				to: bob.did,
				amount: BigInt(i + 1),
				nonce: i,
				timestamp: i * 1000,
			});
			pool.add(tx);
		}

		const batch = pool.drain(3);
		expect(batch.length).toBe(3);
		expect(pool.size).toBe(2);
	});

	it("clear empties the pool", async () => {
		const pool = new Mempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		pool.add(tx);
		pool.clear();
		expect(pool.size).toBe(0);
	});

	it("remove by hash", async () => {
		const pool = new Mempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		const hash = pool.add(tx);
		expect(pool.remove(hash)).toBe(true);
		expect(pool.size).toBe(0);
	});
});

// ── Block production ─────────────────────────────────────────────────

describe("BlockProducer", () => {
	it("initializes genesis block with allocations", () => {
		const config = testGenesis();
		const state = new AccountState();
		const pool = new Mempool();
		const producer = new BlockProducer(state, pool, config);

		const genesis = producer.initGenesis();
		expect(genesis.height).toBe(0);
		expect(genesis.previousHash).toBe("0".repeat(64));
		expect(genesis.proposer).toBe("genesis");
		expect(genesis.transactions.length).toBe(0);

		// Check allocations were distributed
		expect(state.getBalance("did:test:foundation")).toBe(
			150n * DECIMALS,
		);
		expect(state.getBalance(REWARDS_POOL)).toBe(500n * DECIMALS);
		expect(state.getBalance(PROTOCOL_TREASURY)).toBe(100n * DECIMALS);
	});

	it("produces blocks with transactions", async () => {
		const config = testGenesis();
		const state = new AccountState();
		const pool = new Mempool();
		const producer = new BlockProducer(state, pool, config);
		producer.initGenesis();

		// Fund alice from foundation
		state.credit(alice.did, 100n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});
		pool.add(tx);

		const block = producer.produceBlock("did:proposer");
		expect(block.height).toBe(1);
		expect(block.transactions.length).toBe(1);
		expect(block.proposer).toBe("did:proposer");
		expect(block.stateRoot).toBeTruthy();

		expect(state.getBalance(bob.did)).toBe(10n * DECIMALS);
	});

	it("block reward goes to proposer from rewards pool", () => {
		const config = testGenesis();
		const state = new AccountState();
		const pool = new Mempool();
		const producer = new BlockProducer(state, pool, config);
		producer.initGenesis();

		const proposer = "did:validator:1";
		producer.produceBlock(proposer);

		expect(state.getBalance(proposer)).toBe(config.emissionPerBlock);
		expect(producer.getTotalEmitted()).toBe(config.emissionPerBlock);
	});

	it("validates a correctly produced block", async () => {
		const config = testGenesis();
		const state = new AccountState();
		const pool = new Mempool();
		const producer = new BlockProducer(state, pool, config);
		producer.initGenesis();

		// Clone state AFTER genesis so both have same base
		const stateCopy = state.clone();
		const validator = new BlockProducer(
			stateCopy,
			new Mempool(),
			config,
		);
		// Manually set genesis block on validator
		validator.initGenesis();
		// stateCopy now has double genesis allocations — rebuild cleanly
		const state2 = new AccountState();
		const validator2 = new BlockProducer(
			state2,
			new Mempool(),
			config,
		);
		validator2.initGenesis();

		// Fund alice on both states
		state.credit(alice.did, 100n);
		state2.credit(alice.did, 100n);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: Date.now(),
		});
		pool.add(tx);

		const block = producer.produceBlock("did:proposer");
		const result = validator2.validateBlock(block);
		expect(result.valid).toBe(true);
	});

	it("rejects block with wrong height", () => {
		const config = testGenesis();
		const state = new AccountState();
		const producer = new BlockProducer(state, new Mempool(), config);
		producer.initGenesis();

		const fakeBlock = {
			height: 5,
			previousHash: "x",
			stateRoot: "y",
			transactionsRoot: "z",
			timestamp: Date.now(),
			proposer: "did:fake",
			transactions: [],
			attestations: [],
		};

		const result = producer.validateBlock(fakeBlock);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("height");
	});

	it("rejects block with wrong previous hash", () => {
		const config = testGenesis();
		const state = new AccountState();
		const producer = new BlockProducer(state, new Mempool(), config);
		producer.initGenesis();

		const genesis = producer.getBlock(0)!;
		const fakeBlock = {
			height: 1,
			previousHash: "wrong_hash",
			stateRoot: "",
			transactionsRoot: computeTransactionsRoot([]),
			timestamp: Date.now(),
			proposer: "did:fake",
			transactions: [],
			attestations: [],
		};

		const result = producer.validateBlock(fakeBlock);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("previous hash");
	});

	it("getBlock and getLatestBlock work", () => {
		const config = testGenesis();
		const state = new AccountState();
		const producer = new BlockProducer(state, new Mempool(), config);
		producer.initGenesis();
		producer.produceBlock("did:p");

		expect(producer.getBlock(0)?.height).toBe(0);
		expect(producer.getBlock(1)?.height).toBe(1);
		expect(producer.getBlock(99)).toBeNull();
		expect(producer.getLatestBlock()?.height).toBe(1);
		expect(producer.getHeight()).toBe(1);
	});
});

// ── Genesis ──────────────────────────────────────────────────────────

describe("genesis", () => {
	it("default genesis has correct allocations", () => {
		const genesis = createDefaultGenesis();
		expect(genesis.totalSupply).toBe(1_000_000_000n * DECIMALS);
		expect(genesis.allocations.length).toBe(7);

		const result = validateGenesis(genesis);
		expect(result.valid).toBe(true);
	});

	it("validateGenesis rejects wrong percentage sum", () => {
		const config = testGenesis();
		config.allocations[0]!.percentage = 99;
		const result = validateGenesis(config);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("100%");
	});

	it("validateGenesis rejects wrong token sum", () => {
		const config = testGenesis();
		config.allocations[0]!.tokens = 999n * DECIMALS;
		const result = validateGenesis(config);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("total supply");
	});
});

// ── Emission schedule ────────────────────────────────────────────────

describe("emission schedule", () => {
	it("reward declines over time", () => {
		const base = 19n * DECIMALS;
		const r0 = computeBlockReward(0, base, 5_256_000, 500n * DECIMALS, 0n);
		const r1 = computeBlockReward(5_256_000, base, 5_256_000, 500n * DECIMALS, 100n * DECIMALS);
		expect(r1).toBeLessThan(r0);
	});

	it("reward is zero when pool exhausted", () => {
		const base = 100n;
		const reward = computeBlockReward(0, base, 1000, 100n, 100n);
		expect(reward).toBe(0n);
	});

	it("reward capped at remaining pool", () => {
		const reward = computeBlockReward(0, 100n, 1000, 50n, 45n);
		expect(reward).toBeLessThanOrEqual(5n);
	});
});

// ── Protocol fee splitting ───────────────────────────────────────────

describe("protocol fee splitting", () => {
	it("10% to treasury, 90% to operator", async () => {
		const state = new AccountState();
		state.credit(alice.did, 1000n);

		const tx = await signTx(alice, {
			type: "storage_payment",
			from: alice.did,
			to: "did:node:op",
			amount: 1000n,
			nonce: 0,
			timestamp: Date.now(),
		});

		applyTransaction(tx, state, 10);
		expect(state.getBalance(PROTOCOL_TREASURY)).toBe(100n);
		expect(state.getBalance("did:node:op")).toBe(900n);
	});
});

// ── Hashing ──────────────────────────────────────────────────────────

describe("hashing", () => {
	it("computeTxHash is deterministic", async () => {
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 10n,
			nonce: 0,
			timestamp: 1000,
		});
		expect(computeTxHash(tx)).toBe(computeTxHash(tx));
	});

	it("computeBlockHash is deterministic", () => {
		const config = testGenesis();
		const state = new AccountState();
		const producer = new BlockProducer(state, new Mempool(), config);
		const genesis = producer.initGenesis();
		expect(computeBlockHash(genesis)).toBe(computeBlockHash(genesis));
	});

	it("different transactions produce different hashes", async () => {
		const tx1 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		const tx2 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 2n,
			nonce: 0,
			timestamp: 1000,
		});
		expect(computeTxHash(tx1)).not.toBe(computeTxHash(tx2));
	});
});
