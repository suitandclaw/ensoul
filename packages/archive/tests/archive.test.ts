import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import {
	DeadMansArchive,
	MemoryArchiveBackend,
} from "../src/index.js";
import type { ArchiveConfig } from "../src/index.js";

const ENC = new TextEncoder();

let identity: AgentIdentity;
let arweaveBackend: MemoryArchiveBackend;
let filecoinBackend: MemoryArchiveBackend;

function testConfig(): ArchiveConfig {
	return {
		targets: [
			{
				type: "arweave",
				frequency: 1000,
				encryptionKey: "agent",
				maxCost: 1000n,
			},
		],
		autoArchive: true,
		archiveOnDeath: true,
	};
}

function multiConfig(): ArchiveConfig {
	return {
		targets: [
			{
				type: "arweave",
				frequency: 1000,
				encryptionKey: "agent",
				maxCost: 1000n,
			},
			{
				type: "filecoin",
				frequency: 100,
				encryptionKey: "agent",
				maxCost: 500n,
			},
		],
		autoArchive: false,
		archiveOnDeath: false,
	};
}

beforeEach(async () => {
	identity = await createIdentity({ seed: new Uint8Array(32).fill(42) });
	arweaveBackend = new MemoryArchiveBackend("arweave");
	filecoinBackend = new MemoryArchiveBackend("filecoin");
});

