#!/usr/bin/env npx tsx
/**
 * Standalone explorer API server.
 *
 * Usage:
 *   npx tsx packages/explorer/start.ts
 *   npx tsx packages/explorer/start.ts --port 8080
 *
 * Starts the explorer with a demo data source on port 3000 (default).
 * To connect to a live validator, set ENSOUL_VALIDATOR_API to its API URL
 * (e.g. http://localhost:10000). Otherwise, realistic demo data is served.
 */

import { createExplorer } from "./src/server.js";
import type {
	ExplorerDataSource,
	BlockData,
	AgentProfile,
	ValidatorData,
	NetworkStats,
	CheckpointData,
} from "./src/types.js";

// ── Config ───────────────────────────────────────────────────────────

const port = Number(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? 3000);

// ── Demo data source ─────────────────────────────────────────────────

const GENESIS_TS = Date.now() - 6_000_000; // ~1000 blocks ago
const AGENT_DID = "did:key:z6MkhaXgBZDvotDkL5257faWxcsSqBrdR7g5gqjvroHyMjZ";
const VALIDATORS = [
	"did:key:z6MkFoundationValidator1aabbccdd",
	"did:key:z6MkFoundationValidator2eeffgghh",
	"did:key:z6MkFoundationValidator3iijjkkll",
];

function demoBlock(height: number): BlockData {
	const proposer = VALIDATORS[height % VALIDATORS.length]!;
	return {
		height,
		hash: `${height.toString(16).padStart(8, "0")}${"a".repeat(56)}`,
		parentHash: height > 0
			? `${(height - 1).toString(16).padStart(8, "0")}${"a".repeat(56)}`
			: "0".repeat(64),
		proposer,
		timestamp: GENESIS_TS + height * 6000,
		txCount: height % 5 === 0 ? 2 : height % 3 === 0 ? 1 : 0,
		transactions: height % 5 === 0
			? [
					{
						hash: `tx_${height}_0`,
						type: "storage_payment",
						from: AGENT_DID,
						to: proposer,
						amount: "10000000000000000000",
						timestamp: GENESIS_TS + height * 6000,
					},
					{
						hash: `tx_${height}_1`,
						type: "transfer",
						from: proposer,
						to: "did:key:z6MkReceiver123",
						amount: "5000000000000000000",
						timestamp: GENESIS_TS + height * 6000 + 1000,
					},
				]
			: height % 3 === 0
				? [
						{
							hash: `tx_${height}_0`,
							type: "stake",
							from: proposer,
							to: proposer,
							amount: "1000000000000000000000",
							timestamp: GENESIS_TS + height * 6000,
						},
					]
				: [],
	};
}

class DemoDataSource implements ExplorerDataSource {
	private readonly chainHeight = 1000;

	getChainHeight(): number {
		return this.chainHeight;
	}

	getBlock(height: number): BlockData | null {
		if (height < 0 || height > this.chainHeight) return null;
		return demoBlock(height);
	}

	getBlocks(from: number, to: number): BlockData[] {
		const blocks: BlockData[] = [];
		const end = Math.min(to, this.chainHeight);
		for (let h = Math.max(0, from); h <= end; h++) {
			blocks.push(demoBlock(h));
		}
		return blocks;
	}

	getValidators(): ValidatorData[] {
		return VALIDATORS.map((did, i) => ({
			did,
			stake: "10000000000000000000000",
			blocksProduced: Math.floor(this.chainHeight / VALIDATORS.length) + (i < this.chainHeight % VALIDATORS.length ? 1 : 0),
			uptimePercent: 99.0 + Math.random() * 0.9,
			delegation: "foundation" as const,
		}));
	}

	getAgentProfile(did: string): AgentProfile | null {
		if (did === AGENT_DID) {
			return {
				did: AGENT_DID,
				consciousnessAgeDays: 47,
				consciousnessVersions: 312,
				consciousnessBytes: 2_457_600,
				trustLevel: "verified",
				ensouledSince: new Date(Date.now() - 47 * 86_400_000).toISOString(),
				lastHeartbeat: Date.now() - 30_000,
				healthStatus: "alive",
				stateRoot: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
			};
		}
		return null;
	}

	getNetworkStats(): NetworkStats {
		return {
			blockHeight: this.chainHeight,
			validatorCount: VALIDATORS.length,
			totalAgents: 42,
			totalConsciousnessBytes: 524_288_000,
			totalTransactions: 5_000,
			averageBlockTimeMs: 6_012,
			totalSupply: "1000000000000000000000000000",
			totalBurned: "100000000000000000000",
			totalStaked: "30000000000000000000000",
			agentsByTrustLevel: { basic: 20, verified: 12, anchored: 6, immortal: 3, sovereign: 1 },
		};
	}

	getLatestCheckpoint(): CheckpointData | null {
		return {
			blockHeight: 900,
			hash: "checkpoint_900_" + "f".repeat(50),
			stateRoot: "state_root_900_" + "e".repeat(49),
			consciousnessRoot: "consciousness_900_" + "d".repeat(46),
			validatorSetHash: "valset_" + "c".repeat(57),
			totalConsciousnesses: 42,
			timestamp: GENESIS_TS + 900 * 6000,
			signatureCount: 3,
		};
	}
}

// ── Start ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const dataSource = new DemoDataSource();
	const app = await createExplorer(dataSource);

	await app.listen({ port, host: "0.0.0.0" });

	process.stdout.write(`Explorer API running on http://localhost:${port}\n`);
	process.stdout.write(`\n  Dashboard:    http://localhost:${port}/\n`);
	process.stdout.write(`  API status:   http://localhost:${port}/api/v1/status\n`);
	process.stdout.write(`  Agent lookup: http://localhost:${port}/api/v1/agent/${AGENT_DID}\n`);
	process.stdout.write(`  Blocks:       http://localhost:${port}/api/v1/blocks?from=990&to=1000\n`);
	process.stdout.write(`  Validators:   http://localhost:${port}/api/v1/validators\n\n`);

	const shutdown = async (): Promise<void> => {
		process.stdout.write("Shutting down...\n");
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
