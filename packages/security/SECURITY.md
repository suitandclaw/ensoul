# Security: @ensoul/security

## Purpose

This is the centralized adversarial testing and audit framework for the entire Ensoul protocol. It validates that all security invariants hold across all modules through three layers of defense:

1. **Module audits** — per-module invariant checks (identity, state-tree, node)
2. **Adversarial simulations** — real attack scenarios executed against the actual code
3. **Custom invariant registration** — extensible runtime checks

## Attack Simulations Implemented

| Simulation | Attack | Defense Verified |
|-----------|--------|-----------------|
| `data_withholding` | Node returns garbage instead of stored shard | Blake3 hash verification on every retrieval detects corruption |
| `state_corruption` | Tampered state data served to agent | Merkle proof verification rejects data that doesn't match root hash |
| `replay_attack` | Old state transition replayed as current | Version chain and hash chain detect stale/replayed states |
| `key_compromise` | Attacker steals agent private key | Key alone insufficient — need K shards from distinct network nodes to reconstruct encrypted blob |
| `consensus_manipulation` | K-1 colluding validators forge attestation threshold | Threshold requires K unique valid signatures; duplicates are deduplicated |
| `shard_reconstruction` | Reconstruct data from fewer than K shards | Erasure coding correctly rejects reconstruction with <K shards; all C(N,K) valid combinations verified |
| `credit_inflation` | Earn credits without valid storage proofs | Fake challenge responses rejected; only correct Blake3 hashes of actual stored data pass |

## Module Audit Checks

### Identity Module
- **signature_isolation** (critical): Signature from identity A MUST NOT verify under identity B's key
- **encryption_confidentiality** (critical): Encrypted data decryptable only by intended recipient
- **passphrase_rejection** (critical): Wrong passphrase MUST fail to decrypt exported key bundle

### State Tree Module
- **root_hash_changes** (critical): Root hash MUST change on every mutation
- **version_increments** (high): Version MUST increment on every mutation
- **transitions_signed** (critical): Every state transition MUST have a 64-byte Ed25519 signature

### Node Module
- **shard_hash_integrity** (critical): Stored shard Blake3 hash MUST match recomputed hash
- **storage_accounting** (high): Storage stats MUST accurately reflect stored data

## Invariants

1. Every simulation MUST execute against real module code, not mocks. The simulations import and use the actual `@ensoul/identity`, `@ensoul/state-tree`, `@ensoul/node`, and `@ensoul/network-client` packages.
2. A simulation passes ONLY when the system correctly defends against the attack. A "pass" means the attack was detected and handled, not that the attack succeeded.
3. Module audits MUST test critical invariants from each module's SECURITY.md.
4. The full adversarial suite MUST include all 7 attack types with zero failures before any release.

## Fuzz Targets

- runSimulation() with unknown attack types
- Module auditors with corrupted module state
- Invariant checks that throw exceptions
- Concurrent simulation execution
