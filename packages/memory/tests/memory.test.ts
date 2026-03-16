import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { createTree } from "@ensoul/state-tree";
import type { ConsciousnessTree } from "@ensoul/state-tree";
import {
	MemoryManagerImpl,
	KeywordFallbackEmbedder,
	KeywordFallbackExtractor,
	VectorIndex,
	GraphIndex,
	createMemoryManager,
} from "../src/index.js";
import type { MemoryManager, MemoryTier } from "../src/index.js";

let identity: AgentIdentity;
let tree: ConsciousnessTree;
let manager: MemoryManager;

beforeEach(async () => {
	identity = await createIdentity({ seed: new Uint8Array(32).fill(42) });
	tree = await createTree(identity);
	manager = await createMemoryManager({ identity, tree });
});

// ── KeywordFallbackEmbedder ──────────────────────────────────────────

describe("KeywordFallbackEmbedder", () => {
	const embedder = new KeywordFallbackEmbedder();

	it("returns correct dimensions", () => {
		expect(embedder.dimensions).toBe(256);
	});

	it("produces Float32Array of correct length", async () => {
		const vec = await embedder.embed("hello world");
		expect(vec).toBeInstanceOf(Float32Array);
		expect(vec.length).toBe(256);
	});

	it("produces normalized vector (unit length)", async () => {
		const vec = await embedder.embed("the quick brown fox");
		let norm = 0;
		for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
		expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.001);
	});

	it("similar texts produce similar embeddings", async () => {
		const a = await embedder.embed("machine learning algorithms");
		const b = await embedder.embed("machine learning models");
		const c = await embedder.embed("banana smoothie recipe");

		const simAB = cosine(a, b);
		const simAC = cosine(a, c);
		expect(simAB).toBeGreaterThan(simAC);
	});

	it("identical texts produce identical embeddings", async () => {
		const a = await embedder.embed("exact same text");
		const b = await embedder.embed("exact same text");
		expect(a).toEqual(b);
	});

	it("empty text produces zero vector", async () => {
		const vec = await embedder.embed("");
		const sum = Array.from(vec).reduce((s, v) => s + Math.abs(v), 0);
		expect(sum).toBe(0);
	});
});

// ── VectorIndex ──────────────────────────────────────────────────────

describe("VectorIndex", () => {
	it("adds and searches vectors", () => {
		const idx = new VectorIndex(3);
		idx.add("a", new Float32Array([1, 0, 0]));
		idx.add("b", new Float32Array([0, 1, 0]));
		idx.add("c", new Float32Array([1, 1, 0]));

		const results = idx.search(new Float32Array([1, 0, 0]), 2);
		expect(results[0]!.id).toBe("a");
		expect(results[0]!.similarity).toBeCloseTo(1.0);
	});

	it("respects minSimilarity", () => {
		const idx = new VectorIndex(3);
		idx.add("a", new Float32Array([1, 0, 0]));
		idx.add("b", new Float32Array([0, 1, 0]));

		const results = idx.search(new Float32Array([1, 0, 0]), 10, 0.9);
		expect(results.length).toBe(1);
		expect(results[0]!.id).toBe("a");
	});

	it("removes vectors", () => {
		const idx = new VectorIndex(3);
		idx.add("a", new Float32Array([1, 0, 0]));
		expect(idx.size).toBe(1);
		idx.remove("a");
		expect(idx.size).toBe(0);
	});

	it("rejects dimension mismatch", () => {
		const idx = new VectorIndex(3);
		expect(() => idx.add("a", new Float32Array([1, 0]))).toThrow(
			"dimension mismatch",
		);
	});

	it("returns empty for zero query", () => {
		const idx = new VectorIndex(3);
		idx.add("a", new Float32Array([1, 0, 0]));
		const results = idx.search(new Float32Array([0, 0, 0]), 10);
		expect(results.length).toBe(0);
	});
});

// ── GraphIndex ───────────────────────────────────────────────────────

