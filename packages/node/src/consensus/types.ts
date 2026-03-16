/**
 * A registered validator in the consensus set.
 */
export interface ValidatorInfo {
	/** DID of the validator (did:key:z6Mk...) */
	did: string;
	/** Ed25519 public key (32 bytes) */
	publicKey: Uint8Array;
	/** Amount of tokens staked by this validator */
	stake: number;
	/** Unix timestamp (ms) when the validator was registered */
	registeredAt: number;
}

/**
 * An attestation: a validator's signed confirmation that it stored a shard.
 */
export interface Attestation {
	/** DID of the validator that signed this attestation */
	validatorDid: string;
	/** DID of the agent whose state is being attested */
	agentDid: string;
	/** Merkle root hash of the agent's state */
	stateRoot: string;
	/** Version number of the agent's state */
	version: number;
	/** Unix timestamp (ms) when the attestation was created */
	timestamp: number;
	/** Ed25519 signature over the attestation payload */
	signature: Uint8Array;
}

/**
 * The canonical message fields that are signed in an attestation.
 */
export interface AttestationPayload {
	validatorDid: string;
	agentDid: string;
	stateRoot: string;
	version: number;
	timestamp: number;
}

/**
 * Result of checking whether a threshold has been met.
 */
export interface ThresholdResult {
	/** Whether the threshold K-of-N was reached */
	met: boolean;
	/** Number of valid unique attestations collected */
	validCount: number;
	/** Required threshold */
	required: number;
	/** Total validators in the set */
	total: number;
}

/**
 * Configuration for the consensus module.
 */
export interface ConsensusConfig {
	/** Minimum number of attestations required (K in K-of-N) */
	threshold: number;
	/** Minimum stake required to register as a validator */
	minStake: number;
}
