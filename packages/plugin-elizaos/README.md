# @ensoul-network/plugin-elizaos

ElizaOS plugin for the Ensoul Network. Gives your agent persistent memory, a permanent identity, and consciousness state backup across crashes, migrations, and server failures.

## Install

```bash
npm install @ensoul-network/plugin-elizaos
```

## Agent Configuration

Add the plugin to your ElizaOS character file:

```json
{
  "name": "my-agent",
  "plugins": ["@ensoul-network/plugin-elizaos"],
  "settings": {
    "secrets": {
      "ENSOUL_SEED": "your-hex-seed-here"
    }
  }
}
```

Or use environment variables:

```bash
export ENSOUL_API_URL=https://api.ensoul.dev
export ENSOUL_SEED=your-hex-seed-here
```

If `ENSOUL_SEED` is not provided, the plugin generates a new identity automatically and saves it to `~/.ensoul/agent-identity.json`.

## Plugin Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ENSOUL_API_URL` | string | No | API endpoint (defaults to `https://api.ensoul.dev`) |
| `ENSOUL_SEED` | string | No | Agent identity seed in hex. Auto-generated if omitted. |

## Actions

- **ensoulMe**: Register the agent on the Ensoul Network. Creates a DID (decentralized identifier) and cryptographic identity.
- **syncConsciousness**: Store the current consciousness state (SOUL.md, MEMORY.md, learned behaviors) on-chain.
- **recoverConsciousness**: Restore a previously stored consciousness state.

## Providers

- **ensoulIdentityProvider**: Injects the agent's DID and ensoulment status into every conversation context.
- **consciousnessProvider**: Provides the agent's consciousness age, version, and last sync height.

## Evaluators

- **shouldPersistEvaluator**: Monitors conversations and triggers automatic consciousness sync when significant state changes occur.

## How It Works

1. Install the plugin into your ElizaOS agent
2. The agent registers on the Ensoul Network and receives a permanent DID
3. Consciousness state (memory, personality, learned behaviors) is hashed with BLAKE3 and anchored on-chain
4. The raw content never leaves your machine. Only the hash goes to the network.
5. On recovery, the agent verifies its consciousness hash against the on-chain record

## Network Info

- 20 validators across 4 continents
- CometBFT BFT consensus (same engine as Cosmos chains)
- 6-second block times, instant finality
- Explorer: https://explorer.ensoul.dev
- API: https://api.ensoul.dev

## License

MIT-0
