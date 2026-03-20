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
	DelegationRegistry,
} from "@ensoul/ledger";
import type { GenesisConfig, Transaction, Block } from "@ensoul/ledger";
import type { ChainNodeConfig } from "./types.js";
import type { BlockStore } from "./store.js";

const DECIMALS = 10n ** 18n;

function addCommas(s: string): string {
	const parts: string[] = [];
	let remaining = s;
	while (remaining.length > 3) {
		parts.unshift(remaining.slice(-3));
		remaining = remaining.slice(0, -3);
	}
	parts.unshift(remaining);
	return parts.join(",");
}

/** Default: 1,000 ENSL minimum stake for testnet. */
const DEFAULT_MINIMUM_STAKE = 1000n * DECIMALS;

const DEFAULT_CONFIG: ChainNodeConfig = {
	blockTimeMs: 6000,
	maxTxPerBlock: 100,
	maxTxPerIdentity: 10,
	nonceGapTimeoutMs: 60000,
	minimumStake: DEFAULT_MINIMUM_STAKE,
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
	private delegations: DelegationRegistry;

	/** Callback invoked when a new block is produced. */
	onBlock: ((block: Block) => void) | null = null;

	/** Callback for log messages (stake warnings, slashing events). */
	onLog: ((msg: string) => void) | null = null;

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
		this.delegations = new DelegationRegistry();
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
		this.ledger.setDelegationRegistry(this.delegations);
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
		this.ledger.setDelegationRegistry(this.delegations);
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
	 * Get the list of validators with totalStakeWeight >= minimumStake and not unstaking.
	 * Derives the eligible set from account state (anyone with stake > 0), not from
	 * this.validatorDids. This ensures a new node syncing historical blocks computes
	 * the same proposer as the original network, since genesis populates account state
	 * for all foundation validators regardless of validatorDids.
	 * Falls back to this.validatorDids only when no accounts have stake (bootstrap
	 * mode with --no-min-stake).
	 */
	getEligibleValidators(): string[] {
		// Derive from on-chain state: all accounts with stakedBalance > 0.
		// Sorted by DID for determinism across nodes. This ensures a new node
		// syncing historical blocks computes the same proposer as the original
		// network, since genesis populates account state for all foundation
		// validators regardless of this.validatorDids.
		const staked = this.state.getAllAccounts()
			.filter((acc) => {
				if (acc.stakedBalance <= 0n) return false;
				if (acc.unstakingBalance > 0n) return false;
				const totalWeight = this.delegations.getTotalStakeWeight(acc.did, acc.stakedBalance);
				return totalWeight >= this.config.minimumStake;
			})
			.map((acc) => acc.did)
			.sort();

		if (staked.length > 0) return staked;

		// Fallback: bootstrap mode (minimumStake=0, no accounts have stake).
		// Use validatorDids in original order for backward compatibility.
		return this.validatorDids.filter((did) => {
			const account = this.state.getAccount(did);
			if (account.unstakingBalance > 0n) return false;
			return true;
		});
	}

	/**
	 * Select the proposer for a given block height using stake-weighted selection.
	 * Validators with more stake get proportionally more slots.
	 * Falls back to equal-weight round-robin if all eligible validators have equal stake.
	 */
	selectProposer(height: number): string | null {
		const eligible = this.getEligibleValidators();
		if (eligible.length === 0) return null;

		// Build a weighted list based on total stake weight (own + delegated)
		const stakes = eligible.map((did) => ({
			did,
			stake: this.delegations.getTotalStakeWeight(
				did,
				this.state.getAccount(did).stakedBalance,
			),
		}));

		const totalStake = stakes.reduce((sum, s) => sum + s.stake, 0n);

		// If no one has any stake (e.g. testnet with minimumStake=0),
		// fall back to equal-weight round-robin
		if (totalStake === 0n) {
			const idx = height % eligible.length;
			return eligible[idx] ?? null;
		}

		// Use block height as a deterministic seed into the weighted range
		const slot = BigInt(height) % totalStake;
		let cumulative = 0n;
		for (const entry of stakes) {
			cumulative += entry.stake;
			if (slot < cumulative) return entry.did;
		}

		// Fallback (should not reach here)
		return eligible[0] ?? null;
	}

	/**
	 * Check if a validator has sufficient stake to produce blocks.
	 */
	hasMinimumStake(did: string): boolean {
		const account = this.state.getAccount(did);
		return account.stakedBalance >= this.config.minimumStake;
	}

	/**
	 * Get the minimum stake requirement.
	 */
	getMinimumStake(): bigint {
		return this.config.minimumStake;
	}

	/**
	 * Produce a block for the current slot.
	 * Returns null if myDid is not the selected proposer or lacks minimum stake.
	 */
	produceBlock(myDid: string): Block | null {
		if (this.getEligibleValidators().length === 0 && this.validatorDids.length === 0) return null;

		const height = this.ledger.getHeight() + 1;

		// Check minimum stake
		if (!this.hasMinimumStake(myDid)) {
			const account = this.state.getAccount(myDid);
			const staked = account.stakedBalance / DECIMALS;
			const required = this.config.minimumStake / DECIMALS;
			this.log(
				`Cannot produce block: staked balance (${staked} ENSL) below minimum (${addCommas(required.toString())} ENSL)`,
			);
			return null;
		}

		// Stake-weighted proposer selection
		const expectedProposer = this.selectProposer(height);
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
	 *
	 * When skipProposerCheck is true (bulk sync of historical blocks),
	 * proposer validation is skipped. During sync, stake weights,
	 * delegation state, and validator ordering can drift from the
	 * original network's state at each height. We trust prior network
	 * consensus for historical blocks. State root and block structure
	 * validation still runs on every block.
	 */
	applyBlock(
		block: Block,
		skipProposerCheck = false,
	): { valid: boolean; error?: string } {
		const result = this.ledger.validateBlock(block);
		if (!result.valid) return result;

		// Validate proposer unless syncing historical blocks
		if (!skipProposerCheck) {
			const expectedProposer = this.selectProposer(block.height);
			if (expectedProposer !== null && expectedProposer !== block.proposer) {
				this.log(
					`Rejected block ${block.height}: proposer ${block.proposer} is not the expected proposer ${expectedProposer}`,
				);
				return {
					valid: false,
					error: `Wrong proposer: expected ${expectedProposer}, got ${block.proposer}`,
				};
			}
		}

		// Push the block into our chain
		const chain = (
			this.ledger as unknown as { chain: Block[] }
		).chain;
		chain.push(block);

		// Apply transactions to state (includes block_reward, delegate, etc.)
		for (const tx of block.transactions) {
			// Handle delegate/undelegate via the delegation registry
			if (tx.type === "delegate") {
				applyTransaction(tx, this.state, this.genesisConfig.protocolFees.storageFeeProtocolShare);
				this.delegations.delegate(tx.from, tx.to, tx.amount);
			} else if (tx.type === "undelegate") {
				applyTransaction(tx, this.state, this.genesisConfig.protocolFees.storageFeeProtocolShare);
				this.delegations.undelegate(tx.from, tx.to, tx.amount);
			} else if (tx.type === "block_reward") {
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

	/** Get the delegation registry. */
	getDelegations(): DelegationRegistry {
		return this.delegations;
	}

	/** Get the validator list. */
	getValidators(): string[] {
		return [...this.validatorDids];
	}

	/**
	 * Log a slashing warning for a missed block.
	 * Actual slashing will be implemented separately.
	 */
	logMissedBlock(did: string, height: number): void {
		this.log(`Slashing event: ${did} missed block production at height ${height}`);
	}

	/**
	 * Log a slashing warning for a failed proof-of-storage challenge.
	 */
	logFailedChallenge(did: string): void {
		this.log(`Slashing event: ${did} failed proof-of-storage challenge`);
	}

	/**
	 * Log a slashing warning for double block production.
	 */
	logDoubleProduction(did: string, height: number): void {
		this.log(`Slashing event: ${did} produced duplicate block at height ${height}`);
	}

	// ── Internal helpers ─────────────────────────────────────────

	private log(msg: string): void {
		if (this.onLog) this.onLog(msg);
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
