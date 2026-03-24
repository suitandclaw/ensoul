# CometBFT Migration Plan

## Overview

Replace the custom TypeScript consensus engine with CometBFT v0.38.x (the Go binary). The TypeScript application becomes an ABCI 2.0 server that CometBFT calls via Unix socket when blocks are decided.

**Why**: The custom consensus engine has been unstable. Over 48 hours we hit: block floods, chain stalls, genesis format mismatches, star topology relay failures, dry-run state divergence, missing round catch-up, missing vote rebroadcast, and a commit logic bug where 4/4 votes fail to commit. CometBFT solves all of these -- battle-tested for 7+ years securing billions in value.

## Architecture: Before vs After

### Before (Custom Consensus)

```
 +------------------+     +------------------+
 | TypeScript Node  |<--->| TypeScript Node  |
 |                  |     |                  |
 | - Custom BFT     |     | - Custom BFT     |
 | - Custom P2P     |     | - Custom P2P     |
 | - Custom WAL     |     | - Custom WAL     |
 | - App Logic      |     | - App Logic      |
 | - Block Store    |     | - Block Store    |
 +------------------+     +------------------+
        ^                        ^
        |   Cloudflare Tunnels   |
        v                        v
 +------------------+     +------------------+
 | TypeScript Node  |<--->| TypeScript Node  |
 +------------------+     +------------------+
```

Everything in one process. Consensus, networking, storage, and application logic are tightly coupled.

### After (CometBFT + ABCI)

```
 +-------------+  Unix Socket  +------------------+
 | CometBFT    |<=============>| TS ABCI Server   |
 | (Go binary) |               |                  |
 | - BFT       |               | - App Logic      |
 | - P2P/Gossip|               | - State Machine  |
 | - WAL       |               | - Account State  |
 | - Block DB  |               | - Emission       |
 | - Mempool   |               | - Delegations    |
 | - Fast Sync |               | - Agent Identity |
 | - State Sync|               | - Consciousness  |
 +-------------+               +------------------+
       |
       | Tendermint P2P (native)
       v
 +-------------+  Unix Socket  +------------------+
 | CometBFT    |<=============>| TS ABCI Server   |
 +-------------+               +------------------+
```

CometBFT handles consensus, P2P, block storage. The ABCI server handles application logic only. Each machine runs both processes.

## ABCI 2.0 Method Mapping

### Startup

| ABCI Method | Ensoul Implementation |
|---|---|
| **Info** | Return app version, last committed height, last app hash (state root) |
| **InitChain** | Process genesis: distribute 1B ENSL across allocations, auto-stake foundation validators, return initial validator set (4 validators, power 10 each) |

### Block Lifecycle (called by CometBFT for each block)

| ABCI Method | Ensoul Implementation |
|---|---|
| **CheckTx** | Validate transaction before mempool admission: check nonce, balance, signature, type-specific rules (13 tx types) |
| **PrepareProposal** | Order transactions for block proposal. Apply per-identity limits (max 10 txs per sender per block). Add block_reward transaction. |
| **ProcessProposal** | Validate proposed block: verify transactions are valid, block reward is correct |
| **FinalizeBlock** | Execute all transactions in the decided block. Update account balances, staking, delegations, consensus set. Compute emission (~19 ENSL/block year 1, 75% decay per year). Return updated validator set if consensus_join/consensus_leave txs processed. |
| **Commit** | Persist state to disk. Return app_hash (Blake3 of account state + consensus set + delegation root). |

### Queries

| ABCI Method | Ensoul Implementation |
|---|---|
| **Query** | Handle queries: account balance, agent lookup, validator info, chain stats. Replaces current /peer/status and explorer API calls. |

## Transaction Types (13 total)

All preserved unchanged:

