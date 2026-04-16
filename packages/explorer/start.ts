#!/usr/bin/env npx tsx
/**
 * Standalone explorer API server.
 *
 * In network mode (default): queries real validator peers for chain state.
 * In local mode (no peers configured): boots internal validators.
 *
 * Usage:
 *   npx tsx packages/explorer/start.ts
 *   npx tsx packages/explorer/start.ts --port 8080
 *   ENSOUL_PEERS=https://v0.ensoul.dev,https://v1.ensoul.dev npx tsx packages/explorer/start.ts
 *   npx tsx packages/explorer/start.ts --network-peers https://v0.ensoul.dev,https://v1.ensoul.dev
 */

import { createIdentity } from "@ensoul/identity";
import { checkValidatorHealth, updateUptimeTracker, getUptimePercent } from "../shared/validator-health.js";
import type { AgentIdentity } from "@ensoul/identity";
import {
	createDefaultGenesis,
	computeBlockHash,
	computeTxHash,
} from "@ensoul/ledger";
import type { Block } from "@ensoul/ledger";
import { NodeBlockProducer, GossipNetwork } from "@ensoul/node";
import { createExplorer } from "./src/server.js";
import type {
	ExplorerDataSource,
	BlockData,
	TxData,
	AgentProfile,
	ValidatorData,
	NetworkStats,
	CheckpointData,
} from "./src/types.js";

// ── Config ───────────────────────────────────────────────────────────

const port = Number(
	process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 3000,
);

