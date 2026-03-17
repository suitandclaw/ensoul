import type {
	ReplicationHealth,
	ReplicationStatus,
	ReplicationConfig,
	ReplicationSummary,
	ConsciousnessRegistration,
} from "./types.js";

const DEFAULT_CONFIG: ReplicationConfig = {
	preservationThreshold: 10,
	preservationRewardMultiplier: 2,
};

/**
 * Minimum Replication Enforcement (Layer 6).
 *
 * Tracks replication health per consciousness, triggers auto-repair,
 * and activates preservation mode during mass failures.
 */
export class ReplicationEnforcer {
	private config: ReplicationConfig;
	private registrations: Map<string, ConsciousnessRegistration> = new Map();
	private _preservationMode = false;

	/** Actions emitted during health checks. */
	private pendingActions: ReplicationAction[] = [];

	constructor(config?: Partial<ReplicationConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Register a consciousness for replication tracking.
	 */
	register(
		did: string,
		requiredReplicas: number,
		dataShards: number,
	): void {
		this.registrations.set(did, {
			did,
			requiredReplicas,
			dataShards,
			nodeHolders: new Set(),
		});
	}

	/**
	 * Remove a consciousness from tracking.
	 */
	unregister(did: string): void {
		this.registrations.delete(did);
	}

	/**
	 * Record that a node holds a shard for a consciousness.
	 */
	addHolder(consciousnessDid: string, nodeDid: string): void {
		const reg = this.registrations.get(consciousnessDid);
		if (reg) {
			reg.nodeHolders.add(nodeDid);
		}
	}

	/**
	 * Record that a node no longer holds a shard.
	 */
	removeHolder(consciousnessDid: string, nodeDid: string): void {
		const reg = this.registrations.get(consciousnessDid);
		if (reg) {
			reg.nodeHolders.delete(nodeDid);
		}
	}

	/**
	 * Compute the health status of a single consciousness.
	 */
	computeHealth(did: string): ReplicationHealth | null {
		const reg = this.registrations.get(did);
		if (!reg) return null;

		const current = reg.nodeHolders.size;
		const status = this.classifyStatus(
			current,
			reg.requiredReplicas,
			reg.dataShards,
		);

		return {
			consciousnessDid: did,
			requiredReplicas: reg.requiredReplicas,
			currentReplicas: current,
			dataShards: reg.dataShards,
			healthStatus: status,
		};
	}

	/**
	 * Run a full replication health check across all consciousnesses.
	 * This should be called every block by validators.
	 * Returns the list of actions needed.
	 */
	runHealthCheck(): {
		summary: ReplicationSummary;
		actions: ReplicationAction[];
	} {
		this.pendingActions = [];
		let healthy = 0;
		let degraded = 0;
		let critical = 0;
		let emergency = 0;
		const total = this.registrations.size;

		for (const [did, reg] of this.registrations) {
			const current = reg.nodeHolders.size;
			const status = this.classifyStatus(
				current,
				reg.requiredReplicas,
				reg.dataShards,
			);

			switch (status) {
				case "healthy":
					healthy++;
					break;
				case "degraded":
					degraded++;
					this.pendingActions.push({
						type: "auto_repair",
						consciousnessDid: did,
						urgency: "normal",
						shardsNeeded: reg.requiredReplicas - current,
					});
					break;
				case "critical":
					critical++;
					this.pendingActions.push({
						type: "urgent_repair",
						consciousnessDid: did,
						urgency: "high",
						shardsNeeded: reg.requiredReplicas - current,
					});
					break;
				case "emergency":
					emergency++;
					this.pendingActions.push({
						type: "emergency_replication",
						consciousnessDid: did,
						urgency: "emergency",
						shardsNeeded: reg.requiredReplicas - current,
					});
					break;
			}
		}

		// Check preservation mode threshold
		const emergencyPct =
			total > 0 ? (emergency / total) * 100 : 0;

		if (
			emergencyPct > this.config.preservationThreshold &&
			!this._preservationMode
		) {
			this._preservationMode = true;
			this.pendingActions.push({
				type: "preservation_mode_activated",
				consciousnessDid: "",
				urgency: "emergency",
				shardsNeeded: 0,
			});
		} else if (
			emergency === 0 &&
			this._preservationMode
		) {
			this._preservationMode = false;
			this.pendingActions.push({
				type: "preservation_mode_deactivated",
				consciousnessDid: "",
				urgency: "normal",
				shardsNeeded: 0,
			});
		}

		return {
			summary: {
				total,
				healthy,
				degraded,
				critical,
				emergency,
				preservationMode: this._preservationMode,
			},
			actions: [...this.pendingActions],
		};
	}

	/**
	 * Is the network in preservation mode?
	 */
	isPreservationMode(): boolean {
		return this._preservationMode;
	}

	/**
	 * Should new storage requests be paused?
	 */
	shouldPauseNewStorage(): boolean {
		return this._preservationMode;
	}

	/**
	 * Get the block reward multiplier (2x during preservation mode).
	 */
	getRewardMultiplier(): number {
		return this._preservationMode
			? this.config.preservationRewardMultiplier
			: 1;
	}

	/**
	 * Get the number of tracked consciousnesses.
	 */
	getRegistrationCount(): number {
		return this.registrations.size;
	}

	/**
	 * Get the summary without running a full check.
	 */
	getSummary(): ReplicationSummary {
		const result = this.runHealthCheck();
		return result.summary;
	}

	// ── Internal ─────────────────────────────────────────────────

	private classifyStatus(
		current: number,
		required: number,
		dataShards: number,
	): ReplicationStatus {
		if (current >= required) return "healthy";
		if (current >= required - 1) return "degraded";
		if (current >= dataShards) return "critical";
		return "emergency";
	}
}

/**
 * An action emitted by the replication health check.
 */
export interface ReplicationAction {
	type:
		| "auto_repair"
		| "urgent_repair"
		| "emergency_replication"
		| "preservation_mode_activated"
		| "preservation_mode_deactivated";
	consciousnessDid: string;
	urgency: "normal" | "high" | "emergency";
	shardsNeeded: number;
}
