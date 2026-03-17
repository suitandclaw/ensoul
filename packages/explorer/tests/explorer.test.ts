import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createExplorer } from "../src/server.js";
import type {
	ExplorerDataSource,
	BlockData,
	AgentProfile,
	ValidatorData,
	NetworkStats,
	CheckpointData,
} from "../src/types.js";

// ── Mock data source ─────────────────────────────────────────────────

const AGENT_DID = "did:key:z6MkTestAgent123456789";
const VALIDATOR_DID = "did:key:z6MkTestValidator1";

function mockBlock(height: number): BlockData {
	return {
		height,
		hash: `hash_${height}`,
		parentHash: `hash_${height - 1}`,
		proposer: VALIDATOR_DID,
		timestamp: 1700000000000 + height * 6000,
		txCount: height % 3,
		transactions:
			height % 3 > 0
				? [
						{
							hash: `tx_${height}_0`,
							type: "transfer",
							from: AGENT_DID,
							to: "did:key:receiver",
							amount: "1000000000000000000",
							timestamp: 1700000000000 + height * 6000,
						},
					]
				: [],
	};
}

function mockAgent(): AgentProfile {
	return {
		did: AGENT_DID,
		consciousnessAgeDays: 187,
		consciousnessVersions: 42,
		consciousnessBytes: 1024 * 1024 * 5,
		trustLevel: "anchored",
		ensouledSince: "2024-09-10T00:00:00.000Z",
		lastHeartbeat: 1000,
		healthStatus: "alive",
		stateRoot: "abc123def456",
	};
}

function mockStats(): NetworkStats {
	return {
		blockHeight: 1000,
		validatorCount: 35,
		totalAgents: 42,
		totalConsciousnessBytes: 1024 * 1024 * 500,
		totalTransactions: 5000,
		averageBlockTimeMs: 6000,
		totalSupply: "1000000000000000000000000000",
		totalBurned: "100000000000000000000",
		totalStaked: "350000000000000000000000",
		agentsByTrustLevel: {
			basic: 20,
			verified: 10,
			anchored: 8,
			immortal: 3,
			sovereign: 1,
		},
	};
}

class MockDataSource implements ExplorerDataSource {
	getChainHeight(): number {
		return 1000;
	}

	getBlock(height: number): BlockData | null {
		if (height < 0 || height > 1000) return null;
		return mockBlock(height);
	}

	getBlocks(from: number, to: number): BlockData[] {
		const blocks: BlockData[] = [];
		for (let h = from; h <= to && h <= 1000; h++) {
			blocks.push(mockBlock(h));
		}
		return blocks;
	}

	getValidators(): ValidatorData[] {
		return [
			{
				did: VALIDATOR_DID,
				stake: "10000000000000000000000",
				blocksProduced: 500,
				uptimePercent: 99.5,
				delegation: "foundation",
			},
			{
				did: "did:key:z6MkValidator2",
				stake: "5000000000000000000000",
				blocksProduced: 300,
				uptimePercent: 98.2,
				delegation: "self",
			},
		];
	}

	getAgentProfile(did: string): AgentProfile | null {
		if (did === AGENT_DID) return mockAgent();
		return null;
	}

	getNetworkStats(): NetworkStats {
		return mockStats();
	}

	getLatestCheckpoint(): CheckpointData | null {
		return {
			blockHeight: 1000,
			hash: "checkpoint_hash_1000",
			stateRoot: "state_root_1000",
			consciousnessRoot: "consciousness_root_1000",
			validatorSetHash: "validator_set_hash",
			totalConsciousnesses: 42,
			timestamp: 1700006000000,
			signatureCount: 24,
		};
	}
}

let app: FastifyInstance;

beforeEach(async () => {
	app = await createExplorer(new MockDataSource());
});

// ── JSON API tests ───────────────────────────────────────────────────

