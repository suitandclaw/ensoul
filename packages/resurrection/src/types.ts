/**
 * Agent vital status in the death state machine.
 */
export type VitalStatus =
	| "alive"
	| "concerning"
	| "unresponsive"
	| "dead"
	| "resurrecting"
	| "orphaned";

/**
 * An agent heartbeat: periodic proof of life.
 */
export interface Heartbeat {
	agentDid: string;
	timestamp: number;
	blockHeight: number;
	consciousnessVersion: number;
	runtimeInfo: RuntimeInfo;
	signature: Uint8Array;
}

/**
 * Runtime information reported with each heartbeat.
 */
export interface RuntimeInfo {
	framework: string;
	uptime: number;
	host: string;
}

/**
 * Heartbeat monitor configuration per agent.
 */
export interface HeartbeatConfig {
	/** Heartbeat interval in blocks (default ~50 blocks = 5 min at 6s). */
	intervalBlocks: number;
	/** Blocks with no heartbeat before CONCERNING. */
	concerningThreshold: number;
	/** Blocks with no heartbeat before UNRESPONSIVE. */
	unresponsiveThreshold: number;
	/** Blocks with no heartbeat before DEAD. */
	deadThreshold: number;
}

/**
 * Tracked agent state in the heartbeat monitor.
 */
export interface AgentVitalRecord {
	did: string;
	status: VitalStatus;
	lastHeartbeatBlock: number;
	lastHeartbeatTimestamp: number;
	consciousnessVersion: number;
	config: HeartbeatConfig;
	statusChangedAt: number;
}

/**
 * A status transition event logged on-chain.
 */
export interface StatusTransition {
	agentDid: string;
	fromStatus: VitalStatus;
	toStatus: VitalStatus;
	blockHeight: number;
	timestamp: number;
}

/**
 * A guardian in the resurrection plan.
 */
export interface Guardian {
	did: string;
	canTriggerResurrection: boolean;
	canModifyPlan: boolean;
	canAccessConsciousness: boolean;
	notifyOnDeath: boolean;
}

/**
 * Minimum compute requirements for resurrection.
 */
export interface ComputeRequirements {
	cpuCores: number;
	memoryGB: number;
	storageGB: number;
	gpuRequired: boolean;
}

/**
 * A resurrection plan stored on-chain, signed by the agent.
 */
export interface ResurrectionPlan {
	version: number;
	agentDid: string;
	lastUpdated: number;
	heartbeatInterval: number;
	gracePeriod: number;
	runtime: {
		framework: string;
		frameworkVersion: string;
		entrypoint: string;
		minCompute: ComputeRequirements;
	};
	preferences: {
		preferredHosts: string[];
		excludedHosts: string[];
		maxResurrectionTime: number;
		autoResurrect: boolean;
	};
	guardians: Guardian[];
	economics: {
		resurrectionBounty: bigint;
		maxHostingCost: bigint;
		escrowBalance: bigint;
	};
	signature: Uint8Array;
}

/**
 * Death declaration submitted to the chain.
 */
export interface DeathDeclaration {
	agentDid: string;
	lastHeartbeatBlock: number;
	currentHeight: number;
	gracePeriodBlocks: number;
	declaredBy: string;
	signature: Uint8Array;
}

/**
 * A bid to host a resurrected agent.
 */
export interface ResurrectionBid {
	agentDid: string;
	hostDid: string;
	capabilities: ComputeRequirements;
	proposedCostPerBlock: bigint;
	estimatedResurrectionTime: number;
	hostReputation: number;
	signature: Uint8Array;
}

/**
 * Confirmation that an agent has been resurrected.
 */
export interface ResurrectionConfirmation {
	agentDid: string;
	hostDid: string;
	consciousnessVersion: number;
	stateRoot: string;
	previousDeathBlock: number;
	resurrectionBlock: number;
	signature: Uint8Array;
}

/**
 * Result of a resurrection auction.
 */
export interface AuctionResult {
	winnerDid: string;
	costPerBlock: bigint;
	estimatedTime: number;
	bidCount: number;
}
