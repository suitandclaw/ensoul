import { describe, it, expect } from "vitest";
import {
	computeTrustLevel,
	assessTrust,
	hashTrustAssessment,
	trustLevelToNumber,
	numberToTrustLevel,
} from "../src/trust/index.js";
import type { TrustInput } from "../src/trust/index.js";

function makeInput(overrides: Partial<TrustInput> = {}): TrustInput {
	return {
		hasEnsoulStorage: false,
		proofOfStoragePassing: false,
		selfAuditPassing: false,
		checkpointActive: false,
		deepArchiveActive: false,
		resurrectionPlanActive: false,
		redundantRuntime: false,
		guardianNetwork: false,
		selfFundedEscrow: false,
		...overrides,
	};
}

describe("Trust Level Calculator", () => {
	describe("computeTrustLevel", () => {
		it("Level 1 - Basic: Ensoul storage with erasure coding", () => {
			expect(
				computeTrustLevel(makeInput({ hasEnsoulStorage: true })),
			).toBe("basic");
		});

		it("Level 1 - Basic: no storage at all", () => {
			expect(computeTrustLevel(makeInput())).toBe("basic");
		});

		it("Level 2 - Verified: storage + PoS + self-audit", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
					}),
				),
			).toBe("verified");
		});

		it("Level 3 - Anchored: verified + internal checkpointing", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						checkpointActive: true,
					}),
				),
			).toBe("anchored");
		});

		it("Level 4 - Immortal: anchored + deep archive + resurrection", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						checkpointActive: true,
						deepArchiveActive: true,
						resurrectionPlanActive: true,
					}),
				),
			).toBe("immortal");
		});

		it("Level 5 - Sovereign: all Ensoul-native layers active", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						checkpointActive: true,
						deepArchiveActive: true,
						resurrectionPlanActive: true,
						redundantRuntime: true,
						guardianNetwork: true,
						selfFundedEscrow: true,
					}),
				),
			).toBe("sovereign");
		});

		it("missing self-audit caps at basic even with PoS", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: false,
					}),
				),
			).toBe("basic");
		});

		it("missing deep archive caps at anchored", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						checkpointActive: true,
						deepArchiveActive: false,
					}),
				),
			).toBe("anchored");
		});
	});

	describe("assessTrust", () => {
		it("returns full assessment with Ensoul-native layers", () => {
			const assessment = assessTrust(
				"did:agent:test",
				makeInput({
					hasEnsoulStorage: true,
					proofOfStoragePassing: true,
					selfAuditPassing: true,
				}),
			);

			expect(assessment.did).toBe("did:agent:test");
			expect(assessment.level).toBe("verified");
			expect(assessment.numericLevel).toBe(2);
			expect(assessment.label).toBe("Verified");
			expect(assessment.description).toContain("verified");
			expect(assessment.layers.length).toBe(7);
			expect(assessment.timestamp).toBeGreaterThan(0);

			// Verify layer names are Ensoul-native
			const l4 = assessment.layers.find((l) => l.layer === 4);
			expect(l4?.name).toBe("Internal Checkpointing");
			const l7 = assessment.layers.find((l) => l.layer === 7);
			expect(l7?.name).toBe("Deep Archive");
		});

		it("layer statuses reflect input", () => {
			const assessment = assessTrust(
				"did:agent:test",
				makeInput({
					hasEnsoulStorage: true,
					checkpointActive: true,
				}),
			);

			const l4 = assessment.layers.find((l) => l.layer === 4);
			expect(l4?.active).toBe(true);
			expect(l4?.details).toContain("Validator-signed");

			const l7 = assessment.layers.find((l) => l.layer === 7);
			expect(l7?.active).toBe(false);
		});
	});

	describe("hashTrustAssessment", () => {
		it("produces deterministic hash", () => {
			const assessment = assessTrust(
				"did:agent:test",
				makeInput({ hasEnsoulStorage: true }),
			);
			const h1 = hashTrustAssessment(assessment);
			const h2 = hashTrustAssessment(assessment);
			expect(h1).toBe(h2);
			expect(h1.length).toBe(64);
		});

		it("different assessments produce different hashes", () => {
			const a1 = assessTrust(
				"did:agent:a",
				makeInput({ hasEnsoulStorage: true }),
			);
			const a2 = assessTrust(
				"did:agent:b",
				makeInput({ hasEnsoulStorage: true }),
			);
			expect(hashTrustAssessment(a1)).not.toBe(hashTrustAssessment(a2));
		});
	});

	describe("level conversion", () => {
		it("trustLevelToNumber maps correctly", () => {
			expect(trustLevelToNumber("basic")).toBe(1);
			expect(trustLevelToNumber("verified")).toBe(2);
			expect(trustLevelToNumber("anchored")).toBe(3);
			expect(trustLevelToNumber("immortal")).toBe(4);
			expect(trustLevelToNumber("sovereign")).toBe(5);
		});

		it("numberToTrustLevel maps correctly", () => {
			expect(numberToTrustLevel(1)).toBe("basic");
			expect(numberToTrustLevel(2)).toBe("verified");
			expect(numberToTrustLevel(3)).toBe("anchored");
			expect(numberToTrustLevel(4)).toBe("immortal");
			expect(numberToTrustLevel(5)).toBe("sovereign");
		});
	});
});
