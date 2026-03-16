import { describe, it, expect, vi, afterEach } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	generateChallenge,
	respondToChallenge,
	verifyResponse,
	ReputationTracker,
	ChallengeScheduler,
} from "../src/challenge/index.js";
import type {
	Challenge,
	ChallengeResponse,
	ChallengableShard,
} from "../src/challenge/index.js";

function shard(size: number, fill = 0xab): Uint8Array {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++) data[i] = (fill + i) % 256;
	return data;
}

const NODE_A = "did:key:z6MkNodeA";
const NODE_B = "did:key:z6MkNodeB";
const AGENT = "did:key:z6MkAgent";

const SHARD_INFO: ChallengableShard = {
	nodeDid: NODE_A,
	agentDid: AGENT,
	version: 1,
	shardIndex: 0,
	shardSize: 1024,
};

describe("Challenge Module", () => {
	// ── generateChallenge ────────────────────────────────────────────

	describe("generateChallenge", () => {
		it("generates a challenge with valid fields", () => {
			const c = generateChallenge(SHARD_INFO);

			expect(c.id).toBeTruthy();
			expect(c.id.length).toBe(32); // 16 bytes hex
			expect(c.nodeDid).toBe(NODE_A);
			expect(c.agentDid).toBe(AGENT);
			expect(c.version).toBe(1);
			expect(c.shardIndex).toBe(0);
			expect(c.offset).toBeGreaterThanOrEqual(0);
			expect(c.length).toBeGreaterThan(0);
			expect(c.offset + c.length).toBeLessThanOrEqual(1024);
			expect(c.issuedAt).toBeGreaterThan(0);
			expect(c.deadline).toBeGreaterThan(c.issuedAt);
		});

		it("generates unique challenge IDs", () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				ids.add(generateChallenge(SHARD_INFO).id);
			}
			expect(ids.size).toBe(100);
		});

		it("respects maxChallengeLength", () => {
			const c = generateChallenge(SHARD_INFO, {
				maxChallengeLength: 10,
			});
			expect(c.length).toBeLessThanOrEqual(10);
		});

		it("respects deadlineMs", () => {
			const before = Date.now();
			const c = generateChallenge(SHARD_INFO, {
				deadlineMs: 5000,
			});
			expect(c.deadline - c.issuedAt).toBeLessThanOrEqual(5001);
			expect(c.deadline).toBeGreaterThanOrEqual(before + 4999);
		});

		it("handles shard of size 1", () => {
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 1,
			});
			expect(c.offset).toBe(0);
			expect(c.length).toBe(1);
		});

		it("throws for empty shard", () => {
			expect(() =>
				generateChallenge({ ...SHARD_INFO, shardSize: 0 }),
			).toThrow("empty shard");
		});

		it("byte range always within shard bounds", () => {
			for (let i = 0; i < 200; i++) {
				const size = 1 + (i % 50);
				const c = generateChallenge({
					...SHARD_INFO,
					shardSize: size,
				});
				expect(c.offset).toBeGreaterThanOrEqual(0);
				expect(c.length).toBeGreaterThan(0);
				expect(c.offset + c.length).toBeLessThanOrEqual(size);
			}
		});
	});

	// ── respondToChallenge ───────────────────────────────────────────

	describe("respondToChallenge", () => {
		it("produces correct Blake3 hash of byte range", () => {
			const data = shard(1024);
			const c: Challenge = {
				id: "test-challenge",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 10,
				length: 50,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};

			const response = respondToChallenge(c, data);
			const expected = bytesToHex(blake3(data.subarray(10, 60)));

			expect(response.hash).toBe(expected);
			expect(response.challengeId).toBe("test-challenge");
			expect(response.respondedAt).toBeGreaterThan(0);
		});

		it("hashes from start of shard (offset 0)", () => {
			const data = shard(100);
			const c: Challenge = {
				id: "c1",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 0,
				length: 10,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};

			const response = respondToChallenge(c, data);
			expect(response.hash).toBe(
				bytesToHex(blake3(data.subarray(0, 10))),
			);
		});

		it("hashes to end of shard", () => {
			const data = shard(100);
			const c: Challenge = {
				id: "c2",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 90,
				length: 10,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};

			const response = respondToChallenge(c, data);
			expect(response.hash).toBe(
				bytesToHex(blake3(data.subarray(90, 100))),
			);
		});

		it("hashes entire shard", () => {
			const data = shard(50);
			const c: Challenge = {
				id: "c3",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 0,
				length: 50,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};

			const response = respondToChallenge(c, data);
			expect(response.hash).toBe(bytesToHex(blake3(data)));
		});

		it("throws if byte range exceeds shard size", () => {
			const data = shard(50);
			const c: Challenge = {
				id: "c4",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 40,
				length: 20,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};

			expect(() => respondToChallenge(c, data)).toThrow(
				"exceeds shard size",
			);
		});
	});

	// ── verifyResponse ───────────────────────────────────────────────

	describe("verifyResponse", () => {
		it("accepts a valid response", () => {
			const data = shard(256);
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 256,
			});
			const response = respondToChallenge(c, data);
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(true);
		});

		it("rejects wrong hash", () => {
			const data = shard(256);
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 256,
			});
			const response: ChallengeResponse = {
				challengeId: c.id,
				hash: "00".repeat(32),
				respondedAt: Date.now(),
			};
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("Hash mismatch");
		});

		it("rejects mismatched challenge ID", () => {
			const data = shard(256);
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 256,
			});
			const response = respondToChallenge(c, data);
			response.challengeId = "wrong-id";
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("Challenge ID mismatch");
		});

		it("rejects response after deadline", () => {
			const data = shard(256);
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 256,
			});
			const response = respondToChallenge(c, data);
			response.respondedAt = c.deadline + 1;
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("deadline");
		});

		it("rejects if verifier shard is too small", () => {
			const data = shard(256);
			const c: Challenge = {
				id: "test",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 200,
				length: 100,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};
			const response: ChallengeResponse = {
				challengeId: "test",
				hash: "ab".repeat(32),
				respondedAt: Date.now(),
			};
			// Verifier only has 100 bytes
			const result = verifyResponse(
				c,
				response,
				data.subarray(0, 100),
			);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("exceeds shard size");
		});

		it("full cycle: generate -> respond -> verify", () => {
			const data = shard(4096);
			for (let i = 0; i < 20; i++) {
				const c = generateChallenge({
					...SHARD_INFO,
					shardSize: data.length,
				});
				const response = respondToChallenge(c, data);
				const result = verifyResponse(c, response, data);
				expect(result.valid).toBe(true);
			}
		});
	});

	// ── ReputationTracker ────────────────────────────────────────────

	describe("ReputationTracker", () => {
		it("new node has score 1.0", () => {
			const tracker = new ReputationTracker();
			const rep = tracker.getReputation(NODE_A);
			expect(rep.score).toBe(1.0);
			expect(rep.totalChallenges).toBe(0);
		});

		it("score stays high with all passes", () => {
			const tracker = new ReputationTracker();
			for (let i = 0; i < 10; i++) {
				tracker.recordResult(NODE_A, true);
			}
			const rep = tracker.getReputation(NODE_A);
			expect(rep.passed).toBe(10);
			expect(rep.failed).toBe(0);
			expect(rep.score).toBe(1.0);
		});

		it("score decreases on failure", () => {
			const tracker = new ReputationTracker();
			tracker.recordResult(NODE_A, true);
			tracker.recordResult(NODE_A, true);
			const before = tracker.getReputation(NODE_A).score;

			tracker.recordResult(NODE_A, false);
			const after = tracker.getReputation(NODE_A).score;

			expect(after).toBeLessThan(before);
		});

		it("multiple failures severely reduce score", () => {
			const tracker = new ReputationTracker();
			for (let i = 0; i < 5; i++) {
				tracker.recordResult(NODE_A, false);
			}
			const rep = tracker.getReputation(NODE_A);
			expect(rep.score).toBeLessThan(0.5);
		});

		it("tracks nodes independently", () => {
			const tracker = new ReputationTracker();
			tracker.recordResult(NODE_A, true);
			tracker.recordResult(NODE_A, true);
			tracker.recordResult(NODE_B, false);
			tracker.recordResult(NODE_B, false);

			expect(
				tracker.getReputation(NODE_A).score,
			).toBeGreaterThan(tracker.getReputation(NODE_B).score);
		});

		it("tracks challenge counts correctly", () => {
			const tracker = new ReputationTracker();
			tracker.recordResult(NODE_A, true);
			tracker.recordResult(NODE_A, false);
			tracker.recordResult(NODE_A, true);

			const rep = tracker.getReputation(NODE_A);
			expect(rep.totalChallenges).toBe(3);
			expect(rep.passed).toBe(2);
			expect(rep.failed).toBe(1);
		});

		it("updates lastChallengeAt timestamp", () => {
			const tracker = new ReputationTracker();
			const before = Date.now();
			tracker.recordResult(NODE_A, true);
			const rep = tracker.getReputation(NODE_A);
			expect(rep.lastChallengeAt).toBeGreaterThanOrEqual(before);
		});

		it("getAllReputations returns all tracked nodes", () => {
			const tracker = new ReputationTracker();
			tracker.recordResult(NODE_A, true);
			tracker.recordResult(NODE_B, false);
			const all = tracker.getAllReputations();
			expect(all.length).toBe(2);
		});

		it("score is bounded between 0 and 1", () => {
			const tracker = new ReputationTracker();
			for (let i = 0; i < 100; i++) {
				tracker.recordResult(NODE_A, false);
			}
			const rep = tracker.getReputation(NODE_A);
			expect(rep.score).toBeGreaterThanOrEqual(0);
			expect(rep.score).toBeLessThanOrEqual(1);
		});
	});

	// ── ChallengeScheduler ───────────────────────────────────────────

	describe("ChallengeScheduler", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("generateRound produces challenges for all shards", () => {
			const shards: ChallengableShard[] = [
				{
					nodeDid: NODE_A,
					agentDid: AGENT,
					version: 1,
					shardIndex: 0,
					shardSize: 100,
				},
				{
					nodeDid: NODE_A,
					agentDid: AGENT,
					version: 1,
					shardIndex: 1,
					shardSize: 100,
				},
				{
					nodeDid: NODE_B,
					agentDid: AGENT,
					version: 1,
					shardIndex: 2,
					shardSize: 100,
				},
			];

			const received: Challenge[] = [];
			const scheduler = new ChallengeScheduler(
				() => shards,
				(c) => received.push(c),
			);

			const challenges = scheduler.generateRound();
			expect(challenges.length).toBe(3);
			expect(received.length).toBe(3);
			expect(challenges[0]!.shardIndex).toBe(0);
			expect(challenges[1]!.shardIndex).toBe(1);
			expect(challenges[2]!.shardIndex).toBe(2);
		});

		it("skips empty shards", () => {
			const shards: ChallengableShard[] = [
				{
					nodeDid: NODE_A,
					agentDid: AGENT,
					version: 1,
					shardIndex: 0,
					shardSize: 100,
				},
				{
					nodeDid: NODE_A,
					agentDid: AGENT,
					version: 1,
					shardIndex: 1,
					shardSize: 0,
				},
			];

			const scheduler = new ChallengeScheduler(
				() => shards,
				() => {},
			);

			const challenges = scheduler.generateRound();
			expect(challenges.length).toBe(1);
		});

		it("start/stop lifecycle", () => {
			const scheduler = new ChallengeScheduler(
				() => [],
				() => {},
				{ intervalMs: 1000 },
			);

			expect(scheduler.isRunning()).toBe(false);
			scheduler.start();
			expect(scheduler.isRunning()).toBe(true);
			scheduler.stop();
			expect(scheduler.isRunning()).toBe(false);
		});

		it("start is idempotent", () => {
			const scheduler = new ChallengeScheduler(
				() => [],
				() => {},
			);
			scheduler.start();
			scheduler.start(); // Should not throw or create duplicate timers
			expect(scheduler.isRunning()).toBe(true);
			scheduler.stop();
		});

		it("scheduler fires at interval", () => {
			vi.useFakeTimers();

			let roundCount = 0;
			const scheduler = new ChallengeScheduler(
				() => [
					{
						nodeDid: NODE_A,
						agentDid: AGENT,
						version: 1,
						shardIndex: 0,
						shardSize: 100,
					},
				],
				() => {
					roundCount++;
				},
				{ intervalMs: 100 },
			);

			scheduler.start();
			expect(roundCount).toBe(0);

			vi.advanceTimersByTime(100);
			expect(roundCount).toBe(1);

			vi.advanceTimersByTime(100);
			expect(roundCount).toBe(2);

			vi.advanceTimersByTime(100);
			expect(roundCount).toBe(3);

			scheduler.stop();
			vi.advanceTimersByTime(200);
			expect(roundCount).toBe(3); // No more after stop
		});
	});

	// ── Edge cases ───────────────────────────────────────────────────

	describe("edge cases", () => {
		it("challenge for 1-byte shard", () => {
			const data = new Uint8Array([42]);
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 1,
			});
			expect(c.offset).toBe(0);
			expect(c.length).toBe(1);

			const response = respondToChallenge(c, data);
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(true);
		});

		it("challenge response with all-zero data", () => {
			const data = new Uint8Array(100);
			const c = generateChallenge({
				...SHARD_INFO,
				shardSize: 100,
			});
			const response = respondToChallenge(c, data);
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(true);
		});

		it("challenge at exact end of shard", () => {
			const data = shard(100);
			const c: Challenge = {
				id: "end-test",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 99,
				length: 1,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};
			const response = respondToChallenge(c, data);
			expect(response.hash).toBe(
				bytesToHex(blake3(data.subarray(99, 100))),
			);
			const result = verifyResponse(c, response, data);
			expect(result.valid).toBe(true);
		});

		it("different byte ranges produce different hashes", () => {
			const data = shard(256);
			const c1: Challenge = {
				id: "c1",
				nodeDid: NODE_A,
				agentDid: AGENT,
				version: 1,
				shardIndex: 0,
				offset: 0,
				length: 32,
				issuedAt: Date.now(),
				deadline: Date.now() + 30000,
			};
			const c2: Challenge = {
				...c1,
				id: "c2",
				offset: 32,
			};

			const r1 = respondToChallenge(c1, data);
			const r2 = respondToChallenge(c2, data);
			expect(r1.hash).not.toBe(r2.hash);
		});

		it("reputation recovery after failures and passes", () => {
			const tracker = new ReputationTracker();
			// Start with failures
			tracker.recordResult(NODE_A, false);
			tracker.recordResult(NODE_A, false);
			const low = tracker.getReputation(NODE_A).score;

			// Recover with passes
			for (let i = 0; i < 20; i++) {
				tracker.recordResult(NODE_A, true);
			}
			const recovered = tracker.getReputation(NODE_A).score;
			expect(recovered).toBeGreaterThan(low);
		});
	});
});
