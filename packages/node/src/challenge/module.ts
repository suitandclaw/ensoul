import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type {
	Challenge,
	ChallengeResponse,
	VerificationResult,
	NodeReputation,
	ChallengeSchedulerConfig,
	ChallengableShard,
} from "./types.js";

/** Default scheduler configuration. */
const DEFAULT_CONFIG: ChallengeSchedulerConfig = {
	intervalMs: 60_000,
	maxChallengeLength: 4096,
	deadlineMs: 30_000,
};

/**
 * Generate a unique challenge ID from random bytes.
 */
function generateId(): string {
	return bytesToHex(randomBytes(16));
}

/**
 * Generate a proof-of-storage challenge for a specific shard.
 *
 * Picks a random byte offset and length within the shard's bounds.
 * The challenged node must hash shard[offset..offset+length] with Blake3
 * and return the result.
 *
 * @param shard - The shard to challenge
 * @param config - Scheduler config for deadline and max length
 */
export function generateChallenge(
	shard: ChallengableShard,
	config?: Partial<ChallengeSchedulerConfig>,
): Challenge {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	if (shard.shardSize === 0) {
		throw new Error("Cannot challenge an empty shard");
	}

	// Pick random offset and length within shard bounds
	const maxLen = Math.min(cfg.maxChallengeLength, shard.shardSize);
	const length = Math.max(1, randomInt(maxLen));
	const maxOffset = shard.shardSize - length;
	const offset = maxOffset > 0 ? randomInt(maxOffset + 1) : 0;

	const now = Date.now();

	return {
		id: generateId(),
		nodeDid: shard.nodeDid,
		agentDid: shard.agentDid,
		version: shard.version,
		shardIndex: shard.shardIndex,
		offset,
		length,
		issuedAt: now,
		deadline: now + cfg.deadlineMs,
	};
}

/**
 * Respond to a challenge by hashing the requested byte range.
 *
 * @param challenge - The challenge to respond to
 * @param shardData - The full shard data
 * @returns The challenge response with the Blake3 hash
 * @throws If the byte range is out of bounds
 */
export function respondToChallenge(
	challenge: Challenge,
	shardData: Uint8Array,
): ChallengeResponse {
	if (challenge.offset + challenge.length > shardData.length) {
		throw new Error(
			`Byte range [${challenge.offset}..${challenge.offset + challenge.length}] ` +
				`exceeds shard size ${shardData.length}`,
		);
	}

	const slice = shardData.subarray(
		challenge.offset,
		challenge.offset + challenge.length,
	);
	const hash = bytesToHex(blake3(slice));

	return {
		challengeId: challenge.id,
		hash,
		respondedAt: Date.now(),
	};
}

/**
 * Verify a challenge response against the expected hash.
 *
 * Computes the expected Blake3 hash of the shard's byte range
 * and compares it with the response.
 *
 * @param challenge - The original challenge
 * @param response - The response from the challenged node
 * @param shardData - The actual shard data (held by the verifier)
 */
export function verifyResponse(
	challenge: Challenge,
	response: ChallengeResponse,
	shardData: Uint8Array,
): VerificationResult {
	if (response.challengeId !== challenge.id) {
		return { valid: false, reason: "Challenge ID mismatch" };
	}

	if (response.respondedAt > challenge.deadline) {
		return { valid: false, reason: "Response received after deadline" };
	}

	if (challenge.offset + challenge.length > shardData.length) {
		return { valid: false, reason: "Byte range exceeds shard size" };
	}

	const slice = shardData.subarray(
		challenge.offset,
		challenge.offset + challenge.length,
	);
	const expectedHash = bytesToHex(blake3(slice));

	if (response.hash !== expectedHash) {
		return {
			valid: false,
			reason: `Hash mismatch: expected ${expectedHash}, got ${response.hash}`,
		};
	}

	return { valid: true };
}

/**
 * Reputation tracker for storage nodes.
 * Tracks challenge pass/fail history and computes reputation scores.
 */
export class ReputationTracker {
	private reputations: Map<string, NodeReputation> = new Map();

	/**
	 * Record a challenge result for a node.
	 */
	recordResult(nodeDid: string, passed: boolean): void {
		const rep = this.getOrCreate(nodeDid);
		rep.totalChallenges += 1;
		if (passed) {
			rep.passed += 1;
		} else {
			rep.failed += 1;
		}
		rep.score = this.computeScore(rep);
		rep.lastChallengeAt = Date.now();
	}

	/**
	 * Get reputation for a node.
	 */
	getReputation(nodeDid: string): NodeReputation {
		return (
			this.reputations.get(nodeDid) ?? {
				nodeDid,
				totalChallenges: 0,
				passed: 0,
				failed: 0,
				score: 1.0,
				lastChallengeAt: 0,
			}
		);
	}

	/**
	 * Get all tracked reputations.
	 */
	getAllReputations(): NodeReputation[] {
		return [...this.reputations.values()];
	}

	/**
	 * Compute the reputation score.
	 * Uses an exponentially weighted approach that penalizes failures heavily.
	 * Score ranges from 0.0 (all failures) to 1.0 (all passes).
	 */
	private computeScore(rep: NodeReputation): number {
		if (rep.totalChallenges === 0) return 1.0;

		// Base score: pass rate
		const passRate = rep.passed / rep.totalChallenges;

		// Penalty multiplier: each failure reduces score more than a pass restores it
		// A node with 10 passes and 1 failure gets ~0.85 (not 0.91)
		const failPenalty = Math.pow(0.85, rep.failed);

		return Math.max(0, Math.min(1, passRate * failPenalty));
	}

	private getOrCreate(nodeDid: string): NodeReputation {
		let rep = this.reputations.get(nodeDid);
		if (!rep) {
			rep = {
				nodeDid,
				totalChallenges: 0,
				passed: 0,
				failed: 0,
				score: 1.0,
				lastChallengeAt: 0,
			};
			this.reputations.set(nodeDid, rep);
		}
		return rep;
	}
}

/**
 * Challenge scheduler that periodically generates challenges for stored shards.
 */
export class ChallengeScheduler {
	private config: ChallengeSchedulerConfig;
	private timer: ReturnType<typeof setInterval> | null = null;
	private shardProvider: () => ChallengableShard[];
	private onChallenge: (challenge: Challenge) => void;
	private running = false;

	constructor(
		shardProvider: () => ChallengableShard[],
		onChallenge: (challenge: Challenge) => void,
		config?: Partial<ChallengeSchedulerConfig>,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.shardProvider = shardProvider;
		this.onChallenge = onChallenge;
	}

	/**
	 * Start the scheduler.
	 */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(
			() => this.generateRound(),
			this.config.intervalMs,
		);
	}

	/**
	 * Stop the scheduler.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.running = false;
	}

	/**
	 * Whether the scheduler is currently running.
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Manually trigger a challenge round (useful for testing).
	 * Returns the challenges generated.
	 */
	generateRound(): Challenge[] {
		const shards = this.shardProvider();
		const challenges: Challenge[] = [];

		for (const shard of shards) {
			if (shard.shardSize === 0) continue;
			const challenge = generateChallenge(shard, this.config);
			challenges.push(challenge);
			this.onChallenge(challenge);
		}

		return challenges;
	}
}

/**
 * Generate a random integer in [0, max).
 */
function randomInt(max: number): number {
	if (max <= 0) return 0;
	const bytes = randomBytes(4);
	const val = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
		0,
		false,
	);
	return val % max;
}