| Type | Description | Key Validation |
|---|---|---|
| transfer | Token transfer | balance >= amount, from != to |
| stake | Lock tokens as validator stake | balance >= amount |
| unstake | Begin unstaking (cooldown) | stakedBalance >= amount, lockup expired |
| storage_payment | Pay for storage credits | balance >= amount |
| reward_claim | Claim pending rewards | pendingRewards > 0 |
| block_reward | Protocol emission | from = REWARDS_POOL (protocol only) |
| genesis_allocation | Initial distribution | Protocol only |
| delegate | Delegate to validator | balance >= amount, min 100 ENSL |
| undelegate | Begin undelegation | delegatedBalance >= amount |
| slash | Slash validator stake | from = PROTOCOL_TREASURY only |
| burn | Remove from circulation | to = BURN_ADDRESS |
| consensus_join | Join validator set | stakedBalance > 0 |
| consensus_leave | Leave validator set | Must be in set |

## What Gets REMOVED

| Component | File(s) | Replacement |
|---|---|---|
| Custom BFT consensus engine | `packages/node/src/chain/tendermint.ts` | CometBFT binary |
| Custom P2P relay layer | `packages/node/src/chain/peer-network.ts` | CometBFT P2P |
| Star topology cross-relay | `peer-network.ts` relay methods | CometBFT gossip |
| Vote broadcasting/rebroadcast | `tendermint.ts` + `peer-network.ts` | CometBFT gossip |
| Custom WAL | None (we didn't have one) | CometBFT WAL |
| Custom proposer rotation | `tendermint.ts` getProposer() | CometBFT proposer selection |
| Custom timeout management | `tendermint.ts` timeouts | CometBFT timeouts |
| Gossip network | `packages/node/src/chain/gossip.ts` | CometBFT mempool |
| Block store (custom) | `packages/node/src/chain/store.ts` | CometBFT block DB |
| Peer status polling | `peer-network.ts` pollPeers() | CometBFT peer management |
| /peer/consensus-state endpoint | `peer-network.ts` | CometBFT RPC /consensus_state |
| /peer/blocks sync endpoint | `peer-network.ts` | CometBFT fast sync |
| /peer/consensus POST | `peer-network.ts` | CometBFT gossip |

## What STAYS

| Component | File(s) | Changes Needed |
|---|---|---|
| Account state machine | `packages/ledger/src/accounts.ts` | None |
| Transaction validation | `packages/ledger/src/transactions.ts` | Wire to CheckTx |
| Transaction application | `packages/ledger/src/transactions.ts` | Wire to FinalizeBlock |
| Block reward / emission | `packages/ledger/src/blocks.ts` computeBlockReward() | Wire to FinalizeBlock |
| Delegation registry | `packages/ledger/src/delegations.ts` | None |
| State root computation | `accounts.ts` computeStateRoot() | Wire to Commit (app_hash) |
| Genesis config/allocations | `packages/ledger/src/genesis.ts` | Wire to InitChain |
| Agent identity (DID) | `packages/identity/` | None |
| Consciousness persistence | Various | None |
| Explorer UI | `packages/explorer/` | Query CometBFT RPC instead of custom endpoints |
| Monitor UI | `packages/monitor/` | Query CometBFT RPC |
| API gateway | `packages/api/` | Query CometBFT RPC |
| Bootstrap scripts | `scripts/` | Adapt for CometBFT node setup |
| Moltbook agent | `ensoul-moltbook-agent/` | None |

## CometBFT Genesis Mapping

CometBFT genesis.json structure:

```json
{
  "genesis_time": "2026-03-23T00:00:00Z",
  "chain_id": "ensoul-1",
  "initial_height": "1",
  "consensus_params": {
    "block": { "max_bytes": "1000000", "max_gas": "-1" },
    "evidence": { "max_age_num_blocks": "100000" },
    "validator": { "pub_key_types": ["ed25519"] }
  },
  "validators": [
    { "address": "...", "pub_key": { "type": "tendermint/PubKeyEd25519", "value": "base64..." }, "power": "10", "name": "v0" },
    { "address": "...", "pub_key": { ... }, "power": "10", "name": "v1" },
    { "address": "...", "pub_key": { ... }, "power": "10", "name": "v2" },
    { "address": "...", "pub_key": { ... }, "power": "10", "name": "v3" }
  ],
  "app_state": {
    "chainId": "ensoul-1",
    "totalSupply": "1000000000000000000000000000",
    "allocations": [ ... ],
    "emissionPerBlock": "19025875190258751",
    "networkRewardsPool": "500000000000000000000000000",
    "protocolFees": { "storageFeeProtocolShare": 10, "txBaseFee": "1000" }
  }
}
```

Key mapping:
- `validators` -- CometBFT uses Tendermint address (first 20 bytes of SHA256 of pubkey) and base64-encoded Ed25519 pubkeys. Our DIDs encode the same Ed25519 keys in multicodec format. We need a conversion layer.
- `app_state` -- passed to InitChain. Contains our GenesisConfig as-is.
- `consensus_params` -- CometBFT manages block size, evidence age, validator key types.

## ABCI Server Implementation Plan

### Package: packages/abci-server

```
packages/abci-server/
  src/
    index.ts          -- Entry point, start gRPC server
    server.ts         -- ABCI method implementations
    state.ts          -- Application state (wraps AccountState, DelegationRegistry)
    genesis.ts        -- InitChain handler
    tx.ts             -- CheckTx + FinalizeBlock tx processing
    query.ts          -- Query handler
    protobuf/         -- Generated types from CometBFT .proto files
  proto/
    types.proto       -- Copied from CometBFT
    abci.proto        -- Copied from CometBFT
  package.json
  tsconfig.json
```

### Protobuf Strategy

CometBFT .proto files are at:
- `github.com/cometbft/cometbft/proto/cometbft/abci/v1/types.proto` (ABCI v1)
- `github.com/cometbft/cometbft/proto/tendermint/abci/types.proto` (legacy)

Use `ts-proto` to generate TypeScript types. Implement a gRPC server using `@grpc/grpc-js` that CometBFT connects to via `proxy_app = "grpc://127.0.0.1:26658"` in config.toml.

Alternative: Unix socket via `proxy_app = "unix:///tmp/ensoul-abci.sock"`. Simpler, no port management.

### Transport Decision

**Unix socket** is recommended:
- No port conflicts
- Faster than TCP (no network stack)
- CometBFT supports it natively
- Config: `proxy_app = "unix:///tmp/ensoul-abci.sock"`

However, the `js-abci` library (github.com/tendermint/js-abci) uses raw TCP with length-delimited protobuf, not gRPC. CometBFT supports both transports:
1. **Socket (ABCI socket)**: Length-delimited protobuf over TCP/Unix. This is what js-abci uses.
2. **gRPC**: Standard gRPC. Requires implementing the full protobuf service definition.

For a TypeScript server, option 1 (socket transport) is simpler. We can fork/adapt js-abci to support ABCI 2.0 methods. The protocol is: 4-byte length prefix + protobuf message.

## Data Migration Strategy

### Option A: Fresh Start (Recommended for testnet)

1. Export all agent registrations and consciousness stores from the current chain
2. Create new CometBFT genesis with all current balances as app_state
3. Start fresh chain from height 0
4. Re-register agents via bootstrap script

### Option B: State Migration (Required for mainnet)

1. Snapshot current AccountState at a known height
2. Encode as CometBFT app_state in genesis
3. Include all account balances, staking, delegations as-is
4. Height starts at 0 but state reflects accumulated history

Recommendation: Option A for initial deployment (we are still testnet). Option B design for future mainnet migration.

## Deployment Order

1. **Build and test ABCI server locally** (MBP only)
2. **Run CometBFT + ABCI server alongside existing chain** (no disruption)
3. **Verify 1000+ blocks locally** with full tx processing
4. **Adapt explorer, monitor, API** to query CometBFT RPC
5. **Deploy to Mini 1** (single remote validator)
6. **Form 2-node testnet** (MBP + Mini 1)
7. **Deploy to Mini 2 and Mini 3**
8. **Full 4-node CometBFT network running**
9. **Decommission custom consensus code**

## Rollback Plan

- Keep the existing custom consensus code intact during migration
- CometBFT runs on different ports (26656 P2P, 26657 RPC, 26658 ABCI)
- If CometBFT migration fails: stop CometBFT, restart custom validators
- No data is shared between old and new chains (separate block stores)
- Rollback is instant: kill CometBFT processes, start old validators

## External Validator Onboarding (Post-Migration)

After CometBFT migration, new validators:
1. Install CometBFT binary
2. Install Node.js + ABCI server package
3. Receive genesis.json from us
4. Configure persistent_peers to include our 4 nodes
5. Start CometBFT + ABCI server
6. Submit consensus_join transaction (handled by ABCI server)
7. Existing validators vote to include them (via validator set updates in FinalizeBlock)

This is identical to how Cosmos Hub validators onboard -- standard, documented, well-understood.

## Timeline Estimate

| Phase | Duration | Description |
|---|---|---|
| ABCI server skeleton | 1 day | Protobuf setup, stub methods, CometBFT handshake |
| InitChain + genesis | 1 day | Process genesis allocations, return validator set |
| CheckTx + FinalizeBlock | 2 days | All 13 tx types, emission, delegation rewards |
| Commit + Query | 1 day | State persistence, balance/agent queries |
| Explorer/Monitor/API adaptation | 1 day | Switch from custom endpoints to CometBFT RPC |
| Local testing (1000+ blocks) | 1 day | Stability, emission correctness, state root consistency |
| Multi-node deployment | 1 day | Deploy across 4 machines, verify consensus |
| Agent re-registration | 0.5 days | Run bootstrap-agents.sh on new chain |
| Buffer | 1.5 days | Unexpected issues, edge cases |
| **Total** | **~10 days** | |

## Phase 3 Integration Test Results (2026-03-24)

All tests passed. Summary:

| Test | Result |
|---|---|
| Transaction validation (transfer, stake, consensus_join, storage) | PASS: all correctly rejected with proper errors when accounts lack funds |
| State queries (/stats, /validators, /balance) | PASS: correct data returned via CometBFT ABCI query |
| Validator count | PASS: 4 validators in consensus set |
| Block production (30 second window) | PASS: 29 blocks produced (stable ~1 block/sec) |
| Emission verification | PASS: ratio 0.999 (1065 emitted vs ~1066 expected at height 56) |
| 250+ block stability | PASS: 4756 ENSL emitted over 250 blocks, zero crashes |
| State persistence | PASS: state.json written with all account data |
| Restart recovery | PASS: loaded height=58 from disk, CometBFT continued at 59 (no full replay) |
| Deterministic replay | PASS: full block replay produces identical state (no app_hash mismatches) |

### Validator Key Conversion

10 Ensoul Ed25519 keys converted to CometBFT priv_validator_key.json format.
Round-trip verified: CometBFT produced blocks using converted key.
Script: `scripts/convert-keys-to-cometbft.ts`

## Key Risks

1. **Protobuf compatibility**: CometBFT's protobuf schema evolves between versions. Pin to v0.38.x exactly.
2. **Ed25519 key format**: CometBFT uses raw 32-byte pubkeys, we use DID:key with multicodec prefix. Need bidirectional conversion.
3. **State root divergence**: If the ABCI server's app_hash computation differs between nodes by even 1 bit, CometBFT halts the chain. Blake3 determinism must be verified across platforms.
4. **BigInt serialization**: ENSL amounts are bigints. Protobuf uses int64/uint64 or bytes. Need consistent encoding.
5. **Block reward timing**: In the current system, block_reward is computed during produceBlock. In ABCI, it happens in FinalizeBlock. The timing difference must not affect emission calculations.
