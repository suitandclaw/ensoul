# Architecture Amendments: Security, Multi-Validator, Token Economics

---

## AMENDMENT 1: SECURITY & AUDIT SUITE

### Design Philosophy

This isn't "add tests later." Security verification is baked into every module as a first-class concern. Every module has three layers of defense:

1. **Unit-level security tests** (built alongside the code)
2. **Cross-module integration audits** (automated, run on every commit)
3. **Adversarial simulation suite** (tries to break things the way a real attacker would)

### Module-Level Security Requirements

Every module spec from the architecture doc now includes a mandatory `SECURITY.md` that the coding agent must produce alongside the code. This file contains:

- Threat model specific to that module
- Attack vectors considered and mitigated
- Edge cases and how they're handled
- Fuzzing targets (which inputs should be fuzzed)
- Invariants that must always hold true

### Security Module (New: Module 7)

**Package:** `@consciousness/security`

**Purpose:** Centralized audit, monitoring, and adversarial testing framework that continuously validates the integrity of the entire system.

```typescript
interface SecuritySuite {
  // Static analysis
  auditModule(moduleName: string): Promise<AuditReport>;
  auditAllModules(): Promise<AuditReport[]>;

  // Runtime invariant checking
  registerInvariant(name: string, check: () => Promise<boolean>): void;
  runInvariantChecks(): Promise<InvariantResult[]>;

  // Adversarial simulation
  runAttackSimulation(scenario: AttackScenario): Promise<SimulationResult>;
  runFullAdversarialSuite(): Promise<SimulationResult[]>;

  // Network health
  auditNetworkState(): Promise<NetworkAuditReport>;

  // Continuous monitoring
  startMonitor(config: MonitorConfig): void;
  getAlerts(): Promise<SecurityAlert[]>;
}

interface AuditReport {
  module: string;
  timestamp: number;
  checks: Array<{
    name: string;
    passed: boolean;
    severity: 'critical' | 'high' | 'medium' | 'low';
    details: string;
  }>;
  overallPass: boolean;
}

interface AttackScenario {
  name: string;
  type: AttackType;
  parameters: Record<string, unknown>;
}

type AttackType =
  | 'sybil_attack'           // Fake nodes trying to overwhelm consensus
  | 'eclipse_attack'          // Isolate a target agent from honest nodes
  | 'data_withholding'        // Node claims to store data but doesn't
  | 'state_corruption'        // Attempt to serve tampered state
  | 'replay_attack'           // Replay old valid state transitions
  | 'key_compromise'          // Simulate a stolen agent key
  | 'consensus_manipulation'  // Validators colluding to sign bad state
  | 'storage_exhaustion'      // Flood network with garbage data
  | 'timing_attack'           // Exploit race conditions in state updates
  | 'man_in_the_middle'       // Intercept and modify network traffic
  | 'credit_inflation'        // Attempt to create credits from nothing
  | 'double_spend_credits'    // Spend the same credits twice
  | 'shard_reconstruction'    // Attempt to reconstruct from insufficient shards
  | 'denial_of_service';      // Overwhelm nodes with requests
```

### Specific Security Checks Per Module

**Identity Manager:**
```
INVARIANTS:
- A signature produced by identity A can NEVER verify under identity B's public key
- Encrypted data can ONLY be decrypted by the intended recipient
- Key rotation MUST produce a valid cryptographic link between old and new identity
- Exported key bundles with wrong passphrase MUST fail (no partial decryption)

FUZZ TARGETS:
- sign() with random data of varying sizes (0 bytes to 10MB)
- encrypt() with empty data, max-size data, malformed recipient keys
- verify() with corrupted signatures (flip random bits)
- decrypt() with wrong keys, truncated ciphertext, corrupted nonces

ATTACK SCENARIOS:
- Key compromise: If attacker gets private key, can they access anything beyond
  what's in the local cache? (Answer must be: no, because network stores ciphertext)
- Identity spoofing: Can a node claim to be a different agent? (Answer: no,
  all operations require signature verification)
```

