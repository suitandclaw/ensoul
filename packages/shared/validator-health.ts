/**
 * Shared validator health check using block signatures.
 *
 * Ground truth: scan the last N committed blocks from local CometBFT
 * and count how many each validator signed (block_id_flag === 2).
 *
 * Used by: telegram-bot, monitor, explorer.
 * Queries the configured CometBFT RPC (CMT_RPC env var or Ashburn fallback).
 */

const DEFAULT_RPC = process.env["CMT_RPC"] ?? "http://178.156.199.91:26657";
const DEFAULT_SCAN_BLOCKS = 20;

export interface ValidatorHealth {
	/** CometBFT hex address (uppercase). */
	address: string;
	/** Number of blocks signed out of the sample window. */
	signed: number;
	/** Total blocks in the sample window. */
	sample: number;
	/** true if the validator is in the active set with power > 0. */
	active: boolean;
	/** Voting power from the active validator set. */
	votingPower: number;
	/** Derived status from signatures and active set membership. */
	status: "signing" | "not_signing" | "inactive";
}

export interface HealthCheckResult {
	/** Chain tip height at time of check. */
	height: number;
	/** Per-validator health, keyed by CometBFT address. */
	validators: Map<string, ValidatorHealth>;
	/** Timestamp of the check. */
	checkedAt: number;
}

/**
 * Check health of all active validators by scanning block signatures.
 *
 * @param rpcUrl Local CometBFT RPC (default http://localhost:26657)
 * @param scanBlocks Number of recent blocks to scan (default 20)
 */
export async function checkValidatorHealth(
	rpcUrl = DEFAULT_RPC,
	scanBlocks = DEFAULT_SCAN_BLOCKS,
): Promise<HealthCheckResult> {
	const result: HealthCheckResult = {
		height: 0,
		validators: new Map(),
		checkedAt: Date.now(),
	};

	// Step 1: Get the active validator set
	const valSetData = await rpc(rpcUrl, "validators");
	if (!valSetData) return result;

	const valSet = valSetData["validators"] as Array<{ address: string; voting_power: string }>;
	for (const v of valSet) {
		if (Number(v.voting_power) > 0) {
			result.validators.set(v.address, {
				address: v.address,
				signed: 0,
				sample: 0,
				active: true,
				votingPower: Number(v.voting_power),
				status: "not_signing",
			});
		}
	}

	// Step 2: Get chain tip height
	const statusData = await rpc(rpcUrl, "status");
	if (!statusData) return result;

	const syncInfo = statusData["sync_info"] as Record<string, unknown>;
	const tipHeight = Number(syncInfo["latest_block_height"]);
	result.height = tipHeight;

	if (tipHeight === 0) return result;

	// Step 3: Scan the last N blocks for signatures
	const scanCount = Math.min(scanBlocks, tipHeight);
	const sigCounts = new Map<string, number>();

	for (let h = tipHeight; h > tipHeight - scanCount; h--) {
		const blockData = await rpc(rpcUrl, "block", { height: String(h) });
		if (!blockData) continue;

		const block = blockData["block"] as Record<string, unknown>;
		const lastCommit = block["last_commit"] as Record<string, unknown>;
		const sigs = lastCommit["signatures"] as Array<Record<string, unknown>>;

		for (const sig of sigs ?? []) {
			const addr = String(sig["validator_address"] ?? "");
			if (addr && sig["block_id_flag"] === 2) {
				sigCounts.set(addr, (sigCounts.get(addr) ?? 0) + 1);
			}
		}
	}

	// Step 4: Assign health status
	for (const [addr, health] of result.validators) {
		health.signed = sigCounts.get(addr) ?? 0;
		health.sample = scanCount;
		health.status = health.signed > 0 ? "signing" : "not_signing";
	}

	return result;
}

// ── Persistent Rolling Uptime Tracker ────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const UPTIME_FILE = join(homedir(), ".ensoul", "uptime-tracker.json");
const UPTIME_WINDOW = 10_000; // blocks
const MIN_SAMPLES = 100;
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Per-validator rolling uptime totals. */
export interface UptimeEntry {
	totalSampled: number;
	totalSigned: number;
	lastHeight: number;
}

/** Loaded uptime state keyed by CometBFT address. */
let uptimeData: Map<string, UptimeEntry> = new Map();
let uptimeLoaded = false;
let lastPersistTime = 0;

function loadUptimeData(): void {
	if (uptimeLoaded) return;
	uptimeLoaded = true;
	try {
		const raw = readFileSync(UPTIME_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, UptimeEntry>;
		for (const [addr, entry] of Object.entries(parsed)) {
			uptimeData.set(addr, entry);
		}
	} catch { /* no file or corrupt, start fresh */ }
}

function persistUptimeData(): void {
	const now = Date.now();
	if (now - lastPersistTime < PERSIST_INTERVAL_MS) return;
	lastPersistTime = now;
	try {
		mkdirSync(join(homedir(), ".ensoul"), { recursive: true });
		const obj: Record<string, UptimeEntry> = {};
		for (const [addr, entry] of uptimeData) obj[addr] = entry;
		writeFileSync(UPTIME_FILE, JSON.stringify(obj, null, 2));
	} catch { /* non-fatal */ }
}

/**
 * Update the rolling uptime tracker with the latest health check result.
 * Call this after each health check cycle.
 */
export function updateUptimeTracker(health: HealthCheckResult): void {
	loadUptimeData();
	if (health.height === 0) return;

	for (const [addr, vh] of health.validators) {
		let entry = uptimeData.get(addr);
		if (!entry) {
			entry = { totalSampled: 0, totalSigned: 0, lastHeight: 0 };
			uptimeData.set(addr, entry);
		}

		// Only count if we advanced past the last recorded height
		if (health.height <= entry.lastHeight) continue;

		// Add the sample from this check (1 sample per check cycle, not per block)
		// The health check already scanned 20 blocks; we record the aggregate
		const isSigning = vh.signed > 0;
		entry.totalSampled += 1;
		if (isSigning) entry.totalSigned += 1;
		entry.lastHeight = health.height;

		// Prune: if we have way more samples than the window, decay
		// Each sample represents ~20 blocks (health check interval).
		// 10,000 block window / 20 blocks per sample = 500 samples max.
		const maxSamples = Math.ceil(UPTIME_WINDOW / DEFAULT_SCAN_BLOCKS);
		if (entry.totalSampled > maxSamples * 2) {
			// Scale down to maxSamples while preserving the ratio
			const ratio = entry.totalSigned / entry.totalSampled;
			entry.totalSampled = maxSamples;
			entry.totalSigned = Math.round(ratio * maxSamples);
		}
	}

	persistUptimeData();
}

/**
 * Get the rolling uptime percentage for a validator.
 * Returns null if fewer than MIN_SAMPLES have been collected.
 */
export function getUptimePercent(address: string): number | null {
	loadUptimeData();
	const entry = uptimeData.get(address);
	if (!entry || entry.totalSampled < MIN_SAMPLES) return null;
	return Math.round((entry.totalSigned / entry.totalSampled) * 1000) / 10;
}

/**
 * Get all uptime data (for the explorer API).
 */
export function getAllUptimeData(): Map<string, UptimeEntry> {
	loadUptimeData();
	return new Map(uptimeData);
}

/** Simple CometBFT JSON-RPC helper. */
async function rpc(
	url: string,
	method: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "hc", method, params }),
			signal: AbortSignal.timeout(5000),
		});
		const data = (await resp.json()) as { result?: Record<string, unknown> };
		return data.result ?? null;
	} catch {
		return null;
	}
}
