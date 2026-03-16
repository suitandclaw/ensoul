import type { MemoryManager } from "@ensoul/memory";
import type { NetworkClient } from "@ensoul/network-client";
import type { ElizaProvider, ElizaRuntime, ElizaMessage } from "./elizaos-types.js";

/**
 * Provider that injects consciousness persistence status into the agent's context.
 */
export function createConsciousnessStatusProvider(
	manager: MemoryManager,
): ElizaProvider {
	return {
		name: "consciousnessStatus",
		description:
			"Provides the agent with its current consciousness persistence status.",
		async get(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
		): Promise<string> {
			const all = await manager.getAll();
			const core = await manager.getAll({ tier: "core" });
			const longterm = await manager.getAll({ tier: "longterm" });

			return [
				"[Consciousness Status]",
				`Total memories: ${all.length}`,
				`Core identity memories: ${core.length}`,
				`Long-term knowledge: ${longterm.length}`,
				all.length === 0
					? "Warning: No memories stored yet. Consider persisting important information."
					: `Latest memory: "${all[all.length - 1]!.content.slice(0, 50)}..."`,
			].join("\n");
		},
	};
}

/**
 * Provider that injects network health stats into the agent's context.
 */
export function createNetworkStatsProvider(
	networkClient: NetworkClient,
): ElizaProvider {
	return {
		name: "networkStats",
		description:
			"Provides the agent with current Ensoul network health statistics.",
		async get(
			_runtime: ElizaRuntime,
			_message: ElizaMessage,
		): Promise<string> {
			const connected = networkClient.isConnected();
			const peerCount = networkClient.getPeerCount();
			const balance = await networkClient.getBalance();

			return [
				"[Network Status]",
				`Connected: ${connected ? "yes" : "no"}`,
				`Peers: ${peerCount}`,
				`Credit balance: ${balance}`,
				balance < 10
					? "Warning: Low credit balance. Consider running a node to earn credits."
					: "",
			]
				.filter(Boolean)
				.join("\n");
		},
	};
}
