// Storage engine
export {
	StorageEngine,
	computeShardHash,
} from "./storage/index.js";

export type {
	ShardMetadata,
	Shard,
	StoreShardRequest,
	ShardKey,
	AgentStorageStats,
	StorageStats,
	StorageEngineConfig,
} from "./storage/index.js";

// Consensus module
export {
	ConsensusModule,
	encodeAttestationPayload,
} from "./consensus/index.js";

export type {
	ValidatorInfo,
	Attestation,
	AttestationPayload,
	ThresholdResult,
	ConsensusConfig,
} from "./consensus/index.js";

// Challenge module
export {
	generateChallenge,
	respondToChallenge,
	verifyResponse,
	ReputationTracker,
	ChallengeScheduler,
} from "./challenge/index.js";

export type {
	Challenge,
	ChallengeResponse,
	VerificationResult,
	NodeReputation,
	ChallengeSchedulerConfig,
	ChallengableShard,
} from "./challenge/index.js";

// API server
export { createApiServer } from "./api/index.js";

export type { ApiServerConfig, CreditBalance } from "./api/index.js";

// Chain integration (block production + sync)
export { NodeBlockProducer, BlockSync, GossipNetwork } from "./chain/index.js";

// CLI
export { parseArgs, expandHome, printHelp, EnsoulNodeRunner, formatStatus } from "./cli/index.js";
export type { CliArgs, NodeStatus } from "./cli/index.js";
export {
	serializeBlock,
	deserializeBlock,
	serializeTx,
	deserializeTx,
} from "./chain/index.js";
// Replication enforcement (Layer 6)
export { ReplicationEnforcer } from "./replication/index.js";
export type { ReplicationAction } from "./replication/index.js";
export type {
	ReplicationHealth,
	ReplicationStatus,
	ReplicationConfig,
	ReplicationSummary,
	ConsciousnessRegistration,
} from "./replication/index.js";

// Trust level calculation
export {
	computeTrustLevel,
	assessTrust,
	hashTrustAssessment,
	trustLevelToNumber,
	numberToTrustLevel,
} from "./trust/index.js";
export type {
	TrustLevel,
	TrustLevelNumber,
	TrustAssessment,
	LayerStatus,
	TrustInput,
} from "./trust/index.js";

export type {
	ChainNodeConfig,
	BlockMessage,
	TxMessage,
	SyncRequestMessage,
	SyncResponseMessage,
	ChainMessage,
	SerializedBlock,
	SerializedTx,
} from "./chain/index.js";
