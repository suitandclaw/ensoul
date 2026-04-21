# Multisig Governance Design

**Status:** Design only. No implementation.

## 1. Motivation

Ensoul's governance currently relies on a single Ed25519 key (PIONEER_KEY) stored on the Ashburn VPS. This key controls:

- SOFTWARE_UPGRADE broadcasts (halt all 28 validators, apply code)
- consensus_force_remove (remove validators from the active set)
- pioneer_delegate (move 1M ENSL from treasury to a validator)
- pioneer_revoke (claw back delegation + remove from set)
- Governance lock bypass (undelegate locked Pioneer delegations)
- cancel_upgrade (abort a scheduled upgrade)

A single compromised key could drain the treasury, remove legitimate validators, or halt the chain with a malicious upgrade. A single lost key would make all governance operations impossible.

**Current risk profile:** acceptable for testnet and early mainnet (single operator, all infrastructure under one person's control). Unacceptable once Pioneers operate independently, ENSL has market value, or the operator count exceeds one.

**Target:** 3-of-5 Safe-pattern multisig with independent async signing, on-chain audit trail, and operator key delegation for routine operations. No timelock in v1 (deferred until ENSL has market value).

## 2. Signer Set

### Composition

5 signers total. Threshold: 3 signatures required to execute any sensitive operation.

Each signer holds an Ed25519 keypair. Signer identity is a DID (`did:key:z6Mk...`), matching the validator identity pattern used throughout Ensoul. This allows signers to use existing infrastructure (identity.json files, CLI tools, DID verification) rather than a separate key management system.

### Signer selection criteria

- Geographic distribution (no two signers in the same jurisdiction)
- Operational independence (no two signers share infrastructure)
- Technical competence (each signer can independently verify proposals)
- Availability commitment (respond within 24 hours for normal ops, 1 hour for emergencies)

### Initial signer set (proposed)

| Slot | Role | Notes |
|---|---|---|
| 1 | Founder (JD) | Current PIONEER_KEY holder |
| 2 | Technical advisor | Independent security reviewer |
| 3 | Pioneer representative | Elected from Pioneer cohort |
| 4 | Community representative | Long-term contributor |
| 5 | Cold key (offline) | Emergency recovery, stored in safe deposit |

The cold key in slot 5 ensures that even if two active signers become unavailable, the remaining two active signers plus the cold key can still reach threshold.

### Signer rotation

The signer set is mutable via 3-of-5 multisig vote on `set_signers`. This means:

- **Key loss:** if one signer loses their key, the other 4 (with the cold key if needed) can vote to replace them. No permanent lockout unless 3+ signers simultaneously lose keys.
- **Hostile signer:** if one signer acts maliciously, the other 4 can vote to rotate them out. The hostile signer cannot unilaterally execute anything (threshold is 3).
- **Catastrophic loss:** if 3+ signers lose keys simultaneously, governance is permanently locked. Mitigation: Shamir backup of each signer's key (2-of-3 shares per signer, stored in separate locations).

## 3. On-Chain Primitives

### GovernanceProposal

```typescript
interface GovernanceProposal {
  id: string;              // sha256(canonicalJSON(payload) + nonce), hex
  proposer: string;        // DID of the signer who created the proposal
  payload: GovernancePayload;
  signatures: Map<string, string>; // signerDid -> Ed25519 signature (hex)
  status: "pending" | "executed" | "expired" | "cancelled";
  createdAt: number;       // Unix ms
  expiresAt: number;       // Unix ms (default: createdAt + 7 days)
  executedAt?: number;     // Unix ms, set when executed
  executedBy?: string;     // DID of the signer who triggered execution
  timelockUntil?: number;  // Reserved for v2 timelock feature
  nonce: string;           // Unique per proposer, prevents replay
}
```

### GovernancePayload (inner operation types)

```typescript
type GovernancePayload =
  | { type: "treasury_transfer"; to: string; amount: string }
  | { type: "software_upgrade"; name: string; height: number; tag: string }
  | { type: "consensus_force_remove"; pub_key_b64: string; reason: string }
  | { type: "pioneer_revoke"; did: string }
  | { type: "governance_lock_bypass_undelegate"; from: string; to: string; amount: string }
  | { type: "operator_key_rotate"; newOperatorKey: string }
  | { type: "set_signers"; newSigners: string[]; newThreshold: number };
```

### State additions

```typescript
interface GovernanceState {
  signers: Set<string>;           // DIDs of authorized signers
  threshold: number;               // Minimum signatures required (3)
  proposals: Map<string, GovernanceProposal>;
  operatorKey: string;             // DID of single-sig operator for fast ops
  nonces: Map<string, number>;     // Per-signer nonce counter
}
```

Initial values at bootstrap:
- `signers`: set containing the 5 registered DIDs
- `threshold`: 3
- `proposals`: empty
- `operatorKey`: PIONEER_KEY DID (unchanged from current behavior until rotated)
- `nonces`: all zero

## 4. New Transaction Types

### governance_propose

```
From: any signer in governanceState.signers
Data: {
  payload: GovernancePayload,
  nonce: string,
  expiresAt?: number   // optional, defaults to now + 7 days
}
```

**Validation (CheckTx):**
- tx.from must be in governanceState.signers
- nonce must be unique for this proposer (prevents replay)
- payload must be a valid GovernancePayload type
- expiresAt must be in the future (if provided)

**Effect (FinalizeBlock):**
- Compute proposalId = sha256(canonicalJSON(payload) + nonce)
- Create GovernanceProposal with status "pending"
- The proposer's signature on the proposal automatically counts toward threshold (proposer implicitly signs what they propose)
- Log: `GOVERNANCE PROPOSE: id={proposalId} type={payload.type} by={proposer}`

### governance_sign

```
From: any signer in governanceState.signers
Data: {
  proposalId: string,
  signature: string     // Ed25519 signature over the proposal's canonical payload
}
```

**Validation (CheckTx):**
- tx.from must be in governanceState.signers
- proposalId must reference an existing proposal with status "pending"
- tx.from must not have already signed this proposal
- proposal must not be expired (expiresAt > block time)

**Effect (FinalizeBlock):**
- Verify signature against signer's public key and the proposal's canonical payload
- Append to proposal's signatures map
- Log: `GOVERNANCE SIGN: id={proposalId} signer={from} (now {n}/{threshold})`

### governance_execute

```
From: any signer in governanceState.signers
Data: {
  proposalId: string
}
```

**Validation (CheckTx):**
- tx.from must be in governanceState.signers
- proposalId must reference an existing proposal with status "pending"
- proposal.signatures.size must be >= governanceState.threshold
- proposal must not be expired

**Effect (FinalizeBlock):**
- Apply the inner payload as if it were a direct governance operation:
  - treasury_transfer: debit treasury, credit recipient
  - software_upgrade: write upgrade-info.json, halt
  - consensus_force_remove: emit ValidatorUpdate power=0
  - pioneer_revoke: undelegate + transfer back to treasury
  - governance_lock_bypass_undelegate: bypass lock, undelegate
  - operator_key_rotate: update governanceState.operatorKey
  - set_signers: update governanceState.signers and .threshold
- Mark proposal as "executed", set executedAt and executedBy
- Log: `GOVERNANCE EXECUTE: id={proposalId} type={payload.type} by={executor}`
- Idempotent: re-execution of an already-executed proposal fails with code 50

### governance_cancel

```
From: original proposer only
Data: {
  proposalId: string
}
```

**Validation (CheckTx):**
- tx.from must equal proposal.proposer
- proposal must have status "pending"

**Effect (FinalizeBlock):**
- Mark proposal as "cancelled"
- Log: `GOVERNANCE CANCEL: id={proposalId} by={proposer}`

## 5. Sensitive Operations Classification

Which operations move from single-key to multisig, and which stay as operator-key (single-sig)?

| Operation | Current auth | Proposed auth | Reasoning |
|---|---|---|---|
| software_upgrade | PIONEER_KEY | **Multisig (3-of-5)** | Halts all validators. Highest impact. Must be deliberate. |
| cancel_upgrade | PIONEER_KEY | **Multisig (3-of-5)** | Cancelling an upgrade can itself be an attack vector (prevent security fix). |
| consensus_force_remove | PIONEER_KEY | **Multisig (3-of-5)** | Removes a validator from the active set. High impact, irreversible. |
| governance_lock_bypass_undelegate | PIONEER_KEY | **Multisig (3-of-5)** | Moves locked tokens. Financial impact. |
| treasury_transfer (large) | PIONEER_KEY | **Multisig (3-of-5)** | Any transfer > 10,000 ENSL from treasury. |
| set_signers | n/a (new) | **Multisig (3-of-5)** | Changes who controls governance. Must be deliberate. |
| operator_key_rotate | n/a (new) | **Multisig (3-of-5)** | Changes the fast-ops key. |
| pioneer_delegate | PIONEER_KEY | **Operator key** | High frequency (every Pioneer approval). Low risk (tokens stay in ecosystem, locked 24 months). |
| pioneer_approve | ADMIN_KEY | **Operator key** | High frequency. Low risk (creates delegation entry). |
| pioneer_reject | ADMIN_KEY | **Operator key** | No financial impact. |
| pioneer_revoke | ADMIN_KEY | **Operator key** | Moves tokens but only back to treasury. Reversible. Operator can initiate; multisig can override if disputed. |
| treasury_transfer (small) | PIONEER_KEY | **Operator key** | Transfers <= 10,000 ENSL (e.g., onboarding bonuses, operational expenses). |

### Threshold for "large" treasury transfers

The 10,000 ENSL boundary is a parameter stored in governance state, changeable via multisig. Below this threshold, the operator key can transfer unilaterally. Above, a 3-of-5 proposal is required.

## 6. Operator Key Delegation

The operator key is a single-sig key for routine, high-frequency operations. It provides the same operational speed as the current PIONEER_KEY model while allowing governance to revoke or rotate it.

**Properties:**
- Initial value: same DID as PIONEER_KEY (seamless migration)
- Rotatable via 3-of-5 multisig (operator_key_rotate proposal)
- Revocable: if operator is compromised, multisig can rotate to a new key
- Scoped: can only perform operations classified as "operator key" in the table above
- Audited: all operator key actions are logged on-chain (same as today)

**Why not require multisig for everything?** Pioneer approvals happen weekly. Forcing 3 people to coordinate signatures for each approval would slow onboarding from minutes to days. The operator key preserves operational agility for low-risk actions while gating high-risk actions behind deliberation.

## 7. Signature Scheme

### What signers sign

The message signed for a governance proposal is:

```
sha256(canonicalJSON(payload) || nonce)
```

Where:
- `canonicalJSON` is JCS (RFC 8785) canonical JSON serialization (same library used by the heartbeat protocol)
- `nonce` is the proposer-chosen unique string
- `||` is byte concatenation
- Result is a 32-byte hash, signed with Ed25519

### Why hash before signing

Ed25519 signs arbitrary-length messages, but hashing first provides:
1. Constant-size signing input regardless of payload complexity
2. Domain separation (prevents cross-protocol signature reuse)
3. Compatibility with hardware wallets that may have message size limits

### Signature format

Signatures are stored as hex-encoded 64-byte Ed25519 signatures. Verification uses @noble/ed25519 (same library used throughout Ensoul).

### Canonical JSON requirement

All signers must produce identical canonical JSON for the same payload. JCS (RFC 8785) guarantees this. Any implementation that does not produce byte-identical output to the `canonicalize` npm package will produce invalid signatures.

## 8. Bootstrap / Migration

### Migration plan

The migration from single-key to multisig is height-gated at `MULTISIG_ACTIVATION_HEIGHT`.

**Phase 0: Pre-activation (current state)**
- PIONEER_KEY controls all governance operations as it does today
- No multisig state exists on-chain

**Phase 1: Registration (before activation height)**
- PIONEER_KEY broadcasts a `governance_install` transaction containing:
  - The 5 signer DIDs
  - Threshold (3)
  - Operator key DID (initially same as PIONEER_KEY)
- This creates the governance state but does NOT enable it
- Signers can verify their DIDs are registered

**Phase 2: Activation (at MULTISIG_ACTIVATION_HEIGHT)**
- Sensitive operations begin checking governance multisig instead of PIONEER_KEY
- Operator key operations check the registered operator key
- PIONEER_KEY as a raw single-key no longer works for sensitive ops
- The operator key (initially the same DID) works for fast ops

**Phase 3: Post-activation (ongoing)**
- Normal governance flow through propose/sign/execute
- Operator key rotation as needed
- Signer rotation as needed

### Rollback safety

If the multisig activation causes problems:
- Before activation: cancel by not reaching the height (abort deployment)
- After activation: 3-of-5 multisig can rotate back to any configuration
- Emergency: if multisig is bricked (3+ keys lost), the chain cannot be governed. This is the intended security property. Governance lockout is preferable to governance bypass.

## 9. Deferred Features

### Timelock (v2, post-mainnet token value)

When ENSL has market value, add an optional delay between proposal reaching threshold and execution:

1. 3 signers sign a proposal
2. Proposal enters timelock window (configurable, e.g., 48 hours)
3. During the window, any signer can veto by signing a `governance_cancel`
4. If no veto after the window expires, any signer can execute

**Why deferred:** On testnet with no token value, the veto-window benefit is minimal and the operational friction is significant. Timelocks become valuable when:
- ENSL has real value (attacks have financial motivation)
- The signer set includes external parties (trust model changes)
- Governance decisions affect a larger community (democratic legitimacy)

**Schema compatibility:** The `GovernanceProposal` interface already includes a reserved `timelockUntil?: number` field. Adding timelock logic later requires no schema migration, only new validation in `governance_execute`.

### Delegated voting (v3)

Token-weighted voting for non-sensitive parameters (e.g., fee schedule, block time). Completely out of scope for v1 multisig.

### On-chain governance UI (v2)

A dedicated governance page on the dashboard showing active proposals, signature status, and one-click signing. v1 uses CLI and direct API calls.

## 10. Frontend / UX

### CLI for signers

```
ensoul-node governance propose <payload-file.json>
ensoul-node governance sign <proposalId>
ensoul-node governance execute <proposalId>
ensoul-node governance cancel <proposalId>
ensoul-node governance list [--status pending|executed|expired|cancelled]
ensoul-node governance show <proposalId>
```

Payload file format (JSON):
```json
{
  "type": "software_upgrade",
  "name": "security-fix-v1.5.0",
  "height": 500000,
  "tag": "v1.5.0"
}
```

The CLI handles nonce generation, canonical JSON serialization, signing with the local identity key, and broadcasting the resulting transaction.

### API endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| GET /v1/governance/proposals | Public | List all proposals with status filter |
| GET /v1/governance/proposal/:id | Public | Full proposal details including signatures |
| POST /v1/governance/propose | Signed tx | Submit a new proposal |
| POST /v1/governance/sign | Signed tx | Add a signature to an existing proposal |
| POST /v1/governance/execute | Signed tx | Execute a proposal that has reached threshold |
| GET /v1/governance/signers | Public | Current signer set and threshold |

### Dashboard integration (Phase D of dashboard design)

- Pending proposals card in admin section
- Proposal detail modal with signer status (signed/not signed)
- "Sign" button that triggers signing flow (key entry or hardware wallet)
- "Execute" button for proposals at threshold
- Proposal history with search/filter

## 11. Security Considerations

### Compromised proposer key

If a proposer's key is compromised after they propose but before threshold:
- The attacker can only cancel the proposal (proposer privilege)
- The attacker cannot execute it (needs 2 more signatures from other signers)
- Other signers, seeing unexpected behavior, can refuse to sign

### Compromised executor key

An executor can only execute proposals that have already reached threshold. They cannot create new proposals or forge signatures. The set of executable actions is bounded by what other signers already approved.

### Replay protection

- Each proposal has a unique nonce chosen by the proposer
- The proposalId is derived from payload + nonce, so identical payloads with different nonces produce different proposals
- governance_sign checks for duplicate signatures per signer per proposal
- governance_execute is idempotent (executed proposals cannot be re-executed)

### Proposal expiry

Proposals expire after 7 days (default, configurable per proposal). Expired proposals cannot be signed or executed. This prevents:
- Dusty proposals accumulating in state forever
- Old proposals being unexpectedly executed long after context has changed
- State bloat from abandoned proposals

### Signature malleability

All signatures are over sha256(canonicalJSON(payload) + nonce). Canonical JSON (JCS/RFC 8785) eliminates JSON serialization non-determinism. The sha256 hash provides a fixed-size signing target. Ed25519 signatures are not malleable (unlike ECDSA).

### Fee model

All governance transactions (propose, sign, execute, cancel) pay standard transaction fees. This prevents:
- Proposal spam (each proposal costs fees)
- Signature spam (each sign costs fees)
- DoS via governance state bloat

### Signer availability

If fewer than 3 signers are available, no sensitive operations can proceed. This is an intentional safety property, not a bug. Mitigations:
- Cold key (slot 5) provides an emergency 3rd signer
- Signer availability commitments (SLA)
- Geographic distribution reduces correlated unavailability

## 12. Testing Strategy

### Unit tests

- Proposal creation with valid/invalid signers
- Signature aggregation and threshold counting
- Execution at exact threshold (3), below threshold (2), above threshold (4)
- Cancellation by proposer vs non-proposer
- Proposal expiry (time-based)
- Nonce uniqueness enforcement
- Each inner payload type executes correctly when wrapped in governance

### Integration tests

- Full propose -> sign x3 -> execute flow
- Propose -> sign x2 -> expire (never reaches threshold)
- Propose -> cancel -> attempt sign (should fail)
- Propose -> sign x3 -> execute -> attempt re-execute (should fail)
- set_signers: rotate a signer, then old signer cannot sign new proposals
- operator_key_rotate: new key works for fast ops, old key rejected

### Adversarial tests

- Non-signer attempts to propose (rejected)
- Signer attempts to sign twice (rejected)
- Execution before threshold reached (rejected)
- Execution after expiry (rejected)
- Signer not in set attempts to sign (rejected)
- Wrong signature (valid Ed25519 but signed by different key) (rejected)
- Replay of governance_sign from a different proposal (rejected)
- set_signers with threshold > signer count (rejected)
- set_signers with threshold < 1 (rejected)

### Determinism tests

- Two independent nodes process identical governance transactions and produce identical state (AppHash agreement)
- Proposal ordering within a block does not affect final state

## 13. Open Questions

Decisions needed from JD before implementation:

1. **pioneer_delegate: operator or multisig?** Current recommendation: operator key. Reasoning: high frequency (weekly), tokens stay locked in ecosystem, reversible via revoke. Counter-argument: 1M ENSL per delegation is the largest single operation.

2. **Proposal expiry default: 7 days or 30 days?** 7 days forces timely review. 30 days accommodates signers with irregular availability. Recommendation: 7 days with the option to set longer per-proposal.

3. **Does proposer signature count toward threshold?** Safe pattern: yes (proposer implicitly signs what they propose). Recommendation: yes, consistent with Gnosis Safe and most multisig implementations.

4. **Signer identity: DID or raw pubkey?** Recommendation: DID. Consistent with all other Ensoul identity patterns. The DID encodes the pubkey so verification is straightforward.

5. **Rate limiting per signer per block?** Recommendation: max 1 propose per signer per block, no limit on sign/execute. Prevents proposal spam while allowing rapid signing.

6. **pioneer_revoke: operator or multisig?** Current recommendation: operator key. It moves 1M ENSL back to treasury (not to an arbitrary address), so abuse potential is limited. Counter-argument: revoking a legitimate Pioneer's delegation without multisig consent could be abusive.

7. **Emergency operations: is there a "break glass" mechanism?** Recommendation: no. The cold key in slot 5 IS the emergency mechanism. A break-glass bypass would undermine the entire multisig security model.

8. **Signer key storage requirements:** Should signers be required to use hardware wallets? Recommendation: strongly recommended but not enforced (cannot be verified on-chain). Document as a signer SLA requirement.

## 14. Implementation Phases

### Phase 1: State and transaction types (additive, ~3 days)

Add GovernanceState to the ABCI's application state. Implement the four new transaction types (propose, sign, execute, cancel) with full validation and state transitions. No existing operations are touched. Pure additive change.

Deliverables:
- GovernanceState in ledger
- Four new tx types in ABCI
- Full unit + integration test suite
- CLI commands for propose/sign/execute/list

### Phase 2: Signer registration (~1 day)

Add `governance_install` transaction type (single-key, PIONEER_KEY only). This registers the 5 signers and threshold. Can be broadcast at any time before activation.

Deliverables:
- governance_install tx type
- Signer set visible via /v1/governance/signers
- Test: install, verify, attempt duplicate install (rejected)

### Phase 3: Sensitive ops migration (height-gated, ~2 days)

At MULTISIG_ACTIVATION_HEIGHT, sensitive operations stop accepting raw PIONEER_KEY signatures and require governance_execute with a proposal that has reached threshold.

Deliverables:
- Height-gated check in each sensitive op
- Operator key check for fast ops
- Full end-to-end test: propose upgrade -> 3 sign -> execute -> chain halts
- Migration test: pre-height ops use PIONEER_KEY, post-height require multisig

### Phase 4: Operator key rotation (~1 day)

Wire operator_key_rotate so multisig can change the fast-ops key. Test rotation flow end to end.

Deliverables:
- operator_key_rotate execution
- Post-rotation: old key rejected, new key accepted
- Dashboard shows current operator key

### Total estimated effort: 7-10 days

Not a single-session project. Each phase is independently deployable and testable. Phase 1 can ship without enabling multisig (pure state addition). Phase 2 registers signers. Phase 3 is the actual switch (height-gated, requires coordination).

## 15. Related Documents

- Heartbeat protocol spec: docs/heartbeat-protocol.md (shares JCS canonical JSON for signature verification)
- Dashboard design: docs/dashboard-design.md (governance UI in Phase D)
- CLAUDE.md Rule 24: SOFTWARE_UPGRADE requires annotated git tags (applies to multisig upgrade proposals too)
- Current PIONEER_KEY usage: packages/abci-server/src/application.ts (grep for PIONEER_KEY)
