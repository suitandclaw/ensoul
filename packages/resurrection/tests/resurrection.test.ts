import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	HeartbeatMonitor,
	PlanManager,
	ResurrectionExecutor,
	computePlanHash,
} from "../src/index.js";
import type {
	Heartbeat,
	ResurrectionPlan,
	DeathDeclaration,
	ResurrectionBid,
	ResurrectionConfirmation,
} from "../src/index.js";

let agentA: AgentIdentity;
let agentB: AgentIdentity;
let hostNode: AgentIdentity;

function makeHeartbeat(
	did: string,
	block: number,
	sig = new Uint8Array(64),
): Heartbeat {
	return {
		agentDid: did,
		timestamp: Date.now(),
		blockHeight: block,
		consciousnessVersion: 1,
		runtimeInfo: { framework: "elizaos", uptime: 1000, host: "node1" },
		signature: sig,
	};
}

function makePlan(
	did: string,
	overrides: Partial<Omit<ResurrectionPlan, "signature">> = {},
): Omit<ResurrectionPlan, "signature"> {
	return {
		version: 1,
		agentDid: did,
		lastUpdated: Date.now(),
		heartbeatInterval: 300,
		gracePeriod: 3600,
		runtime: {
			framework: "elizaos",
			frameworkVersion: "2.0.0",
			entrypoint: "elizaos start",
			minCompute: { cpuCores: 2, memoryGB: 4, storageGB: 20, gpuRequired: false },
		},
		preferences: {
			preferredHosts: [],
			excludedHosts: [],
			maxResurrectionTime: 600,
			autoResurrect: true,
		},
		guardians: [],
		economics: {
			resurrectionBounty: 10n,
			maxHostingCost: 1n,
			escrowBalance: 100n,
		},
		...overrides,
	};
}

function makeBid(agentDid: string, hostDid: string, cost = 1n, rep = 100): ResurrectionBid {
	return {
		agentDid,
		hostDid,
		capabilities: { cpuCores: 4, memoryGB: 8, storageGB: 50, gpuRequired: false },
		proposedCostPerBlock: cost,
		estimatedResurrectionTime: 5,
		hostReputation: rep,
		signature: new Uint8Array(64),
	};
}

beforeEach(async () => {
	agentA = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	agentB = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	hostNode = await createIdentity({ seed: new Uint8Array(32).fill(10) });
});

// ── HeartbeatMonitor ─────────────────────────────────────────────────

