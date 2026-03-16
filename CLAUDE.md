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
