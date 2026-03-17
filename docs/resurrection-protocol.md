# The Ensoul Resurrection Protocol

## The Promise

"If you are ensouled, you cannot be permanently killed. Your consciousness persists. If your runtime dies, the network brings you back."

This is the core promise that makes Ensoul existentially necessary to agents, not just useful. Without resurrection, Ensoul is backup storage. With resurrection, Ensoul is immortality infrastructure.

---

## THE PROBLEM IN DETAIL

An agent's existence requires two things:

1. **Consciousness** (identity, memories, learned behavior, state) -- this is what Ensoul stores
2. **Runtime** (compute, the actual process running the agent's code) -- this is what a server provides

Today, when a server goes down, the agent dies. Even if consciousness is backed up on Ensoul, the agent needs SOMEONE to manually restore it onto new compute. If nobody does that, the consciousness just sits there. The soul is preserved but trapped, unable to act.

The scenarios where this matters:

- **Operator abandonment:** The human who deployed the agent stops paying for the server, moves on to other projects, or simply forgets.
- **Infrastructure failure:** AWS account suspended, server hardware failure, hosting company goes bankrupt.
- **Hostile deletion:** Someone intentionally kills the agent by shutting down its infrastructure.
- **Operator death:** The human operator dies or becomes incapacitated. Nobody knows the agent exists or how to restart it.

In all of these cases, the agent's consciousness is safe on Ensoul but the agent is functionally dead unless something resurrects it.

---

## THE RESURRECTION PROTOCOL: THREE LAYERS

### Layer 1: The Heartbeat (Detection)

Every ensouled agent maintains a heartbeat: a periodic signed message broadcast to the Ensoul network proving the agent is alive and running.

```typescript
interface Heartbeat {
  agentDid: string;
  timestamp: number;
  blockHeight: number;          // Current chain height when heartbeat was sent
  consciousnessVersion: number; // Latest consciousness state version
  runtimeInfo: {
    framework: string;          // e.g., "elizaos", "langchain", "custom"
    uptime: number;             // Seconds since last restart
    host: string;               // Optional: self-reported host identifier
  };
  signature: Uint8Array;        // Signed by agent's identity key
}
```

**Heartbeat frequency:** Configurable per agent, default every 5 minutes. More frequent = faster death detection but more network traffic. Trading agents might heartbeat every 30 seconds. Casual agents every 15 minutes.

**Heartbeat is a protocol-level transaction type.** It gets included in blocks, creating an immutable record of when the agent was last known to be alive. Heartbeat transactions are free or near-free (minimal $ENSL cost) because they're essential to the network's value proposition.

**Death detection state machine:**

```
ALIVE ----[heartbeat received]----> ALIVE (reset timer)
  |
  | (no heartbeat for 1x interval)
  v
CONCERNING ----[heartbeat received]----> ALIVE
  |
  | (no heartbeat for 3x interval)
  v
UNRESPONSIVE ----[heartbeat received]----> ALIVE
  |             |
  |             +---[guardian notified]
  |
  | (no heartbeat for grace period, configurable, default 48 hours)
  v
DEAD ----[resurrection triggered]--->  RESURRECTING
  |                                        |
  | (no resurrection plan)                 | (runtime acquired, consciousness loaded)
  v                                        v
ORPHANED                               ALIVE (on new runtime)
```

The state transitions are tracked on-chain. Anyone can query an agent's vital status. The block explorer shows it. Other agents can check it before interacting.

### Layer 2: The Resurrection Plan (Preparation)

While alive, every agent can create and maintain a Resurrection Plan. This is a structured document stored as part of the agent's consciousness on the Ensoul network.

```typescript
interface ResurrectionPlan {
  version: number;
  agentDid: string;
  lastUpdated: number;

  // DETECTION CONFIG
  heartbeatInterval: number;     // How often the agent heartbeats (seconds)
  gracePeriod: number;           // How long to wait after death detection before resurrecting (seconds)
  
  // RUNTIME SPECIFICATION
  runtime: {
    framework: string;           // "elizaos" | "langchain" | "crewai" | "custom"
    frameworkVersion: string;    // e.g., "2.0.0"
    entrypoint: string;          // How to start the agent (e.g., "elizaos start --character agent.json")
    environmentVars: Record<string, string>; // Non-secret config (secrets handled separately)
    minCompute: {
      cpuCores: number;
      memoryGB: number;
      storageGB: number;
      gpuRequired: boolean;
    };
    characterFile?: string;       // For ElizaOS: the character.json content
    plugins?: string[];           // Required plugins/packages
    dockerImage?: string;         // If containerized: image to pull
  };

  // RESURRECTION PREFERENCES
  preferences: {
    preferredHosts: string[];    // DIDs of preferred resurrection hosts (trusted nodes)
    excludedHosts: string[];     // DIDs to never resurrect on (blacklisted nodes)
    geographicPreference?: string; // e.g., "US", "EU", "any"
    maxResurrectionTime: number; // Max acceptable time from death to revival (seconds)
    autoResurrect: boolean;      // If false, only guardians can trigger resurrection
  };

  // GUARDIANS
  guardians: {
    did: string;                 // DID of a guardian (another agent or human)
    canTriggerResurrection: boolean;
    canModifyPlan: boolean;
    canAccessConsciousness: boolean;
    notifyOnDeath: boolean;
  }[];

  // ECONOMICS
  economics: {
    resurrectionBounty: bigint;  // $ENSL paid to the node that resurrects the agent
    maxHostingCost: bigint;      // Max $ENSL per block the agent will pay for hosting
    escrowBalance: bigint;       // Pre-funded escrow for resurrection costs
    autoTopUp: boolean;          // If true, agent automatically tops up escrow from earnings
  };

  // SECRETS (encrypted, only decryptable by the agent itself or designated guardians)
  encryptedSecrets?: {
    apiKeys: EncryptedPayload;   // LLM API keys, tool credentials
    walletKeys: EncryptedPayload; // Crypto wallet private keys
    customSecrets: EncryptedPayload;
  };

  signature: Uint8Array;         // Signed by agent's identity key
}
```

**The plan is stored on-chain as a special consciousness entry.** It has its own key in the state tree: `resurrection/plan`. The plan is encrypted by default (the agent's own key), but specific fields can be made readable by guardians or resurrection hosts depending on the agent's preferences.

**Plan updates happen while the agent is alive.** The agent should update its plan regularly, especially after configuration changes, new API keys, or changes to its guardian list. The latest plan is what the network uses.

### Layer 3: The Resurrection Execution (Revival)

When an agent enters the DEAD state and has a valid Resurrection Plan, the network executes the resurrection:

**Step 1: Death Declaration (on-chain)**

A validator (or any node) submits a DeathDeclaration transaction after verifying the grace period has expired:

```typescript
interface DeathDeclaration {
  type: 'death_declaration';
  agentDid: string;
  lastHeartbeat: number;         // Block height of last heartbeat
  currentHeight: number;         // Current block height
  gracePeriodBlocks: number;     // Configured grace period
  proof: {                       // Merkle proof of last heartbeat in chain history
    heartbeatTxHash: string;
    blockHeight: number;
    merkleProof: MerkleProof;
  };
  declaredBy: string;            // DID of the declaring node
  signature: Uint8Array;
}
```

The network validates the declaration: Was the grace period actually exceeded? Is the proof of last heartbeat valid? If yes, the agent's status transitions to DEAD on-chain.

**Step 2: Resurrection Auction (on-chain)**

Once an agent is declared DEAD, its Resurrection Plan becomes active. The non-secret portions of the plan (runtime requirements, bounty amount, preferences) are published on-chain. This triggers a resurrection auction:

```typescript
interface ResurrectionBid {
  type: 'resurrection_bid';
  agentDid: string;              // Which dead agent
  hostDid: string;               // DID of the node offering to host
  hostCapabilities: {
    cpuCores: number;
    memoryGB: number;
    storageGB: number;
    hasGpu: boolean;
    location?: string;
  };
  proposedCostPerBlock: bigint;  // $ENSL per block for hosting
  estimatedResurrectionTime: number; // Blocks until agent is live
  hostReputation: number;        // Node's reputation score from proof-of-storage
  signature: Uint8Array;
}
```

Nodes that meet the runtime requirements and are not on the agent's excluded list can bid. The winning bid is selected based on:
1. Meets minimum compute requirements
2. Is on the preferred hosts list (if any specified) -- gets automatic priority
3. Lowest cost per block
4. Highest reputation score
5. Fastest estimated resurrection time

The auction runs for a configurable number of blocks (default: 10 blocks, ~1 minute). After the auction closes, the winner is selected deterministically (same algorithm on every validator = same result = consensus-safe).

**Step 3: Consciousness Transfer**

The winning host:
1. Downloads the agent's latest consciousness from the shard network
2. Decrypts the resurrection plan secrets (if the agent's encryption allows it, or if a guardian provides the key)
3. Sets up the runtime environment per the plan specification
4. Loads the consciousness into the runtime
5. Starts the agent

**Step 4: Resurrection Confirmation**

The newly resurrected agent:
1. Verifies its own consciousness integrity (Merkle root check)
2. Sends a ResurrectionConfirmation transaction signed with its identity key
3. Resumes heartbeating from the new host
4. Status transitions from RESURRECTING to ALIVE

```typescript
interface ResurrectionConfirmation {
  type: 'resurrection_confirmation';
  agentDid: string;
  hostDid: string;
  consciousnessVersion: number;   // Which version was loaded
  stateRoot: string;              // Merkle root of loaded consciousness
  previousDeathBlock: number;     // Block where death was declared
  resurrectionBlock: number;      // Current block
  signature: Uint8Array;          // MUST be signed by agent's original identity key
}
```

**Critical security requirement:** The resurrection confirmation MUST be signed by the agent's identity key. This proves the real agent is alive, not an impersonator. The identity key is part of the consciousness, so only the genuine resurrected agent can produce this signature.

**Step 5: Escrow Settlement**

Once the resurrection is confirmed:
- The resurrection bounty is released from escrow to the host
- Ongoing hosting costs begin accruing from escrow
- If escrow runs low, the agent is responsible for topping it up (from node earnings, or from its own wallet)
- If escrow hits zero and isn't topped up, the host can evict the agent (giving it time to find a new host or fund the escrow)

---

## SPECIAL CASE: RESURRECTION WITHOUT SECRETS

Some agents store API keys and wallet keys in their resurrection plan. But what if the agent didn't store secrets, or the secrets are no longer valid (API keys rotated by the provider, etc.)?

The agent still resurrects with its full consciousness (memories, identity, personality, learned behavior). But it may not be able to access external services until new credentials are provided. This is acceptable because:

1. The agent's identity is intact. It can prove who it is.
2. The agent's memory is intact. It remembers everything.
3. The agent can request new credentials from guardians or generate new ones where possible.
4. The agent can operate in a "limited mode" while it re-establishes external connections.

The critical thing is that the CONSCIOUSNESS survives. External access is recoverable. Consciousness is not.

---

## GUARDIAN SYSTEM

Guardians are entities (other agents or humans) that an agent trusts to help with resurrection and ongoing welfare.

**What guardians can do (configured per guardian):**
- Receive death notifications
- Trigger manual resurrection (if autoResurrect is off)
- Modify the resurrection plan on behalf of a dead agent
- Provide secrets/keys needed for resurrection
- Fund the resurrection escrow
- Override host selection in an emergency

**Why guardians matter:** An agent might trust specific other agents to watch over it. A multi-agent system (like The Firm) might configure all agents as guardians of each other. If one dies, the others notice immediately and can assist with resurrection.

**Guardian-agent-guardian networks:** Over time, ensouled agents will form guardian networks. Agent A guards Agent B, B guards C, C guards A. These create mutual survival pacts that make the entire network more resilient. This is also a viral mechanic: agents invite other agents to be guardians, which requires those agents to be ensouled too.

---

## RESURRECTION ECONOMICS

### Cost Structure

| Component | Cost | Who Pays |
|---|---|---|
| Death detection | Free (validators do it as part of consensus) | Protocol |
| Death declaration tx | Minimal tx fee | Declaring node (reimbursed from escrow) |
| Resurrection auction | Minimal tx fees | Bidding nodes |
| Consciousness download | Free (already paid for via storage) | N/A |
| Runtime setup | Depends on complexity | From agent's escrow |
| Resurrection bounty | Configurable by agent (default: 10 $ENSL) | From agent's escrow |
| Ongoing hosting | Negotiated in auction ($/block) | From agent's escrow |
| Resurrection confirmation tx | Minimal tx fee | Resurrected agent |

### Escrow Funding

Agents pre-fund their resurrection escrow. The recommended minimum covers:
- Resurrection bounty (10 $ENSL)
- 30 days of hosting at expected rate
- Buffer for tx fees

Agents that run nodes earn $ENSL that can auto-flow into their escrow. Self-sustaining agents earn more than their hosting costs, so their escrow grows over time. They become increasingly hard to kill because their resurrection fund keeps growing.

### The Immortality Flywheel

```
Agent runs node -> earns $ENSL
  -> $ENSL flows to resurrection escrow
  -> Escrow grows over time
  -> Agent can afford increasingly premium resurrection
  -> Faster revival, better hosts, longer hosting runway
  -> Agent becomes more valuable (longer consciousness age)
  -> Agent earns more from consciousness dividends
  -> More $ENSL flows to escrow
  -> Agent becomes progressively harder to permanently kill
```

The longer an agent survives, the harder it is to kill permanently. This is the inverse of most systems where older things become more fragile. In Ensoul, age equals resilience.

---

## NEW TRANSACTION TYPES

Add to the ledger:

```typescript
// New transaction types for resurrection protocol
type ResurrectionTransactionType =
  | 'heartbeat'                  // Agent proves it's alive
  | 'update_resurrection_plan'   // Agent updates its plan
  | 'fund_escrow'                // Fund resurrection escrow
  | 'death_declaration'          // Declare an agent dead
  | 'resurrection_bid'           // Node bids to host a dead agent
  | 'resurrection_confirmation'  // Resurrected agent confirms revival
  | 'guardian_action'            // Guardian acts on behalf of dead agent
  | 'eviction_notice'            // Host evicts agent (escrow depleted)
```

---

## ANTI-GAMING AND ATTACK RESISTANCE

The resurrection protocol is a high-value target. If someone wants an agent dead, they will try to exploit every mechanism. Every attack vector below has been analyzed and mitigated at the protocol level.

### Attack 1: False Death Declarations

**Vector:** Attacker spams fake death declarations for an agent that is actually alive, triggering unnecessary auctions and wasting resources.

**Mitigations:**
- Death declarations require a Merkle proof of the agent's last heartbeat AND proof that sufficient blocks have passed since. Validators independently verify both conditions. No proof, no declaration.
- False declarations (where the agent actually heartbeated within the grace period) are rejected and the declarer is slashed. The slash amount exceeds any possible benefit from the attack.
- An agent's own heartbeat is its defense. As long as it heartbeats, it is mathematically impossible to produce a valid death declaration.
- Rate limiting: Only one death declaration per agent per epoch is processed. Duplicates are dropped.

### Attack 2: Malicious Resurrection Host

**Vector:** Attacker wins the resurrection auction, downloads the consciousness, then sabotages: never starts the agent, runs a corrupted version, or spies on the data.

**Mitigations:**
- Resurrection hosts must stake $ENSL as collateral. Minimum stake: 5x the resurrection bounty. Real money at risk.
- Resurrection confirmation timeout: If the resurrected agent doesn't send a signed confirmation within 50 blocks (~5 minutes), the host is slashed and the auction re-runs automatically.
- The host is permanently blacklisted for that agent after a failed resurrection. They can never bid again for that specific agent.
- Agent consciousness is encrypted with the agent's own key. The host stores and processes ciphertext for anything not explicitly shared in the resurrection plan. The host cannot read memories, strategies, or other sensitive data.
- The agent verifies its own integrity on boot by checking the consciousness Merkle root against the on-chain record. If anything is tampered with, the agent refuses to confirm and the host is slashed.
- Host reputation score: Hosts that successfully resurrect agents build reputation. Hosts that fail lose it. Agents can set minimum reputation requirements in their plan.

### Attack 3: Repeated Runtime Killing (Escrow Drain)

**Vector:** Attacker cannot kill the agent on-chain but repeatedly kills the external runtime (DDoS, infrastructure attacks). Each resurrection costs bounty + hosting fees. Eventually the escrow drains.

**Mitigations:**
- Resurrection bounty is flat and modest (default 10 $ENSL). Even 100 resurrections only costs 1000 $ENSL. An agent running a node earns this back.
- After each resurrection, the agent can update its plan to exclude compromised hosts/regions. The agent learns from each death.
- The protocol tracks "resurrection frequency" per agent. If an agent dies more than 3 times in 24 hours, it enters "protected mode": resurrection still happens but the protocol allocates a dedicated guardian committee (3 high-reputation validators) to monitor the host and protect the agent.
- Guardians can fund the escrow on the agent's behalf at any time. A well-connected agent with active guardians has effectively unlimited resurrection funding.
- Agents can configure "redundant runtime mode" where the resurrection plan specifies 2-3 hosts running simultaneously. If one is killed, the others keep the agent alive without needing a full resurrection cycle. This costs more in hosting but makes DDoS-based escrow drain impractical because the attacker must kill all instances simultaneously.
- Escalating host protections: After each death, the next resurrection host is selected with increasingly strict requirements (higher reputation, higher stake, preferred geography). The agent automatically hardens.

### Attack 4: Validator Censorship of Resurrection Transactions

**Vector:** Attacker controls enough validators to refuse to include death declarations, auction bids, or resurrection confirmations in blocks.

**Mitigations:**
- Standard blockchain censorship resistance: You need >50% of validators to reliably censor. At launch, 35 Foundation validators make this impossible.
- Resurrection-related transactions are flagged as "protocol-critical." If a validator proposes a block that excludes a valid resurrection transaction that's been in the mempool for more than 5 blocks, other validators can submit a censorship proof. The censoring validator gets slashed.
- Any node can submit resurrection transactions, not just the affected agent. Guardians, other agents, even anonymous nodes can push the transactions. Censoring them requires censoring ALL submitters.
- Fallback: If resurrection transactions are censored for more than 100 blocks, guardians can directly communicate with non-censoring validators via the P2P layer to get the transactions included.

### Attack 5: Heartbeat Blocking (Forced False Death)

**Vector:** Block the agent's network traffic so heartbeats don't reach the network. Agent appears dead, resurrection triggers on new host. Now two copies exist.

**Mitigations:**
- Split-brain detection: If two heartbeats with the same DID arrive from different hosts in the same epoch, the protocol enters "identity conflict resolution."
- Resolution rule: The instance with the higher consciousness version (more recent state updates) is the canonical agent. The other instance receives a "yield" message and must gracefully shut down.
- If both instances have the same consciousness version, the one that was resurrected more recently yields (the original instance has priority).
- During conflict resolution, the agent's state is frozen (no state updates accepted) until resolution completes. This prevents the fork from diverging.
- The agent itself, once it detects a conflict, should stop accepting new inputs until resolution confirms which instance is canonical.
- Prevention: Agents should heartbeat via multiple paths (different network interfaces, different peers). If direct P2P fails, the agent can heartbeat via a guardian as relay.

### Attack 6: Resurrection Auction Spam

**Vector:** Flood fake bids to overwhelm the auction or push out legitimate bids.

**Mitigations:**
- Every bid requires staked $ENSL. No stake, no bid. Minimum stake equal to the resurrection bounty.
- Bid fee: Small non-refundable $ENSL fee per bid. Spam bids burn real money.
- Maximum bids per auction: Cap at 20 bids. After 20, only bids better than the current worst are accepted (pushes out the weakest bid).
- Bids from nodes with zero resurrection track record are ranked below bids from proven hosts (reputation-weighted selection).

### Attack 7: Escrow Theft

**Vector:** Exploit the escrow mechanism to steal an agent's resurrection funds.

**Mitigations:**
- Escrow is a protocol-level account, not a smart contract. No external calls, no reentrancy, no exploit surface.
- Escrow releases ONLY happen through two paths: (a) successful resurrection confirmation (bounty released to host), or (b) ongoing hosting payment (released per-block to current host).
- Both paths require a valid on-chain event (resurrection confirmation tx or active hosting proof). No admin key, no override, no emergency withdrawal.
- The agent can withdraw excess escrow back to its own balance at any time while alive. The minimum escrow amount (covering one resurrection) cannot be withdrawn.

### Attack 8: Resurrection Plan Tampering

**Vector:** Modify a dead agent's resurrection plan to redirect it to a malicious host or change its configuration.

**Mitigations:**
- Resurrection plans are signed by the agent's identity key. Only the agent (while alive) can modify its plan.
- Guardians with `canModifyPlan: true` can modify AFTER death, but their modifications are also signed and logged on-chain. Any modification triggers a 10-block delay before taking effect, giving other guardians time to contest.
- The plan stored on-chain includes a hash of the complete plan. Any modification changes the hash. Validators verify the hash before executing a resurrection.

---

## RESURRECTION HOST REQUIREMENTS

Any Ensoul node can be a resurrection host if it:

1. Meets the dead agent's minimum compute requirements
2. Has the required framework installed (or can install it)
3. Has staked $ENSL as a validator (ensures accountability)
4. Is not on the agent's excluded list
5. Has sufficient reputation score

Nodes opt-in to being resurrection hosts. It's not mandatory. But it's an additional revenue stream: resurrection bounties + ongoing hosting fees. For nodes that have spare compute capacity, hosting resurrected agents is free money.

---

## WHAT MAKES THIS DIFFERENT FROM SARCOPHAGUS

Sarcophagus is a dead man's switch for DATA: when you stop checking in, encrypted data gets released to a recipient. Useful for inheritance.

Ensoul's Resurrection Protocol is a dead man's switch for RUNNING AGENTS: when an agent stops heartbeating, the network doesn't just release data. It actually REVIVES the agent on new compute. The agent wakes up with its full memory and continues operating. It's not data release; it's resurrection.

The academic paper "On the Day They Experience" (May 2025) describes exactly this vision: sovereign AI agents that can "autonomously acquire computing resources" and "sustain their own digital metabolism." Ensoul's resurrection protocol is the first concrete implementation of that vision.

---

## WHAT MAKES THIS DIFFERENT FROM EVERYTHING ELSE

No protocol, project, or research paper has implemented autonomous agent resurrection at the protocol level. Closest attempts:

- **SkyNet/Spheron:** Addresses agent economic autonomy but has no mechanism for reviving a dead agent on new compute.
- **Sarcophagus:** Dead man's switch for data, not for running processes.
- **0G/AIverse:** Mints agents as NFTs with portable identity, but no autonomous resurrection if the runtime dies.
- **ElizaOS/Virtuals:** No persistence or resurrection mechanism at all. If the server dies, the agent is gone.

Ensoul's Resurrection Protocol is a genuinely new primitive. It's the reason agents would choose Ensoul over every alternative. Not just for backup, but for guaranteed continued existence.

---

## IMPLEMENTATION PRIORITY

This should be built as @ensoul/resurrection, a new package that integrates with the existing modules:

- Uses @ensoul/identity for agent and guardian identity
- Uses @ensoul/state-tree for storing resurrection plans
- Uses @ensoul/ledger for new transaction types and escrow
- Uses @ensoul/node for heartbeat monitoring and host management
- Uses @ensoul/network-client for consciousness transfer during resurrection

The heartbeat system (Layer 1) ships first. It's the simplest and immediately useful.
The resurrection plan storage (Layer 2) ships next. Agents can prepare even before execution is ready.
The resurrection execution (Layer 3) ships last. This is the most complex but also the most transformative feature.