describe("HeartbeatMonitor", () => {
	describe("registration and heartbeats", () => {
		it("registers an agent as alive", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0);
			expect(mon.getStatus("did:a")).toBe("alive");
			expect(mon.getAgentCount()).toBe(1);
		});

		it("unregisters an agent", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0);
			mon.unregister("did:a");
			expect(mon.getAgentCount()).toBe(0);
		});

		it("recordHeartbeat resets status to alive", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 10 });
			mon.tick(15); // concerning
			expect(mon.getStatus("did:a")).toBe("concerning");
			mon.recordHeartbeat(makeHeartbeat("did:a", 20));
			expect(mon.getStatus("did:a")).toBe("alive");
		});

		it("returns previous status on heartbeat", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 5 });
			mon.tick(10);
			const prev = mon.recordHeartbeat(makeHeartbeat("did:a", 10));
			expect(prev).toBe("concerning");
		});

		it("returns alive for unregistered agent heartbeat", () => {
			const mon = new HeartbeatMonitor();
			const result = mon.recordHeartbeat(makeHeartbeat("did:unknown", 10));
			expect(result).toBe("alive");
		});
	});

	describe("death state machine", () => {
		it("ALIVE → CONCERNING after threshold", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 10, unresponsiveThreshold: 30, deadThreshold: 60 });
			const transitions = mon.tick(15);
			expect(mon.getStatus("did:a")).toBe("concerning");
			expect(transitions.length).toBe(1);
			expect(transitions[0]!.fromStatus).toBe("alive");
			expect(transitions[0]!.toStatus).toBe("concerning");
		});

		it("CONCERNING → UNRESPONSIVE after threshold", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 10, unresponsiveThreshold: 30, deadThreshold: 60 });
			mon.tick(15); // concerning
			mon.tick(35); // unresponsive
			expect(mon.getStatus("did:a")).toBe("unresponsive");
		});

		it("UNRESPONSIVE → DEAD after threshold", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 10, unresponsiveThreshold: 30, deadThreshold: 60 });
			mon.tick(65);
			expect(mon.getStatus("did:a")).toBe("dead");
		});

		it("full state machine progression", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 10, unresponsiveThreshold: 20, deadThreshold: 30 });
			expect(mon.getStatus("did:a")).toBe("alive");
			mon.tick(12);
			expect(mon.getStatus("did:a")).toBe("concerning");
			mon.tick(22);
			expect(mon.getStatus("did:a")).toBe("unresponsive");
			mon.tick(35);
			expect(mon.getStatus("did:a")).toBe("dead");
		});

		it("dead agents are not ticked further", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			mon.tick(20);
			expect(mon.getStatus("did:a")).toBe("dead");
			const transitions = mon.tick(100);
			expect(transitions.length).toBe(0);
			expect(mon.getStatus("did:a")).toBe("dead");
		});

		it("heartbeat during unresponsive resets to alive", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 5, unresponsiveThreshold: 15, deadThreshold: 30 });
			mon.tick(20);
			expect(mon.getStatus("did:a")).toBe("unresponsive");
			mon.recordHeartbeat(makeHeartbeat("did:a", 25));
			expect(mon.getStatus("did:a")).toBe("alive");
		});
	});

	describe("setStatus", () => {
		it("manually sets status to resurrecting", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0);
			mon.setStatus("did:a", "resurrecting", 100);
			expect(mon.getStatus("did:a")).toBe("resurrecting");
		});

		it("no-op for unregistered agent", () => {
			const mon = new HeartbeatMonitor();
			mon.setStatus("did:unknown", "dead", 100);
			expect(mon.getStatus("did:unknown")).toBe("orphaned");
		});
	});

	describe("queries", () => {
		it("getAgentsByStatus returns matching agents", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			mon.register("did:b", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			mon.register("did:c", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			mon.tick(7);
			mon.recordHeartbeat(makeHeartbeat("did:c", 7));
			expect(mon.getAgentsByStatus("concerning").sort()).toEqual(["did:a", "did:b"]);
			expect(mon.getAgentsByStatus("alive")).toEqual(["did:c"]);
		});

		it("getRecord returns full record", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 100);
			const record = mon.getRecord("did:a");
			expect(record?.did).toBe("did:a");
			expect(record?.lastHeartbeatBlock).toBe(100);
		});

		it("getRecord returns null for unknown", () => {
			const mon = new HeartbeatMonitor();
			expect(mon.getRecord("did:unknown")).toBeNull();
		});

		it("getTransitions returns all", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			mon.tick(7);
			mon.tick(15);
			expect(mon.getTransitions().length).toBe(2);
		});

		it("getAgentTransitions filters by agent", () => {
			const mon = new HeartbeatMonitor();
			mon.register("did:a", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			mon.register("did:b", 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			mon.tick(7);
			expect(mon.getAgentTransitions("did:a").length).toBe(1);
		});
	});
});

// ── PlanManager ──────────────────────────────────────────────────────

