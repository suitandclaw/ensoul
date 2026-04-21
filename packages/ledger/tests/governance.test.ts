import { describe, it, expect } from "vitest";
import { GovernanceState } from "../src/governance.js";
import type { GovernancePayload } from "../src/governance.js";

const SIGNER_A = "did:key:z6MkSignerA";
const SIGNER_B = "did:key:z6MkSignerB";
const SIGNER_C = "did:key:z6MkSignerC";
const SIGNER_D = "did:key:z6MkSignerD";
const SIGNER_E = "did:key:z6MkSignerE";
const NON_SIGNER = "did:key:z6MkOutsider";
const NOW = 1700000000000;

function setup(threshold = 3): GovernanceState {
	const gs = new GovernanceState();
	gs.setSigners([SIGNER_A, SIGNER_B, SIGNER_C, SIGNER_D, SIGNER_E], threshold);
	gs.setOperatorKey(SIGNER_A);
	return gs;
}

const PAYLOAD: GovernancePayload = { type: "set_signers", newSigners: [SIGNER_A, SIGNER_B, SIGNER_C], newThreshold: 2 };

describe("GovernanceState", () => {
	describe("signer management", () => {
		it("stores and retrieves signers", () => {
			const gs = setup();
			expect(gs.getSigners().length).toBe(5);
			expect(gs.getThreshold()).toBe(3);
			expect(gs.isSigner(SIGNER_A)).toBe(true);
			expect(gs.isSigner(NON_SIGNER)).toBe(false);
		});

		it("rejects threshold > signer count", () => {
			const gs = new GovernanceState();
			expect(() => gs.setSigners([SIGNER_A], 2)).toThrow("threshold cannot exceed");
		});

		it("rejects threshold < 1", () => {
			const gs = new GovernanceState();
			expect(() => gs.setSigners([SIGNER_A], 0)).toThrow("threshold must be >= 1");
		});

		it("rejects empty signer set", () => {
			const gs = new GovernanceState();
			expect(() => gs.setSigners([], 1)).toThrow("signer set cannot be empty");
		});

		it("isActive returns false when no signers registered", () => {
			const gs = new GovernanceState();
			expect(gs.isActive()).toBe(false);
		});

		it("isActive returns true after signers registered", () => {
			expect(setup().isActive()).toBe(true);
		});
	});

	describe("proposal creation", () => {
		it("creates a proposal from a valid signer", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "nonce1", NOW);
			expect(p.status).toBe("pending");
			expect(p.proposer).toBe(SIGNER_A);
			expect(p.signatures.size).toBe(0);
		});

		it("rejects proposal from non-signer", () => {
			const gs = setup();
			expect(() => gs.createProposal(NON_SIGNER, PAYLOAD, "n1", NOW)).toThrow("not a registered signer");
		});

		it("rejects duplicate nonce from same proposer", () => {
			const gs = setup();
			gs.createProposal(SIGNER_A, PAYLOAD, "nonce1", NOW);
			expect(() => gs.createProposal(SIGNER_A, PAYLOAD, "nonce1", NOW)).toThrow("nonce already used");
		});

		it("allows same nonce from different proposers", () => {
			const gs = setup();
			gs.createProposal(SIGNER_A, PAYLOAD, "shared-nonce", NOW);
			expect(() => gs.createProposal(SIGNER_B, PAYLOAD, "shared-nonce", NOW)).not.toThrow();
		});

		it("rejects expired expiresAt", () => {
			const gs = setup();
			expect(() => gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW, NOW - 1)).toThrow("must be in the future");
		});

		it("rejects expiresAt beyond 90 days", () => {
			const gs = setup();
			const tooFar = NOW + 91 * 24 * 60 * 60 * 1000;
			expect(() => gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW, tooFar)).toThrow("exceeds maximum");
		});

		it("uses 7-day default expiry", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			expect(p.expiresAt).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
		});
	});

	describe("signatures", () => {
		it("adds a signature from a valid signer", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_B, "sig_b_hex", NOW);
			expect(p.signatures.size).toBe(1);
			expect(p.signatures.get(SIGNER_B)).toBe("sig_b_hex");
		});

		it("rejects duplicate signature from same signer", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_B, "sig1", NOW);
			expect(() => gs.addSignature(p.id, SIGNER_B, "sig2", NOW)).toThrow("already signed");
		});

		it("rejects signature from non-signer", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			expect(() => gs.addSignature(p.id, NON_SIGNER, "sig", NOW)).toThrow("not in the governance set");
		});

		it("rejects signature on non-existent proposal", () => {
			const gs = setup();
			expect(() => gs.addSignature("fake-id", SIGNER_A, "sig", NOW)).toThrow("not found");
		});

		it("rejects signature on expired proposal", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW, NOW + 1000);
			expect(() => gs.addSignature(p.id, SIGNER_B, "sig", NOW + 2000)).toThrow("expired");
		});

		it("rejects signature on cancelled proposal", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.markCancelled(p.id, SIGNER_A);
			expect(() => gs.addSignature(p.id, SIGNER_B, "sig", NOW)).toThrow("not pending");
		});
	});

	describe("execution", () => {
		it("canExecute returns true at threshold", () => {
			const gs = setup(3);
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_A, "sig_a", NOW);
			gs.addSignature(p.id, SIGNER_B, "sig_b", NOW);
			gs.addSignature(p.id, SIGNER_C, "sig_c", NOW);
			expect(gs.canExecute(p.id, NOW).ok).toBe(true);
		});

		it("canExecute returns false below threshold", () => {
			const gs = setup(3);
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_A, "sig_a", NOW);
			gs.addSignature(p.id, SIGNER_B, "sig_b", NOW);
			const result = gs.canExecute(p.id, NOW);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("2/3");
		});

		it("markExecuted updates status", () => {
			const gs = setup(3);
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_A, "a", NOW);
			gs.addSignature(p.id, SIGNER_B, "b", NOW);
			gs.addSignature(p.id, SIGNER_C, "c", NOW);
			gs.markExecuted(p.id, SIGNER_A, NOW + 100);
			expect(p.status).toBe("executed");
			expect(p.executedBy).toBe(SIGNER_A);
		});

		it("rejects re-execution", () => {
			const gs = setup(3);
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_A, "a", NOW);
			gs.addSignature(p.id, SIGNER_B, "b", NOW);
			gs.addSignature(p.id, SIGNER_C, "c", NOW);
			gs.markExecuted(p.id, SIGNER_A, NOW);
			expect(() => gs.markExecuted(p.id, SIGNER_A, NOW)).toThrow("not pending");
		});

		it("canExecute returns false on expired proposal", () => {
			const gs = setup(3);
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW, NOW + 1000);
			gs.addSignature(p.id, SIGNER_A, "a", NOW);
			gs.addSignature(p.id, SIGNER_B, "b", NOW);
			gs.addSignature(p.id, SIGNER_C, "c", NOW);
			expect(gs.canExecute(p.id, NOW + 2000).ok).toBe(false);
		});
	});

	describe("cancellation", () => {
		it("proposer can cancel", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.markCancelled(p.id, SIGNER_A);
			expect(p.status).toBe("cancelled");
		});

		it("non-proposer cannot cancel", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			expect(() => gs.markCancelled(p.id, SIGNER_B)).toThrow("only the proposer");
		});
	});

	describe("expiry", () => {
		it("expireStale marks old proposals as expired", () => {
			const gs = setup();
			gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW, NOW + 1000);
			gs.createProposal(SIGNER_B, PAYLOAD, "n2", NOW, NOW + 5000);
			const count = gs.expireStale(NOW + 2000);
			expect(count).toBe(1);
		});
	});

	describe("listing", () => {
		it("lists all proposals", () => {
			const gs = setup();
			gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.createProposal(SIGNER_B, PAYLOAD, "n2", NOW);
			expect(gs.listProposals().length).toBe(2);
		});

		it("filters by status", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.createProposal(SIGNER_B, PAYLOAD, "n2", NOW);
			gs.markCancelled(p.id, SIGNER_A);
			expect(gs.listProposals("pending").length).toBe(1);
			expect(gs.listProposals("cancelled").length).toBe(1);
		});
	});

	describe("serialization", () => {
		it("round-trips through serialize/deserialize", () => {
			const gs = setup();
			const p = gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			gs.addSignature(p.id, SIGNER_B, "sig_b", NOW);

			const serialized = gs.serialize();
			const restored = GovernanceState.deserialize(serialized);

			expect(restored.getSigners()).toEqual(gs.getSigners());
			expect(restored.getThreshold()).toBe(3);
			expect(restored.getOperatorKey()).toBe(SIGNER_A);
			const rp = restored.getProposal(p.id);
			expect(rp).toBeDefined();
			expect(rp!.signatures.size).toBe(1);
			expect(rp!.signatures.get(SIGNER_B)).toBe("sig_b");
		});

		it("preserves nonce uniqueness after deserialize", () => {
			const gs = setup();
			gs.createProposal(SIGNER_A, PAYLOAD, "n1", NOW);
			const restored = GovernanceState.deserialize(gs.serialize());
			expect(() => restored.createProposal(SIGNER_A, PAYLOAD, "n1", NOW)).toThrow("nonce already used");
		});
	});

	describe("set_signers via execute", () => {
		it("setSigners updates signer set and threshold", () => {
			const gs = setup(3);
			gs.setSigners([SIGNER_A, SIGNER_B, SIGNER_C], 2);
			expect(gs.getSigners().length).toBe(3);
			expect(gs.getThreshold()).toBe(2);
			expect(gs.isSigner(SIGNER_D)).toBe(false);
		});
	});

	describe("operator key", () => {
		it("setOperatorKey updates the key", () => {
			const gs = setup();
			gs.setOperatorKey(SIGNER_B);
			expect(gs.getOperatorKey()).toBe(SIGNER_B);
		});
	});

	describe("determinism", () => {
		it("getSigners returns sorted array", () => {
			const gs = new GovernanceState();
			gs.setSigners([SIGNER_E, SIGNER_A, SIGNER_C, SIGNER_B, SIGNER_D], 3);
			const sorted = [...gs.getSigners()].sort();
			expect(gs.getSigners()).toEqual(sorted);
		});
	});
});
