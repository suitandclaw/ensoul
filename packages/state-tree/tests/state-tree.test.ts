import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	createTree,
	loadTree,
	EMPTY_HASH,
	computeLeafHash,
	buildMerkleTree,
	verifyMerkleProof,
} from "../src/index.js";
import type { ConsciousnessTree, StateTransition } from "../src/index.js";

let identity: AgentIdentity;
let tree: ConsciousnessTree;

beforeEach(async () => {
	identity = await createIdentity({
		seed: new Uint8Array(32).fill(42),
	});
	tree = await createTree(identity);
});

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("@ensoul/state-tree", () => {
	// ── Creation ─────────────────────────────────────────────────────

	describe("createTree", () => {
		it("creates an empty tree at version 0", () => {
			expect(tree.version).toBe(0);
			expect(tree.rootHash).toBe(EMPTY_HASH);
		});

		it("empty tree root hash is deterministic", async () => {
			const tree2 = await createTree(identity);
			expect(tree2.rootHash).toBe(tree.rootHash);
		});
	});

	// ── set / get ────────────────────────────────────────────────────

	describe("set and get", () => {
		it("stores a value and retrieves it", async () => {
			await tree.set("soul/name", encode("Agent-42"));
			const value = await tree.get("soul/name");
			expect(value).toEqual(encode("Agent-42"));
		});

		it("returns null for non-existent key", async () => {
			const value = await tree.get("nonexistent");
			expect(value).toBeNull();
		});

		it("changes root hash on set", async () => {
			const before = tree.rootHash;
			await tree.set("key", encode("value"));
			expect(tree.rootHash).not.toBe(before);
		});

		it("increments version on set", async () => {
			expect(tree.version).toBe(0);
			await tree.set("a", encode("1"));
			expect(tree.version).toBe(1);
			await tree.set("b", encode("2"));
			expect(tree.version).toBe(2);
		});

		it("overwrites existing key", async () => {
			await tree.set("key", encode("v1"));
			await tree.set("key", encode("v2"));
			const value = await tree.get("key");
			expect(value).toEqual(encode("v2"));
		});

		it("root hash is deterministic for same data", async () => {
			const tree1 = await createTree(identity);
			await tree1.set("a", encode("1"));
			await tree1.set("b", encode("2"));

			const tree2 = await createTree(identity);
			await tree2.set("a", encode("1"));
			await tree2.set("b", encode("2"));

			expect(tree1.rootHash).toBe(tree2.rootHash);
		});

		it("different data produces different root hashes", async () => {
			const tree1 = await createTree(identity);
			await tree1.set("a", encode("1"));

			const tree2 = await createTree(identity);
			await tree2.set("a", encode("2"));

			expect(tree1.rootHash).not.toBe(tree2.rootHash);
		});
	});

	// ── delete ───────────────────────────────────────────────────────

	describe("delete", () => {
		it("removes an existing key", async () => {
			await tree.set("key", encode("value"));
			await tree.delete("key");
			const value = await tree.get("key");
			expect(value).toBeNull();
		});

		it("changes root hash on delete", async () => {
			await tree.set("key", encode("value"));
			const hashWithKey = tree.rootHash;
			await tree.delete("key");
			expect(tree.rootHash).not.toBe(hashWithKey);
		});

		it("deleting last key returns to empty hash", async () => {
			await tree.set("key", encode("value"));
			await tree.delete("key");
			expect(tree.rootHash).toBe(EMPTY_HASH);
		});

		it("increments version on delete", async () => {
			await tree.set("key", encode("value"));
			expect(tree.version).toBe(1);
			await tree.delete("key");
			expect(tree.version).toBe(2);
		});
	});

	// ── batch ────────────────────────────────────────────────────────

	describe("batch", () => {
		it("applies multiple operations atomically", async () => {
			await tree.batch([
				{ op: "set", key: "a", value: encode("1") },
				{ op: "set", key: "b", value: encode("2") },
				{ op: "set", key: "c", value: encode("3") },
			]);

			expect(tree.version).toBe(1);
			expect(await tree.get("a")).toEqual(encode("1"));
			expect(await tree.get("b")).toEqual(encode("2"));
			expect(await tree.get("c")).toEqual(encode("3"));
		});

		it("produces single root for batch vs sequential", async () => {
			const tree1 = await createTree(identity);
			await tree1.batch([
				{ op: "set", key: "a", value: encode("1") },
				{ op: "set", key: "b", value: encode("2") },
			]);

			const tree2 = await createTree(identity);
			await tree2.set("a", encode("1"));
			await tree2.set("b", encode("2"));

			// Same root hash for same final state
			expect(tree1.rootHash).toBe(tree2.rootHash);
			// But batch uses one version, sequential uses two
			expect(tree1.version).toBe(1);
			expect(tree2.version).toBe(2);
		});

		it("handles mixed set and delete operations", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));

			await tree.batch([
				{ op: "delete", key: "a" },
				{ op: "set", key: "c", value: encode("3") },
			]);

			expect(await tree.get("a")).toBeNull();
			expect(await tree.get("b")).toEqual(encode("2"));
			expect(await tree.get("c")).toEqual(encode("3"));
		});
	});

	// ── Merkle proofs ────────────────────────────────────────────────

	describe("getWithProof and verifyProof", () => {
		it("generates a valid proof for an existing key", async () => {
			await tree.set("key", encode("value"));
			const { value, proof } = await tree.getWithProof("key");

			expect(value).toEqual(encode("value"));
			expect(proof.leafHash).toBeTruthy();

			const valid = tree.verifyProof(
				"key",
				encode("value"),
				proof,
				tree.rootHash,
			);
			expect(valid).toBe(true);
		});

		it("proof is invalid against wrong root hash", async () => {
			await tree.set("key", encode("value"));
			const { proof } = await tree.getWithProof("key");

			const valid = tree.verifyProof(
				"key",
				encode("value"),
				proof,
				"0000000000000000000000000000000000000000000000000000000000000000",
			);
			expect(valid).toBe(false);
		});

		it("proof is invalid for wrong value", async () => {
			await tree.set("key", encode("value"));
			const { proof } = await tree.getWithProof("key");

			const valid = tree.verifyProof(
				"key",
				encode("wrong"),
				proof,
				tree.rootHash,
			);
			expect(valid).toBe(false);
		});

		it("proof is invalid for wrong key", async () => {
			await tree.set("key", encode("value"));
			const { proof } = await tree.getWithProof("key");

			const valid = tree.verifyProof(
				"wrong-key",
				encode("value"),
				proof,
				tree.rootHash,
			);
			expect(valid).toBe(false);
		});

		it("returns empty proof for non-existent key", async () => {
			const { value, proof } =
				await tree.getWithProof("nonexistent");
			expect(value).toBeNull();
			expect(proof.siblings).toEqual([]);
			expect(proof.leafHash).toBe("");
		});

		it("verifyProof accepts null value with empty proof", async () => {
			const valid = tree.verifyProof(
				"nonexistent",
				null,
				{ siblings: [], leafHash: "" },
				tree.rootHash,
			);
			expect(valid).toBe(true);
		});

		it("proof works with multiple entries", async () => {
			await tree.batch([
				{ op: "set", key: "a", value: encode("1") },
				{ op: "set", key: "b", value: encode("2") },
				{ op: "set", key: "c", value: encode("3") },
				{ op: "set", key: "d", value: encode("4") },
				{ op: "set", key: "e", value: encode("5") },
			]);

			// Verify proof for each key
			for (const [key, val] of [
				["a", "1"],
				["b", "2"],
				["c", "3"],
				["d", "4"],
				["e", "5"],
			] as const) {
				const { value, proof } = await tree.getWithProof(key);
				expect(value).toEqual(encode(val));
				const valid = tree.verifyProof(
					key,
					encode(val),
					proof,
					tree.rootHash,
				);
				expect(valid).toBe(true);
			}
		});

		it("proof for single entry has no siblings", async () => {
			await tree.set("only", encode("one"));
			const { proof } = await tree.getWithProof("only");
			expect(proof.siblings).toEqual([]);
			expect(proof.leafHash).toBeTruthy();

			const valid = tree.verifyProof(
				"only",
				encode("one"),
				proof,
				tree.rootHash,
			);
			expect(valid).toBe(true);
		});
	});

	// ── Merkle tree internals ────────────────────────────────────────

	describe("Merkle tree internals", () => {
		it("computeLeafHash is deterministic", () => {
			const h1 = computeLeafHash("key", encode("value"));
			const h2 = computeLeafHash("key", encode("value"));
			expect(h1).toEqual(h2);
		});

		it("different keys produce different hashes", () => {
			const h1 = computeLeafHash("key1", encode("value"));
			const h2 = computeLeafHash("key2", encode("value"));
			expect(h1).not.toEqual(h2);
		});

		it("different values produce different hashes", () => {
			const h1 = computeLeafHash("key", encode("v1"));
			const h2 = computeLeafHash("key", encode("v2"));
			expect(h1).not.toEqual(h2);
		});

		it("buildMerkleTree returns EMPTY_HASH for empty map", () => {
			const result = buildMerkleTree(new Map());
			expect(result.root).toBe(EMPTY_HASH);
			expect(result.layers).toEqual([]);
			expect(result.sortedKeys).toEqual([]);
		});

		it("buildMerkleTree sorts keys", () => {
			const entries = new Map<string, Uint8Array>();
			entries.set("c", encode("3"));
			entries.set("a", encode("1"));
			entries.set("b", encode("2"));
			const result = buildMerkleTree(entries);
			expect(result.sortedKeys).toEqual(["a", "b", "c"]);
		});

		it("verifyMerkleProof rejects tampered sibling", async () => {
			await tree.batch([
				{ op: "set", key: "a", value: encode("1") },
				{ op: "set", key: "b", value: encode("2") },
			]);

			const { proof } = await tree.getWithProof("a");
			// Tamper with sibling hash
			if (proof.siblings.length > 0) {
				proof.siblings[0]!.hash =
					"0000000000000000000000000000000000000000000000000000000000000000";
			}

			const valid = verifyMerkleProof(
				"a",
				encode("1"),
				proof,
				tree.rootHash,
			);
			expect(valid).toBe(false);
		});
	});

	// ── Version history ──────────────────────────────────────────────

	describe("getVersion", () => {
		it("retrieves tree state at version 0 (empty)", async () => {
			await tree.set("key", encode("value"));

			const v0 = await tree.getVersion(0);
			expect(v0.version).toBe(0);
			expect(v0.rootHash).toBe(EMPTY_HASH);
			expect(await v0.get("key")).toBeNull();
		});

		it("retrieves tree state at intermediate version", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));
			await tree.set("c", encode("3"));

			const v1 = await tree.getVersion(1);
			expect(v1.version).toBe(1);
			expect(await v1.get("a")).toEqual(encode("1"));
			expect(await v1.get("b")).toBeNull();
			expect(await v1.get("c")).toBeNull();
		});

		it("retrieves tree state at current version", async () => {
			await tree.set("key", encode("value"));

			const v1 = await tree.getVersion(1);
			expect(v1.version).toBe(1);
			expect(v1.rootHash).toBe(tree.rootHash);
			expect(await v1.get("key")).toEqual(encode("value"));
		});

		it("throws for out-of-range version", async () => {
			await expect(tree.getVersion(-1)).rejects.toThrow("out of range");
			await expect(tree.getVersion(5)).rejects.toThrow("out of range");
		});

		it("version snapshot preserves overwritten values", async () => {
			await tree.set("key", encode("v1"));
			await tree.set("key", encode("v2"));

			const snap1 = await tree.getVersion(1);
			expect(await snap1.get("key")).toEqual(encode("v1"));

			const snap2 = await tree.getVersion(2);
			expect(await snap2.get("key")).toEqual(encode("v2"));
		});

		it("version snapshot preserves deleted keys", async () => {
			await tree.set("key", encode("value"));
			await tree.delete("key");

			const snap1 = await tree.getVersion(1);
			expect(await snap1.get("key")).toEqual(encode("value"));

			const snap2 = await tree.getVersion(2);
			expect(await snap2.get("key")).toBeNull();
		});
	});

	describe("getHistory", () => {
		it("returns transitions in the requested range", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));
			await tree.set("c", encode("3"));

			const history = await tree.getHistory(0, 3);
			expect(history.length).toBe(3);
			expect(history[0]!.version).toBe(1);
			expect(history[1]!.version).toBe(2);
			expect(history[2]!.version).toBe(3);
		});

		it("returns empty array for equal from and to", async () => {
			await tree.set("a", encode("1"));
			const history = await tree.getHistory(1, 1);
			expect(history.length).toBe(0);
		});

		it("returns subset of transitions", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));
			await tree.set("c", encode("3"));

			const history = await tree.getHistory(1, 2);
			expect(history.length).toBe(1);
			expect(history[0]!.version).toBe(2);
		});

		it("throws for invalid range", async () => {
			await expect(tree.getHistory(-1, 0)).rejects.toThrow(
				"Invalid version range",
			);
			await expect(tree.getHistory(5, 3)).rejects.toThrow(
				"Invalid version range",
			);
		});
	});

	// ── State transition signing ─────────────────────────────────────

	describe("state transition signing", () => {
		it("every transition has a signature", async () => {
			await tree.set("key", encode("value"));
			const history = await tree.getHistory(0, 1);
			expect(history.length).toBe(1);
			expect(history[0]!.signature).toBeInstanceOf(Uint8Array);
			expect(history[0]!.signature.length).toBe(64);
		});

		it("transition signature is verifiable", async () => {
			await tree.set("key", encode("value"));
			const [transition] = await tree.getHistory(0, 1);
			expect(transition).toBeDefined();

			const t = transition!;
			const message = new TextEncoder().encode(
				JSON.stringify({
					version: t.version,
					rootHash: t.rootHash,
					previousRootHash: t.previousRootHash,
					timestamp: t.timestamp,
					operations: t.operations,
				}),
			);

			const valid = await identity.verify(message, t.signature);
			expect(valid).toBe(true);
		});

		it("transitions form a hash chain", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));
			await tree.set("c", encode("3"));

			const history = await tree.getHistory(0, 3);
			expect(history[0]!.previousRootHash).toBe(EMPTY_HASH);
			expect(history[1]!.previousRootHash).toBe(history[0]!.rootHash);
			expect(history[2]!.previousRootHash).toBe(history[1]!.rootHash);
		});

		it("transition records the operations", async () => {
			await tree.batch([
				{ op: "set", key: "a", value: encode("1") },
				{ op: "delete", key: "b" },
			]);

			const [transition] = await tree.getHistory(0, 1);
			expect(transition).toBeDefined();
			expect(transition!.operations).toEqual([
				{ op: "set", key: "a" },
				{ op: "delete", key: "b" },
			]);
		});

		it("each transition has a timestamp", async () => {
			const before = Date.now();
			await tree.set("key", encode("value"));
			const after = Date.now();

			const [transition] = await tree.getHistory(0, 1);
			expect(transition!.timestamp).toBeGreaterThanOrEqual(before);
			expect(transition!.timestamp).toBeLessThanOrEqual(after);
		});
	});

	// ── Serialization ────────────────────────────────────────────────

	describe("serialize and loadTree", () => {
		it("round-trips an empty tree", async () => {
			const serialized = await tree.serialize();
			expect(serialized).toBeInstanceOf(Uint8Array);

			const loaded = await loadTree(serialized, identity);
			expect(loaded.version).toBe(0);
			expect(loaded.rootHash).toBe(EMPTY_HASH);
		});

		it("round-trips a tree with entries", async () => {
			await tree.set("soul/name", encode("Agent-42"));
			await tree.set("memory/long/fact1", encode("sky is blue"));
			await tree.set("config/model", encode("claude"));

			const serialized = await tree.serialize();
			const loaded = await loadTree(serialized, identity);

			expect(loaded.version).toBe(tree.version);
			expect(loaded.rootHash).toBe(tree.rootHash);
			expect(await loaded.get("soul/name")).toEqual(
				encode("Agent-42"),
			);
			expect(await loaded.get("memory/long/fact1")).toEqual(
				encode("sky is blue"),
			);
			expect(await loaded.get("config/model")).toEqual(
				encode("claude"),
			);
		});

		it("preserves transitions across serialization", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));

			const serialized = await tree.serialize();
			const loaded = await loadTree(serialized, identity);

			const history = await loaded.getHistory(0, 2);
			expect(history.length).toBe(2);
			expect(history[0]!.version).toBe(1);
			expect(history[1]!.version).toBe(2);
		});

		it("loaded tree preserves version history for getVersion", async () => {
			await tree.set("key", encode("v1"));
			await tree.set("key", encode("v2"));

			const serialized = await tree.serialize();
			const loaded = await loadTree(serialized, identity);

			const snap1 = await loaded.getVersion(1);
			expect(await snap1.get("key")).toEqual(encode("v1"));

			const snap2 = await loaded.getVersion(2);
			expect(await snap2.get("key")).toEqual(encode("v2"));
		});

		it("loaded tree can be further mutated", async () => {
			await tree.set("a", encode("1"));

			const serialized = await tree.serialize();
			const loaded = await loadTree(serialized, identity);

			await loaded.set("b", encode("2"));
			expect(loaded.version).toBe(2);
			expect(await loaded.get("a")).toEqual(encode("1"));
			expect(await loaded.get("b")).toEqual(encode("2"));
		});
	});

	describe("serializeDelta", () => {
		it("captures only changed keys", async () => {
			await tree.set("a", encode("1"));
			await tree.set("b", encode("2"));
			// Version is now 2

			await tree.set("c", encode("3"));
			// Version is now 3

			const delta = await tree.serializeDelta(2);
			const parsed = JSON.parse(
				new TextDecoder().decode(delta),
			) as {
				fromVersion: number;
				toVersion: number;
				entries: Array<[string, string | null]>;
				transitions: Array<{ version: number }>;
			};

			expect(parsed.fromVersion).toBe(2);
			expect(parsed.toVersion).toBe(3);
			// Only "c" changed since version 2
			expect(parsed.entries.length).toBe(1);
			expect(parsed.entries[0]![0]).toBe("c");
			expect(parsed.transitions.length).toBe(1);
		});

		it("includes deleted keys as null", async () => {
			await tree.set("a", encode("1"));
			await tree.delete("a");

			const delta = await tree.serializeDelta(0);
			const parsed = JSON.parse(
				new TextDecoder().decode(delta),
			) as {
				entries: Array<[string, string | null]>;
			};

			const entry = parsed.entries.find(([k]) => k === "a");
			expect(entry).toBeDefined();
			expect(entry![1]).toBeNull();
		});

		it("delta from current version is empty", async () => {
			await tree.set("a", encode("1"));

			const delta = await tree.serializeDelta(tree.version);
			const parsed = JSON.parse(
				new TextDecoder().decode(delta),
			) as {
				entries: Array<[string, string | null]>;
				transitions: Array<{ version: number }>;
			};

			expect(parsed.entries.length).toBe(0);
			expect(parsed.transitions.length).toBe(0);
		});

		it("throws for invalid fromVersion", async () => {
			await expect(tree.serializeDelta(-1)).rejects.toThrow(
				"Invalid fromVersion",
			);
			await expect(tree.serializeDelta(5)).rejects.toThrow(
				"Invalid fromVersion",
			);
		});
	});

	// ── LevelDB persistence ──────────────────────────────────────────

	describe("LevelDB persistence", () => {
		it("persists entries across createTree with dbPath", async () => {
			const { mkdtempSync, rmSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const dir = mkdtempSync(join(tmpdir(), "ensoul-test-"));

			try {
				const t1 = await createTree(identity, { dbPath: dir });
				await t1.set("key", encode("value"));
				await t1.close();

				// Reopen from same path
				const { openTree } = await import("../src/index.js");
				const t2 = await openTree(dir, identity);
				expect(await t2.get("key")).toEqual(encode("value"));
				expect(t2.version).toBe(1);
				await t2.close();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// ── Edge cases ───────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles keys with special characters", async () => {
			await tree.set("path/to/key with spaces", encode("val"));
			await tree.set("unicode/日本語", encode("日本"));
			await tree.set("empty/", encode(""));

			expect(await tree.get("path/to/key with spaces")).toEqual(
				encode("val"),
			);
			expect(await tree.get("unicode/日本語")).toEqual(
				encode("日本"),
			);
			expect(await tree.get("empty/")).toEqual(encode(""));
		});

		it("handles empty value", async () => {
			await tree.set("key", new Uint8Array(0));
			const value = await tree.get("key");
			expect(value).toEqual(new Uint8Array(0));
		});

		it("handles large values", async () => {
			const large = new Uint8Array(1024 * 100); // 100KB
			large.fill(0xab);
			await tree.set("large", large);
			expect(await tree.get("large")).toEqual(large);
		});

		it("handles many entries", async () => {
			const ops = Array.from({ length: 100 }, (_, i) => ({
				op: "set" as const,
				key: `key-${String(i).padStart(3, "0")}`,
				value: encode(`value-${i}`),
			}));
			await tree.batch(ops);

			expect(tree.version).toBe(1);
			for (let i = 0; i < 100; i++) {
				const key = `key-${String(i).padStart(3, "0")}`;
				expect(await tree.get(key)).toEqual(encode(`value-${i}`));
			}
		});

		it("proofs work after deletions", async () => {
			await tree.batch([
				{ op: "set", key: "a", value: encode("1") },
				{ op: "set", key: "b", value: encode("2") },
				{ op: "set", key: "c", value: encode("3") },
			]);

			await tree.delete("b");

			const { value, proof } = await tree.getWithProof("a");
			expect(value).toEqual(encode("1"));
			const valid = tree.verifyProof(
				"a",
				encode("1"),
				proof,
				tree.rootHash,
			);
			expect(valid).toBe(true);
		});
	});
});
