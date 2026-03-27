import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
	Block,
	Transaction,
	GenesisConfig,
} from "./types.js";
import {
	validateTransaction,
	applyTransaction,
	computeTxHash,
	REWARDS_POOL,
} from "./transactions.js";
import { buildGenesisTransactions } from "./genesis.js";
import { AccountState } from "./accounts.js";
import { Mempool } from "./mempool.js";
import type { DelegationRegistry } from "./delegations.js";

const ENC = new TextEncoder();

/**
 * Compute the hash of a block (header only, excludes attestations).
 */
export function computeBlockHash(block: Block): string {
	const data = ENC.encode(
		JSON.stringify({
			height: block.height,
			previousHash: block.previousHash,
			stateRoot: block.stateRoot,
			transactionsRoot: block.transactionsRoot,
			timestamp: block.timestamp,
			proposer: block.proposer,
		}),
	);
	return bytesToHex(blake3(data));
}

/**
 * Compute the Merkle root of a list of transactions.
 */
export function computeTransactionsRoot(txs: Transaction[]): string {
	if (txs.length === 0) {
		return bytesToHex(blake3(new Uint8Array(0)));
	}
	const hashes = txs.map((tx) => computeTxHash(tx));
	const combined = ENC.encode(hashes.join(":"));
	return bytesToHex(blake3(combined));
}

/**
 * Height at which emission v2 activates.
 * Before this height: original 25%-reduction-per-interval formula.
 * At and after this height: smooth exponential decay with tail emission.
 *
 * Set to current chain height + buffer to allow validators to update.
 */
export const EMISSION_V2_HEIGHT = 100_000;

/**
 * Tail emission floor: 1 ENSL per block in perpetuity.
 * At 6-second blocks this is ~5.256M ENSL per year (~0.5% inflation at 1B supply).
 *
 * Research basis:
 *   Monero: permanent tail emission (0.6 XMR/block) to ensure mining incentives.
 *   Polkadot: 10% annual inflation targeting ideal staking ratio.
 *   Solana: started 8%, reduces 15%/year, floor at 1.5%.
 *
 * Ensoul uses a conservative floor that provides permanent validator revenue
 * while keeping long-term inflation below 1%.
 */
const TAIL_EMISSION_PER_BLOCK = 1_000_000_000_000_000_000n; // 1 ENSL in wei (18 decimals)

/**
 * Compute the block reward based on the emission schedule.
 *
 * v1 (height < EMISSION_V2_HEIGHT):
 *   Declining curve with 25% annual reduction and hard cap at totalReserved.
 *   This preserves deterministic replay of all blocks before the transition.
 *
 * v2 (height >= EMISSION_V2_HEIGHT):
 *   Smooth exponential decay: reward = year1PerBlock * (3/4)^yearIndex
 *   with a floor of 1 ENSL per block (tail emission).
 *   The tail emission draws from the rewards pool while it has balance,
 *   then continues as new issuance to ensure validators always have incentive.
 */
export function computeBlockReward(
	height: number,
	year1PerBlock: bigint,
	halvingIntervalBlocks: number,
	totalReserved: bigint,
	totalEmitted: bigint,
): bigint {
	if (height < EMISSION_V2_HEIGHT) {
		// v1: original formula for deterministic replay of historical blocks
		if (totalEmitted >= totalReserved) return 0n;
		const halvings = Math.floor(height / halvingIntervalBlocks);
		let reward = year1PerBlock;
		for (let i = 0; i < halvings; i++) {
			reward = (reward * 75n) / 100n;
		}
		const remaining = totalReserved - totalEmitted;
		return reward > remaining ? remaining : reward;
	}

	// v2: smooth decay with tail emission floor
	const yearIndex = Math.floor(height / halvingIntervalBlocks);
	let reward = year1PerBlock;
	for (let i = 0; i < yearIndex; i++) {
		reward = (reward * 75n) / 100n;
	}

	// Apply tail emission floor
	if (reward < TAIL_EMISSION_PER_BLOCK) {
		reward = TAIL_EMISSION_PER_BLOCK;
	}

	// If the rewards pool still has balance, draw from it.
	// If depleted, the tail emission continues as new issuance
	// (the ABCI application handles crediting without a pool debit).
	if (totalEmitted < totalReserved) {
		const remaining = totalReserved - totalEmitted;
		if (reward > remaining) {
			// Transitional: emit remaining pool + tail from new issuance
			return remaining;
		}
	}

	return reward;
}

