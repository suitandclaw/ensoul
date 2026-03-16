# Ensoul Native L1: $ENSL as Native Token

## WHAT WE ALREADY BUILT (AND WHAT IT REALLY IS)

Looking at the 7 modules, we already have the bones of an L1:

| L1 Component | What We Have | Module |
|---|---|---|
| Identity / Accounts | Ed25519 keypairs, DIDs | @ensoul/identity |
| State storage | Merklized key-value store with signed transitions | @ensoul/state-tree |
| P2P networking | libp2p with TCP, mDNS, KAD-DHT | @ensoul/network-client |
| Data persistence | LevelDB shard storage with integrity checks | @ensoul/node (storage) |
| Consensus | Validator attestations, K-of-N threshold | @ensoul/node (consensus) |
| Proof-of-work verification | Proof-of-storage challenges with reputation | @ensoul/node (challenge) |
| API layer | REST + WebSocket with auth | @ensoul/node (api) |

What's MISSING to make this a real L1 with a native token:

| Missing Component | What It Does |
|---|---|
| Account ledger | Tracks $ENSL balances for every identity |
| Transaction types | Transfer, stake, pay-storage, claim-rewards |
| Transaction pool (mempool) | Queues pending transactions |
| Block production | Packages transactions into blocks on a cadence |
| Block validation | Other validators verify proposed blocks |
| Genesis block | Initial token distribution (the allocations we defined) |
| Emission schedule | Releases new tokens to validators over time |
| Slashing | Penalizes misbehaving validators |
| Bridge contract | Lock/mint on Ensoul, mint/burn on Ethereum/Base |

## NEW MODULE: @ensoul/ledger

This is the core addition. A native token ledger that lives inside the Ensoul network.

### Transaction Types

```typescript
type TransactionType =
  | 'transfer'          // Send $ENSL from one identity to another
  | 'stake'             // Lock tokens as validator stake
  | 'unstake'           // Begin unstaking (with unbonding period)
  | 'storage_payment'   // Agent pays for consciousness storage
  | 'reward_claim'      // Validator claims earned rewards
  | 'slash'             // Protocol slashes a misbehaving validator
  | 'burn'              // Permanently remove tokens (buyback-and-burn)

interface Transaction {
  type: TransactionType;
  from: string;          // DID of sender
  to: string;            // DID of recipient (or protocol address for burns)
  amount: bigint;        // Amount in smallest unit (like wei for ETH)
  nonce: number;         // Sender's transaction counter (prevents replay)
  timestamp: number;
  data?: Uint8Array;     // Optional payload (e.g., storage metadata)
  signature: Uint8Array; // Signed by sender's identity key
}
```

### Account State

```typescript
interface Account {
  did: string;
  balance: bigint;           // Available $ENSL
  stakedBalance: bigint;     // Locked in validator stake
  nonce: number;             // Transaction counter
  storageCredits: bigint;    // Pre-paid storage (from storage_payment txs)
  lastActivity: number;      // Timestamp of last transaction
}
```

### Ledger Interface

```typescript
interface Ledger {
  // Account operations
  getAccount(did: string): Promise<Account>;
  getBalance(did: string): Promise<bigint>;

  // Transaction operations
  submitTransaction(tx: Transaction): Promise<TxReceipt>;
  getTransaction(txHash: string): Promise<Transaction | null>;

  // Block operations
  getBlock(height: number): Promise<Block>;
  getLatestBlock(): Promise<Block>;
  getBlockHeight(): Promise<number>;

  // Staking
  getValidatorSet(): Promise<ValidatorInfo[]>;
  getStake(did: string): Promise<bigint>;

  // Emission
  getPendingRewards(did: string): Promise<bigint>;
  getTotalSupply(): Promise<bigint>;
  getCirculatingSupply(): Promise<bigint>;
}
```

### Block Structure

```typescript
interface Block {
  height: number;
  previousHash: string;
  stateRoot: string;        // Merkle root of all account states
  transactionsRoot: string; // Merkle root of all transactions in block
  timestamp: number;
  proposer: string;         // DID of the validator who proposed this block
  transactions: Transaction[];
  attestations: Attestation[]; // Validator signatures confirming the block
}
```

### Block Production

Every X seconds (configurable, start with 6 seconds like Ethereum):

