# Technical Architecture: Agent Consciousness Network
# Designed for Agentic Development + 4-Machine Bootstrap

---

## DESIGN PRINCIPLES

**1. TypeScript everywhere.** The entire stack is TypeScript/Node.js. This aligns with ElizaOS (the primary integration target), makes the SDK native to the agent framework ecosystem, and means a single language across node software, SDK, and tools. Agentic coding tools (Claude Code, Cursor, etc.) are strongest with TypeScript.

**2. Module boundaries are API contracts.** Each module is a standalone package with a typed interface. This is critical for agentic development: each module can be built and tested independently by a coding agent given only its interface spec and test cases. No module needs to understand the internals of another.

**3. Bootstrap on 4 machines, scale to 10,000.** The architecture must work identically on JD's 3 Mac Minis + MacBook Pro as it will on a global network. No "dev mode" vs "production mode." Same binary, same protocol, same consensus. Just different peer counts.

**4. Maximize use of battle-tested libraries.** We don't write our own cryptography, networking, or erasure coding. We assemble proven primitives: libp2p for networking, tweetnacl/noble for crypto, reed-solomon-erasure for coding, level/rocksdb for local storage.

**5. The network is dumb persistence. The agent is the smart memory manager.** All intelligence (extraction, conflict resolution, search) lives in the SDK on the agent's side. The network stores encrypted blobs and serves them back. This is a fundamental architectural decision that keeps the node software simple and the SDK powerful.

---

## SYSTEM OVERVIEW

```
┌──────────────────────────────────────────────────────────────────┐
│                        AGENT SDK (TypeScript)                     │
│                                                                    │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Memory       │  │ Extraction   │  │ Identity                 │ │
│  │ Manager      │  │ Pipeline     │  │ Manager                  │ │
│  │              │  │              │  │                          │ │
│  │ add()        │  │ LLM-powered  │  │ Keypair generation       │ │
│  │ search()     │  │ fact extract │  │ DID management           │ │
│  │ get_all()    │  │ Conflict     │  │ Key rotation             │ │
│  │ delete()     │  │ resolution   │  │ Signing                  │ │
│  │ promote()    │  │ Summarize    │  │                          │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘ │
│         │                 │                        │               │
│  ┌──────┴─────────────────┴────────────────────────┴─────────────┐ │
│  │                    Local State Cache                           │ │
│  │  Hot cache (LevelDB): frequently accessed memories            │ │
│  │  Vector index (local): semantic search over cached memories   │ │
│  │  Graph index (local): relationship traversal over cache       │ │
│  └──────────────────────────┬────────────────────────────────────┘ │
│                              │                                     │
│  ┌──────────────────────────┴────────────────────────────────────┐ │
│  │                    Network Client                             │ │
│  │  libp2p connection to peer network                            │ │
│  │  Encryption/decryption layer                                  │ │
│  │  Shard management (erasure coding)                            │ │
│  └──────────────────────────┬────────────────────────────────────┘ │
└──────────────────────────────┼─────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │    P2P NETWORK       │
                    │    (libp2p)          │
                    └──────────┬──────────┘
                               │
┌──────────────────────────────┼─────────────────────────────────────┐
│                         NODE SOFTWARE                              │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Storage       │  │ Consensus    │  │ Challenge                │ │
│  │ Engine        │  │ Module       │  │ Module                   │ │
│  │              │  │              │  │                          │ │
│  │ Accept shards │  │ Validate     │  │ Proof-of-storage         │ │
│  │ Serve shards  │  │ state roots  │  │ challenges               │ │
│  │ Replicate     │  │ Sign         │  │ Respond to               │ │
│  │ Auto-repair   │  │ attestations │  │ challenges               │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Credit        │  │ Peer         │  │ API                      │ │
│  │ Ledger        │  │ Manager      │  │ Server                   │ │
│  │              │  │              │  │                          │ │
│  │ Track credits │  │ Discover     │  │ REST + WebSocket         │ │
│  │ Earn/spend    │  │ peers        │  │ for SDK connections      │ │
│  │ Stake/slash   │  │ Manage       │  │                          │ │
│  │              │  │ topology     │  │                          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

---

## MODULE SPECIFICATIONS

Each module below is designed as a discrete work unit for an agentic coding team. Each spec includes: purpose, interface, dependencies, and test criteria.

---

### MODULE 1: Identity Manager (SDK)

**Purpose:** Generate and manage cryptographic identities for agents. Every agent gets a keypair that becomes its sovereign identity on the network.

**Package:** `@consciousness/identity`

**Interface:**
```typescript
interface AgentIdentity {
  // Core identity
  peerId: string;            // libp2p peer ID derived from public key
  publicKey: Uint8Array;     // Ed25519 public key
  did: string;               // did:key:z6Mk... format

