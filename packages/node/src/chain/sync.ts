import type { NodeBlockProducer } from "./producer.js";
import type { SerializedBlock } from "./types.js";
import { serializeBlock, deserializeBlock } from "./types.js";

/**
 * Block sync handler for receiving and propagating blocks.
 * Handles chain sync for new nodes joining the network.
 */
export class BlockSync {
	private producer: NodeBlockProducer;
	/** Callback to broadcast a block to peers. */
	onBroadcastBlock: ((block: SerializedBlock) => void) | null = null;

	constructor(producer: NodeBlockProducer) {
		this.producer = producer;
	}

	/**
	 * Handle a block received from a peer.
	 * Validates, applies, and rebroadcasts if valid.
	 */
	handleBlock(serialized: SerializedBlock): {
		applied: boolean;
		error?: string;
	} {
		const block = deserializeBlock(serialized);

		// Check if we already have this block
		const existing = this.producer.getBlock(block.height);
		if (existing) {
			return { applied: false, error: "Block already known" };
		}

		// Validate and apply
		const result = this.producer.applyBlock(block);
		if (!result.valid) {
			return {
				applied: false,
				error: result.error ?? "Validation failed",
			};
		}

		// Rebroadcast to other peers
		if (this.onBroadcastBlock) {
			this.onBroadcastBlock(serialized);
		}

		return { applied: true };
	}

	/**
	 * Handle a sync request from a new peer.
	 * Returns blocks from the requested height to the current tip.
	 */
	handleSyncRequest(fromHeight: number): SerializedBlock[] {
		const currentHeight = this.producer.getHeight();
		const blocks: SerializedBlock[] = [];

		for (let h = fromHeight; h <= currentHeight; h++) {
			const block = this.producer.getBlock(h);
			if (block) {
				blocks.push(serializeBlock(block));
			}
		}

		return blocks;
	}

	/**
	 * Apply a batch of sync blocks (from a peer's sync response).
	 * Applies them in order.
	 */
	applySyncBlocks(blocks: SerializedBlock[]): {
		applied: number;
		errors: string[];
	} {
		let applied = 0;
		const errors: string[] = [];

		for (const sb of blocks) {
			const block = deserializeBlock(sb);

			// Skip blocks we already have
			if (this.producer.getBlock(block.height)) {
				continue;
			}

			const result = this.producer.applyBlock(block);
			if (result.valid) {
				applied++;
			} else {
				errors.push(
					`Block ${block.height}: ${result.error ?? "unknown error"}`,
				);
				break; // Stop on first error
			}
		}

		return { applied, errors };
	}

	/**
	 * Get the current chain height (for sync requests).
	 */
	getHeight(): number {
		return this.producer.getHeight();
	}
}