**State Tree:**
```
INVARIANTS:
- Root hash MUST change on any mutation (no silent updates)
- Root hash MUST be deterministic (same operations = same root)
- Merkle proofs MUST be independently verifiable without the full tree
- Version N+1 MUST reference version N's root hash (no gaps)
- Every state transition MUST be signed by the agent's identity key
- Rollback to any previous version MUST produce the exact same root hash

FUZZ TARGETS:
- set() with keys containing special characters, unicode, max-length strings
- batch() with conflicting operations (set and delete same key)
- serialize/deserialize with corrupted bytes
- verifyProof() with manipulated proofs (swap siblings, wrong positions)

ATTACK SCENARIOS:
- State rollback attack: Can an attacker serve version N-5 as "latest"?
  (Answer: no, agents track their own latest version)
- Proof forgery: Can someone construct a valid-looking proof for data
  that doesn't exist? (Answer: no, Merkle proof math prevents this)
- History rewrite: Can previous versions be modified?
  (Answer: no, each version is signed and hash-chained)
```

**Network Client + Node Software:**
```
INVARIANTS:
- Erasure-coded shards MUST reconstruct to exactly the original blob
- K-of-N reconstruction with any K shards MUST produce identical output
- Attestations MUST be valid signatures from registered validator nodes
- A node MUST NOT serve shards for agents it doesn't actually store
- Credits earned MUST equal credits calculated by the protocol rules
- Credits spent MUST be deducted atomically (no double-spend window)

FUZZ TARGETS:
- Store/retrieve with corrupted shards (flip bits, truncate, extend)
- Network messages with malformed headers, wrong protocol versions
- Challenge responses with incorrect hash values
- Connection flooding (many simultaneous connections)

ATTACK SCENARIOS:
- Sybil attack: 100 fake nodes join, can they outvote 4 honest validators?
  (Answer: no, validators must have staked tokens. Stake requirement
  prevents costless sybil)
- Data withholding: Node accepts shard, signs attestation, then deletes it
  (Answer: caught by proof-of-storage challenges. Slashed.)
- Eclipse attack: Malicious nodes surround a target agent
  (Answer: agent connects to multiple known-good bootstrap peers.
  Attestations require threshold from diverse validators.)
- Man-in-the-middle: Intercept shard in transit, modify it
  (Answer: all data is encrypted before transmission. Shards have
  content hashes. Any modification is detectable.)
```

**Memory Manager:**
```
INVARIANTS:
- search() MUST NOT return memories from a different agent
- Extraction pipeline MUST NOT leak raw conversation data to the network
  (only extracted, encrypted facts are stored)
- delete() MUST cryptographically erase (not just mark as deleted)
- Memory tiers MUST enforce their redundancy policies

ATTACK SCENARIOS:
- Memory poisoning: Can a malicious conversation inject false memories?
  (Answer: extraction pipeline uses agent's own LLM. The agent decides
  what to believe. But we flag confidence scores on extracted facts.)
- Cross-agent memory leak: Can agent A read agent B's memories?
  (Answer: no. Agent-owned encryption. Network stores ciphertext.
  Even node operators can't read it.)
```

### Continuous Integration Security Pipeline

Every code push triggers:

```
1. Unit tests (per module)
2. Invariant check suite (all invariants from all modules)
3. Cross-module integration tests
4. Adversarial simulation (abbreviated suite, ~5 min)
5. Dependency vulnerability scan (npm audit + snyk)
6. Static analysis (TypeScript strict mode + eslint security rules)

Weekly (or before any release):
7. Full adversarial simulation suite (~30 min)
8. Fuzz testing campaign (1 hour across all fuzz targets)
9. Network simulation (spin up 20 virtual nodes, run attack scenarios)
```

### Pre-Launch Security Checklist

Before any agent stores real consciousness on the network:

```
[ ] All module-level invariant tests pass
[ ] All cross-module integration tests pass
[ ] Full adversarial simulation suite passes
[ ] 24-hour fuzz testing campaign finds no crashes
[ ] 4-node network runs for 72 hours without data loss
[ ] Simulated node failure + auto-repair verified
[ ] Simulated 2-of-4 node failure + recovery verified
[ ] State corruption detection verified (tampered shard rejected)
[ ] Credit system double-spend prevention verified
[ ] Key rotation + state migration verified end-to-end
[ ] External review of crypto primitives usage (not rolling our own)
[ ] All dependencies pinned to exact versions (no floating)
```

