import { describe, it, expect, vi, afterEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	enforcePerIdentityLimit,
	ConsensusWatchdog,
	AdaptiveBlockTime,
	validateBlockLimits,
	estimateBlockSize,
	DEFAULT_BLOCK_LIMITS,
	ValidatorLifecycle,
	EnhancedMempool,
	encodeTxPayload,
} from "../src/index.js";
import type { Transaction, Block } from "../src/index.js";

let alice: AgentIdentity;
let bob: AgentIdentity;

async function setup(): Promise<void> {
	alice = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	bob = await createIdentity({ seed: new Uint8Array(32).fill(2) });
}

async function signTx(
	identity: AgentIdentity,
	partial: Omit<Transaction, "signature">,
): Promise<Transaction> {
	const payload = encodeTxPayload(partial as Transaction);
	const signature = await identity.sign(payload);
	return { ...partial, signature } as Transaction;
}

// ── 1. Per-Identity Rate Limiting ────────────────────────────────────

describe("enforcePerIdentityLimit", () => {
	it("allows up to N txs per identity", async () => {
		await setup();
		const txs: Transaction[] = [];
		for (let i = 0; i < 5; i++) {
			txs.push(
				await signTx(alice, {
					type: "transfer",
					from: alice.did,
					to: bob.did,
					amount: BigInt(i + 1),
					nonce: i,
					timestamp: i,
				}),
			);
		}

		const filtered = enforcePerIdentityLimit(txs, 3);
		expect(filtered.length).toBe(3);
	});

	it("applies limits per identity independently", async () => {
		await setup();
		const txs: Transaction[] = [];
		for (let i = 0; i < 3; i++) {
			txs.push(
				await signTx(alice, {
					type: "transfer",
					from: alice.did,
					to: bob.did,
					amount: 1n,
					nonce: i,
					timestamp: i,
				}),
			);
		}
		for (let i = 0; i < 3; i++) {
			txs.push(
				await signTx(bob, {
					type: "transfer",
					from: bob.did,
					to: alice.did,
					amount: 1n,
					nonce: i,
					timestamp: 100 + i,
				}),
			);
		}

		const filtered = enforcePerIdentityLimit(txs, 2);
		expect(filtered.length).toBe(4); // 2 from alice + 2 from bob
	});

	it("returns all if under limit", async () => {
		await setup();
		const txs = [
			await signTx(alice, {
				type: "transfer",
				from: alice.did,
				to: bob.did,
				amount: 1n,
				nonce: 0,
				timestamp: 0,
			}),
		];
		const filtered = enforcePerIdentityLimit(txs, 10);
		expect(filtered.length).toBe(1);
	});
});

// ── 2. Consensus Watchdog ────────────────────────────────────────────

describe("ConsensusWatchdog", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("initially not timed out", () => {
		const wd = new ConsensusWatchdog(6000);
		expect(wd.isProposerTimedOut()).toBe(false);
	});

	it("times out after 3x expected block time", () => {
		vi.useFakeTimers();
		const wd = new ConsensusWatchdog(6000);
		vi.advanceTimersByTime(18001);
		expect(wd.isProposerTimedOut()).toBe(true);
	});

	it("recordBlock resets timeout", () => {
		vi.useFakeTimers();
		const wd = new ConsensusWatchdog(6000);
		vi.advanceTimersByTime(15000);
		wd.recordBlock();
		expect(wd.isProposerTimedOut()).toBe(false);
	});

	it("skipProposer advances to next", () => {
		const wd = new ConsensusWatchdog(6000);
		expect(wd.getProposerIndex()).toBe(0);
		const next = wd.skipProposer(4);
		expect(next).toBe(1);
		expect(wd.getConsecutiveMisses()).toBe(1);
	});

	it("enters safe mode after 3 consecutive misses", () => {
		const wd = new ConsensusWatchdog(6000);
		expect(wd.isSafeMode()).toBe(false);
		wd.skipProposer(4);
		wd.skipProposer(4);
		expect(wd.isSafeMode()).toBe(false);
		wd.skipProposer(4);
		expect(wd.isSafeMode()).toBe(true);
	});

	it("exits safe mode on successful block", () => {
		const wd = new ConsensusWatchdog(6000);
		wd.skipProposer(4);
		wd.skipProposer(4);
		wd.skipProposer(4);
		expect(wd.isSafeMode()).toBe(true);
		wd.recordBlock();
		expect(wd.isSafeMode()).toBe(false);
		expect(wd.getConsecutiveMisses()).toBe(0);
	});

	it("advanceProposer wraps around", () => {
		const wd = new ConsensusWatchdog(6000);
		wd.advanceProposer(3); // 0 -> 1
		wd.advanceProposer(3); // 1 -> 2
		const next = wd.advanceProposer(3); // 2 -> 0
		expect(next).toBe(0);
	});
});

