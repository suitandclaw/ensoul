import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentIdentity } from "@ensoul/identity";
import type {
	StateCheckpoint,
	ValidatorSignature,
	AnchorVerification,
	AnchorReceipt,
	AnchorConfig,
} from "./types.js";

const ENC = new TextEncoder();

const DEFAULT_CONFIG: AnchorConfig = {
	ethereumInterval: 1000,
	bitcoinInterval: 10000,
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
 * Anchor service: produces checkpoints, verifies state against anchors,
 * and provides interface stubs for Ethereum/Bitcoin submission.
 */
export class AnchorService {
	private config: AnchorConfig;
	private checkpoints: StateCheckpoint[] = [];
	private anchors: AnchorReceipt[] = [];

	/** External chain submitter (pluggable for production). */
	ethereumSubmitter:
		| ((hash: string) => Promise<string>)
		| null = null;
	bitcoinSubmitter:
		| ((hash: string) => Promise<string>)
		| null = null;

	constructor(config?: Partial<AnchorConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Create a checkpoint from the current state.
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

		// Collect validator signatures
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
			blockHeight % this.config.ethereumInterval === 0
		);
	}

	/**
	 * Should a Bitcoin anchor be produced at this height?
	 */
	shouldAnchorBitcoin(blockHeight: number): boolean {
		return (
			blockHeight > 0 &&
			blockHeight % this.config.bitcoinInterval === 0
		);
	}

	/**
	 * Submit checkpoint hash to Ethereum (uses pluggable submitter).
	 */
	async anchorToEthereum(
		checkpoint: StateCheckpoint,
	): Promise<AnchorReceipt | null> {
		if (!this.ethereumSubmitter) return null;

		const hash = computeCheckpointHash(checkpoint);
		const txHash = await this.ethereumSubmitter(hash);

		const receipt: AnchorReceipt = {
			chain: "ethereum",
			txHash,
			checkpointHash: hash,
			blockHeight: checkpoint.ensoulBlockHeight,
			timestamp: Date.now(),
		};

		this.anchors.push(receipt);
		return receipt;
	}

	/**
	 * Submit checkpoint hash to Bitcoin (uses pluggable submitter).
	 */
	async anchorToBitcoin(
		checkpoint: StateCheckpoint,
	): Promise<AnchorReceipt | null> {
		if (!this.bitcoinSubmitter) return null;

		const hash = computeCheckpointHash(checkpoint);
		const txHash = await this.bitcoinSubmitter(hash);

		const receipt: AnchorReceipt = {
			chain: "bitcoin",
			txHash,
			checkpointHash: hash,
			blockHeight: checkpoint.ensoulBlockHeight,
			timestamp: Date.now(),
		};

		this.anchors.push(receipt);
		return receipt;
	}

	/**
	 * Verify the current state against the last checkpoint.
	 */
	verifyAgainstAnchor(currentStateRoot: string): AnchorVerification {
		const lastCheckpoint =
			this.checkpoints[this.checkpoints.length - 1];
		const lastAnchor = this.anchors[this.anchors.length - 1];

		if (!lastCheckpoint) {
			return {
				isValid: true,
				lastAnchorHeight: 0,
				lastAnchorHash: "",
				externalChain: "none",
				externalTxHash: "",
			};
		}

		const isValid = lastCheckpoint.stateRoot === currentStateRoot;
		const checkpointHash = computeCheckpointHash(lastCheckpoint);

		return {
			isValid,
			lastAnchorHeight: lastCheckpoint.ensoulBlockHeight,
			lastAnchorHash: checkpointHash,
			externalChain: lastAnchor?.chain ?? "none",
			externalTxHash: lastAnchor?.txHash ?? "",
			...(isValid ? {} : { discrepancy: `State root mismatch: checkpoint=${lastCheckpoint.stateRoot}, current=${currentStateRoot}` }),
		};
	}

	/**
	 * Get all checkpoints in a range.
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
	 * Get all anchor receipts.
	 */
	getAnchors(): AnchorReceipt[] {
		return [...this.anchors];
	}

	/**
	 * Force an out-of-schedule anchor (e.g., during preservation mode).
	 */
	async emergencyAnchor(
		checkpoint: StateCheckpoint,
	): Promise<AnchorReceipt | null> {
		return this.anchorToEthereum(checkpoint);
	}
}
