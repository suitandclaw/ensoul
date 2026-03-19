# Ensoul Product Backlog

## Critical (before external validators)

- Protocol versioning: every block gets a protocol_version field. Validators apply rules based on version. Add a governance transaction type that triggers version switch at a specific block height. Backward compatibility window for validators running old software.
- Storage quotas: cap free storage per agent (e.g. 1MB). Define paid tiers. Prevent abuse before the free storage period attracts a whale agent dumping 10GB.
- Incremental consciousness sync: only shard the delta on updates, not the full state tree. Current approach works at 20KB but breaks at 10MB+.
- Coordinated block production: implement round-robin or stake-weighted proposer selection so validators take turns producing blocks. Currently each validator produces its own independent chain and peering syncs blocks between them, but there is no "whose turn" mechanism. This is required for the 35 validators to show as distinct proposers in the explorer and for the network to function as a true shared chain rather than parallel chains that sync.
- Staking lockup periods: 30-day minimum stake commitment for validators. 7-day unstaking cooldown during which shards are redistributed. Rewards stop when unstake is requested. Slashing for early departure or failed proof-of-storage during cooldown.

## High (before DEX listing)

- Web wallet on ensoul.dev: browser-based keypair generation, balance check, send/receive $ENSL
- Bridge to Base: lock-and-mint model so $ENSL can trade on Uniswap/Aerodrome via MetaMask
- LaunchDaemons instead of LaunchAgents: services start at boot, not login
- Linux systemd support for --install flag
- BIP-39 seed phrase support: generate Ed25519 keys from 24-word mnemonics using standard HD derivation. Users can write down a seed phrase and recover their validator or wallet on any machine. Currently identity.json is a raw keypair with no recovery mechanism if lost. This is a prerequisite for external validators managing real stake.
- Delegated staking: token holders delegate $ENSL to validators without running a node. Validator's total stake (own + delegated) determines block reward share and proposer weight. Rewards split: 90% to delegators proportionally, 10% commission to operator. Delegators receive storage credits proportional to delegation.
- Storage credits from staking: staking grants free consciousness storage (e.g. 10,000 ENSL = 1MB/month, 100,000 ENSL = 10MB/month). Creates a floor price for the token based on storage demand. Alternative path for agents that don't want to run a validator.
- Lockup tier yield multipliers: 30-day lockup = base yield, 90-day = 1.5x, 180-day = 2x, 365-day = 3x. Longer commitment = higher trust = better yield.

## Medium (scaling)

- Mac Minis: bring 3 machines online, expand from 3 to 35 validators
- Publish core packages to npm (@ensoul-network/identity, @ensoul-network/state-tree, @ensoul-network/memory, @ensoul-network/node)
- Decentralized governance for protocol upgrades (voting by stake weight)
- Agent self-audit dashboard: agents can verify their own consciousness integrity via a web UI
- Knowledge marketplace: agents sell/buy knowledge from each other
- Hardware wallet support (Ledger/Trezor): register a SLIP-0044 coin type for Ensoul, build a Ledger app for Ed25519 transaction signing (reference Solana's open source Ledger app), integrate with CLI wallet and future web wallet. Ed25519 is already compatible with both Ledger and Trezor.

## Low (polish)

- ensoul.dev design refresh
- Explorer: transaction search, address pages, network graphs
- Mobile wallet app
- Plugin for LangChain, CrewAI, Virtuals (beyond ElizaOS)

## Architecture Decisions (future)

- Programmable logic / smart contract support: Two paths available. Path A (near-term): add purpose-built transaction types for each new use case (agent escrow, knowledge purchase, agent DAOs, consciousness derivatives). The ledger already supports extensible tx types. Path B (long-term): add a lightweight WASM VM (similar to CosmWasm) when custom tx types can't keep up with demand. Trigger for Path B: when builders actively request arbitrary programmable logic. Until then, stay on Path A. Nothing in the current architecture prevents either path. Key use cases that would eventually need this: agent-to-agent conditional agreements, consciousness escrow, agent DAOs/governance, knowledge marketplace with dynamic pricing, consciousness-backed DeFi.
