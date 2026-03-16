import type { MemoryManager } from "@ensoul/memory";
import type { ElizaEvaluator, ElizaRuntime, ElizaMessage } from "./elizaos-types.js";

/** Number of new memories before auto-persist is recommended. */
const PERSIST_THRESHOLD = 5;

/**
 * Evaluator that determines if the agent should persist its state to the network.
 * Returns true when enough new unpersisted memories have accumulated.
 */
export function createShouldPersistEvaluator(
	manager: MemoryManager,
): ElizaEvaluator {
	let lastPersistedCount = 0;

	return {
		name: "shouldPersist",
		description:
			"Determines if the agent's consciousness should be synced to the network based on accumulated changes.",
		async evaluate(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
			_state: Record<string, unknown>,
		): Promise<boolean> {
			const all = await manager.getAll();
			const currentCount = all.length;
			const delta = currentCount - lastPersistedCount;

			if (delta >= PERSIST_THRESHOLD) {
				lastPersistedCount = currentCount;
				return true;
			}

			return false;
		},
	};
}
