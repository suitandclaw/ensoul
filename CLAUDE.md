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
16. Every code fix must be verified against the BUILT output, not just source. After any TypeScript change: (a) Run pnpm build for the affected package if it has a dist/ directory (compiled packages: abci-server, ledger, node, explorer, identity, and others). (b) Grep the dist/ directory to confirm the change is present. (c) Restart the affected process. (d) Verify the process is running the new code by checking logs for a startup timestamp. Packages that run via tsx directly (monitor, telegram-bot, api, research-agents) have no build step but still require process restart and log verification. Never report a fix as complete until all steps are done.

## Standard Operating Procedures

These procedures are MANDATORY. Read them before executing any related task.

### SOP 1: Validator Recovery (when a cloud validator is stuck or needs to rejoin)
- Use STATE SYNC. Never replay from genesis. State sync completes in under 2 minutes.
- On the stuck validator: stop CometBFT, stop ABCI.
- Delete CometBFT data directory ONLY (NOT the ABCI state).
- Reconfigure state sync in config.toml with current trust_height and trust_hash from a healthy validator.
- Restart ABCI first, wait 3 seconds, then restart CometBFT.
- Verify catching_up=false within 5 minutes.
- If state sync fails, diagnose WHY before falling back to block replay.

### SOP 2: ABCI/Code Upgrades (when deploying new code to validators)
- NEVER deploy to all validators at once.
- Pull and rebuild on MBP first, verify it compiles.
- Deploy to ONE cloud validator, verify it signs 50 blocks.
- Deploy to 2 more cloud validators, verify all 3 sign 50 blocks.
- Continue in batches of 3, verifying after each.
- Deploy to home machines LAST.
- If any validator fails after upgrade, STOP and REVERT before continuing.

### SOP 3: New Transaction Types (when adding new tx types like redelegate)
- Implement and test locally on MBP first.
- Deploy to ONE cloud validator using SOP 2 rolling process.
- Submit a test transaction and verify it is accepted.
- Only after successful test, roll out to remaining validators.
- NEVER wipe ABCI state to force replay. The new code must handle existing state.
- Height-gate ALL new state changes (new validation, new registry updates, new power calculations) to a future block height so replay of old blocks produces identical hashes.

### SOP 4: Validator Key Management
- ALWAYS restore existing keys from ~/ensoul-key-vault/ instead of generating new ones.
- NEVER create new validator identities when old ones exist with staked ENSL.
- NEVER spend treasury ENSL without explicit justification and approval.
- Back up new keys to the vault immediately after generation.

### SOP 5: SSH and Infrastructure
- NEVER touch SSH config, sshd, UFW, or firewall on any machine (Rule 15).
- For connectivity issues, use persistent_peers in CometBFT config, not infrastructure changes.
- The Ashburn VPS (178.156.199.91) has both Tailscale and public IP. Use it as the bridge between home and cloud networks.
- The ABCI entry point is packages/abci-server/src/index.ts (NOT start.ts).
- CometBFT must be started via cosmovisor, not the raw cometbft binary.

### SOP 6: Telegram Bot Deployment
- The Telegram bot runs on the VPS (178.156.199.91), NOT on MBP.
- Every code change that affects the bot MUST be deployed to the VPS.
- After pushing to git:
  1. SSH into VPS: ssh -p 2222 ensoul@178.156.199.91
  2. Pull latest: cd ~/ensoul && sudo git fetch origin && sudo git reset --hard origin/main
  3. Kill the bot: sudo pkill -f 'telegram-bot/start'
  4. Restart the bot: sudo nohup npx tsx packages/telegram-bot/start.ts > /tmp/telegram-bot.log 2>&1 &
  5. Verify the fix is active: grep for the relevant change in the deployed code
- This step is MANDATORY for every bot-related code change. If you skip it, the VPS runs stale code.
- The bot shares code with packages/shared/validator-health.ts. If that file changes, the bot must also be redeployed.

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
