import { ClassicLevel } from "classic-level";
import type { Block } from "@ensoul/ledger";
import { AccountState } from "@ensoul/ledger";

/**
 * Persistent chain store backed by LevelDB.
 * Stores blocks, account state, and chain metadata to disk so the
 * chain survives process restarts.
 */
export class BlockStore {
	private db: ClassicLevel<string, string>;
	private closed = false;

	constructor(path: string) {
		this.db = new ClassicLevel(path, { valueEncoding: "utf8" });
	}

	// ── Blocks ───────────────────────────────────────────────────

	/**
	 * Store a block by height.
	 */
	async putBlock(height: number, block: Block): Promise<void> {
		const key = `block:${height.toString().padStart(12, "0")}`;
		await this.db.put(key, serializeBlock(block));
	}

	/**
	 * Retrieve a block by height.
	 */
	async getBlock(height: number): Promise<Block | null> {
		const key = `block:${height.toString().padStart(12, "0")}`;
		try {
			const raw = await this.db.get(key);
			if (raw === undefined) return null;
			return deserializeBlock(raw);
		} catch {
			return null;
		}
	}

	/**
	 * Get the latest (highest) block, or null if the store is empty.
	 */
	async getLatestBlock(): Promise<Block | null> {
		const height = await this.getMetadata("height");
		if (height === null) return null;
		return this.getBlock(Number(height));
	}

	/**
	 * Get all blocks from startHeight to endHeight (inclusive).
	 */
	async getBlocks(
		startHeight: number,
		endHeight: number,
	): Promise<Block[]> {
		const blocks: Block[] = [];
		for (let h = startHeight; h <= endHeight; h++) {
			const block = await this.getBlock(h);
			if (block) blocks.push(block);
		}
		return blocks;
	}

	// ── Account State ────────────────────────────────────────────

	/**
	 * Persist the full account state to disk.
	 */
	async putAccountState(state: AccountState): Promise<void> {
		const accounts = state.getAllAccounts();
		const serialized = JSON.stringify(
			accounts.map((a) => ({
				did: a.did,
				balance: a.balance.toString(),
				stakedBalance: a.stakedBalance.toString(),
				nonce: a.nonce,
				storageCredits: a.storageCredits.toString(),
				lastActivity: a.lastActivity,
			})),
		);
		await this.db.put("state:accounts", serialized);
	}

	/**
	 * Load the full account state from disk.
	 * Returns null if no state is persisted.
	 */
	async getAccountState(): Promise<AccountState | null> {
		try {
			const raw = await this.db.get("state:accounts");
			if (raw === undefined) return null;
			const entries = JSON.parse(raw) as Array<{
				did: string;
				balance: string;
				stakedBalance: string;
				nonce: number;
				storageCredits: string;
				lastActivity: number;
			}>;
			const state = new AccountState();
			for (const e of entries) {
				state.setAccount({
					did: e.did,
					balance: BigInt(e.balance),
					stakedBalance: BigInt(e.stakedBalance),
					nonce: e.nonce,
					storageCredits: BigInt(e.storageCredits),
					lastActivity: e.lastActivity,
				});
			}
			return state;
		} catch {
			return null;
		}
	}

	// ── Metadata ─────────────────────────────────────────────────

	/**
	 * Store a metadata value (height, totalEmitted, validatorDids, etc.).
	 */
	async putMetadata(key: string, value: string): Promise<void> {
		await this.db.put(`meta:${key}`, value);
	}

	/**
	 * Retrieve a metadata value.
	 */
	async getMetadata(key: string): Promise<string | null> {
		try {
			const val = await this.db.get(`meta:${key}`);
			if (val === undefined) return null;
			return val;
		} catch {
			return null;
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────

	/**
	 * Check if the store has any persisted chain data.
	 */
	async hasChain(): Promise<boolean> {
		const height = await this.getMetadata("height");
		return height !== null;
	}

	/**
	 * Close the underlying LevelDB.
	 */
	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = false;
			await this.db.close();
		}
	}
}

// ── Block serialization (JSON with BigInt handling) ──────────────────

function serializeBlock(block: Block): string {
	return JSON.stringify({
		height: block.height,
		previousHash: block.previousHash,
		stateRoot: block.stateRoot,
		transactionsRoot: block.transactionsRoot,
		timestamp: block.timestamp,
		proposer: block.proposer,
		transactions: block.transactions.map((tx) => ({
			type: tx.type,
			from: tx.from,
			to: tx.to,
			amount: tx.amount.toString(),
			nonce: tx.nonce,
			timestamp: tx.timestamp,
			signature: Array.from(tx.signature),
			data: tx.data ? Array.from(tx.data) : undefined,
		})),
		attestations: block.attestations.map((a) => ({
			validatorDid: a.validatorDid,
			signature: Array.from(a.signature),
			timestamp: a.timestamp,
		})),
	});
}

function deserializeBlock(raw: string): Block {
	const data = JSON.parse(raw) as {
		height: number;
		previousHash: string;
		stateRoot: string;
		transactionsRoot: string;
		timestamp: number;
		proposer: string;
		transactions: Array<{
			type: string;
			from: string;
			to: string;
			amount: string;
			nonce: number;
			timestamp: number;
			signature: number[];
			data?: number[];
		}>;
		attestations: Array<{
			validatorDid: string;
			signature: number[];
			timestamp: number;
		}>;
	};

	return {
		height: data.height,
		previousHash: data.previousHash,
		stateRoot: data.stateRoot,
		transactionsRoot: data.transactionsRoot,
		timestamp: data.timestamp,
		proposer: data.proposer,
		transactions: data.transactions.map((tx) => {
			const base = {
				type: tx.type as Block["transactions"][0]["type"],
				from: tx.from,
				to: tx.to,
				amount: BigInt(tx.amount),
				nonce: tx.nonce,
				timestamp: tx.timestamp,
				signature: new Uint8Array(tx.signature),
			};
			if (tx.data) {
				return { ...base, data: new Uint8Array(tx.data) };
			}
			return base;
		}),
		attestations: data.attestations.map((a) => ({
			validatorDid: a.validatorDid,
			signature: new Uint8Array(a.signature),
			timestamp: a.timestamp,
		})),
	};
}
