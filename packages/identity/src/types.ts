/**
 * Encrypted data payload produced by asymmetric encryption.
 * Uses X25519 + XSalsa20-Poly1305 (NaCl box) with an ephemeral keypair.
 */
export interface EncryptedPayload {
	/** Encrypted ciphertext (XSalsa20-Poly1305) */
	ciphertext: Uint8Array;
	/** 24-byte nonce */
	nonce: Uint8Array;
	/** Ephemeral X25519 public key used for the key exchange */
	ephemeralPubKey?: Uint8Array;
}

/**
 * Encrypted key bundle for backing up and restoring an identity.
 * Uses scrypt-derived key + NaCl secretbox.
 */
export interface EncryptedKeyBundle {
	/** Encrypted seed (NaCl secretbox) */
	encrypted: Uint8Array;
	/** 24-byte nonce for secretbox */
	nonce: Uint8Array;
	/** 32-byte salt for scrypt key derivation */
	salt: Uint8Array;
}

/**
 * JSON-serializable representation of an agent's public identity.
 */
export interface SerializedIdentity {
	/** libp2p-compatible peer ID */
	peerId: string;
	/** Hex-encoded Ed25519 public key */
	publicKey: string;
	/** DID:key identifier (did:key:z6Mk...) */
	did: string;
	/** Hex-encoded X25519 public key for encryption */
	encryptionPublicKey: string;
}

/**
 * A cryptographic agent identity providing signing, verification,
 * encryption, decryption, key rotation, and serialization.
 */
export interface AgentIdentity {
	/** libp2p-compatible peer ID derived from public key */
	readonly peerId: string;
	/** Ed25519 public key (32 bytes) */
	readonly publicKey: Uint8Array;
	/** DID:key identifier (did:key:z6Mk...) */
	readonly did: string;

	/** Sign data with this identity's Ed25519 private key */
	sign(data: Uint8Array): Promise<Uint8Array>;
	/** Verify a signature against this identity's Ed25519 public key */
	verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
	/** Encrypt data. If recipientPubKey (Ed25519) is provided, encrypts for that recipient. Otherwise encrypts to self. */
	encrypt(
		data: Uint8Array,
		recipientPubKey?: Uint8Array,
	): Promise<EncryptedPayload>;
	/** Decrypt an EncryptedPayload using this identity's X25519 private key */
	decrypt(payload: EncryptedPayload): Promise<Uint8Array>;
	/** Generate a new identity and cryptographic proof linking old to new */
	rotateKeys(): Promise<{
		newIdentity: AgentIdentity;
		migrationProof: Uint8Array;
	}>;
	/** Export the identity as an encrypted bundle protected by a passphrase */
	export(passphrase: string): Promise<EncryptedKeyBundle>;
	/** Serialize the public identity fields to JSON */
	toJSON(): SerializedIdentity;
}
