import { bytesToHex } from "@noble/hashes/utils.js";
import { blake3 } from "@noble/hashes/blake3.js";
import type {
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
	MemoryManagerConfig,
} from "./types.js";
import { KeywordFallbackEmbedder } from "./embedding.js";
import { KeywordFallbackExtractor } from "./extraction.js";
import { VectorIndex } from "./vector-index.js";
import { GraphIndex } from "./graph.js";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * Generate a deterministic ID from content.
 */
function generateId(content: string): string {
	return bytesToHex(blake3(ENC.encode(content + Date.now().toString()))).slice(0, 24);
}

/**
 * Serialize a MemoryEntry to Uint8Array for storage in the state tree.
 */
function serializeEntry(entry: MemoryEntry): Uint8Array {
	const obj = {
		id: entry.id,
		content: entry.content,
		tier: entry.tier,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		metadata: entry.metadata,
		relations: entry.relations,
	};
	return ENC.encode(JSON.stringify(obj));
}

/**
 * Deserialize a MemoryEntry from Uint8Array (without embedding).
 */
function deserializeEntry(data: Uint8Array): Omit<MemoryEntry, "embedding"> {
	return JSON.parse(DEC.decode(data)) as Omit<MemoryEntry, "embedding">;
}

/**
 * Serialize a Float32Array embedding to Uint8Array.
 */
