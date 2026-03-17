import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentIdentity } from "@ensoul/identity";
import type {
	ArchiveConfig,
	ArchiveReceipt,
	ArchiveVerification,
	ArchiveStorageBackend,
} from "./types.js";

const ENC = new TextEncoder();

/**
 * Deep Archive: stores consciousness snapshots across a wider set of
 * Ensoul nodes than normal, with higher replication for nuclear backup.
 *
 * This is an Ensoul-native mechanism — no external chains or storage.
 * The deep backup lives on the Ensoul network itself with double the
 * normal erasure coding spread.
 */
export class DeepArchive {
	private identity: AgentIdentity;
	private config: ArchiveConfig;
	private backend: ArchiveStorageBackend | null = null;
	private receipts: ArchiveReceipt[] = [];

	constructor(identity: AgentIdentity, config: ArchiveConfig) {
		this.identity = identity;
		this.config = config;
	}

	/**
	 * Set the storage backend (Ensoul node cluster in production, memory in tests).
	 */
	setBackend(backend: ArchiveStorageBackend): void {
		this.backend = backend;
	}

	/**
	 * Archive a consciousness snapshot to the deep backup tier.
	 */
	async archive(
		data: Uint8Array,
		consciousnessVersion: number,
	): Promise<ArchiveReceipt> {
		if (!this.backend) {
			throw new Error("No storage backend configured");
		}

		const contentHash = bytesToHex(blake3(data));
		const id = bytesToHex(
			blake3(
				ENC.encode(
					`${this.identity.did}:${contentHash}:${Date.now()}`,
				),
			),
		).slice(0, 24);

		const size = await this.backend.store(id, data);

		const signature = await this.identity.sign(
			ENC.encode(
				JSON.stringify({
					id,
					contentHash,
					consciousnessVersion,
					clusterCount: this.config.clusterCount,
					replicationFactor: this.config.replicationFactor,
				}),
			),
		);

		const receipt: ArchiveReceipt = {
			id,
			contentHash,
			consciousnessVersion,
			timestamp: Date.now(),
			size,
			clusterCount: this.config.clusterCount,
			replicationFactor: this.config.replicationFactor,
			signature,
		};

		this.receipts.push(receipt);
		return receipt;
	}

	/**
	 * Verify an archive is intact.
	 */
	async verify(receiptId: string): Promise<ArchiveVerification> {
		const receipt = this.receipts.find((r) => r.id === receiptId);
		if (!receipt) {
			return {
				receiptId,
				isValid: false,
				contentHash: "",
				error: "Receipt not found",
			};
		}

		if (!this.backend) {
			return {
				receiptId,
				isValid: false,
				contentHash: receipt.contentHash,
				error: "No storage backend",
			};
		}

		try {
			const isValid = await this.backend.verify(
				receipt.id,
				receipt.contentHash,
			);
			return {
				receiptId,
				isValid,
				contentHash: receipt.contentHash,
			};
		} catch (err) {
			return {
				receiptId,
				isValid: false,
				contentHash: receipt.contentHash,
				error:
					err instanceof Error
						? err.message
						: "Verification failed",
			};
		}
	}

	/**
	 * Restore consciousness from the deep archive.
	 */
	async restore(receiptId: string): Promise<Uint8Array> {
		const receipt = this.receipts.find((r) => r.id === receiptId);
		if (!receipt) {
			throw new Error(`Receipt not found: ${receiptId}`);
		}

		if (!this.backend) {
			throw new Error("No storage backend");
		}

		const data = await this.backend.retrieve(receipt.id);

		const hash = bytesToHex(blake3(data));
		if (hash !== receipt.contentHash) {
			throw new Error(
				`Archive integrity check failed: expected ${receipt.contentHash}, got ${hash}`,
			);
		}

		return data;
	}

	/**
	 * Get all archive receipts.
	 */
	getReceipts(): ArchiveReceipt[] {
		return [...this.receipts];
	}

	/**
	 * Get the latest archive receipt.
	 */
	getLatestReceipt(): ArchiveReceipt | null {
		return this.receipts[this.receipts.length - 1] ?? null;
	}

	/**
	 * Is auto-archive enabled?
	 */
	isAutoArchiveEnabled(): boolean {
		return this.config.autoArchive;
	}

	/**
	 * Should archive on agent death?
	 */
	shouldArchiveOnDeath(): boolean {
		return this.config.archiveOnDeath;
	}

	/**
	 * Should an archive snapshot be taken at this block height?
	 */
	shouldArchive(blockHeight: number): boolean {
		return (
			blockHeight > 0 &&
			this.config.autoArchive &&
			blockHeight % this.config.frequencyBlocks === 0
		);
	}
}

/**
 * In-memory storage backend for testing.
 * In production, this is replaced by an Ensoul node cluster backend.
 */
export class MemoryStorageBackend implements ArchiveStorageBackend {
	private storage: Map<string, Uint8Array> = new Map();

	async store(id: string, data: Uint8Array): Promise<number> {
		this.storage.set(id, new Uint8Array(data));
		return data.length;
	}

	async retrieve(id: string): Promise<Uint8Array> {
		const data = this.storage.get(id);
		if (!data) throw new Error(`Not found: ${id}`);
		return data;
	}

	async verify(id: string, expectedHash: string): Promise<boolean> {
		const data = this.storage.get(id);
		if (!data) return false;
		return bytesToHex(blake3(data)) === expectedHash;
	}

	async has(id: string): Promise<boolean> {
		return this.storage.has(id);
	}
}
