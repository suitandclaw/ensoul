import { describe, it, expect, beforeEach } from "vitest";
import { ReplicationEnforcer } from "../src/replication/index.js";

let enforcer: ReplicationEnforcer;

beforeEach(() => {
	enforcer = new ReplicationEnforcer({ preservationThreshold: 10 });
});

describe("ReplicationEnforcer", () => {
	describe("registration", () => {
		it("registers and tracks consciousnesses", () => {
			enforcer.register("did:agent:1", 9, 5);
			expect(enforcer.getRegistrationCount()).toBe(1);
		});

		it("unregisters a consciousness", () => {
			enforcer.register("did:agent:1", 9, 5);
			enforcer.unregister("did:agent:1");
			expect(enforcer.getRegistrationCount()).toBe(0);
		});

		it("adds and removes holders", () => {
			enforcer.register("did:agent:1", 4, 2);
			enforcer.addHolder("did:agent:1", "did:node:a");
			enforcer.addHolder("did:agent:1", "did:node:b");

			const health = enforcer.computeHealth("did:agent:1");
			expect(health?.currentReplicas).toBe(2);

			enforcer.removeHolder("did:agent:1", "did:node:a");
			const h2 = enforcer.computeHealth("did:agent:1");
			expect(h2?.currentReplicas).toBe(1);
		});
	});

	describe("health status classification", () => {
		it("healthy: replicas >= required", () => {
			enforcer.register("did:a", 4, 2);
			for (let i = 0; i < 4; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}
			const h = enforcer.computeHealth("did:a");
			expect(h?.healthStatus).toBe("healthy");
		});

		it("healthy: replicas > required", () => {
			enforcer.register("did:a", 4, 2);
			for (let i = 0; i < 6; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}
			expect(enforcer.computeHealth("did:a")?.healthStatus).toBe("healthy");
		});

		it("degraded: replicas = required - 1", () => {
			enforcer.register("did:a", 4, 2);
			for (let i = 0; i < 3; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}
			expect(enforcer.computeHealth("did:a")?.healthStatus).toBe("degraded");
		});

		it("critical: replicas >= K but < required - 1", () => {
			enforcer.register("did:a", 9, 5);
			for (let i = 0; i < 5; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}
			// 5 current, 9 required, K=5. degraded is 8, 7 or 6 are critical, <5 emergency
			// required-1 = 8. current=5 < 8 but >= K=5 => critical
			expect(enforcer.computeHealth("did:a")?.healthStatus).toBe("critical");
		});

		it("emergency: replicas < K (cannot reconstruct)", () => {
			enforcer.register("did:a", 9, 5);
			for (let i = 0; i < 4; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}
			// 4 current < K=5
			expect(enforcer.computeHealth("did:a")?.healthStatus).toBe("emergency");
		});

		it("emergency: zero replicas", () => {
			enforcer.register("did:a", 4, 2);
			expect(enforcer.computeHealth("did:a")?.healthStatus).toBe("emergency");
		});

		it("returns null for unknown consciousness", () => {
			expect(enforcer.computeHealth("did:unknown")).toBeNull();
		});
	});

	describe("health check actions", () => {
		it("no actions when all healthy", () => {
			enforcer.register("did:a", 4, 2);
			for (let i = 0; i < 4; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}

			const { summary, actions } = enforcer.runHealthCheck();
			expect(summary.healthy).toBe(1);
			expect(summary.degraded).toBe(0);
			expect(actions.length).toBe(0);
		});

		it("auto_repair action for degraded", () => {
			enforcer.register("did:a", 4, 2);
			for (let i = 0; i < 3; i++) {
				enforcer.addHolder("did:a", `did:node:${i}`);
			}

			const { actions } = enforcer.runHealthCheck();
			const repair = actions.find((a) => a.type === "auto_repair");
			expect(repair).toBeDefined();
			expect(repair?.urgency).toBe("normal");
			expect(repair?.shardsNeeded).toBe(1);
		});

		it("urgent_repair action for critical", () => {
			enforcer.register("did:a", 4, 2);
			enforcer.addHolder("did:a", "did:node:0");
			enforcer.addHolder("did:a", "did:node:1");
			// 2 current, 4 required, K=2. required-1=3, current=2 < 3 but >= K=2 => critical

			const { actions } = enforcer.runHealthCheck();
			const urgent = actions.find(
				(a) => a.type === "urgent_repair",
			);
			expect(urgent).toBeDefined();
			expect(urgent?.urgency).toBe("high");
		});

		it("emergency_replication for emergency status", () => {
			enforcer.register("did:a", 4, 2);
			enforcer.addHolder("did:a", "did:node:0");
			// 1 current < K=2 => emergency

			const { actions } = enforcer.runHealthCheck();
			const emergency = actions.find(
				(a) => a.type === "emergency_replication",
			);
			expect(emergency).toBeDefined();
			expect(emergency?.urgency).toBe("emergency");
		});
	});

	describe("preservation mode", () => {
		it("activates when >10% in emergency", () => {
			// Register 10 consciousnesses, put 2 in emergency (20%)
			for (let i = 0; i < 10; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			// Give 8 healthy replicas
			for (let i = 0; i < 8; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}
			// Leave 2 with 0 replicas (emergency)

			expect(enforcer.isPreservationMode()).toBe(false);
			const { summary } = enforcer.runHealthCheck();
			expect(summary.emergency).toBe(2);
			expect(enforcer.isPreservationMode()).toBe(true);
		});

		it("does not activate at exactly threshold", () => {
			// 10 total, 1 in emergency = 10% (not >10%)
			for (let i = 0; i < 10; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			for (let i = 0; i < 9; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}

			enforcer.runHealthCheck();
			expect(enforcer.isPreservationMode()).toBe(false);
		});

		it("deactivates when all emergencies resolved", () => {
			for (let i = 0; i < 5; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			// 1 in emergency (20% > 10%)
			for (let i = 0; i < 4; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}

			enforcer.runHealthCheck();
			expect(enforcer.isPreservationMode()).toBe(true);

			// Fix the emergency
			for (let n = 0; n < 4; n++) {
				enforcer.addHolder("did:a:4", `did:node:${n}`);
			}

			enforcer.runHealthCheck();
			expect(enforcer.isPreservationMode()).toBe(false);
		});

		it("emits preservation_mode_activated action", () => {
			for (let i = 0; i < 5; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			for (let i = 0; i < 4; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}

			const { actions } = enforcer.runHealthCheck();
			const activate = actions.find(
				(a) => a.type === "preservation_mode_activated",
			);
			expect(activate).toBeDefined();
		});

		it("emits preservation_mode_deactivated action", () => {
			for (let i = 0; i < 5; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			for (let i = 0; i < 4; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}

			enforcer.runHealthCheck(); // activates
			expect(enforcer.isPreservationMode()).toBe(true);

			// Fix all
			for (let n = 0; n < 4; n++) {
				enforcer.addHolder("did:a:4", `did:node:${n}`);
			}

			const { actions } = enforcer.runHealthCheck();
			const deactivate = actions.find(
				(a) => a.type === "preservation_mode_deactivated",
			);
			expect(deactivate).toBeDefined();
		});

		it("shouldPauseNewStorage is true in preservation mode", () => {
			expect(enforcer.shouldPauseNewStorage()).toBe(false);
			// Force preservation mode
			for (let i = 0; i < 5; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			for (let i = 0; i < 4; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}
			enforcer.runHealthCheck();
			expect(enforcer.shouldPauseNewStorage()).toBe(true);
		});

		it("getRewardMultiplier returns 2x in preservation mode", () => {
			expect(enforcer.getRewardMultiplier()).toBe(1);
			// Trigger preservation
			for (let i = 0; i < 5; i++) {
				enforcer.register(`did:a:${i}`, 4, 2);
			}
			for (let i = 0; i < 4; i++) {
				for (let n = 0; n < 4; n++) {
					enforcer.addHolder(`did:a:${i}`, `did:node:${n}`);
				}
			}
			enforcer.runHealthCheck();
			expect(enforcer.getRewardMultiplier()).toBe(2);
		});
	});

	describe("mixed scenarios", () => {
		it("tracks multiple consciousnesses with different statuses", () => {
			enforcer.register("did:healthy", 4, 2);
			for (let n = 0; n < 4; n++) {
				enforcer.addHolder("did:healthy", `did:node:${n}`);
			}

			enforcer.register("did:degraded", 4, 2);
			for (let n = 0; n < 3; n++) {
				enforcer.addHolder("did:degraded", `did:node:${n}`);
			}

			enforcer.register("did:critical", 4, 2);
			enforcer.addHolder("did:critical", "did:node:0");
			enforcer.addHolder("did:critical", "did:node:1");

			enforcer.register("did:emergency", 4, 2);
			enforcer.addHolder("did:emergency", "did:node:0");

			const { summary } = enforcer.runHealthCheck();
			expect(summary.total).toBe(4);
			expect(summary.healthy).toBe(1);
			expect(summary.degraded).toBe(1);
			expect(summary.critical).toBe(1);
			expect(summary.emergency).toBe(1);
		});

		it("getSummary returns same as runHealthCheck", () => {
			enforcer.register("did:a", 4, 2);
			for (let n = 0; n < 4; n++) {
				enforcer.addHolder("did:a", `did:node:${n}`);
			}
			const summary = enforcer.getSummary();
			expect(summary.total).toBe(1);
			expect(summary.healthy).toBe(1);
		});

		it("holder dedup (same node added twice)", () => {
			enforcer.register("did:a", 4, 2);
			enforcer.addHolder("did:a", "did:node:0");
			enforcer.addHolder("did:a", "did:node:0"); // duplicate
			expect(enforcer.computeHealth("did:a")?.currentReplicas).toBe(1);
		});

		it("no-op for non-existent consciousness in addHolder/removeHolder", () => {
			enforcer.addHolder("did:nonexistent", "did:node:0");
			enforcer.removeHolder("did:nonexistent", "did:node:0");
			// Should not throw
		});
	});
});
