import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	ConsensusModule,
	encodeAttestationPayload,
} from "../src/consensus/index.js";
import type { Attestation, AttestationPayload } from "../src/consensus/index.js";

const AGENT_DID = "did:key:z6MkAgentTestPublicKey";
const STATE_ROOT =
	"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

let consensus: ConsensusModule;
let validatorA: AgentIdentity;
let validatorB: AgentIdentity;
let validatorC: AgentIdentity;
let validatorD: AgentIdentity;

beforeEach(async () => {
	consensus = new ConsensusModule({ threshold: 3, minStake: 0 });

	// Create 4 validator identities from deterministic seeds
	validatorA = await createIdentity({
		seed: new Uint8Array(32).fill(1),
	});
	validatorB = await createIdentity({
		seed: new Uint8Array(32).fill(2),
	});
	validatorC = await createIdentity({
		seed: new Uint8Array(32).fill(3),
	});
	validatorD = await createIdentity({
		seed: new Uint8Array(32).fill(4),
	});

	// Register all 4 validators
	consensus.registerValidator(validatorA.did, validatorA.publicKey, 10000);
	consensus.registerValidator(validatorB.did, validatorB.publicKey, 10000);
	consensus.registerValidator(validatorC.did, validatorC.publicKey, 10000);
	consensus.registerValidator(validatorD.did, validatorD.publicKey, 10000);
});

