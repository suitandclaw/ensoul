import type { Transaction, Block } from "./types.js";
import { computeTxHash } from "./transactions.js";

// ── 1. Per-Identity Rate Limiting ────────────────────────────────────

/**
 * Enforce per-identity rate limits within a block.
 * Returns only transactions that fit within the per-sender cap.
 */
export function enforcePerIdentityLimit(
	txs: Transaction[],
	maxPerIdentity: number,
): Transaction[] {
	const counts = new Map<string, number>();
	const allowed: Transaction[] = [];

	for (const tx of txs) {
		const count = counts.get(tx.from) ?? 0;
		if (count < maxPerIdentity) {
			allowed.push(tx);
			counts.set(tx.from, count + 1);
		}
	}

	return allowed;
}

// ── 2. Consensus Watchdog ────────────────────────────────────────────

/**
 * Consensus watchdog: tracks block production timing and triggers
 * proposer skip after timeout, safe mode after consecutive misses.
 */
export class ConsensusWatchdog {
	private expectedBlockTimeMs: number;
	private lastBlockTime: number;
	private consecutiveMisses = 0;
	private safeMode = false;
	private currentProposerIndex = 0;
	private readonly watchdogMultiplier = 3;
	private readonly safeModeThreshold = 3;

	constructor(expectedBlockTimeMs: number) {
		this.expectedBlockTimeMs = expectedBlockTimeMs;
		this.lastBlockTime = Date.now();
	}

	/**
	 * Record that a block was successfully produced.
	 */
	recordBlock(): void {
		this.lastBlockTime = Date.now();
		this.consecutiveMisses = 0;
		if (this.safeMode) {
			this.safeMode = false;
		}
	}

	/**
	 * Check if the current proposer has timed out.
	 */
	isProposerTimedOut(): boolean {
		const elapsed = Date.now() - this.lastBlockTime;
		return elapsed > this.expectedBlockTimeMs * this.watchdogMultiplier;
	}

	/**
	 * Skip to the next proposer. Increments miss counter.
	 */
	skipProposer(validatorCount: number): number {
		this.consecutiveMisses += 1;
		this.lastBlockTime = Date.now();

		if (this.consecutiveMisses >= this.safeModeThreshold) {
			this.safeMode = true;
		}

		this.currentProposerIndex =
			(this.currentProposerIndex + 1) % validatorCount;
		return this.currentProposerIndex;
	}

	/**
	 * Get the current proposer index (round-robin).
	 */
	getProposerIndex(): number {
		return this.currentProposerIndex;
	}

	/**
	 * Advance to next proposer after successful block.
	 */
	advanceProposer(validatorCount: number): number {
		this.currentProposerIndex =
			(this.currentProposerIndex + 1) % validatorCount;
		return this.currentProposerIndex;
	}

	/**
	 * Is the network in safe mode? (Only essential txs processed.)
	 */
	isSafeMode(): boolean {
		return this.safeMode;
	}

	/**
	 * Number of consecutive missed blocks.
	 */
	getConsecutiveMisses(): number {
		return this.consecutiveMisses;
	}
}

// ── 3. Adaptive Block Time ───────────────────────────────────────────

/**
 * Adaptive block time controller.
 * Stretches interval when mempool is empty, shrinks when busy.
 */
export class AdaptiveBlockTime {
	private minIntervalMs: number;
	private maxIntervalMs: number;
	private currentIntervalMs: number;
	/** Fraction of full reward for empty heartbeat blocks. */
	readonly emptyBlockRewardFraction = 10; // 10% of normal reward

	constructor(minIntervalMs = 6000, maxIntervalMs = 60000) {
		this.minIntervalMs = minIntervalMs;
		this.maxIntervalMs = maxIntervalMs;
		this.currentIntervalMs = minIntervalMs;
	}

	/**
	 * Compute the next block interval based on mempool state.
	 */
	computeInterval(mempoolSize: number): number {
		if (mempoolSize > 0) {
			// Transactions pending: use minimum interval
			this.currentIntervalMs = this.minIntervalMs;
		} else {
			// No transactions: double interval, up to max
			this.currentIntervalMs = Math.min(
				this.currentIntervalMs * 2,
				this.maxIntervalMs,
			);
		}
		return this.currentIntervalMs;
	}

	/**
	 * Get the current interval.
	 */
	getCurrentInterval(): number {
		return this.currentIntervalMs;
	}

	/**
	 * Should block reward be reduced (empty heartbeat block)?
	 */
	isEmptyBlockReward(txCount: number): boolean {
		return txCount === 0;
	}

	/**
	 * Compute the actual reward, reduced for empty blocks.
	 */
	adjustReward(baseReward: bigint, txCount: number): bigint {
		if (txCount === 0) {
			return (baseReward * BigInt(this.emptyBlockRewardFraction)) / 100n;
		}
		return baseReward;
	}
}

