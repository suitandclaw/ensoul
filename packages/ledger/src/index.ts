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
} from "./blocks.js";

export { createDefaultGenesis, validateGenesis } from "./genesis.js";

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
