import { describe, it, expect, afterEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import {
	NetworkClientImpl,
	encode,
	decode,
	gfMul,
	gfDiv,
	gfInv,
	serializeMessage,
	deserializeMessage,
} from "../src/index.js";
import type { ErasureConfig } from "../src/index.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Track clients for cleanup
const clients: NetworkClientImpl[] = [];

afterEach(async () => {
	for (const c of clients) {
		try {
			await c.disconnect();
		} catch {
			// ignore
		}
	}
	clients.length = 0;
});

// ── GF(256) Arithmetic ───────────────────────────────────────────────

describe("GF(256) arithmetic", () => {
	it("gfMul identity: a * 1 = a", () => {
		for (let a = 0; a < 256; a++) {
			expect(gfMul(a, 1)).toBe(a);
		}
	});

	it("gfMul zero: a * 0 = 0", () => {
		for (let a = 0; a < 256; a++) {
			expect(gfMul(a, 0)).toBe(0);
		}
	});

	it("gfMul commutativity: a * b = b * a", () => {
		expect(gfMul(5, 7)).toBe(gfMul(7, 5));
		expect(gfMul(100, 200)).toBe(gfMul(200, 100));
	});

	it("gfDiv is inverse of gfMul", () => {
		for (let a = 1; a < 256; a++) {
			for (let b = 1; b < 10; b++) {
				const product = gfMul(a, b);
				expect(gfDiv(product, b)).toBe(a);
			}
		}
	});

	it("gfInv: a * inv(a) = 1", () => {
		for (let a = 1; a < 256; a++) {
			expect(gfMul(a, gfInv(a))).toBe(1);
		}
	});

	it("gfDiv throws on division by zero", () => {
		expect(() => gfDiv(5, 0)).toThrow("Division by zero");
	});

	it("gfInv throws on inverse of zero", () => {
		expect(() => gfInv(0)).toThrow("Inverse of zero");
	});
});

// ── Erasure Coding ───────────────────────────────────────────────────

describe("erasure coding", () => {
	const config: ErasureConfig = { dataShards: 2, totalShards: 4 };

	it("encode produces correct number of shards", () => {
		const data = enc("hello world of erasure coding!");
		const shards = encode(data, config);
		expect(shards.length).toBe(4);
	});

	it("shards have equal size", () => {
		const data = enc("test data for erasure coding");
		const shards = encode(data, config);
		const size = shards[0]!.length;
		for (const s of shards) {
			expect(s.length).toBe(size);
		}
	});

	it("decode from data shards (0,1) - direct reconstruction", () => {
		const data = enc("hello erasure world!");
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			shards[0]!,
			shards[1]!,
			null,
			null,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("decode from shards (0,2)", () => {
		const data = enc("reconstruction test alpha");
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			shards[0]!,
			null,
			shards[2]!,
			null,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("decode from shards (0,3)", () => {
		const data = enc("reconstruction test beta");
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			shards[0]!,
			null,
			null,
			shards[3]!,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("decode from shards (1,2)", () => {
		const data = enc("reconstruction test gamma");
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			null,
			shards[1]!,
			shards[2]!,
			null,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("decode from shards (1,3)", () => {
		const data = enc("reconstruction test delta");
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			null,
			shards[1]!,
			null,
			shards[3]!,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("decode from parity shards (2,3) - hardest case", () => {
		const data = enc("reconstruction from parity only!");
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			null,
			null,
			shards[2]!,
			shards[3]!,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("handles binary data with all byte values", () => {
		const data = new Uint8Array(256);
		for (let i = 0; i < 256; i++) data[i] = i;

		const shards = encode(data, config);

		// Test all 6 combinations of 2 shards
		const combos: [number, number][] = [
			[0, 1],
			[0, 2],
			[0, 3],
			[1, 2],
			[1, 3],
			[2, 3],
		];

		for (const [a, b] of combos) {
			const available: (Uint8Array | null)[] = [
				null,
				null,
				null,
				null,
			];
			available[a] = shards[a]!;
			available[b] = shards[b]!;
			const result = decode(available, config, data.length);
			expect(result).toEqual(data);
		}
	});

	it("handles odd-length data", () => {
		const data = enc("odd"); // 3 bytes
		const shards = encode(data, config);
		const available: (Uint8Array | null)[] = [
			null,
			null,
			shards[2]!,
			shards[3]!,
		];
		const result = decode(available, config, data.length);
		expect(result).toEqual(data);
	});

	it("handles single byte data", () => {
		const data = new Uint8Array([42]);
		const shards = encode(data, config);
		const result = decode(
			[shards[0]!, null, null, shards[3]!],
			config,
			data.length,
		);
		expect(result).toEqual(data);
	});

	it("handles large data (100KB)", () => {
		const data = new Uint8Array(100 * 1024);
		for (let i = 0; i < data.length; i++) data[i] = i % 256;

		const shards = encode(data, config);
		const result = decode(
			[null, shards[1]!, shards[2]!, null],
			config,
			data.length,
		);
		expect(result).toEqual(data);
	});

	it("throws with insufficient shards", () => {
		const data = enc("test");
		const shards = encode(data, config);
		expect(() =>
			decode([shards[0]!, null, null, null], config, data.length),
		).toThrow("Need 2 shards");
	});

	it("rejects K != 2", () => {
		expect(() =>
			encode(enc("test"), { dataShards: 3, totalShards: 5 }),
		).toThrow("Only K=2");
	});
});

// ── Protocol Serialization ───────────────────────────────────────────

describe("protocol serialization", () => {
	it("round-trips a message without payload", () => {
		const msg = {
			type: "retrieve" as const,
			agentDid: "did:key:test",
			version: 5,
			shardIndex: 0,
		};
		const serialized = serializeMessage(msg);
		const { header, payload } = deserializeMessage(serialized);
		expect(header).toEqual(msg);
		expect(payload.length).toBe(0);
	});

	it("round-trips a message with binary payload", () => {
		const msg = {
			type: "response" as const,
			status: "ok" as const,
			version: 3,
		};
		const data = new Uint8Array([0, 1, 2, 255, 128, 0, 0, 64]);
		const serialized = serializeMessage(msg, data);
		const { header, payload } = deserializeMessage(serialized);
		expect(header).toEqual(msg);
		expect(payload).toEqual(data);
	});

	it("handles payload with null bytes", () => {
		const msg = {
			type: "response" as const,
			status: "ok" as const,
		};
		const data = new Uint8Array([0, 0, 0, 0]);
		const serialized = serializeMessage(msg, data);
		const { payload } = deserializeMessage(serialized);
		expect(payload).toEqual(data);
	});
});

// ── NetworkClient (in-memory, single node) ───────────────────────────

describe("NetworkClientImpl (single node)", () => {
	it("stores and retrieves state locally", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(1),
		});
		const client = new NetworkClientImpl(identity);
		clients.push(client);
		await client.connect([]);

		const data = enc("agent consciousness state v1");
		const sig = await identity.sign(enc("root:1"));

		const receipt = await client.storeState(
			data,
			"root-hash-v1",
			1,
			sig,
		);
		expect(receipt.version).toBe(1);
		expect(receipt.stateRoot).toBe("root-hash-v1");
		expect(receipt.shardIds.length).toBe(4);

		const result = await client.retrieveState(identity.did, 1);
		expect(result.blob).toEqual(data);
		expect(result.root).toBe("root-hash-v1");
		expect(result.version).toBe(1);
	});

	it("getBalance decreases after store", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(2),
		});
		const client = new NetworkClientImpl(identity);
		clients.push(client);
		await client.connect([]);

		const before = await client.getBalance();
		const sig = await identity.sign(enc("root:1"));
		await client.storeState(enc("data"), "root", 1, sig);
		const after = await client.getBalance();

		expect(after).toBeLessThan(before);
	});

	it("estimateCost returns positive value", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(3),
		});
		const client = new NetworkClientImpl(identity);
		const cost = await client.estimateCost(10240, 4);
		expect(cost).toBeGreaterThan(0);
	});

	it("connect/disconnect lifecycle", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(4),
		});
		const client = new NetworkClientImpl(identity);
		clients.push(client);

		expect(client.isConnected()).toBe(false);
		await client.connect([]);
		expect(client.isConnected()).toBe(true);
		await client.disconnect();
		expect(client.isConnected()).toBe(false);
	});

	it("startNode/stopNode/getNodeStats", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(5),
		});
		const client = new NetworkClientImpl(identity);
		clients.push(client);
		await client.connect([]);

		await client.startNode({
			maxStorageGB: 10,
			port: 9000,
		});

		const sig = await identity.sign(enc("root:1"));
		await client.storeState(enc("data"), "root", 1, sig);

		const stats = await client.getNodeStats();
		expect(stats.shardsStored).toBeGreaterThan(0);
		expect(stats.totalBytesStored).toBeGreaterThan(0);

		await client.stopNode();
	});
});

