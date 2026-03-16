# Security: @ensoul/memory

## Threat Model

The memory manager is the high-level intelligence layer that manages an agent's consciousness. It processes conversations through an extraction pipeline, stores facts with vector embeddings, manages a knowledge graph, and syncs with the decentralized network. The primary threats are memory poisoning, cross-agent leakage, and extraction pipeline manipulation.

**Trust boundary:** The module trusts the local runtime, @ensoul/identity for cryptography, and @ensoul/state-tree for integrity. It does NOT trust raw conversation input (may contain injection attempts), LLM extraction outputs (may hallucinate), or network-retrieved state (verified via Merkle proofs and signatures).

**Assets protected:**
- Agent consciousness (memories, knowledge graph, embeddings)
- Memory integrity (extraction pipeline correctness)
- Privacy (all data encrypted before network persistence)

## Attack Vectors & Mitigations

### Memory Poisoning
**Vector:** Malicious conversation input designed to inject false memories or override existing knowledge.
**Mitigation:** The extraction pipeline uses conflict resolution — new facts are compared against existing memories. The fallback extractor is conservative (noop when similar exists). LLM-based extractors should include confidence scoring. Memories carry `confidence` metadata for downstream filtering.

### Cross-Agent Memory Leak
**Vector:** Agent A accidentally retrieves or modifies Agent B's memories.
**Mitigation:** Each MemoryManager instance is bound to a single AgentIdentity and ConsciousnessTree. All network persistence uses agent-owned encryption. Even at the storage layer, data is encrypted before leaving the agent's runtime.

### Extraction Pipeline Injection
**Vector:** Attacker crafts conversation messages that cause the LLM extractor to produce malicious output (prompt injection via memory).
**Mitigation:** The extraction provider interface is pluggable. The fallback keyword extractor has no LLM and cannot be prompt-injected. When an LLM provider is used, extracted facts should be sanitized and confidence-scored. The memory manager does not execute extracted content as code.

### Vector Search Poisoning
**Vector:** Attacker adds many memories with crafted embeddings to dominate search results.
**Mitigation:** Embeddings are generated locally by the agent's own embedding provider. External parties cannot inject embeddings. Search results include similarity scores for threshold filtering.

### State Rollback via Network
**Vector:** Attacker serves old network state, rolling back the agent's memories.
**Mitigation:** The state tree has version tracking and signed transitions. The `restore()` method rebuilds from network state, but the agent tracks its latest known version locally. Version regression should be detected and rejected by the state-tree layer.

### Embedding Provider Mismatch
**Vector:** Switching embedding providers makes existing vectors incompatible, producing nonsensical search results.
**Mitigation:** The embedding provider's `dimensions` are checked at construction. If dimensions change, the vector index is cleared on reload. In production, embedding provider metadata should be stored in the state tree.

## Invariants

1. **Memory isolation:** A MemoryManager instance MUST only access memories belonging to its configured identity. No cross-agent access is possible.
2. **Extraction does not leak raw input:** The extraction pipeline MUST NOT persist raw conversation messages to the network. Only extracted, processed facts are stored.
3. **Search correctness:** `search()` MUST return results ordered by descending cosine similarity. Results below `minSimilarity` MUST be excluded.
4. **Delete is complete:** `delete()` MUST remove the entry, its embedding, and its vector index entry. No orphaned data.
5. **Tier consistency:** After `promote(id, tier)`, `getAll({ tier })` MUST include the promoted entry.
6. **State tree fidelity:** All mutations (add, update, delete, promote, demote) MUST be reflected in the state tree, producing signed transitions.
7. **Graph bidirectionality:** `addRelation(A, pred, B)` MUST be traversable from both A and B via `getRelated()`.

## Fuzz Targets

### add() / update()
- Content: empty string, very long strings (100KB), unicode, special characters
- Metadata: missing fields, deeply nested objects, large tag arrays

### search()
- Query: empty, single character, very long, binary characters
- Options: limit=0, negative minSimilarity, nonexistent tier

### addConversation()
- Messages: empty array, hundreds of messages, very long messages
- Adversarial: prompt injection attempts, messages with only whitespace

### Graph operations
- Entity IDs with special characters, colons, slashes
- Very deep traversal (depth=100), circular graphs, isolated nodes

## Cryptographic Primitives

| Operation | Library | Algorithm |
|-----------|---------|-----------|
| Memory ID generation | @noble/hashes | Blake3 |
| State persistence | @ensoul/state-tree | Blake3 Merkle tree |
| Network encryption | @ensoul/identity | X25519 + XSalsa20-Poly1305 |
| Transition signing | @ensoul/identity | Ed25519 |
| Embedding | Pluggable (KeywordFallback default) | FNV-1a hash + L2 normalize |

**No custom cryptography is implemented.** The keyword fallback embedder uses FNV-1a (a non-cryptographic hash) for bag-of-words vectorization — this is for similarity search, not security.
