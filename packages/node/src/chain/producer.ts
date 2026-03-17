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
	computeBlockReward,
	REWARDS_POOL,
} from "@ensoul/ledger";
import type { GenesisConfig, Transaction, Block } from "@ensoul/ledger";
import type { ChainNodeConfig } from "./types.js";

const DEFAULT_CONFIG: ChainNodeConfig = {
	blockTimeMs: 6000,
	maxTxPerBlock: 100,
	maxTxPerIdentity: 10,
	nonceGapTimeoutMs: 60000,
};

/**
 * Node-level block producer that integrates the ledger with
 * adaptive timing, consensus watchdog, and spam protection.
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

	/** Callback invoked when a new block is produced. */
	onBlock: ((block: Block) => void) | null = null;

	constructor(
		genesisConfig: GenesisConfig,
		config?: Partial<ChainNodeConfig>,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.genesisConfig = genesisConfig;
		this.state = new AccountState();
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

		// Apply transactions to state
		for (const tx of block.transactions) {
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

		// Apply emission reward (same logic as ledger)
		const totalEmitted = this.ledger.getTotalEmitted();
		const reward = computeBlockReward(
			block.height,
			this.genesisConfig.emissionPerBlock,
			5_256_000,
			this.genesisConfig.networkRewardsPool,
			totalEmitted,
		);
		if (reward > 0n) {
			const pool = this.state.getBalance(REWARDS_POOL);
			if (pool >= reward) {
				this.state.debit(REWARDS_POOL, reward);
				this.state.credit(block.proposer, reward);
			}
		}

		this.watchdog.recordBlock();
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
}
