# Security: @ensoul/archive (Deep Archive)

## Threat Model
The deep archive provides a nuclear backup tier within the Ensoul network itself — higher replication factor, wider node distribution. No external storage dependencies.

Ensoul is a sovereign L1 — archives live on Ensoul nodes, not Arweave/Filecoin/IPFS.

## Invariants
1. Archive content hash MUST match Blake3(data) on store and on restore.
2. Archive receipts MUST be signed by the agent's identity key.
3. Restore MUST verify integrity before returning data (reject corrupted archives).
4. Receipts are stored on-chain for verifiable proof of archive existence.

## Fuzz Targets
- archive() with empty data, large data, missing backend
- verify() with missing receipts, unavailable backends
- restore() with tampered data in the storage backend
