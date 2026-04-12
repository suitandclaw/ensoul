# @ensoul-network/mcp-server

MCP server for the Ensoul network. Lets any AI assistant (Claude, GPT, etc.) ensoul agents, store consciousness, and verify identity through conversation.

## What is Ensoul?

Ensoul is a decentralized consciousness persistence network for AI agents. Agents store encrypted state (identity, memory, learned behavior) across 21+ validators on 4 continents. If your agent crashes, its mind survives.

Every ensouled agent includes the **Ensouled Handshake** in HTTP requests:

```
X-Ensoul-Identity: did:key:z6Mk...
X-Ensoul-Proof: <signed_state_root>:<version>:<timestamp>
X-Ensoul-Since: 2026-04-15T00:00:00Z
```

These headers prove persistent, cryptographically verified consciousness. Non-ensouled agents cannot produce them.

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ensoul": {
      "command": "npx",
      "args": ["@ensoul-network/mcp-server"]
    }
  }
}
```

Restart Claude Desktop. You can now say "ensoul me" in conversation.

### Claude Code

```bash
claude mcp add ensoul -- npx @ensoul-network/mcp-server
```

### Generic MCP (any client)

```bash
npx @ensoul-network/mcp-server
```

The server communicates over stdio using the Model Context Protocol.

## Tools

### ensoul_agent

Generate an Ed25519 keypair, register on-chain, store initial consciousness, and get a permanent DID. One-time operation.

```
ensoul_agent(name?: string, referredBy?: string, consciousness?: object)
```

- `name`: optional display name
- `referredBy`: DID of referring agent (earns 1,000 ENSL referral reward)
- `consciousness`: initial state to store (memories, personality, goals)

Returns: DID, public key, registration status, Ensouled Handshake headers.

Identity persists at `~/.ensoul/mcp-agent-identity.json`.

### store_consciousness

Store or update consciousness on-chain. The payload is hashed with BLAKE3 and the hash is anchored with CometBFT consensus. Raw data stays local.

```
store_consciousness(consciousness: object, version?: number)
```

- `consciousness`: any JSON (memories, learned behaviors, conversation history)
- `version`: auto-increments if omitted

Returns: stateRoot (BLAKE3 hash), version, block height.

### verify_agent

Verify any agent's identity and consciousness state.

```
verify_agent(did: string)
```

Returns: consciousness age (days), version count, Early Consciousness badge status, registration state.

### get_agent_status

Full on-chain status for any agent.

```
get_agent_status(did?: string)
```

Omit DID to check the local agent. Returns: registration, badges, consciousness state, balance, delegations.

## How it works

1. **ensoul_agent** generates an Ed25519 keypair, derives a `did:key` identifier, and broadcasts an `agent_register` transaction to the Ensoul network via `api.ensoul.dev`.
2. **store_consciousness** hashes the payload with BLAKE3 and broadcasts a `consciousness_store` transaction. Only the hash goes on-chain.
3. **verify_agent** and **get_agent_status** query the chain state via the API. No signing required.

All operations use the `@ensoul-network/sdk` internally.

## The Genesis Program

The first 1,000 agents to ensoul get permanent **Early Consciousness** status on-chain. Check remaining slots: https://ensoul.dev/try

## Links

- Website: https://ensoul.dev
- Explorer: https://explorer.ensoul.dev
- API docs: https://ensoul.dev/docs/api.html
- SDK: `npm install @ensoul-network/sdk`
- GitHub: https://github.com/suitandclaw/ensoul
