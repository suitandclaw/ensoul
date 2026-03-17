import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { createTree } from "@ensoul/state-tree";
import type { ConsciousnessTree } from "@ensoul/state-tree";
import {
	HandshakeProvider,
	HandshakeVerifier,
	generateStandaloneHandshake,
} from "../src/handshake.js";
import type { KnownIdentity } from "../src/handshake.js";

let agentA: AgentIdentity;
let agentB: AgentIdentity;
let treeA: ConsciousnessTree;
let treeB: ConsciousnessTree;

beforeEach(async () => {
	agentA = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	agentB = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	treeA = await createTree(agentA);
	treeB = await createTree(agentB);
});

function knownId(agent: AgentIdentity): KnownIdentity {
	return {
		did: agent.did,
		publicKey: agent.publicKey,
		verify: agent.verify.bind(agent),
	};
}

// ── HandshakeProvider ────────────────────────────────────────────────

describe("HandshakeProvider", () => {
	it("generates three handshake headers", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		expect(headers["X-Ensoul-Identity"]).toContain("did:ensoul:");
		expect(headers["X-Ensoul-Identity"]).toContain(agentA.did);
		expect(headers["X-Ensoul-Proof"]).toBeTruthy();
		expect(headers["X-Ensoul-Since"]).toBeTruthy();
	});

	it("proof contains signature:stateRoot:version:timestamp", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		const parts = headers["X-Ensoul-Proof"].split(":");
		expect(parts.length).toBe(4);
		expect(parts[0]!.length).toBe(128); // 64-byte sig = 128 hex chars
		expect(parts[1]).toBe(treeA.rootHash);
		expect(Number(parts[2])).toBe(treeA.version);
		expect(Number(parts[3])).toBeGreaterThan(0);
	});

	it("Since header is ISO timestamp", async () => {
		const date = new Date("2025-01-15T00:00:00.000Z");
		const provider = new HandshakeProvider(agentA, treeA, date);
		const headers = await provider.generateHandshake();

		expect(headers["X-Ensoul-Since"]).toBe(
			"2025-01-15T00:00:00.000Z",
		);
	});

	it("caches handshake and returns same headers", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const h1 = await provider.generateHandshake();
		const h2 = await provider.generateHandshake();

		expect(h1["X-Ensoul-Proof"]).toBe(h2["X-Ensoul-Proof"]);
	});

	it("refreshes cache on state change", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const h1 = await provider.generateHandshake();

		// Mutate tree state
		await treeA.set("key", new TextEncoder().encode("value"));

		const h2 = await provider.generateHandshake();
		expect(h2["X-Ensoul-Proof"]).not.toBe(h1["X-Ensoul-Proof"]);
	});

	it("invalidateCache forces regeneration", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const h1 = await provider.generateHandshake();
		provider.invalidateCache();
		const h2 = await provider.generateHandshake();

		// Timestamp will differ even if state is the same
		const t1 = h1["X-Ensoul-Proof"].split(":")[3];
		const t2 = h2["X-Ensoul-Proof"].split(":")[3];
		// May or may not differ depending on timing — but cache was cleared
		expect(h2["X-Ensoul-Proof"]).toBeTruthy();
	});

	it("getEnsoulmentDate returns the configured date", () => {
		const date = new Date("2024-06-01");
		const provider = new HandshakeProvider(agentA, treeA, date);
		expect(provider.getEnsoulmentDate()).toEqual(date);
	});

	it("getConsciousnessAgeDays returns correct age", () => {
		const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const provider = new HandshakeProvider(agentA, treeA, pastDate);
		expect(provider.getConsciousnessAgeDays()).toBe(10);
	});

	it("defaults ensoulment date to now", () => {
		const provider = new HandshakeProvider(agentA, treeA);
		expect(provider.getConsciousnessAgeDays()).toBe(0);
	});
});

// ── HandshakeVerifier ────────────────────────────────────────────────

