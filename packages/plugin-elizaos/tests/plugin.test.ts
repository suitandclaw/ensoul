import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { createTree } from "@ensoul/state-tree";
import { createMemoryManager } from "@ensoul/memory";
import type { MemoryManager } from "@ensoul/memory";
import { NetworkClientImpl } from "@ensoul/network-client";
import {
	createConsciousnessPlugin,
	ConsciousnessAdapter,
	createPersistMemoryAction,
	createRecallFromNetworkAction,
	createCheckPersistenceAction,
	createRunNodeAction,
	createConsciousnessStatusProvider,
	createNetworkStatsProvider,
	createShouldPersistEvaluator,
} from "../src/index.js";
import type {
	ElizaPlugin,
	ElizaRuntime,
	ElizaMessage,
} from "../src/index.js";

let identity: AgentIdentity;
let manager: MemoryManager;
let networkClient: NetworkClientImpl;

/** Mock ElizaOS runtime */
function mockRuntime(): ElizaRuntime {
	return {
		agentId: "test-agent",
		getSetting: () => undefined,
		getMemory: async () => null,
		createMemory: async (m) => ({ id: "mock-id", ...m }),
		searchMemories: async () => [],
		deleteMemory: async () => {},
	};
}

const mockMessage: ElizaMessage = {
	role: "user",
	content: "test message",
};

const mockState: Record<string, unknown> = {};

beforeEach(async () => {
	identity = await createIdentity({ seed: new Uint8Array(32).fill(42) });
	const tree = await createTree(identity);
	manager = await createMemoryManager({ identity, tree });
	networkClient = new NetworkClientImpl(identity);
});

// ── Plugin creation ──────────────────────────────────────────────────

describe("createConsciousnessPlugin", () => {
	it("creates a valid ElizaOS plugin with all components", async () => {
		const plugin = await createConsciousnessPlugin({
			identity,
			memoryManager: manager,
			networkClient,
		});

		expect(plugin.name).toBe("ensoul-consciousness");
		expect(plugin.description).toBeTruthy();
		expect(plugin.databaseAdapter).toBeDefined();
		expect(plugin.actions.length).toBe(4);
		expect(plugin.providers.length).toBe(2);
		expect(plugin.evaluators.length).toBe(1);
	});

	it("auto-generates identity when not provided", async () => {
		const plugin = await createConsciousnessPlugin();
		expect(plugin.name).toBe("ensoul-consciousness");
		expect(plugin.databaseAdapter).toBeDefined();
	});

	it("has expected action names", async () => {
		const plugin = await createConsciousnessPlugin({
			identity,
			memoryManager: manager,
			networkClient,
		});

		const names = plugin.actions.map((a) => a.name);
		expect(names).toContain("persistMemory");
		expect(names).toContain("recallFromNetwork");
		expect(names).toContain("checkPersistence");
		expect(names).toContain("runNode");
	});

	it("has expected provider names", async () => {
		const plugin = await createConsciousnessPlugin({
			identity,
			memoryManager: manager,
			networkClient,
		});

		const names = plugin.providers.map((p) => p.name);
		expect(names).toContain("consciousnessStatus");
		expect(names).toContain("networkStats");
	});

	it("has shouldPersist evaluator", async () => {
		const plugin = await createConsciousnessPlugin({
			identity,
			memoryManager: manager,
			networkClient,
		});

		expect(plugin.evaluators[0]!.name).toBe("shouldPersist");
	});
});

// ── ConsciousnessAdapter ─────────────────────────────────────────────

describe("ConsciousnessAdapter", () => {
	let adapter: ConsciousnessAdapter;

	beforeEach(() => {
		adapter = new ConsciousnessAdapter(manager);
	});

	it("init and close are no-ops", async () => {
		await adapter.init();
		await adapter.close();
	});

	it("createMemory stores via MemoryManager", async () => {
		const mem = await adapter.createMemory({
			content: "adapter test memory",
			metadata: { category: "test" },
			createdAt: Date.now(),
		});

		expect(mem.id).toBeTruthy();
		expect(mem.content).toBe("adapter test memory");
	});

	it("getMemory retrieves by ID", async () => {
		const mem = await adapter.createMemory({
			content: "findable memory",
			metadata: {},
			createdAt: Date.now(),
		});

		const found = await adapter.getMemory(mem.id);
		expect(found).not.toBeNull();
		expect(found!.content).toBe("findable memory");
	});

	it("getMemory returns null for unknown ID", async () => {
		const found = await adapter.getMemory("nonexistent");
		expect(found).toBeNull();
	});

	it("searchMemories returns matching results", async () => {
		await adapter.createMemory({
			content: "quantum physics research",
			metadata: {},
			createdAt: Date.now(),
		});
		await adapter.createMemory({
			content: "banana smoothie recipe",
			metadata: {},
			createdAt: Date.now(),
		});

		const results = await adapter.searchMemories("quantum physics");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.content).toContain("quantum");
	});

	it("searchMemories respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await adapter.createMemory({
				content: `memory number ${i}`,
				metadata: {},
				createdAt: Date.now(),
			});
		}

		const results = await adapter.searchMemories("memory", 2);
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it("deleteMemory removes a memory", async () => {
		const mem = await adapter.createMemory({
			content: "to delete",
			metadata: {},
			createdAt: Date.now(),
		});

		await adapter.deleteMemory(mem.id);

		const found = await adapter.getMemory(mem.id);
		expect(found).toBeNull();
	});

	it("getAllMemories returns all stored memories", async () => {
		await adapter.createMemory({
			content: "mem 1",
			metadata: {},
			createdAt: Date.now(),
		});
		await adapter.createMemory({
			content: "mem 2",
			metadata: {},
			createdAt: Date.now(),
		});

		const all = await adapter.getAllMemories();
		expect(all.length).toBe(2);
	});
});

