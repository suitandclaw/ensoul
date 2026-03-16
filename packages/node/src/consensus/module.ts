import type { AgentIdentity } from "@ensoul/identity";
import type {
	ValidatorInfo,
	Attestation,
	AttestationPayload,
	ThresholdResult,
	ConsensusConfig,
} from "./types.js";

/** Default configuration: 3-of-4 threshold, 0 minimum stake. */
const DEFAULT_CONFIG: ConsensusConfig = {
	threshold: 3,
	minStake: 0,
};

/**
 * Encode an attestation payload as deterministic bytes for signing/verification.
 */
export function encodeAttestationPayload(
	payload: AttestationPayload,
): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Consensus module for the Ensoul node.
 *
 * Manages a set of registered validators and provides:
 * - Validator registration and removal
 * - Attestation signing (validator confirms storage of a shard)
 * - Attestation verification (check signature against validator's public key)
 * - Threshold checking (K-of-N unique valid attestations)
 */
export class ConsensusModule {
	private validators: Map<string, ValidatorInfo> = new Map();
	private config: ConsensusConfig;

	constructor(config?: Partial<ConsensusConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	// ── Validator set management ─────────────────────────────────────

	/**
	 * Register a new validator.
	 * @throws If the validator is already registered.
	 * @throws If the stake is below the minimum.
	 */
	registerValidator(
		did: string,
		publicKey: Uint8Array,
		stake: number,
	): ValidatorInfo {
		if (this.validators.has(did)) {
			throw new Error(`Validator already registered: ${did}`);
		}

		if (publicKey.length !== 32) {
			throw new Error("Public key must be 32 bytes");
		}

		if (stake < this.config.minStake) {
			throw new Error(
				`Stake ${stake} below minimum ${this.config.minStake}`,
			);
		}

		const info: ValidatorInfo = {
			did,
			publicKey,
			stake,
			registeredAt: Date.now(),
		};

		this.validators.set(did, info);
		return info;
	}

	/**
	 * Remove a validator from the set.
	 * @returns true if the validator was removed, false if not found.
	 */
	removeValidator(did: string): boolean {
		return this.validators.delete(did);
	}

	/**
	 * Get information about a specific validator.
	 */
	getValidator(did: string): ValidatorInfo | null {
		return this.validators.get(did) ?? null;
	}

	/**
	 * Check if a DID is a registered validator.
	 */
	isValidator(did: string): boolean {
		return this.validators.has(did);
	}

	/**
	 * Get all registered validators.
	 */
	getValidators(): ValidatorInfo[] {
		return [...this.validators.values()];
	}

	/**
	 * Get the number of registered validators.
	 */
	getValidatorCount(): number {
		return this.validators.size;
	}

	/**
	 * Update the consensus configuration.
	 */
	updateConfig(config: Partial<ConsensusConfig>): void {
		if (config.threshold !== undefined) {
			this.config.threshold = config.threshold;
		}
		if (config.minStake !== undefined) {
			this.config.minStake = config.minStake;
		}
	}

	/**
	 * Get the current consensus configuration.
	 */
	getConfig(): ConsensusConfig {
		return { ...this.config };
	}

	// ── Attestation signing ──────────────────────────────────────────

	/**
	 * Create a signed attestation.
	 * The validator signs: validatorDid + agentDid + stateRoot + version + timestamp.
	 *
	 * @param identity - The validator's identity (must match a registered validator)
	 * @param agentDid - The agent whose state is being attested
	 * @param stateRoot - Merkle root hash of the agent's state
	 * @param version - Version number of the agent's state
	 */
	async createAttestation(
		identity: AgentIdentity,
		agentDid: string,
		stateRoot: string,
		version: number,
	): Promise<Attestation> {
		if (!this.validators.has(identity.did)) {
			throw new Error(
				`Identity ${identity.did} is not a registered validator`,
			);
		}

		const timestamp = Date.now();

		const payload: AttestationPayload = {
			validatorDid: identity.did,
			agentDid,
			stateRoot,
			version,
			timestamp,
		};

		const message = encodeAttestationPayload(payload);
		const signature = await identity.sign(message);

		return {
			validatorDid: identity.did,
			agentDid,
			stateRoot,
			version,
			timestamp,
			signature,
		};
	}

	// ── Attestation verification ─────────────────────────────────────

	/**
	 * Verify a single attestation's signature.
	 * Checks that:
	 * 1. The validator is registered
	 * 2. The signature is valid against the validator's public key
	 *
	 * @param attestation - The attestation to verify
	 * @param identity - An identity instance to use for verification
	 *                    (only the verify method is needed, using the validator's public key)
	 */
	async verifyAttestation(attestation: Attestation): Promise<boolean> {
		const validator = this.validators.get(attestation.validatorDid);
		if (!validator) {
			return false;
		}

		const payload: AttestationPayload = {
			validatorDid: attestation.validatorDid,
			agentDid: attestation.agentDid,
			stateRoot: attestation.stateRoot,
			version: attestation.version,
			timestamp: attestation.timestamp,
		};

		const message = encodeAttestationPayload(payload);

		return verifySignature(
			message,
			attestation.signature,
			validator.publicKey,
		);
	}

	// ── Threshold checking ───────────────────────────────────────────

	/**
	 * Check whether a set of attestations meets the K-of-N threshold.
	 *
	 * Validates each attestation and counts unique valid attestations.
	 * Duplicate attestations from the same validator are counted only once.
	 * All attestations must agree on agentDid, stateRoot, and version.
	 *
	 * @param attestations - The attestations to check
	 * @param agentDid - Expected agent DID (all attestations must match)
	 * @param stateRoot - Expected state root (all attestations must match)
	 * @param version - Expected version (all attestations must match)
	 */
	async checkThreshold(
		attestations: Attestation[],
		agentDid: string,
		stateRoot: string,
		version: number,
	): Promise<ThresholdResult> {
		const seenValidators = new Set<string>();
		let validCount = 0;

		for (const att of attestations) {
			// Skip if wrong agent/state/version
			if (
				att.agentDid !== agentDid ||
				att.stateRoot !== stateRoot ||
				att.version !== version
			) {
				continue;
			}

			// Skip duplicates from same validator
			if (seenValidators.has(att.validatorDid)) {
				continue;
			}

			// Verify signature
			const valid = await this.verifyAttestation(att);
			if (valid) {
				seenValidators.add(att.validatorDid);
				validCount++;
			}
		}

		return {
			met: validCount >= this.config.threshold,
			validCount,
			required: this.config.threshold,
			total: this.validators.size,
		};
	}
}

/**
 * Verify an Ed25519 signature using @noble/ed25519.
 * We import and configure it here to avoid coupling the consensus module
 * to @ensoul/identity internals beyond the AgentIdentity interface.
 */
async function verifySignature(
	message: Uint8Array,
	signature: Uint8Array,
	publicKey: Uint8Array,
): Promise<boolean> {
	const { verify } = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	const { hashes } = await import("@noble/ed25519");

	// Ensure sha512 is configured (idempotent)
	if (!hashes.sha512) {
		hashes.sha512 = (msg: Uint8Array) => sha512(msg);
	}

	try {
		return verify(signature, message, publicKey);
	} catch {
		return false;
	}
}
