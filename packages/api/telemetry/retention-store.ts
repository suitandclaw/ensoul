// Append-only JSONL storage for raw heartbeats with hourly aggregation.
//
// File naming uses UTC ARRIVAL time, not payload timestamp. A heartbeat
// arriving at 2026-04-20T00:00:03Z goes into 2026-04-20.jsonl regardless
// of its payload timestamp field. Cross-midnight heartbeats go into the
// arrival day's file.

import { readFile, writeFile, appendFile, readdir, unlink, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { TELEMETRY_CONFIG } from "./types.js";
import type { Heartbeat } from "./types.js";

export interface RawEntry {
  heartbeat: Heartbeat;
  arrivedAt: number;  // Unix ms, server time at append
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface HourlyAggregate {
  did: string;
  hour: number;
  count: number;
  height: { min: number; max: number; avg: number };
  peers: { min: number; max: number; avg: number };
  disk_used_pct: { min: number; max: number; avg: number } | null;
  mem_used_pct: { min: number; max: number; avg: number } | null;
}

function minMaxAvg(values: number[]): { min: number; max: number; avg: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

export class RetentionStore {
  private readonly rawDir: string;
  private readonly aggregateDir: string;

  constructor(rawDir?: string, aggregateDir?: string) {
    this.rawDir = rawDir ?? TELEMETRY_CONFIG.RAW_DIR;
    this.aggregateDir = aggregateDir ?? TELEMETRY_CONFIG.AGGREGATE_DIR;
  }

  async appendRaw(heartbeat: Heartbeat): Promise<void> {
    await mkdir(this.rawDir, { recursive: true });
    const now = new Date();
    const filename = utcDateStr(now) + ".jsonl";
    const filepath = join(this.rawDir, filename);
    const entry: RawEntry = { heartbeat, arrivedAt: now.getTime() };
    await appendFile(filepath, JSON.stringify(entry) + "\n");
  }

  async readRawForDate(date: Date): Promise<RawEntry[]> {
    const filename = utcDateStr(date) + ".jsonl";
    const filepath = join(this.rawDir, filename);
    try {
      const raw = await readFile(filepath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines.map(line => JSON.parse(line) as RawEntry);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async computeHourlyAggregates(date: Date): Promise<void> {
    const entries = await this.readRawForDate(date);
    if (entries.length === 0) return;

    // Group by { did, arrivedAt UTC hour }
    const groups = new Map<string, Heartbeat[]>();
    for (const entry of entries) {
      const hour = new Date(entry.arrivedAt).getUTCHours();
      const key = `${entry.heartbeat.did}|${hour}`;
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push(entry.heartbeat);
    }

    const aggregates: HourlyAggregate[] = [];
    for (const [key, hbs] of groups) {
      const [did, hourStr] = key.split("|");
      const heights = hbs.map(h => h.height);
      const peers = hbs.map(h => h.peers);
      const disks = hbs.filter(h => h.disk_used_pct !== undefined).map(h => h.disk_used_pct!);
      const mems = hbs.filter(h => h.mem_used_pct !== undefined).map(h => h.mem_used_pct!);

      aggregates.push({
        did: did!,
        hour: Number(hourStr),
        count: hbs.length,
        height: minMaxAvg(heights),
        peers: minMaxAvg(peers),
        disk_used_pct: disks.length > 0 ? minMaxAvg(disks) : null,
        mem_used_pct: mems.length > 0 ? minMaxAvg(mems) : null,
      });
    }

    await mkdir(this.aggregateDir, { recursive: true });
    const outFile = join(this.aggregateDir, utcDateStr(date) + ".json");
    await writeFile(outFile, JSON.stringify(aggregates, null, 2));
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    const rawCutoff = now - TELEMETRY_CONFIG.RAW_RETENTION_DAYS * 86_400_000;
    const aggCutoff = now - TELEMETRY_CONFIG.AGGREGATE_RETENTION_DAYS * 86_400_000;

    await this.cleanDir(this.rawDir, rawCutoff);
    await this.cleanDir(this.aggregateDir, aggCutoff);
  }

  private async cleanDir(dir: string, cutoffMs: number): Promise<void> {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        // Parse YYYY-MM-DD from filename
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\./);
        if (!dateMatch) continue;
        const fileDate = new Date(dateMatch[1] + "T00:00:00Z");
        if (fileDate.getTime() < cutoffMs) {
          try {
            await unlink(join(dir, file));
          } catch (err) {
            console.error(`[telemetry] Failed to delete ${file}:`, err);
          }
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.error("[telemetry] Cleanup error:", err);
    }
  }
}
