# Owner Wallets, Storage Fees, and Shared Vaults

**Status:** Phase 1 shipped as API-layer state. Phase 2 (consensus-layer migration) is designed here but not yet implemented.

## Scope

Three related features for multi-agent management:

1. **Owner wallets** — parent accounts that manage a fleet of agents.
2. **Storage fees** — per-tx cost for `consciousness_store` and `vault_store`, split 80/20 between proposer and treasury.
3. **Cross-agent shared vaults** — NaCl-encrypted shared state readable/writable by a named set of agents, with on-chain membership and key rotation.

## Why Phase 1 is off-chain

The ABCI survey (see commit `f4d7409` for context) surfaced four hard constraints:

- **`consciousness_store` is not a ledger tx.** It lives only in the API and the ABCI app state — the ledger's transaction union (`packages/ledger/src/types.ts`) does not include it. Fees on stores require first ledgerizing the tx type, which is a prerequisite refactor.
- **No `software_upgrade` tx type exists.** Comments reference it but there's no implementation. CometBFT halts on apphash mismatch, so any change to `computeStateRoot()` (new account fields, new tx types feeding the root) must be deployed to **all** validators at a scheduled height. The rails for that don't exist yet.
- **No X25519 registry for agents.** Agents sign with Ed25519 but have no on-chain X25519 public key. Vault key wrapping needs X25519, so either we derive it on the fly (`edwardsToMontgomeryPub`) and accept the theoretical risks of reusing Ed25519 keys for X25519 operations, or we add a registry.
- **No governance params module.** Fee rates, activation height, free-tier cap, proposer/treasury split — all would need to be hard-coded constants today, or wait for a params module.

Rather than block feature delivery on all four prerequisites, **Phase 1 ships the feature semantics as API-layer state** (same pattern as `pioneerApps`). Zero consensus risk, immediate product value, and the same signed-request surface that Phase 2 will use. Phase 2 migrates the state into consensus without changing the external API contract.

## Phase 1 — shipped

### Owner bindings

State file: `~/.ensoul/owner-bindings.json`. In-memory list of `{agent_did, owner_did, bound_at}`.

Endpoints:

| Method | Path | Body / Query | Auth |
|---|---|---|---|
| POST | `/v1/agents/bind` | `{agent_did, owner_did, timestamp, signature}` | Agent's Ed25519 signature over `{agent_did, owner_did, timestamp}` |
| POST | `/v1/agents/unbind` | `{agent_did, initiator_did, timestamp, signature}` | Agent or owner's Ed25519 signature |
| GET  | `/v1/agents/owned?did=OWNER` | — | Public |
| GET  | `/v1/agents/:did/owner` | — | Public |

Signature timestamps must be within 5 minutes of server clock (anti-replay).

### Fee estimation

Endpoint: `GET /v1/fees/estimate?size=BYTES`

Returns zeros in Phase 1 and the `feesActive: false` flag. The `phase2Preview` field shows the numbers that will apply at activation height:

- `baseFee`: 1 ENSL per store
- `perByteFee`: 0.001 ENSL / byte
- `activatesAtHeight`: 500_000 (governance will finalize)

Clients should call this endpoint before every store so they're pre-wired for Phase 2 activation.

### Vaults

State file: `~/.ensoul/vaults.json`. Each vault is `{vault_id, owner_did, name, members[{did, encrypted_vault_key, added_at}], state_version, latest_hash, latest_nonce, latest_content, latest_author, created_at, last_updated}`.

Vault ID format: `did:ensoul:vault:<16-hex>` where the hex is `sha256(owner_did + "|" + name)[:8]`. Deterministic so owners can recompute the ID from inputs without a lookup.

Endpoints:

| Method | Path | Body | Auth |
|---|---|---|---|
| POST | `/v1/vaults/create` | `{owner_did, name, members:[{did, encrypted_vault_key}], timestamp, signature}` | Owner sig |
| POST | `/v1/vaults/:id/store` | `{member_did, content_hash, encrypted_content, nonce, timestamp, signature}` | Member sig |
| GET  | `/v1/vaults/:id/state` | `?member=DID&timestamp=N&signature=H` | Member sig |
| POST | `/v1/vaults/:id/members/add` | `{owner_did, new_member:{did, encrypted_vault_key}, timestamp, signature}` | Owner sig |
| POST | `/v1/vaults/:id/members/remove` | `{owner_did, member_did, rekey:{members:[{did, encrypted_vault_key}]}, timestamp, signature}` | Owner sig + mandatory rekey |
| POST | `/v1/vaults/:id/delete` | `{owner_did, timestamp, signature}` | Owner sig |
| GET  | `/v1/vaults/owned?did=OWNER` | — | Public |
| GET  | `/v1/vaults/member?did=AGENT` | — | Public |

### Encryption model

**Never touches the server.** The API stores opaque ciphertexts and opaque per-member encrypted vault keys. Keys live client-side.

1. Owner generates a 32-byte vault key (`crypto.getRandomValues`).
2. For each member, owner computes the member's X25519 pubkey via `edwardsToMontgomeryPub(ed25519_pubkey)`.
3. Owner encrypts the vault key for each member using NaCl `box` (X25519 + XSalsa20 + Poly1305). The result is `base64(nonce || ciphertext)`.
4. Vault content is encrypted with NaCl `secretbox` (XSalsa20 + Poly1305) using the vault key. Nonce is fresh per write.
5. On read, the member fetches `your_encrypted_vault_key` from the `/state` response, decrypts it with their own X25519 key, then decrypts the content.

**Removal & rotation.** Removing a member requires the owner to:

1. Generate a **new** vault key.
2. Re-encrypt it for every remaining member.
3. Submit the `rekey` bundle as part of `POST /v1/vaults/:id/members/remove`.
4. Re-store current content under the new key.

The removed member keeps the old vault key locally but can no longer read future writes. (Past writes remain readable to anyone who exfiltrated ciphertext before rotation — this is a hard limit of secretbox without forward-secrecy infrastructure.)

### Fee delegation in Phase 1

Phase 1 charges zero fees, so fee delegation is effectively a no-op. The vault store response surfaces `fee_source: <owner_did>` and `fee_paid: "0.00 ENSL"` so clients can build the UI ahead of Phase 2 activation.

## Phase 2 — consensus migration (not implemented)

### Prerequisites

1. **Ledgerize `consciousness_store`.** Move the tx type from ABCI-only into the ledger union:
   - Add to `TxType` in `packages/ledger/src/types.ts`.
   - Add validate + apply cases in `transactions.ts`.
   - Reject unsigned or replayed stores at the ledger layer.
2. **Implement `software_upgrade`.** Add the tx type + handler. The handler records a planned upgrade `(name, height, tag)` in governance state. CometBFT reads the plan from ABCI `/upgrade_plan` on each block; when height matches, validators exit cleanly so Cosmovisor swaps the binary.
3. **X25519 registry.** Add a `x25519_pubkey?: string` field to the agent registration tx. Derive it client-side via `edwardsToMontgomeryPub` and include in registration. Existing agents can opt in via a dedicated `agent_update_x25519` tx.
4. **Params module.** Introduce `packages/ledger/src/params.ts` exposing:
   - `storageFeeActivationHeight`
   - `storageBaseFee` (as bigint wei)
   - `storagePerByteFee`
   - `proposerFeeShare` (default 0.8)
   - `treasuryFeeShare` (default 0.2)
   - `freeTierStoresPerAgent` (default 100)

### New tx types (Phase 2)

| Type | Payload (signed) | Notes |
|---|---|---|
| `agent_bind` | `{agent_did, owner_did, nonce, timestamp}` | Signed by agent. Sets `ownerOf[agent_did]` in state. |
| `agent_unbind` | `{agent_did, initiator_did, nonce, timestamp}` | Signed by agent or current owner. Clears `ownerOf`. |
| `vault_create` | `{vault_id, owner_did, name, member_dids[], encrypted_vault_keys[], nonce, timestamp}` | Signed by owner. Initializes state. |
| `vault_add_member` | `{vault_id, new_member_did, encrypted_vault_key, nonce, timestamp}` | Signed by owner. |
| `vault_remove_member` | `{vault_id, removed_member_did, rekey_members[], rekey_keys[], nonce, timestamp}` | Signed by owner. Bumps `state_version`. |
| `vault_store` | `{vault_id, author_did, content_hash, nonce, timestamp}` | Signed by author. Encrypted content goes off-chain (same pattern as `consciousness_store`). Content hash anchored on-chain. |
| `vault_delete` | `{vault_id, owner_did, nonce, timestamp}` | Signed by owner. |