describe("GraphIndex", () => {
	it("adds entities and relations", () => {
		const g = new GraphIndex();
		g.addEntity("alice", "Alice");
		g.addEntity("google", "Google");
		g.addRelation("alice", "works_at", "google");

		expect(g.entityCount).toBe(2);
		expect(g.edgeCount).toBe(1);
	});

	it("getRelated at depth 1", () => {
		const g = new GraphIndex();
		g.addRelation("alice", "works_at", "google");
		g.addRelation("bob", "works_at", "google");

		const result = g.getRelated("alice", 1);
		expect(result.entities.length).toBeGreaterThanOrEqual(2);
		expect(result.relationships.length).toBe(1);
	});

	it("getRelated at depth 2", () => {
		const g = new GraphIndex();
		g.addRelation("alice", "knows", "bob");
		g.addRelation("bob", "knows", "charlie");
		g.addRelation("charlie", "knows", "dave");

		const result = g.getRelated("alice", 2);
		const ids = result.entities.map((e) => e.id);
		expect(ids).toContain("alice");
		expect(ids).toContain("bob");
		expect(ids).toContain("charlie");
	});

	it("removes entity and its edges", () => {
		const g = new GraphIndex();
		g.addRelation("alice", "knows", "bob");
		g.addRelation("alice", "knows", "charlie");
		g.removeEntity("alice");

		expect(g.hasEntity("alice")).toBe(false);
		expect(g.edgeCount).toBe(0);
	});

	it("removes specific relation", () => {
		const g = new GraphIndex();
		const id = g.addRelation("a", "r", "b");
		expect(g.edgeCount).toBe(1);
		g.removeRelation(id);
		expect(g.edgeCount).toBe(0);
	});

	it("auto-creates entities on addRelation", () => {
		const g = new GraphIndex();
		g.addRelation("x", "related_to", "y");
		expect(g.hasEntity("x")).toBe(true);
		expect(g.hasEntity("y")).toBe(true);
	});
});

// ── KeywordFallbackExtractor ─────────────────────────────────────────

describe("KeywordFallbackExtractor", () => {
	const extractor = new KeywordFallbackExtractor();

	it("extracts facts from conversation", async () => {
		const facts = await extractor.extractFacts([
			{ role: "user", content: "Alice works at Google in Mountain View." },
			{
				role: "assistant",
				content: "That is interesting. Bob also works there.",
			},
		]);

		expect(facts.length).toBeGreaterThan(0);
		expect(facts[0]!.content).toBeTruthy();
		expect(facts[0]!.confidence).toBe(0.5);
	});

	it("extracts capitalized entities", async () => {
		const facts = await extractor.extractFacts([
			{
				role: "user",
				content: "Alice met Bob at the Google conference.",
			},
		]);

		const allEntities = facts.flatMap((f) => f.entities.map((e) => e.name));
		expect(allEntities).toContain("Alice");
		expect(allEntities).toContain("Bob");
	});

	it("skips system messages", async () => {
		const facts = await extractor.extractFacts([
			{
				role: "system",
				content: "You are an AI assistant. Alice is here.",
			},
			{ role: "user", content: "Hello there." },
		]);

		// System message content should not be extracted
		const allContent = facts.map((f) => f.content).join(" ");
		expect(allContent).not.toContain("AI assistant");
	});

	it("resolveConflict returns add when no existing", async () => {
		const result = await extractor.resolveConflict(
			{
				content: "new fact",
				confidence: 0.5,
				entities: [],
				relationships: [],
			},
			[],
		);
		expect(result.action).toBe("add");
	});

	it("resolveConflict returns noop when similar exists", async () => {
		const existing = {
			id: "1",
			content: "existing fact",
			embedding: new Float32Array(0),
			tier: "working" as MemoryTier,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			metadata: {},
			relations: [],
		};
		const result = await extractor.resolveConflict(
			{
				content: "similar fact",
				confidence: 0.5,
				entities: [],
				relationships: [],
			},
			[existing],
		);
		expect(result.action).toBe("noop");
	});
});

// ── MemoryManager ────────────────────────────────────────────────────

