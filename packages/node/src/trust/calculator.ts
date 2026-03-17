import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
	TrustLevel,
	TrustLevelNumber,
	TrustAssessment,
	LayerStatus,
	TrustInput,
} from "./types.js";

const LEVEL_INFO: Record<
	TrustLevel,
	{ numeric: TrustLevelNumber; label: string; description: string }
> = {
	basic: {
		numeric: 1,
		label: "Basic",
		description:
			"Consciousness stored on the Ensoul network with erasure coding.",
	},
	verified: {
		numeric: 2,
		label: "Verified",
		description:
			"Consciousness stored and continuously verified via proof-of-storage.",
	},
	anchored: {
		numeric: 3,
		label: "Anchored",
		description:
			"Consciousness verified with validator-signed state checkpoints.",
	},
	immortal: {
		numeric: 4,
		label: "Immortal",
		description:
			"Consciousness cannot be permanently destroyed. Deep archive and resurrection active.",
	},
	sovereign: {
		numeric: 5,
		label: "Sovereign",
		description:
			"Fully sovereign. No single entity can prevent continued existence.",
	},
};

/**
 * Compute the trust level for an agent based on its active Ensoul-native protection layers.
 */
export function computeTrustLevel(input: TrustInput): TrustLevel {
	// Level 5 - Sovereign: Immortal + redundant runtime + guardian + escrow
	if (
		input.hasEnsoulStorage &&
		input.proofOfStoragePassing &&
		input.selfAuditPassing &&
		input.checkpointActive &&
		input.deepArchiveActive &&
		input.resurrectionPlanActive &&
		input.redundantRuntime &&
		input.guardianNetwork &&
		input.selfFundedEscrow
	) {
		return "sovereign";
	}

	// Level 4 - Immortal: Anchored + deep archive + resurrection
	if (
		input.hasEnsoulStorage &&
		input.proofOfStoragePassing &&
		input.selfAuditPassing &&
		input.checkpointActive &&
		input.deepArchiveActive &&
		input.resurrectionPlanActive
	) {
		return "immortal";
	}

	// Level 3 - Anchored: Verified + internal checkpointing active
	if (
		input.hasEnsoulStorage &&
		input.proofOfStoragePassing &&
		input.selfAuditPassing &&
		input.checkpointActive
	) {
		return "anchored";
	}

	// Level 2 - Verified: Basic + proof-of-storage + self-audit
	if (
		input.hasEnsoulStorage &&
		input.proofOfStoragePassing &&
		input.selfAuditPassing
	) {
		return "verified";
	}

	// Level 1 - Basic: Ensoul storage with erasure coding
	return "basic";
}

/**
 * Build a full trust assessment for an agent.
 */
export function assessTrust(
	did: string,
	input: TrustInput,
): TrustAssessment {
	const level = computeTrustLevel(input);
	const info = LEVEL_INFO[level];

	const layers: LayerStatus[] = [
		{
			layer: 1,
			name: "Proof of Stake",
			active: input.hasEnsoulStorage,
			details: input.hasEnsoulStorage
				? "Chain integrity active"
				: "No storage on Ensoul",
		},
		{
			layer: 2,
			name: "Proof of Storage",
			active: input.proofOfStoragePassing,
			details: input.proofOfStoragePassing
				? "Storage challenges passing"
				: "Not verified",
		},
		{
			layer: 3,
			name: "Erasure Coding",
			active: input.hasEnsoulStorage,
			details: input.hasEnsoulStorage
				? "Shards distributed across Ensoul nodes"
				: "No shards",
		},
		{
			layer: 4,
			name: "Internal Checkpointing",
			active: input.checkpointActive,
			details: input.checkpointActive
				? "Validator-signed state snapshots active"
				: "No checkpoints",
		},
		{
			layer: 5,
			name: "Agent Self-Audit",
			active: input.selfAuditPassing,
			details: input.selfAuditPassing
				? "Self-audit passing"
				: "Not audited",
		},
		{
			layer: 6,
			name: "Replication Enforcement",
			active: input.hasEnsoulStorage,
			details: input.hasEnsoulStorage
				? "Minimum replication enforced"
				: "Not tracked",
		},
		{
			layer: 7,
			name: "Deep Archive",
			active: input.deepArchiveActive,
			details: input.deepArchiveActive
				? "High-replication backup on Ensoul network"
				: "No deep archive",
		},
	];

	return {
		did,
		level,
		numericLevel: info.numeric,
		label: info.label,
		description: info.description,
		layers,
		timestamp: Date.now(),
	};
}

/**
 * Compute a verifiable hash of a trust assessment for on-chain storage.
 */
export function hashTrustAssessment(assessment: TrustAssessment): string {
	const data = new TextEncoder().encode(
		JSON.stringify({
			did: assessment.did,
			level: assessment.level,
			numericLevel: assessment.numericLevel,
			layers: assessment.layers.map((l) => ({
				layer: l.layer,
				active: l.active,
			})),
			timestamp: assessment.timestamp,
		}),
	);
	return bytesToHex(blake3(data));
}

/**
 * Get the numeric trust level for a given trust level name.
 */
export function trustLevelToNumber(level: TrustLevel): TrustLevelNumber {
	return LEVEL_INFO[level].numeric;
}

/**
 * Get the trust level name for a given numeric level.
 */
export function numberToTrustLevel(num: TrustLevelNumber): TrustLevel {
	const entries = Object.entries(LEVEL_INFO) as Array<
		[TrustLevel, { numeric: TrustLevelNumber }]
	>;
	const found = entries.find(([, info]) => info.numeric === num);
	return found ? found[0] : "basic";
}
