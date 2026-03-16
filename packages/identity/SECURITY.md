# Security: @ensoul/identity

## Threat Model

The identity module is the cryptographic foundation for all agent operations. It manages Ed25519 signing keys and X25519 encryption keys derived from a single 32-byte seed. Compromise of the seed grants full impersonation and decryption capability for that agent.

**Trust boundary:** The identity module trusts the local runtime environment (memory, filesystem). It does NOT trust network peers, other agents, or stored ciphertext integrity.

**Assets protected:**
- Ed25519 private seed (signing authority)
- X25519 derived keys (decryption capability)
- Exported key bundles (passphrase-protected backups)

## Attack Vectors & Mitigations

### Key Compromise
**Vector:** Attacker obtains the 32-byte seed from memory, disk, or a weak export passphrase.
**Mitigation:** Seeds are never exposed via public API. Exported bundles use scrypt (N=32768, r=8, p=1) key derivation, making brute-force of weak passphrases expensive. The `rotateKeys()` function produces a migration proof so compromised identities can be revoked.
**Residual risk:** If an attacker obtains the seed at runtime (e.g., memory dump), they can impersonate the agent. Network-stored data remains encrypted ciphertext, so key compromise only affects future operations and locally-cached state.

### Identity Spoofing
**Vector:** A malicious node or agent claims to be a different agent.
**Mitigation:** All operations (state transitions, attestations) require Ed25519 signatures verifiable against the agent's public key. The DID:key and PeerId are deterministically derived from the public key, preventing forgery.

### Encryption Oracle Attacks
**Vector:** Attacker manipulates ciphertext, nonce, or ephemeral public key to extract information.
**Mitigation:** NaCl box (XSalsa20-Poly1305) is an AEAD construction. Any modification to ciphertext, nonce, or keys causes decryption to fail with an authentication error. No partial decryption is possible.

### Key Rotation Forgery
**Vector:** Attacker creates a fake migration proof to redirect an identity.
**Mitigation:** Migration proofs contain signatures from BOTH old and new keys over the concatenated public keys. Verification requires both signatures to be valid. An attacker without the old private key cannot produce a valid proof.

### Passphrase Brute Force on Exported Bundles
**Vector:** Attacker obtains an encrypted key bundle and brute-forces the passphrase.
**Mitigation:** scrypt with N=32768, r=8, p=1 makes each attempt ~100ms on modern hardware. Combined with a 32-byte random salt per export, rainbow tables are ineffective. Users should choose strong passphrases.

### Side-Channel Attacks
**Vector:** Timing or cache attacks on cryptographic operations.
**Mitigation:** We use @noble/ed25519 and tweetnacl, both designed with constant-time operations. The Ed25519-to-X25519 public key conversion uses BigInt modular arithmetic which is NOT constant-time, but this operates only on public keys (no secret data).

## Invariants

These properties must ALWAYS hold:

1. **Signature isolation:** A signature produced by identity A MUST NEVER verify under identity B's public key.
2. **Encryption confidentiality:** Encrypted data can ONLY be decrypted by the intended recipient's private key.
3. **Key rotation linkage:** `rotateKeys()` MUST produce a valid cryptographic link (migration proof) between old and new identity, verifiable by any third party.
4. **Export integrity:** An exported key bundle with the wrong passphrase MUST fail entirely (no partial decryption).
5. **Deterministic derivation:** The same 32-byte seed MUST always produce the same publicKey, DID, PeerId, and X25519 keypair.
6. **Ephemeral uniqueness:** Each `encrypt()` call MUST use a fresh ephemeral keypair, producing distinct ciphertexts for identical plaintexts.

## Fuzz Targets

### sign()
- Random data: 0 bytes to 10 MB
- All-zero data, all-0xFF data
- Data with embedded null bytes

### verify()
- Corrupted signatures: flip random bits, truncate, extend
- Wrong public key with valid signature
- Signature from different message

### encrypt()
- Empty data, max-size data (10 MB)
- Malformed recipient public keys (wrong length, all zeros, low-order points)
- Self-encryption vs cross-agent encryption

### decrypt()
- Wrong private key
- Truncated ciphertext
- Corrupted nonces (wrong length, flipped bits)
- Missing or corrupted ephemeralPubKey
- Ciphertext from a different encryption

### loadIdentity()
- Truncated encrypted bundles
- Corrupted salt or nonce
- Every possible wrong passphrase
- Bundles with tampered encrypted field

## Cryptographic Primitives

All cryptography uses audited, battle-tested libraries:

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Signing | @noble/ed25519 v3 | Ed25519 (RFC 8032) |
| Encryption | tweetnacl | X25519 + XSalsa20-Poly1305 (NaCl box) |
| Key derivation | @noble/hashes | scrypt (RFC 7914) |
| Hashing | @noble/hashes | SHA-512 |
| Ed25519→X25519 | Manual (BigInt) | Edwards-to-Montgomery conversion |

**No custom cryptography is implemented.** The only manual computation is the standard Edwards-to-Montgomery point conversion formula `u = (1+y)/(1-y) mod p`, which operates exclusively on public data.
