/**
 * Configuration for the deep archive (Ensoul-native nuclear backup).
 */
export interface ArchiveConfig {
	/** Number of node clusters to distribute deep backup across. */
	clusterCount: number;
	/** Replication factor per cluster (higher than normal erasure coding). */
	replicationFactor: number;
	/** Frequency of archive snapshots (in blocks). */
	frequencyBlocks: number;
	/** Auto-archive on schedule. */
	autoArchive: boolean;
	/** Emergency archive if agent death detected. */
	archiveOnDeath: boolean;
}

/**
 * Receipt from a completed archive operation.
 * Stored on-chain for verifiable proof of archive existence.
 */
export interface ArchiveReceipt {
	id: string;
	contentHash: string;
	consciousnessVersion: number;
	timestamp: number;
	size: number;
	clusterCount: number;
	replicationFactor: number;
	signature: Uint8Array;
}

/**
 * Verification result for an archive.
 */
export interface ArchiveVerification {
	receiptId: string;
	isValid: boolean;
	contentHash: string;
	error?: string;
}

/**
 * Pluggable storage backend for the deep archive.
 * In production, this distributes to Ensoul node clusters.
 * In testing, uses an in-memory store.
 */
export interface ArchiveStorageBackend {
	store(id: string, data: Uint8Array): Promise<number>;
	retrieve(id: string): Promise<Uint8Array>;
	verify(id: string, expectedHash: string): Promise<boolean>;
	has(id: string): Promise<boolean>;
}
