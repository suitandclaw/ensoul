import { describe, it, expect } from "vitest";
import { SecuritySuite, runSimulation } from "../src/index.js";
import type { AttackScenario, AttackType } from "../src/index.js";

function scenario(
	name: string,
	type: AttackType,
): AttackScenario {
	return { name, type, parameters: {} };
}

describe("SecuritySuite", () => {
	// ── Attack Simulations ───────────────────────────────────────

	describe("attack simulations", () => {
		it("data_withholding: corrupted shard detected by Blake3 hash", async () => {
			const result = await runSimulation(
				scenario("data withholding", "data_withholding"),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("integrity check");
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("state_corruption: tampered data rejected by Merkle proof", async () => {
			const result = await runSimulation(
				scenario("state corruption", "state_corruption"),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("Tampered");
		});

		it("replay_attack: old state transition rejected by version chain", async () => {
			const result = await runSimulation(
				scenario("replay attack", "replay_attack"),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("hash chain");
		});

		it("key_compromise: stolen key insufficient without K shards", async () => {
			const result = await runSimulation(
				scenario("key compromise", "key_compromise"),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("K=2 shards");
		});

		it("consensus_manipulation: K-1 validators cannot forge threshold", async () => {
			const result = await runSimulation(
				scenario(
					"consensus manipulation",
					"consensus_manipulation",
				),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("insufficient");
		});

		it("shard_reconstruction: cannot reconstruct from fewer than K shards", async () => {
			const result = await runSimulation(
				scenario(
					"shard reconstruction",
					"shard_reconstruction",
				),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("C(4,2)=6");
		});

		it("credit_inflation: fake storage proof rejected", async () => {
			const result = await runSimulation(
				scenario("credit inflation", "credit_inflation"),
			);
			expect(result.passed).toBe(true);
			expect(result.details).toContain("Fake storage proof rejected");
		});
	});

	// ── Full Adversarial Suite ────────────────────────────────────

	describe("full adversarial suite", () => {
		it("all 7 simulations pass", async () => {
			const suite = new SecuritySuite();
			const results = await suite.runFullAdversarialSuite();

			expect(results.length).toBe(7);
			for (const result of results) {
				expect(result.passed).toBe(true);
			}
		});
	});

	// ── Module Audits ────────────────────────────────────────────

	describe("module audits", () => {
		it("identity audit passes all checks", async () => {
			const suite = new SecuritySuite();
			const report = await suite.auditModule("identity");

			expect(report.module).toBe("identity");
			expect(report.overallPass).toBe(true);
			expect(report.checks.length).toBeGreaterThanOrEqual(3);

			for (const check of report.checks) {
				expect(check.passed).toBe(true);
			}
		});

		it("state-tree audit passes all checks", async () => {
			const suite = new SecuritySuite();
			const report = await suite.auditModule("state-tree");

			expect(report.module).toBe("state-tree");
			expect(report.overallPass).toBe(true);
			expect(report.checks.length).toBeGreaterThanOrEqual(3);
		});

		it("node audit passes all checks", async () => {
			const suite = new SecuritySuite();
			const report = await suite.auditModule("node");

			expect(report.module).toBe("node");
			expect(report.overallPass).toBe(true);
			expect(report.checks.length).toBeGreaterThanOrEqual(2);
		});

		it("unknown module reports failure", async () => {
			const suite = new SecuritySuite();
			const report = await suite.auditModule("nonexistent");

			expect(report.overallPass).toBe(false);
			expect(report.checks[0]!.details).toContain(
				"No auditor registered",
			);
		});

		it("auditAllModules runs all registered auditors", async () => {
			const suite = new SecuritySuite();
			const reports = await suite.auditAllModules();

			expect(reports.length).toBe(3); // identity, state-tree, node
			for (const report of reports) {
				expect(report.overallPass).toBe(true);
			}
		});
	});

	// ── Invariant Checks ─────────────────────────────────────────

	describe("invariant checks", () => {
		it("registers and runs custom invariants", async () => {
			const suite = new SecuritySuite();
			suite.registerInvariant(
				"always_true",
				async () => true,
			);
			suite.registerInvariant(
				"always_false",
				async () => false,
			);

			const results = await suite.runInvariantChecks();
			expect(results.length).toBe(2);
			expect(results[0]!.name).toBe("always_true");
			expect(results[0]!.passed).toBe(true);
			expect(results[1]!.name).toBe("always_false");
			expect(results[1]!.passed).toBe(false);
		});

		it("handles invariant that throws", async () => {
			const suite = new SecuritySuite();
			suite.registerInvariant("throws", async () => {
				throw new Error("invariant error");
			});

			const results = await suite.runInvariantChecks();
			expect(results.length).toBe(1);
			expect(results[0]!.passed).toBe(false);
		});

		it("empty invariant list returns empty results", async () => {
			const suite = new SecuritySuite();
			const results = await suite.runInvariantChecks();
			expect(results.length).toBe(0);
		});
	});

	// ── Individual simulation via suite ───────────────────────────

	describe("runAttackSimulation", () => {
		it("runs a single simulation via the suite", async () => {
			const suite = new SecuritySuite();
			const result = await suite.runAttackSimulation(
				scenario("data withholding", "data_withholding"),
			);
			expect(result.passed).toBe(true);
			expect(result.scenario).toBe("data withholding");
			expect(result.type).toBe("data_withholding");
		});
	});
});