// ── 3. Adaptive Block Time ───────────────────────────────────────────

describe("AdaptiveBlockTime", () => {
	it("uses min interval when mempool has transactions", () => {
		const abt = new AdaptiveBlockTime(6000, 60000);
		const interval = abt.computeInterval(5);
		expect(interval).toBe(6000);
	});

	it("stretches interval when mempool is empty", () => {
		const abt = new AdaptiveBlockTime(6000, 60000);
		const i1 = abt.computeInterval(0);
		expect(i1).toBe(12000); // 6000 * 2
		const i2 = abt.computeInterval(0);
		expect(i2).toBe(24000); // 12000 * 2
		const i3 = abt.computeInterval(0);
		expect(i3).toBe(48000); // 24000 * 2
		const i4 = abt.computeInterval(0);
		expect(i4).toBe(60000); // capped at max
	});

	it("shrinks back to min when transactions arrive", () => {
		const abt = new AdaptiveBlockTime(6000, 60000);
		abt.computeInterval(0); // 12000
		abt.computeInterval(0); // 24000
		const interval = abt.computeInterval(1);
		expect(interval).toBe(6000);
	});

	it("reduces reward for empty blocks to 10%", () => {
		const abt = new AdaptiveBlockTime();
		const reward = abt.adjustReward(100n, 0);
		expect(reward).toBe(10n); // 10% of 100
	});

	it("full reward for blocks with transactions", () => {
		const abt = new AdaptiveBlockTime();
		const reward = abt.adjustReward(100n, 5);
		expect(reward).toBe(100n);
	});

	it("isEmptyBlockReward detects empty blocks", () => {
		const abt = new AdaptiveBlockTime();
		expect(abt.isEmptyBlockReward(0)).toBe(true);
		expect(abt.isEmptyBlockReward(1)).toBe(false);
	});

	it("getCurrentInterval returns current value", () => {
		const abt = new AdaptiveBlockTime(6000, 60000);
		expect(abt.getCurrentInterval()).toBe(6000);
		abt.computeInterval(0);
		expect(abt.getCurrentInterval()).toBe(12000);
	});
});

// ── 4. Block Limits ──────────────────────────────────────────────────

