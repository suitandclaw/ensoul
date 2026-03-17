import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	AnchorService,
	computeCheckpointHash,
	encodeCheckpointPayload,
} from "../src/index.js";
import type { StateCheckpoint } from "../src/index.js";

let v1: AgentIdentity;
let v2: AgentIdentity;
let v3: AgentIdentity;

beforeEach(async () => {
	v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
});

describe("AnchorService", () => {
	describe("checkpoint creation", () => {
		it("creates a checkpoint with validator signatures", async () => {
			const svc = new AnchorService({ minSignatures: 2 });
			const cp = await svc.createCheckpoint(
				1000,
				"state_root_hash",
				"consciousness_root",
				"validator_set_hash",
				42,
				1_000_000n,
				[v1, v2, v3],
			);

			expect(cp.ensoulBlockHeight).toBe(1000);
			expect(cp.stateRoot).toBe("state_root_hash");
			expect(cp.totalConsciousnesses).toBe(42);
			expect(cp.signatures.length).toBe(3);
			for (const sig of cp.signatures) {
				expect(sig.signature.length).toBe(64);
			}
		});

		it("checkpoint hash is deterministic", async () => {
			const svc = new AnchorService();
			const cp = await svc.createCheckpoint(
				500, "root", "croot", "vhash", 10, 100n, [v1],
			);
			expect(computeCheckpointHash(cp)).toBe(
				computeCheckpointHash(cp),
			);
		});

		it("different state roots produce different hashes", async () => {
			const svc = new AnchorService();
			const cp1 = await svc.createCheckpoint(
				500, "root_a", "croot", "vhash", 10, 100n, [v1],
			);
			const cp2 = await svc.createCheckpoint(
				500, "root_b", "croot", "vhash", 10, 100n, [v1],
			);
			expect(computeCheckpointHash(cp1)).not.toBe(
				computeCheckpointHash(cp2),
			);
		});
	});

	describe("signature verification", () => {
		it("verifies valid signatures", async () => {
			const svc = new AnchorService({ minSignatures: 2 });
			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1, v2],
			);

			const result = await svc.verifyCheckpointSignatures(cp, [
				{ did: v1.did, verify: v1.verify.bind(v1) },
				{ did: v2.did, verify: v2.verify.bind(v2) },
			]);

			expect(result.valid).toBe(true);
			expect(result.validCount).toBe(2);
		});

		it("fails with insufficient valid signatures", async () => {
			const svc = new AnchorService({ minSignatures: 3 });
			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1, v2],
			);

			const result = await svc.verifyCheckpointSignatures(cp, [
				{ did: v1.did, verify: v1.verify.bind(v1) },
				{ did: v2.did, verify: v2.verify.bind(v2) },
			]);

			expect(result.valid).toBe(false);
			expect(result.validCount).toBe(2);
		});

		it("ignores signatures from unknown validators", async () => {
			const svc = new AnchorService({ minSignatures: 1 });
			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1],
			);

			// Only v2 as verifier — v1's sig won't be found
			const result = await svc.verifyCheckpointSignatures(cp, [
				{ did: v2.did, verify: v2.verify.bind(v2) },
			]);

			expect(result.validCount).toBe(0);
			expect(result.valid).toBe(false);
		});
	});

	describe("anchor scheduling", () => {
		it("shouldCheckpoint at interval", () => {
			const svc = new AnchorService({ ethereumInterval: 1000 });
			expect(svc.shouldCheckpoint(0)).toBe(false);
			expect(svc.shouldCheckpoint(500)).toBe(false);
			expect(svc.shouldCheckpoint(1000)).toBe(true);
			expect(svc.shouldCheckpoint(2000)).toBe(true);
		});

		it("shouldAnchorBitcoin at 10x interval", () => {
			const svc = new AnchorService({ bitcoinInterval: 10000 });
			expect(svc.shouldAnchorBitcoin(1000)).toBe(false);
			expect(svc.shouldAnchorBitcoin(10000)).toBe(true);
		});
	});

	describe("Ethereum anchoring", () => {
		it("submits to Ethereum via pluggable submitter", async () => {
			const svc = new AnchorService();
			svc.ethereumSubmitter = async (hash) => `0xeth_${hash.slice(0, 8)}`;

			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1],
			);

			const receipt = await svc.anchorToEthereum(cp);
			expect(receipt).not.toBeNull();
			expect(receipt!.chain).toBe("ethereum");
			expect(receipt!.txHash).toContain("0xeth_");
			expect(receipt!.blockHeight).toBe(1000);
		});

		it("returns null without submitter", async () => {
			const svc = new AnchorService();
			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1],
			);

			const receipt = await svc.anchorToEthereum(cp);
			expect(receipt).toBeNull();
		});
	});

	describe("Bitcoin anchoring", () => {
		it("submits to Bitcoin via pluggable submitter", async () => {
			const svc = new AnchorService();
			svc.bitcoinSubmitter = async (hash) => `btc_${hash.slice(0, 8)}`;

			const cp = await svc.createCheckpoint(
				10000, "root", "croot", "vhash", 5, 100n, [v1],
			);

			const receipt = await svc.anchorToBitcoin(cp);
			expect(receipt).not.toBeNull();
			expect(receipt!.chain).toBe("bitcoin");
		});

		it("returns null without submitter", async () => {
			const svc = new AnchorService();
			const cp = await svc.createCheckpoint(
				10000, "root", "croot", "vhash", 5, 100n, [v1],
			);
			expect(await svc.anchorToBitcoin(cp)).toBeNull();
		});
	});

	describe("verification", () => {
		it("verifies matching state root", async () => {
			const svc = new AnchorService();
			await svc.createCheckpoint(
				1000, "current_root", "croot", "vhash", 5, 100n, [v1],
			);

			const result = svc.verifyAgainstAnchor("current_root");
			expect(result.isValid).toBe(true);
			expect(result.lastAnchorHeight).toBe(1000);
		});

		it("detects mismatched state root", async () => {
			const svc = new AnchorService();
			await svc.createCheckpoint(
				1000, "old_root", "croot", "vhash", 5, 100n, [v1],
			);

			const result = svc.verifyAgainstAnchor("new_root");
			expect(result.isValid).toBe(false);
			expect(result.discrepancy).toContain("mismatch");
		});

		it("returns valid with no checkpoints", () => {
			const svc = new AnchorService();
			const result = svc.verifyAgainstAnchor("any_root");
			expect(result.isValid).toBe(true);
			expect(result.lastAnchorHeight).toBe(0);
		});

		it("includes external chain info in verification", async () => {
			const svc = new AnchorService();
			svc.ethereumSubmitter = async () => "0xabc";

			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1],
			);
			await svc.anchorToEthereum(cp);

			const result = svc.verifyAgainstAnchor("root");
			expect(result.externalChain).toBe("ethereum");
			expect(result.externalTxHash).toBe("0xabc");
		});
	});

	describe("checkpoint retrieval", () => {
		it("getCheckpoints returns range", async () => {
			const svc = new AnchorService();
			await svc.createCheckpoint(500, "r1", "c", "v", 1, 10n, [v1]);
			await svc.createCheckpoint(1000, "r2", "c", "v", 2, 20n, [v1]);
			await svc.createCheckpoint(1500, "r3", "c", "v", 3, 30n, [v1]);

			const result = svc.getCheckpoints(500, 1000);
			expect(result.length).toBe(2);
		});

		it("getAnchors returns all receipts", async () => {
			const svc = new AnchorService();
			svc.ethereumSubmitter = async () => "0x1";

			const cp = await svc.createCheckpoint(
				1000, "r", "c", "v", 1, 10n, [v1],
			);
			await svc.anchorToEthereum(cp);

			expect(svc.getAnchors().length).toBe(1);
		});
	});

	describe("emergency anchor", () => {
		it("produces out-of-schedule anchor", async () => {
			const svc = new AnchorService();
			svc.ethereumSubmitter = async () => "0xemergency";

			const cp = await svc.createCheckpoint(
				42, "root", "croot", "vhash", 5, 100n, [v1],
			);

			const receipt = await svc.emergencyAnchor(cp);
			expect(receipt).not.toBeNull();
			expect(receipt!.txHash).toBe("0xemergency");
		});
	});

	describe("encodeCheckpointPayload", () => {
		it("returns Uint8Array", async () => {
			const svc = new AnchorService();
			const cp = await svc.createCheckpoint(
				1, "r", "c", "v", 0, 0n, [],
			);
			const payload = encodeCheckpointPayload(cp);
			expect(payload).toBeInstanceOf(Uint8Array);
			expect(payload.length).toBeGreaterThan(0);
		});
	});
});
