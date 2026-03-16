import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AbstractLevel } from "abstract-level";
import type {
	ShardMetadata,
	Shard,
	StoreShardRequest,
	ShardKey,
	AgentStorageStats,
	StorageStats,
	StorageEngineConfig,
} from "./types.js";

/** Default configuration. */
const DEFAULT_CONFIG: StorageEngineConfig = {
	maxStorageBytes: 0,
	cleanupIntervalMs: 0,
};

/**
 * Compute the Blake3 hash of shard data, returned as a hex string.
 */
export function computeShardHash(data: Uint8Array): string {
	return bytesToHex(blake3(data));
}

/**
 * Encode a shard key as a LevelDB key string.
 * Format: shard:{agentDid}:{version}:{shardIndex}
 * Version and shardIndex are zero-padded for lexicographic sorting.
 */
function encodeShardKey(key: ShardKey): string {
	const ver = String(key.version).padStart(12, "0");
	const idx = String(key.shardIndex).padStart(6, "0");
	return `shard:${key.agentDid}:${ver}:${idx}`;
}

/**
 * Encode a metadata key for LevelDB.
 */
function encodeMetaKey(key: ShardKey): string {
	const ver = String(key.version).padStart(12, "0");
	const idx = String(key.shardIndex).padStart(6, "0");
	return `meta:${key.agentDid}:${ver}:${idx}`;
}

/**
 * Storage engine for the Ensoul node.
 * Accepts encrypted shards from agents, stores them in LevelDB,
 * serves them on request, tracks per-agent storage, enforces limits,
 * and handles TTL-based shard expiration.
 */
export class StorageEngine {
	private db: AbstractLevel<string, string, string>;
	private config: StorageEngineConfig;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	/** In-memory cache of per-agent storage stats for fast lookups. */
	private agentStats: Map<string, AgentStorageStats> = new Map();
	/** Total bytes across all agents. */
	private totalBytes = 0;
	/** Total shard count. */
	private totalShards = 0;

