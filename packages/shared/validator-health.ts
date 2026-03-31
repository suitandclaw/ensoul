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
