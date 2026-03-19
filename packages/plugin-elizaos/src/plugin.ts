import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { createMemoryManager } from "@ensoul/memory";
import type { MemoryManager } from "@ensoul/memory";
import { NetworkClientImpl } from "@ensoul/network-client";
import type { NetworkClient } from "@ensoul/network-client";
import { createTree } from "@ensoul/state-tree";
import type { ElizaPlugin } from "./elizaos-types.js";
import { ConsciousnessAdapter } from "./adapter.js";
import {
	createPersistMemoryAction,
	createRecallFromNetworkAction,
	createCheckPersistenceAction,
	createRunNodeAction,
} from "./actions.js";
import {
	createConsciousnessStatusProvider,
	createNetworkStatsProvider,
} from "./providers.js";
import { createShouldPersistEvaluator } from "./evaluators.js";

/** Default Ensoul API gateway URL. */
export const DEFAULT_API_URL = "https://api.ensoul.dev";

function pluginLog(msg: string): void {
	// Use globalThis to access console without @types/node
	(globalThis as unknown as { console: { error: (m: string) => void } }).console.error(`[ensoul] ${msg}`);
}

/**
 * Configuration for the Ensoul consciousness plugin.
 */
export interface EnsoulPluginConfig {
	/** Ensoul API gateway URL (default: https://api.ensoul.dev). */
	apiUrl?: string;
	/** Bootstrap peer multiaddr(s) to connect to. */
	bootstrapPeers?: string[];
	/** Optional pre-created identity (otherwise auto-generated). */
	identity?: AgentIdentity;
	/** Optional pre-created memory manager. */
	memoryManager?: MemoryManager;
	/** Optional pre-created network client. */
	networkClient?: NetworkClient;
}

/**
 * Create the Ensoul consciousness plugin for ElizaOS.
 * Minimal setup: just provide bootstrap peers.
 * Identity, storage, and node participation are automatic.
 */
export async function createConsciousnessPlugin(
	config?: EnsoulPluginConfig,
): Promise<ElizaPlugin> {
	const apiUrl = config?.apiUrl ?? DEFAULT_API_URL;

	// Auto-generate identity if not provided
	const identity = config?.identity ?? (await createIdentity());

	// Create state tree
	const tree = await createTree(identity);

	// Create network client
	const networkClient =
		config?.networkClient ??
		new NetworkClientImpl(identity);

	// Connect to network if bootstrap peers provided
	const peers = config?.bootstrapPeers ?? [];
	if (peers.length > 0) {
		await networkClient.connect(peers);
	}

	// Register agent with the Ensoul API gateway
	try {
		const resp = await fetch(`${apiUrl}/v1/agents/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				did: identity.did,
				publicKey: Array.from(identity.publicKey)
					.map((b) => b.toString(16).padStart(2, "0"))
					.join(""),
			}),
			signal: AbortSignal.timeout(10000),
		});
		if (resp.ok) {
			pluginLog(`Connected to Ensoul network via ${apiUrl}`);
			pluginLog(`Agent registered: ${identity.did}`);
		}
	} catch {
		pluginLog(`Warning: could not reach ${apiUrl}. Running in offline mode.`);
	}

	// Create memory manager
	const manager =
		config?.memoryManager ??
		(await createMemoryManager({
			identity,
			tree,
			networkClient,
		}));

	// Build the plugin
	const adapter = new ConsciousnessAdapter(manager);

	return {
		name: "ensoul-consciousness",
		description:
			"Decentralized, indestructible memory persistence for autonomous agents. Powered by the Ensoul network.",

		databaseAdapter: adapter,

		actions: [
			createPersistMemoryAction(manager),
			createRecallFromNetworkAction(manager),
			createCheckPersistenceAction(manager),
			createRunNodeAction(networkClient),
		],

		providers: [
			createConsciousnessStatusProvider(manager),
			createNetworkStatsProvider(networkClient),
		],

		evaluators: [createShouldPersistEvaluator(manager)],
	};
}