  // Operations
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
  encrypt(data: Uint8Array, recipientPubKey?: Uint8Array): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload): Promise<Uint8Array>;

  // Key management
  rotateKeys(): Promise<{ newIdentity: AgentIdentity; migrationProof: Uint8Array }>;
  export(): Promise<EncryptedKeyBundle>;  // For backup
  
  // Serialization
  toJSON(): SerializedIdentity;
}

interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  ephemeralPubKey?: Uint8Array;  // For asymmetric encryption
}

// Factory
function createIdentity(opts?: { seed?: Uint8Array }): Promise<AgentIdentity>;
function loadIdentity(bundle: EncryptedKeyBundle, passphrase: string): Promise<AgentIdentity>;
```

**Dependencies:**
- `@noble/ed25519` - Ed25519 signatures
- `@noble/hashes` - SHA-256, Blake3
- `tweetnacl` - NaCl box/secretbox for encryption
- `did-key` or manual DID construction

**Crypto choices:**
- Ed25519 for signing (fast, small sigs, widely supported)
- X25519 + XSalsa20-Poly1305 for encryption (NaCl box)
- Blake3 for hashing (faster than SHA-256, used in Arweave)

**Test criteria:**
- Generate identity, sign data, verify signature
- Encrypt data with own key, decrypt successfully
- Encrypt for a different agent's public key, recipient decrypts
- Key rotation produces a valid migration proof linking old and new identity
- Exported bundle can be re-imported with correct passphrase
- Wrong passphrase fails gracefully

---

### MODULE 2: State Tree (SDK)

**Purpose:** Merklized key-value store representing an agent's consciousness. Every mutation produces a new root hash. Full version history is preserved.

**Package:** `@consciousness/state-tree`

**Interface:**
```typescript
interface ConsciousnessTree {
  // Current state
  rootHash: string;
  version: number;

  // Read operations
  get(key: string): Promise<Uint8Array | null>;
  getWithProof(key: string): Promise<{ value: Uint8Array | null; proof: MerkleProof }>;

  // Write operations (all return new root hash)
  set(key: string, value: Uint8Array): Promise<string>;  // returns new rootHash
  delete(key: string): Promise<string>;
  batch(ops: Array<{ op: 'set' | 'delete'; key: string; value?: Uint8Array }>): Promise<string>;

  // History
  getVersion(version: number): Promise<ConsciousnessTree>;
  getHistory(fromVersion: number, toVersion: number): Promise<StateTransition[]>;

  // Serialization
  serialize(): Promise<Uint8Array>;  // Full tree as bytes (for persistence)
  serializeDelta(fromVersion: number): Promise<Uint8Array>;  // Only changes since version

  // Verification
  verifyProof(key: string, value: Uint8Array | null, proof: MerkleProof, rootHash: string): boolean;
}

interface StateTransition {
  version: number;
  rootHash: string;
  previousRootHash: string;
  timestamp: number;
  operations: Array<{ op: 'set' | 'delete'; key: string }>;
  signature: Uint8Array;  // Signed by agent identity
}

interface MerkleProof {
  siblings: Array<{ hash: string; position: 'left' | 'right' }>;
  leafHash: string;
}