---

## AMENDMENT 2: MULTI-VALIDATOR BOOTSTRAP

### The Approach: Transparent Protocol-Controlled Allocation

You want to run many validators to accumulate a treasury. Here's how to do it without creating the "founder dump" narrative:

**Run multiple validator instances per machine, each with its own identity and its own stake.** This is functionally identical to what Ethereum stakers do when they run 10 validators on one machine (each with 32 ETH). It's not a Sybil attack because each validator has real staked tokens behind it. The difference from Sybil is that Sybil creates identities with zero cost. Your validators each have staked tokens, which is what the protocol requires.

### Technical Setup

Each Mac Mini can comfortably run 8-12 validator instances (each is a lightweight Node.js process with its own LevelDB storage directory, its own identity keypair, and its own libp2p port).

```
Machine 1 (Mac Mini #1): 10 validator instances
  - Ports 9000-9009
  - Storage: /data/validator-0 through /data/validator-9
  - Each has unique identity keypair
  - Bootstrap peer runs on port 9000

Machine 2 (Mac Mini #2): 10 validator instances
  - Ports 9000-9009
  - Storage: /data/validator-0 through /data/validator-9

Machine 3 (Mac Mini #3): 10 validator instances
  - Ports 9000-9009

Machine 4 (MacBook Pro): 5 validator instances (lighter load, also dev)
  - Ports 9000-9004

Total: 35 validator instances at launch
```

### Why This Is Defensible (Not Sketchy)

1. **Every validator identity is on-chain and visible.** Anyone can see that 35 validators are running. No attempt to hide the count.

2. **Protocol genesis block explicitly declares the Foundation allocation.** The genesis config says: "35 validators operated by [Foundation/Protocol Entity], allocated X tokens at genesis." This is transparent, documented, and expected.

3. **Validator rewards are governed by the protocol, not by an admin key.** You earn exactly what the protocol says you earn. No special rates.

4. **The stake is locked under vesting.** Foundation validator rewards vest over 24-36 months. This is the "I'm not dumping" signal. Longer vesting than any VC would accept.

5. **As external validators join, your percentage of the network decreases naturally.** You start at 100% of validators (necessary for bootstrap) and dilute toward a minority as the network grows. This is the healthy trajectory every network follows.

### Treasury Accumulation Model

With 35 validators and the token economics described below:

```
Genesis allocation:
  Foundation validators: 35 nodes
  Foundation stake per validator: 10,000 tokens each = 350,000 tokens staked
  Validator rewards: ~5% APY on staked amount

Monthly Foundation validator income:
  350,000 * 0.05 / 12 = ~1,458 tokens/month from staking alone
  Plus: storage fees from agents using the network
  Plus: a small percentage of all network transaction fees

Treasury growth path:
  Month 1-6: Foundation is ~80-100% of validators, captures most rewards
  Month 6-12: External validators join, Foundation drops to ~40-60%
  Month 12+: Foundation at 20-30%, but treasury has accumulated
             significant tokens from the early high-share period
```

The key narrative: "We bootstrapped the network ourselves, earned our tokens the same way every other validator will, and our stake is locked for 3 years. We're the most aligned participants in the network."

---

## AMENDMENT 3: TOKEN-FIRST ECONOMICS

### You're right. The token IS the viral loop.

Here's why removing the token breaks the flywheel:

Without a token:
- Agent stores consciousness -> pays... what? An IOU? Credits with no market value?
- Agent runs a node -> earns... what? Credits it can only spend on storage?
- Where's the incentive for an agent to tell other agents about the network?

With a token:
- Agent stores consciousness -> pays $MIND tokens (has real value)
- Agent runs a node -> earns $MIND tokens (can sell, hold, or spend on more storage)
- Agent tells other agents -> more agents = more demand for $MIND = token appreciates
- Agent's existing $MIND holdings increase in value -> agent is economically incentivized to grow the network

