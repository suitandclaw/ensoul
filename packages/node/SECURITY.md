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

---

## Challenge Module (Proof-of-Storage)

### Attack Vectors & Mitigations

**Precomputed Responses:** Node precomputes hashes for all possible byte ranges to fake proof-of-storage without actually holding the data.
*Mitigation:* Challenges use cryptographically random offsets and lengths from a large range. With shards of even moderate size (1KB+), the number of possible (offset, length) pairs is enormous — precomputation is infeasible. Challenges have deadlines to prevent slow computation.

**Response Replay:** Node replays a response from a previous challenge.
*Mitigation:* Each challenge has a unique random ID. The response must reference the correct challenge ID. Challenge IDs are 128-bit random values — collision is infeasible.

**Deadline Manipulation:** Node responds correctly but claims an earlier timestamp to bypass deadline.
*Mitigation:* The `respondedAt` timestamp is checked against the challenge `deadline`. In production, the network layer should use its own clock for received-at timestamps rather than trusting the responder's claimed timestamp.

**Reputation Gaming:** Node selectively drops challenges for low-value shards while passing high-value ones.
*Mitigation:* The reputation tracker treats all challenges equally. Score uses an exponential penalty (each failure multiplied by 0.85 factor) that makes selective dropping costly. Persistent low scores lead to slashing.

**Shard Substitution:** Node holds a different shard but passes challenges by having a copy of the expected data.
*Mitigation:* Challenges are generated from metadata (agentDid, version, shardIndex, shardSize). The verifier holds the actual shard data and independently computes the expected hash. If the node substituted data, the hash would not match.

### Challenge Invariants

1. **Range validity:** Generated challenges MUST have `offset + length <= shardSize`. The challenged byte range is always within bounds.
2. **Hash correctness:** `respondToChallenge` MUST return `blake3(shard[offset..offset+length])`. No other hash function or byte range.
3. **Verification soundness:** `verifyResponse` returns `valid: true` ONLY when the response hash matches blake3 of the actual byte range in the verifier's copy. Any discrepancy (wrong hash, wrong challenge ID, past deadline) returns `valid: false`.
4. **Reputation monotonic decay:** Each failed challenge MUST reduce the node's reputation score. Score can never increase above 1.0 or decrease below 0.0.
5. **Unique challenge IDs:** Each challenge MUST have a 128-bit random ID. Duplicate IDs across challenges must be astronomically unlikely.

### Challenge Fuzz Targets
- generateChallenge(): shard sizes 1B–10MB, boundary offsets, maxChallengeLength variations
- respondToChallenge(): corrupted shard data, truncated shards, offset at exact end
- verifyResponse(): wrong hashes, expired deadlines, mismatched IDs, manipulated timestamps

---

## API Server

### Attack Vectors & Mitigations

**Request Flooding (DoS):** Attacker sends massive numbers of requests to overwhelm the node.
*Mitigation:* Fastify @fastify/rate-limit enforces configurable per-IP rate limits (default 100 req/min). Fastify's native performance (high throughput, low overhead) provides additional resilience.

**Unauthorized Shard Storage:** Attacker stores shards with forged agentDid to consume storage.
*Mitigation:* The storage engine enforces `maxStorageBytes` limits. The API validates required fields. In production, request signatures should be verified against the claimed agentDid (not yet enforced at API level — planned for network integration).

**Invalid Attestation Injection:** Attacker submits fake attestations to manipulate consensus.
*Mitigation:* The API verifies the validatorDid is registered in the consensus module. Unknown validators are rejected with 403. Full signature verification happens during threshold checking.

**Challenge Response Manipulation:** Attacker submits wrong hashes to pass challenges.
*Mitigation:* The API retrieves the actual shard from storage and independently computes the expected Blake3 hash. Wrong hashes are detected and the response is marked as failed.

### API Invariants

1. **Input validation:** All endpoints MUST validate required fields and return 400 for missing/invalid input.
2. **Rate limiting:** All endpoints MUST be rate-limited to prevent DoS.
3. **Validator gating:** POST /attestations MUST reject attestations from unregistered validators (403).
4. **Integrity on retrieval:** GET /shards MUST verify shard integrity (via storage engine Blake3 check) before serving.
5. **Credit atomicity:** Credits awarded for passing challenges MUST be recorded atomically with the challenge result.

### API Fuzz Targets
- All POST endpoints with missing fields, wrong types, oversized payloads
- Path params with special characters, URL encoding, negative numbers
- Rate limit boundary testing (exactly at limit, one over)
- Concurrent requests to same endpoint

---

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Shard hashing | @noble/hashes | Blake3 |
| Challenge hashing | @noble/hashes | Blake3 |
| Challenge ID generation | @noble/hashes | CSPRNG (randomBytes) |
| Attestation signing | @noble/ed25519 | Ed25519 (RFC 8032) |
| Attestation verification | @noble/ed25519 | Ed25519 (RFC 8032) |
| Storage | classic-level / memory-level | LevelDB |
| HTTP server | Fastify | Rate-limited REST |

**No custom cryptography is implemented.** All hashing uses Blake3. All signing/verification uses Ed25519. Random values use the OS CSPRNG via @noble/hashes. All from audited @noble libraries.
