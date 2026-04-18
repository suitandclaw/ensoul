/**
 * Transaction types in the Ensoul L1.
 */
export type TransactionType =
	| "send"
	| "transfer"
	| "stake"
	| "unstake"
	| "storage_payment"
	| "reward_claim"
	| "block_reward"
	| "genesis_allocation"
	| "delegate"
	| "undelegate"
	| "slash"
	| "burn"
	| "redelegate"
	| "consensus_join"
	| "consensus_leave"
	| "consensus_force_remove"
	| "pioneer_delegate";

/**
 * A transaction on the Ensoul chain.
 */
export interface Transaction {
	type: TransactionType;
	from: string;
	to: string;
	amount: bigint;
	nonce: number;
	timestamp: number;
	data?: Uint8Array;
	signature: Uint8Array;
}

/**
 * Transaction receipt after inclusion in a block.
 */
export interface TxReceipt {
	txHash: string;
	blockHeight: number;
	status: "success" | "failed";
	error?: string;
}

/**
 * Account state on the Ensoul chain.
 */
export interface Account {
	did: string;
	balance: bigint;
	stakedBalance: bigint;
	unstakingBalance: bigint;
	unstakingCompleteAt: number;
	stakeLockedUntil: number;
	delegatedBalance: bigint;
	pendingRewards: bigint;
	nonce: number;
	storageCredits: bigint;
	lastActivity: number;
}

/**
 * Attestation from a validator on a block.
 */
export interface BlockAttestation {
	validatorDid: string;
	signature: Uint8Array;
	timestamp: number;
}

/**
 * A block on the Ensoul chain.
 */
export interface Block {
	height: number;
	previousHash: string;
	stateRoot: string;
	transactionsRoot: string;
	timestamp: number;
	proposer: string;
	transactions: Transaction[];
	attestations: BlockAttestation[];
}

/**
 * Genesis allocation entry.
 */
export interface GenesisAllocation {
	label: string;
	percentage: number;
	tokens: bigint;
	recipient: string;
	/** If true, tokens are credited as staked balance (for validators). */
	autoStake?: boolean;
}

/**
 * Genesis configuration.
 */
export interface GenesisConfig {
	chainId: string;
	timestamp: number;
	totalSupply: bigint;
	allocations: GenesisAllocation[];
	emissionPerBlock: bigint;
	networkRewardsPool: bigint;
	protocolFees: {
		storageFeeProtocolShare: number;
		txBaseFee: bigint;
	};
}

/**
 * Emission schedule configuration.
 */
export interface EmissionSchedule {
	/** Tokens released per block in year 1. */
	year1PerBlock: bigint;
	/** Blocks per halving interval (~3 years). */
	halvingIntervalBlocks: number;
	/** Total tokens reserved for emission. */
	totalReserved: bigint;
	/** Total tokens emitted so far. */
	totalEmitted: bigint;
}