describe("ConsensusModule", () => {
	// ── Validator registration ───────────────────────────────────────

	describe("registerValidator", () => {
		it("registers a validator with correct info", async () => {
			const module = new ConsensusModule();
			const id = await createIdentity({
				seed: new Uint8Array(32).fill(99),
			});

			const info = module.registerValidator(
				id.did,
				id.publicKey,
				5000,
			);

			expect(info.did).toBe(id.did);
			expect(info.publicKey).toEqual(id.publicKey);
			expect(info.stake).toBe(5000);
			expect(info.registeredAt).toBeGreaterThan(0);
		});

		it("rejects duplicate registration", () => {
			expect(() =>
				consensus.registerValidator(
					validatorA.did,
					validatorA.publicKey,
					10000,
				),
			).toThrow("already registered");
		});

		it("rejects invalid public key length", () => {
			expect(() =>
				consensus.registerValidator(
					"did:key:new",
					new Uint8Array(16),
					10000,
				),
			).toThrow("32 bytes");
		});

		it("rejects stake below minimum", () => {
			const module = new ConsensusModule({ minStake: 1000 });
			const pk = new Uint8Array(32).fill(0xaa);

			expect(() =>
				module.registerValidator("did:key:low", pk, 500),
			).toThrow("below minimum");
		});

		it("allows stake at exact minimum", () => {
			const module = new ConsensusModule({ minStake: 1000 });
			const pk = new Uint8Array(32).fill(0xaa);

			const info = module.registerValidator(
				"did:key:exact",
				pk,
				1000,
			);
			expect(info.stake).toBe(1000);
		});
	});

	// ── Validator removal ────────────────────────────────────────────

	describe("removeValidator", () => {
		it("removes an existing validator", () => {
			expect(consensus.removeValidator(validatorA.did)).toBe(true);
			expect(consensus.isValidator(validatorA.did)).toBe(false);
			expect(consensus.getValidatorCount()).toBe(3);
		});

		it("returns false for non-existent validator", () => {
			expect(consensus.removeValidator("did:key:nonexistent")).toBe(
				false,
			);
		});
	});

	// ── Validator set management ─────────────────────────────────────

	describe("validator set management", () => {
		it("getValidator returns info for registered validator", () => {
			const info = consensus.getValidator(validatorA.did);
			expect(info).not.toBeNull();
			expect(info!.did).toBe(validatorA.did);
			expect(info!.stake).toBe(10000);
		});

		it("getValidator returns null for unknown DID", () => {
			expect(consensus.getValidator("did:key:unknown")).toBeNull();
		});

		it("isValidator returns true for registered", () => {
			expect(consensus.isValidator(validatorA.did)).toBe(true);
		});

		it("isValidator returns false for unregistered", () => {
			expect(consensus.isValidator("did:key:unknown")).toBe(false);
		});

		it("getValidators returns all registered", () => {
			const validators = consensus.getValidators();
			expect(validators.length).toBe(4);
			const dids = validators.map((v) => v.did).sort();
			expect(dids).toContain(validatorA.did);
			expect(dids).toContain(validatorD.did);
		});

		it("getValidatorCount reflects additions and removals", () => {
			expect(consensus.getValidatorCount()).toBe(4);
			consensus.removeValidator(validatorA.did);
			expect(consensus.getValidatorCount()).toBe(3);
		});
	});

	// ── Configuration ────────────────────────────────────────────────

	describe("configuration", () => {
		it("getConfig returns current config", () => {
			const config = consensus.getConfig();
			expect(config.threshold).toBe(3);
			expect(config.minStake).toBe(0);
		});

		it("updateConfig changes threshold", () => {
			consensus.updateConfig({ threshold: 2 });
			expect(consensus.getConfig().threshold).toBe(2);
		});

		it("updateConfig changes minStake", () => {
			consensus.updateConfig({ minStake: 5000 });
			expect(consensus.getConfig().minStake).toBe(5000);
		});
	});

	// ── Attestation signing ──────────────────────────────────────────

	describe("createAttestation", () => {
		it("creates a signed attestation", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				7,
			);

			expect(att.validatorDid).toBe(validatorA.did);
			expect(att.agentDid).toBe(AGENT_DID);
			expect(att.stateRoot).toBe(STATE_ROOT);
			expect(att.version).toBe(7);
			expect(att.timestamp).toBeGreaterThan(0);
			expect(att.signature).toBeInstanceOf(Uint8Array);
			expect(att.signature.length).toBe(64);
		});

		it("rejects non-registered identity", async () => {
			const stranger = await createIdentity({
				seed: new Uint8Array(32).fill(0xff),
			});

			await expect(
				consensus.createAttestation(
					stranger,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
			).rejects.toThrow("not a registered validator");
		});

		it("different validators produce different signatures", async () => {
			const attA = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);
			const attB = await consensus.createAttestation(
				validatorB,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(attA.signature).not.toEqual(attB.signature);
		});
	});

	// ── Attestation verification ─────────────────────────────────────

	describe("verifyAttestation", () => {
		it("verifies a valid attestation", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const valid = await consensus.verifyAttestation(att);
			expect(valid).toBe(true);
		});

		it("rejects attestation from unknown validator", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			// Remove validator A, then verify
			consensus.removeValidator(validatorA.did);
			const valid = await consensus.verifyAttestation(att);
			expect(valid).toBe(false);
		});

		it("rejects attestation with tampered agentDid", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			// Tamper with the agentDid
			const tampered: Attestation = {
				...att,
				agentDid: "did:key:tampered",
			};

			const valid = await consensus.verifyAttestation(tampered);
			expect(valid).toBe(false);
		});

		it("rejects attestation with tampered stateRoot", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const tampered: Attestation = {
				...att,
				stateRoot: "00".repeat(32),
			};

			const valid = await consensus.verifyAttestation(tampered);
			expect(valid).toBe(false);
		});

		it("rejects attestation with tampered version", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const tampered: Attestation = { ...att, version: 999 };
			const valid = await consensus.verifyAttestation(tampered);
			expect(valid).toBe(false);
		});

		it("rejects attestation with tampered timestamp", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const tampered: Attestation = { ...att, timestamp: 0 };
			const valid = await consensus.verifyAttestation(tampered);
			expect(valid).toBe(false);
		});

		it("rejects attestation with corrupted signature", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const corrupted = new Uint8Array(att.signature);
			corrupted[0] = corrupted[0]! ^ 0xff;
			const tampered: Attestation = {
				...att,
				signature: corrupted,
			};

			const valid = await consensus.verifyAttestation(tampered);
			expect(valid).toBe(false);
		});

		it("rejects attestation with wrong validatorDid (signature mismatch)", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			// Claim the attestation was from B (but signature is from A)
			const tampered: Attestation = {
				...att,
				validatorDid: validatorB.did,
			};

			const valid = await consensus.verifyAttestation(tampered);
			expect(valid).toBe(false);
		});
	});

	// ── Threshold checking ───────────────────────────────────────────

	describe("checkThreshold", () => {
		it("threshold met with K valid attestations", async () => {
			const attestations = await Promise.all([
				consensus.createAttestation(
					validatorA,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorB,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorC,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
			]);

			const result = await consensus.checkThreshold(
				attestations,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.met).toBe(true);
			expect(result.validCount).toBe(3);
			expect(result.required).toBe(3);
			expect(result.total).toBe(4);
		});

		it("threshold not met with fewer than K", async () => {
			const attestations = await Promise.all([
				consensus.createAttestation(
					validatorA,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorB,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
			]);

			const result = await consensus.checkThreshold(
				attestations,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.met).toBe(false);
			expect(result.validCount).toBe(2);
		});

		it("threshold met with more than K (all 4 validators)", async () => {
			const attestations = await Promise.all([
				consensus.createAttestation(
					validatorA,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorB,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorC,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorD,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
			]);

			const result = await consensus.checkThreshold(
				attestations,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.met).toBe(true);
			expect(result.validCount).toBe(4);
		});

		it("deduplicates attestations from same validator", async () => {
			const att1 = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);
			const att2 = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);
			const att3 = await consensus.createAttestation(
				validatorB,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const result = await consensus.checkThreshold(
				[att1, att2, att3],
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			// Only 2 unique validators, even though 3 attestations
			expect(result.validCount).toBe(2);
			expect(result.met).toBe(false);
		});

		it("ignores attestations for wrong agentDid", async () => {
			const attCorrect = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);
			const attWrong = await consensus.createAttestation(
				validatorB,
				"did:key:wrong-agent",
				STATE_ROOT,
				1,
			);
			const attCorrect2 = await consensus.createAttestation(
				validatorC,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const result = await consensus.checkThreshold(
				[attCorrect, attWrong, attCorrect2],
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.validCount).toBe(2);
			expect(result.met).toBe(false);
		});

		it("ignores attestations for wrong stateRoot", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				"ff".repeat(32),
				1,
			);

			const result = await consensus.checkThreshold(
				[att],
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.validCount).toBe(0);
		});

		it("ignores attestations for wrong version", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				99,
			);

			const result = await consensus.checkThreshold(
				[att],
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.validCount).toBe(0);
		});

		it("returns zero for empty attestation list", async () => {
			const result = await consensus.checkThreshold(
				[],
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.met).toBe(false);
			expect(result.validCount).toBe(0);
		});

		it("handles configurable threshold (2-of-4)", async () => {
			consensus.updateConfig({ threshold: 2 });

			const attestations = await Promise.all([
				consensus.createAttestation(
					validatorA,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorB,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
			]);

			const result = await consensus.checkThreshold(
				attestations,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.met).toBe(true);
			expect(result.required).toBe(2);
		});

		it("threshold 1-of-N (single validator sufficient)", async () => {
			consensus.updateConfig({ threshold: 1 });

			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			const result = await consensus.checkThreshold(
				[att],
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.met).toBe(true);
		});
	});

	// ── encodeAttestationPayload ─────────────────────────────────────

	describe("encodeAttestationPayload", () => {
		it("produces deterministic encoding", () => {
			const payload: AttestationPayload = {
				validatorDid: "did:key:v1",
				agentDid: AGENT_DID,
				stateRoot: STATE_ROOT,
				version: 5,
				timestamp: 1700000000000,
			};

			const a = encodeAttestationPayload(payload);
			const b = encodeAttestationPayload(payload);
			expect(a).toEqual(b);
		});

		it("different payloads produce different encodings", () => {
			const a = encodeAttestationPayload({
				validatorDid: "did:key:v1",
				agentDid: AGENT_DID,
				stateRoot: STATE_ROOT,
				version: 1,
				timestamp: 1000,
			});
			const b = encodeAttestationPayload({
				validatorDid: "did:key:v1",
				agentDid: AGENT_DID,
				stateRoot: STATE_ROOT,
				version: 2,
				timestamp: 1000,
			});
			expect(a).not.toEqual(b);
		});
	});

	// ── Edge cases ───────────────────────────────────────────────────

	describe("edge cases", () => {
		it("validator removed after attestation is not verified", async () => {
			const att = await consensus.createAttestation(
				validatorA,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			consensus.removeValidator(validatorA.did);

			const valid = await consensus.verifyAttestation(att);
			expect(valid).toBe(false);
		});

		it("attestation from removed validator doesn't count for threshold", async () => {
			const attestations = await Promise.all([
				consensus.createAttestation(
					validatorA,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorB,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
				consensus.createAttestation(
					validatorC,
					AGENT_DID,
					STATE_ROOT,
					1,
				),
			]);

			// Remove validator A before checking
			consensus.removeValidator(validatorA.did);

			const result = await consensus.checkThreshold(
				attestations,
				AGENT_DID,
				STATE_ROOT,
				1,
			);

			expect(result.validCount).toBe(2);
			expect(result.met).toBe(false);
		});

		it("re-registering a removed validator works", async () => {
			consensus.removeValidator(validatorA.did);
			expect(consensus.isValidator(validatorA.did)).toBe(false);

			consensus.registerValidator(
				validatorA.did,
				validatorA.publicKey,
				20000,
			);
			expect(consensus.isValidator(validatorA.did)).toBe(true);

			const info = consensus.getValidator(validatorA.did)!;
			expect(info.stake).toBe(20000);
		});

		it("many validators can register", async () => {
			const module = new ConsensusModule();
			for (let i = 0; i < 35; i++) {
				const seed = new Uint8Array(32);
				seed[0] = i;
				const id = await createIdentity({ seed });
				module.registerValidator(id.did, id.publicKey, 10000);
			}

			expect(module.getValidatorCount()).toBe(35);
		});
	});
});