const networkPeersArg = process.argv.find(
	(_, i, a) => a[i - 1] === "--network-peers",
);
const networkPeersEnv = process.env["ENSOUL_PEERS"];
const peerUrls = (networkPeersArg ?? networkPeersEnv ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const validatorCountOverride = process.env["ENSOUL_VALIDATOR_COUNT"]
	? Number(process.env["ENSOUL_VALIDATOR_COUNT"])
	: null;
const CMT_RPC = process.env["CMT_RPC"] ?? "http://178.156.199.91:26657";

// ── Types for peer responses ─────────────────────────────────────────

interface PeerStatusResponse {
	height: number;
	peerCount: number;
	did: string;
}

interface SerializedBlock {
	height: number;
	previousHash: string;
	stateRoot: string;
	transactionsRoot: string;
	timestamp: number;
	proposer: string;
	transactions: Array<{
		type: string;
		from: string;
		to: string;
		amount: string;
		nonce: number;
		timestamp: number;
		signature: string;
	}>;
	attestations: Array<{
		validatorDid: string;
		signature: string;
		timestamp: number;
	}>;
}

// ── Network data source (queries real validators) ────────────────────

interface PeerState {
	url: string;
	did: string;
	height: number;
	alive: boolean;
	lastSeen: number;
}

class NetworkDataSource implements ExplorerDataSource {
	private peers: Map<string, PeerState> = new Map();
	private peerUrls: string[];
	private startedAt: number;
	private blockCache: Map<number, BlockData> = new Map();
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	/** Validator DIDs from genesis (all 35+). */
	private genesisDids: string[] = [];
	/** Cached validator data. */
	private validatorCache: ValidatorData[] = [];
	/** Stake category mapping (DID -> category). */
	private stakeCategories: Map<string, "genesis-partners" | "foundation" | "pioneer" | "community"> = new Map();
	/** Cached agent count from the API. */
	private agentCount = 0;
	private consciousnessCount = 0;
	/** Block proposer counts for leaderboard. */
	private proposerCounts: Map<string, number> = new Map();
	/** Total transactions across all cached blocks. */
	private totalTxCount = 0;
	/** DIDs of validators on reachable machines (online). */
	private onlineDids: Set<string> = new Set();

	constructor(urls: string[]) {
		this.peerUrls = urls;
		this.startedAt = Date.now();
	}

	/** Load genesis DIDs from ~/.ensoul/genesis.json. */
	async loadGenesis(): Promise<void> {
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { homedir } = await import("node:os");
		const genesisPath = join(homedir(), ".ensoul", "genesis.json");
		try {
			const raw = await readFile(genesisPath, "utf-8");
			const genesis = JSON.parse(raw) as {
				transactions: Array<{ type: string; to: string; data?: number[] }>;
			};
			this.genesisDids = genesis.transactions
				.filter((tx) => tx.type === "genesis_allocation" && tx.data && tx.data.length > 0 && tx.to.startsWith("did:key:"))
				.map((tx) => tx.to)
				.sort();
			process.stdout.write(`  Genesis validators: ${this.genesisDids.length}\n`);
		} catch {
			process.stdout.write("  Warning: could not load genesis.json\n");
		}
	}

	/** Load stake categories from configs/stake-categories.json. */
	async loadStakeCategories(): Promise<void> {
		const { readFile } = await import("node:fs/promises");
		const { join, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
		try {
			const raw = await readFile(join(repoRoot, "configs", "stake-categories.json"), "utf-8");
			const data = JSON.parse(raw) as { validators: Record<string, { category: string }> };
			for (const [did, info] of Object.entries(data.validators)) {
				this.stakeCategories.set(did, info.category as "genesis-partners" | "foundation" | "pioneer" | "community");
			}
			process.stdout.write(`  Stake categories: ${this.stakeCategories.size} validators mapped\n`);
		} catch {
			process.stdout.write("  Warning: could not load stake-categories.json\n");
		}
	}

	/** Start polling. */
	async start(): Promise<void> {
		await this.loadGenesis();
		await this.loadStakeCategories();
		await this.loadAddressMapping();
		await this.pollAllPeers();
		await this.refreshValidators();
		await this.refreshChainStats();
		await this.refreshOnlineStatus();
		this.pollTimer = setInterval(() => {
			void this.pollAllPeers();
			void this.refreshOnlineStatus();
			void this.refreshValidators();
			void this.refreshChainStats();
		}, 10_000);
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	getChainHeight(): number {
		let max = 0;
		for (const peer of this.peers.values()) {
			if (peer.alive && peer.height > max) max = peer.height;
		}
		return max;
	}

	getBlock(height: number): BlockData | null {
		return this.blockCache.get(height) ?? null;
	}

	getBlocks(from: number, to: number): BlockData[] {
		const blocks: BlockData[] = [];
		const end = Math.min(to, this.getChainHeight());
		for (let h = Math.max(0, from); h <= end; h++) {
			const b = this.blockCache.get(h);
			if (b) blocks.push(b);
		}
		return blocks;
	}

	getValidators(): ValidatorData[] {
		return this.validatorCache;
	}

	getAgentProfile(_did: string): AgentProfile | null {
		return null;
	}

	getNetworkStats(): NetworkStats {
		const height = this.getChainHeight();
		// Compute average block time from the last 10 consecutive cached blocks
		let avgBlockTime = 6000;
		const recent: BlockData[] = [];
		for (let h = height; h >= Math.max(0, height - 10) && recent.length < 11; h--) {
			const b = this.blockCache.get(h);
			if (b) recent.push(b);
		}
		recent.reverse();
		if (recent.length >= 2) {
			let sum = 0;
			let count = 0;
			for (let i = 1; i < recent.length; i++) {
				const diff = recent[i]!.timestamp - recent[i - 1]!.timestamp;
				// Only count reasonable intervals (under 120 seconds)
				if (diff > 0 && diff < 120000) { sum += diff; count++; }
			}
			if (count > 0) avgBlockTime = Math.round(sum / count);
		}

		// Total staked from validator cache (includes delegated power)
		const totalStaked = this.validatorCache.reduce((s, v) => s + BigInt(v.stake), 0n);

		return {
			blockHeight: height,
			validatorCount: this.validatorCache.length || this.genesisDids.length || validatorCountOverride || 35,
			totalAgents: this.agentCount,
			totalConsciousnessBytes: this.consciousnessCount,
			totalTransactions: this.totalTxCount,
			averageBlockTimeMs: avgBlockTime,
			totalSupply: "1000000000",
			totalBurned: "0",
			totalStaked: (totalStaked / 1000000000000000000n).toString(),
			agentsByTrustLevel: {},
		};
	}

	getLatestCheckpoint(): CheckpointData | null {
		return null;
	}

	/** Get account data via ABCI query. */
	async getAccountData(did: string): Promise<{
		balance: string; staked: string; delegated: string;
		unstaking: string; nonce: number; storageCredits: string;
	} | null> {
		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "abci_query", params: { path: `/balance/${did}` } }),
				signal: AbortSignal.timeout(5000),
			});
			if (!resp.ok) return null;
			const result = (await resp.json()) as { result?: { response?: { value?: string } } };
			const val = result.result?.response?.value;
			if (!val) return null;
			const d = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as Record<string, unknown>;
			return {
				balance: String(d["balance"] ?? "0"),
				staked: String(d["stakedBalance"] ?? "0"),
				delegated: String(d["delegatedBalance"] ?? "0"),
				unstaking: String(d["unstaking"] ?? "0"),
				nonce: Number(d["nonce"] ?? 0),
				storageCredits: String(d["storageCredits"] ?? "0"),
			};
		} catch { return null; }
	}

	// ── Internal ─────────────────────────────────────────────────

	/** Map CometBFT validator address to DID (loaded from config). */
	private addressToDid: Map<string, string> = new Map();
	/** Per-validator signature counts over the last N blocks (for real uptime). */
	private signatureCounts: Map<string, number> = new Map();
	/** Number of recent blocks scanned for uptime calculation. */
	private uptimeSampleSize = 0;

	/** Load address-to-DID mapping from configs/validators.json. */
	private async loadAddressMapping(): Promise<void> {
		try {
			const { readFile: rf } = await import("node:fs/promises");
			const { join: j, dirname: dn } = await import("node:path");
			const { fileURLToPath: fu } = await import("node:url");
			const configPath = j(dn(fu(import.meta.url)), "..", "..", "configs", "validators.json");
			const raw = await rf(configPath, "utf-8");
			const config = JSON.parse(raw) as {
				validators: Array<{ cometbftAddress?: string; did?: string; name: string }>;
			};
			for (const v of config.validators) {
				if (v.cometbftAddress && v.did) {
					this.addressToDid.set(v.cometbftAddress, v.did);
				}
			}
			process.stdout.write(`  Address-to-DID mapping: ${this.addressToDid.size} validators\n`);
		} catch {
			process.stdout.write(`  Warning: could not load address mapping from configs/validators.json\n`);
		}
	}

	/**
	 * Determine actual liveness.
	 *
	 * Rule: if a validator is in the CometBFT active set with voting power > 0,
	 * it is ONLINE. Being in the active set means CometBFT accepted it into
	 * consensus. Only mark offline if it has been in the set for 100+ blocks
	 * AND signed fewer than 50% of those blocks.
	 */
	private async refreshOnlineStatus(): Promise<void> {
		try {
			// Shared block-signature health check (scans last 20 blocks)
			const health = await checkValidatorHealth();

			const online = new Set<string>();
			const counts = new Map<string, number>();

			for (const [addr, vh] of health.validators) {
				counts.set(addr, vh.signed);
				if (vh.status === "signing") {
					const did = this.addressToDid.get(addr);
					if (did) online.add(did);
				}
			}

			this.signatureCounts = counts;
			this.uptimeSampleSize = health.height > 0 ? Math.min(20, health.height) : 0;
			this.onlineDids = online;

			// Feed into the persistent rolling uptime tracker
			updateUptimeTracker(health);
		} catch { /* non-fatal */ }
	}

	/**
	 * Refresh validator data from ABCI /validators and CometBFT /validators.
	 * Uses ABCI for stake data (DID-keyed) and CometBFT for the address mapping.
	 * Liveness comes from refreshOnlineStatus() block signature analysis.
	 */
	private async refreshValidators(): Promise<void> {
		try {
			// Get validator list with stake from ABCI
			const abciResp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "v", method: "abci_query", params: { path: "/validators" } }),
				signal: AbortSignal.timeout(5000),
			});
			if (!abciResp.ok) return;
			const abciResult = (await abciResp.json()) as { result?: { response?: { value?: string } } };
			const abciVal = abciResult.result?.response?.value;
			if (!abciVal) return;

			const abciData = JSON.parse(Buffer.from(abciVal, "base64").toString("utf-8")) as {
				validators: Array<{
					did: string;
					stakedBalance: string;
					delegatedToThis: string;
					totalPower: string;
					power: number;
				}>;
				count: number;
			};

			// Auto-discover CometBFT address mappings for new validators
			try {
				const cmtResp = await fetch(CMT_RPC, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "cv", method: "validators", params: {} }),
					signal: AbortSignal.timeout(5000),
				});
				if (cmtResp.ok) {
					const cmtData = (await cmtResp.json()) as { result: { validators: Array<{ address: string; voting_power: string }> } };
					const abciByPower = new Map<number, string[]>();
					for (const v of abciData.validators) {
						const p = v.power;
						if (!abciByPower.has(p)) abciByPower.set(p, []);
						abciByPower.get(p)!.push(v.did);
					}
					for (const cv of cmtData.result.validators) {
						if (this.addressToDid.has(cv.address)) continue;
						// Try matching by unique power
						const power = Number(cv.voting_power);
						const candidates = abciByPower.get(power);
						if (candidates && candidates.length === 1) {
							this.addressToDid.set(cv.address, candidates[0]!);
							log(`Auto-mapped ${cv.address.slice(0, 12)}... to ${candidates[0]!.slice(0, 30)}...`);
						}
					}
				}
			} catch { /* non-fatal */ }

			// Count proposer blocks from recent CometBFT blocks
			await this.refreshProposerCounts();

			// Pioneer power ceiling: Foundation validators have 4M+ power.
			// Pioneers get ~1M delegation + optional self-stake. Any validator
			// at or below this threshold without an explicit stake category is
			// labeled "pioneer" automatically.
			const PIONEER_POWER_CEILING = 1_100_000;

			// Build validator cache from ABCI data first.
			const abciDids = new Set(abciData.validators.map(v => v.did));

			const cache: ValidatorData[] = abciData.validators.map((v) => {
				const totalStake = BigInt(v.stakedBalance) + BigInt(v.delegatedToThis);

				// Uptime: persistent rolling tracker (10,000 block window)
				let uptimePercent = -1; // -1 means "N/A" (not enough samples)
				let addr = "";
				for (const [a, d] of this.addressToDid) {
					if (d === v.did) { addr = a; break; }
				}
				if (addr) {
					const rolling = getUptimePercent(addr);
					if (rolling !== null) uptimePercent = rolling;
				}

				// Auto-detect Pioneer category from voting power
				const existingCat = this.stakeCategories.get(v.did);
				const category = existingCat ?? (v.power <= PIONEER_POWER_CEILING ? "pioneer" : undefined);

				return {
					did: v.did,
					stake: totalStake.toString(),
					blocksProduced: this.proposerCounts.get(v.did) ?? 0,
					uptimePercent,
					delegation: "foundation" as const,
					category,
				};
			});

			// Append CometBFT validators that are in consensus but missing
			// from ABCI /validators. This happens for some Pioneers: CometBFT
			// includes them in its active set, but the ABCI app hasn't
			// added them to its /validators query response yet.
			try {
				const cmtResp2 = await fetch(CMT_RPC, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "cv2", method: "validators", params: { per_page: "100" } }),
					signal: AbortSignal.timeout(5000),
				});
				if (cmtResp2.ok) {
					const cmtData2 = (await cmtResp2.json()) as { result: { validators: Array<{ address: string; voting_power: string }> } };
					for (const cv of cmtData2.result.validators) {
						const power = Number(cv.voting_power);
						if (power <= 0) continue;

						// Already covered by ABCI list?
						const did = this.addressToDid.get(cv.address);
						if (did && abciDids.has(did)) continue;

						// Also skip if we already added an entry for this DID
						if (did && cache.some(c => c.did === did)) continue;

						// Missing from ABCI — create a best-effort entry.
						const stakeWei = (BigInt(power) * 1000000000000000000n).toString();
						let uptimePercent = -1;
						const rolling = getUptimePercent(cv.address);
						if (rolling !== null) uptimePercent = rolling;

						const existingCat = did ? this.stakeCategories.get(did) : undefined;
						const category = existingCat ?? (power <= PIONEER_POWER_CEILING ? "pioneer" : undefined);

						cache.push({
							did: did ?? `cmt:${cv.address}`,
							stake: stakeWei,
							blocksProduced: (did ? this.proposerCounts.get(did) : undefined) ?? 0,
							uptimePercent,
							delegation: "foundation" as const,
							category,
						});
					}
				}
			} catch { /* non-fatal */ }

			this.validatorCache = cache;
		} catch { /* non-fatal, keep last cache */ }
	}

	/** Count block proposers from the last 1000 blocks via CometBFT blockchain RPC. */
	private async refreshProposerCounts(): Promise<void> {
		try {
			const statusResp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "s", method: "status", params: {} }),
				signal: AbortSignal.timeout(5000),
			});
			if (!statusResp.ok) return;
			const statusData = (await statusResp.json()) as { result: { sync_info: { latest_block_height: string } } };
			const tipHeight = Number(statusData.result.sync_info.latest_block_height);
			const fromHeight = Math.max(1, tipHeight - 999);

			const counts = new Map<string, number>();

			for (let min = fromHeight; min <= tipHeight; min += 20) {
				const max = Math.min(min + 19, tipHeight);
				try {
					const resp = await fetch(CMT_RPC, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ jsonrpc: "2.0", id: "bc", method: "blockchain", params: { minHeight: String(min), maxHeight: String(max) } }),
						signal: AbortSignal.timeout(5000),
					});
					if (!resp.ok) continue;
					const data = (await resp.json()) as { result: { block_metas: Array<{ header: { proposer_address: string } }> } };
					for (const meta of data.result.block_metas ?? []) {
						const addr = meta.header.proposer_address;
						if (addr) {
							const did = this.addressToDid.get(addr);
							if (did) {
								counts.set(did, (counts.get(did) ?? 0) + 1);
							}
						}
					}
				} catch { /* skip batch */ }
			}

			this.proposerCounts = counts;
		} catch { /* non-fatal */ }
	}

	/** Fetch all chain statistics from ABCI state via CometBFT RPC (single source of truth). */
	private async refreshChainStats(): Promise<void> {
		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "stats", method: "abci_query", params: { path: "/stats" } }),
				signal: AbortSignal.timeout(5000),
			});
			if (!resp.ok) return;
			const result = (await resp.json()) as { result?: { response?: { value?: string } } };
			const val = result.result?.response?.value;
			if (!val) return;
			const data = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as {
				agentCount?: number;
				consciousnessCount?: number;
				totalTransactions?: number;
			};
			this.agentCount = data.agentCount ?? 0;
			this.consciousnessCount = data.consciousnessCount ?? 0;
			// Use ABCI as the authoritative source for total transactions
			if (data.totalTransactions !== undefined) {
				this.totalTxCount = data.totalTransactions;
			}
		} catch { /* non-fatal */ }
	}

	/** Poll CometBFT RPC for the current chain height and cache recent blocks. */
	private async pollAllPeers(): Promise<void> {
		try {
			const resp = await fetch(CMT_RPC, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "s", method: "status", params: {} }),
				signal: AbortSignal.timeout(5000),
			});
			if (!resp.ok) return;
			const data = (await resp.json()) as { result: { sync_info: { latest_block_height: string }; node_info: { id: string; moniker: string } } };
			const height = Number(data.result.sync_info.latest_block_height);
			const moniker = data.result.node_info.moniker;

			const prev = this.peers.get("localhost");
			const prevHeight = prev?.height ?? Math.max(0, height - 10);

			this.peers.set("localhost", {
				url: CMT_RPC,
				did: moniker,
				height,
				alive: true,
				lastSeen: Date.now(),
			});

			// Fetch new blocks since last poll
			if (height > prevHeight) {
				await this.fetchBlocksFromCometBFT(prevHeight + 1, height);
			}
		} catch { /* non-fatal */ }
	}

	/** Fetch blocks from CometBFT RPC and cache them. */
	private async fetchBlocksFromCometBFT(from: number, to: number): Promise<void> {
		// Only fetch recent blocks (limit to last 20 to avoid overload on first start)
		const start = Math.max(from, to - 19);
		for (let h = start; h <= to; h++) {
			if (this.blockCache.has(h)) continue;
			try {
				const resp = await fetch(CMT_RPC, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "b", method: "block", params: { height: String(h) } }),
					signal: AbortSignal.timeout(3000),
				});
				if (!resp.ok) continue;
				const data = (await resp.json()) as {
					result: {
						block: {
							header: {
								height: string;
								time: string;
								proposer_address: string;
								last_block_id: { hash: string };
								app_hash: string;
							};
							data: { txs: string[] | null };
							last_commit: { signatures: Array<{ validator_address: string }> };
						};
						block_id: { hash: string };
					};
				};
				const block = data.result.block;
				const header = block.header;
				const txs = block.data.txs ?? [];
				const proposerDid = this.addressToDid.get(header.proposer_address) ?? header.proposer_address;

				this.blockCache.set(h, {
					height: Number(header.height),
					hash: data.result.block_id.hash.slice(0, 16),
					parentHash: header.last_block_id.hash.slice(0, 16),
					proposer: proposerDid,
					timestamp: new Date(header.time).getTime(),
					txCount: txs.length,
					transactions: txs.map((txB64, i) => {
						try {
							const txJson = JSON.parse(Buffer.from(txB64, "base64").toString("utf-8")) as {
								type: string; from: string; to: string; amount: string; timestamp: number; nonce: number;
							};
							return {
								hash: `${(txJson.from ?? "").slice(0, 8)}:${txJson.nonce ?? i}`,
								type: txJson.type ?? "unknown",
								from: txJson.from ?? "",
								to: txJson.to ?? "",
								amount: txJson.amount ?? "0",
								timestamp: txJson.timestamp ?? 0,
							};
						} catch {
							return { hash: `tx:${i}`, type: "unknown", from: "", to: "", amount: "0", timestamp: 0 };
						}
					}),
				});
			} catch { /* skip block */ }
		}
	}
}

