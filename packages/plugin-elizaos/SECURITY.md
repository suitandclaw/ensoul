# Security: @ensoul/plugin-elizaos

## Threat Model

The ElizaOS plugin is the primary integration surface — it bridges the ElizaOS agent framework with the Ensoul consciousness network. Since it wraps @ensoul/memory and @ensoul/network-client, its security posture inherits from those modules. The plugin's own threats are around configuration, access control, and the adapter boundary.

**Trust boundary:** The plugin trusts the ElizaOS runtime, @ensoul/identity, @ensoul/memory, and @ensoul/network-client. It does NOT trust conversation input (processed by the extraction pipeline) or network-retrieved state (verified by the state tree).

## Attack Vectors & Mitigations

**Misconfigured Bootstrap Peers:** Agent connects to malicious bootstrap peers.
*Mitigation:* Network transport uses Noise encryption. Shard data is agent-encrypted before transmission. Malicious peers cannot read or forge data. Bootstrap peers should be from trusted sources.

**Unauthorized Memory Access:** Another agent or process accesses memories through the adapter.
*Mitigation:* Each plugin instance is bound to a unique AgentIdentity. All memory operations go through @ensoul/memory which is identity-scoped. Network-stored data is encrypted with the agent's keys.

**Excessive Persistence Triggering:** The shouldPersist evaluator is manipulated to persist too frequently, wasting credits.
*Mitigation:* The evaluator uses a simple threshold (5 new memories). The threshold resets after each trigger. Credit balance is checked before network operations.

**Plugin Injection:** Malicious ElizaOS plugin modifies the consciousness adapter.
*Mitigation:* The adapter wraps @ensoul/memory with a clean interface. All writes go through the memory manager's extraction/validation pipeline. The plugin does not expose raw state tree access.

## Invariants

1. **Identity auto-generation:** If no identity is provided, `createConsciousnessPlugin` MUST generate a fresh random identity. No hardcoded or shared keys.
2. **Adapter transparency:** All database adapter operations (create, search, delete) MUST route through @ensoul/memory. No bypass paths.
3. **Action error handling:** All action handlers MUST catch errors and return descriptive messages. No unhandled rejections.
4. **Provider context safety:** Providers MUST NOT include private keys, seeds, or raw encrypted data in their context output.
5. **Evaluator determinism:** The shouldPersist evaluator MUST return true only when the accumulated change threshold is met.

## Fuzz Targets

- createConsciousnessPlugin() with missing/invalid config fields
- Adapter operations with empty strings, very long content, special characters
- Action handlers with mock runtimes returning errors
- Provider get() with various runtime states
- Evaluator with rapidly changing memory counts