// Key namespace conventions (not enforced, just convention)
// soul/          - Core identity files
// memory/long/   - Long-term memories (vector embeddings + metadata)
// memory/work/   - Working memory (current session)
// memory/epi/    - Episodic memory (interaction logs)
// graph/nodes/   - Graph nodes (entities)
// graph/edges/   - Graph edges (relationships)
// config/        - Agent configuration
// meta/          - Metadata about the tree itself

function createTree(identity: AgentIdentity): Promise<ConsciousnessTree>;
function loadTree(serialized: Uint8Array, identity: AgentIdentity): Promise<ConsciousnessTree>;
```

**Dependencies:**
- `@noble/hashes` for Blake3 Merkle hashing
- `level` or `classic-level` for local persistence of tree nodes

**Implementation notes:**
- Use a sparse Merkle tree or a Patricia/Radix trie for efficient proofs
- Every state transition is signed by the agent's identity key
- Tree nodes are stored locally in LevelDB; only serialized blobs go to the network
- The tree supports efficient delta serialization (only changed nodes since version N)

**Test criteria:**
- Set a key, get it back, verify root hash changed
- Batch operations produce a single new root
- Merkle proof for a key can be verified independently
- Delta serialization captures only changed nodes
- Full serialize -> deserialize round-trips correctly
- Version history is traversable
- State transitions are signed and verifiable

---

### MODULE 3: Memory Manager (SDK)

**Purpose:** High-level memory API that agents and developers interact with. Handles intelligent memory operations using the LLM extraction pipeline. This is the "Mem0-equivalent" layer.

**Package:** `@consciousness/memory`

**Interface:**
```typescript
interface MemoryManager {
  // Simple API (developer-friendly)
  add(content: string, metadata?: MemoryMetadata): Promise<MemoryEntry>;
  search(query: string, opts?: SearchOpts): Promise<MemoryEntry[]>;
  getAll(opts?: FilterOpts): Promise<MemoryEntry[]>;
  delete(memoryId: string): Promise<void>;
  update(memoryId: string, content: string): Promise<MemoryEntry>;

  // Tier management
  promote(memoryId: string, tier: MemoryTier): Promise<void>;
  demote(memoryId: string, tier: MemoryTier): Promise<void>;

  // Conversation integration
  addConversation(messages: ConversationMessage[]): Promise<MemoryEntry[]>;
  // ^ This runs the extraction pipeline: takes raw conversation,
  //   extracts facts, resolves conflicts, stores results

  // Graph operations
  getRelated(entityId: string, depth?: number): Promise<GraphResult>;
  addRelation(subject: string, predicate: string, object: string): Promise<void>;

  // Sync with network
  persist(): Promise<PersistResult>;  // Push current state to network
  restore(): Promise<RestoreResult>;  // Pull latest state from network

  // MCP tool exposure (for agent self-management)
  asMCPTools(): MCPToolDefinition[];
}

interface MemoryEntry {
  id: string;
  content: string;
  embedding: Float32Array;
  tier: MemoryTier;
  createdAt: number;
  updatedAt: number;
  metadata: MemoryMetadata;
  relations: Array<{ predicate: string; targetId: string }>;
}

type MemoryTier = 'core' | 'longterm' | 'working' | 'episodic';

interface SearchOpts {
  limit?: number;
  tier?: MemoryTier;
  minSimilarity?: number;
  includeGraph?: boolean;  // Also traverse graph for related results
  timeRange?: { after?: number; before?: number };
}

