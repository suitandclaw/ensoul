/**
 * A proof-of-storage challenge: asks a node to prove it holds a shard
 * by hashing a specific byte range.
 */
export interface Challenge {
	/** Unique challenge identifier */
	id: string;
	/** DID of the node being challenged */
	nodeDid: string;
	/** DID of the agent whose shard is being challenged */
	agentDid: string;
	/** Version of the shard */
	version: number;
	/** Shard index within the erasure-coded set */
	shardIndex: number;
	/** Byte offset to start hashing from */
	offset: number;
	/** Number of bytes to hash */
	length: number;
	/** Unix timestamp (ms) when the challenge was issued */
	issuedAt: number;
	/** Unix timestamp (ms) by which the response must be received */
	deadline: number;
}

/**
 * A response to a challenge: the Blake3 hash of the requested byte range.
 */
export interface ChallengeResponse {
	/** ID of the challenge being responded to */
	challengeId: string;
	/** Blake3 hash of shard[offset..offset+length] (hex) */
	hash: string;
	/** Unix timestamp (ms) when the response was created */
	respondedAt: number;
}

/**
 * Result of verifying a challenge response.
 */
export interface VerificationResult {
	/** Whether the response is valid */
	valid: boolean;
	/** Reason for failure if invalid */
	reason?: string;
}

/**
 * Reputation record for a single node.
 */
export interface NodeReputation {
	/** DID of the node */
	nodeDid: string;
	/** Total challenges issued to this node */
	totalChallenges: number;
	/** Number of challenges passed */
	passed: number;
	/** Number of challenges failed */
	failed: number;
	/** Current reputation score (0.0 to 1.0) */
	score: number;
	/** Unix timestamp (ms) of the last challenge */
	lastChallengeAt: number;
}

/**
 * Configuration for the challenge scheduler.
 */
export interface ChallengeSchedulerConfig {
	/** Interval in ms between challenge rounds. */
	intervalMs: number;
	/** Maximum byte range length for a challenge. */
	maxChallengeLength: number;
	/** Time in ms a node has to respond to a challenge. */
	deadlineMs: number;
}

/**
 * Describes a shard that can be challenged.
 */
export interface ChallengableShard {
	nodeDid: string;
	agentDid: string;
	version: number;
	shardIndex: number;
	shardSize: number;
}
