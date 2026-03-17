# Security: @ensoul/anchor

## Threat Model
The anchor module provides tamper evidence by checkpointing Ensoul state to external chains (Ethereum, Bitcoin). It detects but does not prevent tampering. An attacker who compromises the Ensoul validator set cannot rewrite history if anchors exist on Ethereum/Bitcoin.

## Invariants
1. Checkpoint hashes MUST be deterministic: same inputs produce same hash.
2. Checkpoint signatures MUST be verified against registered validators.
3. Verification MUST detect state root mismatches between current state and last anchor.
4. Emergency anchors MUST be producible at any time, bypassing the normal interval.
5. Anchor receipts MUST be immutable once recorded.

## Fuzz Targets
- createCheckpoint with edge-case values (zero supply, max height, empty validator set)
- verifyCheckpointSignatures with corrupted signatures, missing validators
- verifyAgainstAnchor with matching and mismatched state roots