1. A validator is selected to propose a block (round-robin at bootstrap, VRF at scale)
2. Proposer collects pending transactions from the mempool
3. Proposer validates each transaction (sufficient balance, valid signature, correct nonce)
4. Proposer packages valid transactions into a block
5. Proposer computes new state root after applying all transactions
6. Proposer signs the block and broadcasts to peers
7. Other validators verify the block and sign attestations
8. When K-of-N attestations are collected, block is finalized

For the 35-validator bootstrap, this is straightforward. Round-robin proposer selection. 3-second block time is achievable on a LAN. Finality in one block since all validators are honest at launch.

### Genesis Block

```typescript
const GENESIS: GenesisConfig = {
  chainId: 'ensoul-1',
  timestamp: Date.now(),
  totalSupply: 1_000_000_000n * 10n**18n, // 1B tokens, 18 decimals

  allocations: [
    {
      label: 'Foundation Validators',
      percentage: 15,
      tokens: 150_000_000n * 10n**18n,
      vestingMonths: 36,
      cliffMonths: 6,
      recipients: [/* 35 validator DIDs */]
    },
    {
      label: 'Protocol Treasury',
      percentage: 10,
      tokens: 100_000_000n * 10n**18n,
      vestingMonths: 0, // Governance-controlled
      controller: 'governance'
    },
    {
      label: 'Network Rewards',
      percentage: 50,
      tokens: 500_000_000n * 10n**18n,
      vestingMonths: 0, // Emitted per block via emission schedule
      controller: 'emission_schedule'
    },
    {
      label: 'Agent Onboarding',
      percentage: 10,
      tokens: 100_000_000n * 10n**18n,
      vestingMonths: 0, // Milestone-based release
      controller: 'governance'
    },
    {
      label: 'Initial Liquidity',
      percentage: 5,
      tokens: 50_000_000n * 10n**18n,
      vestingMonths: 0, // Unlocked at launch for bridge + DEX
      recipient: 'bridge_reserve'
    },
    {
      label: 'Early Contributors',
      percentage: 5,
      tokens: 50_000_000n * 10n**18n,
      vestingMonths: 24,
      cliffMonths: 3
    },
    {
      label: 'Insurance Reserve',
      percentage: 5,
      tokens: 50_000_000n * 10n**18n,
      vestingMonths: 0, // Governance-controlled
      controller: 'governance'
    }
  ],

  emissionSchedule: {
    // Tokens released per block from Network Rewards pool
    // Declining curve: halves roughly every 3 years
    year1PerBlock: calculatePerBlock(100_000_000n, 6), // ~100M tokens in year 1
    halvingInterval: 365 * 24 * 60 * 10, // Blocks per ~3 years at 6s blocks
  },

  protocolFees: {
    storageFeeProtocolShare: 10, // 10% to protocol treasury
    txFeeProtocolShare: 50,      // 50% to protocol treasury
    txBaseFee: 1000n,            // Base fee per transaction in smallest unit
  }
};
```

### Emission Schedule

Network Rewards (500M tokens) are released over ~10 years with a declining curve:

```
Year 1:  100M tokens (~19 $ENSL per block at 6s blocks)
Year 2:   80M tokens (~15.2 per block)
Year 3:   60M tokens (~11.4 per block)
Year 4:   50M tokens (~9.5 per block)
Year 5:   45M tokens (~8.5 per block)
Year 6:   40M tokens (~7.6 per block)
Year 7:   35M tokens (~6.6 per block)
Year 8:   30M tokens (~5.7 per block)
Year 9:   30M tokens (~5.7 per block)
Year 10:  30M tokens (~5.7 per block)
Total:   500M tokens
```

Block rewards are split among validators proportional to their stake.

### Protocol Fee Flow (Native)

When an agent pays for storage:
```
Agent submits storage_payment transaction for 100 $ENSL
  -> 10 $ENSL goes to Protocol Treasury account (10%)
  -> 90 $ENSL goes to Node Reward Pool
  -> Node Reward Pool distributes to nodes holding shards proportionally
```

When the buyback-and-burn activates:
```
Protocol Treasury accumulates fees
  -> 40% stays in Operations account (for eventual governance distribution)
  -> 40% is burned (transfer to burn address, permanently removed from supply)
  -> 20% goes to Insurance Reserve account
```

All of this happens as native transactions on the Ensoul chain. No smart contracts needed. These are protocol-level operations, like how Ethereum handles block rewards and fee burns natively.

---

## BRIDGE DESIGN: ENSOUL <-> ETHEREUM/BASE

### Why Bridge?

