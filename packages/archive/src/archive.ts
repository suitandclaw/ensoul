import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentIdentity } from "@ensoul/identity";
import type {
	ArchiveConfig,
	ArchiveReceipt,
	ArchiveVerification,
	ArchiveBackend,
	ArchiveTarget,
} from "./types.js";

/**
 * Dead Man's Archive: stores consciousness snapshots on external
 * permanent storage as a nuclear backup independent of the Ensoul network.
 */
export class DeadMansArchive {
	private identity: AgentIdentity;
	private config: ArchiveConfig;
	private backends: Map<ArchiveTarget, ArchiveBackend> = new Map();
	private receipts: ArchiveReceipt[] = [];

	constructor(identity: AgentIdentity, config: ArchiveConfig) {
		this.identity = identity;
		this.config = config;
	}

	/**
	 * Register a backend for a target type.
	 */
	registerBackend(backend: ArchiveBackend): void {
		this.backends.set(backend.type, backend);
	}

	/**
	 * Archive a consciousness snapshot to all configured targets.
	 * Returns receipts for each successful upload.
	 */
	async archive(
		data: Uint8Array,
		consciousnessVersion: number,
	): Promise<ArchiveReceipt[]> {
		const contentHash = bytesToHex(blake3(data));
		const results: ArchiveReceipt[] = [];

		for (const targetConfig of this.config.targets) {
			const backend = this.backends.get(targetConfig.type);
			if (!backend) continue;

			try {
				const { externalId, size } = await backend.upload(data);
				const id = bytesToHex(
					blake3(
						new TextEncoder().encode(
							`${externalId}:${contentHash}:${Date.now()}`,
						),
					),
				).slice(0, 24);

				const signature = await this.identity.sign(
					new TextEncoder().encode(
						JSON.stringify({
							id,
							target: targetConfig.type,
							contentHash,
							externalId,
							consciousnessVersion,
						}),
					),
				);

				const receipt: ArchiveReceipt = {
					id,
					target: targetConfig.type,
					contentHash,
					externalId,
					consciousnessVersion,
					timestamp: Date.now(),
					size,
					signature,
				};

				this.receipts.push(receipt);
				results.push(receipt);
			} catch {
				// Target failed — continue with others
			}
		}

		return results;
	}

	/**
	 * Verify an archive is intact at the external target.
	 */
	async verify(receiptId: string): Promise<ArchiveVerification> {
		const receipt = this.receipts.find((r) => r.id === receiptId);
		if (!receipt) {
			return {
				receiptId,
				isValid: false,
				target: "arweave",
				contentHash: "",
				externalId: "",
				error: "Receipt not found",
			};
		}

		const backend = this.backends.get(receipt.target);
		if (!backend) {
			return {
				receiptId,
				isValid: false,
				target: receipt.target,
				contentHash: receipt.contentHash,
				externalId: receipt.externalId,
				error: `No backend for ${receipt.target}`,
			};
		}

		try {
			const isValid = await backend.verify(
				receipt.externalId,
				receipt.contentHash,
			);
			return {
				receiptId,
				isValid,
				target: receipt.target,
				contentHash: receipt.contentHash,
				externalId: receipt.externalId,
			};
		} catch (err) {
			return {
				receiptId,
				isValid: false,
				target: receipt.target,
				contentHash: receipt.contentHash,
				externalId: receipt.externalId,
				error:
					err instanceof Error
						? err.message
						: "Verification failed",
			};
		}
	}

	/**
	 * Restore consciousness data from an archive.
	 */
	async restoreFromArchive(receiptId: string): Promise<Uint8Array> {
		const receipt = this.receipts.find((r) => r.id === receiptId);
		if (!receipt) {
			throw new Error(`Receipt not found: ${receiptId}`);
		}

		const backend = this.backends.get(receipt.target);
		if (!backend) {
			throw new Error(`No backend for ${receipt.target}`);
		}

		const data = await backend.download(receipt.externalId);

		// Verify integrity
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
	 * Get the latest receipt for a specific target.
	 */
	getLatestReceipt(target: ArchiveTarget): ArchiveReceipt | null {
		for (let i = this.receipts.length - 1; i >= 0; i--) {
			if (this.receipts[i]!.target === target) {
				return this.receipts[i]!;
			}
		}
		return null;
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
}

/**
 * In-memory archive backend for testing.
 */
export class MemoryArchiveBackend implements ArchiveBackend {
	readonly type: ArchiveTarget;
	private storage: Map<string, Uint8Array> = new Map();
	private counter = 0;

	constructor(type: ArchiveTarget = "arweave") {
		this.type = type;
	}

	async upload(
		data: Uint8Array,
	): Promise<{ externalId: string; size: number }> {
		const id = `${this.type}_${++this.counter}`;
		this.storage.set(id, new Uint8Array(data));
		return { externalId: id, size: data.length };
	}

	async download(externalId: string): Promise<Uint8Array> {
		const data = this.storage.get(externalId);
		if (!data) throw new Error(`Not found: ${externalId}`);
		return data;
	}

	async verify(
		externalId: string,
		expectedHash: string,
	): Promise<boolean> {
		const data = this.storage.get(externalId);
		if (!data) return false;
		return bytesToHex(blake3(data)) === expectedHash;
	}
}
