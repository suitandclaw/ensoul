# Heartbeat-Required Validator Participation

Spec version: 0.2 (decisions locked, planning complete)
Status: ready for implementation
Predecessor: 0.1 (initial draft, included open questions)

## Overview

Today, validators on Ensoul can sign blocks indefinitely without producing telemetry. The heartbeat client is run on a best-effort basis and the chain has no view into whether a validator is reporting. This is fine for liveness but produces three operational gaps:

1. No observability recovery path. If a validator goes silent we have no chain-level signal that something is wrong.
2. No fork detection at the consensus layer. A validator can be partitioned from the telemetry endpoint and the chain will not notice.
3. No incentive coupling. Validators that stop reporting incur no economic cost, so the network has no enforcement leverage to keep telemetry healthy.

This spec adds chain-enforced heartbeat reporting. Validators must submit a small `validator_heartbeat` transaction at most once per N-block interval. A soft threshold removes a silent validator from the active CometBFT set (jail). A hard threshold removes the validator and slashes 1% of total stake to the protocol treasury. Recovery is automatic on the next valid heartbeat for jailed (not yet hard-removed) validators. Hard-removed validators rejoin only via a governance proposal (out of scope for this spec).

## Parameters

| Parameter | Value | Notes |
|---|---|---|
| `HEARTBEAT_INTERVAL_BLOCKS` | 50 | About 5 minutes at 6s/block. Validator submits at most one heartbeat per interval. |
| `JAIL_THRESHOLD_BLOCKS` | 1,800 | About 3 hours of silence. Soft jail: validator removed from active set, can rejoin. |
| `REMOVE_THRESHOLD_BLOCKS` | 14,400 | About 24 hours of silence. Hard removal + slash. |
| `SLASH_FRACTION_BPS` | 100 | 1% of total stake (own + delegations). Basis points so governance can change later. |
| `SLASH_DESTINATION` | `did:ensoul:protocol:treasury` | Slashed amount is credited (not burned). |
| `HEARTBEAT_TX_FEE` | 0 | Free. The chain has no fee mechanism today, so this is the default. |
| `ACTIVATION_HEIGHT` | `current_height + 14 * 14400` | Set at release time, ~201,600 blocks ahead (14 days at 14400 blocks/day). |

## Validator State Machine

Four discrete states, transitions enforced by per-block logic in `handleFinalizeBlock`:

```
            heartbeat received
              ┌─────────────────┐
              │                 │
              ▼                 │
   ┌──────────┐  silent>1,800  ┌─────┐  silent>14,400  ┌──────────┐
   │  ACTIVE  │ ─────────────► │JAIL │ ──────────────► │ REMOVED  │
   └──────────┘                 └─────┘                 └──────────┘
        │                                                    ▲
        │ governance force-remove                            │
        └────────────────────────────────────────────────────┘
                                                             │
                                  governance rejoin proposal │ (OUT OF SCOPE)
                                                             ▼
                                                     [future spec]
```

- `ACTIVE`: validator is in the consensus set, signing blocks, submitting heartbeats.
- `JAIL`: validator is removed from CometBFT active set (`power=0` emitted), but state is recoverable. Receiving a valid heartbeat tx automatically transitions back to `ACTIVE` and re-emits a `power=full` ValidatorUpdate.
- `REMOVED`: validator is hard-removed and slashed. Cannot rejoin without a future governance proposal type (out of scope).
- `governance force-remove` is the existing `consensus_force_remove` path. It transitions `ACTIVE → REMOVED` directly without slashing. Documented here for completeness; this spec does not modify that path.

## Transaction Format

Two new transaction types: `validator_heartbeat` (validator-signed) and `register_heartbeat_pubkey` (privileged, PIONEER_KEY-signed).

### `Transaction` interface change

The `Transaction` struct in `packages/ledger/src/types.ts` gains one new optional field:

```ts
interface Transaction {
  type: TransactionType;
  from: string;
  to: string;
  amount: bigint;
  nonce: number;
  timestamp: number;
  intervalSlot?: number;   // NEW. Required for validator_heartbeat post-ACTIVATION_HEIGHT. Ignored for all other tx types.
  data?: Uint8Array;
  signature: Uint8Array;
}
```

