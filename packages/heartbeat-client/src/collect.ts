// Collect validator metrics from CometBFT RPC and local system.
// If a required field (height, peers, catching_up) fails, throw.
// If an optional field fails, omit it silently.

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import type { HeartbeatPayload } from "./types.js";

const RPC = "http://localhost:26657";
const FETCH_TIMEOUT = 5000;

export class RpcUnreachableError extends Error {
  constructor(cause?: unknown) {
    super("CometBFT RPC unreachable at " + RPC);
    this.name = "RpcUnreachableError";
    if (cause) this.cause = cause;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

function dig(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export async function collectMetrics(): Promise<Omit<HeartbeatPayload, "version" | "did" | "timestamp" | "signature">> {
  // CometBFT /status
  let statusData: Record<string, unknown>;
  try {
    statusData = await fetchJson(RPC + "/status");
  } catch (err) {
    throw new RpcUnreachableError(err);
  }

  const syncInfo = dig(statusData, "result", "sync_info") as Record<string, unknown> | undefined;
  const nodeInfo = dig(statusData, "result", "node_info") as Record<string, unknown> | undefined;

  const height = Number(syncInfo?.["latest_block_height"] ?? 0);
  const catching_up = Boolean(syncInfo?.["catching_up"] ?? false);
  const chain_id = String(nodeInfo?.["network"] ?? "ensoul-1");
  const cometbft_version = String(nodeInfo?.["version"] ?? "unknown");

  // CometBFT /net_info for peer count
  let peers = 0;
  try {
    const netData = await fetchJson(RPC + "/net_info");
    peers = Number(dig(netData, "result", "n_peers") ?? 0);
  } catch {
    // Non-fatal: report peers=0
  }

  // ABCI version: read from the repo's version.ts (fail hard if missing)
  let abci_version: string | null = null;
  for (const path of [
    "packages/node/src/version.ts",
    "../node/src/version.ts",
    "../../packages/node/src/version.ts",
  ]) {
    try {
      const content = await readFile(path, "utf-8");
      const match = content.match(/VERSION\s*=\s*"([^"]+)"/);
      if (match && match[1]) { abci_version = match[1]; break; }
    } catch { /* try next */ }
  }
  if (!abci_version) {
    throw new Error("Could not read ABCI version from packages/node/src/version.ts");
  }

  const result: Omit<HeartbeatPayload, "version" | "did" | "timestamp" | "signature"> = {
    chain_id,
    height,
    catching_up,
    peers,
    cometbft_version,
    abci_version,
  };

  // Optional: disk usage
  try {
    const diskPct = parseDiskUsage();
    if (diskPct !== null) result.disk_used_pct = diskPct;
  } catch { /* omit */ }

  // Optional: memory usage
  try {
    const memPct = await parseMemUsage();
    if (memPct !== null) result.mem_used_pct = memPct;
  } catch { /* omit */ }

  // Optional: uptime
  try {
    const uptime = await parseUptime();
    if (uptime !== null) result.uptime_seconds = uptime;
  } catch { /* omit */ }

  // Optional: restart count
  try {
    const restarts = parseRestartCount();
    if (restarts !== null) result.restart_count = restarts;
  } catch { /* omit */ }

  return result;
}

function parseDiskUsage(): number | null {
  try {
    // df -B1 / outputs: Filesystem 1B-blocks Used Available Use% Mounted
    const output = execSync("df -B1 / 2>/dev/null || df -k /", { encoding: "utf-8", timeout: 3000 });
    const lines = output.trim().split("\n");
    if (lines.length < 2 || !lines[1]) return null;
    const parts = lines[1].split(/\s+/);
    // Find the percentage column (contains %)
    for (const part of parts) {
      if (part.endsWith("%")) {
        const pct = parseInt(part, 10);
        if (!Number.isNaN(pct) && pct >= 0 && pct <= 100) return pct;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function parseMemUsage(): Promise<number | null> {
  try {
    const content = await readFile("/proc/meminfo", "utf-8");
    const total = extractMemValue(content, "MemTotal");
    const available = extractMemValue(content, "MemAvailable");
    if (total === null || available === null || total === 0) return null;
    return Math.round(((total - available) / total) * 100);
  } catch {
    return null;
  }
}

function extractMemValue(content: string, key: string): number | null {
  const match = content.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10); // kB
}

async function parseUptime(): Promise<number | null> {
  try {
    const content = await readFile("/proc/uptime", "utf-8");
    const seconds = parseFloat(content.split(" ")[0] ?? "");
    if (Number.isNaN(seconds)) return null;
    return Math.floor(seconds);
  } catch {
    return null;
  }
}

function parseRestartCount(): number | null {
  try {
    const output = execSync(
      "systemctl show ensoul-abci -p NRestarts --value 2>/dev/null",
      { encoding: "utf-8", timeout: 3000 },
    ).trim();
    const n = parseInt(output, 10);
    if (Number.isNaN(n)) return null;
    return n;
  } catch {
    return null;
  }
}