/**
 * Block producer: creates new blocks from the mempool.
 */
export class BlockProducer {
	private state: AccountState;
	private mempool: Mempool;
	private chain: Block[] = [];
	private config: GenesisConfig;
	private totalEmitted = 0n;
	private delegations: DelegationRegistry | null = null;

	constructor(
		state: AccountState,
		mempool: Mempool,
		config: GenesisConfig,
	) {
		this.state = state;
		this.mempool = mempool;
		this.config = config;
	}

	/**
	 * Initialize the chain with the genesis block.
	 * Distributes initial token allocations as visible genesis_allocation
	 * transactions. Foundation validator allocations are auto-staked.
	 */
	initGenesis(): Block {
		// Guard: prevent re-application of genesis
		if (this.chain.length > 0) {
			throw new Error(
				"Genesis already applied (height: " +
					this.chain[this.chain.length - 1]!.height +
					"), cannot re-initialize",
			);
		}

		// Build genesis allocation transactions
		const genesisTxs = buildGenesisTransactions(this.config);

		// Apply each allocation to state
		for (const tx of genesisTxs) {
			applyTransaction(tx, this.state, 0);
		}

		const genDelRoot = this.delegations?.computeRoot();
		const genesisBlock: Block = {
			height: 0,
			previousHash: "0".repeat(64),
			stateRoot: this.state.computeStateRoot(genDelRoot),
			transactionsRoot: computeTransactionsRoot(genesisTxs),
			timestamp: this.config.timestamp,
			proposer: "genesis",
			transactions: genesisTxs,
			attestations: [],
		};

		this.chain.push(genesisBlock);
		return genesisBlock;
	}

	/**
	 * Produce a new block.
	 * Collects transactions from mempool, validates, applies, computes state root.
	 */
	produceBlock(
		proposer: string,
		maxTxPerBlock = 100,
	): Block {
		const previousBlock = this.chain[this.chain.length - 1];
		if (!previousBlock) {
			throw new Error("Chain not initialized. Call initGenesis() first.");
		}

		const previousHash = computeBlockHash(previousBlock);
		const height = previousBlock.height + 1;

		// Collect and validate transactions
		const candidates = this.mempool.drain(maxTxPerBlock);
		const validTxs: Transaction[] = [];

		for (const tx of candidates) {
			const result = validateTransaction(tx, this.state);
			if (result.valid) {
				applyTransaction(
					tx,
					this.state,
					this.config.protocolFees.storageFeeProtocolShare,
				);
				validTxs.push(tx);
			}
		}

		// Apply block reward (emission)
		const reward = computeBlockReward(
			height,
			this.config.emissionPerBlock,
			5_256_000, // ~1 year at 6s blocks
			this.config.networkRewardsPool,
			this.totalEmitted,
		);

		if (reward > 0n) {
			const poolBalance = this.state.getBalance(REWARDS_POOL);
			if (poolBalance >= reward) {
				this.state.debit(REWARDS_POOL, reward);
				this.totalEmitted += reward;

				// Split reward: if delegations exist, distribute proportionally
				if (this.delegations) {
					const ownStake = this.state.getAccount(proposer).stakedBalance;
					const splits = this.delegations.computeRewardSplit(
						proposer,
						ownStake,
						reward,
					);
					// Credit proposer's share directly
					const proposerShare = splits.get(proposer) ?? reward;
					this.state.credit(proposer, proposerShare);

					// Accrue delegator rewards as pending (claimed via reward_claim)
					for (const [did, share] of splits) {
						if (did !== proposer && share > 0n) {
							this.state.addPendingRewards(did, share);
						}
					}
				} else {
					// No delegation registry: full reward to proposer
					this.state.credit(proposer, reward);
				}

				// Include reward as a visible transaction in the block
				const rewardTx: Transaction = {
					type: "block_reward",
					from: REWARDS_POOL,
					to: proposer,
					amount: reward,
					nonce: 0,
					timestamp: Date.now(),
					signature: new Uint8Array(64),
				};
				validTxs.push(rewardTx);
			}
		}

		const delegationRoot = this.delegations?.computeRoot();
		const block: Block = {
			height,
			previousHash,
			stateRoot: this.state.computeStateRoot(delegationRoot),
			transactionsRoot: computeTransactionsRoot(validTxs),
			timestamp: Date.now(),
			proposer,
			transactions: validTxs,
			attestations: [],
		};

		this.chain.push(block);
		return block;
	}