describe("block limits", () => {
	it("accepts block within limits", () => {
		const block: Block = {
			height: 1,
			previousHash: "a".repeat(64),
			stateRoot: "b".repeat(64),
			transactionsRoot: "c".repeat(64),
			timestamp: Date.now(),
			proposer: "did:test",
			transactions: [],
			attestations: [],
		};
		expect(validateBlockLimits(block).valid).toBe(true);
	});

	it("rejects block with too many transactions", async () => {
		await setup();
		const txs: Transaction[] = [];
		for (let i = 0; i < 600; i++) {
			txs.push(
				await signTx(alice, {
					type: "transfer",
					from: alice.did,
					to: bob.did,
					amount: 1n,
					nonce: i,
					timestamp: i,
				}),
			);
		}

		const block: Block = {
			height: 1,
			previousHash: "a".repeat(64),
			stateRoot: "b".repeat(64),
			transactionsRoot: "c".repeat(64),
			timestamp: Date.now(),
			proposer: "did:test",
			transactions: txs,
			attestations: [],
		};

		const result = validateBlockLimits(block);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Too many transactions");
	});

	it("rejects oversized block", () => {
		const bigData = new Uint8Array(2_000_000);
		const block: Block = {
			height: 1,
			previousHash: "a".repeat(64),
			stateRoot: "b".repeat(64),
			transactionsRoot: "c".repeat(64),
			timestamp: Date.now(),
			proposer: "did:test",
			transactions: [
				{
					type: "transfer",
					from: "did:a",
					to: "did:b",
					amount: 1n,
					nonce: 0,
					timestamp: 0,
					data: bigData,
					signature: new Uint8Array(64),
				},
			],
			attestations: [],
		};

		const result = validateBlockLimits(block);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("too large");
	});

	it("estimateBlockSize returns reasonable values", () => {
		const block: Block = {
			height: 1,
			previousHash: "a".repeat(64),
			stateRoot: "b".repeat(64),
			transactionsRoot: "c".repeat(64),
			timestamp: Date.now(),
			proposer: "did:test",
			transactions: [],
			attestations: [],
		};
		expect(estimateBlockSize(block)).toBeGreaterThan(0);
	});

	it("uses custom limits", async () => {
		await setup();
		const block: Block = {
			height: 1,
			previousHash: "a".repeat(64),
			stateRoot: "b".repeat(64),
			transactionsRoot: "c".repeat(64),
			timestamp: Date.now(),
			proposer: "did:test",
			transactions: [
				await signTx(alice, {
					type: "transfer",
					from: alice.did,
					to: bob.did,
					amount: 1n,
					nonce: 0,
					timestamp: 0,
				}),
				await signTx(alice, {
					type: "transfer",
					from: alice.did,
					to: bob.did,
					amount: 2n,
					nonce: 1,
					timestamp: 1,
				}),
			],
			attestations: [],
		};

		const result = validateBlockLimits(block, {
			maxBlockSizeBytes: 10_000_000,
			maxTransactionsPerBlock: 1, // too low
		});
		expect(result.valid).toBe(false);
	});
});

// ── 5. Validator Join/Exit ───────────────────────────────────────────

describe("ValidatorLifecycle", () => {
	it("unbonding period enforced on exit", () => {
		const vl = new ValidatorLifecycle(100);
		const exitHeight = vl.requestExit("did:v1", 50);
		expect(exitHeight).toBe(150);
		expect(vl.isUnbonding("did:v1")).toBe(true);
		expect(vl.canExit("did:v1", 100)).toBe(false);
		expect(vl.canExit("did:v1", 150)).toBe(true);
	});

	it("completeExit removes from unbonding", () => {
		const vl = new ValidatorLifecycle(100);
		vl.requestExit("did:v1", 0);
		expect(vl.getUnbondingCount()).toBe(1);
		vl.completeExit("did:v1");
		expect(vl.getUnbondingCount()).toBe(0);
		expect(vl.isUnbonding("did:v1")).toBe(false);
	});

	it("canExit returns false for unknown DID", () => {
		const vl = new ValidatorLifecycle(100);
		expect(vl.canExit("did:unknown", 999)).toBe(false);
	});

	it("join queue rate-limits new validators", () => {
		const vl = new ValidatorLifecycle(100, 2);

		const h1 = vl.requestJoin("did:v1", 10);
		const h2 = vl.requestJoin("did:v2", 10);
		const h3 = vl.requestJoin("did:v3", 10);

		// First two can join at height 11, third pushed to 12
		expect(h1).toBe(11);
		expect(h2).toBe(11);
		expect(h3).toBe(12);
		expect(vl.getJoinQueueSize()).toBe(3);
	});

	it("canJoin and completeJoin work", () => {
		const vl = new ValidatorLifecycle(100, 2);
		vl.requestJoin("did:v1", 10);

		expect(vl.canJoin("did:v1", 10)).toBe(false);
		expect(vl.canJoin("did:v1", 11)).toBe(true);
		vl.completeJoin("did:v1");
		expect(vl.getJoinQueueSize()).toBe(0);
	});

	it("canJoin returns false for unknown DID", () => {
		const vl = new ValidatorLifecycle();
		expect(vl.canJoin("did:unknown", 999)).toBe(false);
	});

	it("getUnbondingPeriod returns configured value", () => {
		const vl = new ValidatorLifecycle(200);
		expect(vl.getUnbondingPeriod()).toBe(200);
	});
});

// ── 6. Nonce Gap Handling (Enhanced Mempool) ─────────────────────────