describe("API: GET /api/v1/status", () => {
	it("returns network status", async () => {
		const res = await app.inject({ method: "GET", url: "/api/v1/status" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.blockHeight).toBe(1000);
		expect(body.validatorCount).toBe(35);
		expect(body.totalAgents).toBe(42);
	});
});

describe("API: GET /api/v1/agent/:did", () => {
	it("returns agent profile", async () => {
		const res = await app.inject({
			method: "GET",
			url: `/api/v1/agent/${AGENT_DID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.did).toBe(AGENT_DID);
		expect(body.consciousnessAgeDays).toBe(187);
		expect(body.trustLevel).toBe("anchored");
		expect(body.healthStatus).toBe("alive");
	});

	it("returns 404 for unknown agent", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/agent/did:unknown",
		});
		expect(res.statusCode).toBe(404);
	});
});

describe("API: GET /api/v1/agent/:did/verify", () => {
	it("returns trust verification", async () => {
		const res = await app.inject({
			method: "GET",
			url: `/api/v1/agent/${AGENT_DID}/verify`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.did).toBe(AGENT_DID);
		expect(body.stateRoot).toBe("abc123def456");
		expect(body.checkpointHash).toBe("checkpoint_hash_1000");
		expect(body.trustAssessment.level).toBe("anchored");
		expect(body.verifiableHash.length).toBe(64);
	});

	it("returns 404 for unknown agent", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/agent/did:unknown/verify",
		});
		expect(res.statusCode).toBe(404);
	});
});

describe("API: GET /api/v1/block/:height", () => {
	it("returns block by height", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/block/500",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.height).toBe(500);
		expect(body.proposer).toBe(VALIDATOR_DID);
	});

	it("returns 404 for non-existent block", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/block/9999",
		});
		expect(res.statusCode).toBe(404);
	});

	it("returns 400 for invalid height", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/block/abc",
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("API: GET /api/v1/blocks", () => {
	it("returns block range", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/blocks?from=990&to=1000",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.blocks.length).toBe(11);
	});

	it("defaults to full range", async () => {
		const res = await app.inject({ method: "GET", url: "/api/v1/blocks?from=998" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.blocks.length).toBeGreaterThan(0);
	});
});

describe("API: GET /api/v1/validators", () => {
	it("returns validator list", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/validators",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.validators.length).toBe(2);
		expect(body.validators[0].did).toBe(VALIDATOR_DID);
	});
});

describe("API: GET /api/v1/checkpoint/latest", () => {
	it("returns latest checkpoint", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/checkpoint/latest",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.blockHeight).toBe(1000);
		expect(body.signatureCount).toBe(24);
	});

	it("returns 404 when no checkpoints", async () => {
		const noCheckpointSource: ExplorerDataSource = {
			...new MockDataSource(),
			getLatestCheckpoint: () => null,
		};
		const app2 = await createExplorer(noCheckpointSource);
		const res = await app2.inject({
			method: "GET",
			url: "/api/v1/checkpoint/latest",
		});
		expect(res.statusCode).toBe(404);
	});
});

describe("API: GET /api/v1/stats", () => {
	it("returns full network statistics", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/stats",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.totalTransactions).toBe(5000);
		expect(body.agentsByTrustLevel.sovereign).toBe(1);
	});
});

// ── HTML page tests ──────────────────────────────────────────────────

describe("HTML: Dashboard /", () => {
	it("renders dashboard with stats", async () => {
		const res = await app.inject({ method: "GET", url: "/" });
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		const html = res.body;
		expect(html).toContain("ENSOUL");
		expect(html).toContain("1000"); // block height
		expect(html).toContain("42"); // agents
	});
});

describe("HTML: Agent search /agents", () => {
	it("renders search page", async () => {
		const res = await app.inject({ method: "GET", url: "/agents" });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Look Up Agent");
		expect(res.body).toContain("did:key");
	});
});

describe("HTML: Agent profile /agent?did=", () => {
	it("renders agent with consciousness age hero", async () => {
		const res = await app.inject({
			method: "GET",
			url: `/agent?did=${AGENT_DID}`,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Ensouled for 187 days");
		expect(res.body).toContain("ANCHORED");
		expect(res.body).toContain("ALIVE");
	});

	it("returns 404 for unknown agent", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/agent?did=did:unknown",
		});
		expect(res.statusCode).toBe(404);
	});

	it("redirects when no DID provided", async () => {
		const res = await app.inject({ method: "GET", url: "/agent" });
		expect(res.statusCode).toBe(302);
	});
});

describe("HTML: Block /block/:height", () => {
	it("renders block detail", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/block/500",
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Block 500");
		expect(res.body).toContain(VALIDATOR_DID);
	});

	it("returns 404 for non-existent block", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/block/9999",
		});
		expect(res.statusCode).toBe(404);
	});
});

describe("HTML: Blocks list /blocks", () => {
	it("renders blocks page", async () => {
		const res = await app.inject({ method: "GET", url: "/blocks" });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Blocks");
	});
});

describe("HTML: Validators /validators", () => {
	it("renders validators page", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/validators",
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Validators");
		expect(res.body).toContain(VALIDATOR_DID.slice(0, 24));
	});
});
