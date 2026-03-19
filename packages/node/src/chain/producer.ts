import {
	BlockProducer as LedgerBlockProducer,
	AccountState,
	Mempool,
	EnhancedMempool,
	ConsensusWatchdog,
	AdaptiveBlockTime,
	enforcePerIdentityLimit,
	validateBlockLimits,
	validateTransaction,
	applyTransaction,
} from "@ensoul/ledger";
import type { GenesisConfig, Transaction, Block } from "@ensoul/ledger";
import type { ChainNodeConfig } from "./types.js";
import type { BlockStore } from "./store.js";

const DEFAULT_CONFIG: ChainNodeConfig = {
	blockTimeMs: 6000,
	maxTxPerBlock: 100,
	maxTxPerIdentity: 10,
	nonceGapTimeoutMs: 60000,
};

/**
 * Node-level block producer that integrates the ledger with
 * adaptive timing, consensus watchdog, and spam protection.
 *
 * If a BlockStore is provided, all blocks and state are persisted to
 * disk. On restart, the chain resumes from the last persisted height
 * instead of starting from genesis.
 */
export class NodeBlockProducer {
	private ledger: LedgerBlockProducer;
	private state: AccountState;
	private mempool: EnhancedMempool;
	private watchdog: ConsensusWatchdog;
	private adaptiveTime: AdaptiveBlockTime;
	private config: ChainNodeConfig;
	private validatorDids: string[] = [];
	private genesisConfig: GenesisConfig;
	private store: BlockStore | null;

	/** Callback invoked when a new block is produced. */
	onBlock: ((block: Block) => void) | null = null;

	constructor(
		genesisConfig: GenesisConfig,
		config?: Partial<ChainNodeConfig>,
		store?: BlockStore,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.genesisConfig = genesisConfig;
		this.state = new AccountState();
		this.store = store ?? null;
		this.mempool = new EnhancedMempool(
			10000,
			this.config.nonceGapTimeoutMs,
			this.config.maxTxPerIdentity,
		);
		this.ledger = new LedgerBlockProducer(
			this.state,
			new Mempool(), // internal mempool (we bypass it)
			genesisConfig,
		);
		this.watchdog = new ConsensusWatchdog(this.config.blockTimeMs);
		this.adaptiveTime = new AdaptiveBlockTime(
			this.config.blockTimeMs,
			60000,
		);
	}

	/**
	 * Initialize genesis and register validators.
	 * If a BlockStore is present and has persisted state, this loads
	 * from disk instead of creating a fresh genesis.
	 * Returns the genesis block (from disk or freshly created).
	 */
	async initGenesisAsync(
		validatorDids: string[],
	): Promise<{ block: Block; resumed: boolean; height: number }> {
		this.validatorDids = [...validatorDids];

		if (this.store && (await this.store.hasChain())) {
			// Resume from persisted state
			const savedState = await this.store.getAccountState();
			if (savedState) {
				// Replace the state in both the ledger and this producer
				this.state = savedState;
				const ledgerAny = this.ledger as unknown as Record<
					string,
					unknown
				>;
				ledgerAny["state"] = savedState;
			}

			// Restore totalEmitted
			const emittedStr = await this.store.getMetadata("totalEmitted");
			if (emittedStr) {
				const ledgerAny = this.ledger as unknown as Record<
					string,
					unknown
				>;
				ledgerAny["totalEmitted"] = BigInt(emittedStr);
			}

			// Restore validator DIDs from metadata
			const vidsStr = await this.store.getMetadata("validatorDids");
			if (vidsStr) {
				this.validatorDids = JSON.parse(vidsStr) as string[];
			}

			// Reload blocks into the in-memory chain
			const heightStr = await this.store.getMetadata("height");
			const height = heightStr ? Number(heightStr) : 0;
			const chain = (
				this.ledger as unknown as { chain: Block[] }
			).chain;
			chain.length = 0;
			for (let h = 0; h <= height; h++) {
				const block = await this.store.getBlock(h);
				if (block) chain.push(block);
			}

			const genesis = chain[0];
			if (!genesis) {
				throw new Error("Persisted chain has no genesis block");
			}
			return { block: genesis, resumed: true, height };
		}

		// Fresh genesis
		const block = this.ledger.initGenesis();

		if (this.store) {
			await this.persistBlock(block);
			await this.store.putMetadata(
				"validatorDids",
				JSON.stringify(this.validatorDids),
			);
		}

		return { block, resumed: false, height: 0 };
	}

	/**
	 * Initialize genesis (synchronous, for backward compatibility).
	 * Does NOT load from disk. Use initGenesisAsync for persistence.
	 */
	initGenesis(validatorDids: string[]): Block {
		this.validatorDids = [...validatorDids];
		return this.ledger.initGenesis();
	}

