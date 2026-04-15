/**
 * Fetches live network stats from api.ensoul.dev/v1/network/status.
 */

import { log, errMsg } from "./log.js";

export interface NetworkStats {
	blockHeight: number;
	validatorCount: number;
	agentCount: number;
	totalConsciousnessStored: number;
	peers: number;
}

const API = process.env["ENSOUL_API_URL"] ?? "https://api.ensoul.dev";

/** Genesis day: chain went live. Used to compute "chain alive for X days". */
const GENESIS_DATE = new Date("2026-03-20T00:00:00Z").getTime();

export async function fetchNetworkStats(): Promise<NetworkStats | null> {
	try {
		const res = await fetch(`${API}/v1/network/status`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			await log(`network/status HTTP ${res.status}`);
			return null;
		}
		const data = (await res.json()) as Partial<NetworkStats>;
		return {
			blockHeight: data.blockHeight ?? 0,
			validatorCount: data.validatorCount ?? 0,
			agentCount: data.agentCount ?? 0,
			totalConsciousnessStored: data.totalConsciousnessStored ?? 0,
			peers: data.peers ?? 0,
		};
	} catch (e) {
		await log(`network/status fetch failed: ${errMsg(e)}`);
		return null;
	}
}

export function chainAliveDays(): number {
	return Math.floor((Date.now() - GENESIS_DATE) / 86_400_000);
}
