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

	constructor(urls: string[]) {
		this.peerUrls = urls;
		this.startedAt = Date.now();
	}

	/** Start polling peers every 10 seconds. */
	async start(): Promise<void> {
		await this.pollAllPeers();
		this.pollTimer = setInterval(() => {
			void this.pollAllPeers();
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
		const validators: ValidatorData[] = [];
		const seen = new Set<string>();
		for (const peer of this.peers.values()) {
			if (!peer.alive || seen.has(peer.did)) continue;
			seen.add(peer.did);
			validators.push({
				did: peer.did,
				stake: "10000000000000000000000",
				blocksProduced: 0,
				uptimePercent: 100,
				delegation: "foundation",
			});
		}
		return validators;
	}

	getAgentProfile(_did: string): AgentProfile | null {
		return null;
	}

	getNetworkStats(): NetworkStats {
		const height = this.getChainHeight();
		const elapsed = Date.now() - this.startedAt;
		const avgBlockTime = height > 0 ? Math.round(elapsed / height) : 6000;
		const uniqueDids = new Set<string>();
		for (const peer of this.peers.values()) {
			if (peer.alive) uniqueDids.add(peer.did);
		}

		return {
			blockHeight: height,
			validatorCount: validatorCountOverride ?? uniqueDids.size,
			totalAgents: 0,
			totalConsciousnessBytes: 0,
			totalTransactions: 0,
			averageBlockTimeMs: avgBlockTime,
			totalSupply: "1000000000",
			totalBurned: "0",
			totalStaked: "0",
			agentsByTrustLevel: {},
		};
	}

	getLatestCheckpoint(): CheckpointData | null {
		return null;
	}

	// ── Internal ─────────────────────────────────────────────────

	private async pollAllPeers(): Promise<void> {
		for (const url of this.peerUrls) {
			try {
				const resp = await fetch(`${url}/peer/status`);
				if (!resp.ok) {
					this.markDead(url);
					continue;
				}
				const status = (await resp.json()) as PeerStatusResponse;
				const prev = this.peers.get(url);
				const prevHeight = prev?.height ?? -1;

				this.peers.set(url, {
					url,
					did: status.did,
					height: status.height,
					alive: true,
					lastSeen: Date.now(),
				});

				// Fetch new blocks from this peer if it advanced
				if (status.height > prevHeight) {
					await this.fetchBlocks(url, prevHeight + 1, status.height);
				}
			} catch {
				this.markDead(url);
			}
		}
	}

	private markDead(url: string): void {
		const existing = this.peers.get(url);
		if (existing) {
			existing.alive = false;
		}
	}

	private async fetchBlocks(
		peerUrl: string,
		from: number,
		to: number,
	): Promise<void> {
		try {
			const resp = await fetch(`${peerUrl}/peer/sync/${from}`);
			if (!resp.ok) return;
			const data = (await resp.json()) as { blocks: SerializedBlock[] };
			for (const sb of data.blocks) {
				if (sb.height <= to) {
					this.blockCache.set(sb.height, this.toBlockData(sb));
				}
			}
		} catch {
			// Non-fatal
		}
	}

	private toBlockData(sb: SerializedBlock): BlockData {
		return {
			height: sb.height,
			hash: sb.stateRoot.slice(0, 16) + sb.transactionsRoot.slice(0, 16),
			parentHash: sb.previousHash,
			proposer: sb.proposer,
			timestamp: sb.timestamp,
			txCount: sb.transactions.length,
			transactions: sb.transactions.map((tx) => ({
				hash: `${tx.from.slice(0, 8)}:${tx.nonce}`,
				type: tx.type,
				from: tx.from,
				to: tx.to,
				amount: tx.amount,
				timestamp: tx.timestamp,
			})),
		};
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
			averageBlockTimeMs: height > 0 ? Math.round(elapsed / height) : 6000,
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