// ── 4. Block Limits ──────────────────────────────────────────────────

/**
 * Block limits configuration.
 */
export interface BlockLimits {
	/** Maximum block size in bytes. */
	maxBlockSizeBytes: number;
	/** Maximum number of transactions per block. */
	maxTransactionsPerBlock: number;
}

/** Default block limits. */
export const DEFAULT_BLOCK_LIMITS: BlockLimits = {
	maxBlockSizeBytes: 1_000_000, // 1MB
	maxTransactionsPerBlock: 500,
};

/**
 * Estimate the size of a block in bytes (rough approximation).
 */
export function estimateBlockSize(block: Block): number {
	let size = 200; // header overhead
	for (const tx of block.transactions) {
		size += 200 + tx.signature.length + (tx.data?.length ?? 0);
	}
	for (const att of block.attestations) {
		size += 100 + att.signature.length;
	}
	return size;
}

/**
 * Validate block against size and transaction limits.
 */
export function validateBlockLimits(
	block: Block,
	limits: BlockLimits = DEFAULT_BLOCK_LIMITS,
): { valid: boolean; error?: string } {
	if (block.transactions.length > limits.maxTransactionsPerBlock) {
		return {
			valid: false,
			error: `Too many transactions: ${block.transactions.length} > ${limits.maxTransactionsPerBlock}`,
		};
	}

	const size = estimateBlockSize(block);
	if (size > limits.maxBlockSizeBytes) {
		return {
			valid: false,
			error: `Block too large: ${size} > ${limits.maxBlockSizeBytes} bytes`,
		};
	}

	return { valid: true };
}

// ── 5. Validator Join/Exit ───────────────────────────────────────────

/**
 * Validator lifecycle manager.
 * Handles unbonding periods for exits and join queue rate limiting.
 */
export class ValidatorLifecycle {
	/** DIDs currently unbonding, with the block at which they can fully exit. */
	private unbonding: Map<string, number> = new Map();
	/** DIDs in the join queue, with the block at which they can enter. */
	private joinQueue: Map<string, number> = new Map();
	/** Number of blocks before unstaked tokens are released. */
	private unbondingPeriod: number;
	/** Maximum validators that can join per block. */
	private maxJoinsPerBlock: number;

	constructor(unbondingPeriod = 100, maxJoinsPerBlock = 2) {
		this.unbondingPeriod = unbondingPeriod;
		this.maxJoinsPerBlock = maxJoinsPerBlock;
	}

	/**
	 * Request to exit the validator set. Starts unbonding.
	 */
	requestExit(did: string, currentHeight: number): number {
		const exitHeight = currentHeight + this.unbondingPeriod;
		this.unbonding.set(did, exitHeight);
		return exitHeight;
	}

	/**
	 * Check if a validator has completed unbonding.
	 */
	canExit(did: string, currentHeight: number): boolean {
		const exitHeight = this.unbonding.get(did);
		if (exitHeight === undefined) return false;
		return currentHeight >= exitHeight;
	}

	/**
	 * Complete the exit, removing from unbonding set.
	 */
	completeExit(did: string): boolean {
		return this.unbonding.delete(did);
	}

	/**
	 * Is a validator currently unbonding?
	 */
	isUnbonding(did: string): boolean {
		return this.unbonding.has(did);
	}

	/**
	 * Request to join the validator set. Queued for rate limiting.
	 */
	requestJoin(did: string, currentHeight: number): number {
		// Find the earliest block where a join slot is available
		const queuedHeights = [...this.joinQueue.values()];
		const slotsPerHeight = new Map<number, number>();
		for (const h of queuedHeights) {
			slotsPerHeight.set(h, (slotsPerHeight.get(h) ?? 0) + 1);
		}

		let targetHeight = currentHeight + 1;
		while (
			(slotsPerHeight.get(targetHeight) ?? 0) >= this.maxJoinsPerBlock
		) {
			targetHeight++;
		}

		this.joinQueue.set(did, targetHeight);
		return targetHeight;
	}

	/**
	 * Check if a validator can join at the current height.
	 */
	canJoin(did: string, currentHeight: number): boolean {
		const joinHeight = this.joinQueue.get(did);
		if (joinHeight === undefined) return false;
		return currentHeight >= joinHeight;
	}

	/**
	 * Complete the join, removing from queue.
	 */
	completeJoin(did: string): boolean {
		return this.joinQueue.delete(did);
	}

	/**
	 * Get the unbonding period.
	 */
	getUnbondingPeriod(): number {
		return this.unbondingPeriod;
	}

	/**
	 * Number of validators currently unbonding.
	 */
	getUnbondingCount(): number {
		return this.unbonding.size;
	}

	/**
	 * Number of validators in the join queue.
	 */
	getJoinQueueSize(): number {
		return this.joinQueue.size;
	}
}

