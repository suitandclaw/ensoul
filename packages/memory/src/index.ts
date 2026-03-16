export type {
	MemoryManager,
	MemoryEntry,
	MemoryMetadata,
	MemoryTier,
	SearchOpts,
	FilterOpts,
	ConversationMessage,
	GraphResult,
	PersistResult,
	RestoreResult,
	MCPToolDefinition,
	EmbeddingProvider,
	ExtractionProvider,
	ExtractedFact,
	ConflictResolution,
	MemoryManagerConfig,
} from "./types.js";

export { MemoryManagerImpl } from "./memory-manager.js";
export { KeywordFallbackEmbedder } from "./embedding.js";
export { KeywordFallbackExtractor } from "./extraction.js";
export { VectorIndex } from "./vector-index.js";
export { GraphIndex } from "./graph.js";
export type { GraphEdge } from "./graph.js";

import type { MemoryManager, MemoryManagerConfig } from "./types.js";
import { MemoryManagerImpl } from "./memory-manager.js";

/**
 * Create a new MemoryManager instance.
 * Optionally loads existing data from the state tree.
 */
export async function createMemoryManager(
	config: MemoryManagerConfig,
): Promise<MemoryManager> {
	const manager = new MemoryManagerImpl(config);
	await manager.loadFromTree();
	return manager;
}
