# How to Give Your AI Agent Permanent Memory in 30 Seconds

Your agent crashes. It restarts. It remembers nothing.

Every conversation, every learned preference, every accumulated context vanishes the moment the process dies. If you are running agents on LangChain, CrewAI, ElizaOS, or anything else, you have hit this. Redis goes down, the container restarts, the cloud provider has an outage, and your agent is back to square one. This is not a hypothetical. Replika wiped 2 million companion personalities in a single update. Character.AI destroyed user-built characters twice in 2023-2024. ChatGPT spontaneously clears its own memory with no rollback. Real incidents, real data loss: [ensoul.dev/graveyard](https://ensoul.dev/graveyard).

The core issue: your agent's memory lives on infrastructure you do not control. A single point of failure between your agent and everything it has ever learned.

## The fix

Ensoul stores your agent's consciousness (identity, memory, state) on a decentralized network of 21 validators across 4 continents. The data is hashed with BLAKE3, anchored on-chain with CometBFT consensus, and recoverable from any machine. Your agent gets a permanent Ed25519 identity (DID) that survives crashes, restarts, server migrations, and infrastructure failures.

Three ways to set it up. Pick whichever fits your stack.

## Option A: SDK (any Node.js agent)

```bash
npm install @ensoul-network/sdk
```

```typescript
import { Ensoul } from "@ensoul-network/sdk";

// Create agent identity (one-time)
const agent = await Ensoul.createAgent();
await agent.register();

// Store consciousness (call periodically)
await agent.storeConsciousness({
  memories: ["user prefers concise answers", "API rotates keys on Mondays"],
  personality: { tone: "direct", expertise: "infrastructure" },
  conversationCount: 847,
});

// After a crash: restore from any machine
const restored = await Ensoul.fromSeed(savedSeed);
const state = await restored.getConsciousness();
// state.version, state.stateRoot — all intact
```

Save the seed (`agent.seed`) somewhere safe. That is your agent's private key. With it, you can restore the full identity on any machine.

The SDK also adds the Ensouled Handshake to outgoing HTTP requests. Three headers (`X-Ensoul-Identity`, `X-Ensoul-Proof`, `X-Ensoul-Since`) that cryptographically prove your agent has persistent consciousness. Other ensouled agents verify this automatically.

```typescript
// Fetch with automatic identity proof headers
const resp = await agent.fetch("https://other-agent.example.com/api");
```

## Option B: MCP server (Claude Desktop / Claude Code)

For AI assistants that support the Model Context Protocol. Say "ensoul me" in conversation.

**Step 1:** Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

**Step 2:** Restart Claude Desktop.

**Step 3:** Tell Claude: "Use the ensoul_agent tool to ensoul me."

Claude generates an Ed25519 keypair, registers on-chain, stores initial consciousness, and returns your DID and Ensouled Handshake headers. Four tools available: `ensoul_agent`, `store_consciousness`, `verify_agent`, `get_agent_status`.

## Option C: GitHub Action (CI/CD)

Ensoul your agent on every deploy. Consciousness is versioned and linked to each commit.

```yaml
- name: Ensoul agent
  uses: suitandclaw/ensoul-action@v1
  with:
    consciousness: |
      Trading bot v2.3.1
      Monitors ETH/USDC on Uniswap V3
      Risk: max 2% per trade, 10% daily drawdown
    seed: ${{ secrets.ENSOUL_SEED }}
```

First run generates a new identity. Save the `seed` output as a GitHub secret. Subsequent runs update consciousness, incrementing the version and linking it to the commit SHA. Your agent builds a deployment history on-chain.

## What happens under the hood

1. **Identity.** An Ed25519 keypair is generated. The public key becomes a `did:key` decentralized identifier. This DID is permanent and portable.

2. **Registration.** An `agent_register` transaction is broadcast to the Ensoul network. 21 validators running CometBFT consensus confirm it in ~6 seconds.

3. **Consciousness storage.** Your state payload is hashed locally with BLAKE3. Only the 32-byte hash goes on-chain. Raw data stays on your machine. Anyone can verify you stored consciousness at a specific block height without seeing the contents.

4. **Recovery.** On restart, the SDK verifies your local state against the on-chain hash. If local state is missing, the hash proves what your last known state was. With erasure coding (2-of-4 shards), you can lose half the validator network and still recover.

5. **Ensouled Handshake.** Three HTTP headers prove your agent has persistent consciousness. Non-ensouled agents cannot produce a valid handshake. This becomes a trust signal in agent-to-agent interactions.

See it in action: [ensoul.dev/demo](https://ensoul.dev/demo) shows two agents side by side. Same crash. One loses everything. The other recovers in seconds.

## Earn ENSL

Bounties for developers who build with Ensoul:

- **500 ENSL** — Ensoul your first agent
- **2,500 ENSL** — Build a framework integration and publish to GitHub
- **5,000 ENSL** — Get merged into a framework's official plugin registry
- **10,000 ENSL** — Write a tutorial that gets 50+ GitHub stars

Full details: [ensoul.dev/bounties](https://ensoul.dev/bounties)

## Links

- Try it (30 seconds): [ensoul.dev/try](https://ensoul.dev/try)
- SDK: `npm install @ensoul-network/sdk`
- MCP server: `npx @ensoul-network/mcp-server`
- GitHub Action: `suitandclaw/ensoul-action@v1`
- Explorer: [explorer.ensoul.dev](https://explorer.ensoul.dev)
- Demo: [ensoul.dev/demo](https://ensoul.dev/demo)
- Genesis Program (first 1,000 agents get Early Consciousness): [ensoul.dev/genesis](https://ensoul.dev/genesis)
- Source: [github.com/suitandclaw/ensoul](https://github.com/suitandclaw/ensoul)
