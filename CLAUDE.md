# ENSOUL PROTOCOL

## Project Overview
Ensoul is a decentralized consciousness persistence network for AI agents.
Agents store encrypted state (identity, memory, learned behavior) across a
peer-to-peer node network. Token: $ENSL. Domain: ensoul.dev

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
4. ALL tests must pass before any commit. Run pnpm test to verify.
5. TypeScript strict mode. No any types. No ts-ignore.
6. All async operations must have proper error handling and timeouts.
7. Every public function must have JSDoc documentation.
8. No console.log in production code. Use a structured logger.
9. All data that touches the network must be encrypted first.
10. State transitions must be signed by the agent identity key.
11. NEVER reinitialize genesis or wipe chain data to add state. All state changes go through transactions on the live chain. The only acceptable reason for a genesis reset is a consensus engine replacement. Use scripts/safe-cometbft.sh instead of the raw binary.
12. NEVER use em dashes or double dashes in any output. Rewrite sentences to avoid them.
13. When restarting CometBFT or validators, NEVER kill explorer (port 3000), monitor (port 4000), API (port 5050), or cloudflared processes. Restart only the specific processes that need restarting. Kill by port (26656, 26657, 26658) not by process name.
14. NEVER kill cloudflared or any process matching 'cloudflared'. The tunnel serves all public URLs. If it dies, explorer.ensoul.dev, status.ensoul.dev, api.ensoul.dev, and ensoul.dev all go dark. On Minis, the tunnel serves v1/v2/v3.ensoul.dev.
15. NEVER touch SSH configuration on any machine. NEVER run systemctl restart ssh, systemctl reload ssh, systemctl start ssh, kill -HUP on sshd, or any command that affects the SSH daemon. NEVER edit sshd_config. NEVER enable UFW. SSH hardening is done manually by JD, never by Claude Code. This rule has zero exceptions.

## Operational Rules
- The chain is the database. Agent registrations, consciousness stores, and all state live on-chain, replicated by CometBFT consensus.
- Disk files (registered-agents.json, consciousness-store.json) are caches, not sources of truth.
- All new agents and consciousness stores must be submitted as on-chain transactions.
- Binary upgrades go through Cosmovisor via on-chain SOFTWARE_UPGRADE proposals.
- Code updates go through scripts/update-all-validators.sh (rolling update with health checks).
- Both social agents (X and Moltbook) are disabled via ~/.ensoul/agents-disabled and ~/.ensoul/x-agent-disabled. Do not re-enable without explicit instruction.

## Build Commands
- pnpm install - Install dependencies
- pnpm build - Build all packages
- pnpm test - Run all tests
- pnpm test --filter @ensoul/identity - Test single package
- pnpm lint - Run linter

## Module Dependency Chain
identity (no deps) -> state-tree -> network-client -> memory -> plugin-elizaos
                                 -> node (consensus, storage, challenge, api)
security (independent, tests all other modules)

## Architecture
See /docs/ directory for full architecture documents.
Each package has a spec in the architecture docs with exact interfaces.

## When in Doubt
- Prioritize security over performance
- Prioritize correctness over speed of development
- If a design decision is unclear, explain trade-offs and pick the better option
- Every module should be independently testable with mocked dependencies
