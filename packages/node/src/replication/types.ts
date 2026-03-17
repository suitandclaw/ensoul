/**
 * Health status of a consciousness's replication.
 */
export type ReplicationStatus = "healthy" | "degraded" | "critical" | "emergency";

/**
 * Replication health record for a single consciousness.
 */
export interface ReplicationHealth {
	consciousnessDid: string;
	requiredReplicas: number;
	currentReplicas: number;
	dataShards: number;
	healthStatus: ReplicationStatus;
}

/**
 * Configuration for the replication enforcement module.
 */
export interface ReplicationConfig {
	/** Percentage of consciousnesses in emergency to trigger preservation mode. */
	preservationThreshold: number;
	/** Multiplier for block rewards during preservation mode. */
	preservationRewardMultiplier: number;
}

/**
 * Network-wide replication summary.
 */
export interface ReplicationSummary {
	total: number;
	healthy: number;
	degraded: number;
	critical: number;
	emergency: number;
	preservationMode: boolean;
}

/**
 * A consciousness registration: tracks what the network must protect.
 */
export interface ConsciousnessRegistration {
	did: string;
	requiredReplicas: number;
	dataShards: number;
	nodeHolders: Set<string>;
}
