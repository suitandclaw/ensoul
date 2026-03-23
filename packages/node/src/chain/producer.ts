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
 * Uses a deterministic validator roster from genesis for proposer
 * selection: simple round-robin by height % roster.length.
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

	/**
	 * Deterministic validator roster derived from genesis.
	 * Sorted alphabetically. Used for round-robin proposer selection.
	 * Every node loads the same genesis, gets the same roster.
	 */
	private validatorRoster: string[] = [];

	/** Timestamp of the last block produced or applied. */
	private lastBlockTime = Date.now();

	/** Base block interval for fallback delay calculation. */
	private static readonly BLOCK_INTERVAL_MS = 6_000;

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

		// Build validator roster from genesis config.
		// Validators are allocations with autoStake: true, sorted by DID.
		this.validatorRoster = genesisConfig.allocations
			.filter((a) => a.autoStake === true)
			.map((a) => a.recipient)
			.sort();

		if (this.validatorRoster.length > 0) {
			this.log(`Validator roster: ${this.validatorRoster.length} validators loaded from genesis`);
		}
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
	 * Get the validator roster (from genesis, sorted alphabetically).
	 * Falls back to validatorDids for bootstrap/test mode.
	 */
	getEligibleValidators(): string[] {
		if (this.validatorRoster.length > 0) return this.validatorRoster;
		return [...this.validatorDids];
	}

	/**
	 * Select the proposer for a given block height.
	 * Simple deterministic round-robin from the genesis validator roster.
	 * Every node loads the same genesis, gets the same roster, computes
	 * the same proposer for every height.
	 */
	selectProposer(height: number): string | null {
		const roster = this.getEligibleValidators();
		if (roster.length === 0) return null;
		const idx = height % roster.length;
		return roster[idx] ?? null;
	}

	/**
	 * Check if a DID is in the validator roster.
	 */
	isInRoster(did: string): boolean {
		return this.validatorRoster.includes(did) || this.validatorDids.includes(did);
	}

	/**
	 * Check if a validator has sufficient stake to produce blocks.
	 */
	hasMinimumStake(did: string): boolean {
		if (this.config.minimumStake === 0n) return true;
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
	 * Calculate the fallback delay for a given validator at a given height.
	 * Each validator has a priority based on its distance from the expected
	 * proposer in the roster. Distance 0 = expected proposer (6s), distance
	 * 1 = next in roster (12s), distance 2 = 18s, etc.
	 * Returns the delay in milliseconds, or -1 if the DID is not in the roster.
	 */
	getFallbackDelay(height: number, myDid: string): number {
		const roster = this.getEligibleValidators();
		if (roster.length === 0) return -1;

		const myIndex = roster.indexOf(myDid);
		if (myIndex === -1) return -1;

		const expectedIndex = height % roster.length;
		const distance = (myIndex - expectedIndex + roster.length) % roster.length;

		return (distance + 1) * NodeBlockProducer.BLOCK_INTERVAL_MS;
	}

	/**
	 * Check if enough time has passed for this validator to produce a
	 * fallback block at the given height. Uses priority-based delay:
	 * the next validator in the roster after the expected proposer
	 * gets to produce sooner than validators further away.
	 */
	canProduceFallback(height: number, myDid: string): boolean {
		const delay = this.getFallbackDelay(height, myDid);
		if (delay < 0) return false;
		return Date.now() - this.lastBlockTime >= delay;
	}

	/**
	 * Produce a block for the current slot.
	 * Returns null if myDid is not the selected proposer.
	 * If force is true, skips the proposer check (used for fallback
	 * production when the expected proposer is offline).
	 * If dryRun is true, produces the block but rolls back the chain
	 * state so it is not applied (used for consensus proposals).
	 */
	produceBlock(myDid: string, force = false, dryRun = false): Block | null {
		const roster = this.getEligibleValidators();
		if (roster.length === 0) return null;

		const height = this.ledger.getHeight() + 1;

		// Check minimum stake (skip if minimumStake is 0)
		if (this.config.minimumStake > 0n && !this.hasMinimumStake(myDid)) {
			const account = this.state.getAccount(myDid);
			const staked = account.stakedBalance / DECIMALS;
			const required = this.config.minimumStake / DECIMALS;
			this.log(
				`Cannot produce block: staked balance (${staked} ENSL) below minimum (${addCommas(required.toString())} ENSL)`,
			);
			return null;
		}

		// Round-robin proposer selection (skip if forced)
		if (!force) {
			const expectedProposer = this.selectProposer(height);
			if (expectedProposer !== myDid) return null;
		}

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

		// Save state before production for dry-run rollback
		const savedState = dryRun ? this.state.clone() : null;
		const savedTotalEmitted = dryRun ? (this.ledger as unknown as { totalEmitted: bigint }).totalEmitted : 0n;

		const block = this.ledger.produceBlock(
			myDid,
			this.config.maxTxPerBlock,
		);

		ledgerAny["mempool"] = origMempool;

		if (dryRun) {
			// Roll back: remove the block from the chain and restore state
			const chainArr = (this.ledger as unknown as { chain: Block[] }).chain;
			chainArr.pop();
			// Restore account state
			const stateRef = this.ledger as unknown as { state: AccountState };
			stateRef.state = savedState!;
			this.state = savedState!;
			(this.ledger as unknown as { totalEmitted: bigint }).totalEmitted = savedTotalEmitted;
			// Put txs back into mempool
			for (const tx of candidates) {
				const nonce = savedState!.getAccount(tx.from).nonce;
				try { this.mempool.add(tx, nonce); } catch { /* dup */ }
			}
			return block;
		}

		this.watchdog.recordBlock();
		this.watchdog.advanceProposer(roster.length);
		this.adaptiveTime.computeInterval(this.mempool.readySize);

		const limitsCheck = validateBlockLimits(block);
		if (!limitsCheck.valid) return null;

		// Persist to disk if store is available
		if (this.store) {
			void this.persistBlock(block);
		}

		this.lastBlockTime = Date.now();
		if (this.onBlock) this.onBlock(block);
		return block;
	}

	/**
	 * Apply an externally received block (from a peer).
	 * Validates then applies to local state.
	 *
	 * When skipProposerCheck is true (bulk sync of historical blocks),
	 * proposer validation is skipped entirely. For real-time blocks,
	 * the proposer must match selectProposer(height) OR be a fallback
	 * block (previous block is 30+ seconds old and the proposer is
	 * in the validator roster).
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
				// Accept fallback blocks if the proposer is in the roster
				// and enough time has passed for their priority level.
				// Any roster validator is accepted if the expected proposer
				// has had its full slot time plus the fallback validator's
				// priority delay.
				const proposerInRoster = this.isInRoster(block.proposer);
				const timeSinceLastBlock = Date.now() - this.lastBlockTime;
				const fallbackDelay = this.getFallbackDelay(block.height, block.proposer);
				if (!proposerInRoster || fallbackDelay < 0 || timeSinceLastBlock < fallbackDelay) {
					this.log(
						`Rejected block ${block.height}: proposer ${block.proposer} is not the expected proposer ${expectedProposer}`,
					);
					return {
						valid: false,
						error: `Wrong proposer: expected ${expectedProposer}, got ${block.proposer}`,
					};
				}
				this.log(
					`Accepted fallback block ${block.height} from ${block.proposer} (expected ${expectedProposer}, priority fallback)`,
				);
			}
		}

		// Push the block into our chain
		const chain = (
			this.ledger as unknown as { chain: Block[] }
		).chain;
		chain.push(block);

		// Apply transactions to state (includes block_reward, delegate, etc.)
		for (const tx of block.transactions) {
			if (tx.type === "delegate") {
				applyTransaction(tx, this.state, this.genesisConfig.protocolFees.storageFeeProtocolShare);
				this.delegations.delegate(tx.from, tx.to, tx.amount);
			} else if (tx.type === "undelegate") {
				applyTransaction(tx, this.state, this.genesisConfig.protocolFees.storageFeeProtocolShare);
				this.delegations.undelegate(tx.from, tx.to, tx.amount);
			} else if (tx.type === "block_reward") {
				applyTransaction(
					tx,
					this.state,
					this.genesisConfig.protocolFees.storageFeeProtocolShare,
				);
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
		this.lastBlockTime = Date.now();

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
		return [...this.validatorRoster.length > 0 ? this.validatorRoster : this.validatorDids];
	}

	/**
	 * Log a slashing warning for a missed block.
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