The native token lives on Ensoul. But agents and humans need to buy $ENSL somewhere, and the deepest liquidity for trading is on Ethereum DEXes. The bridge is the on-ramp.

### How It Works

**Lock-and-Mint model:**

```
Ensoul -> Ethereum direction:
1. User locks X $ENSL in the Bridge Reserve account on Ensoul chain
2. Bridge validators observe the lock transaction
3. When K-of-N bridge validators confirm, they sign a mint authorization
4. On Ethereum/Base, a wrapped $wENSL ERC-20 token is minted to the user's ETH address
5. $wENSL trades on Uniswap like any ERC-20

Ethereum -> Ensoul direction:
1. User burns X $wENSL on Ethereum by sending to the bridge contract
2. Bridge validators observe the burn event
3. When K-of-N confirm, they sign an unlock authorization
4. On Ensoul chain, X $ENSL is unlocked from Bridge Reserve to the user's Ensoul DID
```

**Bridge validators = Ensoul validators.** The same 35 nodes that validate the Ensoul chain also validate bridge transactions. No separate bridge infrastructure needed. This is the same model Cosmos uses with IBC: the validator set of the source chain attests to cross-chain messages.

### What Gets Deployed on Ethereum/Base

One simple contract:

```solidity
// Wrapped ENSL on Ethereum/Base
contract WrappedENSL is ERC20, ERC20Burnable {
    // Mint: called by bridge multisig when tokens locked on Ensoul
    function mint(address to, uint256 amount) external onlyBridge;

    // Burn: user calls to initiate transfer back to Ensoul
    function bridgeToEnsoul(string calldata ensoulDid, uint256 amount) external;
}
```

The bridge multisig is controlled by K-of-N Ensoul validators. At bootstrap (35 validators), a 5-of-7 multisig of the top-staked validators controls the bridge contract. As the validator set grows, the multisig expands.

### Bridge is a Phase 2 Feature

For launch, the native token on the Ensoul chain is sufficient. Validators earn $ENSL, agents spend $ENSL, the economy runs. The bridge to Ethereum/Base comes when there's demand for external trading. This could be month 2-3, not day 1.

---

## IMPLEMENTATION PLAN

### What to build now (one Claude Code session):

**@ensoul/ledger** - New package:
- Account state management (balances, nonces, stakes)
- Transaction types and validation
- Mempool (pending transaction queue)
- Block production and validation
- Genesis block initialization
- Emission schedule
- Protocol fee splitting
- Slashing logic

### What to modify:

**@ensoul/node** - Add block production loop:
- Select proposer per round
- Collect transactions from mempool
- Produce block
- Broadcast block to peers
- Validate incoming blocks from other proposers
- Apply finalized blocks to ledger state

**@ensoul/node (API)** - Add endpoints:
- POST /transactions (submit a transaction)
- GET /accounts/:did (get account balance and info)
- GET /blocks/:height (get block by height)
- GET /blocks/latest (get latest block)
- GET /chain/status (chain height, validator count, supply info)

**@ensoul/network-client** - Add:
- Transaction broadcast to peers
- Block propagation protocol
- Block sync for new nodes joining the network

### What to build later (Phase 2):

**@ensoul/bridge** - Ethereum/Base bridge:
- Lock/unlock on Ensoul side
- ERC-20 wrapper contract on Ethereum/Base
- Bridge validator multisig
- Relay service that watches both chains

---

## WHY THIS IS BETTER THAN AN ERC-20

1. **Sovereignty.** Ensoul's economic layer cannot be censored, paused, or modified by any external chain. If Ethereum has a bug or Base changes policy, Ensoul is unaffected.

2. **Native fee structure.** Storage payments, validator rewards, and protocol fees are all native operations. No smart contract gas overhead. No dependency on Ethereum gas prices.

3. **Aligned validator incentives.** Validators earn the native token for both block production AND storage attestation. One unified incentive model instead of split attention between two chains.

4. **Agent-native.** Agents interact with one chain, one token, one set of endpoints. No bridging required for core operations. Simpler SDK, fewer failure points.

5. **Narrative.** "Ensoul is the sovereign chain for agent consciousness" is dramatically more compelling than "Ensoul is a storage layer with an ERC-20 on Base."

6. **Value capture.** All transaction fees, storage fees, and economic activity accrue directly to the Ensoul network and $ENSL holders. Nothing leaks to Ethereum validators or Base sequencers.