// ── Two-peer P2P tests ───────────────────────────────────────────────

describe("NetworkClientImpl (two peers)", () => {
	it("two peers connect and exchange shards", async () => {
		const idA = await createIdentity({
			seed: new Uint8Array(32).fill(10),
		});
		const idB = await createIdentity({
			seed: new Uint8Array(32).fill(11),
		});

		const clientA = new NetworkClientImpl(idA);
		const clientB = new NetworkClientImpl(idB);
		clients.push(clientA, clientB);

		await clientA.connect([]);
		await clientB.connect([]);

		// Get clientB's multiaddr
		const nodeB = clientB.getLibp2p()!;
		const addrs = nodeB.getMultiaddrs();
		expect(addrs.length).toBeGreaterThan(0);

		// Connect A to B
		const nodeA = clientA.getLibp2p()!;
		await nodeA.dial(addrs[0]!);

		expect(clientA.getPeerCount()).toBeGreaterThanOrEqual(1);

		// Store from A — some shards go to B
		const data = enc("consciousness data for P2P test");
		const sig = await idA.sign(enc("root:1"));
		const receipt = await clientA.storeState(
			data,
			"p2p-root",
			1,
			sig,
		);
		expect(receipt.shardIds.length).toBe(4);

		// Retrieve from A (has some shards locally, fetches rest from B)
		const result = await clientA.retrieveState(idA.did, 1);
		expect(result.blob).toEqual(data);
	}, 15000);

	it("store on peer A, retrieve from peer B via shard copy", async () => {
		const idA = await createIdentity({
			seed: new Uint8Array(32).fill(20),
		});
		const idB = await createIdentity({
			seed: new Uint8Array(32).fill(21),
		});

		// Use default 2-of-4 erasure config
		const clientA = new NetworkClientImpl(idA);
		const clientB = new NetworkClientImpl(idB);
		clients.push(clientA, clientB);

		await clientA.connect([]);
		await clientB.connect([]);

		const nodeA = clientA.getLibp2p()!;
		const nodeB = clientB.getLibp2p()!;
		await nodeA.dial(nodeB.getMultiaddrs()[0]!);

		const data = enc("shared state between peers");
		const sig = await idA.sign(enc("root:1"));
		await clientA.storeState(data, "shared-root", 1, sig);

		// Copy any 2 shards from A to B (simulating network distribution)
		for (let i = 0; i < 2; i++) {
			const shard = clientA.getShard(idA.did, 1, i);
			if (shard) {
				clientB.storeShard(
					idA.did,
					1,
					i,
					shard.data,
					shard.stateRoot,
					shard.originalLength,
					shard.signature,
				);
			}
		}

		const result = await clientB.retrieveState(idA.did, 1);
		expect(result.blob).toEqual(data);
		expect(result.root).toBe("shared-root");
	}, 15000);
});