	constructor(
		db: AbstractLevel<string, string, string>,
		config?: Partial<StorageEngineConfig>,
	) {
		this.db = db;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Initialize the storage engine: scan existing data and start cleanup timer.
	 */
	async init(): Promise<void> {
		await this.rebuildStats();

		if (this.config.cleanupIntervalMs > 0) {
			this.cleanupTimer = setInterval(
				() => void this.cleanExpired(),
				this.config.cleanupIntervalMs,
			);
		}
	}

	/**
	 * Shut down the storage engine and release resources.
	 */
	async close(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		await this.db.close();
	}

	/**
	 * Store an encrypted shard.
	 * @throws If max storage limit would be exceeded.
	 * @throws If shard data is empty.
	 */
	async store(request: StoreShardRequest): Promise<ShardMetadata> {
		if (request.data.length === 0) {
			throw new Error("Shard data must not be empty");
		}

		// Check storage limit
		if (
			this.config.maxStorageBytes > 0 &&
			this.totalBytes + request.data.length >
				this.config.maxStorageBytes
		) {
			throw new Error(
				`Storage limit exceeded: ${this.totalBytes + request.data.length} > ${this.config.maxStorageBytes} bytes`,
			);
		}

		const key: ShardKey = {
			agentDid: request.agentDid,
			version: request.version,
			shardIndex: request.shardIndex,
		};

		// Check for existing shard at this key and remove its size from stats
		const existing = await this.getMetadata(key);
		if (existing) {
			this.decrementStats(existing);
		}

		const hash = computeShardHash(request.data);
		const now = Date.now();

		const metadata: ShardMetadata = {
			agentDid: request.agentDid,
			version: request.version,
			shardIndex: request.shardIndex,
			hash,
			size: request.data.length,
			storedAt: now,
		};

		if (request.ttlMs !== undefined) {
			metadata.expiresAt = now + request.ttlMs;
		}

		// Store data and metadata
		await this.db.put(encodeShardKey(key), bytesToHex(request.data));
		await this.db.put(encodeMetaKey(key), JSON.stringify(metadata));

		// Update stats
		this.incrementStats(metadata);

		return metadata;
	}

	/**
	 * Retrieve a shard by key.
	 * @throws If the shard is not found.
	 * @throws If the shard has expired.
	 * @throws If the shard data fails integrity verification.
	 */
	async retrieve(key: ShardKey): Promise<Shard> {
		const metadata = await this.getMetadata(key);
		if (!metadata) {
			throw new Error(
				`Shard not found: ${key.agentDid}/${key.version}/${key.shardIndex}`,
			);
		}

		// Check expiration
		if (metadata.expiresAt !== undefined && Date.now() >= metadata.expiresAt) {
			await this.deleteShard(key, metadata);
			throw new Error(
				`Shard expired: ${key.agentDid}/${key.version}/${key.shardIndex}`,
			);
		}

		const dataHex = await this.db.get(encodeShardKey(key));
		if (dataHex === undefined) {
			throw new Error(
				`Shard data missing: ${key.agentDid}/${key.version}/${key.shardIndex}`,
			);
		}

		const data = hexToBytes(dataHex);

		// Verify integrity
		const actualHash = computeShardHash(data);
		if (actualHash !== metadata.hash) {
			throw new Error(
				`Shard integrity check failed: expected ${metadata.hash}, got ${actualHash}`,
			);
		}

		return { metadata, data };
	}

	/**
	 * Check if a shard exists (and is not expired).
	 */
	async has(key: ShardKey): Promise<boolean> {
		const metadata = await this.getMetadata(key);
		if (!metadata) return false;
		if (metadata.expiresAt !== undefined && Date.now() >= metadata.expiresAt) {
			await this.deleteShard(key, metadata);
			return false;
		}
		return true;
	}

	/**
	 * Delete a specific shard.
	 */
	async delete(key: ShardKey): Promise<boolean> {
		const metadata = await this.getMetadata(key);
		if (!metadata) return false;
		await this.deleteShard(key, metadata);
		return true;
	}

	/**
	 * Get the latest version number stored for a given agent.
	 * Returns -1 if no shards exist for the agent.
	 */
	async getLatestVersion(agentDid: string): Promise<number> {
		const stats = this.agentStats.get(agentDid);
		if (!stats || stats.shardCount === 0) return -1;
		return stats.latestVersion;
	}

	/**
	 * List all shard metadata for a given agent and version.
	 */
	async listShards(
		agentDid: string,
		version: number,
	): Promise<ShardMetadata[]> {
		const prefix = `meta:${agentDid}:${String(version).padStart(12, "0")}:`;
		const results: ShardMetadata[] = [];

		for await (const [key, value] of this.db.iterator()) {
			if (key.startsWith(prefix)) {
				results.push(JSON.parse(value) as ShardMetadata);
			} else if (key > prefix + "\xff") {
				break;
			}
		}

		return results;
	}

	/**
	 * Get storage statistics for a specific agent.
	 */
	getAgentStats(agentDid: string): AgentStorageStats {
		return (
			this.agentStats.get(agentDid) ?? {
				totalBytes: 0,
				shardCount: 0,
				latestVersion: -1,
			}
		);
	}

	/**
	 * Get overall storage statistics.
	 */
	getStats(): StorageStats {
		return {
			totalBytes: this.totalBytes,
			totalShards: this.totalShards,
			agentCount: this.agentStats.size,
		};
	}

	/**
	 * Remove all expired shards.
	 * Returns the number of shards removed.
	 */
	async cleanExpired(): Promise<number> {
		const now = Date.now();
		let removed = 0;

		const toDelete: Array<{
			key: ShardKey;
			metadata: ShardMetadata;
		}> = [];

		for await (const [dbKey, value] of this.db.iterator()) {
			if (!dbKey.startsWith("meta:")) continue;
			const metadata = JSON.parse(value) as ShardMetadata;
			if (
				metadata.expiresAt !== undefined &&
				now >= metadata.expiresAt
			) {
				toDelete.push({
					key: {
						agentDid: metadata.agentDid,
						version: metadata.version,
						shardIndex: metadata.shardIndex,
					},
					metadata,
				});
			}
		}

		for (const { key, metadata } of toDelete) {
			await this.deleteShard(key, metadata);
			removed++;
		}

		return removed;
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private async getMetadata(key: ShardKey): Promise<ShardMetadata | null> {
		try {
			const raw = await this.db.get(encodeMetaKey(key));
			if (raw === undefined) return null;
			return JSON.parse(raw) as ShardMetadata;
		} catch {
			return null;
		}
	}

	private async deleteShard(
		key: ShardKey,
		metadata: ShardMetadata,
	): Promise<void> {
		await this.db.del(encodeShardKey(key));
		await this.db.del(encodeMetaKey(key));
		this.decrementStats(metadata);
	}

	private incrementStats(metadata: ShardMetadata): void {
		this.totalBytes += metadata.size;
		this.totalShards += 1;

		const stats = this.agentStats.get(metadata.agentDid) ?? {
			totalBytes: 0,
			shardCount: 0,
			latestVersion: -1,
		};
		stats.totalBytes += metadata.size;
		stats.shardCount += 1;
		if (metadata.version > stats.latestVersion) {
			stats.latestVersion = metadata.version;
		}
		this.agentStats.set(metadata.agentDid, stats);
	}

	private decrementStats(metadata: ShardMetadata): void {
		this.totalBytes = Math.max(0, this.totalBytes - metadata.size);
		this.totalShards = Math.max(0, this.totalShards - 1);

		const stats = this.agentStats.get(metadata.agentDid);
		if (stats) {
			stats.totalBytes = Math.max(
				0,
				stats.totalBytes - metadata.size,
			);
			stats.shardCount = Math.max(0, stats.shardCount - 1);
			if (stats.shardCount === 0) {
				this.agentStats.delete(metadata.agentDid);
			}
		}
	}

	/**
	 * Rebuild in-memory stats by scanning all metadata in the database.
	 */
	private async rebuildStats(): Promise<void> {
		this.agentStats.clear();
		this.totalBytes = 0;
		this.totalShards = 0;

		for await (const [key, value] of this.db.iterator()) {
			if (!key.startsWith("meta:")) continue;
			const metadata = JSON.parse(value) as ShardMetadata;

			// Skip expired during rebuild
			if (
				metadata.expiresAt !== undefined &&
				Date.now() >= metadata.expiresAt
			) {
				continue;
			}

			this.incrementStats(metadata);
		}
	}
}

/**
 * Convert a hex string to Uint8Array.
 * Extracted to avoid importing from external modules in hot path.
 */
function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}
