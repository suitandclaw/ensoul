#!/usr/bin/env npx tsx
/**
 * Standalone explorer API server with live validator network.
 *
 * Usage:
 *   npx tsx packages/explorer/start.ts
 *   npx tsx packages/explorer/start.ts --port 8080
 *
 * Spins up 3 in-process validators producing real blocks, then serves
 * the explorer backed by their live chain state. Block height, validator
 * count, transaction count, and block data are all real.
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

// ── Boot a 3-validator network ───────────────────────────────────────

async function bootNetwork(): Promise<{
	validators: AgentIdentity[];
	producers: NodeBlockProducer[];
	gossips: GossipNetwork[];
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

	// Wire gossip: broadcast to all other nodes
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

	return { validators, producers, gossips };
}

// ── Block production loop ────────────────────────────────────────────

function startBlockLoop(
	gossips: GossipNetwork[],
	validators: AgentIdentity[],
): ReturnType<typeof setInterval> {
	let tick = 0;
	return setInterval(() => {
		tick++;
		const height = gossips[0]!.getProducer().getHeight() + 1;
		const proposerIndex = height % validators.length;
		const proposerDid = validators[proposerIndex]!.did;
		gossips[0]!.tryProduceBlock(proposerDid);
	}, 6000);
}

// ── Live data source backed by real chain state ──────────────────────

class LiveDataSource implements ExplorerDataSource {
	private producer: NodeBlockProducer;
	private validators: AgentIdentity[];
	private startedAt: number;
	private totalTxCount = 0;

	constructor(producer: NodeBlockProducer, validators: AgentIdentity[]) {
		this.producer = producer;
		this.validators = validators;
		this.startedAt = Date.now();

		// Track transaction count as blocks come in
		producer.onBlock = (block: Block) => {
			this.totalTxCount += block.transactions.length;
		};
	}

	getChainHeight(): number {
		return this.producer.getHeight();
	}

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
		const dids = this.producer.getValidators();
		const height = this.getChainHeight();

		return dids.map((did, i) => {
			const account = this.producer.getState().getAccount(did);
			// Count blocks produced by this validator
			let blocksProduced = 0;
			for (let h = 1; h <= height; h++) {
				const b = this.producer.getBlock(h);
				if (b && b.proposer === did) blocksProduced++;
			}
			return {
				did,
				stake: account.stakedBalance.toString(),
				blocksProduced,
				uptimePercent: 100,
				delegation: "foundation" as const,
			};
		});
	}

	getAgentProfile(_did: string): AgentProfile | null {
		// No agents ensouled yet on a fresh network
		return null;
	}

	getNetworkStats(): NetworkStats {
		const height = this.getChainHeight();
		const elapsed = Date.now() - this.startedAt;
		const avgBlockTime = height > 0 ? Math.round(elapsed / height) : 6000;

		return {
			blockHeight: height,
			validatorCount: this.validators.length,
			totalAgents: 0,
			totalConsciousnessBytes: 0,
			totalTransactions: this.totalTxCount,
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

	private toBlockData(block: Block): BlockData {
		const txs: TxData[] = block.transactions.map((tx) => ({
			hash: computeTxHash(tx),
			type: tx.type,
			from: tx.from,
			to: tx.to,
			amount: tx.amount.toString(),
			timestamp: tx.timestamp,
		}));

		return {
			height: block.height,
			hash: computeBlockHash(block),
			parentHash: block.previousHash,
			proposer: block.proposer,
			timestamp: block.timestamp,
			txCount: block.transactions.length,
			transactions: txs,
		};
	}
}

// ── Start ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	process.stdout.write("Booting 3-validator network...\n");

	const { validators, producers, gossips } = await bootNetwork();
	const dids = validators.map((v) => v.did);

	process.stdout.write(
		`  Validators:\n${dids.map((d, i) => `    [${i}] ${d}`).join("\n")}\n\n`,
	);

	// Produce a few initial blocks so the explorer has content
	for (let i = 0; i < 5; i++) {
		const h = producers[0]!.getHeight() + 1;
		const proposer = dids[h % dids.length]!;
		gossips[0]!.tryProduceBlock(proposer);
	}

	// Start continuous block production (every 6 seconds)
	const blockTimer = startBlockLoop(gossips, validators);

	const dataSource = new LiveDataSource(producers[0]!, validators);
	const app = await createExplorer(dataSource);

	await app.listen({ port, host: "0.0.0.0" });

	process.stdout.write(`Explorer API running on http://localhost:${port}\n`);
	process.stdout.write(`\n  Dashboard:    http://localhost:${port}/\n`);
	process.stdout.write(`  API status:   http://localhost:${port}/api/v1/status\n`);
	process.stdout.write(`  Blocks:       http://localhost:${port}/api/v1/blocks?from=0&to=10\n`);
	process.stdout.write(`  Validators:   http://localhost:${port}/api/v1/validators\n`);
	process.stdout.write(
		`\n  Block height: ${producers[0]!.getHeight()} (producing every 6s)\n\n`,
	);

	const shutdown = async (): Promise<void> => {
		process.stdout.write("Shutting down...\n");
		clearInterval(blockTimer);
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
