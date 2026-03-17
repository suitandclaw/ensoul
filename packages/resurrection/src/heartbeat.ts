import type {
	VitalStatus,
	HeartbeatConfig,
	AgentVitalRecord,
	Heartbeat,
	StatusTransition,
} from "./types.js";

const DEFAULT_CONFIG: HeartbeatConfig = {
	intervalBlocks: 50,
	concerningThreshold: 50,
	unresponsiveThreshold: 150,
	deadThreshold: 14400, // ~24h at 6s blocks
};

/**
 * Heartbeat monitor: tracks agent vital status through
 * ALIVE → CONCERNING → UNRESPONSIVE → DEAD state machine.
 * Each transition is logged for on-chain recording.
 */
export class HeartbeatMonitor {
	private agents: Map<string, AgentVitalRecord> = new Map();
	private transitions: StatusTransition[] = [];

	/**
	 * Register an agent for heartbeat monitoring.
	 */
	register(
		did: string,
		startBlock: number,
		config?: Partial<HeartbeatConfig>,
	): void {
		this.agents.set(did, {
			did,
			status: "alive",
			lastHeartbeatBlock: startBlock,
			lastHeartbeatTimestamp: Date.now(),
			consciousnessVersion: 0,
			config: { ...DEFAULT_CONFIG, ...config },
			statusChangedAt: startBlock,
		});
	}

	/**
	 * Remove an agent from monitoring.
	 */
	unregister(did: string): void {
		this.agents.delete(did);
	}

	/**
	 * Record a heartbeat from an agent.
	 * Resets the agent's status to ALIVE regardless of current status.
	 */
	recordHeartbeat(heartbeat: Heartbeat): VitalStatus {
		const record = this.agents.get(heartbeat.agentDid);
		if (!record) return "alive";

		const previousStatus = record.status;
		record.lastHeartbeatBlock = heartbeat.blockHeight;
		record.lastHeartbeatTimestamp = heartbeat.timestamp;
		record.consciousnessVersion = heartbeat.consciousnessVersion;

		if (record.status !== "alive") {
			this.transition(record, "alive", heartbeat.blockHeight);
		}

		return previousStatus;
	}

	/**
	 * Check all agents at the given block height.
	 * Updates statuses and returns new transitions.
	 */
	tick(currentBlock: number): StatusTransition[] {
		const newTransitions: StatusTransition[] = [];

		for (const record of this.agents.values()) {
			if (record.status === "dead" || record.status === "resurrecting" || record.status === "orphaned") {
				continue;
			}

			const missed = currentBlock - record.lastHeartbeatBlock;
			let newStatus: VitalStatus = record.status;

			if (missed >= record.config.deadThreshold) {
				newStatus = "dead";
			} else if (missed >= record.config.unresponsiveThreshold) {
				newStatus = "unresponsive";
			} else if (missed >= record.config.concerningThreshold) {
				newStatus = "concerning";
			} else {
				newStatus = "alive";
			}

			if (newStatus !== record.status) {
				this.transition(record, newStatus, currentBlock);
				newTransitions.push(
					this.transitions[this.transitions.length - 1]!,
				);
			}
		}

		return newTransitions;
	}

	/**
	 * Manually set an agent's status (e.g., to RESURRECTING).
	 */
	setStatus(did: string, status: VitalStatus, blockHeight: number): void {
		const record = this.agents.get(did);
		if (!record) return;
		if (record.status !== status) {
			this.transition(record, status, blockHeight);
		}
	}

	/**
	 * Get an agent's current vital record.
	 */
	getRecord(did: string): AgentVitalRecord | null {
		return this.agents.get(did) ?? null;
	}

	/**
	 * Get an agent's current vital status.
	 */
	getStatus(did: string): VitalStatus {
		return this.agents.get(did)?.status ?? "orphaned";
	}

	/**
	 * Get all status transitions.
	 */
	getTransitions(): StatusTransition[] {
		return [...this.transitions];
	}

	/**
	 * Get transitions for a specific agent.
	 */
	getAgentTransitions(did: string): StatusTransition[] {
		return this.transitions.filter((t) => t.agentDid === did);
	}

	/**
	 * Get all agents in a specific status.
	 */
	getAgentsByStatus(status: VitalStatus): string[] {
		const result: string[] = [];
		for (const record of this.agents.values()) {
			if (record.status === status) result.push(record.did);
		}
		return result;
	}

	/**
	 * Number of monitored agents.
	 */
	getAgentCount(): number {
		return this.agents.size;
	}

	// ── Internal ─────────────────────────────────────────────────

	private transition(
		record: AgentVitalRecord,
		newStatus: VitalStatus,
		blockHeight: number,
	): void {
		const transition: StatusTransition = {
			agentDid: record.did,
			fromStatus: record.status,
			toStatus: newStatus,
			blockHeight,
			timestamp: Date.now(),
		};
		this.transitions.push(transition);
		record.status = newStatus;
		record.statusChangedAt = blockHeight;
	}
}