// ── Local fallback data source (in-process validators) ───────────────

async function bootLocalNetwork(): Promise<{
	dataSource: ExplorerDataSource;
	blockTimer: ReturnType<typeof setInterval>;
}> {
	const validators = await Promise.all([
		createIdentity({ seed: new Uint8Array(32).fill(1) }),
		createIdentity({ seed: new Uint8Array(32).fill(2) }),
		createIdentity({ seed: new Uint8Array(32).fill(3) }),
	]);

	const dids = validators.map((v) => v.did);
	const genesis = createDefaultGenesis(dids);

	const producers = validators.map(() => {
		const p = new NodeBlockProducer(genesis);
		p.initGenesis(dids);
		return p;
	});

	const gossips = producers.map((p) => new GossipNetwork(p));
	for (let i = 0; i < gossips.length; i++) {
		const others = gossips.filter((_, j) => j !== i);
		const g = gossips[i]!;
		g.onBroadcastTx = (tx) => {
			for (const o of others) o.handleGossipTx(tx);
		};
		g.onBroadcastBlock = (block) => {
			for (const o of others) o.handleGossipBlock(block);
		};
	}

	// Produce a few initial blocks
	for (let i = 0; i < 5; i++) {
		const h = producers[0]!.getHeight() + 1;
		const proposer = dids[h % dids.length]!;
		gossips[0]!.tryProduceBlock(proposer);
	}

	const blockTimer = setInterval(() => {
		const h = producers[0]!.getHeight() + 1;
		const proposerIndex = h % validators.length;
		const proposerDid = validators[proposerIndex]!.did;
		gossips[0]!.tryProduceBlock(proposerDid);
	}, 6000);

	const dataSource = new LocalDataSource(producers[0]!, validators);
	return { dataSource, blockTimer };
}

