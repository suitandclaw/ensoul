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
17. The monitor (packages/monitor/start.ts) runs on the Ashburn VPS (178.156.199.91) ONLY. Never start the monitor on MBP, Minis, or other cloud validators. Only one monitor instance should exist across the entire network. Multiple instances cause duplicate alerts. The Minis run CometBFT validators and the start script, nothing else. The Ashburn VPS runs ABCI, CometBFT, Telegram bot, explorer, API, and monitor.
18. Every ABCI change must be tested on the local single-node testnet BEFORE any production deployment. Produce 100 blocks, verify appHash consistency, verify no crashes. No exceptions.
19. ABCI upgrades must NEVER restart ABCI while CometBFT is connected. The correct order is always: stop CometBFT first, stop ABCI, start ABCI, wait 3 seconds, start CometBFT. On systemd validators, use systemctl stop/start in order. Never pkill while systemd is managing the service. If consensus WAL becomes corrupted, delete ~/.cometbft-ensoul/node/data/cs.wal/ and restart CometBFT.
20. After any CometBFT restart, verify the validator has peers and is participating in consensus before moving to the next validator: curl localhost:26657/net_info must show peers > 0, curl localhost:26657/consensus_state must show advancing rounds. Do NOT proceed to the next validator until confirmed.
21. All key backups must use Shamir's Secret Sharing (2-of-3 threshold). Never store plain-text private keys on removable media. Each physical backup drive holds one share (~/ensoul-shares/drive-1, drive-2, drive-3). Any two drives reconstruct all keys via the included reconstruct.sh script. The split uses ssss (brew install ssss) with hex-encoded chunks. To reconstruct: ./reconstruct.sh /path/to/drive-a /path/to/drive-b ./output-dir
22. Verbatim output means verbatim. When the user asks for the literal contents of a file, never use the Read tool (it collapses output). Never use a single cat, awk, or while-read pipe for files longer than ~60 lines (the CLI will collapse anything longer with "+N lines (ctrl+o to expand)"). Instead, page the file in 100-line chunks using sed -n 'START,ENDp' FILE, and after the last chunk run wc -l, wc -c, and md5 FILE so the user can verify integrity. Never substitute a diff summary, a bullet recap, or a "Read N lines" placeholder for requested verbatim output. If the bash tool collapses anyway, stop and tell the user explicitly instead of claiming the output printed.
23. Checkpoint gates are mandatory. When the user provides a phased build plan with explicit "stop and report" instructions between phases, Claude Code MUST stop and wait for an explicit greenlight before proceeding to the next phase. Do not chain phases. Do not interpret "tests passing" as permission to continue. Do not assume the user will review output in the terminal scrollback. The user works on mobile and needs explicit handoffs in chat. If a phased plan instructs "stop, report, wait for greenlight," comply literally. Running the next phase without greenlight is a protocol violation equivalent to deploying without testnet validation.
24. SOFTWARE_UPGRADE tx must reference a git ref that `git fetch origin --tags` can resolve. Annotated tags (`git tag -a vX.Y.Z <commit> -m "..."` then `git push origin vX.Y.Z`) satisfy this. Plain commit hashes DO NOT work because most git hosts refuse `git fetch origin <sha>`. Procedure before broadcasting SOFTWARE_UPGRADE: (1) Create annotated tag pointing to deploy commit: `git tag -a vX.Y.Z <commit> -m "description"` then `git push origin vX.Y.Z`. (2) Verify origin has it: `git ls-remote origin refs/tags/vX.Y.Z`. (3) Verify Ashburn (canary) can fetch and resolve it: `ssh vps1 'cd /root/ensoul && git fetch origin --tags && git rev-parse vX.Y.Z^{commit}'`. (4) Only then broadcast with tag field = "vX.Y.Z". Learned from the first real SOFTWARE_UPGRADE (pioneer-consensus-fix-v1.4.119, 2026-04-21): initially staged with commit hash "350d0d8" which would have failed the fetch fallback in auto-upgrade.sh on external Pioneers that did not already have that commit locally.

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

### SOP 3b: Automatic Protocol Upgrades
- For consensus-breaking changes, use the on-chain upgrade system instead of manual rolling updates.
- Flow: (1) Push code changes to a git tag (e.g., v1.5.0). (2) Submit the upgrade via API: POST /v1/admin/upgrade with name, height (target block), and tag. (3) At the target height, every ABCI halts, writes upgrade-info.json, and exits. (4) scripts/auto-upgrade.sh runs via ExecStopPost, checks out the tag, rebuilds, and places the CometBFT binary for Cosmovisor. (5) systemd restarts ABCI, Cosmovisor restarts CometBFT with the upgrade binary.
- The upgrade info field format: {"tag": "v1.5.0"} (auto-upgrade.sh reads this).
- To cancel a scheduled upgrade before the target height: POST /v1/admin/cancel-upgrade with name.
- Validators that are offline during the upgrade will apply it on next restart (upgrade-info.json persists).
- ALWAYS test upgrades on a local testnet first (SOP 3 still applies for testing).

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
- Protocol upgrades are automatic. The admin submits an on-chain SOFTWARE_UPGRADE transaction via POST /v1/admin/upgrade with name, target height, and git tag. At the target height, every ABCI halts, scripts/auto-upgrade.sh pulls the new code, rebuilds, and systemd restarts the services. No validator operator action required.
- Manual rolling updates (for non-consensus changes) go through scripts/update-all-validators.sh.
- Both social agents (X and Moltbook) are disabled via ~/.ensoul/agents-disabled and ~/.ensoul/x-agent-disabled. Do not re-enable without explicit instruction.
- Explorer, API, and monitor run on the Ashburn VPS (178.156.199.91) as systemd services (ensoul-explorer, ensoul-api, ensoul-monitor) with auto-restart. Caddy reverse proxy handles SSL via Let's Encrypt for explorer.ensoul.dev, api.ensoul.dev, and status.ensoul.dev. The MBP launchd plists for these services are no longer active.

## Future: Protocol Governance

The protocol currently has single-key admin control for foundation operations (Pioneer approvals, treasury management, parameter changes). Before mainnet or any public token event, implement multisig governance:
- Foundation treasury operations require M-of-N signatures
- Validator set changes (slashing, forced unbonding) require multisig
- Protocol parameter updates (emission rate, lock durations) require multisig
- Admin API endpoints (pioneer-approve, pioneer-reject, pioneer-delegate) must transition from single admin key to multisig authorization
- No single point of failure for protocol control
- Research Cosmos SDK's x/gov and x/group modules, and Safe (formerly Gnosis Safe) patterns for the multisig design

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
