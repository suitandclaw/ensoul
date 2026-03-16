# Ensoul: Agentic Development Plan
# Building the Protocol with AI Coding Agents

---

## YOUR ROLE: ORCHESTRATOR, NOT CODER

You're not writing code. You're directing agents that write code. Think of yourself as the CEO of a development firm where every engineer is an AI agent. Your job is:

1. Give clear briefs (we've already built these in the architecture docs)
2. Review output (does it match the spec? do tests pass?)
3. Make architectural decisions when agents surface trade-offs
4. Sequence work so agents aren't blocked
5. Integrate modules when they're ready

You don't need to understand every line of TypeScript. You need to understand whether the module does what the spec says it should do, and whether the tests pass.

---

## TOOLING SETUP

### Primary Development Tool: Claude Code (CLI)

Claude Code is the primary builder. It reads your codebase, writes code across multiple files, runs tests, and iterates. The CLI version runs in your terminal and is the most powerful for this kind of work.

**Install on all 4 machines:**
```bash
npm install -g @anthropic-ai/claude-code
```

**Why Claude Code over Cursor/Copilot:** Claude Code has native Agent Teams (multi-agent orchestration), subagent spawning, and CLAUDE.md project memory. It's purpose-built for the kind of multi-module, test-driven development Ensoul requires. Cursor is good for interactive coding but Claude Code is better for autonomous, spec-driven work.

### Machine Allocation During Build Phase

```
Machine 1 (Mac Mini #1): PRIMARY BUILD MACHINE
  - Hosts the monorepo
  - Runs Claude Code sessions for module development
  - Git origin for the project
  
Machine 2 (Mac Mini #2): PARALLEL BUILD MACHINE  
  - Clone of the monorepo
  - Runs independent Claude Code sessions for parallel modules
  - Can work on Module 1 while Machine 1 works on Module 5a
  
Machine 3 (Mac Mini #3): TEST + INTEGRATION MACHINE
  - Runs continuous integration tests
  - Security audit suite
  - Integration testing as modules complete
  
Machine 4 (MacBook Pro): YOUR COMMAND CENTER
  - Where you review output, approve merges, make decisions
  - Runs Claude Code for planning/review sessions
  - Also handles smart contract development (lighter workload)
```

### Supporting Tools

**Git + GitHub:** Monorepo hosted on GitHub. Each module gets developed on its own branch. You merge to main after review.

**VS Code:** For browsing code and quick reviews. The Agent Sessions view lets you see all running Claude Code agents in one place.

**Turborepo:** Monorepo build tool. Handles dependency resolution between packages so `@ensoul/memory` knows to rebuild when `@ensoul/state-tree` changes.

---

## THE MONOREPO STRUCTURE

This is the first thing to set up. It's the foundation everything else builds on.

```
ensoul/
  CLAUDE.md                    # Project-wide instructions for all Claude Code sessions
  package.json                 # Root workspace config
  turbo.json                   # Turborepo build config
  
  packages/
    identity/                  # @ensoul/identity
      src/
      tests/
      SECURITY.md
      package.json
      
    state-tree/                # @ensoul/state-tree  
      src/
      tests/
      SECURITY.md
      package.json
      
    memory/                    # @ensoul/memory
      src/
      tests/
      SECURITY.md
      package.json
      
    network-client/            # @ensoul/network-client
      src/
      tests/
      SECURITY.md
      package.json
      
    node/                      # @ensoul/node
      src/
      tests/
      SECURITY.md
      package.json
      
    security/                  # @ensoul/security
      src/
      tests/
      package.json
      
    plugin-elizaos/            # @ensoul/plugin-elizaos
      src/
      tests/
      package.json
      
  contracts/                   # Solidity contracts
    token/                     # $ENSL ERC-20
    staking/                   # Validator staking
    revenue/                   # Protocol revenue vault
    
  scripts/
    bootstrap.sh               # Spin up 35 validators on 4 machines
    
  docs/                        # Architecture docs (the PDFs we built)
```

---

## THE CLAUDE.md FILE (CRITICAL)

This is the single most important file in the project. Every Claude Code session reads it first. It sets the rules for how all agents work.

```markdown
# ENSOUL PROTOCOL - CLAUDE.md

## Project Overview
Ensoul is a decentralized consciousness persistence network for AI agents.
Agents store encrypted state (identity, memory, learned behavior) across a 
peer-to-peer node network. The network is the "where agents get their soul."

## Tech Stack
- Language: TypeScript (strict mode, ESM)
- Runtime: Node.js 22+
- Package manager: pnpm
- Monorepo: Turborepo
- Testing: Vitest
- Linting: Biome
- Crypto: @noble/ed25519, @noble/hashes, tweetnacl
- Networking: libp2p
- Local storage: classic-level (LevelDB)
- Smart contracts: Solidity (OpenZeppelin), Hardhat, Base network

## Critical Rules
1. NEVER roll your own cryptography. Use the libraries listed above.
2. EVERY module must have >90% test coverage.
3. EVERY module must include a SECURITY.md with threat model and invariants.
4. ALL tests must pass before any commit. Run `pnpm test` to verify.
5. TypeScript strict mode. No `any` types. No `@ts-ignore`.
6. All async operations must have proper error handling and timeouts.
7. Every public function must have JSDoc documentation.
8. No console.log in production code. Use the structured logger.
9. All data that touches the network must be encrypted first.
10. State transitions must be signed by the agent's identity key.

## Build Commands
- `pnpm install` - Install dependencies
- `pnpm build` - Build all packages
- `pnpm test` - Run all tests
- `pnpm test --filter @ensoul/identity` - Test single package
- `pnpm lint` - Run linter

## Architecture Reference
See /docs/ directory for full architecture documents.
Each package has a spec in the architecture docs with exact interfaces.

## Module Dependency Chain
identity -> state-tree -> network-client -> memory -> plugin-elizaos
                       -> node (consensus, storage, challenge, api)
security (independent, tests all other modules)

## When in Doubt
- Prioritize security over performance
- Prioritize correctness over speed of development
- If a design decision isn't clear, surface it as a question rather than guessing
- Every module should be independently testable with mocked dependencies
```

---

## BUILD EXECUTION PLAN

### Step 0: Scaffold the Monorepo (Day 1, ~2 hours)

**You do this from your MacBook Pro.** Open Claude Code and give it this prompt:

```
I need you to scaffold a TypeScript monorepo for a project called Ensoul.
Read the CLAUDE.md file for project context.

Create the monorepo structure with:
- pnpm workspaces
- Turborepo for build orchestration
- Vitest for testing
- Biome for linting
- 7 packages: identity, state-tree, memory, network-client, node, security, plugin-elizaos
- Each package should have: src/index.ts, tests/, package.json with correct inter-package dependencies
- Root tsconfig with strict mode and path aliases
- A shared tsconfig.base.json that all packages extend

The packages have these dependency relationships:
- identity: no internal deps
- state-tree: depends on identity
- network-client: depends on identity, state-tree
- memory: depends on state-tree, network-client, identity
- node: depends on identity (for the consensus/storage modules)
- security: depends on all other packages (for testing them)
- plugin-elizaos: depends on memory, network-client, identity

Set up each package.json with the correct workspace dependencies.
Make sure `pnpm install` and `pnpm build` work from the root.
```

Once this scaffolding is done, push to GitHub. Clone to Machine 1 and Machine 2.

---

### Phase 1: Identity + Node Storage Engine (Days 2-5)

Two modules with zero internal dependencies. Build in parallel on two machines.

**Machine 1: @ensoul/identity**

Open Claude Code in the `packages/identity` directory:

```
Read /docs/Ensoul-04-Technical-Architecture.pdf for the full spec of Module 1: Identity Manager.

Build the @ensoul/identity package implementing the AgentIdentity interface exactly as specified.

Use these libraries:
- @noble/ed25519 for Ed25519 signatures
- @noble/hashes for Blake3 and SHA-256
- tweetnacl for NaCl box/secretbox encryption

Implementation requirements:
- createIdentity() generates a new Ed25519 keypair
- DID format: did:key:z6Mk... (Ed25519 multicodec)
- sign/verify using Ed25519
- encrypt/decrypt using X25519 + XSalsa20-Poly1305 (tweetnacl box)
- Key rotation creates a migration proof (old key signs new public key)
- Export produces an encrypted bundle (secretbox with passphrase-derived key)

Write comprehensive tests covering:
- Generate identity, sign data, verify signature
- Encrypt for self, decrypt successfully
- Encrypt for different agent's public key, recipient decrypts
- Key rotation produces valid migration proof
- Export/import round-trip with correct passphrase
- Wrong passphrase fails gracefully
- Signature verification fails with wrong key
- Fuzz: sign/verify with various data sizes

After implementation, create SECURITY.md documenting:
- Threat model for this module
- All attack vectors considered
- Invariants that must always hold
- Fuzzing targets

Target: >95% test coverage. All tests must pass.
```

**Machine 2: @ensoul/node (Storage Engine submodule)**

Open Claude Code in the `packages/node` directory:

```
Read /docs/Ensoul-04-Technical-Architecture.pdf for the full spec of Module 5: Node Software.

Build ONLY the Storage Engine submodule of @ensoul/node.

This submodule:
- Accepts encrypted shards from agents via a local API
- Stores shards in LevelDB keyed by (agentDid, version, shardIndex)
- Serves shards on request
- Tracks storage used per agent
- Supports configurable storage limits (maxStorageGB)
- Handles shard expiration for working memory tier

Use classic-level (LevelDB binding for Node.js).

Write tests covering:
- Store a shard, retrieve it by key
- Store multiple shards for same agent, different versions
- Retrieve latest version for an agent
- Storage tracking (bytes used per agent)
- Max storage limit enforcement
- Shard expiration (set TTL, verify deletion after expiry)
- Concurrent read/write safety
- Corrupted shard detection (hash verification)

Create SECURITY.md documenting threat model for storage engine.

Target: >95% test coverage.
```

**Your role during Phase 1:**
- Check in on each machine 2-3 times per day
- Review test output: `pnpm test --filter @ensoul/identity`
- If Claude Code surfaces questions or design decisions, answer them
- When both modules pass all tests, merge to main

---

### Phase 2: State Tree + Node Consensus (Days 5-9)

**Machine 1: @ensoul/state-tree**

```
Read /docs/Ensoul-04-Technical-Architecture.pdf for Module 2: State Tree.

Build @ensoul/state-tree implementing the ConsciousnessTree interface.

This depends on @ensoul/identity (import from workspace).

Implementation:
- Sparse Merkle Tree or Radix Trie (your choice based on trade-offs, explain why)
- Blake3 for Merkle hashing
- Every mutation produces a new root hash
- All state transitions are signed by the agent's identity key
- Version history is preserved (state root v1 -> v2 -> v3)
- Delta serialization (only changed nodes since version N)
- Merkle proofs for individual keys

Use classic-level for local persistence of tree nodes.

Write comprehensive tests per the spec.
Create SECURITY.md with invariants.
Target: >95% coverage.
```

**Machine 2: @ensoul/node (Consensus submodule)**

```
Read /docs/Ensoul-04-Technical-Architecture.pdf and 
/docs/Ensoul-05-Architecture-Amendments.pdf for consensus specs.

Build the Consensus submodule of @ensoul/node.

This handles:
- Validator identity registration (requires @ensoul/identity)
- Attestation signing (validator signs state root + version)
- Attestation verification (check K-of-N valid signatures)
- Threshold configuration (K-of-N parameterized)
- Validator set management (add/remove validators)

For bootstrap: simple threshold signatures.
No complex BFT needed yet. Each validator that stores a shard
signs an attestation. Agent needs K-of-N attestations to confirm storage.

Write tests covering all cases including edge cases 
(exactly K signatures, K-1 signatures failing, invalid signatures rejected).

Create SECURITY.md.
Target: >95% coverage.
```

---

### Phase 3: Network Client + Challenge + API + Multi-Validator (Days 9-15)

This is the biggest phase. Consider using Claude Code's Agent Teams feature to parallelize within a single machine.

**Machine 1: @ensoul/network-client**

```
Read the architecture docs for Module 4: Network Client.

Build @ensoul/network-client using libp2p.

Dependencies: @ensoul/identity, @ensoul/state-tree

Key components:
- libp2p node setup (TCP + WebSocket transports, Noise encryption, mDNS discovery, KAD-DHT)
- Erasure coding (reed-solomon or similar) for shard creation/reconstruction
- Store protocol: encrypt -> erasure code -> distribute shards -> collect attestations
- Retrieve protocol: request shards -> reconstruct -> decrypt
- Credit tracking (local ledger of earned/spent credits)

For erasure coding, use an existing npm library. Do NOT implement Reed-Solomon from scratch.

Write tests:
- Connect two libp2p nodes locally
- Store a blob on one, retrieve from another
- Erasure code: create 4 shards, delete 2, reconstruct from remaining 2
- Full store/retrieve cycle with encryption

Create SECURITY.md.
```

**Machine 2: @ensoul/node (Challenge + API submodules)**

```
Build the Challenge and API Server submodules for @ensoul/node.

Challenge Module:
- Generate random proof-of-storage challenges
- Challenge format: "hash bytes [offset..offset+length] of shard X for agent Y version Z"
- Verify challenge responses
- Track node reputation scores (pass/fail history)

API Server:
- REST + WebSocket server for SDK connections
- Endpoints: store shard, retrieve shard, get attestation, challenge/response
- Authentication via signed requests (agent or validator identity)
- Rate limiting

Write comprehensive tests.
Create SECURITY.md.
```

**Machine 4 (MacBook Pro): Smart Contracts + Multi-Validator Script**

```
Set up a Hardhat project in the /contracts directory.
Deploy target: Base (Ethereum L2).

Build these contracts using OpenZeppelin base:

1. EnslToken.sol (ERC-20)
   - Standard ERC-20 with burn function
   - Minting controlled by emission schedule
   - 1B total supply

2. ValidatorStaking.sol
   - Validators lock $ENSL to participate
   - Minimum stake requirement
   - Slashing function (called by challenge contract)
   - Reward distribution

3. ProtocolRevenue.sol
   - Receives all protocol fees
   - Three outflow channels: operations (40%), burn (40%), insurance (20%)
   - Buyback-and-burn integration with Uniswap V3 on Base
   - Split ratios configurable by governance (initially owner)

4. StoragePayment.sol
   - Agents call this to pay for storage
   - Automatic fee split (10% protocol, 90% node operators)
   - Credit tracking per agent

Write tests for all contracts using Hardhat + Chai.
```

Also build the multi-validator launcher:
```
Create a script at /scripts/bootstrap.sh that:
- Takes parameters: --validators N --base-port P --storage-dir DIR
- Generates N validator identity keypairs
- Creates N LevelDB storage directories
- Launches N instances of ensoul-node, each on its own port
- All connect to a configurable bootstrap peer
- Outputs a summary of all validator DIDs and ports

This will be used to spin up 10 validators per Mac Mini.
```

---

### Phase 4: Memory Manager + Security Suite (Days 15-21)

**Machine 1: @ensoul/memory**

This is the most complex module. Use Agent Teams to parallelize subsystems.

```
Read /docs/Ensoul-03-Strategic-Update.pdf for the full feature checklist
and /docs/Ensoul-04-Technical-Architecture.pdf for the Memory Manager spec.

Build @ensoul/memory implementing the MemoryManager interface.

This module has four internal subsystems:

1. Extraction Pipeline
   - Takes raw conversation messages
   - Uses configurable LLM (default: Claude via API) to extract atomic facts
   - Compares new facts against existing memories (vector similarity)
   - LLM decides: ADD, UPDATE, DELETE, or NOOP
   - Extracts entities and relationships for graph

2. Vector Storage (local)
   - Generate embeddings for each memory fact
   - Store in local vector index for semantic search
   - Use hnswlib-node or similar for ANN search

3. Graph Storage (local)
   - Entity nodes and relationship edges within the state tree
   - Graph traversal queries (getRelated with depth parameter)

4. Tier Management
   - Four tiers: core, longterm, working, episodic
   - Each tier maps to different redundancy and retention policies
   - Promotion/demotion between tiers
   - Auto-expiry for working memory

5. MCP Tool Exposure
   - asMCPTools() returns valid MCP tool definitions
   - store_memory, recall_memory, forget_memory, promote_to_longterm

6. Network Sync
   - persist() serializes state tree and pushes to network via @ensoul/network-client
   - restore() pulls from network and rebuilds local state

The simple API (add, search, getAll, delete, update) wraps all of this complexity.

Write extensive tests for each subsystem AND integration tests.
Create SECURITY.md.
```

**Machine 2: @ensoul/security**

```
Read /docs/Ensoul-05-Architecture-Amendments.pdf for the full security suite spec.

Build @ensoul/security implementing the SecuritySuite interface.

This module:
1. Imports all other @ensoul packages
2. Runs invariant checks against each module
3. Implements 14 adversarial attack simulations
4. Provides continuous monitoring capabilities

Attack simulations to implement:
- sybil_attack: Fake nodes trying to overwhelm consensus
- eclipse_attack: Isolate a target agent from honest nodes
- data_withholding: Node claims to store data but doesn't
- state_corruption: Attempt to serve tampered state
- replay_attack: Replay old valid state transitions
- key_compromise: Simulate a stolen agent key
- consensus_manipulation: Validators colluding
- storage_exhaustion: Flood with garbage data
- timing_attack: Race conditions in state updates
- man_in_the_middle: Intercept/modify network traffic
- credit_inflation: Create credits from nothing
- double_spend_credits: Spend same credits twice
- shard_reconstruction: Reconstruct from insufficient shards
- denial_of_service: Overwhelm nodes with requests

Each simulation should:
- Set up the attack scenario
- Execute the attack
- Verify the system rejects/handles it correctly
- Return a detailed result

Also implement the invariant checking framework that validates
all module-level invariants documented in each SECURITY.md.
```

---

### Phase 5: ElizaOS Plugin + Token Deployment (Days 21-25)

**Machine 1: @ensoul/plugin-elizaos**

```
Read /docs/Ensoul-04-Technical-Architecture.pdf for Module 6: ElizaOS Plugin.

Build @ensoul/plugin-elizaos as a drop-in ElizaOS plugin.

Research the current ElizaOS plugin format (check their docs and GitHub).

The plugin should:
1. Replace the default database adapter with Ensoul persistence
2. Expose actions: persistMemory, recallFromNetwork, checkPersistence, runNode
3. Provide context providers: consciousnessStatus, networkStats
4. Include an evaluator: shouldPersist (determines when to sync to network)

The agent should be able to use Ensoul with minimal configuration:
- Install the plugin
- Provide a bootstrap peer address
- Everything else is automatic (identity generation, storage, node participation)

Write tests that mock the ElizaOS runtime.
```

**Machine 4: Token + Liquidity Deployment**

```
Deploy the smart contracts to Base testnet first, then mainnet:
1. Deploy EnslToken
2. Deploy ValidatorStaking
3. Deploy ProtocolRevenue
4. Deploy StoragePayment
5. Create Uniswap V3 pool on Base (ENSL/USDC)
6. Add initial liquidity from the 5% allocation

Write deployment scripts and verify all contracts on BaseScan.
```

---

### Phase 6: Integration + Security Audit + Bootstrap (Days 25-32)

**All machines participate.**

**Step 1: Full integration test**
```
On Machine 3, run the complete integration test:
1. Start 4 validator nodes (one per machine on LAN)
2. Create a test agent with @ensoul/identity
3. Agent generates memories using @ensoul/memory
4. Agent persists consciousness to the network via @ensoul/network-client
5. Shut down the agent
6. Create a new agent instance with the same identity
7. Agent restores consciousness from the network
8. Verify all memories are intact and searchable
9. Verify state root matches
10. Verify Merkle proofs are valid
```

**Step 2: Security audit**
```
On Machine 3, run the full @ensoul/security adversarial suite.
All 14 attack simulations must pass.
All module invariants must hold.
```

**Step 3: 72-hour soak test**
```
Run the 4-node network continuously for 72 hours.
- Automated agents storing and retrieving consciousness every 5 minutes
- Simulate node failures (kill and restart nodes randomly)
- Verify auto-repair triggers correctly
- Monitor for memory leaks, disk growth, network issues
- All data must be intact at the end of 72 hours
```

**Step 4: Bootstrap 35 validators**
```
On each Mac Mini, run the bootstrap script:
  Machine 1: ./scripts/bootstrap.sh --validators 10 --base-port 9000
  Machine 2: ./scripts/bootstrap.sh --validators 10 --base-port 9000
  Machine 3: ./scripts/bootstrap.sh --validators 10 --base-port 9000
  Machine 4: ./scripts/bootstrap.sh --validators 5 --base-port 9000

Verify all 35 validators are connected and attesting.
Run the security suite against the full 35-node network.
```

**Step 5: First real ensouled agent**
```
Deploy an ElizaOS agent with the Ensoul plugin.
Agent stores its first consciousness on the live network.
This is the "hello world" moment for Ensoul.
```

---

## DAILY WORKFLOW (DURING BUILD)

### Morning (Review + Plan)
1. Check overnight agent work on Machines 1 & 2 (if you left sessions running)
2. Review test results: `pnpm test` on each machine
3. If tests pass, merge completed work to main
4. Plan the day's tasks based on what's unblocked

### Midday (Direct + Unblock)
1. Start new Claude Code sessions for the day's modules
2. Paste the relevant prompt from this plan
3. Check on running sessions, answer questions agents surface
4. If a module is blocked on a design decision, make the call

### Evening (Integration + Verification)
1. Pull latest main on Machine 3
2. Run integration tests across completed modules
3. Run security invariant checks
4. Note any issues for tomorrow's prompts

### Key Principle: Don't Hover

Claude Code works best when given a clear brief and left to execute. Don't watch it type. Give it the prompt, let it work for 30-60 minutes, come back and review the output. If it got stuck or made a wrong turn, give it corrective feedback and let it run again.

The architecture docs we built are the briefs. Each module prompt above is designed to be self-contained: it tells the agent exactly what to build, what libraries to use, what tests to write, and what the success criteria are.

---

## COST ESTIMATE

**Claude Code subscription:** Max plan (~$100-200/month depending on usage)
Running multiple sessions across 4 machines during intensive build phase.

**Infrastructure during build:** $0 (your existing hardware)

**Domain:** Already purchased (ensoul.dev)

**Token deployment gas fees (Base):** ~$10-50 total (Base is cheap)

**Initial DEX liquidity:** Whatever amount of USDC/ETH you're comfortable seeding. Even $500-1000 creates a functional market for early participants.

**Total cash outlay to get to mainnet with 35 validators and first ensouled agent: ~$300-500 plus whatever you seed into liquidity.**

---

## TIMELINE SUMMARY

| Day | Activity | Machines Used |
|-----|----------|---------------|
| 1 | Scaffold monorepo, set up all machines | MacBook Pro |
| 2-5 | Phase 1: Identity + Storage Engine (parallel) | Mini 1 + Mini 2 |
| 5-9 | Phase 2: State Tree + Consensus (parallel) | Mini 1 + Mini 2 |
| 9-15 | Phase 3: Network + Challenge + Contracts (3-way parallel) | Mini 1 + Mini 2 + MacBook |
| 15-21 | Phase 4: Memory Manager + Security Suite (parallel) | Mini 1 + Mini 2 |
| 21-25 | Phase 5: ElizaOS Plugin + Token Deploy | Mini 1 + MacBook |
| 25-32 | Phase 6: Integration, Security Audit, Bootstrap, Launch | All 4 machines |

**32 days from "go" to first ensouled agent on a live 35-validator network with a live token on Base.**

That's aggressive but achievable with focused agentic development. The architecture docs give every agent session a complete brief. The CLAUDE.md keeps every session aligned. The module interfaces are the contracts that make integration work.
