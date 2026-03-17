/**
 * Supported external archive targets.
 */
export type ArchiveTarget = "arweave" | "filecoin" | "ipfs";

/**
 * Configuration for the dead man's archive.
 */
export interface ArchiveConfig {
	targets: ArchiveTargetConfig[];
	autoArchive: boolean;
	archiveOnDeath: boolean;
}

/**
 * Per-target configuration.
 */
export interface ArchiveTargetConfig {
	type: ArchiveTarget;
	frequency: number;
	encryptionKey: "agent" | "guardian" | "shared";
	maxCost: bigint;
}

/**
 * Receipt from a completed archive operation.
 */
export interface ArchiveReceipt {
	id: string;
	target: ArchiveTarget;
	contentHash: string;
	externalId: string;
	consciousnessVersion: number;
	timestamp: number;
	size: number;
	signature: Uint8Array;
}

/**
 * Verification result for an archive.
 */
export interface ArchiveVerification {
	receiptId: string;
	isValid: boolean;
	target: ArchiveTarget;
	contentHash: string;
	externalId: string;
	error?: string;
}

/**
 * Pluggable backend for external storage.
 */
export interface ArchiveBackend {
	readonly type: ArchiveTarget;
	upload(data: Uint8Array): Promise<{ externalId: string; size: number }>;
	download(externalId: string): Promise<Uint8Array>;
	verify(externalId: string, expectedHash: string): Promise<boolean>;
}
