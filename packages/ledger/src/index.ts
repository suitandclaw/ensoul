export type {
	TransactionType,
	Transaction,
	TxReceipt,
	Account,
	Block,
	BlockAttestation,
	GenesisConfig,
	GenesisAllocation,
	EmissionSchedule,
} from "./types.js";

export { AccountState } from "./accounts.js";

export {
	computeTxHash,
	encodeTxPayload,
	validateTransactionWithSignature,
	verifyTxSignature,
	validateTransaction,
	applyTransaction,
	PROTOCOL_TREASURY,
	BURN_ADDRESS,
	REWARDS_POOL,
} from "./transactions.js";

export { Mempool } from "./mempool.js";

export {
	BlockProducer,
	computeBlockHash,
	computeTransactionsRoot,
	computeBlockReward,
	EMISSION_V2_HEIGHT,
} from "./blocks.js";

export { createDefaultGenesis, validateGenesis, buildGenesisTransactions } from "./genesis.js";

export { DelegationRegistry, MIN_DELEGATION, COMMISSION_RATE, STORAGE_CREDIT_THRESHOLD, PIONEER_LOCK_DURATION_MS } from "./delegations.js";
export type { DelegationCategory } from "./delegations.js";

// L1 protections (lessons learned from Solana, Ethereum, Sui, Polygon)
export {
	enforcePerIdentityLimit,
	ConsensusWatchdog,
	AdaptiveBlockTime,
	validateBlockLimits,
	estimateBlockSize,
	DEFAULT_BLOCK_LIMITS,
	ValidatorLifecycle,
	EnhancedMempool,
} from "./protections.js";

export type { BlockLimits } from "./protections.js";
