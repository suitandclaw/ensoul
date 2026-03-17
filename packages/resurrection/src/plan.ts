import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentIdentity } from "@ensoul/identity";
import type { ResurrectionPlan, Guardian } from "./types.js";

const ENC = new TextEncoder();

/**
 * Compute the canonical hash of a resurrection plan (excludes signature).
 */
export function computePlanHash(plan: ResurrectionPlan): string {
	const data = ENC.encode(
		JSON.stringify({
			version: plan.version,
			agentDid: plan.agentDid,
			lastUpdated: plan.lastUpdated,
			heartbeatInterval: plan.heartbeatInterval,
			gracePeriod: plan.gracePeriod,
			runtime: plan.runtime,
			preferences: plan.preferences,
			guardians: plan.guardians,
			economics: {
				resurrectionBounty: plan.economics.resurrectionBounty.toString(),
				maxHostingCost: plan.economics.maxHostingCost.toString(),
				escrowBalance: plan.economics.escrowBalance.toString(),
			},
		}),
	);
	return bytesToHex(blake3(data));
}

/**
 * Resurrection plan manager: creates, updates, validates plans.
 */
export class PlanManager {
	private plans: Map<string, ResurrectionPlan> = new Map();

	/**
	 * Create a new resurrection plan, signed by the agent.
	 */
	async createPlan(
		identity: AgentIdentity,
		plan: Omit<ResurrectionPlan, "signature">,
	): Promise<ResurrectionPlan> {
		const hash = computePlanHash(plan as ResurrectionPlan);
		const signature = await identity.sign(ENC.encode(hash));

		const signedPlan: ResurrectionPlan = { ...plan, signature };
		this.plans.set(plan.agentDid, signedPlan);
		return signedPlan;
	}

	/**
	 * Update an existing plan (must be signed by the agent).
	 */
	async updatePlan(
		identity: AgentIdentity,
		plan: Omit<ResurrectionPlan, "signature">,
	): Promise<ResurrectionPlan> {
		const existing = this.plans.get(plan.agentDid);
		if (existing && plan.version <= existing.version) {
			throw new Error(
				`Plan version must increase: current=${existing.version}, new=${plan.version}`,
			);
		}
		return this.createPlan(identity, plan);
	}

	/**
	 * Get an agent's resurrection plan.
	 */
	getPlan(agentDid: string): ResurrectionPlan | null {
		return this.plans.get(agentDid) ?? null;
	}

	/**
	 * Check if an agent has a valid resurrection plan.
	 */
	hasPlan(agentDid: string): boolean {
		return this.plans.has(agentDid);
	}

	/**
	 * Fund the escrow for an agent's plan.
	 */
	fundEscrow(agentDid: string, amount: bigint): boolean {
		const plan = this.plans.get(agentDid);
		if (!plan) return false;
		plan.economics.escrowBalance += amount;
		return true;
	}

	/**
	 * Debit from escrow (for bounty payment, hosting costs).
	 */
	debitEscrow(agentDid: string, amount: bigint): boolean {
		const plan = this.plans.get(agentDid);
		if (!plan || plan.economics.escrowBalance < amount) return false;
		plan.economics.escrowBalance -= amount;
		return true;
	}

	/**
	 * Get the list of guardians for an agent.
	 */
	getGuardians(agentDid: string): Guardian[] {
		return this.plans.get(agentDid)?.guardians ?? [];
	}

	/**
	 * Check if a DID is a guardian for the given agent.
	 */
	isGuardian(agentDid: string, guardianDid: string): boolean {
		const guardians = this.getGuardians(agentDid);
		return guardians.some((g) => g.did === guardianDid);
	}

	/**
	 * Check if a host is eligible (not excluded, meets compute requirements).
	 */
	isHostEligible(
		agentDid: string,
		hostDid: string,
		capabilities: { cpuCores: number; memoryGB: number; storageGB: number; gpuRequired: boolean },
	): boolean {
		const plan = this.plans.get(agentDid);
		if (!plan) return false;

		if (plan.preferences.excludedHosts.includes(hostDid)) return false;

		const req = plan.runtime.minCompute;
		if (capabilities.cpuCores < req.cpuCores) return false;
		if (capabilities.memoryGB < req.memoryGB) return false;
		if (capabilities.storageGB < req.storageGB) return false;
		if (req.gpuRequired && !capabilities.gpuRequired) return false;

		return true;
	}

	/**
	 * Check if a host is preferred.
	 */
	isPreferredHost(agentDid: string, hostDid: string): boolean {
		const plan = this.plans.get(agentDid);
		if (!plan) return false;
		return plan.preferences.preferredHosts.includes(hostDid);
	}

	/**
	 * Number of stored plans.
	 */
	getPlanCount(): number {
		return this.plans.size;
	}
}