	/**
	 * Submit a transaction to the mempool.
	 */
	submitTransaction(tx: Transaction): string {
		const currentNonce = this.state.getAccount(tx.from).nonce;
		return this.mempool.add(tx, currentNonce);
	}

	/**
	 * Produce a block for the current slot.
	 * Returns null if myDid is not the current proposer.
	 */
	produceBlock(myDid: string): Block | null {
		if (this.validatorDids.length === 0) return null;

		// Round-robin proposer selection based on next block height
		const height = this.ledger.getHeight() + 1;
		const proposerIndex = height % this.validatorDids.length;
		const expectedProposer = this.validatorDids[proposerIndex];

		if (expectedProposer !== myDid) return null;

		// Drain ready txs from enhanced mempool, enforce per-identity limit
		const candidates = this.mempool.drain(this.config.maxTxPerBlock);
		const limited = enforcePerIdentityLimit(
			candidates,
			this.config.maxTxPerIdentity,
		);

		// Feed into a temporary mempool for the ledger
		const tempPool = new Mempool();
		for (const tx of limited) {
			try {
				tempPool.add(tx);
			} catch {
				// skip duplicates
			}
		}

		// Swap the ledger's mempool temporarily
		const ledgerAny = this.ledger as unknown as Record<string, unknown>;
		const origMempool = ledgerAny["mempool"];
		ledgerAny["mempool"] = tempPool;

		const block = this.ledger.produceBlock(
			myDid,
			this.config.maxTxPerBlock,
		);

		ledgerAny["mempool"] = origMempool;

		this.watchdog.recordBlock();
		this.watchdog.advanceProposer(this.validatorDids.length);
		this.adaptiveTime.computeInterval(this.mempool.readySize);

		const limitsCheck = validateBlockLimits(block);
		if (!limitsCheck.valid) return null;

		// Persist to disk if store is available
		if (this.store) {
			void this.persistBlock(block);
		}

		if (this.onBlock) this.onBlock(block);
		return block;
	}

	/**
	 * Apply an externally received block (from a peer).
	 * Validates then applies to local state.
	 */
	applyBlock(block: Block): { valid: boolean; error?: string } {
		const result = this.ledger.validateBlock(block);
		if (!result.valid) return result;

		// Push the block into our chain
		const chain = (
			this.ledger as unknown as { chain: Block[] }
		).chain;
		chain.push(block);

		// Apply transactions to state (includes block_reward tx)
		for (const tx of block.transactions) {
			if (tx.type === "block_reward") {
				// Protocol-generated, skip normal validation
				applyTransaction(
					tx,
					this.state,
					this.genesisConfig.protocolFees.storageFeeProtocolShare,
				);
				// Track totalEmitted
				const ledgerAny = this.ledger as unknown as Record<
					string,
					unknown
				>;
				const prev = this.ledger.getTotalEmitted();
				ledgerAny["totalEmitted"] = prev + tx.amount;
			} else {
				const vr = validateTransaction(tx, this.state);
				if (vr.valid) {
					applyTransaction(
						tx,
						this.state,
						this.genesisConfig.protocolFees
							.storageFeeProtocolShare,
					);
				}
			}
		}

		this.watchdog.recordBlock();

		// Persist to disk if store is available
		if (this.store) {
			void this.persistBlock(block);
		}

		return { valid: true };
	}

	/** Get the underlying account state. */
	getState(): AccountState {
		return this.state;
	}

	/** Get the enhanced mempool. */
	getMempool(): EnhancedMempool {
		return this.mempool;
	}

	/** Get the watchdog. */
	getWatchdog(): ConsensusWatchdog {
		return this.watchdog;
	}

	/** Get current chain height. */
	getHeight(): number {
		return this.ledger.getHeight();
	}

	/** Get a block by height. */
	getBlock(height: number): Block | null {
		return this.ledger.getBlock(height);
	}

	/** Get the latest block. */
	getLatestBlock(): Block | null {
		return this.ledger.getLatestBlock();
	}

	/** Get the validator list. */
	getValidators(): string[] {
		return [...this.validatorDids];
	}

	// ── Internal persistence ─────────────────────────────────────

	private async persistBlock(block: Block): Promise<void> {
		if (!this.store) return;
		await this.store.putBlock(block.height, block);
		await this.store.putMetadata("height", String(block.height));
		await this.store.putMetadata(
			"totalEmitted",
			this.ledger.getTotalEmitted().toString(),
		);
		await this.store.putAccountState(this.state);
	}
}
