# Security: @ensoul/anchor (Checkpoint Service)

## Threat Model
The checkpoint service provides tamper evidence by producing validator-signed state snapshots stored on the Ensoul chain. Any party can compare current state against the last checkpoint to detect tampering or corruption.

Ensoul is a sovereign L1 — checkpoints are internal protocol state. No external chain dependencies.

## Invariants
1. Checkpoint hashes MUST be deterministic: same inputs produce same hash.
2. Checkpoint signatures MUST be verified against registered validators.
3. Verification MUST detect state root mismatches between current state and last checkpoint.
4. Emergency checkpoints MUST be producible at any time, bypassing the normal interval.
5. Checkpoints are stored on-chain and immutable once produced.

## Fuzz Targets
- createCheckpoint with edge-case values (zero supply, max height, empty validator set)
- verifyCheckpointSignatures with corrupted signatures, missing validators
- verifyAgainstCheckpoint with matching and mismatched state roots
