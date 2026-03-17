/**
 * A state checkpoint for external chain anchoring.
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
 * Result of verifying the current state against an anchor.
 */
export interface AnchorVerification {
	isValid: boolean;
	lastAnchorHeight: number;
	lastAnchorHash: string;
	externalChain: "ethereum" | "bitcoin" | "none";
	externalTxHash: string;
	discrepancy?: string;
}

/**
 * Receipt from an external chain submission.
 */
export interface AnchorReceipt {
	chain: "ethereum" | "bitcoin";
	txHash: string;
	checkpointHash: string;
	blockHeight: number;
	timestamp: number;
}

/**
 * Configuration for the anchor service.
 */
export interface AnchorConfig {
	/** Blocks between Ethereum anchors. */
	ethereumInterval: number;
	/** Blocks between Bitcoin anchors. */
	bitcoinInterval: number;
	/** Minimum validator signatures required (>2/3). */
	minSignatures: number;
}
