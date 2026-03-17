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
		anchorActive: false,
		archiveActive: false,
		resurrectionPlanActive: false,
		redundantRuntime: false,
		guardianNetwork: false,
		selfFundedEscrow: false,
		...overrides,
	};
}

describe("Trust Level Calculator", () => {
	describe("computeTrustLevel", () => {
		it("Level 1 - Basic: only Ensoul storage", () => {
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

		it("Level 3 - Anchored: verified + anchor", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						anchorActive: true,
					}),
				),
			).toBe("anchored");
		});

		it("Level 4 - Immortal: anchored + archive + resurrection", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						anchorActive: true,
						archiveActive: true,
						resurrectionPlanActive: true,
					}),
				),
			).toBe("immortal");
		});

		it("Level 5 - Sovereign: all layers active", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						anchorActive: true,
						archiveActive: true,
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

		it("missing archive caps at anchored", () => {
			expect(
				computeTrustLevel(
					makeInput({
						hasEnsoulStorage: true,
						proofOfStoragePassing: true,
						selfAuditPassing: true,
						anchorActive: true,
						archiveActive: false,
					}),
				),
			).toBe("anchored");
		});
	});

	describe("assessTrust", () => {
		it("returns full assessment", () => {
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
		});

		it("layer statuses reflect input", () => {
			const assessment = assessTrust(
				"did:agent:test",
				makeInput({
					hasEnsoulStorage: true,
					anchorActive: true,
				}),
			);

			const l1 = assessment.layers.find((l) => l.layer === 1);
			expect(l1?.active).toBe(true);

			const l4 = assessment.layers.find((l) => l.layer === 4);
			expect(l4?.active).toBe(true);

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
			expect(hashTrustAssessment(a1)).not.toBe(
				hashTrustAssessment(a2),
			);
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
