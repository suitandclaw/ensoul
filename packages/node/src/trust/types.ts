/**
 * Trust levels for consciousness protection.
 * Based on which Ensoul-native protection layers an agent has active.
 */
export type TrustLevel =
	| "basic"
	| "verified"
	| "anchored"
	| "immortal"
	| "sovereign";

/**
 * Numeric trust level (1-5) for on-chain storage.
 */
export type TrustLevelNumber = 1 | 2 | 3 | 4 | 5;

/**
 * Trust level assessment for an agent.
 */
export interface TrustAssessment {
	did: string;
	level: TrustLevel;
	numericLevel: TrustLevelNumber;
	label: string;
	description: string;
	layers: LayerStatus[];
	timestamp: number;
}

/**
 * Status of a protection layer for an agent.
 */
export interface LayerStatus {
	layer: number;
	name: string;
	active: boolean;
	details: string;
}

/**
 * Input data for computing a trust level.
 * All layers are Ensoul-native — no external chain dependencies.
 */
export interface TrustInput {
	/** Agent has consciousness stored on Ensoul with erasure coding. */
	hasEnsoulStorage: boolean;
	/** Proof-of-storage challenges are passing. */
	proofOfStoragePassing: boolean;
	/** Agent self-audit is passing. */
	selfAuditPassing: boolean;
	/** Internal checkpointing active (validator-signed state snapshots). */
	checkpointActive: boolean;
	/** Deep archive (higher replication snapshot) configured and recent. */
	deepArchiveActive: boolean;
	/** Resurrection plan is configured. */
	resurrectionPlanActive: boolean;
	/** Redundant runtime available. */
	redundantRuntime: boolean;
	/** Guardian network configured. */
	guardianNetwork: boolean;
	/** Self-funded escrow for operations. */
	selfFundedEscrow: boolean;
}