describe("EnhancedMempool", () => {
	it("accepts transaction with current nonce", async () => {
		await setup();
		const pool = new EnhancedMempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});

		const hash = pool.add(tx, 0);
		expect(hash.length).toBe(64);
		expect(pool.readySize).toBe(1);
		expect(pool.futureSize).toBe(0);
	});

	it("holds future-nonce transaction", async () => {
		await setup();
		const pool = new EnhancedMempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 5,
			timestamp: 1000,
		});

		pool.add(tx, 0);
		expect(pool.readySize).toBe(0);
		expect(pool.futureSize).toBe(1);
	});

	it("promotes future tx when gap is filled", async () => {
		await setup();
		const pool = new EnhancedMempool();

		// Add nonce 1 first (future, since current is 0)
		const tx1 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 2n,
			nonce: 1,
			timestamp: 2000,
		});
		pool.add(tx1, 0);
		expect(pool.readySize).toBe(0);
		expect(pool.futureSize).toBe(1);

		// Add nonce 0 (fills the gap)
		const tx0 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		pool.add(tx0, 0);

		// Both should now be ready
		expect(pool.readySize).toBe(2);
		expect(pool.futureSize).toBe(0);
	});

	it("rejects nonce too low", async () => {
		await setup();
		const pool = new EnhancedMempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});

		// Current nonce is 5, tx nonce is 0 (too low)
		expect(() => pool.add(tx, 5)).toThrow("Nonce too low");
	});

	it("rejects duplicate", async () => {
		await setup();
		const pool = new EnhancedMempool();
		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});

		pool.add(tx, 0);
		expect(() => pool.add(tx, 0)).toThrow("Duplicate");
	});

	it("enforces per-identity rate limit", async () => {
		await setup();
		const pool = new EnhancedMempool(10000, 60000, 3);

		for (let i = 0; i < 3; i++) {
			const tx = await signTx(alice, {
				type: "transfer",
				from: alice.did,
				to: bob.did,
				amount: BigInt(i + 1),
				nonce: i,
				timestamp: i * 1000,
			});
			pool.add(tx, i);
		}

		const tx4 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 4n,
			nonce: 3,
			timestamp: 3000,
		});
		expect(() => pool.add(tx4, 3)).toThrow("rate limit");
	});

	it("rejects when full", async () => {
		await setup();
		const pool = new EnhancedMempool(1);
		const tx1 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		pool.add(tx1, 0);

		const tx2 = await signTx(bob, {
			type: "transfer",
			from: bob.did,
			to: alice.did,
			amount: 1n,
			nonce: 0,
			timestamp: 2000,
		});
		expect(() => pool.add(tx2, 0)).toThrow("full");
	});

	it("cleans expired future transactions", async () => {
		await setup();
		const pool = new EnhancedMempool(10000, 1); // 1ms timeout

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 5,
			timestamp: 1000,
		});
		pool.add(tx, 0);
		expect(pool.futureSize).toBe(1);

		await new Promise((r) => setTimeout(r, 10));
		const removed = pool.cleanExpiredFuture();
		expect(removed).toBe(1);
		expect(pool.futureSize).toBe(0);
	});

	it("drain removes from ready queue", async () => {
		await setup();
		const pool = new EnhancedMempool();
		for (let i = 0; i < 5; i++) {
			const tx = await signTx(alice, {
				type: "transfer",
				from: alice.did,
				to: bob.did,
				amount: BigInt(i + 1),
				nonce: i,
				timestamp: i * 1000,
			});
			pool.add(tx, i);
		}

		const batch = pool.drain(3);
		expect(batch.length).toBe(3);
		expect(pool.readySize).toBe(2);
	});

	it("size includes both ready and future", async () => {
		await setup();
		const pool = new EnhancedMempool();
		const tx0 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 1n,
			nonce: 0,
			timestamp: 1000,
		});
		const tx5 = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: bob.did,
			amount: 5n,
			nonce: 5,
			timestamp: 5000,
		});

		pool.add(tx0, 0);
		pool.add(tx5, 0);

		expect(pool.size).toBe(2);
		expect(pool.readySize).toBe(1);
		expect(pool.futureSize).toBe(1);
	});
});
