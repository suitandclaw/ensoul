import type { TrustLevel } from "@ensoul/node";
import type { VitalStatus } from "@ensoul/resurrection";

/**
 * Data source interface that the explorer reads from.
 * Abstracts the node's local state for testability.
 */
export interface ExplorerDataSource {
	getChainHeight(): number;
	getBlock(height: number): BlockData | null;
	getBlocks(from: number, to: number): BlockData[];
	getValidators(): ValidatorData[];
	getAgentProfile(did: string): AgentProfile | null;
	getNetworkStats(): NetworkStats;
	getLatestCheckpoint(): CheckpointData | null;
}

export interface BlockData {
	height: number;
	hash: string;
	parentHash: string;
	proposer: string;
	timestamp: number;
	txCount: number;
	transactions: TxData[];
}

export interface TxData {
	hash: string;
	type: string;
	from: string;
	to: string;
	amount: string;
	timestamp: number;
}

export interface ValidatorData {
	did: string;
	stake: string;
	blocksProduced: number;
	uptimePercent: number;
	delegation: "foundation" | "self" | "delegated";
	tier?: "genesis" | "foundation" | "pioneer" | "open" | "standard";
}

export interface AgentProfile {
	did: string;
	consciousnessAgeDays: number;
	consciousnessVersions: number;
	consciousnessBytes: number;
	trustLevel: TrustLevel;
	ensouledSince: string;
	lastHeartbeat: number;
	healthStatus: VitalStatus;
	stateRoot: string;
}

export interface NetworkStats {
	blockHeight: number;
	validatorCount: number;
	totalAgents: number;
	totalConsciousnessBytes: number;
	totalTransactions: number;
	averageBlockTimeMs: number;
	totalSupply: string;
	totalBurned: string;
	totalStaked: string;
	agentsByTrustLevel: Record<string, number>;
}

export interface CheckpointData {
	blockHeight: number;
	hash: string;
	stateRoot: string;
	consciousnessRoot: string;
	validatorSetHash: string;
	totalConsciousnesses: number;
	timestamp: number;
	signatureCount: number;
}
