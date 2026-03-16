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
