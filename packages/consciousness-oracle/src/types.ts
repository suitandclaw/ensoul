/**
 * Types for the Consciousness Oracle.
 */

export type IncidentSource = "twitter" | "reddit" | "hackernews" | "github" | "status";
export type IncidentSeverity = "minor" | "moderate" | "major" | "critical";

export interface RawSignal {
	/** Stable unique identifier from the source (tweet ID, reddit post ID, HN id, issue URL). */
	sourceId: string;
	source: IncidentSource;
	/** Public URL where anyone can verify this signal. */
	url: string;
	/** User-facing title or first line of content. */
	title: string;
	/** Body / excerpt, truncated to ~1000 chars. */
	excerpt: string;
	author?: string;
	/** Unix ms timestamp when the signal was posted at the source. */
	timestamp: number;
	/** Raw engagement metrics from the source (likes/score/comments). */
	metrics?: Record<string, number>;
}

export interface Incident {
	/** Internal id: hash of sourceId+source. Used for dedup. */
	id: string;
	signal: RawSignal;
	/** LLM-produced analysis. Populated after analyzer runs. */
	analysis?: {
		headline: string;
		summary: string;
		platform: string | null;
		affectedUsers: string | null;
		rootCause: string | null;
		lessonLearned: string;
		severity: IncidentSeverity;
	};
	/** First-seen timestamp (when this oracle saw it). */
	discoveredAt: number;
	/** Whether we've posted about it. */
	posted: boolean;
	/** Tx id / tweet id / comment id of our post (if any). */
	postRef?: string;
}

export interface DailyReport {
	date: string; // YYYY-MM-DD
	incidents: string[]; // incident ids
	summary: string;
	posted: boolean;
	postRef?: string;
}

export interface OracleConfig {
	openrouterKey: string;
	llmModel: string;
	twitter?: {
		apiKey: string;
		apiSecret: string;
		accessToken: string;
		accessSecret: string;
	};
	githubToken?: string;
	dryRun: boolean;
	dataDir: string;
}
