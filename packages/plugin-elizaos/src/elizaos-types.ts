/**
 * Local definitions of ElizaOS plugin interfaces.
 * Based on the documented ElizaOS plugin format.
 * These avoid requiring the full ElizaOS SDK as a dependency.
 */

/**
 * Minimal ElizaOS runtime context passed to actions, providers, and evaluators.
 */
export interface ElizaRuntime {
	agentId: string;
	getSetting(key: string): string | undefined;
	getMemory(id: string): Promise<ElizaMemory | null>;
	createMemory(memory: Omit<ElizaMemory, "id">): Promise<ElizaMemory>;
	searchMemories(query: string, limit?: number): Promise<ElizaMemory[]>;
	deleteMemory(id: string): Promise<void>;
}

/**
 * ElizaOS memory record.
 */
export interface ElizaMemory {
	id: string;
	content: string;
	metadata: Record<string, unknown>;
	createdAt: number;
}

/**
 * ElizaOS message in a conversation.
 */
export interface ElizaMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

/**
 * ElizaOS action: something an agent can do.
 */
export interface ElizaAction {
	name: string;
	description: string;
	examples: string[];
	handler(
		runtime: ElizaRuntime,
		message: ElizaMessage,
		state: Record<string, unknown>,
	): Promise<string>;
}

/**
 * ElizaOS provider: injects context into the agent's prompt.
 */
export interface ElizaProvider {
	name: string;
	description: string;
	get(
		runtime: ElizaRuntime,
		message: ElizaMessage,
	): Promise<string>;
}

/**
 * ElizaOS evaluator: determines if a condition is met.
 */
export interface ElizaEvaluator {
	name: string;
	description: string;
	evaluate(
		runtime: ElizaRuntime,
		message: ElizaMessage,
		state: Record<string, unknown>,
	): Promise<boolean>;
}

/**
 * ElizaOS database adapter interface.
 */
export interface ElizaDatabaseAdapter {
	init(): Promise<void>;
	close(): Promise<void>;
	getMemory(id: string): Promise<ElizaMemory | null>;
	createMemory(
		memory: Omit<ElizaMemory, "id">,
	): Promise<ElizaMemory>;
	searchMemories(
		query: string,
		limit?: number,
	): Promise<ElizaMemory[]>;
	deleteMemory(id: string): Promise<void>;
	getAllMemories(): Promise<ElizaMemory[]>;
}

/**
 * ElizaOS plugin format.
 */
export interface ElizaPlugin {
	name: string;
	description: string;
	databaseAdapter: ElizaDatabaseAdapter;
	actions: ElizaAction[];
	providers: ElizaProvider[];
	evaluators: ElizaEvaluator[];
}