	/**
	 * Validate an incoming block (from another proposer).
	 * Replays transactions against a copy of the state and verifies the state root.
	 */
	validateBlock(block: Block): { valid: boolean; error?: string } {
		const previousBlock = this.chain[this.chain.length - 1];
		if (!previousBlock) {
			return { valid: false, error: "Chain not initialized" };
		}

		// Check height
		if (block.height !== previousBlock.height + 1) {
			return {
				valid: false,
				error: `Invalid height: expected ${previousBlock.height + 1}, got ${block.height}`,
			};
		}

		// Check previous hash
		const expectedPrevHash = computeBlockHash(previousBlock);
		if (block.previousHash !== expectedPrevHash) {
			return { valid: false, error: "Invalid previous hash" };
		}

		// Verify transactions root
		const expectedTxRoot = computeTransactionsRoot(block.transactions);
		if (block.transactionsRoot !== expectedTxRoot) {
			return { valid: false, error: "Invalid transactions root" };
		}

		// Replay transactions against state copy (includes block_reward tx)
		const stateCopy = this.state.clone();
		for (const tx of block.transactions) {
			// block_reward txs are protocol-generated, skip nonce/balance checks
			if (tx.type !== "block_reward") {
				const result = validateTransaction(tx, stateCopy);
				if (!result.valid) {
					return {
						valid: false,
						error: `Invalid transaction: ${result.error}`,
					};
				}
			}
			applyTransaction(
				tx,
				stateCopy,
				this.config.protocolFees.storageFeeProtocolShare,
			);
		}

		// Check state root (includes delegation registry root if available)
		const delRoot = this.delegations?.computeRoot();
		const expectedStateRoot = stateCopy.computeStateRoot(delRoot);
		if (block.stateRoot !== expectedStateRoot) {
			return { valid: false, error: "Invalid state root" };
		}

		return { valid: true };
	}

	/**
	 * Get a block by height.
	 */
	getBlock(height: number): Block | null {
		return this.chain[height] ?? null;
	}

	/**
	 * Get the latest block.
	 */
	getLatestBlock(): Block | null {
		return this.chain[this.chain.length - 1] ?? null;
	}

	/**
	 * Get the current chain height.
	 */
	getHeight(): number {
		const latest = this.getLatestBlock();
		return latest ? latest.height : -1;
	}

	/**
	 * Get the account state.
	 */
	getState(): AccountState {
		return this.state;
	}

	/**
	 * Set the delegation registry for reward splitting.
	 */
	setDelegationRegistry(registry: DelegationRegistry): void {
		this.delegations = registry;
	}

	/**
	 * Get the delegation registry.
	 */
	getDelegationRegistry(): DelegationRegistry | null {
		return this.delegations;
	}

	/**
	 * Get total emitted rewards.
	 */
	getTotalEmitted(): bigint {
		return this.totalEmitted;
	}
}