The field is optional and defaults to `undefined`. Any tx type other than `validator_heartbeat` MUST omit it. The canonical encoder (`encodeTxPayload`) is updated to include `intervalSlot` in the signed payload only when `tx.type === "validator_heartbeat"`. This preserves byte-for-byte canonical equality for all other tx types and avoids invalidating prior signatures.

### `validator_heartbeat` shape

```
{
  type: "validator_heartbeat",
  from: <validator_did>,
  to:   <validator_did>,                                 // self
  amount: 0n,
  nonce: 0,                                              // unused, kept zero for canonical-encoding stability
  intervalSlot: floor(currentHeight / HEARTBEAT_INTERVAL_BLOCKS),
  timestamp: <unix_seconds>,
  data: <encoded_payload>,                               // see below
  signature: <ed25519_over_canonical_payload, signed by heartbeat_pubkey>,
}
```

The canonical payload is `{ chainId, type, from, to, amount, intervalSlot, timestamp }` (in this order). The payload INTENTIONALLY excludes `nonce` and `data` from the signed bytes. `nonce` is unused for this tx type. `data` is informational only (see below) and excluded so a validator can resubmit with updated `data` if a tx is dropped without resigning.

Wait, that contradicts — if `data` is informational, what stops an attacker from rewriting it? Answer: nothing, but also nothing relies on it for chain state. The `data` is purely for the indexer (telemetry mirroring); the chain only checks signature, slot ID, and validator identity. Anyone replaying a heartbeat with rewritten `data` cannot change the chain effect (which is just `lastHeartbeatHeight = currentHeight`). The signature still gates whether the tx is accepted at all. So this is safe.

`data` payload (JSON):

```
{
  height_seen:      <validator_local_view_of_chain_height>,
  abci_version:     <e.g., "1.4.135">,
  cometbft_version: <e.g., "0.38.0">,
  peer_count:       <int>,
  catching_up:      <bool>,
}
```

### `register_heartbeat_pubkey` shape

Privileged tx. Follows the existing `consensus_force_remove` / `pioneer_delegate` / `governance_*` pattern (validation in ABCI, ledger marker no-op, PIONEER_KEY-signed, activation-height gated).

```
{
  type: "register_heartbeat_pubkey",
  from: <PIONEER_KEY_DID>,
  to:   <validator_did_being_registered>,
  amount: 0n,
  nonce: <pioneer_key_account_nonce>,
  data: { heartbeat_pubkey: <hex_ed25519_pubkey>, install_proof: <hex_signature> },
  signature: <ed25519, signed by PIONEER_KEY>,
}
```

