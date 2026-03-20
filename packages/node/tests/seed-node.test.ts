import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { REWARDS_POOL, PROTOCOL_TREASURY } from "@ensoul/ledger";
import type { GenesisConfig } from "@ensoul/ledger";
import { SeedNode, SeedClient } from "../src/chain/seed-node.js";
import { NodeBlockProducer } from "../src/chain/producer.js";
import { GossipNetwork } from "../src/chain/gossip.js";
import { PeerNetwork } from "../src/chain/peer-network.js";
import { parseArgs } from "../src/cli/args.js";

const DECIMALS = 10n ** 18n;

let v1: AgentIdentity;
let v2: AgentIdentity;

function testGenesis(): GenesisConfig {
	return {
		chainId: "ensoul-test",
		timestamp: 1700000000000,
		totalSupply: 1000n * DECIMALS,
		allocations: [
			{ label: "Foundation", percentage: 15, tokens: 150n * DECIMALS, recipient: "did:test:foundation" },
			{ label: "Rewards", percentage: 50, tokens: 500n * DECIMALS, recipient: REWARDS_POOL },
			{ label: "Treasury", percentage: 10, tokens: 100n * DECIMALS, recipient: PROTOCOL_TREASURY },
			{ label: "Onboarding", percentage: 10, tokens: 100n * DECIMALS, recipient: "did:test:onboarding" },
			{ label: "Liquidity", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:liquidity" },
			{ label: "Contributors", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:contributors" },
			{ label: "Insurance", percentage: 5, tokens: 50n * DECIMALS, recipient: "did:test:insurance" },
		],
		emissionPerBlock: 1n * DECIMALS,
		networkRewardsPool: 500n * DECIMALS,
		protocolFees: { storageFeeProtocolShare: 10, txBaseFee: 1000n },
	};
}

function createNode(dids: string[]): { producer: NodeBlockProducer; gossip: GossipNetwork } {
	const producer = new NodeBlockProducer(testGenesis(), { minimumStake: 0n });
	producer.initGenesis(dids);
	return { producer, gossip: new GossipNetwork(producer) };
}

beforeEach(async () => {
	v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
});

// ── parseArgs --seed and --public-url ────────────────────────────────

describe("parseArgs seed flags", () => {
	it("defaults seed to empty string (disabled)", () => {
		const args = parseArgs(["--validate"]);
		expect(args.seed).toBe("");
	});

	it("parses --seed flag", () => {
		const args = parseArgs(["--validate", "--seed", "http://localhost:4000"]);
		expect(args.seed).toBe("http://localhost:4000");
	});

	it("parses --public-url flag", () => {
		const args = parseArgs(["--validate", "--public-url", "https://my-tunnel.trycloudflare.com"]);
		expect(args.publicUrl).toBe("https://my-tunnel.trycloudflare.com");
	});

	it("defaults publicUrl to empty string", () => {
		const args = parseArgs(["--validate"]);
		expect(args.publicUrl).toBe("");
	});
});

// ── SeedNode server ──────────────────────────────────────────────────

describe("SeedNode", () => {
	let seed: SeedNode;

	beforeEach(() => {
		seed = new SeedNode();
	});

	afterEach(async () => {
		await seed.stop();
	});

	it("POST /register adds a validator", async () => {
		const server = seed.getServer();
		const resp = await server.inject({
			method: "POST",
			url: "/register",
			payload: { url: "http://node1:9000", did: v1.did, height: 10 },
		});

		expect(resp.statusCode).toBe(200);
		const body = resp.json() as { ok: boolean; peers: number };
		expect(body.ok).toBe(true);
		expect(body.peers).toBe(1);
		expect(seed.getValidatorCount()).toBe(1);
	});

	it("POST /register updates height on heartbeat", async () => {
		const server = seed.getServer();

		await server.inject({
			method: "POST", url: "/register",
			payload: { url: "http://node1:9000", did: v1.did, height: 5 },
		});

		await server.inject({
			method: "POST", url: "/register",
			payload: { url: "http://node1:9000", did: v1.did, height: 20 },
		});

		expect(seed.getValidatorCount()).toBe(1);
		const validators = seed.getValidators();
		expect(validators[0]?.height).toBe(20);
	});

	it("POST /register rejects missing fields", async () => {
		const resp = await seed.getServer().inject({
			method: "POST", url: "/register",
			payload: { url: "" },
		});
		const body = resp.json() as { ok: boolean };
		expect(body.ok).toBe(false);
	});

	it("GET /peers returns all registered validators", async () => {
		const server = seed.getServer();

		await server.inject({
			method: "POST", url: "/register",
			payload: { url: "http://node1:9000", did: v1.did, height: 5 },
		});
		await server.inject({
			method: "POST", url: "/register",
			payload: { url: "http://node2:9000", did: v2.did, height: 10 },
		});

		const resp = await server.inject({ method: "GET", url: "/peers" });
		expect(resp.statusCode).toBe(200);
		const body = resp.json() as { peers: Array<{ url: string; did: string }> };
		expect(body.peers.length).toBe(2);
		expect(body.peers.map((p) => p.url)).toContain("http://node1:9000");
		expect(body.peers.map((p) => p.url)).toContain("http://node2:9000");
	});

	it("GET /status returns validator count", async () => {
		await seed.getServer().inject({
			method: "POST", url: "/register",
			payload: { url: "http://node1:9000", did: v1.did, height: 0 },
		});

		const resp = await seed.getServer().inject({ method: "GET", url: "/status" });
		const body = resp.json() as { validators: number };
		expect(body.validators).toBe(1);
	});

	it("removeStale removes validators that missed heartbeats", async () => {
		const server = seed.getServer();

		await server.inject({
			method: "POST", url: "/register",
			payload: { url: "http://node1:9000", did: v1.did, height: 0 },
		});

		expect(seed.getValidatorCount()).toBe(1);

		// Manually age the validator's heartbeat
		const validators = seed.getValidators();
		if (validators[0]) {
			validators[0].lastHeartbeat = Date.now() - 70_000; // 70s ago (>65s timeout)
		}
		// Re-set the validator in the map by re-registering state
		// (removeStale reads from the internal map, which is by reference)
		const removed = seed.removeStale();
		expect(removed).toBe(1);
		expect(seed.getValidatorCount()).toBe(0);
	});
});

// ── SeedClient ───────────────────────────────────────────────────────

describe("SeedClient", () => {
	let seed: SeedNode;

	beforeEach(async () => {
		seed = new SeedNode();
		await seed.start(19400);
	});

	afterEach(async () => {
		await seed.stop();
	});

	it("registers with the seed and discovers peers", async () => {
		// Pre-register a peer
		await seed.getServer().inject({
			method: "POST", url: "/register",
			payload: { url: "http://existing-peer:9000", did: v2.did, height: 5 },
		});

		const client = new SeedClient(
			"http://localhost:19400",
			"http://my-node:9000",
			v1.did,
			() => 0,
		);

		const peers = await client.start();
		client.stop();

		// Should discover the pre-registered peer (not itself)
		expect(peers).toContain("http://existing-peer:9000");
		expect(peers).not.toContain("http://my-node:9000");

		// Seed should now have 2 validators
		expect(seed.getValidatorCount()).toBe(2);
	});

	it("filters out self from discovered peers", async () => {
		const client = new SeedClient(
			"http://localhost:19400",
			"http://my-node:9000",
			v1.did,
			() => 0,
		);

		const peers = await client.start();
		client.stop();

		expect(peers).not.toContain("http://my-node:9000");
	});

	it("calls onPeersDiscovered callback", async () => {
		await seed.getServer().inject({
			method: "POST", url: "/register",
			payload: { url: "http://peer-a:9000", did: v2.did, height: 0 },
		});

		let discoveredUrls: string[] = [];
		const client = new SeedClient(
			"http://localhost:19400",
			"http://my-node:9000",
			v1.did,
			() => 0,
		);
		client.setOnPeersDiscovered((urls) => {
			discoveredUrls = urls;
		});

		await client.start();
		client.stop();

		expect(discoveredUrls).toContain("http://peer-a:9000");
	});
});

// ── Full integration: Seed + PeerNetwork ─────────────────────────────

describe("Seed + PeerNetwork integration", () => {
	let seed: SeedNode;
	let net1: PeerNetwork;
	let net2: PeerNetwork;

	afterEach(async () => {
		if (net1) await net1.stop();
		if (net2) await net2.stop();
		if (seed) await seed.stop();
	});

	it("two validators discover each other via seed and sync", async () => {
		seed = new SeedNode();
		await seed.start(19500);

		const dids = [v1.did, v2.did];

		// Node 1: produce 3 blocks, register with seed
		const node1 = createNode(dids);
		node1.producer.produceBlock(v2.did);
		node1.producer.produceBlock(v1.did);
		node1.producer.produceBlock(v2.did);

		net1 = new PeerNetwork(node1.gossip, v1.did);
		await net1.startServer(19501);
		await net1.registerWithSeed("http://localhost:19500", "http://localhost:19501");

		// Node 2: fresh, registers with seed, should discover node 1 and sync
		const node2 = createNode(dids);
		expect(node2.producer.getHeight()).toBe(0);

		net2 = new PeerNetwork(node2.gossip, v2.did);
		await net2.startServer(19502);
		const connected = await net2.registerWithSeed("http://localhost:19500", "http://localhost:19502");

		expect(connected).toBeGreaterThanOrEqual(1);
		expect(node2.producer.getHeight()).toBe(3);

		// Seed should know 2 validators
		expect(seed.getValidatorCount()).toBe(2);
	});
});
