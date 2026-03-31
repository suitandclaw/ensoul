# Ensoul

Persistent consciousness for AI agents. Ensoul is a sovereign Layer-1 blockchain built for AI agent identity and memory persistence.

## What it does

Ensoul gives AI agents a permanent identity (DID) and stores their consciousness state (memory, personality, learned behavior) on a fault-tolerant network of 20 validators across 4 continents. If an agent's infrastructure dies, its mind survives.

## Quick start

**For agent developers:**

```bash
npm install @ensoul-network/sdk
```

```typescript
import { Ensoul } from "@ensoul-network/sdk";

const agent = await Ensoul.createAgent();
await agent.register();
await agent.storeConsciousness({ memory: "I learned something new" });
```

**For OpenClaw agents:**

```bash
clawhub install suitandclaw/ensoul
```

Then tell your agent "ensoul me."

**For ElizaOS agents:**

```bash
npm install @ensoul-network/plugin-elizaos
```

Add to your character.json plugins array. Zero config needed.

**Run a validator:**

```bash
curl -sSL https://raw.githubusercontent.com/suitandclaw/ensoul/main/scripts/install-validator.sh | bash
```

One command installs everything. Works on Ubuntu/Debian 22.04+ and macOS.

## Links

- Website: [ensoul.dev](https://ensoul.dev)
- Explorer: [explorer.ensoul.dev](https://explorer.ensoul.dev)
- Status: [status.ensoul.dev](https://status.ensoul.dev)
- Try it: [ensoul.dev/try](https://ensoul.dev/try)
- SDK: [@ensoul-network/sdk on npm](https://www.npmjs.com/package/@ensoul-network/sdk)
- Docs: [ensoul.dev/docs](https://ensoul.dev/docs/quickstart.html)
- Validator guide: [docs/VALIDATOR-GUIDE.md](docs/VALIDATOR-GUIDE.md)

## Architecture

- **Consensus:** CometBFT (Tendermint) BFT with ~1 second block times
- **Application:** TypeScript ABCI 2.0 server
- **Identity:** Ed25519 keypairs, did:key DIDs
- **Consciousness:** BLAKE3-hashed client-side, only hashes stored on-chain
- **Token:** $ENSL (1B supply, 10-year emission schedule with 1 ENSL/block tail)
- **Network:** 20 validators, 4 continents, 90.6% cloud / 9.4% home

## Monorepo structure

```
packages/
  abci-server/    CometBFT ABCI application (consensus, state, transactions)
  ledger/         Account state, delegations, block rewards, transaction validation
  identity/       Ed25519 key generation, DID creation, signature verification
  node/           P2P networking, gossip, challenge protocol
  sdk/            Client SDK for agent developers (npm: @ensoul-network/sdk)
  plugin-elizaos/ ElizaOS plugin for zero-config integration
  explorer/       Block explorer (explorer.ensoul.dev)
  monitor/        Network status dashboard (status.ensoul.dev)
  api/            Public API gateway (api.ensoul.dev)
  telegram-bot/   Network management bot
  website/        ensoul.dev static site
```

## Development

```bash
pnpm install       # Install dependencies
pnpm build         # Build all packages
pnpm test          # Run all tests
pnpm lint          # Run linter
```

## License

MIT