class LocalDataSource implements ExplorerDataSource {
	private producer: NodeBlockProducer;
	private validators: AgentIdentity[];
	private startedAt: number;
	private totalTxCount = 0;

	constructor(producer: NodeBlockProducer, validators: AgentIdentity[]) {
		this.producer = producer;
		this.validators = validators;
		this.startedAt = Date.now();
		producer.onBlock = (block: Block) => {
			this.totalTxCount += block.transactions.length;
		};
	}

	getChainHeight(): number { return this.producer.getHeight(); }

	getBlock(height: number): BlockData | null {
		const block = this.producer.getBlock(height);
		if (!block) return null;
		return this.toBlockData(block);
	}

	getBlocks(from: number, to: number): BlockData[] {
		const blocks: BlockData[] = [];
		const end = Math.min(to, this.getChainHeight());
		for (let h = Math.max(0, from); h <= end; h++) {
			const block = this.producer.getBlock(h);
			if (block) blocks.push(this.toBlockData(block));
		}
		return blocks;
	}

	getValidators(): ValidatorData[] {
		return this.producer.getValidators().map((did) => ({
			did, stake: "0", blocksProduced: 0, uptimePercent: 100,
			delegation: "foundation" as const,
		}));
	}

	getAgentProfile(): AgentProfile | null { return null; }

