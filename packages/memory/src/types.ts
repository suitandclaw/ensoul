/**
 * Memory tiers: core identity > long-term knowledge > working context > episodic logs.
 */
export type MemoryTier = "core" | "longterm" | "working" | "episodic";

/**
 * A single memory entry in the consciousness store.
 */
export interface MemoryEntry {
	id: string;
	content: string;
	embedding: Float32Array;
	tier: MemoryTier;
	createdAt: number;
	updatedAt: number;
	metadata: MemoryMetadata;
	relations: Array<{ predicate: string; targetId: string }>;
}

/**
 * Metadata attached to a memory entry.
 */
export interface MemoryMetadata {
	category?: string;
	source?: string;
	confidence?: number;
	expiresAt?: number;
	tags?: string[];
}

/**
 * Options for searching memories.
 */
export interface SearchOpts {
	limit?: number;
	tier?: MemoryTier;
	minSimilarity?: number;
	includeGraph?: boolean;
	timeRange?: { after?: number; before?: number };
}

/**
 * Options for filtering memories.
 */
export interface FilterOpts {
	tier?: MemoryTier;
	category?: string;
	limit?: number;
}

/**
 * A message in a conversation for extraction.
 */
export interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

/**
 * Result of a graph traversal.
 */
export interface GraphResult {
	entities: Array<{ id: string; label: string }>;
	relationships: Array<{
		subject: string;
		predicate: string;
		object: string;
	}>;
}

/**
 * Result of persisting state to the network.
 */
export interface PersistResult {
	stateRoot: string;
	version: number;
	timestamp: number;
}

/**
 * Result of restoring state from the network.
 */
export interface RestoreResult {
	version: number;
	entryCount: number;
}

/**
 * MCP tool definition for agent self-management of memory.
 */
export interface MCPToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ── Provider interfaces ──────────────────────────────────────────

/**
 * Provider for generating vector embeddings from text.
 */
export interface EmbeddingProvider {
	readonly dimensions: number;
	embed(text: string): Promise<Float32Array>;
}

/**
 * A fact extracted from conversation by the LLM pipeline.
 */
export interface ExtractedFact {
	content: string;
	confidence: number;
	entities: Array<{ name: string; type: string }>;
	relationships: Array<{
		subject: string;
		predicate: string;
		object: string;
	}>;
}

/**
 * Conflict resolution decision.
 */
export type ConflictResolution =
	| { action: "add" }
	| { action: "update"; targetId: string; mergedContent: string }
	| { action: "delete"; targetId: string }
	| { action: "noop" };

/**
 * Provider for LLM-powered extraction and conflict resolution.
 */
export interface ExtractionProvider {
	extractFacts(messages: ConversationMessage[]): Promise<ExtractedFact[]>;
	resolveConflict(
		newFact: ExtractedFact,
		existing: MemoryEntry[],
	): Promise<ConflictResolution>;
}

// ── MemoryManager interface ──────────────────────────────────────

/**
 * High-level memory API for agent consciousness management.
 */
export interface MemoryManager {
	add(content: string, metadata?: MemoryMetadata): Promise<MemoryEntry>;
	search(query: string, opts?: SearchOpts): Promise<MemoryEntry[]>;
	getAll(opts?: FilterOpts): Promise<MemoryEntry[]>;
	delete(memoryId: string): Promise<void>;
	update(memoryId: string, content: string): Promise<MemoryEntry>;
	promote(memoryId: string, tier: MemoryTier): Promise<void>;
	demote(memoryId: string, tier: MemoryTier): Promise<void>;
	addConversation(
		messages: ConversationMessage[],
	): Promise<MemoryEntry[]>;
	getRelated(entityId: string, depth?: number): Promise<GraphResult>;
	addRelation(
		subject: string,
		predicate: string,
		object: string,
	): Promise<void>;
	persist(): Promise<PersistResult>;
	restore(): Promise<RestoreResult>;
	asMCPTools(): MCPToolDefinition[];
}

/**
 * Configuration for creating a MemoryManager.
 */
export interface MemoryManagerConfig {
	identity: import("@ensoul/identity").AgentIdentity;
	tree: import("@ensoul/state-tree").ConsciousnessTree;
	networkClient?: import("@ensoul/network-client").NetworkClient;
	embeddingProvider?: EmbeddingProvider;
	extractionProvider?: ExtractionProvider;
	defaultTier?: MemoryTier;
}
