# Security: @ensoul/ledger

## Threat Model

The ledger is the economic foundation of the Ensoul L1 chain. It manages all $ENSL token balances, validator stakes, block production, and emission. The primary threats are double-spending, unauthorized minting, consensus manipulation, and economic attacks.

**Trust boundary:** The ledger trusts cryptographic primitives (@noble/ed25519, @noble/hashes) and the identity module. It does NOT trust transaction inputs, block proposers, or external state. All transactions are validated before application.

## Attack Vectors & Mitigations

### Double Spending
**Vector:** Attacker submits two transactions spending the same balance.
**Mitigation:** Nonce-based replay protection. Each account has a monotonically incrementing nonce. Transactions must include the current nonce; wrong nonce is rejected. Within a block, transactions are applied sequentially — second spend fails balance check.

### Unauthorized Minting / Credit Inflation
**Vector:** Attacker creates tokens without valid block production.
**Mitigation:** New tokens only enter circulation via the emission schedule (block rewards from the Network Rewards pool). Block rewards are computed deterministically based on height and remaining pool. No other mechanism creates tokens.

### Replay Attack
**Vector:** Attacker replays a valid transaction from a previous block.
**Mitigation:** Nonce is incremented after each transaction. A replayed transaction has an old nonce that doesn't match the account's current nonce and is rejected.

### Block Manipulation
**Vector:** Malicious proposer creates a block with invalid transactions or wrong state root.
**Mitigation:** `validateBlock()` replays all transactions against a state copy and independently computes the expected state root. Wrong state root = block rejected. Invalid transactions within a block cause rejection.

### Slash Abuse
**Vector:** Attacker issues slash transactions to drain validators' stakes.
**Mitigation:** Only the protocol treasury DID (`did:ensoul:protocol:treasury`) can be the `from` address in slash transactions. All other senders are rejected.

### Genesis Manipulation
**Vector:** Modified genesis config gives attacker more initial tokens.
**Mitigation:** `validateGenesis()` verifies allocations sum to exactly 100% and token amounts sum to total supply. Genesis config is deterministic and auditable.

### Storage Fee Stealing
**Vector:** Node operator receives storage payment but doesn't actually store data.
**Mitigation:** Protocol fee splitting is enforced at the ledger level (10% to treasury, 90% to operator). The challenge module separately verifies actual storage via proof-of-storage challenges, with slashing for failures.

## Invariants

1. **Balance conservation:** The sum of all balances + staked balances + burned tokens MUST equal total supply at all times.
2. **Nonce monotonicity:** Account nonces MUST only increment by 1 per transaction. No skips, no resets.
3. **Emission cap:** Total emitted block rewards MUST NOT exceed the Network Rewards pool allocation (500M tokens).
4. **Slash authorization:** Only `PROTOCOL_TREASURY` can initiate slash transactions.
5. **Burn finality:** Tokens sent to `BURN_ADDRESS` are permanently destroyed — never credited.
6. **Block chain integrity:** Each block's `previousHash` MUST equal the hash of the preceding block.
7. **State root determinism:** The same sequence of transactions applied to the same initial state MUST always produce the same state root.
8. **Fee split accuracy:** Storage payments MUST split exactly `storageFeeProtocolShare%` to treasury and the remainder to the operator.

## Fuzz Targets

### Transaction validation
- All 7 transaction types with boundary amounts (0, 1, MAX_SAFE_INTEGER)
- Wrong nonces (past, future, negative)
- Invalid signature bytes (truncated, extended, flipped bits)
- Self-transfers, transfers to protocol addresses

### Block production
- Empty mempool (empty block)
- Mempool with mix of valid and invalid transactions
- Blocks at emission boundary (pool nearly exhausted)

### Genesis
- Allocations that don't sum to 100%
- Token amounts that don't match total supply
- Zero total supply, negative amounts

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Transaction hashing | @noble/hashes | Blake3 |
| Block hashing | @noble/hashes | Blake3 |
| State root computation | @noble/hashes | Blake3 |
| Transaction signing | @noble/ed25519 | Ed25519 (RFC 8032) |
| Signature verification | @noble/ed25519 | Ed25519 (RFC 8032) |

**No custom cryptography is implemented.** All hashing uses Blake3. All signing/verification uses Ed25519.