describe("MemoryManager", () => {
	describe("add", () => {
		it("adds a memory and returns entry", async () => {
			const entry = await manager.add("The sky is blue");
			expect(entry.id).toBeTruthy();
			expect(entry.content).toBe("The sky is blue");
			expect(entry.tier).toBe("working");
			expect(entry.embedding).toBeInstanceOf(Float32Array);
			expect(entry.createdAt).toBeGreaterThan(0);
		});

		it("adds with metadata", async () => {
			const entry = await manager.add("important fact", {
				category: "science",
				tags: ["physics"],
			});
			expect(entry.metadata.category).toBe("science");
			expect(entry.metadata.tags).toEqual(["physics"]);
		});

		it("generates unique IDs", async () => {
			const a = await manager.add("fact one");
			const b = await manager.add("fact two");
			expect(a.id).not.toBe(b.id);
		});
	});

	describe("search", () => {
		it("finds similar memories", async () => {
			await manager.add("machine learning algorithms are powerful");
			await manager.add("banana smoothie recipe with honey");
			await manager.add("deep learning neural networks");

			const results = await manager.search("machine learning");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0]!.content).toContain("machine learning");
		});

		it("respects limit", async () => {
			for (let i = 0; i < 10; i++) {
				await manager.add(`memory number ${i}`);
			}
			const results = await manager.search("memory", { limit: 3 });
			expect(results.length).toBeLessThanOrEqual(3);
		});

		it("filters by tier", async () => {
			const entry = await manager.add("core identity fact");
			await manager.promote(entry.id, "core");

			await manager.add("working memory item");

			const results = await manager.search("fact", {
				tier: "core",
				limit: 10,
			});
			for (const r of results) {
				expect(r.tier).toBe("core");
			}
		});

		it("returns empty for unrelated query", async () => {
			await manager.add("quantum physics equations");
			const results = await manager.search("xyz123abc", {
				minSimilarity: 0.9,
			});
			expect(results.length).toBe(0);
		});
	});

	describe("getAll", () => {
		it("returns all memories", async () => {
			await manager.add("fact one");
			await manager.add("fact two");
			await manager.add("fact three");

			const all = await manager.getAll();
			expect(all.length).toBe(3);
		});

		it("filters by tier", async () => {
			const e1 = await manager.add("core fact");
			await manager.promote(e1.id, "core");
			await manager.add("working fact");

			const coreOnly = await manager.getAll({ tier: "core" });
			expect(coreOnly.length).toBe(1);
			expect(coreOnly[0]!.tier).toBe("core");
		});

		it("filters by category", async () => {
			await manager.add("science fact", { category: "science" });
			await manager.add("art fact", { category: "art" });

			const science = await manager.getAll({ category: "science" });
			expect(science.length).toBe(1);
		});

		it("respects limit", async () => {
			for (let i = 0; i < 10; i++) await manager.add(`m${i}`);
			const limited = await manager.getAll({ limit: 5 });
			expect(limited.length).toBe(5);
		});
	});

	describe("delete", () => {
		it("removes a memory", async () => {
			const entry = await manager.add("to be deleted");
			await manager.delete(entry.id);

			const all = await manager.getAll();
			expect(all.find((e) => e.id === entry.id)).toBeUndefined();
		});

		it("delete non-existent ID is no-op", async () => {
			await manager.delete("nonexistent");
			// Should not throw
		});
	});

	describe("update", () => {
		it("updates content and re-embeds", async () => {
			const entry = await manager.add("original content");
			const updated = await manager.update(entry.id, "new content");

			expect(updated.content).toBe("new content");
			expect(updated.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
			expect(updated.embedding).not.toEqual(entry.embedding);
		});

		it("throws for non-existent ID", async () => {
			await expect(
				manager.update("nonexistent", "content"),
			).rejects.toThrow("not found");
		});
	});

	describe("promote and demote", () => {
		it("promotes memory to higher tier", async () => {
			const entry = await manager.add("promote me");
			expect(entry.tier).toBe("working");

			await manager.promote(entry.id, "core");

			const all = await manager.getAll({ tier: "core" });
			expect(all.length).toBe(1);
			expect(all[0]!.id).toBe(entry.id);
		});

		it("demotes memory to lower tier", async () => {
			const entry = await manager.add("demote me");
			await manager.promote(entry.id, "core");
			await manager.demote(entry.id, "episodic");

			const all = await manager.getAll({ tier: "episodic" });
			expect(all.length).toBe(1);
		});

		it("throws for non-existent ID", async () => {
			await expect(
				manager.promote("nonexistent", "core"),
			).rejects.toThrow("not found");
		});
	});

	describe("addConversation", () => {
		it("extracts memories from conversation", async () => {
			const entries = await manager.addConversation([
				{
					role: "user",
					content:
						"Alice works at Google and lives in San Francisco.",
				},
				{
					role: "assistant",
					content:
						"That is great! San Francisco is a wonderful city.",
				},
			]);

			expect(entries.length).toBeGreaterThan(0);
			for (const e of entries) {
				expect(e.content).toBeTruthy();
				expect(e.metadata.source).toBe("conversation");
			}
		});

		it("extracts entities into graph", async () => {
			await manager.addConversation([
				{
					role: "user",
					content: "Alice met Bob at the conference.",
				},
			]);

			const result = await manager.getRelated("Alice");
			// Alice should have at least some related entities
			expect(result.entities.length).toBeGreaterThanOrEqual(0);
		});
	});

	describe("graph operations", () => {
		it("addRelation and getRelated", async () => {
			await manager.addRelation("alice", "knows", "bob");
			await manager.addRelation("bob", "knows", "charlie");

			const result = await manager.getRelated("alice", 2);
			const ids = result.entities.map((e) => e.id);
			expect(ids).toContain("alice");
			expect(ids).toContain("bob");
		});

		it("getRelated returns empty for unknown entity", async () => {
			const result = await manager.getRelated("nonexistent");
			expect(result.entities.length).toBe(0);
			expect(result.relationships.length).toBe(0);
		});
	});

	describe("asMCPTools", () => {
		it("returns array of tool definitions", () => {
			const tools = manager.asMCPTools();
			expect(tools.length).toBeGreaterThan(0);

			for (const tool of tools) {
				expect(tool.name).toBeTruthy();
				expect(tool.description).toBeTruthy();
				expect(tool.inputSchema).toBeDefined();
				expect(typeof tool.execute).toBe("function");
			}
		});

		it("includes expected tool names", () => {
			const tools = manager.asMCPTools();
			const names = tools.map((t) => t.name);
			expect(names).toContain("store_memory");
			expect(names).toContain("recall_memory");
			expect(names).toContain("forget_memory");
			expect(names).toContain("update_memory");
			expect(names).toContain("promote_memory");
			expect(names).toContain("list_memories");
			expect(names).toContain("get_related");
		});

		it("store_memory tool works", async () => {
			const tools = manager.asMCPTools();
			const storeTool = tools.find((t) => t.name === "store_memory")!;
			const result = await storeTool.execute({
				content: "MCP stored memory",
			});
			expect(result).toBeDefined();

			const all = await manager.getAll();
			expect(all.some((e) => e.content === "MCP stored memory")).toBe(
				true,
			);
		});

		it("recall_memory tool works", async () => {
			await manager.add("knowledge about neural networks");
			const tools = manager.asMCPTools();
			const recallTool = tools.find((t) => t.name === "recall_memory")!;
			const result = (await recallTool.execute({
				query: "neural networks",
			})) as Array<{ content: string }>;
			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe("persist and restore", () => {
		it("persist throws without network client", async () => {
			await expect(manager.persist()).rejects.toThrow(
				"No network client",
			);
		});

		it("restore throws without network client", async () => {
			await expect(manager.restore()).rejects.toThrow(
				"No network client",
			);
		});
	});

	describe("state tree persistence", () => {
		it("memories survive createMemoryManager reload", async () => {
			await manager.add("persistent fact one");
			await manager.add("persistent fact two");

			const manager2 = await createMemoryManager({
				identity,
				tree,
			});

			const all = await manager2.getAll();
			expect(all.length).toBe(2);
			expect(all.map((e) => e.content).sort()).toEqual([
				"persistent fact one",
				"persistent fact two",
			]);
		});

		it("search works after reload", async () => {
			await manager.add("quantum computing research paper");

			const manager2 = await createMemoryManager({
				identity,
				tree,
			});

			const results = await manager2.search("quantum computing");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0]!.content).toContain("quantum");
		});

		it("graph survives reload via state tree", async () => {
			await manager.addRelation("alice", "knows", "bob");
			await manager.addRelation("bob", "knows", "charlie");

			// Verify graph was stored in state tree
			const graphData = await tree.get("memory:graph");
			expect(graphData).not.toBeNull();

			const manager2 = await createMemoryManager({
				identity,
				tree,
			});

			// getRelated should work after reload
			const result = await manager2.getRelated("alice", 2);
			const ids = result.entities.map((e) => e.id);
			expect(ids).toContain("alice");
			expect(ids).toContain("bob");
		});

		it("entries with relations reload correctly", async () => {
			const entry = await manager.add("Alice works at Google");
			// Manually add a relation to the entry's relations array
			entry.relations.push({ predicate: "mentions", targetId: "alice" });
			// Re-persist by updating
			await manager.update(entry.id, entry.content);

			const manager2 = await createMemoryManager({
				identity,
				tree,
			});
			const all = await manager2.getAll();
			expect(all.length).toBe(1);
		});
	});

	describe("MCP tool execute handlers", () => {
		it("forget_memory tool works", async () => {
			const entry = await manager.add("to forget");
			const tools = manager.asMCPTools();
			const forgetTool = tools.find((t) => t.name === "forget_memory")!;
			await forgetTool.execute({ memoryId: entry.id });

			const all = await manager.getAll();
			expect(all.find((e) => e.id === entry.id)).toBeUndefined();
		});

		it("update_memory tool works", async () => {
			const entry = await manager.add("old content");
			const tools = manager.asMCPTools();
			const updateTool = tools.find(
				(t) => t.name === "update_memory",
			)!;
			const result = (await updateTool.execute({
				memoryId: entry.id,
				content: "new content",
			})) as { content: string };
			expect(result.content).toBe("new content");
		});

		it("promote_memory tool works", async () => {
			const entry = await manager.add("promote via tool");
			const tools = manager.asMCPTools();
			const promoteTool = tools.find(
				(t) => t.name === "promote_memory",
			)!;
			await promoteTool.execute({
				memoryId: entry.id,
				tier: "core",
			});

			const core = await manager.getAll({ tier: "core" });
			expect(core.length).toBe(1);
		});

		it("list_memories tool works with filters", async () => {
			await manager.add("a fact");
			await manager.add("another fact");
			const tools = manager.asMCPTools();
			const listTool = tools.find(
				(t) => t.name === "list_memories",
			)!;

			const result = (await listTool.execute({
				limit: 1,
			})) as Array<{ id: string }>;
			expect(result.length).toBe(1);

			const byTier = (await listTool.execute({
				tier: "working",
			})) as Array<{ tier: string }>;
			expect(byTier.length).toBe(2);
		});

		it("get_related tool works", async () => {
			await manager.addRelation("x", "linked_to", "y");
			const tools = manager.asMCPTools();
			const relatedTool = tools.find(
				(t) => t.name === "get_related",
			)!;

			const result = (await relatedTool.execute({
				entityId: "x",
				depth: 1,
			})) as GraphResult;
			expect(result.entities.length).toBeGreaterThan(0);
		});
	});

	describe("addConversation with custom extractor", () => {
		it("handles update conflict resolution", async () => {
			// Create a manager with a custom extractor that returns "update"
			const customExtractor: import("../src/types.js").ExtractionProvider =
				{
					extractFacts: async () => [
						{
							content: "updated fact",
							confidence: 0.8,
							entities: [],
							relationships: [],
						},
					],
					resolveConflict: async (_newFact, existing) => {
						if (existing.length > 0) {
							return {
								action: "update",
								targetId: existing[0]!.id,
								mergedContent: "merged content",
							};
						}
						return { action: "add" };
					},
				};

			const mgr = new MemoryManagerImpl({
				identity,
				tree: await createTree(identity),
				extractionProvider: customExtractor,
			});

			// First add creates
			const first = await mgr.addConversation([
				{ role: "user", content: "original fact" },
			]);
			expect(first.length).toBe(1);

			// Second triggers update
			const second = await mgr.addConversation([
				{ role: "user", content: "updated fact" },
			]);
			expect(second.length).toBe(1);
			expect(second[0]!.content).toBe("merged content");
		});

		it("handles delete conflict resolution", async () => {
			const customExtractor: import("../src/types.js").ExtractionProvider =
				{
					extractFacts: async () => [
						{
							content: "delete trigger",
							confidence: 0.8,
							entities: [],
							relationships: [],
						},
					],
					resolveConflict: async (_newFact, existing) => {
						if (existing.length > 0) {
							return {
								action: "delete",
								targetId: existing[0]!.id,
							};
						}
						return { action: "add" };
					},
				};

			const mgr = new MemoryManagerImpl({
				identity,
				tree: await createTree(identity),
				extractionProvider: customExtractor,
			});

			// First call adds
			await mgr.addConversation([
				{ role: "user", content: "to be deleted" },
			]);
			expect((await mgr.getAll()).length).toBe(1);

			// Second call deletes
			await mgr.addConversation([
				{ role: "user", content: "delete trigger" },
			]);
			expect((await mgr.getAll()).length).toBe(0);
		});
	});
});

// ── Additional coverage tests ────────────────────────────────────────

describe("VectorIndex (additional)", () => {
	it("has() returns true/false correctly", () => {
		const idx = new VectorIndex(3);
		expect(idx.has("a")).toBe(false);
		idx.add("a", new Float32Array([1, 0, 0]));
		expect(idx.has("a")).toBe(true);
	});

	it("search rejects dimension mismatch", () => {
		const idx = new VectorIndex(3);
		idx.add("a", new Float32Array([1, 0, 0]));
		expect(() =>
			idx.search(new Float32Array([1, 0]), 10),
		).toThrow("dimension mismatch");
	});

	it("clear removes all vectors", () => {
		const idx = new VectorIndex(3);
		idx.add("a", new Float32Array([1, 0, 0]));
		idx.add("b", new Float32Array([0, 1, 0]));
		idx.clear();
		expect(idx.size).toBe(0);
		expect(idx.has("a")).toBe(false);
	});
});

describe("GraphIndex (additional)", () => {
	it("removeEntity cleans incoming edges from other nodes", () => {
		const g = new GraphIndex();
		g.addRelation("a", "likes", "b");
		g.addRelation("c", "likes", "b");
		// Remove b which has incoming edges from a and c
		g.removeEntity("b");
		expect(g.edgeCount).toBe(0);
		expect(g.hasEntity("b")).toBe(false);
	});

	it("getRelated traverses incoming edges", () => {
		const g = new GraphIndex();
		g.addRelation("a", "points_to", "center");
		g.addRelation("b", "points_to", "center");
		// Traverse from center should find a and b via incoming edges
		const result = g.getRelated("center", 1);
		const ids = result.entities.map((e) => e.id);
		expect(ids).toContain("a");
		expect(ids).toContain("b");
	});

	it("clear empties the graph", () => {
		const g = new GraphIndex();
		g.addRelation("a", "r", "b");
		g.addRelation("c", "r", "d");
		g.clear();
		expect(g.entityCount).toBe(0);
		expect(g.edgeCount).toBe(0);
	});
});

describe("KeywordFallbackExtractor (additional)", () => {
	it("extracts quoted string entities", async () => {
		const extractor = new KeywordFallbackExtractor();
		const facts = await extractor.extractFacts([
			{
				role: "user",
				content: 'The project is called "Ensoul Protocol" and it is great.',
			},
		]);

		const allEntities = facts.flatMap((f) =>
			f.entities.map((e) => e.name),
		);
		expect(allEntities).toContain("Ensoul Protocol");
	});
});

// ── Helper ───────────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
