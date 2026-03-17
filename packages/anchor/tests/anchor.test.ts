import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	CheckpointService,
	computeCheckpointHash,
	encodeCheckpointPayload,
} from "../src/index.js";

let v1: AgentIdentity;
let v2: AgentIdentity;
let v3: AgentIdentity;

beforeEach(async () => {
	v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
});

describe("CheckpointService", () => {
	describe("checkpoint creation", () => {
		it("creates a checkpoint with validator signatures", async () => {
			const svc = new CheckpointService({ minSignatures: 2 });
			const cp = await svc.createCheckpoint(
				1000, "state_root", "consciousness_root",
				"validator_set_hash", 42, 1_000_000n, [v1, v2, v3],
			);

			expect(cp.ensoulBlockHeight).toBe(1000);
			expect(cp.stateRoot).toBe("state_root");
			expect(cp.totalConsciousnesses).toBe(42);
			expect(cp.signatures.length).toBe(3);
			for (const sig of cp.signatures) {
				expect(sig.signature.length).toBe(64);
			}
		});

		it("checkpoint hash is deterministic", async () => {
			const svc = new CheckpointService();
			const cp = await svc.createCheckpoint(
				500, "root", "croot", "vhash", 10, 100n, [v1],
			);
			expect(computeCheckpointHash(cp)).toBe(computeCheckpointHash(cp));
		});

		it("different state roots produce different hashes", async () => {
			const svc = new CheckpointService();
			const cp1 = await svc.createCheckpoint(
				500, "root_a", "croot", "vhash", 10, 100n, [v1],
			);
			const cp2 = await svc.createCheckpoint(
				500, "root_b", "croot", "vhash", 10, 100n, [v1],
			);
			expect(computeCheckpointHash(cp1)).not.toBe(computeCheckpointHash(cp2));
		});
	});

	describe("signature verification", () => {
		it("verifies valid signatures", async () => {
			const svc = new CheckpointService({ minSignatures: 2 });
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
			const svc = new CheckpointService({ minSignatures: 3 });
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
			const svc = new CheckpointService({ minSignatures: 1 });
			const cp = await svc.createCheckpoint(
				1000, "root", "croot", "vhash", 5, 100n, [v1],
			);
			const result = await svc.verifyCheckpointSignatures(cp, [
				{ did: v2.did, verify: v2.verify.bind(v2) },
			]);
			expect(result.validCount).toBe(0);
			expect(result.valid).toBe(false);
		});
	});

	describe("checkpoint scheduling", () => {
		it("shouldCheckpoint at interval", () => {
			const svc = new CheckpointService({ interval: 1000 });
			expect(svc.shouldCheckpoint(0)).toBe(false);
			expect(svc.shouldCheckpoint(500)).toBe(false);
			expect(svc.shouldCheckpoint(1000)).toBe(true);
			expect(svc.shouldCheckpoint(2000)).toBe(true);
		});
	});

	describe("verification against checkpoint", () => {
		it("verifies matching state root", async () => {
			const svc = new CheckpointService();
			await svc.createCheckpoint(
				1000, "current_root", "croot", "vhash", 5, 100n, [v1],
			);
			const result = svc.verifyAgainstCheckpoint("current_root");
			expect(result.isValid).toBe(true);
			expect(result.lastCheckpointHeight).toBe(1000);
		});

		it("detects mismatched state root", async () => {
			const svc = new CheckpointService();
			await svc.createCheckpoint(
				1000, "old_root", "croot", "vhash", 5, 100n, [v1],
			);
			const result = svc.verifyAgainstCheckpoint("new_root");
			expect(result.isValid).toBe(false);
			expect(result.discrepancy).toContain("mismatch");
		});

		it("returns valid with no checkpoints", () => {
			const svc = new CheckpointService();
			const result = svc.verifyAgainstCheckpoint("any_root");
			expect(result.isValid).toBe(true);
			expect(result.lastCheckpointHeight).toBe(0);
		});
	});

	describe("checkpoint retrieval", () => {
		it("getCheckpoints returns range", async () => {
			const svc = new CheckpointService();
			await svc.createCheckpoint(500, "r1", "c", "v", 1, 10n, [v1]);
			await svc.createCheckpoint(1000, "r2", "c", "v", 2, 20n, [v1]);
			await svc.createCheckpoint(1500, "r3", "c", "v", 3, 30n, [v1]);
			expect(svc.getCheckpoints(500, 1000).length).toBe(2);
		});

		it("getLatestCheckpoint returns most recent", async () => {
			const svc = new CheckpointService();
			await svc.createCheckpoint(500, "r1", "c", "v", 1, 10n, [v1]);
			await svc.createCheckpoint(1000, "r2", "c", "v", 2, 20n, [v1]);
			expect(svc.getLatestCheckpoint()?.ensoulBlockHeight).toBe(1000);
		});

		it("getLatestCheckpoint returns null when empty", () => {
			const svc = new CheckpointService();
			expect(svc.getLatestCheckpoint()).toBeNull();
		});

		it("getCheckpointCount tracks correctly", async () => {
			const svc = new CheckpointService();
			expect(svc.getCheckpointCount()).toBe(0);
			await svc.createCheckpoint(500, "r1", "c", "v", 1, 10n, [v1]);
			expect(svc.getCheckpointCount()).toBe(1);
		});
	});

	describe("emergency checkpoint", () => {
		it("produces out-of-schedule checkpoint", async () => {
			const svc = new CheckpointService();
			const cp = await svc.emergencyCheckpoint(
				42, "root", "croot", "vhash", 5, 100n, [v1, v2],
			);
			expect(cp.ensoulBlockHeight).toBe(42);
			expect(cp.signatures.length).toBe(2);
			expect(svc.getCheckpointCount()).toBe(1);
		});
	});

	describe("encodeCheckpointPayload", () => {
		it("returns Uint8Array", async () => {
			const svc = new CheckpointService();
			const cp = await svc.createCheckpoint(
				1, "r", "c", "v", 0, 0n, [],
			);
			const payload = encodeCheckpointPayload(cp);
			expect(payload).toBeInstanceOf(Uint8Array);
			expect(payload.length).toBeGreaterThan(0);
		});
	});
});
