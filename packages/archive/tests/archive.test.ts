import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { DeepArchive, MemoryStorageBackend } from "../src/index.js";
import type { ArchiveConfig } from "../src/index.js";

const ENC = new TextEncoder();

let identity: AgentIdentity;
let backend: MemoryStorageBackend;

function testConfig(): ArchiveConfig {
	return {
		clusterCount: 4,
		replicationFactor: 8,
		frequencyBlocks: 1000,
		autoArchive: true,
		archiveOnDeath: true,
	};
}

beforeEach(async () => {
	identity = await createIdentity({ seed: new Uint8Array(32).fill(42) });
	backend = new MemoryStorageBackend();
});

describe("DeepArchive", () => {
	describe("archive", () => {
		it("archives data and returns receipt", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);

			const data = ENC.encode("consciousness snapshot v1");
			const receipt = await archive.archive(data, 1);

			expect(receipt.id.length).toBe(24);
			expect(receipt.contentHash.length).toBe(64);
			expect(receipt.size).toBe(data.length);
			expect(receipt.signature.length).toBe(64);
			expect(receipt.consciousnessVersion).toBe(1);
			expect(receipt.clusterCount).toBe(4);
			expect(receipt.replicationFactor).toBe(8);
		});

		it("throws without backend", async () => {
			const archive = new DeepArchive(identity, testConfig());
			await expect(
				archive.archive(ENC.encode("data"), 1),
			).rejects.toThrow("No storage backend");
		});
	});

	describe("verify", () => {
		it("verifies a valid archive", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);

			const receipt = await archive.archive(ENC.encode("verify this"), 1);
			const result = await archive.verify(receipt.id);
			expect(result.isValid).toBe(true);
		});

		it("returns invalid for unknown receipt", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);
			const result = await archive.verify("nonexistent");
			expect(result.isValid).toBe(false);
			expect(result.error).toContain("Receipt not found");
		});

		it("returns invalid without backend", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);
			const receipt = await archive.archive(ENC.encode("data"), 1);

			const archive2 = new DeepArchive(identity, testConfig());
			// Copy receipts but don't set backend
			(archive2 as unknown as { receipts: unknown[] }).receipts =
				(archive as unknown as { receipts: unknown[] }).receipts;

			const result = await archive2.verify(receipt.id);
			expect(result.isValid).toBe(false);
			expect(result.error).toContain("No storage backend");
		});
	});

	describe("restore", () => {
		it("restores archived data with integrity check", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);

			const originalData = ENC.encode("restore me please");
			const receipt = await archive.archive(originalData, 3);

			const restored = await archive.restore(receipt.id);
			expect(restored).toEqual(originalData);
		});

		it("throws for unknown receipt", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);
			await expect(archive.restore("nonexistent")).rejects.toThrow(
				"Receipt not found",
			);
		});

		it("throws without backend", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);
			const receipt = await archive.archive(ENC.encode("data"), 1);

			const archive2 = new DeepArchive(identity, testConfig());
			(archive2 as unknown as { receipts: unknown[] }).receipts =
				(archive as unknown as { receipts: unknown[] }).receipts;

			await expect(archive2.restore(receipt.id)).rejects.toThrow(
				"No storage backend",
			);
		});

		it("rejects corrupted data", async () => {
			const corruptBackend: MemoryStorageBackend = {
				async store() { return 10; },
				async retrieve() { return ENC.encode("corrupted"); },
				async verify() { return false; },
				async has() { return true; },
			} as unknown as MemoryStorageBackend;

			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(corruptBackend);

			const receipt = await archive.archive(ENC.encode("original"), 1);
			await expect(archive.restore(receipt.id)).rejects.toThrow(
				"integrity check failed",
			);
		});
	});

	describe("receipts", () => {
		it("getReceipts returns all", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);

			await archive.archive(ENC.encode("v1"), 1);
			await archive.archive(ENC.encode("v2"), 2);
			expect(archive.getReceipts().length).toBe(2);
		});

		it("getLatestReceipt returns most recent", async () => {
			const archive = new DeepArchive(identity, testConfig());
			archive.setBackend(backend);

			await archive.archive(ENC.encode("v1"), 1);
			await archive.archive(ENC.encode("v2"), 2);
			expect(archive.getLatestReceipt()?.consciousnessVersion).toBe(2);
		});

		it("getLatestReceipt returns null when empty", () => {
			const archive = new DeepArchive(identity, testConfig());
			expect(archive.getLatestReceipt()).toBeNull();
		});
	});

	describe("config", () => {
		it("isAutoArchiveEnabled reflects config", () => {
			const archive = new DeepArchive(identity, testConfig());
			expect(archive.isAutoArchiveEnabled()).toBe(true);
		});

		it("shouldArchiveOnDeath reflects config", () => {
			const archive = new DeepArchive(identity, testConfig());
			expect(archive.shouldArchiveOnDeath()).toBe(true);
		});

		it("shouldArchive at correct block interval", () => {
			const archive = new DeepArchive(identity, testConfig());
			expect(archive.shouldArchive(0)).toBe(false);
			expect(archive.shouldArchive(500)).toBe(false);
			expect(archive.shouldArchive(1000)).toBe(true);
			expect(archive.shouldArchive(2000)).toBe(true);
		});

		it("shouldArchive returns false when autoArchive disabled", () => {
			const cfg = testConfig();
			cfg.autoArchive = false;
			const archive = new DeepArchive(identity, cfg);
			expect(archive.shouldArchive(1000)).toBe(false);
		});
	});

	describe("MemoryStorageBackend", () => {
		it("store and retrieve", async () => {
			const data = ENC.encode("test");
			await backend.store("id1", data);
			expect(await backend.retrieve("id1")).toEqual(data);
		});

		it("verify with correct hash", async () => {
			const { blake3 } = await import("@noble/hashes/blake3.js");
			const { bytesToHex } = await import("@noble/hashes/utils.js");
			const data = ENC.encode("verify");
			const hash = bytesToHex(blake3(data));
			await backend.store("id1", data);
			expect(await backend.verify("id1", hash)).toBe(true);
		});

		it("verify with wrong hash", async () => {
			await backend.store("id1", ENC.encode("data"));
			expect(await backend.verify("id1", "wrong")).toBe(false);
		});

		it("verify returns false for missing", async () => {
			expect(await backend.verify("missing", "hash")).toBe(false);
		});

		it("retrieve throws for missing", async () => {
			await expect(backend.retrieve("missing")).rejects.toThrow(
				"Not found",
			);
		});

		it("has returns true/false correctly", async () => {
			expect(await backend.has("id1")).toBe(false);
			await backend.store("id1", ENC.encode("data"));
			expect(await backend.has("id1")).toBe(true);
		});
	});
});
