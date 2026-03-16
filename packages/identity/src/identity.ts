import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import nacl from "tweetnacl";
import {
	edwardsToMontgomeryPub,
	edwardsToMontgomeryPriv,
	createDid,
	createPeerId,
	bytesToHex,
} from "./crypto.js";
import type {
	AgentIdentity,
	EncryptedPayload,
	EncryptedKeyBundle,
	SerializedIdentity,
} from "./types.js";

// Configure @noble/ed25519 v3 to use @noble/hashes for SHA-512
ed.hashes.sha512 = (message: Uint8Array) => sha512(message);

/** Scrypt parameters for passphrase-based key derivation */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

/**
 * Internal implementation of AgentIdentity.
 * Holds the Ed25519 seed and derived X25519 keys for encryption.
 */
class AgentIdentityImpl implements AgentIdentity {
	readonly peerId: string;
	readonly publicKey: Uint8Array;
	readonly did: string;

	private readonly seed: Uint8Array;
	private readonly x25519PublicKey: Uint8Array;
	private readonly x25519SecretKey: Uint8Array;

	constructor(seed: Uint8Array) {
		if (seed.length !== 32) {
			throw new Error("Seed must be 32 bytes");
		}
		this.seed = new Uint8Array(seed);
		this.publicKey = ed.getPublicKey(seed);
		this.did = createDid(this.publicKey);
		this.peerId = createPeerId(this.publicKey);

		// Derive X25519 keys for NaCl box encryption
		this.x25519SecretKey = edwardsToMontgomeryPriv(seed);
		this.x25519PublicKey = nacl.box.keyPair.fromSecretKey(
			this.x25519SecretKey,
		).publicKey;
	}

	/** Sign data with Ed25519 */
	async sign(data: Uint8Array): Promise<Uint8Array> {
		return ed.sign(data, this.seed);
	}

	/** Verify a signature against this identity's Ed25519 public key */
	async verify(
		data: Uint8Array,
		signature: Uint8Array,
	): Promise<boolean> {
		try {
			return ed.verify(signature, data, this.publicKey);
		} catch {
			return false;
		}
	}

	/** Encrypt data using NaCl box with an ephemeral keypair */
	async encrypt(
		data: Uint8Array,
		recipientPubKey?: Uint8Array,
	): Promise<EncryptedPayload> {
		const recipientX25519 = recipientPubKey
			? edwardsToMontgomeryPub(recipientPubKey)
			: this.x25519PublicKey;

		const ephemeral = nacl.box.keyPair();
		const nonce = nacl.randomBytes(nacl.box.nonceLength);
		const ciphertext = nacl.box(
			data,
			nonce,
			recipientX25519,
			ephemeral.secretKey,
		);

		return { ciphertext, nonce, ephemeralPubKey: ephemeral.publicKey };
	}

	/** Decrypt an EncryptedPayload using this identity's X25519 private key */
	async decrypt(payload: EncryptedPayload): Promise<Uint8Array> {
		if (!payload.ephemeralPubKey) {
			throw new Error("Missing ephemeralPubKey for decryption");
		}
		const plaintext = nacl.box.open(
			payload.ciphertext,
			payload.nonce,
			payload.ephemeralPubKey,
			this.x25519SecretKey,
		);

		if (!plaintext) {
			throw new Error(
				"Decryption failed: invalid ciphertext or wrong key",
			);
		}

		return plaintext;
	}

	/** Generate a new identity and produce a migration proof linking old to new */
	async rotateKeys(): Promise<{
		newIdentity: AgentIdentity;
		migrationProof: Uint8Array;
	}> {
		const newSeed = nacl.randomBytes(32);
		const newIdentity = new AgentIdentityImpl(newSeed);

		// Both identities sign the concatenation of old + new public keys
		const message = new Uint8Array(64);
		message.set(this.publicKey, 0);
		message.set(newIdentity.publicKey, 32);

		const oldSig = ed.sign(message, this.seed);
		const newSig = ed.sign(message, newSeed);

		// Proof format: oldPub(32) + newPub(32) + oldSig(64) + newSig(64) = 192 bytes
		const migrationProof = new Uint8Array(192);
		migrationProof.set(this.publicKey, 0);
		migrationProof.set(newIdentity.publicKey, 32);
		migrationProof.set(oldSig, 64);
		migrationProof.set(newSig, 128);

		return { newIdentity, migrationProof };
	}

	/** Export the identity encrypted with a passphrase-derived key */
	async export(passphrase: string): Promise<EncryptedKeyBundle> {
		const salt = nacl.randomBytes(32);
		const key = scrypt(
			new TextEncoder().encode(passphrase),
			salt,
			SCRYPT_PARAMS,
		);
		const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
		const encrypted = nacl.secretbox(this.seed, nonce, key);
		return { encrypted, nonce, salt };
	}

	/** Serialize public identity fields to JSON */
	toJSON(): SerializedIdentity {
		return {
			peerId: this.peerId,
			publicKey: bytesToHex(this.publicKey),
			did: this.did,
			encryptionPublicKey: bytesToHex(this.x25519PublicKey),
		};
	}
}

/**
 * Create a new agent identity.
 * @param opts.seed - Optional 32-byte seed for deterministic key generation
 */
export async function createIdentity(
	opts?: { seed?: Uint8Array },
): Promise<AgentIdentity> {
	const seed = opts?.seed ?? nacl.randomBytes(32);
	return new AgentIdentityImpl(seed);
}

/**
 * Load an agent identity from an encrypted key bundle.
 * @param bundle - The encrypted key bundle from a previous export
 * @param passphrase - The passphrase used during export
 * @throws If the passphrase is incorrect
 */
export async function loadIdentity(
	bundle: EncryptedKeyBundle,
	passphrase: string,
): Promise<AgentIdentity> {
	const key = scrypt(
		new TextEncoder().encode(passphrase),
		bundle.salt,
		SCRYPT_PARAMS,
	);
	const seed = nacl.secretbox.open(bundle.encrypted, bundle.nonce, key);

	if (!seed) {
		throw new Error("Failed to decrypt key bundle: wrong passphrase");
	}

	return new AgentIdentityImpl(seed);
}

/**
 * Verify a migration proof linking an old identity to a new one.
 * @param proof - 192-byte migration proof from rotateKeys()
 * @returns The old and new public keys if valid
 * @throws If the proof is invalid
 */
export function verifyMigrationProof(proof: Uint8Array): {
	oldPublicKey: Uint8Array;
	newPublicKey: Uint8Array;
} {
	if (proof.length !== 192) {
		throw new Error("Migration proof must be 192 bytes");
	}

	const oldPublicKey = proof.slice(0, 32);
	const newPublicKey = proof.slice(32, 64);
	const oldSig = proof.slice(64, 128);
	const newSig = proof.slice(128, 192);

	const message = new Uint8Array(64);
	message.set(oldPublicKey, 0);
	message.set(newPublicKey, 32);

	if (!ed.verify(oldSig, message, oldPublicKey)) {
		throw new Error(
			"Invalid migration proof: old identity signature failed",
		);
	}

	if (!ed.verify(newSig, message, newPublicKey)) {
		throw new Error(
			"Invalid migration proof: new identity signature failed",
		);
	}

	return { oldPublicKey, newPublicKey };
}