The `install_proof` field is the original install-time signed message (replicated on-chain so anyone can verify the validator's claim that it was running an enforcement-capable binary at apply time). Schema:

```
install_proof_payload = { abci_version, git_commit, timestamp }
install_proof = ed25519_sign(payload_canonical, heartbeat_privkey)
```

The chain stores `heartbeat_pubkey` (and the install_proof for auditability) in the `HeartbeatRegistry`. Once registered, the entry is immutable; rotation is a separate future tx type (out of scope).

## Replay Protection

Heartbeats use slot-based replay protection, NOT account nonce.

- Slot ID: `intervalSlot = floor(currentHeight / HEARTBEAT_INTERVAL_BLOCKS)`
- A validator can have at most one accepted heartbeat per slot.
- CheckTx tracks "highest slot accepted per validator" in mempool; rejects duplicates within the same slot.
- FinalizeBlock enforces the same constraint at execution: a heartbeat is rejected if `intervalSlot < lastAcceptedSlot[validator]` or equal. This collapses the mempool race condition into a deterministic outcome.

The chain rejects heartbeat txs with `intervalSlot != current_slot` (within a small tolerance window of one slot to handle block-boundary timing). Specifically, accept if `intervalSlot ∈ {current_slot - 1, current_slot}`. This handles the case where a validator submits a tx late in slot N and it lands in block N+1's first execution.

## Heartbeat Pubkey Registration

The validator's `heartbeat_pubkey` is a SEPARATE Ed25519 keypair from the validator identity key.

- Validator identity key: `~/.ensoul/identity.json`. Used for block signing and CometBFT consensus. RESERVED for that purpose only.
- Heartbeat key: `~/.ensoul/heartbeat-key.json` (NEW). Used to sign heartbeat txs. Generated during Pioneer install or admin onboarding.

`heartbeat-key.json` schema:

```json
{
  "did_for": "did:key:z6Mk... (the validator this key serves)",
  "publicKey": "<hex 32 bytes>",
  "privateKey": "<hex 32 bytes>",
  "createdAt": "<ISO8601>"
}
```

Operators are responsible for backing up this file alongside the identity key. Loss of `heartbeat-key.json` means the validator cannot send heartbeat txs and will eventually be jailed and removed.

### Generation flow

- New Pioneer onboarding (`scripts/install-validator.sh`): a step generates `heartbeat-key.json` if missing, prints the public key, and includes it in the Pioneer apply payload.
- Existing validators: a one-time script `scripts/generate-heartbeat-key.sh` generates the key and produces an install proof for re-attestation. Validators run this before `ACTIVATION_HEIGHT` and submit a re-attestation through the API.

## Pioneer Apply Pipeline

Today the Pioneer apply pipeline is OFF-CHAIN. Applications live in `/home/ensoul/.ensoul/pioneer-applications.json` on the API VPS, served by endpoints in `packages/api/start.ts`. The on-chain effect is the privileged `pioneer_delegate` tx triggered by approval.

After this spec, the flow becomes (additions in **bold**):

1. Validator generates `heartbeat-key.json` (install or re-attest script).
2. Validator submits a Pioneer application via POST `/v1/pioneers/apply`. **Schema gains two new required fields**: `heartbeat_pubkey` (hex) and `heartbeat_install_proof` (hex Ed25519 signature over `{abci_version, git_commit, timestamp}`).
3. **API VPS validates**: `heartbeat_pubkey` length is 64 hex chars (32 bytes), install proof signature verifies under `heartbeat_pubkey`, install proof timestamp is within 24h of submission, `abci_version` is acceptable.
4. JD reviews and approves (admin endpoint, X-Admin-Key gated).
5. **API VPS broadcasts `register_heartbeat_pubkey` tx FIRST**, signed with PIONEER_KEY, registering the validator's heartbeat_pubkey on chain.
6. After `register_heartbeat_pubkey` is included in a block, the API VPS broadcasts `pioneer_delegate` (existing flow) to delegate the Pioneer's stake.

Order matters: `register_heartbeat_pubkey` must land first. If it fails, the API VPS does not broadcast `pioneer_delegate`. The application stays in `pending` state with a recorded error so an admin can retry.

### Existing applications (the 12 in the current file)

Pre-existing applications lack the new fields. Two paths:

1. Re-attest endpoint (admin-only): POST `/v1/pioneers/re-attest`. Requires the existing application's DID and the new `heartbeat_pubkey` + `heartbeat_install_proof`. On success, the API broadcasts `register_heartbeat_pubkey` and updates the application JSON.
2. Without re-attestation: validator passes through `ACTIVATION_HEIGHT`, fails to send any valid heartbeat txs (no registered pubkey on-chain → signature check fails), jails at the soft threshold, hard-removed at the hard threshold.

This is an explicit migration path: every existing validator must re-attest before `ACTIVATION_HEIGHT` to remain in consensus.

## ABCI State

Two new state collections, both included in the state root:

### `HeartbeatRegistry`

```
Map<validatorDID, {
  heartbeatPubkey: Uint8Array,   // 32-byte Ed25519 pubkey
  installProof:    Uint8Array,   // 64-byte Ed25519 signature, kept for auditability
  registeredAt:    number,       // block height
}>
```

Set by the privileged `register_heartbeat_pubkey` tx. Read at heartbeat-tx signature verification.

### `HeartbeatTracker`

```
Map<validatorDID, {
  lastHeartbeatHeight: number,
  lastAcceptedSlot:    number,            // highest intervalSlot accepted
  jailedAtHeight:      number | null,
  removedAtHeight:     number | null,
}>
```

Updated on heartbeat tx acceptance and on per-block enforcement.

State root: extend `AccountState.computeStateRoot()` to fold `HeartbeatRegistry` and `HeartbeatTracker` into the root with deterministic key sorting, alongside the existing `__delegationRoot__` and `__consensusSet__` markers. The chain's state root is computed via blake3 over sorted JSON in `accounts.ts:computeStateRoot()` (the orphan `packages/state-tree` package is not used and remains out of scope).

The state root inclusion uses two new markers:

```
__heartbeatRegistryRoot__: <blake3 over sorted HeartbeatRegistry entries>
__heartbeatTrackerRoot__:  <blake3 over sorted HeartbeatTracker entries>
```

Each new collection lives in `packages/ledger/src/heartbeat.ts` (new file) with its own `serialize`/`deserialize`/`computeRoot`/`clone` methods, mirroring `DelegationRegistry`.

## Per-Block Logic

Inside `handleFinalizeBlock` in `packages/abci-server/src/application.ts`, after existing tx processing and BEFORE emitting `validatorUpdates`:

```
// Step 1: process accepted heartbeat txs (already validated in CheckTx)
for each tx in block:
  if tx.type == "validator_heartbeat":
    if signature verifies under HeartbeatRegistry[tx.from].heartbeatPubkey
       and tx.intervalSlot ∈ {currentSlot - 1, currentSlot}
       and tx.intervalSlot > tracker[tx.from].lastAcceptedSlot:
      tracker[tx.from] = {
        lastHeartbeatHeight: currentHeight,
        lastAcceptedSlot:    tx.intervalSlot,
        jailedAtHeight:      null,                     // clear jail
        removedAtHeight:     existing,                 // do not clear removal
      }
      if was_jailed and not_removed:
        // unjail: re-emit power
        let totalStake = ownStake + delegations.getTotalDelegatedTo(validator)
        emit ValidatorUpdate(tx.from, power = totalStake / DECIMALS)

// Step 2: per-validator enforcement
if currentHeight >= ACTIVATION_HEIGHT:
  for each validator in sorted(consensusSet):
    let entry = tracker.get(validator) ?? defaultEntry(ACTIVATION_HEIGHT)
    if entry.removedAtHeight: continue                   // terminal
    let silentBlocks = currentHeight - entry.lastHeartbeatHeight
    if silentBlocks > REMOVE_THRESHOLD_BLOCKS:
      let totalStake = ownStake(validator) + delegations.getTotalDelegatedTo(validator)
      let slashAmount = totalStake * SLASH_FRACTION_BPS / 10000
      let actualSlashed = slashValidatorStake(validator, slashAmount)  // see Slashing Math
      accountState.credit(SLASH_DESTINATION, actualSlashed)
      tracker.set(validator, { ...entry, removedAtHeight: currentHeight })
      emit ValidatorUpdate(validator, power = "0")
      emit SlashEvent({validator, amount: actualSlashed, reason: "heartbeat-timeout-hard"})
    else if silentBlocks > JAIL_THRESHOLD_BLOCKS and not entry.jailedAtHeight:
      tracker.set(validator, { ...entry, jailedAtHeight: currentHeight })
      emit ValidatorUpdate(validator, power = "0")
```

Iteration is sorted (already enforced in `accountState.getConsensusSet()`) for determinism.

## Slashing Math

Slash flow:

1. Compute `totalStake = ownStake + totalDelegated`.
2. Compute `slashAmount = totalStake * SLASH_FRACTION_BPS / 10000`. (Integer division. Rounds DOWN.)
3. Slash self-stake first: `selfSlashed = AccountState.slash(validator, min(slashAmount, ownStake))`. Today's `slash()` reduces `stakedBalance` and credits nowhere; this spec does not change that primitive (it stays a "no-credit" reduction).
4. If `slashAmount > ownStake`, slash remainder pro rata across delegations: `delegationsSlashed = DelegationRegistry.slashDelegations(validator, remainder, totalDelegated)`. Foundation, Pioneer, and community delegations are slashed proportionally with no insulation. Locks restrict undelegation, not slashing.
5. Sum the actually-slashed amounts: `total = selfSlashed + sum(delegationsSlashed.values())`.
6. Credit `total` to `PROTOCOL_TREASURY`: `accountState.credit(SLASH_DESTINATION, total)`.
7. Emit a `SlashEvent` for the indexer with `{validator, total, breakdown: {self, byDelegator}, reason}`.

Implementation introduces a new helper `slashValidatorStake(validator, slashAmount): SlashResult` in `packages/ledger/src/heartbeat.ts` (or alongside the slash primitives in `accounts.ts`). The helper handles the cap-at-available case so the ABCI layer credits treasury with the correct sum even if the validator has less stake than the computed amount.

The existing `slash` transaction (PROTOCOL_TREASURY-only sender) is updated to use the new helper. Its semantics are preserved: it slashes `tx.amount` from the target. The change is that slashed amount now credits treasury rather than disappearing.

## Activation Strategy

Single hard-fork activation height. Computed at release time as `current_height + 14 * 14400`.

Behavior split:

- Before `ACTIVATION_HEIGHT`:
  - `validator_heartbeat` txs are accepted at CheckTx (signature must verify against registered pubkey if registered, else accept silently). Per-block enforcement is a no-op (no jail, no slash).
  - `register_heartbeat_pubkey` txs are accepted and applied normally so that registrations land BEFORE enforcement turns on.
  - `Transaction.intervalSlot` is unused for any other tx type.
- At `ACTIVATION_HEIGHT` exactly:
  - Initialize every validator currently in `consensusSet`: `tracker.set(validator, { lastHeartbeatHeight: ACTIVATION_HEIGHT, lastAcceptedSlot: ACTIVATION_HEIGHT/HEARTBEAT_INTERVAL_BLOCKS - 1, jailedAtHeight: null, removedAtHeight: null })`. This guarantees `silentBlocks = 0` for everyone at activation.
  - Begin per-block enforcement.
- After `ACTIVATION_HEIGHT`:
  - Heartbeats not registered with a `heartbeat_pubkey` cannot pass signature verification, so unregistered validators fail silent and jail at `ACTIVATION_HEIGHT + 1800`.

## Migration Path

1. Phase 0 (DONE, v1.4.135): heartbeat-client cwd-independence fix.
2. Phase 1 (DONE, this spec): planning and audit.
3. Phase 2: implement (this spec is the contract for that work).
4. Phase 3: testnet soak (>= 7 days, full enforcement on, observe drift, slash one or more test validators).
5. Phase 4: cut release v1.5.0 (semver minor, behavior change for validators).
6. Phase 5: rolling deploy to all 21 operator hosts (same procedure as v1.4.135).
7. Phase 6: external Pioneers update via `update-validator.sh` and re-attest with new fields.
8. Phase 7: announce `ACTIVATION_HEIGHT` 14 days in advance. Validators have 14 days to re-attest and confirm heartbeat-tx delivery in chain.
9. Phase 8: activation.

## Failure Modes

| Failure | Detection | Mitigation |
|---|---|---|
| Validator network-disconnected mid-deploy | jails within 3h, no slash yet | rejoin on next heartbeat (auto unjail) |
| Validator key lost (heartbeat-key.json) | jails at 3h, slashed and hard-removed at 24h | post-event recovery via governance proposal (out of scope) |
| Heartbeat client bug (never submits) | full validator set jails at 3h | testnet soak (>= 7 days) before mainnet activation; on-chain dashboard panel shows last heartbeat per validator |
| api.ensoul.dev outage | no chain effect (heartbeat tx broadcast is via local CometBFT RPC, not the API) | heartbeat-client must NEVER depend on api.ensoul.dev for tx submission. API outage is independent of chain participation. |
| Eclipse attack on a single validator | targeted jail | heartbeat-client should multi-broadcast (local RPC + at least one peer RPC) |
| Replay attack | rejected by intervalSlot check | one-tx-per-slot-per-validator |
| Front-running heartbeat txs | not exploitable | heartbeats are free and have no economic effect from inclusion order |
| Mempool DoS by non-validators | rejected at CheckTx | sender must be a registered validator (presence in `HeartbeatRegistry` is the gate) |
| Per-block enforcement loop scaling | O(N) per block, N = consensus set size | trivial at current 28 validators; revisit if N > 1000 |
| Time skew (validator clock off) | stale `tx.timestamp` rejected | enforce `|tx.timestamp - blockTime| < 600s` window in CheckTx |
| Activation-block mass-jail | every validator's lastHeartbeatHeight is 0 at activation | initialize to ACTIVATION_HEIGHT for every consensus-set validator at the activation block |
| State root divergence | replicas compute different roots | new collections folded into root with sorted-key blake3, same pattern as DelegationRegistry; covered by determinism tests |

## Implementation Order

Build in seven layers, each a self-contained PR with tests at that layer:

### Layer 0 — Types and skeleton (no behavior)
- `packages/ledger/src/types.ts`: extend `TransactionType` union with `validator_heartbeat`, `register_heartbeat_pubkey`. Add optional `intervalSlot` to `Transaction`. Add `HeartbeatRegistryEntry`, `HeartbeatTrackerEntry`, `SlashEvent` interfaces.
- `packages/ledger/src/heartbeat.ts`: NEW file. Skeleton of `HeartbeatRegistry` and `HeartbeatTracker` classes (empty methods, just types and Maps).

### Layer 1 — Ledger primitives
- `packages/ledger/src/heartbeat.ts`: full implementation of `HeartbeatRegistry.{set,get,has,serialize,deserialize,computeRoot,clone}` and `HeartbeatTracker.{set,get,markJailed,markRemoved,clearJail,serialize,deserialize,computeRoot,clone}`.
- `packages/ledger/src/heartbeat.ts`: `slashValidatorStake(accountState, delegationRegistry, validator, slashAmount): SlashResult` helper.
- `packages/ledger/src/accounts.ts`: extend `computeStateRoot()` to accept optional `heartbeatRegistryRoot` and `heartbeatTrackerRoot` markers.
- Tests: state root determinism with new markers, slash math correctness across self-stake-only / self-and-delegations / over-cap cases.

### Layer 2 — Transaction handling
- `packages/ledger/src/transactions.ts`: add `validator_heartbeat` and `register_heartbeat_pubkey` cases to `validateTransaction` and `applyTransaction` (privileged-tx no-op pattern, like `pioneer_delegate`). Update `encodeTxPayload` to include `intervalSlot` only for `validator_heartbeat`.
- Tests: canonical encoding stability for non-heartbeat tx types (existing signatures still verify), new tx types validate through.

### Layer 3 — ABCI integration: register_heartbeat_pubkey
- `packages/abci-server/src/application.ts`: CheckTx + FinalizeBlock handling for `register_heartbeat_pubkey`. PIONEER_KEY signature gate, activation-height gate, validation of payload, persistence to `HeartbeatRegistry`. Mirror the `consensus_force_remove` handler.
- Tests: PIONEER_KEY check, payload validation, registry persistence, idempotency on retry.

### Layer 4 — ABCI integration: validator_heartbeat
- `packages/abci-server/src/application.ts`: CheckTx for `validator_heartbeat` (sender must be in `HeartbeatRegistry`, signature verifies under registered pubkey, slot is current or current-1, no duplicate slot in mempool). FinalizeBlock acceptance updates `HeartbeatTracker`.
- Tests: signature verification under registered pubkey, slot validation, mempool dedup, replay rejection.

### Layer 5 — ABCI integration: per-block enforcement
- `packages/abci-server/src/application.ts`: per-block enforcement loop after tx processing. Activation-height gate. Initialize tracker entries at activation. Soft-jail at 1,800 blocks silent (emit `power=0`). Hard-remove + slash at 14,400 blocks silent (call `slashValidatorStake`, credit treasury, emit `power=0`, emit `SlashEvent`). Auto-unjail on heartbeat acceptance.
- Tests: state machine transitions for all four transitions, activation-block mass-jail prevention, slash determinism end-to-end, unjail re-emits correct power.

### Layer 6 — Validator-side: heartbeat-client
- `packages/heartbeat-client/src/`: add `broadcast_tx_sync` to the existing CometBFT RPC layer (currently read-only `/status`, `/net_info`).
- `packages/heartbeat-client/src/`: load `~/.ensoul/heartbeat-key.json`, build canonical `validator_heartbeat` payload, sign, broadcast via local CometBFT RPC every `HEARTBEAT_INTERVAL_BLOCKS` (50 blocks). Multi-broadcast to local + at least one peer for eclipse resistance.
- `scripts/generate-heartbeat-key.sh`: NEW script. Generates `heartbeat-key.json` if missing, prints the public key for re-attestation.
- Tests: tx encoding, signing, RPC broadcast (mocked in unit, integration on testnet).

### Layer 7 — API integration
- `packages/api/start.ts`: schema validation on `/v1/pioneers/apply` (require `heartbeat_pubkey` + `heartbeat_install_proof`, validate hex lengths and signature). New endpoint `/v1/pioneers/re-attest` (admin, X-Admin-Key) for existing applications. New broadcast helper `broadcastRegisterHeartbeatPubkey(did, pubkey, install_proof)` invoked in the approval flow BEFORE `pioneer_delegate`.
- Tests: schema validation rejection cases, re-attest flow, broadcast ordering (register first, delegate second).

### Build dependencies (which must precede which)

```
Layer 0 (types) → Layer 1 (primitives) → Layer 2 (txns) → Layer 3+4 (ABCI tx handlers) → Layer 5 (enforcement)
                                                                                              │
                                                       Layer 6 (heartbeat-client) ←──────────┤
                                                                                              │
                                                               Layer 7 (API) ←──────────────┘
```

Layer 6 depends on Layer 5 only for end-to-end testing; the wire format is fully defined by Layer 0–4 so dev work on Layer 6 can start once those land. Layer 7 depends on Layer 3 for the register tx existing.

## Test Plan

Tests are organized by package and priority. P0 tests block the release. P1 are required before production but can land later in the cycle. P2 are nice-to-haves.

### `packages/ledger` (unit)

| Test | Priority | Why |
|---|---|---|
| Slash math determinism: self-only, self+delegations, over-cap | **P0** | Wrong math reduces real validator stake |
| Slash credits exact total to PROTOCOL_TREASURY (sum of self + delegations) | **P0** | Treasury balance is consensus state |
| State root includes `__heartbeatRegistryRoot__` and `__heartbeatTrackerRoot__` | **P0** | Fork risk if state diverges |
| HeartbeatRegistry.computeRoot is deterministic across insertion order | **P0** | Same fork risk |
| HeartbeatTracker state machine: ACTIVE→JAIL→ACTIVE | **P0** | Recovery path correctness |
| HeartbeatTracker state machine: ACTIVE→JAIL→REMOVED | **P0** | Hard removal correctness |
| HeartbeatTracker state machine: REMOVED is terminal | **P0** | No accidental rejoin |
| Slashing on a validator with locked Foundation/Pioneer delegations | P1 | Confirms locks don't insulate from slash |
| Canonical tx encoding stability for non-heartbeat txs | **P0** | Cross-version signature compatibility |
| `intervalSlot` round-trip through encode/decode | P1 | Wire format integrity |

### `packages/abci-server` (integration)

| Test | Priority | Why |
|---|---|---|
| Activation-block mass-jail prevention (full set has lastHeartbeatHeight=ACTIVATION_HEIGHT) | **P0** | Operational disaster if wrong |
| validator_heartbeat tx with valid signature accepted, tracker updated | **P0** | Core happy path |
| validator_heartbeat with wrong slot rejected | **P0** | Replay protection |
| validator_heartbeat from non-registered validator rejected | **P0** | DoS protection |
| Soft-jail fires at silent_blocks > 1800 | **P0** | Threshold correctness |
| Hard-remove fires at silent_blocks > 14400, slash to treasury | **P0** | Threshold correctness |
| Unjail re-emits ValidatorUpdate with full power | **P0** | Recovery path correctness |
| Removed validator's subsequent heartbeat is no-op | **P0** | Terminal state correctness |
| register_heartbeat_pubkey requires PIONEER_KEY | **P0** | Privileged tx gate |
| register_heartbeat_pubkey before activation works (so we can pre-register) | P1 | Migration path |
| Two heartbeat txs in same slot from same validator: first wins | P1 | Replay determinism |
| Multiple validators heartbeat in same block, all tracked correctly | P1 | Common case |

### `packages/heartbeat-client` (unit + integration)

| Test | Priority | Why |
|---|---|---|
| Canonical payload encoding matches ledger encoder byte-for-byte | **P0** | Signature compat |
| Sign payload, verify roundtrip | **P0** | Crypto correctness |
| broadcast_tx_sync against local CometBFT (testnet) | P1 | E2E delivery |
| Multi-broadcast falls back to peer RPC if local fails | P1 | Eclipse resistance |
| `heartbeat-key.json` missing produces a clear error | P2 | Operator UX |

### `packages/api` (unit)

| Test | Priority | Why |
|---|---|---|
| `/v1/pioneers/apply` rejects payload missing `heartbeat_pubkey` | **P0** | Schema enforcement |
| Install proof signature validates under heartbeat_pubkey | **P0** | Cryptographic correctness |
| Re-attest endpoint requires X-Admin-Key | **P0** | Admin gate |
| Approval flow broadcasts register_heartbeat_pubkey BEFORE pioneer_delegate | **P0** | Ordering invariant |
| If register_heartbeat_pubkey fails on chain, pioneer_delegate is NOT broadcast | **P0** | Atomicity |

### Testnet soak

- Spin up testnet with 4 validators on the new build.
- Set `ACTIVATION_HEIGHT = current_height + 100` (close, fast iteration).
- Observe normal heartbeat operation for 200 blocks.
- Stop one validator's heartbeat-client. Confirm jail at `silent_blocks > 1800`.
- Restart heartbeat-client. Confirm auto-unjail on next heartbeat.
- Stop another validator's heartbeat-client and leave it down for `> 14400` blocks. Confirm hard-remove + slash to treasury, slash event emitted, treasury balance increases by exactly the slashed amount.
- Confirm chain liveness throughout (>2/3 voting power always healthy).
- Run for >= 7 days at the smaller threshold values (e.g., scale-down to JAIL=180, REMOVE=1440 for soak; revert to production values before mainnet release).

## Risk Areas Requiring Extra Review

These need explicit code review attention beyond standard PR review.

1. **Slash math**. The math reduces real validator stake. A bug here either over-slashes (operator complaint) or under-slashes (treasury shortfall). Requires three independent reviews: math, integer overflow check, edge cases (validator with 0 own stake, validator with 0 delegations, slash amount > total stake).
2. **State root determinism**. Folding new collections into the root must use the exact same sorted-key blake3 pattern as `DelegationRegistry`. A divergence here forks the chain. Test with shuffled-input determinism over 100+ random orderings.
3. **Activation-block initialization**. If we forget to seed `lastHeartbeatHeight` for the existing consensus set at activation, every validator jails immediately and the chain stops. This is THE critical bug to avoid. The activation logic must be tested in a dedicated integration test that creates a chain at `ACTIVATION_HEIGHT - 1` with N validators, advances one block, and asserts `silentBlocks == 0` for all of them.
4. **Tx canonical encoding compatibility**. The new `intervalSlot` field MUST NOT change the canonical encoding for any non-heartbeat tx. A bug here invalidates every existing signature on the chain. Test with prior-version replay: build current main's tx fixtures, run them through the new encoder, assert byte-for-byte equality.
5. **CheckTx mempool DoS**. A non-validator who knows a real validator's DID could spam `validator_heartbeat` txs with random signatures. CheckTx must reject these BEFORE signature verification (cheap check first: is `from` in HeartbeatRegistry? then verify signature). Profile under load.
6. **PIONEER_KEY exposure on the API VPS**. The API VPS already has access to PIONEER_KEY for `pioneer_delegate`. This spec adds another use (`register_heartbeat_pubkey`) but does not change the threat surface. However, document explicitly that compromise of PIONEER_KEY allows an attacker to register arbitrary heartbeat pubkeys for arbitrary validators, effectively jamming a validator out of consensus. Existing mitigation (PIONEER_KEY rotation procedure) applies.
7. **`heartbeat-key.json` operator UX**. Loss of this file means the validator gets jailed and removed within 24h. Onboarding scripts must be loud about this: "back this file up to your secret manager, treat it like the identity key." Consider integrating with the existing `~/ensoul-key-vault/` Shamir's Secret Sharing tooling (Rule 21 in CLAUDE.md).
8. **Race between register_heartbeat_pubkey and the validator's first heartbeat**. If the validator's heartbeat-client starts broadcasting heartbeats before `register_heartbeat_pubkey` lands on chain, those heartbeats will be rejected (no registered pubkey). The heartbeat-client must check on startup: is my pubkey registered? If not, defer broadcast until it is, or until a manual override is set.
