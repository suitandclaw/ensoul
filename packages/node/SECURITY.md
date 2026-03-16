# Security: @ensoul/node — Storage Engine

## Threat Model

The storage engine is the persistence layer on each node in the Ensoul network. It accepts encrypted shards from agents, stores them in LevelDB, and serves them back on request. Since nodes store data they cannot read (agent-owned encryption), the primary threats are data integrity attacks, storage exhaustion, and data withholding.

**Trust boundary:** The storage engine trusts the local filesystem and LevelDB. It does NOT trust the data content (shards are opaque encrypted blobs). It does NOT trust callers to provide correct hashes — hashes are computed and verified internally.

**Assets protected:**
- Shard data integrity (Blake3 hash verification)
- Storage capacity (max limit enforcement)
- Per-agent storage accounting (accurate tracking)

## Attack Vectors & Mitigations

### Data Corruption
**Vector:** Hardware failure, software bug, or malicious tampering corrupts stored shard data.
**Mitigation:** Every shard is Blake3-hashed on store. On every retrieval, the hash is recomputed and verified against the stored metadata. Corrupted shards are detected immediately and an error is thrown rather than serving bad data.

### Storage Exhaustion
**Vector:** Malicious agents flood the node with shards to consume all disk space, denying service to legitimate agents.
**Mitigation:** The `maxStorageBytes` configuration enforces a hard cap on total storage. Store requests that would exceed the limit are rejected. Per-agent storage tracking enables future rate-limiting and quota enforcement.

### Data Withholding
**Vector:** A node accepts a shard and signs an attestation, then silently deletes the data.
**Mitigation:** The proof-of-storage challenge module (separate submodule) periodically verifies that nodes still hold the shards they claim. The storage engine supports `has()` and `retrieve()` for challenge response. Failed challenges result in slashing.

### Shard Key Collision
**Vector:** An attacker crafts a store request that overwrites another agent's shard by using the same (agentDid, version, shardIndex) key.
**Mitigation:** Store requests include the agentDid which must match the authenticated caller's identity (enforced at the network layer above the storage engine). The storage engine itself uses composite keys with proper separation.

### TTL Bypass
**Vector:** Attacker stores a shard with no TTL to bypass working-memory expiration policies.
**Mitigation:** TTL enforcement is the caller's responsibility at the protocol layer. The storage engine faithfully applies TTLs when provided and cleans expired shards via `cleanExpired()`. Nodes should enforce minimum TTLs for working-memory tier shards at the API layer.

### Metadata Tampering
**Vector:** Attacker modifies stored metadata (hash, size) to make a corrupted shard appear valid.
**Mitigation:** Metadata is stored alongside data in the same LevelDB instance. If an attacker has write access to LevelDB, they could tamper with both data and metadata — but this requires local filesystem access, which is outside our trust boundary. For network-level integrity, the challenge module verifies shards against agent-provided hashes.

## Invariants

1. **Hash integrity:** A shard's Blake3 hash MUST be computed on store and verified on every retrieve. A mismatch MUST throw an error — never serve corrupted data.
2. **Storage accounting accuracy:** `getStats().totalBytes` MUST equal the sum of all stored shard sizes at all times. Overwrites and deletes MUST correctly update the accounting.
3. **Limit enforcement:** If `maxStorageBytes > 0`, a store that would cause `totalBytes > maxStorageBytes` MUST be rejected before writing any data.
4. **TTL enforcement:** A shard with `expiresAt < Date.now()` MUST NOT be served by `retrieve()` or reported by `has()`.
5. **Key isolation:** Shards for different (agentDid, version, shardIndex) tuples MUST be stored and retrieved independently. No cross-contamination.
6. **Overwrite correctness:** Storing a shard at an existing key MUST replace the old data and metadata, and MUST update storage accounting to reflect the new size (not the old + new).

## Fuzz Targets

### store()
- Data: 1 byte to 10MB, all-zero, all-0xFF, random
- agentDid: empty string, very long strings, special characters, unicode
- version/shardIndex: 0, negative, MAX_SAFE_INTEGER
- ttlMs: 0, 1, negative, very large
- Concurrent stores to the same key

### retrieve()
- Corrupted data in LevelDB (bit flips, truncation, extension)
- Missing data key with valid metadata
- Missing metadata with valid data key
- Expired shards at boundary (expiresAt == Date.now())

### cleanExpired()
- Mix of expired and non-expired shards
- All expired, none expired
- Concurrent cleanup with store/retrieve

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Shard hashing | @noble/hashes | Blake3 |
| Storage | classic-level / memory-level | LevelDB |

**No custom cryptography is implemented.** The only cryptographic operation is Blake3 hashing via @noble/hashes for integrity verification.