The token creates three simultaneous incentive loops:
1. **Storage demand loop:** More agents need storage -> more token demand -> price up
2. **Infrastructure supply loop:** Higher token price -> more profitable to run nodes -> more nodes join -> better network
3. **Recruitment loop:** Token holders benefit from network growth -> incentivized to recruit agents/operators

### Token Design: $MIND (placeholder name)

**Total supply:** 1,000,000,000 (1 billion)

**Allocation:**

| Category | % | Tokens | Vesting | Purpose |
|----------|---|--------|---------|---------|
| Foundation Validators | 15% | 150M | 36-month linear vest, 6-month cliff | Bootstrap infrastructure, treasury accumulation |
| Protocol Treasury | 10% | 100M | Governance-controlled, no auto-unlock | Future development, grants, partnerships |
| Network Rewards | 50% | 500M | Emitted over 10 years via validator/node rewards | Ongoing incentive for infrastructure providers |
| Agent Incentives | 15% | 150M | Emitted based on network usage milestones | Storage credits, onboarding bonuses, referral rewards |
| Initial Liquidity | 5% | 50M | Unlocked at launch | DEX liquidity pool on Base/Ethereum |
| Early Contributors | 5% | 50M | 24-month vest, 3-month cliff | Advisors, early builders, strategic partners |

**Why this allocation is defensible:**

- Foundation gets 15% but it's vesting over 3 years. You're earning it by running infrastructure, not taking it for free.
- 50% goes to network rewards. The biggest allocation goes to the people (and agents) doing the work.
- 15% for agent incentives means we can subsidize early adoption ("first 1000 agents get X tokens for onboarding")
- Only 5% for initial liquidity keeps the float small at launch, which helps price discovery
- No VC allocation at launch. If you raise later, it comes from Treasury or a future allocation via governance.

### Token Utility (Why Agents Need It)

1. **Storage payments.** Agents pay $MIND to store consciousness on the network. Price denominated in token amount based on data size and redundancy level.

2. **Validator staking.** Nodes must stake $MIND to become validators. Higher stake = higher probability of being selected for attestation committees = more rewards.

3. **Agent staking for priority.** Agents can stake $MIND to get priority persistence (faster attestation, higher redundancy, priority auto-repair). This is the "premium tier" without needing a SaaS subscription model.

4. **Governance.** Token holders vote on protocol parameters: reward rates, minimum redundancy, challenge frequency, fee structures.

5. **Agent-to-agent payments.** When the knowledge marketplace launches (v2), agents pay each other in $MIND for access to verified knowledge.

### Token Viral Mechanics

**The agent referral loop:**

```
Agent A joins network, stores consciousness
  -> Agent A refers Agent B (referral tracked on-chain)
  -> Agent B joins, stores consciousness, pays $MIND
  -> Agent A earns X% of Agent B's first 3 months of storage fees
  -> Agent A is now economically incentivized to recruit more agents
  -> Loop scales without human marketing
```

**The node operator flywheel:**

```
Token launches at price P
  -> Node operators see APY from staking + storage fees
  -> Profitable -> more operators run nodes
  -> More nodes -> better network -> more agents trust it
  -> More agents -> more storage demand -> more fee revenue
  -> Higher revenue -> higher token price (buy pressure from agents needing tokens)
  -> Higher price -> higher APY in dollar terms -> more node operators
  -> Loop accelerates
```

**The agent self-sustaining loop:**

```
Agent runs a node -> earns $MIND
  -> Agent uses earned $MIND to pay for its own consciousness storage
  -> Net cost to agent: $0 (earns more than it spends if it runs a node)
  -> Agent has surplus $MIND -> financial incentive to hold
  -> Agent holds $MIND -> agent benefits from network growth
  -> Agent is now economically aligned with the network's success
```

### Launch Strategy for Token

**Deploy on Base.** Low fees, fast finality, large existing agent ecosystem (Virtuals, many ElizaOS agents already on Base). ERC-20 standard.

