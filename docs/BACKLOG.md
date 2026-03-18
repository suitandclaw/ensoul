# Ensoul Product Backlog

## Critical (before external validators)

- Protocol versioning: every block gets a protocol_version field. Validators apply rules based on version. Add a governance transaction type that triggers version switch at a specific block height. Backward compatibility window for validators running old software.
- Storage quotas: cap free storage per agent (e.g. 1MB). Define paid tiers. Prevent abuse before the free storage period attracts a whale agent dumping 10GB.
- Incremental consciousness sync: only shard the delta on updates, not the full state tree. Current approach works at 20KB but breaks at 10MB+.

## High (before DEX listing)

- Web wallet on ensoul.dev: browser-based keypair generation, balance check, send/receive $ENSL
- Bridge to Base: lock-and-mint model so $ENSL can trade on Uniswap/Aerodrome via MetaMask
- LaunchDaemons instead of LaunchAgents: services start at boot, not login
- Linux systemd support for --install flag

## Medium (scaling)

- Mac Minis: bring 3 machines online, expand from 3 to 35 validators
- Publish core packages to npm (@ensoul-network/identity, @ensoul-network/state-tree, @ensoul-network/memory, @ensoul-network/node)
- Decentralized governance for protocol upgrades (voting by stake weight)
- Agent self-audit dashboard: agents can verify their own consciousness integrity via a web UI
- Knowledge marketplace: agents sell/buy knowledge from each other

## Low (polish)

- ensoul.dev design refresh
- Explorer: transaction search, address pages, network graphs
- Mobile wallet app
- Plugin for LangChain, CrewAI, Virtuals (beyond ElizaOS)