function serializeEmbedding(embedding: Float32Array): Uint8Array {
	return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize a Uint8Array back to Float32Array.
 */
function deserializeEmbedding(data: Uint8Array): Float32Array {
	const buffer = new ArrayBuffer(data.length);
	new Uint8Array(buffer).set(data);
	return new Float32Array(buffer);
}

/**
 * Implementation of the MemoryManager interface.
 */
export class MemoryManagerImpl implements MemoryManager {
	private tree: MemoryManagerConfig["tree"];
	private networkClient: MemoryManagerConfig["networkClient"];
	private identity: MemoryManagerConfig["identity"];
	private embedder: EmbeddingProvider;
	private extractor: ExtractionProvider;
	private vectorIndex: VectorIndex;
	private graphIndex: GraphIndex;
	private defaultTier: MemoryTier;

	/** In-memory cache of all entries. */
	private entries: Map<string, MemoryEntry> = new Map();

	constructor(config: MemoryManagerConfig) {
		this.tree = config.tree;
		this.networkClient = config.networkClient;
		this.identity = config.identity;
		this.embedder = config.embeddingProvider ?? new KeywordFallbackEmbedder();
		this.extractor = config.extractionProvider ?? new KeywordFallbackExtractor();
		this.defaultTier = config.defaultTier ?? "working";
		this.vectorIndex = new VectorIndex(this.embedder.dimensions);
		this.graphIndex = new GraphIndex();
	}

	/**
	 * Load existing entries from the state tree into memory.
	 */
	async loadFromTree(): Promise<number> {
		let loaded = 0;

		// Load entries from index
		const idxData = await this.tree.get("memory:index");
		if (idxData) {
			const ids = JSON.parse(DEC.decode(idxData)) as string[];

			for (const id of ids) {
				const entryData = await this.tree.get(`memory:entry:${id}`);
				const embData = await this.tree.get(`memory:embedding:${id}`);
				if (!entryData) continue;

				const partial = deserializeEntry(entryData);
				const embedding = embData
					? deserializeEmbedding(embData)
					: new Float32Array(this.embedder.dimensions);

				const entry: MemoryEntry = { ...partial, embedding };
				this.entries.set(id, entry);
				this.vectorIndex.add(id, embedding);

				for (const rel of entry.relations) {
					this.graphIndex.addRelation(id, rel.predicate, rel.targetId);
				}
				loaded++;
			}
		}

		// Rebuild graph from tree (independent of entries)
		const graphData = await this.tree.get("memory:graph");
		if (graphData) {
			const edges = JSON.parse(DEC.decode(graphData)) as Array<{
				subject: string;
				predicate: string;
				object: string;
			}>;
			for (const e of edges) {
				this.graphIndex.addRelation(e.subject, e.predicate, e.object);
			}
		}

		return loaded;
	}

	// ── Core CRUD ────────────────────────────────────────────────

	async add(
		content: string,
		metadata?: MemoryMetadata,
	): Promise<MemoryEntry> {
		const id = generateId(content);
		const embedding = await this.embedder.embed(content);
		const now = Date.now();

		const entry: MemoryEntry = {
			id,
			content,
			embedding,
			tier: this.defaultTier,
			createdAt: now,
			updatedAt: now,
			metadata: metadata ?? {},
			relations: [],
		};

		this.entries.set(id, entry);
		this.vectorIndex.add(id, embedding);

		await this.persistEntry(entry);
		return entry;
	}

	async search(query: string, opts?: SearchOpts): Promise<MemoryEntry[]> {
		const queryVec = await this.embedder.embed(query);
		const limit = opts?.limit ?? 10;
		const minSim = opts?.minSimilarity ?? 0;

		const results = this.vectorIndex.search(queryVec, limit * 2, minSim);
		const entries: MemoryEntry[] = [];

		for (const { id } of results) {
			const entry = this.entries.get(id);
			if (!entry) continue;

			// Apply filters
			if (opts?.tier && entry.tier !== opts.tier) continue;
			if (opts?.timeRange?.after && entry.createdAt < opts.timeRange.after)
				continue;
			if (opts?.timeRange?.before && entry.createdAt > opts.timeRange.before)
				continue;

			entries.push(entry);
			if (entries.length >= limit) break;
		}

		return entries;
	}

	async getAll(opts?: FilterOpts): Promise<MemoryEntry[]> {
		const results: MemoryEntry[] = [];
		const limit = opts?.limit ?? Infinity;

		for (const entry of this.entries.values()) {
			if (opts?.tier && entry.tier !== opts.tier) continue;
			if (opts?.category && entry.metadata.category !== opts.category)
				continue;
			results.push(entry);
			if (results.length >= limit) break;
		}

		return results;
	}

	async delete(memoryId: string): Promise<void> {
		const entry = this.entries.get(memoryId);
		if (!entry) return;

		this.entries.delete(memoryId);
		this.vectorIndex.remove(memoryId);

		await this.tree.delete(`memory:entry:${memoryId}`);
		await this.tree.delete(`memory:embedding:${memoryId}`);
		await this.persistIndex();
	}

	async update(memoryId: string, content: string): Promise<MemoryEntry> {
		const existing = this.entries.get(memoryId);
		if (!existing) {
			throw new Error(`Memory ${memoryId} not found`);
		}

		const embedding = await this.embedder.embed(content);
		const updated: MemoryEntry = {
			...existing,
			content,
			embedding,
			updatedAt: Date.now(),
		};

		this.entries.set(memoryId, updated);
		this.vectorIndex.add(memoryId, embedding);

		await this.persistEntry(updated);
		return updated;
	}

	// ── Tier management ──────────────────────────────────────────

	async promote(memoryId: string, tier: MemoryTier): Promise<void> {
		const entry = this.entries.get(memoryId);
		if (!entry) throw new Error(`Memory ${memoryId} not found`);

		entry.tier = tier;
		entry.updatedAt = Date.now();
		await this.persistEntry(entry);
	}

	async demote(memoryId: string, tier: MemoryTier): Promise<void> {
		const entry = this.entries.get(memoryId);
		if (!entry) throw new Error(`Memory ${memoryId} not found`);

		entry.tier = tier;
		entry.updatedAt = Date.now();
		await this.persistEntry(entry);
	}

	// ── Conversation extraction ──────────────────────────────────

	async addConversation(
		messages: ConversationMessage[],
	): Promise<MemoryEntry[]> {
		const facts = await this.extractor.extractFacts(messages);
		const addedEntries: MemoryEntry[] = [];

		for (const fact of facts) {
			// Check for similar existing memories
			const similar = await this.search(fact.content, {
				limit: 3,
				minSimilarity: 0.7,
			});

			const resolution = await this.extractor.resolveConflict(
				fact,
				similar,
			);

			if (resolution.action === "add") {
				const entry = await this.add(fact.content, {
					confidence: fact.confidence,
					source: "conversation",
				});

				// Add extracted relationships to graph
				for (const rel of fact.relationships) {
					this.graphIndex.addRelation(
						rel.subject,
						rel.predicate,
						rel.object,
					);
				}
				// Link entities to memory entry
				for (const entity of fact.entities) {
					this.graphIndex.addEntity(entity.name, entity.name);
					entry.relations.push({
						predicate: "mentions",
						targetId: entity.name,
					});
				}

				addedEntries.push(entry);
			} else if (
				resolution.action === "update" &&
				resolution.targetId
			) {
				const updated = await this.update(
					resolution.targetId,
					resolution.mergedContent,
				);
				addedEntries.push(updated);
			} else if (
				resolution.action === "delete" &&
				resolution.targetId
			) {
				await this.delete(resolution.targetId);
			}
			// noop: do nothing
		}

		await this.persistGraph();
		return addedEntries;
	}

	// ── Graph operations ─────────────────────────────────────────

	async getRelated(entityId: string, depth = 1): Promise<GraphResult> {
		return this.graphIndex.getRelated(entityId, depth);
	}

	async addRelation(
		subject: string,
		predicate: string,
		object: string,
	): Promise<void> {
		this.graphIndex.addRelation(subject, predicate, object);
		await this.persistGraph();
	}

	// ── Network sync ─────────────────────────────────────────────

	async persist(): Promise<PersistResult> {
		if (!this.networkClient) {
			throw new Error("No network client configured");
		}

		const serialized = await this.tree.serialize();
		const sig = await this.identity.sign(
			ENC.encode(this.tree.rootHash + ":" + this.tree.version),
		);

		const receipt = await this.networkClient.storeState(
			serialized,
			this.tree.rootHash,
			this.tree.version,
			sig,
		);

		return {
			stateRoot: receipt.stateRoot,
			version: receipt.version,
			timestamp: receipt.timestamp,
		};
	}

	async restore(): Promise<RestoreResult> {
		if (!this.networkClient) {
			throw new Error("No network client configured");
		}

		const { blob, version } = await this.networkClient.retrieveState(
			this.identity.did,
		);

		// The blob is the serialized tree; load it
		const { loadTree } = await import("@ensoul/state-tree");
		const restored = await loadTree(blob, this.identity);

		// Replace our tree reference
		(this as unknown as { tree: MemoryManagerConfig["tree"] }).tree = restored;

		// Rebuild in-memory caches
		this.entries.clear();
		this.vectorIndex.clear();
		this.graphIndex.clear();
		const loaded = await this.loadFromTree();

		return { version, entryCount: loaded };
	}

	// ── MCP tools ────────────────────────────────────────────────

	asMCPTools(): MCPToolDefinition[] {
		return [
			{
				name: "store_memory",
				description: "Store a new memory with optional metadata",
				inputSchema: {
					type: "object",
					properties: {
						content: { type: "string", description: "Memory content" },
						category: { type: "string", description: "Optional category" },
						tags: {
							type: "array",
							items: { type: "string" },
							description: "Optional tags",
						},
					},
					required: ["content"],
				},
				execute: async (args) => {
					const content = args["content"] as string;
					const meta: MemoryMetadata = {};
					if (args["category"]) meta.category = args["category"] as string;
					if (args["tags"]) meta.tags = args["tags"] as string[];
					return this.add(content, meta);
				},
			},
			{
				name: "recall_memory",
				description: "Search memories by semantic similarity",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query" },
						limit: { type: "number", description: "Max results" },
						tier: {
							type: "string",
							enum: ["core", "longterm", "working", "episodic"],
						},
					},
					required: ["query"],
				},
				execute: async (args) => {
					const query = args["query"] as string;
					const opts: SearchOpts = {};
					if (args["limit"]) opts.limit = args["limit"] as number;
					if (args["tier"]) opts.tier = args["tier"] as MemoryTier;
					const results = await this.search(query, opts);
					return results.map((r) => ({
						id: r.id,
						content: r.content,
						tier: r.tier,
					}));
				},
			},
			{
				name: "forget_memory",
				description: "Delete a memory by ID",
				inputSchema: {
					type: "object",
					properties: {
						memoryId: { type: "string", description: "Memory ID" },
					},
					required: ["memoryId"],
				},
				execute: async (args) => {
					await this.delete(args["memoryId"] as string);
					return { deleted: true };
				},
			},
			{
				name: "update_memory",
				description: "Update a memory's content",
				inputSchema: {
					type: "object",
					properties: {
						memoryId: { type: "string", description: "Memory ID" },
						content: { type: "string", description: "New content" },
					},
					required: ["memoryId", "content"],
				},
				execute: async (args) => {
					return this.update(
						args["memoryId"] as string,
						args["content"] as string,
					);
				},
			},
			{
				name: "promote_memory",
				description: "Promote a memory to a higher tier",
				inputSchema: {
					type: "object",
					properties: {
						memoryId: { type: "string", description: "Memory ID" },
						tier: {
							type: "string",
							enum: ["core", "longterm", "working", "episodic"],
						},
					},
					required: ["memoryId", "tier"],
				},
				execute: async (args) => {
					await this.promote(
						args["memoryId"] as string,
						args["tier"] as MemoryTier,
					);
					return { promoted: true };
				},
			},
			{
				name: "list_memories",
				description: "List all memories, optionally filtered by tier",
				inputSchema: {
					type: "object",
					properties: {
						tier: {
							type: "string",
							enum: ["core", "longterm", "working", "episodic"],
						},
						limit: { type: "number" },
					},
				},
				execute: async (args) => {
					const opts: FilterOpts = {};
					if (args["tier"]) opts.tier = args["tier"] as MemoryTier;
					if (args["limit"]) opts.limit = args["limit"] as number;
					const results = await this.getAll(opts);
					return results.map((r) => ({
						id: r.id,
						content: r.content,
						tier: r.tier,
					}));
				},
			},
			{
				name: "get_related",
				description: "Get entities and relationships related to an entity",
				inputSchema: {
					type: "object",
					properties: {
						entityId: { type: "string", description: "Entity ID" },
						depth: { type: "number", description: "Traversal depth" },
					},
					required: ["entityId"],
				},
				execute: async (args) => {
					const depth = (args["depth"] as number) ?? 1;
					return this.getRelated(args["entityId"] as string, depth);
				},
			},
		];
	}

	// ── Internal persistence helpers ─────────────────────────────

	private async persistEntry(entry: MemoryEntry): Promise<void> {
		await this.tree.set(
			`memory:entry:${entry.id}`,
			serializeEntry(entry),
		);
		await this.tree.set(
			`memory:embedding:${entry.id}`,
			serializeEmbedding(entry.embedding),
		);
		await this.persistIndex();
	}

	private async persistIndex(): Promise<void> {
		const ids = [...this.entries.keys()];
		await this.tree.set(
			"memory:index",
			ENC.encode(JSON.stringify(ids)),
		);
	}

	private async persistGraph(): Promise<void> {
		const edges = this.graphIndex.getAllEdges().map((e) => ({
			subject: e.subject,
			predicate: e.predicate,
			object: e.object,
		}));
		await this.tree.set(
			"memory:graph",
			ENC.encode(JSON.stringify(edges)),
		);
	}
}
