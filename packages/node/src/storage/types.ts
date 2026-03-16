/**
 * Metadata stored alongside each shard.
 */
export interface ShardMetadata {
	/** DID of the agent that owns this shard */
	agentDid: string;
	/** State version this shard belongs to */
	version: number;
	/** Index of this shard within the erasure-coded set */
	shardIndex: number;
	/** Blake3 hash of the shard data (hex) for integrity verification */
	hash: string;
	/** Size of the shard data in bytes */
	size: number;
	/** Unix timestamp (ms) when the shard was stored */
	storedAt: number;
	/** Optional TTL: Unix timestamp (ms) after which the shard expires */
	expiresAt?: number;
}

/**
 * A shard with its data and metadata.
 */
export interface Shard {
	metadata: ShardMetadata;
	data: Uint8Array;
}

/**
 * Request to store a shard.
 */
export interface StoreShardRequest {
	agentDid: string;
	version: number;
	shardIndex: number;
	data: Uint8Array;
	/** Optional TTL in milliseconds. If set, the shard expires after this duration. */
	ttlMs?: number;
}

/**
 * Key identifying a specific shard.
 */
export interface ShardKey {
	agentDid: string;
	version: number;
	shardIndex: number;
}

/**
 * Per-agent storage usage statistics.
 */
export interface AgentStorageStats {
	/** Total bytes stored for this agent */
	totalBytes: number;
	/** Number of shards stored */
	shardCount: number;
	/** Latest version stored */
	latestVersion: number;
}

/**
 * Overall storage engine statistics.
 */
export interface StorageStats {
	/** Total bytes stored across all agents */
	totalBytes: number;
	/** Total number of shards */
	totalShards: number;
	/** Number of distinct agents */
	agentCount: number;
}

/**
 * Configuration for the storage engine.
 */
export interface StorageEngineConfig {
	/** Maximum storage in bytes. 0 = unlimited. */
	maxStorageBytes: number;
	/** Interval in ms for cleaning expired shards. 0 = no auto-clean. */
	cleanupIntervalMs: number;
}