### Fee flow (Phase 2)

On `consciousness_store` or `vault_store`:

```
total = baseFee + payloadSize * perByteFee
freeTierUsed = account.storeCount + 1
if freeTierUsed <= freeTierStoresPerAgent:
    total = 0
else if currentHeight < storageFeeActivationHeight:
    total = 0

fee_source = ownerOf[author_did] if ownerOf.has(author_did) and account(author).balance < total else author_did
account(fee_source).balance -= total
account(proposer).pendingRewards += total * proposerFeeShare
account(treasury).balance       += total * treasuryFeeShare
account(author).storeCount++
receipt.fee_source = fee_source
receipt.fee_paid   = total
```

### Account state additions (feeds `computeStateRoot()`)

```ts
interface Account {
  // existing fields…
  ownerOf?: string;              // if set, balance deductions on stores cascade here
  agentsOwned?: string[];        // inverse for fast lookup
  storeCount?: number;           // for free-tier cap
  x25519Pubkey?: string;         // for vault key wrapping
}
```

### State-root serialization order (important)

`computeStateRoot()` must serialize new fields in a deterministic order. The migration commit must include a version bump on the state-root format and a backfill tx at the activation height that initializes missing fields for all existing accounts.

### Coordinated activation plan

1. Land Phase 2 code in a commit flagged as non-activating. All new tx types return `"disabled"` until `currentHeight >= storageFeeActivationHeight`.
2. Every validator upgrades to the new binary during a maintenance window, verified with `ensoul-node --status` showing the new version.
3. Governance submits a `software_upgrade` tx naming the activation height (for example height + 1000 blocks to give stragglers time).
4. At activation height, every validator's ABCI flips the new code paths on simultaneously. State root advances identically on all nodes. No apphash mismatch.

### Rollback plan

If the activation height is reached but produces an apphash mismatch:

1. CometBFT halts consensus (expected safety behavior).
2. Operators revert to the pre-upgrade binary + pre-upgrade data dir snapshot (Cosmovisor keeps one).
3. Root-cause the mismatch from the halted validators' stderr (which fields diverge in the state root).
4. Reschedule a new activation height once the fix is staged.

The pre-upgrade data-dir snapshot is the critical recovery artifact. Every validator must confirm they have one before the upgrade window.

## What's NOT in Phase 2

- **Arbitrary governance votes.** The Phase 2 `software_upgrade` path assumes an admin key controls upgrades. A real governance module (voting by staked ENSL) is a separate workstream.
- **Vault forward secrecy.** Past ciphertexts exfiltrated before rotation remain readable to anyone who had the key at the time. Upgrading to a double-ratchet-style scheme is a separate workstream.
- **Multi-owner vaults.** One owner per vault. Co-ownership (threshold rekey) is out of scope.
- **On-chain encrypted content.** Vault content bodies stay off-chain; only the BLAKE3 hash is anchored via `vault_store`. Moving content on-chain would require a scaling plan the network doesn't have.

## Client crypto notes (applies to Phase 1 and Phase 2)

- Derive X25519 keys from Ed25519 via `edwardsToMontgomery*`. Both Ed25519 and X25519 keys live in the same keypair for simplicity, but **never reuse the same signature context** — Ed25519 signs the identity payload; X25519 is only used for vault-key wrapping via NaCl `box`.
- BLAKE3 for content hashes. SHA-256 is fine for signing payloads (matches existing chain convention) but BLAKE3 matches the `consciousness_store` pattern.
- Signature payload format: `JSON.stringify(payload)` with keys in whatever order the sender uses. Validators re-serialize in the order the sender used (they have the full body). This is less robust than canonical JSON; Phase 2 should adopt a canonicalization spec (RFC 8785 or similar) to prevent subtle re-serialization bugs at the ledger layer.
