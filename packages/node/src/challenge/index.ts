export {
	generateChallenge,
	respondToChallenge,
	verifyResponse,
	ReputationTracker,
	ChallengeScheduler,
} from "./module.js";

export type {
	Challenge,
	ChallengeResponse,
	VerificationResult,
	NodeReputation,
	ChallengeSchedulerConfig,
	ChallengableShard,
} from "./types.js";