describe("DeadMansArchive", () => {
	describe("archive", () => {
		it("archives data and returns receipt", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			const data = ENC.encode("consciousness snapshot v1");
			const receipts = await archive.archive(data, 1);

			expect(receipts.length).toBe(1);
			expect(receipts[0]!.target).toBe("arweave");
			expect(receipts[0]!.contentHash.length).toBe(64);
			expect(receipts[0]!.externalId).toContain("arweave_");
			expect(receipts[0]!.size).toBe(data.length);
			expect(receipts[0]!.signature.length).toBe(64);
			expect(receipts[0]!.consciousnessVersion).toBe(1);
		});

		it("archives to multiple targets", async () => {
			const archive = new DeadMansArchive(identity, multiConfig());
			archive.registerBackend(arweaveBackend);
			archive.registerBackend(filecoinBackend);

			const data = ENC.encode("multi-target snapshot");
			const receipts = await archive.archive(data, 5);

			expect(receipts.length).toBe(2);
			expect(receipts[0]!.target).toBe("arweave");
			expect(receipts[1]!.target).toBe("filecoin");
		});

		it("skips targets without registered backend", async () => {
			const archive = new DeadMansArchive(identity, multiConfig());
			// Only register arweave, not filecoin
			archive.registerBackend(arweaveBackend);

			const data = ENC.encode("partial archive");
			const receipts = await archive.archive(data, 1);

			expect(receipts.length).toBe(1);
			expect(receipts[0]!.target).toBe("arweave");
		});

		it("returns empty array if no backends registered", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			const receipts = await archive.archive(ENC.encode("data"), 1);
			expect(receipts.length).toBe(0);
		});
	});

	describe("verify", () => {
		it("verifies a valid archive", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			const data = ENC.encode("verify this");
			const [receipt] = await archive.archive(data, 1);

			const result = await archive.verify(receipt!.id);
			expect(result.isValid).toBe(true);
			expect(result.target).toBe("arweave");
		});

		it("returns invalid for unknown receipt", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			const result = await archive.verify("nonexistent");
			expect(result.isValid).toBe(false);
			expect(result.error).toContain("Receipt not found");
		});

		it("returns invalid for missing backend", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			const data = ENC.encode("data");
			const [receipt] = await archive.archive(data, 1);

			// Remove backend
			const archive2 = new DeadMansArchive(identity, testConfig());
			(archive2 as unknown as { receipts: typeof archive["receipts"] }).receipts = (archive as unknown as { receipts: typeof archive["receipts"] }).receipts;

			const result = await archive2.verify(receipt!.id);
			expect(result.isValid).toBe(false);
			expect(result.error).toContain("No backend");
		});
	});

	describe("restore", () => {
		it("restores archived data with integrity check", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			const originalData = ENC.encode("restore me please");
			const [receipt] = await archive.archive(originalData, 3);

			const restored = await archive.restoreFromArchive(receipt!.id);
			expect(restored).toEqual(originalData);
		});

		it("throws for unknown receipt", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			await expect(
				archive.restoreFromArchive("nonexistent"),
			).rejects.toThrow("Receipt not found");
		});

		it("throws for missing backend", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			const [receipt] = await archive.archive(ENC.encode("data"), 1);

			const archive2 = new DeadMansArchive(identity, testConfig());
			(archive2 as unknown as { receipts: typeof archive["receipts"] }).receipts = (archive as unknown as { receipts: typeof archive["receipts"] }).receipts;

			await expect(
				archive2.restoreFromArchive(receipt!.id),
			).rejects.toThrow("No backend");
		});

		it("rejects corrupted archive data", async () => {
			const corruptBackend: MemoryArchiveBackend = {
				type: "arweave",
				async upload(data) {
					return { externalId: "corrupt_1", size: data.length };
				},
				async download() {
					return ENC.encode("corrupted data");
				},
				async verify() {
					return false;
				},
			} as unknown as MemoryArchiveBackend;

			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(corruptBackend);

			const [receipt] = await archive.archive(
				ENC.encode("original data"),
				1,
			);

			await expect(
				archive.restoreFromArchive(receipt!.id),
			).rejects.toThrow("integrity check failed");
		});
	});

	describe("receipts", () => {
		it("getReceipts returns all", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			await archive.archive(ENC.encode("v1"), 1);
			await archive.archive(ENC.encode("v2"), 2);

			expect(archive.getReceipts().length).toBe(2);
		});

		it("getLatestReceipt returns most recent for target", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			archive.registerBackend(arweaveBackend);

			await archive.archive(ENC.encode("v1"), 1);
			await archive.archive(ENC.encode("v2"), 2);

			const latest = archive.getLatestReceipt("arweave");
			expect(latest).not.toBeNull();
			expect(latest!.consciousnessVersion).toBe(2);
		});

		it("getLatestReceipt returns null for unknown target", async () => {
			const archive = new DeadMansArchive(identity, testConfig());
			expect(archive.getLatestReceipt("filecoin")).toBeNull();
		});
	});

	describe("config", () => {
		it("isAutoArchiveEnabled reflects config", () => {
			const archive = new DeadMansArchive(identity, testConfig());
			expect(archive.isAutoArchiveEnabled()).toBe(true);
		});

		it("shouldArchiveOnDeath reflects config", () => {
			const archive = new DeadMansArchive(identity, testConfig());
			expect(archive.shouldArchiveOnDeath()).toBe(true);
		});

		it("disabled auto-archive", () => {
			const archive = new DeadMansArchive(identity, multiConfig());
			expect(archive.isAutoArchiveEnabled()).toBe(false);
			expect(archive.shouldArchiveOnDeath()).toBe(false);
		});
	});

	describe("MemoryArchiveBackend", () => {
		it("uploads and downloads", async () => {
			const data = ENC.encode("test data");
			const { externalId } = await arweaveBackend.upload(data);
			const downloaded = await arweaveBackend.download(externalId);
			expect(downloaded).toEqual(data);
		});

		it("verify returns true for matching hash", async () => {
			const data = ENC.encode("verify data");
			const { blake3 } = await import("@noble/hashes/blake3.js");
			const { bytesToHex } = await import("@noble/hashes/utils.js");
			const hash = bytesToHex(blake3(data));

			const { externalId } = await arweaveBackend.upload(data);
			const valid = await arweaveBackend.verify(externalId, hash);
			expect(valid).toBe(true);
		});

		it("verify returns false for wrong hash", async () => {
			const data = ENC.encode("some data");
			const { externalId } = await arweaveBackend.upload(data);
			const valid = await arweaveBackend.verify(externalId, "wrong");
			expect(valid).toBe(false);
		});

		it("verify returns false for missing id", async () => {
			const valid = await arweaveBackend.verify("missing", "hash");
			expect(valid).toBe(false);
		});

		it("download throws for missing id", async () => {
			await expect(
				arweaveBackend.download("missing"),
			).rejects.toThrow("Not found");
		});
	});
});
