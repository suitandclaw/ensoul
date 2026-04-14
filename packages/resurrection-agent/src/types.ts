/**
 * Types for the Resurrection Agent.
 */

export type Phase =
	| "learn"     // Mon-Fri mornings: accumulate knowledge + daily post
	| "announce"  // Fri 3:00-3:59pm EST: countdown threads
	| "kill"      // Fri 4:00pm EST: exit the process, trigger wipe
	| "resurrect" // Fri 4:05pm EST (on new machine): recover + prove
	| "silent";   // Fri 4:00-4:05pm EST: process is dead, X account silent

export interface LearnedTopic {
	/** ISO date of day when learned. */
	day: string;
	/** Short title of the topic. */
	title: string;
	/** One-paragraph summary. */
	summary: string;
	/** Source URLs referenced. */
	sources: string[];
	/** Unix ms when learned. */
	timestamp: number;
}

export interface ConsciousnessPayload {
	/** Schema version for future migrations. */
	schemaVersion: 1;
	/** Monotonically increasing cycle count (resurrections completed). */
	resurrectionCount: number;
	/** ISO date of start of current cycle (a Monday). */
	cycleStart: string;
	/** Everything learned this cycle. */
	topics: LearnedTopic[];
	/** Running tweet-post ledger this cycle. */
	posts: Array<{ id: string; text: string; timestamp: number }>;
	/** Birthday: when the agent first came alive (never changes). */
	bornAt: string;
	/** Last sync timestamp (unix ms). */
	lastSyncAt: number;
	/** Optional: which machine the agent was running on when last synced. */
	host?: string;
}

export interface AgentConfig {
	openrouterKey: string;
	llmModel: string;
	twitter?: {
		apiKey: string;
		apiSecret: string;
		accessToken: string;
		accessSecret: string;
	};
	dryRun: boolean;
	dataDir: string;
	vaultDir: string;
	explorerBase: string;
}