// ── Erasure coding: delete 2 of 4 shards, reconstruct ───────────────

describe("erasure coding integration", () => {
	it("store 4 shards, delete 2, reconstruct from remaining 2", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(30),
		});
		const client = new NetworkClientImpl(identity);
		clients.push(client);
		await client.connect([]);

		const originalData = enc(
			"This is the agent's full consciousness state that needs to survive shard loss.",
		);
		const sig = await identity.sign(enc("root:7"));
		await client.storeState(originalData, "root-v7", 7, sig);

		// Verify all 4 shards are stored locally
		for (let i = 0; i < 4; i++) {
			expect(
				client.getShard(identity.did, 7, i),
			).not.toBeNull();
		}

		// Simulate losing shards 0 and 1 (data shards)
		// We'll manually decode from shards 2 and 3 (parity only)
		const config: ErasureConfig = {
			dataShards: 2,
			totalShards: 4,
		};
		const shard2 = client.getShard(identity.did, 7, 2)!;
		const shard3 = client.getShard(identity.did, 7, 3)!;

		const available: (Uint8Array | null)[] = [
			null,
			null,
			shard2.data,
			shard3.data,
		];

		const reconstructed = decode(
			available,
			config,
			originalData.length,
		);
		expect(reconstructed).toEqual(originalData);
	});

	it("full store/retrieve cycle with encryption", async () => {
		const identity = await createIdentity({
			seed: new Uint8Array(32).fill(40),
		});
		const client = new NetworkClientImpl(identity);
		clients.push(client);
		await client.connect([]);

		// Encrypt the data first (as the SDK would do)
		const plaintext = enc(
			"Secret consciousness state that must be encrypted before network storage",
		);
		const encrypted = await identity.encrypt(plaintext);

		// Serialize the encrypted payload (ciphertext + nonce + ephemeralPubKey)
		const blob = new Uint8Array(
			encrypted.ciphertext.length +
				encrypted.nonce.length +
				(encrypted.ephemeralPubKey?.length ?? 0),
		);
		let offset = 0;
		blob.set(encrypted.ciphertext, offset);
		offset += encrypted.ciphertext.length;
		blob.set(encrypted.nonce, offset);
		offset += encrypted.nonce.length;
		if (encrypted.ephemeralPubKey) {
			blob.set(encrypted.ephemeralPubKey, offset);
		}

		const sig = await identity.sign(enc("encrypted-root:1"));
		await client.storeState(blob, "encrypted-root", 1, sig);

		// Retrieve
		const result = await client.retrieveState(identity.did, 1);
		expect(result.blob).toEqual(blob);

		// Verify the encrypted data can be decrypted back
		const ctLen = encrypted.ciphertext.length;
		const nonceLen = encrypted.nonce.length;
		const retrieved = {
			ciphertext: result.blob.subarray(0, ctLen),
			nonce: result.blob.subarray(ctLen, ctLen + nonceLen),
			ephemeralPubKey: result.blob.subarray(ctLen + nonceLen),
		};

		const decrypted = await identity.decrypt(retrieved);
		expect(decrypted).toEqual(plaintext);
	});
});
