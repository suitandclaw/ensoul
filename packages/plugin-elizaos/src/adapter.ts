import type { MemoryManager, MemoryEntry } from "@ensoul/memory";
import type { ElizaDatabaseAdapter, ElizaMemory } from "./elizaos-types.js";

/**
 * Convert an Ensoul MemoryEntry to an ElizaOS memory record.
 */
function toElizaMemory(entry: MemoryEntry): ElizaMemory {
	return {
		id: entry.id,
		content: entry.content,
		metadata: {
			tier: entry.tier,
			...entry.metadata,
		},
		createdAt: entry.createdAt,
	};
}

/**
 * ElizaOS database adapter backed by @ensoul/memory.
 * Transparently routes all memory operations through the Ensoul memory manager.
 */
export class ConsciousnessAdapter implements ElizaDatabaseAdapter {
	private manager: MemoryManager;

	constructor(manager: MemoryManager) {
		this.manager = manager;
	}

	async init(): Promise<void> {
		// MemoryManager is already initialized at construction
	}

	async close(): Promise<void> {
		// No cleanup needed; lifecycle managed externally
	}

	async getMemory(id: string): Promise<ElizaMemory | null> {
		const all = await this.manager.getAll();
		const found = all.find((e) => e.id === id);
		return found ? toElizaMemory(found) : null;
	}

	async createMemory(
		memory: Omit<ElizaMemory, "id">,
	): Promise<ElizaMemory> {
		const entry = await this.manager.add(memory.content, {
			category: (memory.metadata["category"] as string) ?? undefined,
			source: "elizaos",
		});
		return toElizaMemory(entry);
	}

	async searchMemories(
		query: string,
		limit?: number,
	): Promise<ElizaMemory[]> {
		const opts = limit !== undefined ? { limit } : {};
		const results = await this.manager.search(query, opts);
		return results.map(toElizaMemory);
	}

	async deleteMemory(id: string): Promise<void> {
		await this.manager.delete(id);
	}

	async getAllMemories(): Promise<ElizaMemory[]> {
		const all = await this.manager.getAll();
		return all.map(toElizaMemory);
	}
}