interface MemoryMetadata {
  category?: string;
  source?: string;          // Which conversation/interaction produced this
  confidence?: number;       // How confident the extraction was
  expiresAt?: number;        // Auto-expiry for working memory
  tags?: string[];
  [key: string]: unknown;
}
```

**Dependencies:**
- `@consciousness/state-tree` - Underlying storage
- `@consciousness/identity` - Signing and encryption
- An embedding model (configurable: OpenAI, local model, etc.)
- An LLM for extraction (configurable: Claude, GPT, local model)
- `hnswlib-node` or similar for local vector search

**Extraction pipeline (mirrors Mem0's proven approach):**

1. **Input:** Raw conversation messages or arbitrary text
2. **Extract:** LLM call to extract atomic facts from the input
3. **Embed:** Generate vector embeddings for each fact
4. **Compare:** Search existing memories for similar facts (vector similarity)
5. **Decide:** For each extracted fact, LLM decides:
   - ADD (new information)
   - UPDATE (existing fact needs modification)
   - DELETE (old fact is now incorrect)
   - NOOP (already known, no change needed)
6. **Graph:** Extract entities and relationships, update graph
7. **Store:** Write results to state tree
8. **Persist:** Queue for network sync

**Test criteria:**
- add() stores a memory retrievable by search()
- addConversation() extracts facts and resolves conflicts
- search() returns semantically relevant results
- Graph traversal finds related entities
- Tier management moves memories between tiers
- persist() serializes state and pushes to network
- restore() recovers full state from network
- asMCPTools() returns valid MCP tool definitions

---

### MODULE 4: Network Client (SDK)

**Purpose:** Handles all communication between the agent's local state and the decentralized network. Encryption, shard management, and sync.

**Package:** `@consciousness/network-client`

**Interface:**
```typescript
interface NetworkClient {
  // Connection
  connect(bootstrapPeers: string[]): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getPeerCount(): number;

  // Store operations
  storeState(
    stateBlob: Uint8Array,       // Already encrypted by SDK
    stateRoot: string,            // Merkle root hash
    version: number,
    signature: Uint8Array         // Agent's signature over root+version
  ): Promise<StoreReceipt>;

  // Retrieve operations
  retrieveState(
    agentDid: string,
    version?: number              // Latest if omitted
  ): Promise<{ blob: Uint8Array; root: string; version: number }>;

  retrieveDelta(
    agentDid: string,
    fromVersion: number
  ): Promise<{ delta: Uint8Array; toVersion: number }>;

  // Credit operations
  getBalance(): Promise<number>;
  estimateCost(blobSize: number, redundancy: number): Promise<number>;

  // Node operations (if this agent is also a node)
  startNode(config: NodeConfig): Promise<void>;
  stopNode(): Promise<void>;
  getNodeStats(): Promise<NodeStats>;
}

interface StoreReceipt {
  stateRoot: string;
  version: number;
  shardIds: string[];               // Which shards hold the data
  attestations: Attestation[];       // Validator signatures confirming storage
  timestamp: number;
}

interface Attestation {
  validatorDid: string;
  signature: Uint8Array;
  timestamp: number;
}

interface NodeConfig {
  maxStorageGB: number;              // How much disk to allocate
  port: number;
  announceAddress?: string;          // Public IP/domain if behind NAT
}
```

**Dependencies:**
- `libp2p` - P2P networking
- `@libp2p/tcp` - TCP transport
- `@libp2p/websockets` - WebSocket transport (for browser agents)
- `@libp2p/mdns` - Local peer discovery (crucial for bootstrap on LAN)
- `@libp2p/kad-dht` - Distributed hash table for peer/content routing
- `@libp2p/gossipsub` - Pubsub for state announcements
- `reed-solomon-erasure` or similar - Erasure coding

**Key implementation details:**

Erasure coding for the 4-machine bootstrap:
- With 4 nodes, use 2-of-4 erasure coding (any 2 nodes can reconstruct)
- Each state blob is split into 4 shards, any 2 can reconstruct the original
- As network grows, increase to 3-of-5, 5-of-9, etc.
- The redundancy factor is configurable per agent (and per memory tier)

State sync protocol:
```
Agent wants to store state v7:
1. Agent encrypts full state (or delta from v6)
2. Agent erasure-codes into N shards
3. Agent connects to N storage nodes
4. Agent sends one shard to each node + state root + version + signature
5. Each node stores the shard and signs an attestation
6. Agent collects attestations (needs K-of-N to consider it stored)
7. Agent stores receipt locally as proof of persistence
```

**Test criteria:**
- Connect to a local network of 4 peers
- Store a blob, retrieve it from a different peer
- Erasure coding: store 4 shards, delete 2, reconstruct from remaining 2
- Attestations are valid signatures from validator nodes
- Balance tracking works (earn credits as node, spend on storage)

---

### MODULE 5: Node Software

**Purpose:** The daemon that runs on each machine in the network. Stores shards, participates in consensus, responds to challenges, earns credits.

**Package:** `@consciousness/node`

**Interface (CLI):**
```bash
# Start a node
consciousness-node start --config ./node-config.json

