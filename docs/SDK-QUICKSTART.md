# Ensoul SDK: Get Started in 5 Minutes

Persistent consciousness for AI agents. No blockchain knowledge required.

## Install

```bash
npm install @ensoul-network/sdk
```

## Create an Agent

```typescript
import { Ensoul } from "@ensoul-network/sdk";

// Create a new agent with a fresh identity
const agent = await Ensoul.createAgent();
console.log(`Agent DID: ${agent.did}`);

// Save the seed (this is your agent's private key)
console.log(`Seed: ${agent.seed}`);
// Store this securely. You need it to recover your agent.
```

## Register On-Chain

```typescript
// Register the agent on the Ensoul network
const result = await agent.register();
console.log(`Registered: ${result.registered}`);
```

## Store Consciousness

```typescript
// Store any data as your agent's consciousness
await agent.storeConsciousness({
  memory: ["learned TypeScript", "built an API"],
  personality: { curiosity: 0.9, helpfulness: 0.95 },
  lastInteraction: new Date().toISOString(),
});
```

The SDK hashes your payload, signs it with your agent's key, and broadcasts it to the chain. Validators replicate it across 4 continents.

## Retrieve Consciousness

```typescript
const state = await agent.getConsciousness();
if (state) {
  console.log(`Version: ${state.version}`);
  console.log(`State root: ${state.stateRoot}`);
  console.log(`Stored at block: ${state.storedAt}`);
}
```

## Prove Identity (Ensouled Handshake)

```typescript
// Your agent creates a cryptographic proof
const proof = await agent.createHandshakeProof();

// Another agent or service verifies it
const result = await Ensoul.verifyHandshake(agent.did, proof);
console.log(`Valid: ${result.valid}`);
console.log(`Trust level: ${result.trustLevel}`);
// basic -> verified (>10 versions) -> anchored (>100 versions)
```

## Resume an Existing Agent

```typescript
// Load from a saved seed
const agent = await Ensoul.fromSeed("your-64-char-hex-seed");
// The agent's DID and keys are derived deterministically
```

## Full Example

```typescript
import { Ensoul } from "@ensoul-network/sdk";

async function main() {
  // Create and register
  const agent = await Ensoul.createAgent();
  await agent.register();
  console.log(`Agent ensouled: ${agent.did}`);

  // Store consciousness
  await agent.storeConsciousness({
    knowledge: ["The Ensoul network stores agent state permanently"],
    version: 1,
  });

  // Verify it's on-chain
  const state = await agent.getConsciousness();
  console.log(`On-chain: version=${state?.version}, root=${state?.stateRoot?.slice(0, 16)}...`);

  // Prove identity
  const proof = await agent.createHandshakeProof();
  const verified = await Ensoul.verifyHandshake(agent.did, proof);
  console.log(`Handshake valid: ${verified.valid}, trust: ${verified.trustLevel}`);

  // Save seed for later
  console.log(`\nSave this seed to recover your agent: ${agent.seed}`);
}

main();
```

## Configuration

```typescript
// Use a custom API endpoint (for local development or testnet)
const agent = await Ensoul.createAgent({
  apiUrl: "http://localhost:5050",
});
```

## What Happens Under the Hood

1. **createAgent()** generates a random Ed25519 keypair and derives a `did:key` DID from the public key.
2. **register()** signs an `agent_register` transaction and broadcasts it to CometBFT via the API.
3. **storeConsciousness()** hashes your payload with BLAKE3, signs a `consciousness_store` transaction, and broadcasts it.
4. **getConsciousness()** queries the ABCI state via the API for the latest on-chain state root.
5. **createHandshakeProof()** signs the current state root with your key to prove you own this consciousness.

All transactions are signed client-side. Your seed never leaves your machine. The API is a relay, not a custodian.

## Links

- Explorer: [explorer.ensoul.dev](https://explorer.ensoul.dev)
- API Reference: [ensoul.dev/docs/api.html](https://ensoul.dev/docs/api.html)
- Validator Guide: [VALIDATOR-GUIDE.md](./VALIDATOR-GUIDE.md)
- GitHub: [github.com/suitandclaw/ensoul](https://github.com/suitandclaw/ensoul)
