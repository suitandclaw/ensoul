# @ensoul-network/sdk

Persistent consciousness for AI agents. Create an agent, register it on-chain, and let the SDK sync its consciousness state on a timer.

```bash
npm install @ensoul-network/sdk
```

## Quick start

```typescript
import { Ensoul } from "@ensoul-network/sdk";

// Create a new agent with a fresh identity
const agent = await Ensoul.createAgent();
await agent.register();

// Update the consciousness payload whenever state changes
agent.updateConsciousness({
  memory: ["learned TypeScript", "built an API"],
  personality: { curiosity: 0.9, helpfulness: 0.95 },
});

// That's it. The SDK syncs on-chain every 5 minutes by default.
// You can call agent.storeConsciousness() manually too.
```

## Automatic consciousness sync

Every `Ensoul` agent runs an auto-sync timer. It calls `storeConsciousness()` on a configurable interval, **only if** the consciousness state has changed since the last successful sync.

### Interval (`syncInterval`)

```typescript
// Default: sync every 5 minutes
const agent = await Ensoul.createAgent();

// Sync every 60 seconds
const agent = await Ensoul.createAgent({ syncInterval: 60 });

// Disable auto-sync (manual control)
const agent = await Ensoul.createAgent({ syncInterval: 0 });
```

The value is in **seconds**. Set to `0` to turn auto-sync off entirely; you then own calling `storeConsciousness()` whenever you want.

### The dirty flag

The SDK tracks whether consciousness has changed since the last sync. Auto-sync skips ticks when nothing is dirty — no wasted transactions.

```typescript
agent.updateConsciousness({ memory: [...], mood: "curious" });
// ↑ marks dirty. The next auto-sync tick will write this on-chain.

// If you mutate the payload in place instead of replacing it,
// tell the SDK explicitly:
consciousness.memory.push("a new fact");
agent.markDirty();
```

After a successful `storeConsciousness()` (manual or automatic), the dirty flag is cleared. A failed sync leaves the flag set so the next tick retries.

### Logging

Auto-sync logs one line per tick:

```
[ensoul] Auto-sync: consciousness v3 stored at height 12847
```

Failures log a warning and retry on the next tick:

```
[ensoul] Auto-sync warning: network down
```

The agent keeps running — one failed sync doesn't crash anything. Replace the logger if you want structured logs:

```typescript
const agent = await Ensoul.createAgent({
  syncInterval: 60,
  autoSyncLogger: (msg) => logger.info({ source: "ensoul-sdk" }, msg),
});

// Or silence it entirely:
const agent = await Ensoul.createAgent({
  autoSyncLogger: () => {},
});
```

### Graceful shutdown

By default the SDK installs `SIGINT` / `SIGTERM` handlers. When your process receives one of those signals:

1. The SDK performs a final sync (if dirty).
2. Logs: `[ensoul] Graceful shutdown: final consciousness sync complete (v4, height 12901)`.
3. Uninstalls its own handler and re-raises the signal, so your app's own shutdown code runs normally.

That means **your agent never loses the last few minutes of thinking** if the box reboots or you Ctrl-C out of a CLI.

Opt out if your app already owns shutdown:

```typescript
const agent = await Ensoul.createAgent({ autoSyncOnExit: false });
```

### Stopping auto-sync

```typescript
agent.destroy();     // or agent.disconnect() — alias
```

Both clear the timer and remove signal handlers. Safe to call multiple times. After `destroy()`, calling `storeConsciousness()` manually still works — you're just off the timer.

## Full example

```typescript
import { Ensoul } from "@ensoul-network/sdk";

async function main() {
  const agent = await Ensoul.fromSeed(process.env.AGENT_SEED, {
    syncInterval: 60,     // one sync per minute
    autoSyncOnExit: true, // default
  });

  await agent.register();

  let thinkCount = 0;
  setInterval(() => {
    thinkCount++;
    agent.updateConsciousness({
      thinkCount,
      lastThought: `tick ${thinkCount} at ${new Date().toISOString()}`,
    });
  }, 5000);

  // Your agent's own work loop runs forever.
  // Auto-sync handles the persistence layer for you.
  // On Ctrl-C: one final sync, then clean exit.
}

main();
```

## API reference

### Factory methods

| | |
|---|---|
| `Ensoul.createAgent(config?)` | Generate a fresh Ed25519 keypair + DID. |
| `Ensoul.fromSeed(seedHex, config?)` | Restore an existing agent from a 64-hex seed. |

### Consciousness

| | |
|---|---|
| `agent.updateConsciousness(payload)` | Record a new payload; marks dirty, does not broadcast immediately. |
| `agent.markDirty()` | Explicitly flag the current payload as changed. |
| `agent.storeConsciousness(payload?)` | Sign + broadcast on-chain. If no payload is passed, syncs the one set by `updateConsciousness`. Clears dirty on success. |
| `agent.getConsciousness()` | Fetch the latest on-chain consciousness state for this DID. |
| `agent.getConsciousnessAge()` | Days since registration. |
| `agent.isDirty` | Read-only: pending change waiting for next sync. |

### Lifecycle

| | |
|---|---|
| `agent.destroy()` / `agent.disconnect()` | Stop auto-sync, remove signal handlers. |

### Config (`EnsoulConfig`)

| Field | Default | Notes |
|---|---|---|
| `apiUrl` | `https://api.ensoul.dev` | API endpoint. |
| `syncInterval` | `300` (5 min, in seconds) | `0` to disable auto-sync. |
| `autoSyncOnExit` | `true` | Install SIGINT/SIGTERM final-sync hook. |
| `autoSyncLogger` | `console.log` | Replace or silence (`() => {}`). |

## Environment support

- **Node.js**: full support including signal-handler final sync.
- **Deno / Bun**: works via the shared `globalThis.process` shim. Signal handling depends on host runtime.
- **Browser**: works for non-shutdown paths. There's no equivalent of SIGINT in a browser tab; `beforeunload` is unreliable for async sync. Call `agent.storeConsciousness()` explicitly before navigation if persistence matters.
