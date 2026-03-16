import { describe, it, expect } from "vitest";
import {
	createIdentity,
	loadIdentity,
	verifyMigrationProof,
	base58btcEncode,
	base58btcDecode,
	edwardsToMontgomeryPub,
	edwardsToMontgomeryPriv,
	bytesToHex,
	hexToBytes,
	createDid,
	createPeerId,
} from "../src/index.js";
import type { EncryptedPayload } from "../src/index.js";

describe("@ensoul/identity", () => {
	describe("createIdentity", () => {
		it("creates an identity with all required fields", async () => {
			const identity = await createIdentity();

			expect(identity.peerId).toBeDefined();
			expect(identity.peerId.length).toBeGreaterThan(0);
			expect(identity.publicKey).toBeInstanceOf(Uint8Array);
			expect(identity.publicKey.length).toBe(32);
			expect(identity.did).toMatch(/^did:key:z6Mk/);
		});

		it("creates deterministic identity from seed", async () => {
			const seed = new Uint8Array(32).fill(42);
			const id1 = await createIdentity({ seed });
			const id2 = await createIdentity({ seed });

			expect(id1.peerId).toBe(id2.peerId);
			expect(id1.did).toBe(id2.did);
			expect(id1.publicKey).toEqual(id2.publicKey);
		});

		it("creates unique identities without seed", async () => {
			const id1 = await createIdentity();
			const id2 = await createIdentity();

			expect(id1.peerId).not.toBe(id2.peerId);
			expect(id1.did).not.toBe(id2.did);
		});

		it("rejects invalid seed length", async () => {
			await expect(
				createIdentity({ seed: new Uint8Array(16) }),
			).rejects.toThrow("32 bytes");
		});
	});

	describe("sign and verify", () => {
		it("signs data and verifies signature", async () => {
			const identity = await createIdentity();
			const data = new TextEncoder().encode("hello ensoul");

			const signature = await identity.sign(data);
			expect(signature).toBeInstanceOf(Uint8Array);
			expect(signature.length).toBe(64);

			const valid = await identity.verify(data, signature);
			expect(valid).toBe(true);
		});

		it("rejects modified data", async () => {
			const identity = await createIdentity();
			const data = new TextEncoder().encode("original");
			const signature = await identity.sign(data);

			const tampered = new TextEncoder().encode("tampered");
			const valid = await identity.verify(tampered, signature);
			expect(valid).toBe(false);
		});

		it("rejects corrupted signature", async () => {
			const identity = await createIdentity();
			const data = new TextEncoder().encode("hello");
			const signature = await identity.sign(data);

			const corrupted = new Uint8Array(signature);
			corrupted[0] = corrupted[0]! ^ 0xff;

			const valid = await identity.verify(data, corrupted);
			expect(valid).toBe(false);
		});

		it("signature from identity A cannot verify under identity B", async () => {
			const alice = await createIdentity();
			const bob = await createIdentity();
			const data = new TextEncoder().encode("secret message");

			const signature = await alice.sign(data);
			const valid = await bob.verify(data, signature);
			expect(valid).toBe(false);
		});

		it("handles empty data", async () => {
			const identity = await createIdentity();
			const data = new Uint8Array(0);

			const signature = await identity.sign(data);
			const valid = await identity.verify(data, signature);
			expect(valid).toBe(true);
		});

		it("handles large data (1 MB)", async () => {
			const identity = await createIdentity();
			const data = new Uint8Array(1024 * 1024);
			data.fill(0xab);

			const signature = await identity.sign(data);
			const valid = await identity.verify(data, signature);
			expect(valid).toBe(true);
		});
	});

	describe("encrypt and decrypt", () => {
		it("encrypts and decrypts with own key", async () => {
			const identity = await createIdentity();
			const plaintext = new TextEncoder().encode(
				"secret consciousness data",
			);

			const payload = await identity.encrypt(plaintext);
			expect(payload.ciphertext).toBeInstanceOf(Uint8Array);
			expect(payload.nonce).toBeInstanceOf(Uint8Array);
			expect(payload.ephemeralPubKey).toBeInstanceOf(Uint8Array);
			expect(payload.ciphertext.length).toBeGreaterThan(0);

			const decrypted = await identity.decrypt(payload);
			expect(decrypted).toEqual(plaintext);
		});

		it("encrypts for a different agent and they decrypt", async () => {
			const alice = await createIdentity();
			const bob = await createIdentity();

			const plaintext = new TextEncoder().encode("message for bob");

			// Alice encrypts for Bob using Bob's Ed25519 public key
			const payload = await alice.encrypt(plaintext, bob.publicKey);

			// Bob decrypts
			const decrypted = await bob.decrypt(payload);
			expect(decrypted).toEqual(plaintext);
		});

		it("sender cannot decrypt message intended for another", async () => {
			const alice = await createIdentity();
			const bob = await createIdentity();

			const plaintext = new TextEncoder().encode("for bob only");
			const payload = await alice.encrypt(plaintext, bob.publicKey);

			// Alice cannot decrypt what she encrypted for Bob
			await expect(alice.decrypt(payload)).rejects.toThrow(
				"Decryption failed",
			);
		});

		it("third party cannot decrypt", async () => {
			const alice = await createIdentity();
			const bob = await createIdentity();
			const eve = await createIdentity();

			const plaintext = new TextEncoder().encode("private data");
			const payload = await alice.encrypt(plaintext, bob.publicKey);

			await expect(eve.decrypt(payload)).rejects.toThrow(
				"Decryption failed",
			);
		});

		it("rejects missing ephemeralPubKey", async () => {
			const identity = await createIdentity();
			const payload: EncryptedPayload = {
				ciphertext: new Uint8Array(32),
				nonce: new Uint8Array(24),
			};

			await expect(identity.decrypt(payload)).rejects.toThrow(
				"ephemeralPubKey",
			);
		});

		it("rejects tampered ciphertext", async () => {
			const identity = await createIdentity();
			const plaintext = new TextEncoder().encode("secret");
			const payload = await identity.encrypt(plaintext);

			payload.ciphertext[0] = payload.ciphertext[0]! ^ 0xff;

			await expect(identity.decrypt(payload)).rejects.toThrow(
				"Decryption failed",
			);
		});

		it("handles empty data", async () => {
			const identity = await createIdentity();
			const plaintext = new Uint8Array(0);

			const payload = await identity.encrypt(plaintext);
			const decrypted = await identity.decrypt(payload);
			expect(decrypted).toEqual(plaintext);
		});

		it("produces different ciphertext each time (ephemeral key)", async () => {
			const identity = await createIdentity();
			const plaintext = new TextEncoder().encode("same data");

			const p1 = await identity.encrypt(plaintext);
			const p2 = await identity.encrypt(plaintext);

			expect(p1.ephemeralPubKey).not.toEqual(p2.ephemeralPubKey);
			expect(p1.ciphertext).not.toEqual(p2.ciphertext);
		});
	});

	describe("rotateKeys", () => {
		it("produces a new identity with different keys", async () => {
			const original = await createIdentity();
			const { newIdentity, migrationProof } =
				await original.rotateKeys();

			expect(newIdentity.publicKey).not.toEqual(original.publicKey);
			expect(newIdentity.did).not.toBe(original.did);
			expect(newIdentity.peerId).not.toBe(original.peerId);
			expect(migrationProof.length).toBe(192);
		});

		it("migration proof is verifiable", async () => {
			const original = await createIdentity();
			const { newIdentity, migrationProof } =
				await original.rotateKeys();

			const { oldPublicKey, newPublicKey } =
				verifyMigrationProof(migrationProof);

			expect(oldPublicKey).toEqual(original.publicKey);
			expect(newPublicKey).toEqual(newIdentity.publicKey);
		});

		it("new identity can sign and verify", async () => {
			const original = await createIdentity();
			const { newIdentity } = await original.rotateKeys();

			const data = new TextEncoder().encode("after rotation");
			const sig = await newIdentity.sign(data);
			expect(await newIdentity.verify(data, sig)).toBe(true);
		});

		it("new identity can encrypt and decrypt", async () => {
			const original = await createIdentity();
			const { newIdentity } = await original.rotateKeys();

			const plaintext = new TextEncoder().encode("after rotation");
			const payload = await newIdentity.encrypt(plaintext);
			const decrypted = await newIdentity.decrypt(payload);
			expect(decrypted).toEqual(plaintext);
		});

		it("rejects tampered migration proof", () => {
			const proof = new Uint8Array(192);
			proof.fill(0x42);

			expect(() => verifyMigrationProof(proof)).toThrow(
				"Invalid migration proof",
			);
		});

		it("rejects wrong-length migration proof", () => {
			expect(() => verifyMigrationProof(new Uint8Array(100))).toThrow(
				"192 bytes",
			);
		});
	});

	describe("export and loadIdentity", () => {
		it("exports and re-imports with correct passphrase", async () => {
			const original = await createIdentity();
			const passphrase = "my-secure-passphrase-2024";

			const bundle = await original.export(passphrase);
			expect(bundle.encrypted).toBeInstanceOf(Uint8Array);
			expect(bundle.nonce).toBeInstanceOf(Uint8Array);
			expect(bundle.salt).toBeInstanceOf(Uint8Array);

			const restored = await loadIdentity(bundle, passphrase);

			expect(restored.publicKey).toEqual(original.publicKey);
			expect(restored.did).toBe(original.did);
			expect(restored.peerId).toBe(original.peerId);

			// Verify restored identity can sign and original can verify
			const data = new TextEncoder().encode("test after restore");
			const sig = await restored.sign(data);
			expect(await original.verify(data, sig)).toBe(true);
		});

		it("fails with wrong passphrase", async () => {
			const identity = await createIdentity();
			const bundle = await identity.export("correct-password");

			await expect(
				loadIdentity(bundle, "wrong-password"),
			).rejects.toThrow("wrong passphrase");
		});

		it("different passphrases produce different bundles", async () => {
			const identity = await createIdentity();
			const b1 = await identity.export("pass1");
			const b2 = await identity.export("pass2");

			expect(b1.encrypted).not.toEqual(b2.encrypted);
			expect(b1.salt).not.toEqual(b2.salt);
		});
	});

	describe("toJSON", () => {
		it("serializes identity to JSON with correct fields", async () => {
			const identity = await createIdentity();
			const json = identity.toJSON();

			expect(json.peerId).toBe(identity.peerId);
			expect(json.did).toBe(identity.did);
			expect(typeof json.publicKey).toBe("string");
			expect(typeof json.encryptionPublicKey).toBe("string");

			// Hex strings should be 64 chars (32 bytes)
			expect(json.publicKey.length).toBe(64);
			expect(json.encryptionPublicKey.length).toBe(64);
		});

		it("is fully JSON-serializable (no Uint8Array in output)", async () => {
			const identity = await createIdentity();
			const json = identity.toJSON();

			const stringified = JSON.stringify(json);
			const parsed = JSON.parse(stringified) as Record<string, unknown>;

			expect(parsed["peerId"]).toBe(json.peerId);
			expect(parsed["did"]).toBe(json.did);
			expect(parsed["publicKey"]).toBe(json.publicKey);
			expect(parsed["encryptionPublicKey"]).toBe(
				json.encryptionPublicKey,
			);
		});

		it("is deterministic for the same seed", async () => {
			const seed = new Uint8Array(32).fill(99);
			const id1 = await createIdentity({ seed });
			const id2 = await createIdentity({ seed });

			expect(JSON.stringify(id1.toJSON())).toBe(
				JSON.stringify(id2.toJSON()),
			);
		});
	});

	describe("DID format", () => {
		it("produces did:key:z6Mk prefix for Ed25519 keys", async () => {
			const identity = await createIdentity();
			expect(identity.did).toMatch(/^did:key:z6Mk/);
		});

		it("is deterministic for the same key", async () => {
			const seed = new Uint8Array(32).fill(1);
			const id1 = await createIdentity({ seed });
			const id2 = await createIdentity({ seed });
			expect(id1.did).toBe(id2.did);
		});
	});

	describe("PeerId", () => {
		it("is deterministic for the same key", async () => {
			const seed = new Uint8Array(32).fill(7);
			const id1 = await createIdentity({ seed });
			const id2 = await createIdentity({ seed });
			expect(id1.peerId).toBe(id2.peerId);
		});

		it("is different for different keys", async () => {
			const id1 = await createIdentity();
			const id2 = await createIdentity();
			expect(id1.peerId).not.toBe(id2.peerId);
		});
	});

	describe("crypto utilities", () => {
		describe("base58btc", () => {
			it("round-trips arbitrary bytes", () => {
				const data = new Uint8Array([
					0, 0, 1, 2, 3, 255, 128, 64,
				]);
				const encoded = base58btcEncode(data);
				const decoded = base58btcDecode(encoded);
				expect(decoded).toEqual(data);
			});

			it("encodes all-zero bytes as leading 1s", () => {
				const data = new Uint8Array([0, 0, 0]);
				const encoded = base58btcEncode(data);
				expect(encoded).toBe("111");
				const decoded = base58btcDecode(encoded);
				expect(decoded).toEqual(data);
			});

			it("handles single zero byte", () => {
				const encoded = base58btcEncode(new Uint8Array([0]));
				expect(encoded).toBe("1");
			});

			it("handles empty string decode", () => {
				const decoded = base58btcDecode("");
				expect(decoded).toEqual(new Uint8Array(0));
			});

			it("throws on invalid base58 character", () => {
				expect(() => base58btcDecode("0OIl")).toThrow(
					"Invalid base58",
				);
			});

			it("round-trips a 32-byte key", () => {
				const key = new Uint8Array(32);
				key.fill(0xab);
				const decoded = base58btcDecode(base58btcEncode(key));
				expect(decoded).toEqual(key);
			});
		});

		describe("hex utilities", () => {
			it("bytesToHex produces correct hex string", () => {
				const bytes = new Uint8Array([0, 1, 15, 16, 255]);
				expect(bytesToHex(bytes)).toBe("00010f10ff");
			});

			it("hexToBytes reverses bytesToHex", () => {
				const original = new Uint8Array([10, 20, 30, 40, 50]);
				const hex = bytesToHex(original);
				expect(hexToBytes(hex)).toEqual(original);
			});
		});

		describe("edwardsToMontgomeryPub", () => {
			it("rejects wrong-length input", () => {
				expect(() =>
					edwardsToMontgomeryPub(new Uint8Array(16)),
				).toThrow("32 bytes");
			});

			it("produces a 32-byte X25519 public key", async () => {
				const id = await createIdentity();
				const x25519Pub = edwardsToMontgomeryPub(id.publicKey);
				expect(x25519Pub).toBeInstanceOf(Uint8Array);
				expect(x25519Pub.length).toBe(32);
			});

			it("is deterministic", async () => {
				const id = await createIdentity();
				const a = edwardsToMontgomeryPub(id.publicKey);
				const b = edwardsToMontgomeryPub(id.publicKey);
				expect(a).toEqual(b);
			});
		});

		describe("edwardsToMontgomeryPriv", () => {
			it("rejects wrong-length input", () => {
				expect(() =>
					edwardsToMontgomeryPriv(new Uint8Array(16)),
				).toThrow("32 bytes");
			});

			it("produces a clamped 32-byte key", () => {
				const seed = new Uint8Array(32).fill(0x42);
				const priv = edwardsToMontgomeryPriv(seed);
				expect(priv.length).toBe(32);
				// Check clamping: low 3 bits of first byte are 0
				expect(priv[0]! & 7).toBe(0);
				// High bit of last byte is 0, second highest is 1
				expect(priv[31]! & 128).toBe(0);
				expect(priv[31]! & 64).toBe(64);
			});
		});

		describe("createDid", () => {
			it("produces did:key:z prefix", () => {
				const pubKey = new Uint8Array(32).fill(0x01);
				const did = createDid(pubKey);
				expect(did).toMatch(/^did:key:z/);
			});
		});

		describe("createPeerId", () => {
			it("produces a non-empty string", () => {
				const pubKey = new Uint8Array(32).fill(0x01);
				const peerId = createPeerId(pubKey);
				expect(peerId.length).toBeGreaterThan(0);
			});
		});
	});
});
