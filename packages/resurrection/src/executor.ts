import type {
	DeathDeclaration,
	ResurrectionBid,
	ResurrectionConfirmation,
	AuctionResult,
} from "./types.js";
import type { HeartbeatMonitor } from "./heartbeat.js";
import type { PlanManager } from "./plan.js";

/**
 * Resurrection executor: handles death declarations,
 * resurrection auctions, and confirmation.
 */
export class ResurrectionExecutor {
	private monitor: HeartbeatMonitor;
	private plans: PlanManager;
	private pendingAuctions: Map<string, ResurrectionBid[]> = new Map();
	private completedResurrections: ResurrectionConfirmation[] = [];
	private auctionDurationBlocks: number;
	private maxBidsPerAuction: number;

	constructor(
		monitor: HeartbeatMonitor,
		plans: PlanManager,
		auctionDurationBlocks = 10,
		maxBidsPerAuction = 20,
	) {
		this.monitor = monitor;
		this.plans = plans;
		this.auctionDurationBlocks = auctionDurationBlocks;
		this.maxBidsPerAuction = maxBidsPerAuction;
	}

	/**
	 * Process a death declaration.
	 * Validates the declaration and opens a resurrection auction.
	 */
	declareDeathAndOpenAuction(
		declaration: DeathDeclaration,
	): { accepted: boolean; error?: string } {
		const status = this.monitor.getStatus(declaration.agentDid);

		if (status !== "dead") {
			return {
				accepted: false,
				error: `Agent is not dead (status: ${status})`,
			};
		}

		const plan = this.plans.getPlan(declaration.agentDid);
		if (!plan) {
			// No plan — agent becomes orphaned
			this.monitor.setStatus(
				declaration.agentDid,
				"orphaned",
				declaration.currentHeight,
			);
			return {
				accepted: false,
				error: "No resurrection plan — agent orphaned",
			};
		}

		if (!plan.preferences.autoResurrect) {
			return {
				accepted: false,
				error: "Auto-resurrect disabled — requires guardian action",
			};
		}

		// Open auction
		this.pendingAuctions.set(declaration.agentDid, []);
		this.monitor.setStatus(
			declaration.agentDid,
			"resurrecting",
			declaration.currentHeight,
		);

		return { accepted: true };
	}

	/**
	 * Submit a bid to host a resurrected agent.
	 */
	submitBid(bid: ResurrectionBid): { accepted: boolean; error?: string } {
		const bids = this.pendingAuctions.get(bid.agentDid);
		if (!bids) {
			return { accepted: false, error: "No active auction" };
		}

		// Check eligibility
		if (
			!this.plans.isHostEligible(bid.agentDid, bid.hostDid, bid.capabilities)
		) {
			return {
				accepted: false,
				error: "Host does not meet requirements or is excluded",
			};
		}

		// Check max bids
		if (bids.length >= this.maxBidsPerAuction) {
			// Replace worst bid if this one is better
			const worst = bids[bids.length - 1];
			if (worst && bid.proposedCostPerBlock < worst.proposedCostPerBlock) {
				bids.pop();
			} else {
				return { accepted: false, error: "Auction full" };
			}
		}

		bids.push(bid);
		// Sort by: preferred > cost > reputation > speed
		bids.sort((a, b) => {
			const aPref = this.plans.isPreferredHost(bid.agentDid, a.hostDid) ? 0 : 1;
			const bPref = this.plans.isPreferredHost(bid.agentDid, b.hostDid) ? 0 : 1;
			if (aPref !== bPref) return aPref - bPref;
			if (a.proposedCostPerBlock !== b.proposedCostPerBlock) {
				return a.proposedCostPerBlock < b.proposedCostPerBlock ? -1 : 1;
			}
			if (a.hostReputation !== b.hostReputation) {
				return b.hostReputation - a.hostReputation;
			}
			return a.estimatedResurrectionTime - b.estimatedResurrectionTime;
		});

		return { accepted: true };
	}

	/**
	 * Close an auction and select the winner.
	 */
	closeAuction(agentDid: string): AuctionResult | null {
		const bids = this.pendingAuctions.get(agentDid);
		if (!bids || bids.length === 0) {
			this.pendingAuctions.delete(agentDid);
			return null;
		}

		const winner = bids[0]!;
		this.pendingAuctions.delete(agentDid);

		// Debit escrow for the bounty
		const plan = this.plans.getPlan(agentDid);
		if (plan) {
			this.plans.debitEscrow(
				agentDid,
				plan.economics.resurrectionBounty,
			);
		}

		return {
			winnerDid: winner.hostDid,
			costPerBlock: winner.proposedCostPerBlock,
			estimatedTime: winner.estimatedResurrectionTime,
			bidCount: bids.length,
		};
	}

	/**
	 * Confirm a successful resurrection.
	 * Transitions the agent back to ALIVE.
	 */
	confirmResurrection(
		confirmation: ResurrectionConfirmation,
	): { accepted: boolean; error?: string } {
		const status = this.monitor.getStatus(confirmation.agentDid);
		if (status !== "resurrecting") {
			return {
				accepted: false,
				error: `Agent is not resurrecting (status: ${status})`,
			};
		}

		this.completedResurrections.push(confirmation);
		this.monitor.setStatus(
			confirmation.agentDid,
			"alive",
			confirmation.resurrectionBlock,
		);

		return { accepted: true };
	}

	/**
	 * Check if an auction is active for an agent.
	 */
	hasActiveAuction(agentDid: string): boolean {
		return this.pendingAuctions.has(agentDid);
	}

	/**
	 * Get bids for an active auction.
	 */
	getBids(agentDid: string): ResurrectionBid[] {
		return [...(this.pendingAuctions.get(agentDid) ?? [])];
	}

	/**
	 * Get all completed resurrections.
	 */
	getCompletedResurrections(): ResurrectionConfirmation[] {
		return [...this.completedResurrections];
	}

	/**
	 * Get the auction duration in blocks.
	 */
	getAuctionDuration(): number {
		return this.auctionDurationBlocks;
	}
}