	getNetworkStats(): NetworkStats {
		const height = this.getChainHeight();
		const elapsed = Date.now() - this.startedAt;
		return {
			blockHeight: height,
			validatorCount: this.validators.length,
			totalAgents: 0, totalConsciousnessBytes: 0,
			totalTransactions: this.totalTxCount,
			averageBlockTimeMs: height > 1 ? Math.round(elapsed / Math.min(height, 10)) : 6000,
			totalSupply: "1000000000", totalBurned: "0", totalStaked: "0",
			agentsByTrustLevel: {},
		};
	}

	getLatestCheckpoint(): CheckpointData | null { return null; }

	private toBlockData(block: Block): BlockData {
		return {
			height: block.height,
			hash: computeBlockHash(block),
			parentHash: block.previousHash,
			proposer: block.proposer,
			timestamp: block.timestamp,
			txCount: block.transactions.length,
			transactions: block.transactions.map((tx) => ({
				hash: computeTxHash(tx),
				type: tx.type, from: tx.from, to: tx.to,
				amount: tx.amount.toString(), timestamp: tx.timestamp,
			})),
		};
	}
}

// ── Start ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	let dataSource: ExplorerDataSource;
	let blockTimer: ReturnType<typeof setInterval> | null = null;
	let networkDs: NetworkDataSource | null = null;

	if (peerUrls.length > 0) {
		// Network mode: query real validators
		process.stdout.write(`Connecting to ${peerUrls.length} network peers...\n`);
		for (const url of peerUrls) {
			process.stdout.write(`  ${url}\n`);
		}

		networkDs = new NetworkDataSource(peerUrls);
		await networkDs.start();
		dataSource = networkDs;

		process.stdout.write(`\n  Network height: ${networkDs.getChainHeight()}\n`);
		process.stdout.write(`  Validators: ${networkDs.getValidators().length}\n\n`);
	} else {
		// Local fallback: boot internal validators
		process.stdout.write("No peers configured. Booting local validators...\n");
		process.stdout.write("  Set ENSOUL_PEERS or use --network-peers to connect to the real network.\n\n");

		const local = await bootLocalNetwork();
		dataSource = local.dataSource;
		blockTimer = local.blockTimer;
	}

	const app = await createExplorer(dataSource);
	await app.listen({ port, host: "0.0.0.0" });

	process.stdout.write(`Explorer API running on http://localhost:${port}\n`);
	process.stdout.write(`\n  Dashboard:    http://localhost:${port}/\n`);
	process.stdout.write(`  API status:   http://localhost:${port}/api/v1/status\n`);
	process.stdout.write(`  Validators:   http://localhost:${port}/api/v1/validators\n\n`);

	const shutdown = async (): Promise<void> => {
		process.stdout.write("Shutting down...\n");
		if (blockTimer) clearInterval(blockTimer);
		if (networkDs) networkDs.stop();
		await app.close();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`Fatal: ${msg}\n`);
	process.exit(1);
});