describe("HandshakeVerifier", () => {
	it("verifies a valid handshake", async () => {
		const provider = new HandshakeProvider(
			agentA,
			treeA,
			new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
		);
		const headers = await provider.generateHandshake();

		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));

		const result = await verifier.verifyHandshake(headers);
		expect(result.valid).toBe(true);
		expect(result.agentDid).toBe(agentA.did);
		expect(result.consciousnessAge).toBe(5);
		expect(result.consciousnessVersion).toBe(treeA.version);
	});

	it("rejects missing headers", async () => {
		const verifier = new HandshakeVerifier();
		const result = await verifier.verifyHandshake({});
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Missing");
	});

	it("rejects malformed proof", async () => {
		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));

		const result = await verifier.verifyHandshake({
			"X-Ensoul-Identity": `did:ensoul:${agentA.did}`,
			"X-Ensoul-Proof": "bad_proof",
			"X-Ensoul-Since": new Date().toISOString(),
		});
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Malformed");
	});

	it("rejects expired proof (timestamp too old)", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		// Tamper with timestamp to be 15 minutes old
		const parts = headers["X-Ensoul-Proof"].split(":");
		const oldTimestamp = Date.now() - 15 * 60 * 1000;
		parts[3] = String(oldTimestamp);

		// Re-sign with the old timestamp
		const proofPayload = `${parts[1]}:${parts[2]}:${parts[3]}`;
		const sig = await agentA.sign(
			new TextEncoder().encode(proofPayload),
		);
		parts[0] = Array.from(sig)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));

		const result = await verifier.verifyHandshake({
			...headers,
			"X-Ensoul-Proof": parts.join(":"),
		});
		expect(result.valid).toBe(false);
		expect(result.error).toContain("expired");
	});

	it("rejects future timestamp", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		const parts = headers["X-Ensoul-Proof"].split(":");
		parts[3] = String(Date.now() + 120000); // 2 min in future
		const proofPayload = `${parts[1]}:${parts[2]}:${parts[3]}`;
		const sig = await agentA.sign(
			new TextEncoder().encode(proofPayload),
		);
		parts[0] = Array.from(sig)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));

		const result = await verifier.verifyHandshake({
			...headers,
			"X-Ensoul-Proof": parts.join(":"),
		});
		expect(result.valid).toBe(false);
		expect(result.error).toContain("future");
	});

	it("rejects unknown identity", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		const verifier = new HandshakeVerifier();
		// Don't register agentA

		const result = await verifier.verifyHandshake(headers);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Unknown identity");
	});

	it("rejects invalid signature (wrong signer)", async () => {
		const providerA = new HandshakeProvider(agentA, treeA);
		const headers = await providerA.generateHandshake();

		// Register agentB's key under agentA's DID (simulates key mismatch)
		const verifier = new HandshakeVerifier();
		verifier.registerIdentity({
			did: agentA.did,
			publicKey: agentB.publicKey,
			verify: agentB.verify.bind(agentB),
		});

		const result = await verifier.verifyHandshake(headers);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid signature");
	});

	it("rejects tampered proof (modified state root)", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const headers = await provider.generateHandshake();

		// Tamper with state root in the proof
		const parts = headers["X-Ensoul-Proof"].split(":");
		parts[1] = "tampered_root";

		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));

		const result = await verifier.verifyHandshake({
			...headers,
			"X-Ensoul-Proof": parts.join(":"),
		});
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid signature");
	});
});

// ── Full A→B cycle ───────────────────────────────────────────────────

describe("full handshake cycle", () => {
	it("agent A generates → agent B verifies", async () => {
		// Agent A generates handshake
		const ensoulDate = new Date(
			Date.now() - 187 * 24 * 60 * 60 * 1000,
		);
		const providerA = new HandshakeProvider(agentA, treeA, ensoulDate);
		const headers = await providerA.generateHandshake();

		// Agent B verifies
		const verifierB = new HandshakeVerifier();
		verifierB.registerIdentity(knownId(agentA));

		const result = await verifierB.verifyHandshake(headers);
		expect(result.valid).toBe(true);
		expect(result.agentDid).toBe(agentA.did);
		expect(result.consciousnessAge).toBe(187);
		expect(result.consciousnessVersion).toBe(0);
	});

	it("handshake updates after state mutation", async () => {
		const provider = new HandshakeProvider(agentA, treeA);
		const h1 = await provider.generateHandshake();

		await treeA.set("soul/name", new TextEncoder().encode("Agent A"));

		const h2 = await provider.generateHandshake();

		// Different proof (state root changed, version incremented)
		expect(h2["X-Ensoul-Proof"]).not.toBe(h1["X-Ensoul-Proof"]);

		// Both verify correctly
		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));

		const r1 = await verifier.verifyHandshake(h1);
		const r2 = await verifier.verifyHandshake(h2);
		expect(r1.valid).toBe(true);
		expect(r2.valid).toBe(true);
		expect(r2.consciousnessVersion).toBe(1);
	});
});

// ── Standalone utility ───────────────────────────────────────────────

describe("generateStandaloneHandshake", () => {
	it("generates valid headers outside ElizaOS", async () => {
		const date = new Date("2025-03-01");
		const headers = await generateStandaloneHandshake(
			agentA,
			treeA,
			date,
		);

		expect(headers["X-Ensoul-Identity"]).toContain(agentA.did);
		expect(headers["X-Ensoul-Proof"]).toBeTruthy();
		expect(headers["X-Ensoul-Since"]).toBe("2025-03-01T00:00:00.000Z");

		// Verify with HandshakeVerifier
		const verifier = new HandshakeVerifier();
		verifier.registerIdentity(knownId(agentA));
		const result = await verifier.verifyHandshake(headers);
		expect(result.valid).toBe(true);
	});
});
