/**
 * Attack types for adversarial simulation.
 */
export type AttackType =
	| "data_withholding"
	| "state_corruption"
	| "replay_attack"
	| "key_compromise"
	| "consensus_manipulation"
	| "shard_reconstruction"
	| "credit_inflation";

/**
 * An attack scenario to simulate.
 */
export interface AttackScenario {
	name: string;
	type: AttackType;
	parameters: Record<string, unknown>;
}

/**
 * Result of running an attack simulation.
 */
export interface SimulationResult {
	scenario: string;
	type: AttackType;
	passed: boolean;
	details: string;
	durationMs: number;
}

/**
 * A single check within an audit report.
 */
export interface AuditCheck {
	name: string;
	passed: boolean;
	severity: "critical" | "high" | "medium" | "low";
	details: string;
}

/**
 * Audit report for a module.
 */
export interface AuditReport {
	module: string;
	timestamp: number;
	checks: AuditCheck[];
	overallPass: boolean;
}

/**
 * A registered invariant check.
 */
export interface InvariantCheck {
	name: string;
	check: () => Promise<boolean>;
}

/**
 * Result of running an invariant check.
 */
export interface InvariantResult {
	name: string;
	passed: boolean;
}
