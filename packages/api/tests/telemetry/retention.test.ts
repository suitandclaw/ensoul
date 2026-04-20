import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RetentionStore } from "../../telemetry/retention-store.js";
import type { Heartbeat } from "../../telemetry/types.js";

let testDir: string;

function hb(did: string, height: number, overrides?: Partial<Heartbeat>): Heartbeat {
  return {
    version: 1, chain_id: "ensoul-1", did,
    timestamp: Date.now(), height, catching_up: false, peers: 12,
    cometbft_version: "0.38.17", abci_version: "1.4.91",
    disk_used_pct: 42, mem_used_pct: 65,
    signature: "a".repeat(128),
    ...overrides,
  };
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "retention-test-"));
});

afterAll(async () => {
  vi.useRealTimers();
  await rm(testDir, { recursive: true, force: true });
});

describe("RetentionStore", () => {
  // Test 81: heartbeat appended to correct daily JSONL (arrival UTC)
  it("appends heartbeat to correct daily JSONL file", async () => {
    const rawDir = join(testDir, "raw-81");
    const aggDir = join(testDir, "agg-81");
    const store = new RetentionStore(rawDir, aggDir);

    await store.appendRaw(hb("did:A", 100));
    const today = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(rawDir, today + ".jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.heartbeat.did).toBe("did:A");
    expect(typeof parsed.arrivedAt).toBe("number");
  });

  // Test 82: heartbeat at 23:59:59 goes into that day's file
  it("heartbeat arriving at 23:59:59 UTC goes into that day's file", async () => {
    const rawDir = join(testDir, "raw-82");
    const aggDir = join(testDir, "agg-82");
    const store = new RetentionStore(rawDir, aggDir);

    // Mock Date.now to 2026-04-19T23:59:59.500Z
    const fakeDate = new Date("2026-04-19T23:59:59.500Z");
    vi.useFakeTimers();
    vi.setSystemTime(fakeDate);

    await store.appendRaw(hb("did:B", 200));

    vi.useRealTimers();

    // Should be in 2026-04-19.jsonl, NOT 2026-04-20.jsonl
    const content = await readFile(join(rawDir, "2026-04-19.jsonl"), "utf-8");
    expect(content).toContain("did:B");

    // 2026-04-20 should not exist
    try {
      await readFile(join(rawDir, "2026-04-20.jsonl"), "utf-8");
      expect.fail("2026-04-20.jsonl should not exist");
    } catch (e: unknown) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  // Test 83: files older than 7 days deleted
  it("deletes raw files older than 7 days on cleanup", async () => {
    const rawDir = join(testDir, "raw-83");
    const aggDir = join(testDir, "agg-83");
    await mkdir(rawDir, { recursive: true });

    // Create file dated 10 days ago
    const old = new Date();
    old.setDate(old.getDate() - 10);
    const oldName = old.toISOString().slice(0, 10) + ".jsonl";
    await writeFile(join(rawDir, oldName), "old\n");

    // Create file dated 3 days ago
    const recent = new Date();
    recent.setDate(recent.getDate() - 3);
    const recentName = recent.toISOString().slice(0, 10) + ".jsonl";
    await writeFile(join(rawDir, recentName), "recent\n");

    const store = new RetentionStore(rawDir, aggDir);
    await store.cleanup();

    // Old deleted
    try {
      await readFile(join(rawDir, oldName));
      expect.fail("Old file should be deleted");
    } catch (e: unknown) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    // Recent kept
    const kept = await readFile(join(rawDir, recentName), "utf-8");
    expect(kept).toBe("recent\n");
  });

  // Test 84: hourly aggregates correct
  it("computes hourly aggregates with min/max/avg", async () => {
    const rawDir = join(testDir, "raw-84");
    const aggDir = join(testDir, "agg-84");
    await mkdir(rawDir, { recursive: true });

    // Write 3 entries for same DID at different hours (by arrivedAt)
    const dateStr = "2026-04-19";
    const lines: string[] = [];
    for (let h = 0; h < 3; h++) {
      const arrivedAt = new Date(`2026-04-19T0${h}:30:00Z`).getTime();
      lines.push(JSON.stringify({
        heartbeat: hb("did:C", 100 + h * 10, { peers: 5 + h, disk_used_pct: 30 + h * 10 }),
        arrivedAt,
      }));
    }
    // Add two more entries in hour 0 for the same DID to test aggregation
    lines.push(JSON.stringify({
      heartbeat: hb("did:C", 105, { peers: 8, disk_used_pct: 35 }),
      arrivedAt: new Date("2026-04-19T00:45:00Z").getTime(),
    }));
    await writeFile(join(rawDir, dateStr + ".jsonl"), lines.join("\n") + "\n");

    const store = new RetentionStore(rawDir, aggDir);
    await store.computeHourlyAggregates(new Date("2026-04-19T00:00:00Z"));

    const aggContent = await readFile(join(aggDir, dateStr + ".json"), "utf-8");
    const aggs = JSON.parse(aggContent);
    expect(Array.isArray(aggs)).toBe(true);
    // 3 hours, but hour 0 has 2 entries so still 3 groups
    expect(aggs.length).toBe(3);

    const hour0 = aggs.find((a: { hour: number }) => a.hour === 0);
    expect(hour0).toBeDefined();
    expect(hour0.count).toBe(2);
    expect(hour0.height.min).toBe(100);
    expect(hour0.height.max).toBe(105);
    expect(hour0.height.avg).toBe(102.5);
  });

  // Test 85: aggregate files older than 90 days deleted
  it("deletes aggregate files older than 90 days on cleanup", async () => {
    const rawDir = join(testDir, "raw-85");
    const aggDir = join(testDir, "agg-85");
    await mkdir(aggDir, { recursive: true });

    const old = new Date();
    old.setDate(old.getDate() - 95);
    const oldName = old.toISOString().slice(0, 10) + ".json";
    await writeFile(join(aggDir, oldName), "[]");

    const recent = new Date();
    recent.setDate(recent.getDate() - 30);
    const recentName = recent.toISOString().slice(0, 10) + ".json";
    await writeFile(join(aggDir, recentName), "[]");

    const store = new RetentionStore(rawDir, aggDir);
    await store.cleanup();

    try {
      await readFile(join(aggDir, oldName));
      expect.fail("Old aggregate should be deleted");
    } catch (e: unknown) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    const kept = await readFile(join(aggDir, recentName), "utf-8");
    expect(kept).toBe("[]");
  });

  // Test 86: cleanup is idempotent
  it("cleanup is idempotent (running twice does not error)", async () => {
    const rawDir = join(testDir, "raw-86");
    const aggDir = join(testDir, "agg-86");
    const store = new RetentionStore(rawDir, aggDir);
    await store.cleanup(); // dirs don't exist yet
    await store.cleanup(); // still fine
  });
});
