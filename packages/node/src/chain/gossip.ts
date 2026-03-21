import type { Transaction, Block } from "@ensoul/ledger";
import { computeTxHash } from "@ensoul/ledger";
import type { NodeBlockProducer } from "./producer.js";
import { BlockSync } from "./sync.js";
import {
	serializeBlock,
	serializeTx,
	deserializeTx,
} from "./types.js";
import type { SerializedBlock, SerializedTx } from "./types.js";

/**
 * Gossip network layer for block and transaction propagation.
 * Manages deduplication and broadcast callbacks.
 * In production, this wires to libp2p gossipsub topics.
 */
export class GossipNetwork {
	private producer: NodeBlockProducer;
	private sync: BlockSync;
	private seenTxHashes: Set<string> = new Set();
	private seenBlockHeights: Set<number> = new Set();
	private maxSeenCache = 10000;

	/** External callback: broadcast a serialized block to peers. */
	onBroadcastBlock:
		| ((block: SerializedBlock) => void)
		| null = null;

	/** External callback: broadcast a serialized tx to peers. */
	onBroadcastTx: ((tx: SerializedTx) => void) | null = null;

	constructor(producer: NodeBlockProducer) {
		this.producer = producer;
		this.sync = new BlockSync(producer);

		// Wire sync's broadcast to our broadcast
		this.sync.onBroadcastBlock = (block) => {
			if (this.onBroadcastBlock) this.onBroadcastBlock(block);
		};
	}

	/**
	 * Submit a transaction locally and broadcast to peers.
	 * Returns the tx hash, or null if already seen.
	 */
	submitTransaction(tx: Transaction): string | null {
		const hash = computeTxHash(tx);
		if (this.seenTxHashes.has(hash)) return null;

		this.markTxSeen(hash);

		try {
			this.producer.submitTransaction(tx);
		} catch {
			// Mempool full, rate limit, etc — still propagate
		}

		if (this.onBroadcastTx) {
			this.onBroadcastTx(serializeTx(tx));
		}

		return hash;
	}

	/**
	 * Handle a transaction received from a peer via gossip.
	 * Deduplicates and adds to local mempool.
	 */
	handleGossipTx(serialized: SerializedTx): boolean {
		const tx = deserializeTx(serialized);
		const hash = computeTxHash(tx);

		if (this.seenTxHashes.has(hash)) return false;
		this.markTxSeen(hash);

		try {
			this.producer.submitTransaction(tx);
		} catch {
			// Mempool full or invalid — that's OK
		}

		// Re-broadcast to other peers
		if (this.onBroadcastTx) {
			this.onBroadcastTx(serialized);
		}

		return true;
	}

	/**
	 * Handle a block received from a peer via gossip.
	 * Deduplicates, validates, applies, and rebroadcasts.
	 */
	handleGossipBlock(serialized: SerializedBlock): {
		applied: boolean;
		error?: string;
	} {
		if (this.seenBlockHeights.has(serialized.height)) {
			return { applied: false, error: "Block already seen" };
		}
		this.markBlockSeen(serialized.height);

		return this.sync.handleBlock(serialized);
	}

	/**
	 * Produce a block (if this node is the current proposer)
	 * and broadcast it to peers.
	 */
	tryProduceBlock(myDid: string): Block | null {
		const block = this.producer.produceBlock(myDid);
		if (!block) return null;

		this.markBlockSeen(block.height);

		const serialized = serializeBlock(block);
		if (this.onBroadcastBlock) {
			this.onBroadcastBlock(serialized);
		}

		return block;
	}

	/**
	 * Broadcast an already-produced block to peers.
	 * Used for fallback blocks produced outside normal rotation.
	 */
	broadcastBlock(block: Block): void {
		this.markBlockSeen(block.height);
		const serialized = serializeBlock(block);
		if (this.onBroadcastBlock) {
			this.onBroadcastBlock(serialized);
		}
	}

	/**
	 * Request chain sync from a peer.
	 * Returns blocks from fromHeight to the peer's tip.
	 */
	handleSyncRequest(fromHeight: number): SerializedBlock[] {
		return this.sync.handleSyncRequest(fromHeight);
	}

	/**
	 * Apply a batch of sync blocks received from a peer.
	 */
	applySyncBlocks(blocks: SerializedBlock[]): {
		applied: number;
		errors: string[];
	} {
		for (const b of blocks) {
			this.markBlockSeen(b.height);
		}
		return this.sync.applySyncBlocks(blocks);
	}

	/** Get the underlying producer. */
	getProducer(): NodeBlockProducer {
		return this.producer;
	}

	/** Get the sync handler. */
	getSync(): BlockSync {
		return this.sync;
	}

	/** Number of seen tx hashes in the dedup cache. */
	getSeenTxCount(): number {
		return this.seenTxHashes.size;
	}

	/** Number of seen block heights in the dedup cache. */
	getSeenBlockCount(): number {
		return this.seenBlockHeights.size;
	}

	// ── Internal ─────────────────────────────────────────────────

	private markTxSeen(hash: string): void {
		this.seenTxHashes.add(hash);
		if (this.seenTxHashes.size > this.maxSeenCache) {
			const first = this.seenTxHashes.values().next().value;
			if (first !== undefined) this.seenTxHashes.delete(first);
		}
	}

	private markBlockSeen(height: number): void {
		this.seenBlockHeights.add(height);
		if (this.seenBlockHeights.size > this.maxSeenCache) {
			const first = this.seenBlockHeights.values().next().value;
			if (first !== undefined) this.seenBlockHeights.delete(first);
		}
	}
}
