/**
 * A validator-signed state checkpoint stored on the Ensoul chain.
 * Produced every N blocks as internal protocol state.
 */
export interface StateCheckpoint {
	ensoulBlockHeight: number;
	stateRoot: string;
	consciousnessRoot: string;
	validatorSetHash: string;
	totalConsciousnesses: number;
	totalSupply: bigint;
	timestamp: number;
	signatures: ValidatorSignature[];
}

/**
 * A validator's signature on a checkpoint.
 */
export interface ValidatorSignature {
	validatorDid: string;
	signature: Uint8Array;
}

/**
 * Result of verifying the current state against the last checkpoint.
 */
export interface CheckpointVerification {
	isValid: boolean;
	lastCheckpointHeight: number;
	lastCheckpointHash: string;
	discrepancy?: string;
}

/**
 * Configuration for the checkpoint service.
 */
export interface CheckpointConfig {
	/** Blocks between checkpoints. */
	interval: number;
	/** Minimum validator signatures required (>2/3). */
	minSignatures: number;
}