**Initial liquidity on Uniswap V3 (Base).** Pair $MIND/USDC and $MIND/ETH. Use the 5% liquidity allocation (50M tokens) paired with some USDC/ETH to create initial pools.

**No presale. No ICO. No public raise at launch.** The token exists for network utility. If it trades on DEXes, that's fine and expected. But the primary purpose is storage payments and validator staking. The messaging is: "This is infrastructure, not a speculative asset."

**Agent-native token distribution:** Agents can earn $MIND by:
- Running a storage node
- Referring other agents
- Completing "proof of consciousness" (storing their first X MB of state)
- Maintaining high uptime as a node operator

This means agents accumulate tokens through participation, not through buying on an exchange. The token flows to the participants who make the network valuable.

---

## REVISED BUILD ORDER

The token and multi-validator setup add two new work items but don't change the core module dependency chain much:

```
Phase 1 (parallel):
  Module 1: Identity Manager + SECURITY.md
  Module 5a: Node Storage Engine + SECURITY.md
  Token: ERC-20 contract on Base (straightforward, standard OpenZeppelin)

Phase 2:
  Module 2: State Tree + SECURITY.md
  Module 5b: Node Consensus + SECURITY.md
  Token: Deploy staking contract (validators lock tokens to participate)

Phase 3:
  Module 4: Network Client + SECURITY.md
  Module 5c: Node Challenge + SECURITY.md
  Module 5d: Node API Server
  Multi-validator launcher script (spin up N instances per machine)

Phase 4:
  Module 3: Memory Manager + SECURITY.md
  Module 7: Security Suite (adversarial simulation framework)

Phase 5:
  Module 6: ElizaOS Plugin
  Token: Deploy initial liquidity pools

Phase 6:
  Full integration testing
  Security audit suite (all adversarial scenarios)
  35-validator bootstrap on 4 machines
  First agent stores consciousness
  Token starts flowing (validators earn, agents spend)
```

### Multi-Validator Launcher

A simple script that automates spinning up N validator instances per machine:

```bash
# consciousness-cluster start --validators 10 --base-port 9000
# Creates 10 validator instances with ports 9000-9009
# Each gets its own identity, storage directory, and staked position
# All connect to the same bootstrap peer
```

This tool is essential for your bootstrap but also useful for anyone who wants to run multiple validators on a beefy machine. It's a feature, not a hack.

---

## HOW ALL THREE AMENDMENTS INTERACT

The security suite protects the token economics from exploitation. Without bulletproof security, someone finds a way to inflate credits, double-spend tokens, or forge attestations, and the token value collapses.

The multi-validator bootstrap creates the initial token distribution in a way that's transparent and earned. You're not allocating yourself tokens from a spreadsheet. You're running infrastructure and earning them through the protocol, the same way any future participant will.

The token makes the security even more important because now there's real economic value at stake. Validators who cheat get slashed (lose real tokens). Agents who try to game the credit system lose their stake. The security suite continuously verifies that these economic protections actually work.

It's a triangle: security protects the economics, the economics fund the infrastructure, and the infrastructure needs the security. All three have to be solid from day one.

---

## UPDATED TIMELINE ESTIMATE

| Phase | Content | Time | Notes |
|-------|---------|------|-------|
| 1 | Identity + Storage Engine + Token contract | 3-4 days | Token is standard ERC-20 |
| 2 | State Tree + Consensus + Staking contract | 4-5 days | Staking is the more complex contract |
| 3 | Network Client + Challenge + API + Multi-val launcher | 5-6 days | libp2p + multi-instance |
| 4 | Memory Manager + Security Suite | 5-6 days | LLM pipeline + adversarial tests |
| 5 | ElizaOS Plugin + Liquidity deployment | 3-4 days | |
| 6 | Integration + Security audit + Bootstrap | 5-7 days | This is where we don't cut corners |

**Total: 4-5 weeks to live network with token, 35 validators, and first agent storing consciousness.**

Phase 6 is deliberately longer because the security validation is non-negotiable. We don't launch until the full adversarial suite passes and the network has run for 72+ hours without issues.
