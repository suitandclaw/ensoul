# Security: @ensoul/node

## Threat Model

The @ensoul/node package contains the storage engine and consensus module for Ensoul network nodes. Nodes store encrypted shards for agents and participate in attestation-based consensus to confirm storage. The primary threats are data integrity attacks, storage exhaustion, consensus manipulation, and attestation forgery.

**Trust boundary:** The node trusts the local filesystem, LevelDB, and the cryptographic libraries (@noble/ed25519, @noble/hashes). It does NOT trust shard content (encrypted blobs), network peers, or callers to provide correct hashes or valid attestations — all are verified.

**Assets protected:**
- Shard data integrity (Blake3 hash verification)
- Storage capacity (max limit enforcement)
- Attestation authenticity (Ed25519 signature verification)
- Consensus integrity (threshold enforcement, deduplication)

---

## Storage Engine

### Attack Vectors & Mitigations

**Data Corruption:** Hardware failure or tampering corrupts stored shard data.
*Mitigation:* Every shard is Blake3-hashed on store. On every retrieval, the hash is recomputed and verified. Corrupted shards throw immediately — never served.

**Storage Exhaustion:** Malicious agents flood the node to consume all disk space.
*Mitigation:* `maxStorageBytes` enforces a hard cap. Store requests exceeding the limit are rejected. Per-agent tracking enables future quota enforcement.

**Data Withholding:** Node accepts shard, signs attestation, then deletes data.
*Mitigation:* Proof-of-storage challenges (challenge module) periodically verify holdings. Failed challenges result in slashing.

**Shard Key Collision:** Attacker overwrites another agent's shard using the same composite key.
*Mitigation:* The (agentDid, version, shardIndex) key includes the agent's DID. Network layer must authenticate the caller's identity matches the agentDid.

**TTL Bypass:** Attacker stores without TTL to avoid working-memory expiration.
*Mitigation:* TTL enforcement is applied faithfully when provided. Protocol layer should enforce minimum TTLs for working-memory tier.

**Metadata Tampering:** Attacker modifies stored metadata to mask corruption.
*Mitigation:* Requires local filesystem access (outside trust boundary). Challenge module verifies against agent-provided hashes for network-level integrity.

### Storage Invariants

1. **Hash integrity:** Blake3 hash computed on store, verified on every retrieve. Mismatch throws.
2. **Accounting accuracy:** `totalBytes` always equals sum of stored shard sizes. Overwrites and deletes correctly update accounting.
3. **Limit enforcement:** If `maxStorageBytes > 0`, stores exceeding the limit are rejected before writing.
4. **TTL enforcement:** Expired shards are never served or reported as existing.
5. **Key isolation:** Different (agentDid, version, shardIndex) tuples are fully independent.
6. **Overwrite correctness:** Overwrites replace data and update accounting to new size only.

---

## Consensus Module

### Attack Vectors & Mitigations

**Attestation Forgery:** Attacker creates a fake attestation claiming a validator signed it.
*Mitigation:* Every attestation is Ed25519-signed. Verification checks the signature against the registered validator's public key. Without the private key, forging a valid signature is computationally infeasible.

**Consensus Manipulation (Sybil):** Attacker registers many fake validators to dominate threshold.
*Mitigation:* Validators must have staked tokens (enforced by `minStake`). Creating validators has real economic cost. The protocol requires K-of-N attestations from *registered* validators only.

**Replay Attack:** Attacker replays valid attestations from a previous version/state.
*Mitigation:* Attestations include agentDid, stateRoot, version, and timestamp. Threshold checking requires all attestations to match the expected agentDid, stateRoot, and version. Old attestations for different versions are rejected.

**Double-Counting:** Same validator submits multiple attestations for the same request.
*Mitigation:* Threshold checking deduplicates by validatorDid. Multiple attestations from the same validator count as one.

**Validator Removal After Attestation:** Validator signs attestation then is removed before threshold check.
*Mitigation:* Attestation verification checks current validator set. A removed validator's attestations are rejected. This is by design — the current validator set is authoritative.

**Impersonation:** Attacker claims attestation is from validator B but signature is from validator A.
*Mitigation:* The validatorDid is part of the signed payload. Verification reconstructs the payload with the claimed validatorDid and verifies against that validator's public key. A mismatched validatorDid produces a different message, so the signature fails.

### Consensus Invariants

1. **Signature authenticity:** An attestation's signature MUST verify against the claimed validator's registered public key. Any tampering to any field (agentDid, stateRoot, version, timestamp, validatorDid) MUST cause verification to fail.
2. **Validator registration:** Only registered validators with sufficient stake can create attestations. Unregistered identities are rejected.
3. **Threshold correctness:** `checkThreshold` returns `met: true` ONLY when at least K unique, valid, matching attestations are collected. Duplicates from the same validator count once.
4. **Payload determinism:** The same attestation fields MUST always produce the same signed message bytes. Non-deterministic encoding would allow signature bypass.
5. **Set consistency:** Validator set changes (add/remove) take immediate effect. Attestations from removed validators fail verification.

---

## Fuzz Targets

### Storage Engine
- store(): data sizes 1B–10MB, special characters in agentDid, boundary version/shardIndex values
- retrieve(): corrupted LevelDB data (bit flips, truncation), missing keys
- cleanExpired(): mix of expired/non-expired, boundary timestamps

### Consensus Module
- registerValidator(): invalid key lengths, zero/negative stakes, duplicate DIDs
- verifyAttestation(): corrupted signatures (bit flips), swapped validatorDids, tampered fields
- checkThreshold(): empty lists, all-invalid, mix of valid/invalid/duplicate/wrong-version

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Shard hashing | @noble/hashes | Blake3 |
| Attestation signing | @noble/ed25519 | Ed25519 (RFC 8032) |
| Attestation verification | @noble/ed25519 | Ed25519 (RFC 8032) |
| Storage | classic-level / memory-level | LevelDB |

**No custom cryptography is implemented.** All hashing uses Blake3. All signing/verification uses Ed25519. Both from audited @noble libraries.