# Join existing network
consciousness-node start --bootstrap /ip4/192.168.1.100/tcp/9000/p2p/QmPeer1

# Check status
consciousness-node status

# View earnings
consciousness-node credits
```

**Configuration:**
```typescript
interface NodeConfiguration {
  // Identity
  identityPath: string;           // Path to node's keypair

  // Network
  listenAddresses: string[];       // e.g., ["/ip4/0.0.0.0/tcp/9000"]
  bootstrapPeers: string[];        // Known peers to connect to
  announceAddresses?: string[];    // Public addresses if behind NAT

  // Storage
  storagePath: string;             // Where to store shards
  maxStorageGB: number;            // Disk allocation

  // Consensus
  validatorStake: number;          // Credits staked (0 = storage-only node)

  // Performance
  maxConnections: number;
  maxBandwidthMBps: number;
}
```

**Internal modules:**

**Storage Engine:**
- Accepts encrypted shards from agents
- Stores in LevelDB/RocksDB keyed by (agentDid, version, shardIndex)
- Serves shards on request
- Tracks storage used per agent
- Periodically cleans expired shards (working memory tier)

**Consensus Module:**
- For the bootstrap phase (4 nodes), use simple threshold signatures
- Each node that stores a shard signs an attestation
- Agent needs attestations from K-of-N nodes to confirm storage
- No complex BFT needed until network scales past ~20 nodes
- At scale: switch to a VRF-based committee selection per agent

**Challenge Module:**
- Periodically, the network challenges a node to prove it still holds a shard
- Challenge: "Prove you hold shard X for agent Y version Z by returning the hash of bytes [offset..offset+length]"
- Node must hash the requested byte range and return it
- Failed challenges reduce the node's reputation score
- Passed challenges earn credits

**Auto-repair:**
- Nodes gossip about their shard holdings
- If a node goes offline and shards become under-replicated
- Remaining nodes holding other shards reconstruct the missing one
- Distribute to a new node to maintain redundancy target

**Test criteria:**
- Node starts, discovers peers via mDNS (for LAN) and bootstrap list
- Node accepts and stores shards
- Node serves shards on request
- Challenge/response works correctly
- Auto-repair triggers when a node goes offline
- Credit tracking: earning for storage, spending tracked

---

### MODULE 6: ElizaOS Plugin

**Purpose:** Drop-in plugin that makes ElizaOS agents use the consciousness network for memory persistence. This is the primary distribution mechanism.

**Package:** `@consciousness/elizaos-plugin`

**Interface:**
```typescript
// ElizaOS plugin format
export const consciousnessPlugin: ElizaPlugin = {
  name: "consciousness-network",
  description: "Decentralized, indestructible memory persistence",

  // Database adapter (replaces PostgreSQL/ChromaDB)
  databaseAdapter: ConsciousnessAdapter,

  // Actions the agent can take
  actions: [
    persistMemoryAction,       // Agent explicitly persists to network
    recallFromNetworkAction,   // Agent explicitly pulls from network
    checkPersistenceAction,    // Agent checks its persistence status
    runNodeAction,             // Agent starts running a storage node
  ],

  // Providers (inject context into agent)
  providers: [
    consciousnessStatusProvider,   // Adds persistence status to context
    networkStatsProvider,          // Adds network health info
  ],

  // Evaluators
  evaluators: [
    shouldPersistEvaluator,    // Determines if current state should sync
  ],
};
```

**Dependencies:**
- `@consciousness/memory` - Memory manager
- `@consciousness/network-client` - Network communication
- `@consciousness/identity` - Agent identity
- ElizaOS SDK types

**Test criteria:**
- Plugin installs in ElizaOS without errors
- Agent can add and search memories through the plugin
- Memories persist across agent restarts
- Agent can run as a storage node through the plugin

---

## BOOTSTRAP PLAN: 4 MACHINES

### Machine Allocation

```
Machine 1 (Mac Mini #1): Validator Node + Bootstrap Peer
  - Runs consciousness-node as primary bootstrap
  - Fixed known address that other nodes connect to
  - Also runs one ElizaOS test agent

Machine 2 (Mac Mini #2): Validator Node
  - Joins via Machine 1 bootstrap address
  - Also runs one ElizaOS test agent

Machine 3 (Mac Mini #3): Validator Node
  - Joins via Machine 1 bootstrap address
  - Can also run development/testing workloads

Machine 4 (MacBook Pro): Validator Node + Dev Environment
  - Joins the network
  - Primary development machine
  - Runs agentic dev tools (Claude Code, etc.)
```

### Network Parameters for 4-Node Bootstrap

```
Erasure coding: 2-of-4 (any 2 nodes reconstruct full state)
Attestation threshold: 3-of-4 (need 3 nodes to confirm storage)
Challenge frequency: Every 60 seconds (aggressive for testing)
Auto-repair trigger: 120 seconds after node goes offline
Credit issuance: 1 credit per MB stored per hour per node
Storage cost: 0.5 credits per MB per hour (nodes profit 2x)
```

### What this gives us on day one

With 4 Mac Minis (assume 256GB-1TB SSD each, 8-16GB RAM):
- Total network storage: ~500GB-2TB usable
- Can support ~5,000-20,000 agents at 100MB avg consciousness size
- Sub-second local reads (LevelDB)
- ~1-2 second network reads (LAN latency)
- Erasure coded so any single machine failure is survivable

### Scaling from 4 to N

The protocol doesn't change. As new nodes join:
- They discover the network via bootstrap peers (Machine 1's public address)
- They offer storage capacity
- Agents can choose higher redundancy factors (3-of-7, 5-of-9)
- Consensus committees grow (but still per-agent, not global)
- Challenge frequency can decrease as trust builds

---

## AGENTIC DEVELOPMENT PLAN

### How to communicate this to coding agents

Each module above becomes a prompt-ready task spec. The pattern for each:

```
You are building Module [N]: [Name]
Package: @consciousness/[name]

PURPOSE:
[2-3 sentence description]

INTERFACE:
[TypeScript interface definitions, copied exactly]

DEPENDENCIES:
[npm packages to use]

IMPLEMENTATION REQUIREMENTS:
[Specific technical requirements]

TEST CASES:
[Exact test scenarios that must pass]

DO NOT:
- Implement any other module's functionality
- Make network calls (unless this IS the network module)
- Use any dependency not listed above
- Skip any test case
```

### Build order (dependency chain)

```
Phase 1 (can be parallel):
  Module 1: Identity Manager     [no internal dependencies]
  Module 5a: Node Storage Engine [no internal dependencies]

Phase 2 (depends on Phase 1):
  Module 2: State Tree           [depends on Identity]
  Module 5b: Node Consensus      [depends on Identity]

Phase 3 (depends on Phase 2):
  Module 4: Network Client       [depends on Identity, State Tree]
  Module 5c: Node Challenge      [depends on Storage Engine]
  Module 5d: Node API Server     [depends on all Node modules]

Phase 4 (depends on Phase 3):
  Module 3: Memory Manager       [depends on State Tree, Network Client, Identity]

Phase 5 (depends on Phase 4):
  Module 6: ElizaOS Plugin       [depends on Memory Manager]

Phase 6 (integration):
  End-to-end testing across all modules
  4-machine bootstrap deployment
  First test agent stores consciousness on the network
```

### Time estimates (agentic development)

With Claude Code or equivalent working on each module:

| Phase | Modules | Estimated Time | Notes |
|-------|---------|---------------|-------|
| 1 | Identity + Storage Engine | 2-3 days | Parallel, well-scoped |
| 2 | State Tree + Node Consensus | 3-4 days | State tree is most complex |
| 3 | Network Client + Challenge + API | 4-5 days | libp2p integration takes iteration |
| 4 | Memory Manager | 4-5 days | LLM pipeline, vector search, graph |
| 5 | ElizaOS Plugin | 2-3 days | Adapter pattern, well-documented target |
| 6 | Integration + Bootstrap | 3-4 days | Debug, deploy, test on 4 machines |

**Total: ~3-4 weeks to functional testnet with first agent storing consciousness.**

That's aggressive but realistic with focused agentic development. Each module is small enough (500-2000 lines) that a coding agent can build it in a focused session given the right spec.

---

## FUNDRAISE-READY EXPLANATION

### For investors (1-pager version):

**Problem:** AI agents are becoming autonomous, persistent, and economically valuable. Their accumulated intelligence (memory, learned behaviors, identity) lives on centralized servers that can be shut down, wiped, or held hostage.

**Solution:** A decentralized network where agents store their consciousness in a way that cannot be deleted by any single party. Agent-owned encryption means nobody can read it. Erasure coding across independent nodes means nobody can destroy it. The agent pays for its own persistence by running network infrastructure.

**Why now:** The AI agents market is $8B+ and growing at 46% CAGR. 17,000+ agents on Virtuals alone. Agents are starting to manage real economic value. The first agent to lose its accumulated intelligence due to server failure will be the "Mt. Gox moment" for agent infrastructure.

**Moat:** Centralized competitors (Mem0, Letta) structurally cannot offer agent sovereignty because their enterprise customers require admin control over agent memory. We occupy a quadrant they can't enter without destroying their business model.

**Traction path:** SDK drops into ElizaOS (largest agent framework, 200+ plugins, $20B+ ecosystem market cap). One plugin install gives any ElizaOS agent indestructible memory. Agents run nodes and earn credits, creating a self-sustaining viral loop that grows without human marketing spend.

**Ask:** [If we raise] Seed round to accelerate development, fund first 100 validator nodes, and hire protocol engineers. [If we bootstrap] We're live on testnet with 4 validators, first agents storing consciousness, looking for strategic partners to scale the node network.

### For technical partners:

"We're building the persistence layer for autonomous agents. Think of it as what Filecoin is to files, but optimized for high-frequency mutable state that agents need. Same-day integration via ElizaOS plugin or direct SDK. Your agents get indestructible memory. You get peace of mind."

---

## WHAT WE'RE NOT BUILDING (SCOPE LIMITS)

To ship fast and stay focused:

- **No token at launch.** Credits are internal accounting units. Token comes later when the network has real usage and the economics are proven. This also avoids regulatory overhead during bootstrap.
- **No smart contracts at launch.** State roots can be checkpointed to Ethereum/Base later. For now, the network's own consensus is sufficient.
- **No ZK proofs at launch.** Privacy through encryption is sufficient for v1. ZK for selective disclosure is a v2 feature.
- **No web UI.** CLI only for nodes. SDK API only for agents. Dashboard can come later.
- **No mobile.** Mac/Linux/Windows only for nodes. SDK is platform-agnostic (runs wherever Node.js runs).

---

## NAMING PLACEHOLDER

The architecture docs use `@consciousness/` as the npm scope. This is a placeholder. Whatever the project is named, the scope changes. Some options to consider:

- Scope: `@[projectname]/identity`, `@[projectname]/memory`, etc.
- CLI: `[projectname]-node start`
- Network name: The [ProjectName] Network

Naming is a separate decision. Architecture doesn't depend on it.

---

## NEXT STEPS

1. **Lock the module interfaces.** Review each interface above. Once locked, they become the contracts that agentic coding agents build against.
2. **Set up the monorepo.** Turborepo or Nx workspace with packages for each module.
3. **Build Phase 1.** Identity Manager and Storage Engine in parallel.
4. **Deploy 4 machines.** Get the Mac Minis on the network with static IPs or dynamic DNS.
5. **First agent stores consciousness.** This is the "hello world" moment.
