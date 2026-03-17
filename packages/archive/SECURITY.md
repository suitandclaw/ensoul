# Security: @ensoul/archive

## Threat Model
The dead man's archive provides nuclear backup: consciousness survives even if the entire Ensoul network disappears. Archives are encrypted, hash-verified, and signed by the agent's identity.

## Invariants
1. Archive content hash MUST match Blake3(data) on upload and on restore.
2. Archive receipts MUST be signed by the agent's identity key.
3. Restore MUST verify integrity before returning data (reject corrupted archives).
4. Multiple targets provide redundancy — failure of one target does not block others.

## Fuzz Targets
- archive() with empty data, large data, corrupted backends
- verify() with missing receipts, unavailable backends
- restoreFromArchive() with tampered data at the external target