// ── Actions ──────────────────────────────────────────────────────────

describe("actions", () => {
	it("checkPersistence returns memory counts", async () => {
		await manager.add("core fact");
		await manager.add("working fact");

		const action = createCheckPersistenceAction(manager);
		const result = await action.handler(
			mockRuntime(),
			mockMessage,
			mockState,
		);

		expect(result).toContain("Total memories: 2");
		expect(result).toContain("Working:");
	});

	it("persistMemory reports failure without network", async () => {
		const action = createPersistMemoryAction(manager);
		const result = await action.handler(
			mockRuntime(),
			mockMessage,
			mockState,
		);

		expect(result).toContain("Failed to persist");
	});

	it("recallFromNetwork reports failure without network", async () => {
		const action = createRecallFromNetworkAction(manager);
		const result = await action.handler(
			mockRuntime(),
			mockMessage,
			mockState,
		);

		expect(result).toContain("Failed to restore");
	});

	it("runNode starts node mode", async () => {
		const action = createRunNodeAction(networkClient);
		const result = await action.handler(
			mockRuntime(),
			mockMessage,
			mockState,
		);

		expect(result).toContain("running as a storage node");
	});

	it("actions have examples", async () => {
		const plugin = await createConsciousnessPlugin({
			identity,
			memoryManager: manager,
			networkClient,
		});

		for (const action of plugin.actions) {
			expect(action.examples.length).toBeGreaterThan(0);
		}
	});
});

// ── Providers ────────────────────────────────────────────────────────

describe("providers", () => {
	it("consciousnessStatus reports memory counts", async () => {
		await manager.add("a fact");
		const provider = createConsciousnessStatusProvider(manager);
		const result = await provider.get(mockRuntime(), mockMessage);

		expect(result).toContain("[Consciousness Status]");
		expect(result).toContain("Total memories: 1");
	});

	it("consciousnessStatus warns when empty", async () => {
		const provider = createConsciousnessStatusProvider(manager);
		const result = await provider.get(mockRuntime(), mockMessage);

		expect(result).toContain("No memories stored");
	});

	it("networkStats reports connection status", async () => {
		const provider = createNetworkStatsProvider(networkClient);
		const result = await provider.get(mockRuntime(), mockMessage);

		expect(result).toContain("[Network Status]");
		expect(result).toContain("Connected:");
		expect(result).toContain("Credit balance:");
	});
});

// ── Evaluators ───────────────────────────────────────────────────────

describe("evaluators", () => {
	it("shouldPersist returns false initially", async () => {
		const evaluator = createShouldPersistEvaluator(manager);
		const result = await evaluator.evaluate(
			mockRuntime(),
			mockMessage,
			mockState,
		);
		expect(result).toBe(false);
	});

	it("shouldPersist returns true after threshold memories", async () => {
		const evaluator = createShouldPersistEvaluator(manager);

		// Add 5 memories (threshold)
		for (let i = 0; i < 5; i++) {
			await manager.add(`memory ${i}`);
		}

		const result = await evaluator.evaluate(
			mockRuntime(),
			mockMessage,
			mockState,
		);
		expect(result).toBe(true);
	});

	it("shouldPersist resets after triggering", async () => {
		const evaluator = createShouldPersistEvaluator(manager);

		for (let i = 0; i < 5; i++) {
			await manager.add(`memory ${i}`);
		}

		// First check triggers
		const first = await evaluator.evaluate(
			mockRuntime(),
			mockMessage,
			mockState,
		);
		expect(first).toBe(true);

		// Second check: not enough new memories yet
		const second = await evaluator.evaluate(
			mockRuntime(),
			mockMessage,
			mockState,
		);
		expect(second).toBe(false);
	});
});

// ── Full workflow ────────────────────────────────────────────────────

describe("full ElizaOS workflow", () => {
	it("plugin lifecycle: create, store, search, check", async () => {
		const plugin = await createConsciousnessPlugin({
			identity,
			memoryManager: manager,
			networkClient,
		});

		// Store via adapter
		const mem = await plugin.databaseAdapter.createMemory({
			content: "Agent learned about Bitcoin trading strategies",
			metadata: {},
			createdAt: Date.now(),
		});
		expect(mem.id).toBeTruthy();

		// Search via adapter
		const results = await plugin.databaseAdapter.searchMemories(
			"Bitcoin trading",
		);
		expect(results.length).toBeGreaterThan(0);

		// Check persistence status
		const checkAction = plugin.actions.find(
			(a) => a.name === "checkPersistence",
		)!;
		const status = await checkAction.handler(
			mockRuntime(),
			mockMessage,
			mockState,
		);
		expect(status).toContain("Total memories: 1");

		// Get consciousness status
		const statusProvider = plugin.providers.find(
			(p) => p.name === "consciousnessStatus",
		)!;
		const ctx = await statusProvider.get(
			mockRuntime(),
			mockMessage,
		);
		expect(ctx).toContain("Total memories: 1");

		// Evaluate persistence
		const evaluator = plugin.evaluators[0]!;
		const shouldPersist = await evaluator.evaluate(
			mockRuntime(),
			mockMessage,
			mockState,
		);
		expect(shouldPersist).toBe(false); // only 1 memory, below threshold
	});
});
