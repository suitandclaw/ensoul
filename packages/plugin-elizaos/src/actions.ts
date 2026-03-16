import type { MemoryManager } from "@ensoul/memory";
import type { NetworkClient } from "@ensoul/network-client";
import type { ElizaAction, ElizaRuntime, ElizaMessage } from "./elizaos-types.js";

/**
 * Create the persistMemory action.
 * Agent explicitly persists current state to the network.
 */
export function createPersistMemoryAction(
	manager: MemoryManager,
): ElizaAction {
	return {
		name: "persistMemory",
		description:
			"Persist the agent's current consciousness state to the decentralized network for indestructible storage.",
		examples: [
			"Save my memories to the network",
			"Persist my consciousness",
			"Back up my state",
		],
		async handler(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
			_state: Record<string, unknown>,
		): Promise<string> {
			try {
				const result = await manager.persist();
				return `Consciousness persisted to network. State root: ${result.stateRoot}, version: ${result.version}`;
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Unknown error";
				return `Failed to persist: ${msg}`;
			}
		},
	};
}

/**
 * Create the recallFromNetwork action.
 * Agent explicitly pulls latest state from the network.
 */
export function createRecallFromNetworkAction(
	manager: MemoryManager,
): ElizaAction {
	return {
		name: "recallFromNetwork",
		description:
			"Restore the agent's consciousness from the decentralized network.",
		examples: [
			"Restore my memories from the network",
			"Recall my consciousness",
			"Load my backed up state",
		],
		async handler(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
			_state: Record<string, unknown>,
		): Promise<string> {
			try {
				const result = await manager.restore();
				return `Consciousness restored from network. Version: ${result.version}, entries: ${result.entryCount}`;
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Unknown error";
				return `Failed to restore: ${msg}`;
			}
		},
	};
}

/**
 * Create the checkPersistence action.
 * Agent checks the current persistence status.
 */
export function createCheckPersistenceAction(
	manager: MemoryManager,
): ElizaAction {
	return {
		name: "checkPersistence",
		description:
			"Check the current status of the agent's consciousness persistence.",
		examples: [
			"Check my persistence status",
			"Am I backed up?",
			"What is my consciousness status?",
		],
		async handler(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
			_state: Record<string, unknown>,
		): Promise<string> {
			const all = await manager.getAll();
			const core = await manager.getAll({ tier: "core" });
			const longterm = await manager.getAll({ tier: "longterm" });
			const working = await manager.getAll({ tier: "working" });
			const episodic = await manager.getAll({ tier: "episodic" });

			return [
				`Total memories: ${all.length}`,
				`Core: ${core.length}`,
				`Long-term: ${longterm.length}`,
				`Working: ${working.length}`,
				`Episodic: ${episodic.length}`,
			].join("\n");
		},
	};
}

/**
 * Create the runNode action.
 * Agent starts running as a storage node to earn credits.
 */
export function createRunNodeAction(
	networkClient: NetworkClient,
): ElizaAction {
	return {
		name: "runNode",
		description:
			"Start running as a storage node on the Ensoul network to earn persistence credits.",
		examples: [
			"Start running a node",
			"Earn credits by storing data",
			"Become a validator",
		],
		async handler(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
			_state: Record<string, unknown>,
		): Promise<string> {
			try {
				await networkClient.startNode({
					maxStorageGB: 10,
					port: 9000,
				});
				return "Now running as a storage node. Earning credits for storing other agents' consciousness.";
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Unknown error";
				return `Failed to start node: ${msg}`;
			}
		},
	};
}