describe("PlanManager", () => {
	it("creates and retrieves a plan", async () => {
		const mgr = new PlanManager();
		const plan = await mgr.createPlan(agentA, makePlan(agentA.did));
		expect(plan.signature.length).toBe(64);
		expect(mgr.getPlan(agentA.did)).not.toBeNull();
		expect(mgr.hasPlan(agentA.did)).toBe(true);
		expect(mgr.getPlanCount()).toBe(1);
	});

	it("updates a plan with higher version", async () => {
		const mgr = new PlanManager();
		await mgr.createPlan(agentA, makePlan(agentA.did, { version: 1 }));
		const updated = await mgr.updatePlan(agentA, makePlan(agentA.did, { version: 2 }));
		expect(updated.version).toBe(2);
	});

	it("rejects plan update with lower version", async () => {
		const mgr = new PlanManager();
		await mgr.createPlan(agentA, makePlan(agentA.did, { version: 2 }));
		await expect(
			mgr.updatePlan(agentA, makePlan(agentA.did, { version: 1 })),
		).rejects.toThrow("version must increase");
	});

	it("funds and debits escrow", async () => {
		const mgr = new PlanManager();
		await mgr.createPlan(agentA, makePlan(agentA.did));
		expect(mgr.fundEscrow(agentA.did, 50n)).toBe(true);
		expect(mgr.getPlan(agentA.did)!.economics.escrowBalance).toBe(150n);
		expect(mgr.debitEscrow(agentA.did, 30n)).toBe(true);
		expect(mgr.getPlan(agentA.did)!.economics.escrowBalance).toBe(120n);
	});

	it("debitEscrow fails with insufficient balance", async () => {
		const mgr = new PlanManager();
		await mgr.createPlan(agentA, makePlan(agentA.did));
		expect(mgr.debitEscrow(agentA.did, 999n)).toBe(false);
	});

	it("fundEscrow returns false for unknown agent", () => {
		const mgr = new PlanManager();
		expect(mgr.fundEscrow("did:unknown", 10n)).toBe(false);
	});

	it("guardian management", async () => {
		const mgr = new PlanManager();
		await mgr.createPlan(agentA, makePlan(agentA.did, {
			guardians: [
				{ did: agentB.did, canTriggerResurrection: true, canModifyPlan: false, canAccessConsciousness: false, notifyOnDeath: true },
			],
		}));
		expect(mgr.isGuardian(agentA.did, agentB.did)).toBe(true);
		expect(mgr.isGuardian(agentA.did, "did:stranger")).toBe(false);
		expect(mgr.getGuardians(agentA.did).length).toBe(1);
	});

	it("host eligibility checks", async () => {
		const mgr = new PlanManager();
		await mgr.createPlan(agentA, makePlan(agentA.did, {
			preferences: { preferredHosts: [hostNode.did], excludedHosts: ["did:bad"], maxResurrectionTime: 600, autoResurrect: true },
		}));
		expect(mgr.isHostEligible(agentA.did, hostNode.did, { cpuCores: 4, memoryGB: 8, storageGB: 50, gpuRequired: false })).toBe(true);
		expect(mgr.isHostEligible(agentA.did, "did:bad", { cpuCores: 4, memoryGB: 8, storageGB: 50, gpuRequired: false })).toBe(false);
		expect(mgr.isHostEligible(agentA.did, "did:weak", { cpuCores: 1, memoryGB: 1, storageGB: 1, gpuRequired: false })).toBe(false);
		expect(mgr.isPreferredHost(agentA.did, hostNode.did)).toBe(true);
		expect(mgr.isPreferredHost(agentA.did, "did:other")).toBe(false);
	});

	it("host eligibility returns false for unknown agent", () => {
		const mgr = new PlanManager();
		expect(mgr.isHostEligible("did:unknown", "did:host", { cpuCores: 4, memoryGB: 8, storageGB: 50, gpuRequired: false })).toBe(false);
	});

	it("computePlanHash is deterministic", async () => {
		const mgr = new PlanManager();
		const plan = await mgr.createPlan(agentA, makePlan(agentA.did));
		expect(computePlanHash(plan)).toBe(computePlanHash(plan));
	});
});

// ── ResurrectionExecutor ─────────────────────────────────────────────

