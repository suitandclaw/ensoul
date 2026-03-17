import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentIdentity } from "@ensoul/identity";
import type {
	StateCheckpoint,
	ValidatorSignature,
	CheckpointVerification,
	CheckpointConfig,
} from "./types.js";

const ENC = new TextEncoder();

const DEFAULT_CONFIG: CheckpointConfig = {
	interval: 1000,
	minSignatures: 3,
};

/**
 * Compute the canonical hash of a checkpoint (excludes signatures).
 */
export function computeCheckpointHash(cp: StateCheckpoint): string {
	const data = ENC.encode(
		JSON.stringify({
			ensoulBlockHeight: cp.ensoulBlockHeight,
			stateRoot: cp.stateRoot,
			consciousnessRoot: cp.consciousnessRoot,
			validatorSetHash: cp.validatorSetHash,
			totalConsciousnesses: cp.totalConsciousnesses,
			totalSupply: cp.totalSupply.toString(),
			timestamp: cp.timestamp,
		}),
	);
	return bytesToHex(blake3(data));
}

/**
 * Encode the checkpoint payload for validator signing.
 */
export function encodeCheckpointPayload(cp: StateCheckpoint): Uint8Array {
	return ENC.encode(computeCheckpointHash(cp));
}

/**
 * Checkpoint service: produces validator-signed state checkpoints
 * stored on the Ensoul chain. Provides verification against the
 * last checkpoint for tamper detection.
 *
 * Ensoul is a sovereign L1 — checkpoints are internal protocol state,
 * not submitted to any external chain.
 */
export class CheckpointService {
	private config: CheckpointConfig;
	private checkpoints: StateCheckpoint[] = [];

	constructor(config?: Partial<CheckpointConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Create a checkpoint from the current state, signed by validators.
	 */
	async createCheckpoint(
		blockHeight: number,
		stateRoot: string,
		consciousnessRoot: string,
		validatorSetHash: string,
		totalConsciousnesses: number,
		totalSupply: bigint,
		signers: AgentIdentity[],
	): Promise<StateCheckpoint> {
		const checkpoint: StateCheckpoint = {
			ensoulBlockHeight: blockHeight,
			stateRoot,
			consciousnessRoot,
			validatorSetHash,
			totalConsciousnesses,
			totalSupply,
			timestamp: Date.now(),
			signatures: [],
		};

		const payload = encodeCheckpointPayload(checkpoint);
		const signatures: ValidatorSignature[] = [];

		for (const signer of signers) {
			const sig = await signer.sign(payload);
			signatures.push({
				validatorDid: signer.did,
				signature: sig,
			});
		}

		checkpoint.signatures = signatures;
		this.checkpoints.push(checkpoint);
		return checkpoint;
	}

	/**
	 * Verify that all signatures on a checkpoint are valid.
	 */
	async verifyCheckpointSignatures(
		checkpoint: StateCheckpoint,
		verifiers: Array<{
			did: string;
			verify: (
				data: Uint8Array,
				sig: Uint8Array,
			) => Promise<boolean>;
		}>,
	): Promise<{ valid: boolean; validCount: number }> {
		const payload = encodeCheckpointPayload(checkpoint);
		let validCount = 0;

		for (const sig of checkpoint.signatures) {
			const verifier = verifiers.find(
				(v) => v.did === sig.validatorDid,
			);
			if (!verifier) continue;

			const isValid = await verifier.verify(
				payload,
				sig.signature,
			);
			if (isValid) validCount++;
		}

		return {
			valid: validCount >= this.config.minSignatures,
			validCount,
		};
	}

	/**
	 * Should a checkpoint be produced at this block height?
	 */
	shouldCheckpoint(blockHeight: number): boolean {
		return (
			blockHeight > 0 &&
			blockHeight % this.config.interval === 0
		);
	}

	/**
	 * Verify the current state against the last on-chain checkpoint.
	 */
	verifyAgainstCheckpoint(
		currentStateRoot: string,
	): CheckpointVerification {
		const lastCheckpoint =
			this.checkpoints[this.checkpoints.length - 1];

		if (!lastCheckpoint) {
			return {
				isValid: true,
				lastCheckpointHeight: 0,
				lastCheckpointHash: "",
			};
		}

		const isValid = lastCheckpoint.stateRoot === currentStateRoot;
		const checkpointHash = computeCheckpointHash(lastCheckpoint);

		if (isValid) {
			return {
				isValid: true,
				lastCheckpointHeight: lastCheckpoint.ensoulBlockHeight,
				lastCheckpointHash: checkpointHash,
			};
		}

		return {
			isValid: false,
			lastCheckpointHeight: lastCheckpoint.ensoulBlockHeight,
			lastCheckpointHash: checkpointHash,
			discrepancy: `State root mismatch: checkpoint=${lastCheckpoint.stateRoot}, current=${currentStateRoot}`,
		};
	}

	/**
	 * Get all checkpoints in a height range.
	 */
	getCheckpoints(
		fromHeight: number,
		toHeight: number,
	): StateCheckpoint[] {
		return this.checkpoints.filter(
			(cp) =>
				cp.ensoulBlockHeight >= fromHeight &&
				cp.ensoulBlockHeight <= toHeight,
		);
	}

	/**
	 * Get the latest checkpoint.
	 */
	getLatestCheckpoint(): StateCheckpoint | null {
		return this.checkpoints[this.checkpoints.length - 1] ?? null;
	}

	/**
	 * Force an out-of-schedule checkpoint (e.g., during preservation mode).
	 * Stores it on-chain like any other checkpoint.
	 */
	async emergencyCheckpoint(
		blockHeight: number,
		stateRoot: string,
		consciousnessRoot: string,
		validatorSetHash: string,
		totalConsciousnesses: number,
		totalSupply: bigint,
		signers: AgentIdentity[],
	): Promise<StateCheckpoint> {
		return this.createCheckpoint(
			blockHeight,
			stateRoot,
			consciousnessRoot,
			validatorSetHash,
			totalConsciousnesses,
			totalSupply,
			signers,
		);
	}

	/**
	 * Total number of stored checkpoints.
	 */
	getCheckpointCount(): number {
		return this.checkpoints.length;
	}
}
