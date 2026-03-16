# Security: @ensoul/state-tree

## Threat Model

The state tree is the Merklized key-value store representing an agent's consciousness. It is the single source of truth for all agent state and the foundation for network persistence. Integrity of the Merkle root and state transition signatures is critical — if either can be forged, an attacker can rewrite agent memory.

**Trust boundary:** The tree trusts the local runtime environment and the `AgentIdentity` passed at construction. It does NOT trust serialized data from the network or other agents. All deserialized data must pass verification.

**Assets protected:**
- Merkle root integrity (tamper-evident state)
- State transition history (signed, hash-chained audit log)
- Key-value entries (agent consciousness data)

## Attack Vectors & Mitigations

### State Rollback Attack
**Vector:** Attacker serves an older version's state as "latest," causing the agent to lose recent memories.
**Mitigation:** Each state transition records its version number and the previous root hash, forming a hash chain. The agent tracks its own latest version locally. Any rollback attempt is detectable by comparing version numbers and the hash chain.

### Proof Forgery
**Vector:** Attacker constructs a Merkle proof for data that does not exist in the tree.
**Mitigation:** Merkle proofs are verified against the root hash using Blake3. The proof must reconstruct the exact root hash by hashing from the leaf through all sibling nodes. Forging a proof requires finding a Blake3 preimage or collision, which is computationally infeasible.

### History Rewrite
**Vector:** Attacker modifies a past state transition to alter history.
**Mitigation:** Every state transition is signed by the agent's Ed25519 identity key. The signature covers the version, root hash, previous root hash, timestamp, and operations. Modifying any field invalidates the signature. Additionally, transitions form a hash chain: each transition's `previousRootHash` must match the prior transition's `rootHash`.

### Serialization Tampering
**Vector:** Attacker modifies a serialized tree blob before it reaches the agent.
**Mitigation:** Loaded trees can be verified by: (1) recomputing the Merkle root from entries and checking it matches; (2) verifying all transition signatures against the agent's public key; (3) verifying the hash chain of transitions. The `loadTree` function should be followed by verification in production.

### Key-Value Collision
**Vector:** Two different keys produce the same leaf hash, allowing one entry to masquerade as another.
**Mitigation:** Leaf hashes use length-prefixed key encoding: `blake3(uint32BE(keyLen) || keyBytes || valueBytes)`. The length prefix prevents ambiguity between key and value boundaries. Blake3's collision resistance (128-bit security level) makes finding collisions computationally infeasible.

### LevelDB Data Corruption
**Vector:** Local LevelDB data becomes corrupted (hardware failure, crash during write).
**Mitigation:** LevelDB provides crash-safe writes via its write-ahead log. The tree's in-memory state is the authoritative copy during operation; LevelDB is a persistence mirror. If LevelDB data is corrupted, the tree can be rebuilt from a serialized network copy.

## Invariants

These properties must ALWAYS hold:

1. **Root hash determinism:** The same set of key-value entries MUST always produce the same Merkle root hash, regardless of insertion order.
2. **Root hash changes on mutation:** Any `set` or `delete` of a key that changes the entry set MUST produce a different root hash.
3. **Merkle proof soundness:** A valid `verifyProof` result means the key-value pair IS in the tree with the given root hash. No false positives.
4. **Version monotonicity:** Version N+1's `previousRootHash` MUST equal version N's `rootHash`. No gaps in the hash chain.
5. **Signature coverage:** Every state transition MUST be signed by the agent identity key. The signature covers version, rootHash, previousRootHash, timestamp, and operations.
6. **Version isolation:** `getVersion(N)` MUST return the exact state at version N. Changes to the current tree MUST NOT affect historical snapshots.
7. **Serialization fidelity:** `loadTree(await tree.serialize())` MUST produce a tree with identical entries, root hash, version, and transition history.

## Fuzz Targets

### set() / delete() / batch()
- Keys: empty string, max-length strings, unicode, special characters, path separators
- Values: empty bytes, 0 bytes to 1MB, all-zero, all-0xFF
- Batch: conflicting operations (set and delete same key), duplicate keys, thousands of operations

### verifyProof()
- Manipulated proofs: swap sibling positions, change sibling hashes, truncate siblings, add extra siblings
- Wrong root hash with valid proof
- Valid proof with wrong key or wrong value

### serialize() / loadTree()
- Truncated serialized bytes
- Corrupted JSON
- Modified entry hex values
- Missing or extra transitions
- Tampered signatures in transitions

### getVersion() / getHistory()
- Boundary versions (0, current, current+1)
- Negative versions
- Large version numbers
- Range where from > to

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Leaf hashing | @noble/hashes | Blake3 |
| Internal node hashing | @noble/hashes | Blake3 |
| Transition signing | @ensoul/identity | Ed25519 (RFC 8032) |
| Transition verification | @ensoul/identity | Ed25519 (RFC 8032) |
| Persistence | classic-level | LevelDB |

**No custom cryptography is implemented.** All hashing uses Blake3 from @noble/hashes. All signing uses Ed25519 from @ensoul/identity.