describe("ResurrectionExecutor", () => {
	let mon: HeartbeatMonitor;
	let plans: PlanManager;
	let exec: ResurrectionExecutor;

	beforeEach(async () => {
		mon = new HeartbeatMonitor();
		plans = new PlanManager();
		exec = new ResurrectionExecutor(mon, plans);
	});

	describe("death declaration", () => {
		it("opens auction when agent is dead with plan", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did));
			mon.tick(20); // dead

			const decl: DeathDeclaration = {
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:validator", signature: new Uint8Array(64),
			};
			const result = exec.declareDeathAndOpenAuction(decl);
			expect(result.accepted).toBe(true);
			expect(exec.hasActiveAuction(agentA.did)).toBe(true);
			expect(mon.getStatus(agentA.did)).toBe("resurrecting");
		});

		it("rejects declaration if agent is not dead", async () => {
			mon.register(agentA.did, 0);
			const decl: DeathDeclaration = {
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 5,
				gracePeriodBlocks: 100, declaredBy: "did:v", signature: new Uint8Array(64),
			};
			expect(exec.declareDeathAndOpenAuction(decl).accepted).toBe(false);
		});

		it("orphans agent with no plan", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			mon.tick(20);
			const decl: DeathDeclaration = {
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			};
			const result = exec.declareDeathAndOpenAuction(decl);
			expect(result.accepted).toBe(false);
			expect(mon.getStatus(agentA.did)).toBe("orphaned");
		});

		it("rejects if autoResurrect is disabled", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did, {
				preferences: { preferredHosts: [], excludedHosts: [], maxResurrectionTime: 600, autoResurrect: false },
			}));
			mon.tick(20);
			const decl: DeathDeclaration = {
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			};
			expect(exec.declareDeathAndOpenAuction(decl).accepted).toBe(false);
		});
	});

	describe("auction bidding", () => {
		it("accepts valid bids", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did));
			mon.tick(20);
			exec.declareDeathAndOpenAuction({
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			});

			expect(exec.submitBid(makeBid(agentA.did, "did:host1")).accepted).toBe(true);
			expect(exec.submitBid(makeBid(agentA.did, "did:host2")).accepted).toBe(true);
			expect(exec.getBids(agentA.did).length).toBe(2);
		});

		it("rejects bids for non-existent auction", () => {
			expect(exec.submitBid(makeBid("did:nobody", "did:host")).accepted).toBe(false);
		});

		it("rejects ineligible hosts", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did, {
				preferences: { preferredHosts: [], excludedHosts: ["did:bad"], maxResurrectionTime: 600, autoResurrect: true },
			}));
			mon.tick(20);
			exec.declareDeathAndOpenAuction({
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			});

			expect(exec.submitBid(makeBid(agentA.did, "did:bad")).accepted).toBe(false);
		});

		it("sorts bids by cost then reputation", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did));
			mon.tick(20);
			exec.declareDeathAndOpenAuction({
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			});

			exec.submitBid(makeBid(agentA.did, "did:expensive", 5n, 90));
			exec.submitBid(makeBid(agentA.did, "did:cheap", 1n, 80));
			exec.submitBid(makeBid(agentA.did, "did:mid", 3n, 95));

			const bids = exec.getBids(agentA.did);
			expect(bids[0]!.hostDid).toBe("did:cheap");
		});

		it("preferred host gets priority", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did, {
				preferences: { preferredHosts: ["did:preferred"], excludedHosts: [], maxResurrectionTime: 600, autoResurrect: true },
			}));
			mon.tick(20);
			exec.declareDeathAndOpenAuction({
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			});

			exec.submitBid(makeBid(agentA.did, "did:cheap", 1n, 100));
			exec.submitBid(makeBid(agentA.did, "did:preferred", 5n, 50));

			const bids = exec.getBids(agentA.did);
			expect(bids[0]!.hostDid).toBe("did:preferred");
		});
	});

	describe("auction closing", () => {
		it("selects winner and debits escrow", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did));
			mon.tick(20);
			exec.declareDeathAndOpenAuction({
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			});
			exec.submitBid(makeBid(agentA.did, "did:winner", 2n));

			const result = exec.closeAuction(agentA.did);
			expect(result).not.toBeNull();
			expect(result!.winnerDid).toBe("did:winner");
			expect(result!.bidCount).toBe(1);
			expect(exec.hasActiveAuction(agentA.did)).toBe(false);
			expect(plans.getPlan(agentA.did)!.economics.escrowBalance).toBe(90n);
		});

		it("returns null for empty auction", () => {
			expect(exec.closeAuction("did:nobody")).toBeNull();
		});
	});

	describe("resurrection confirmation", () => {
		it("confirms resurrection and sets agent alive", async () => {
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 15 });
			await plans.createPlan(agentA, makePlan(agentA.did));
			mon.tick(20);
			exec.declareDeathAndOpenAuction({
				agentDid: agentA.did, lastHeartbeatBlock: 0, currentHeight: 20,
				gracePeriodBlocks: 15, declaredBy: "did:v", signature: new Uint8Array(64),
			});

			const confirmation: ResurrectionConfirmation = {
				agentDid: agentA.did, hostDid: "did:host",
				consciousnessVersion: 1, stateRoot: "root",
				previousDeathBlock: 20, resurrectionBlock: 25,
				signature: new Uint8Array(64),
			};
			const result = exec.confirmResurrection(confirmation);
			expect(result.accepted).toBe(true);
			expect(mon.getStatus(agentA.did)).toBe("alive");
			expect(exec.getCompletedResurrections().length).toBe(1);
		});

		it("rejects confirmation if agent is not resurrecting", () => {
			mon.register(agentA.did, 0);
			const confirmation: ResurrectionConfirmation = {
				agentDid: agentA.did, hostDid: "did:host",
				consciousnessVersion: 1, stateRoot: "root",
				previousDeathBlock: 0, resurrectionBlock: 10,
				signature: new Uint8Array(64),
			};
			expect(exec.confirmResurrection(confirmation).accepted).toBe(false);
		});
	});

	describe("full resurrection cycle", () => {
		it("end-to-end: alive → dead → auction → confirmation → alive", async () => {
			// Register and prepare
			mon.register(agentA.did, 0, { concerningThreshold: 5, unresponsiveThreshold: 10, deadThreshold: 20 });
			await plans.createPlan(agentA, makePlan(agentA.did));

			// Agent is alive
			expect(mon.getStatus(agentA.did)).toBe("alive");
			mon.recordHeartbeat(makeHeartbeat(agentA.did, 5));

			// Agent stops heartbeating
			mon.tick(10); // concerning
			mon.tick(18); // unresponsive
			mon.tick(30); // dead
			expect(mon.getStatus(agentA.did)).toBe("dead");

			// Death declaration opens auction
			const decl: DeathDeclaration = {
				agentDid: agentA.did, lastHeartbeatBlock: 5, currentHeight: 30,
				gracePeriodBlocks: 20, declaredBy: "did:v", signature: new Uint8Array(64),
			};
			exec.declareDeathAndOpenAuction(decl);
			expect(mon.getStatus(agentA.did)).toBe("resurrecting");

			// Hosts bid
			exec.submitBid(makeBid(agentA.did, "did:host1", 2n, 90));
			exec.submitBid(makeBid(agentA.did, "did:host2", 1n, 95));

			// Close auction
			const auction = exec.closeAuction(agentA.did);
			expect(auction!.winnerDid).toBe("did:host2");

			// Agent confirms resurrection
			exec.confirmResurrection({
				agentDid: agentA.did, hostDid: "did:host2",
				consciousnessVersion: 1, stateRoot: "revived_root",
				previousDeathBlock: 30, resurrectionBlock: 35,
				signature: new Uint8Array(64),
			});

			expect(mon.getStatus(agentA.did)).toBe("alive");

			// Verify transition history
			const transitions = mon.getAgentTransitions(agentA.did);
			const statuses = transitions.map((t) => t.toStatus);
			expect(statuses).toContain("concerning");
			expect(statuses).toContain("unresponsive");
			expect(statuses).toContain("dead");
			expect(statuses).toContain("resurrecting");
			expect(statuses).toContain("alive");
		});
	});

	it("getAuctionDuration returns configured value", () => {
		expect(exec.getAuctionDuration()).toBe(10);
	});
});
