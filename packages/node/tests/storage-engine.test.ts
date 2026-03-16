import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryLevel } from "memory-level";
import { StorageEngine, computeShardHash } from "../src/storage/index.js";
import type {
	StorageEngineConfig,
	ShardKey,
} from "../src/storage/index.js";

function createDb(): MemoryLevel<string, string> {
	return new MemoryLevel<string, string>({ valueEncoding: "utf8" });
}

function shard(size: number, fill = 0xab): Uint8Array {
	const data = new Uint8Array(size);
	data.fill(fill);
	return data;
}

const AGENT_A = "did:key:z6MkAgent_A_PublicKey";
const AGENT_B = "did:key:z6MkAgent_B_PublicKey";

let db: MemoryLevel<string, string>;
let engine: StorageEngine;

beforeEach(async () => {
	db = createDb();
	engine = new StorageEngine(db);
	await engine.init();
});

afterEach(async () => {
	await engine.close();
});

describe("StorageEngine", () => {
	// ── Store ────────────────────────────────────────────────────────

	describe("store", () => {
		it("stores a shard and returns metadata", async () => {
			const meta = await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(1024),
			});

			expect(meta.agentDid).toBe(AGENT_A);
			expect(meta.version).toBe(1);
			expect(meta.shardIndex).toBe(0);
			expect(meta.size).toBe(1024);
			expect(meta.hash).toBeTruthy();
			expect(meta.storedAt).toBeGreaterThan(0);
			expect(meta.expiresAt).toBeUndefined();
		});

		it("stores shard with TTL", async () => {
			const meta = await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
				ttlMs: 60_000,
			});

			expect(meta.expiresAt).toBeDefined();
			expect(meta.expiresAt!).toBeGreaterThan(Date.now());
		});

		it("rejects empty shard data", async () => {
			await expect(
				engine.store({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
					data: new Uint8Array(0),
				}),
			).rejects.toThrow("must not be empty");
		});

		it("computes correct Blake3 hash", async () => {
			const data = shard(256);
			const expectedHash = computeShardHash(data);

			const meta = await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data,
			});

			expect(meta.hash).toBe(expectedHash);
		});

		it("overwrites existing shard at same key", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});

			const meta2 = await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(200, 0xcd),
			});

			expect(meta2.size).toBe(200);

			const result = await engine.retrieve({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			});
			expect(result.data).toEqual(shard(200, 0xcd));
		});

		it("stores multiple shards for same agent/version", async () => {
			for (let i = 0; i < 4; i++) {
				await engine.store({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: i,
					data: shard(100, i),
				});
			}

			const shards = await engine.listShards(AGENT_A, 1);
			expect(shards.length).toBe(4);
		});
	});

	// ── Retrieve ─────────────────────────────────────────────────────

	describe("retrieve", () => {
		it("retrieves stored shard data", async () => {
			const data = shard(512);
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data,
			});

			const result = await engine.retrieve({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			});

			expect(result.data).toEqual(data);
			expect(result.metadata.hash).toBe(computeShardHash(data));
		});

		it("throws for non-existent shard", async () => {
			await expect(
				engine.retrieve({
					agentDid: AGENT_A,
					version: 99,
					shardIndex: 0,
				}),
			).rejects.toThrow("not found");
		});

		it("verifies integrity on retrieval", async () => {
			const data = shard(100);
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data,
			});

			// Corrupt the stored data directly in LevelDB
			const ver = "000000000001";
			const idx = "000000";
			const dataKey = `shard:${AGENT_A}:${ver}:${idx}`;

			// Read current hex, flip a character
			const currentHex = (await db.get(dataKey))!;
			const corrupted =
				"ff" + currentHex.slice(2); // replace first byte
			await db.put(dataKey, corrupted);

			await expect(
				engine.retrieve({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).rejects.toThrow("integrity check failed");
		});
	});

	// ── has / delete ─────────────────────────────────────────────────

	describe("has and delete", () => {
		it("has returns true for existing shard", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});

			expect(
				await engine.has({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).toBe(true);
		});

		it("has returns false for non-existent shard", async () => {
			expect(
				await engine.has({
					agentDid: AGENT_A,
					version: 99,
					shardIndex: 0,
				}),
			).toBe(false);
		});

		it("delete removes a shard", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});

			const deleted = await engine.delete({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			});
			expect(deleted).toBe(true);

			expect(
				await engine.has({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).toBe(false);
		});

		it("delete returns false for non-existent shard", async () => {
			const deleted = await engine.delete({
				agentDid: AGENT_A,
				version: 99,
				shardIndex: 0,
			});
			expect(deleted).toBe(false);
		});
	});

	// ── Latest version lookup ────────────────────────────────────────

	describe("getLatestVersion", () => {
		it("returns -1 for unknown agent", async () => {
			expect(await engine.getLatestVersion(AGENT_A)).toBe(-1);
		});

		it("returns the highest stored version", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 3,
				shardIndex: 0,
				data: shard(100),
			});
			await engine.store({
				agentDid: AGENT_A,
				version: 7,
				shardIndex: 0,
				data: shard(100),
			});
			await engine.store({
				agentDid: AGENT_A,
				version: 5,
				shardIndex: 0,
				data: shard(100),
			});

			expect(await engine.getLatestVersion(AGENT_A)).toBe(7);
		});

		it("tracks versions per agent independently", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 10,
				shardIndex: 0,
				data: shard(100),
			});
			await engine.store({
				agentDid: AGENT_B,
				version: 3,
				shardIndex: 0,
				data: shard(100),
			});

			expect(await engine.getLatestVersion(AGENT_A)).toBe(10);
			expect(await engine.getLatestVersion(AGENT_B)).toBe(3);
		});

		it("returns -1 after all shards for agent are deleted", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});

			await engine.delete({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			});

			expect(await engine.getLatestVersion(AGENT_A)).toBe(-1);
		});
	});

	// ── Storage tracking ─────────────────────────────────────────────

	describe("storage tracking", () => {
		it("tracks per-agent storage", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(500),
			});
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 1,
				data: shard(300),
			});

			const stats = engine.getAgentStats(AGENT_A);
			expect(stats.totalBytes).toBe(800);
			expect(stats.shardCount).toBe(2);
			expect(stats.latestVersion).toBe(1);
		});

		it("tracks overall storage", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(500),
			});
			await engine.store({
				agentDid: AGENT_B,
				version: 1,
				shardIndex: 0,
				data: shard(300),
			});

			const stats = engine.getStats();
			expect(stats.totalBytes).toBe(800);
			expect(stats.totalShards).toBe(2);
			expect(stats.agentCount).toBe(2);
		});

		it("decrements stats on delete", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(500),
			});

			await engine.delete({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			});

			const stats = engine.getStats();
			expect(stats.totalBytes).toBe(0);
			expect(stats.totalShards).toBe(0);
			expect(stats.agentCount).toBe(0);
		});

		it("updates stats on overwrite (not double-count)", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(500),
			});

			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(200),
			});

			const stats = engine.getAgentStats(AGENT_A);
			expect(stats.totalBytes).toBe(200);
			expect(stats.shardCount).toBe(1);
		});

		it("returns zero stats for unknown agent", () => {
			const stats = engine.getAgentStats("did:key:unknown");
			expect(stats.totalBytes).toBe(0);
			expect(stats.shardCount).toBe(0);
			expect(stats.latestVersion).toBe(-1);
		});
	});

	// ── Max storage limit enforcement ────────────────────────────────

	describe("max storage limit", () => {
		it("rejects store when limit would be exceeded", async () => {
			const limitedEngine = new StorageEngine(createDb(), {
				maxStorageBytes: 1000,
			});
			await limitedEngine.init();

			await limitedEngine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(800),
			});

			await expect(
				limitedEngine.store({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 1,
					data: shard(300),
				}),
			).rejects.toThrow("Storage limit exceeded");

			await limitedEngine.close();
		});

		it("allows store up to exact limit", async () => {
			const limitedEngine = new StorageEngine(createDb(), {
				maxStorageBytes: 1000,
			});
			await limitedEngine.init();

			await limitedEngine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(1000),
			});

			expect(limitedEngine.getStats().totalBytes).toBe(1000);
			await limitedEngine.close();
		});

		it("allows store after freeing space via delete", async () => {
			const limitedEngine = new StorageEngine(createDb(), {
				maxStorageBytes: 1000,
			});
			await limitedEngine.init();

			await limitedEngine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(800),
			});

			await limitedEngine.delete({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			});

			// Now there's room again
			await limitedEngine.store({
				agentDid: AGENT_A,
				version: 2,
				shardIndex: 0,
				data: shard(800),
			});

			expect(limitedEngine.getStats().totalBytes).toBe(800);
			await limitedEngine.close();
		});

		it("unlimited storage when maxStorageBytes is 0", async () => {
			// Default config has maxStorageBytes: 0
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100_000),
			});

			expect(engine.getStats().totalBytes).toBe(100_000);
		});
	});

	// ── TTL expiration ───────────────────────────────────────────────

	describe("TTL expiration", () => {
		it("retrieve rejects expired shard", async () => {
			// Store with a very short TTL
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
				ttlMs: 1, // 1ms TTL
			});

			// Wait for expiration
			await new Promise((r) => setTimeout(r, 10));

			await expect(
				engine.retrieve({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).rejects.toThrow("expired");
		});

		it("has returns false for expired shard", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
				ttlMs: 1,
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(
				await engine.has({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).toBe(false);
		});

		it("cleanExpired removes expired shards", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
				ttlMs: 1,
			});
			await engine.store({
				agentDid: AGENT_A,
				version: 2,
				shardIndex: 0,
				data: shard(200),
				// No TTL — should survive
			});

			await new Promise((r) => setTimeout(r, 10));

			const removed = await engine.cleanExpired();
			expect(removed).toBe(1);

			expect(engine.getStats().totalShards).toBe(1);
			expect(engine.getStats().totalBytes).toBe(200);
		});

		it("non-expired shards are unaffected by cleanup", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
				ttlMs: 60_000, // 1 minute — not expired
			});

			const removed = await engine.cleanExpired();
			expect(removed).toBe(0);

			expect(
				await engine.has({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).toBe(true);
		});

		it("expired shards update stats when cleaned", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(500),
				ttlMs: 1,
			});

			expect(engine.getStats().totalBytes).toBe(500);

			await new Promise((r) => setTimeout(r, 10));
			await engine.cleanExpired();

			expect(engine.getStats().totalBytes).toBe(0);
			expect(engine.getStats().totalShards).toBe(0);
		});
	});

	// ── Concurrent read/write ────────────────────────────────────────

	describe("concurrent operations", () => {
		it("handles concurrent stores from different agents", async () => {
			const promises = Array.from({ length: 10 }, (_, i) =>
				engine.store({
					agentDid: `did:key:agent${i}`,
					version: 1,
					shardIndex: 0,
					data: shard(100, i),
				}),
			);

			await Promise.all(promises);

			expect(engine.getStats().totalShards).toBe(10);
			expect(engine.getStats().totalBytes).toBe(1000);
			expect(engine.getStats().agentCount).toBe(10);
		});

		it("handles concurrent reads", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(256),
			});

			const key: ShardKey = {
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
			};

			const results = await Promise.all(
				Array.from({ length: 10 }, () => engine.retrieve(key)),
			);

			for (const result of results) {
				expect(result.data).toEqual(shard(256));
			}
		});

		it("handles interleaved store and retrieve", async () => {
			const ops: Promise<unknown>[] = [];

			for (let i = 0; i < 5; i++) {
				ops.push(
					engine.store({
						agentDid: AGENT_A,
						version: i + 1,
						shardIndex: 0,
						data: shard(100, i),
					}),
				);
			}

			await Promise.all(ops);

			// Now read them all back
			const reads = Array.from({ length: 5 }, (_, i) =>
				engine.retrieve({
					agentDid: AGENT_A,
					version: i + 1,
					shardIndex: 0,
				}),
			);

			const results = await Promise.all(reads);
			for (let i = 0; i < 5; i++) {
				expect(results[i]!.data).toEqual(shard(100, i));
			}
		});
	});

	// ── Corrupt shard rejection ──────────────────────────────────────

	describe("corrupt shard rejection", () => {
		it("detects corrupted data on retrieval", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});

			// Corrupt data in LevelDB
			const ver = "000000000001";
			const idx = "000000";
			await db.put(
				`shard:${AGENT_A}:${ver}:${idx}`,
				"00".repeat(100), // zeros instead of 0xab
			);

			await expect(
				engine.retrieve({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).rejects.toThrow("integrity check failed");
		});

		it("detects truncated data on retrieval", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});

			// Truncate stored data
			const ver = "000000000001";
			const idx = "000000";
			const currentHex = (await db.get(
				`shard:${AGENT_A}:${ver}:${idx}`,
			))!;
			await db.put(
				`shard:${AGENT_A}:${ver}:${idx}`,
				currentHex.slice(0, 20),
			);

			await expect(
				engine.retrieve({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: 0,
				}),
			).rejects.toThrow("integrity check failed");
		});
	});

	// ── computeShardHash ─────────────────────────────────────────────

	describe("computeShardHash", () => {
		it("returns consistent hash for same data", () => {
			const data = shard(256);
			expect(computeShardHash(data)).toBe(computeShardHash(data));
		});

		it("returns different hashes for different data", () => {
			expect(computeShardHash(shard(100, 0x01))).not.toBe(
				computeShardHash(shard(100, 0x02)),
			);
		});

		it("returns a 64-char hex string (32 bytes)", () => {
			const hash = computeShardHash(shard(50));
			expect(hash.length).toBe(64);
			expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
		});
	});

	// ── listShards ───────────────────────────────────────────────────

	describe("listShards", () => {
		it("lists all shards for an agent/version", async () => {
			for (let i = 0; i < 4; i++) {
				await engine.store({
					agentDid: AGENT_A,
					version: 1,
					shardIndex: i,
					data: shard(100, i),
				});
			}

			const shards = await engine.listShards(AGENT_A, 1);
			expect(shards.length).toBe(4);
			expect(shards.map((s) => s.shardIndex).sort()).toEqual([
				0, 1, 2, 3,
			]);
		});

		it("returns empty array for non-existent agent/version", async () => {
			const shards = await engine.listShards(AGENT_A, 99);
			expect(shards.length).toBe(0);
		});

		it("does not include shards from other versions", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(100),
			});
			await engine.store({
				agentDid: AGENT_A,
				version: 2,
				shardIndex: 0,
				data: shard(100),
			});

			const shards = await engine.listShards(AGENT_A, 1);
			expect(shards.length).toBe(1);
			expect(shards[0]!.version).toBe(1);
		});
	});

	// ── Rebuild stats on init ────────────────────────────────────────

	describe("init (rebuild stats)", () => {
		it("rebuilds stats from existing data", async () => {
			await engine.store({
				agentDid: AGENT_A,
				version: 1,
				shardIndex: 0,
				data: shard(500),
			});
			await engine.store({
				agentDid: AGENT_B,
				version: 1,
				shardIndex: 0,
				data: shard(300),
			});

			// Create a new engine on the same db
			const engine2 = new StorageEngine(db);
			await engine2.init();

			const stats = engine2.getStats();
			expect(stats.totalBytes).toBe(800);
			expect(stats.totalShards).toBe(2);
			expect(stats.agentCount).toBe(2);

			// Don't close engine2 — it shares db with engine, which will close it
		});
	});
});