// ── 6. Nonce Gap Handling ────────────────────────────────────────────

/**
 * Enhanced mempool that holds future-nonce transactions
 * rather than rejecting them, with a timeout for gap resolution.
 */
export class EnhancedMempool {
	private ready: Map<string, Transaction> = new Map();
	private futureByFrom: Map<
		string,
		Map<number, { tx: Transaction; hash: string; addedAt: number }>
	> = new Map();
	private maxSize: number;
	private gapTimeoutMs: number;
	private maxPerIdentity: number;

	constructor(
		maxSize = 10000,
		gapTimeoutMs = 60000,
		maxPerIdentity = 10,
	) {
		this.maxSize = maxSize;
		this.gapTimeoutMs = gapTimeoutMs;
		this.maxPerIdentity = maxPerIdentity;
	}

	/**
	 * Add a transaction. If its nonce is ahead of what's expected,
	 * hold it in the future queue instead of rejecting.
	 *
	 * @param tx The transaction
	 * @param currentNonce The sender's current nonce from account state
	 * @returns The transaction hash
	 */
	add(tx: Transaction, currentNonce: number): string {
		const totalSize = this.ready.size + this.totalFutureCount();
		if (totalSize >= this.maxSize) {
			throw new Error("Mempool full");
		}

		const hash = computeTxHash(tx);
		if (this.ready.has(hash)) {
			throw new Error("Duplicate transaction");
		}

		// Check per-identity rate limit
		const senderReadyCount = this.countReadyBySender(tx.from);
		const senderFutureCount = this.countFutureBySender(tx.from);
		if (senderReadyCount + senderFutureCount >= this.maxPerIdentity) {
			throw new Error("Per-identity rate limit exceeded");
		}

		if (tx.nonce === currentNonce) {
			this.ready.set(hash, tx);
			// Check if any future txs are now promotable
			this.promoteFromFuture(tx.from, currentNonce + 1);
		} else if (tx.nonce > currentNonce) {
			// Future nonce: hold for gap resolution
			let senderFuture = this.futureByFrom.get(tx.from);
			if (!senderFuture) {
				senderFuture = new Map();
				this.futureByFrom.set(tx.from, senderFuture);
			}
			senderFuture.set(tx.nonce, {
				tx,
				hash,
				addedAt: Date.now(),
			});
		} else {
			throw new Error("Nonce too low (already processed)");
		}

		return hash;
	}

	/**
	 * Promote future transactions that now have consecutive nonces.
	 */
	private promoteFromFuture(from: string, nextNonce: number): void {
		const senderFuture = this.futureByFrom.get(from);
		if (!senderFuture) return;

		let nonce = nextNonce;
		while (senderFuture.has(nonce)) {
			const entry = senderFuture.get(nonce)!;
			this.ready.set(entry.hash, entry.tx);
			senderFuture.delete(nonce);
			nonce++;
		}

		if (senderFuture.size === 0) {
			this.futureByFrom.delete(from);
		}
	}

	/**
	 * Clean up timed-out future transactions.
	 */
	cleanExpiredFuture(): number {
		const now = Date.now();
		let removed = 0;

		for (const [from, senderFuture] of this.futureByFrom) {
			for (const [nonce, entry] of senderFuture) {
				if (now - entry.addedAt > this.gapTimeoutMs) {
					senderFuture.delete(nonce);
					removed++;
				}
			}
			if (senderFuture.size === 0) {
				this.futureByFrom.delete(from);
			}
		}

		return removed;
	}

	/**
	 * Get all ready transactions.
	 */
	getReady(): Transaction[] {
		return [...this.ready.values()].sort(
			(a, b) => a.timestamp - b.timestamp,
		);
	}

	/**
	 * Drain up to `limit` ready transactions.
	 */
	drain(limit: number): Transaction[] {
		const all = this.getReady();
		const batch = all.slice(0, limit);
		for (const tx of batch) {
			this.ready.delete(computeTxHash(tx));
		}
		return batch;
	}

	/**
	 * Number of ready transactions.
	 */
	get readySize(): number {
		return this.ready.size;
	}

	/**
	 * Number of future (held) transactions.
	 */
	get futureSize(): number {
		return this.totalFutureCount();
	}

	/**
	 * Total size (ready + future).
	 */
	get size(): number {
		return this.ready.size + this.totalFutureCount();
	}

	private totalFutureCount(): number {
		let count = 0;
		for (const m of this.futureByFrom.values()) {
			count += m.size;
		}
		return count;
	}

	private countReadyBySender(from: string): number {
		let count = 0;
		for (const tx of this.ready.values()) {
			if (tx.from === from) count++;
		}
		return count;
	}

	private countFutureBySender(from: string): number {
		return this.futureByFrom.get(from)?.size ?? 0;
	}
}
