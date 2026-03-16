import type { Transaction } from "./types.js";
import { computeTxHash } from "./transactions.js";

/**
 * Transaction mempool: a queue of pending transactions awaiting block inclusion.
 * Orders by nonce per sender to ensure sequential processing.
 */
export class Mempool {
	private pending: Map<string, Transaction> = new Map();
	private maxSize: number;

	constructor(maxSize = 10000) {
		this.maxSize = maxSize;
	}

	/**
	 * Add a transaction to the mempool.
	 * @returns The transaction hash.
	 * @throws If the mempool is full or the transaction is a duplicate.
	 */
	add(tx: Transaction): string {
		if (this.pending.size >= this.maxSize) {
			throw new Error("Mempool full");
		}

		const hash = computeTxHash(tx);
		if (this.pending.has(hash)) {
			throw new Error("Duplicate transaction");
		}

		this.pending.set(hash, tx);
		return hash;
	}

	/**
	 * Get a transaction by hash.
	 */
	get(hash: string): Transaction | null {
		return this.pending.get(hash) ?? null;
	}

	/**
	 * Remove a transaction by hash.
	 */
	remove(hash: string): boolean {
		return this.pending.delete(hash);
	}

	/**
	 * Get all pending transactions, sorted by timestamp.
	 */
	getAll(): Transaction[] {
		return [...this.pending.values()].sort(
			(a, b) => a.timestamp - b.timestamp,
		);
	}

	/**
	 * Drain up to `limit` transactions from the mempool (removes them).
	 */
	drain(limit: number): Transaction[] {
		const all = this.getAll();
		const batch = all.slice(0, limit);

		for (const tx of batch) {
			const hash = computeTxHash(tx);
			this.pending.delete(hash);
		}

		return batch;
	}

	/**
	 * Number of pending transactions.
	 */
	get size(): number {
		return this.pending.size;
	}

	/**
	 * Clear all pending transactions.
	 */
	clear(): void {
		this.pending.clear();
	}
}
