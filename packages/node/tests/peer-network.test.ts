import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { REWARDS_POOL, PROTOCOL_TREASURY } from "@ensoul/ledger";
import type { GenesisConfig } from "@ensoul/ledger";
import { NodeBlockProducer } from "../src/chain/producer.js";
import { GossipNetwork } from "../src/chain/gossip.js";
import { PeerNetwork, parsePeerAddresses } from "../src/chain/peer-network.js";
import type { PeerStatus } from "../src/chain/peer-network.js";
import type { SerializedBlock } from "../src/chain/types.js";
import { parseArgs } from "../src/cli/args.js";

const DECIMALS = 10n ** 18n;

let v1: AgentIdentity;
let v2: AgentIdentity;
let v3: AgentIdentity;

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
	const producer = new NodeBlockProducer(testGenesis());
	producer.initGenesis(dids);
	const gossip = new GossipNetwork(producer);
	return { producer, gossip };
}

beforeEach(async () => {
	v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
});

// ── parsePeerAddresses ───────────────────────────────────────────────

describe("parsePeerAddresses", () => {
	it("parses comma-separated host:port pairs", () => {
		const addrs = parsePeerAddresses("192.168.1.10:9000,192.168.1.11:9001");
		expect(addrs).toEqual([
			"http://192.168.1.10:9000",
			"http://192.168.1.11:9001",
		]);
	});

	it("handles addresses already with http://", () => {
		const addrs = parsePeerAddresses("http://localhost:9000");
		expect(addrs).toEqual(["http://localhost:9000"]);
	});

	it("trims whitespace", () => {
		const addrs = parsePeerAddresses("  10.0.0.1:9000 , 10.0.0.2:9001 ");
		expect(addrs).toEqual(["http://10.0.0.1:9000", "http://10.0.0.2:9001"]);
	});

	it("returns empty for empty string", () => {
		expect(parsePeerAddresses("")).toEqual([]);
		expect(parsePeerAddresses("  ")).toEqual([]);
	});
});

// ── parseArgs --peers ────────────────────────────────────────────────

describe("parseArgs --peers", () => {
	it("parses --peers flag", () => {
		const args = parseArgs(["--validate", "--peers", "10.0.0.1:9000,10.0.0.2:9001"]);
		expect(args.peers).toEqual(["10.0.0.1:9000", "10.0.0.2:9001"]);
	});

	it("defaults to empty peers", () => {
		const args = parseArgs(["--validate"]);
		expect(args.peers).toEqual([]);
	});
});

// ── PeerNetwork server API ───────────────────────────────────────────

describe("PeerNetwork server", () => {
	let peerNet: PeerNetwork;

	afterEach(async () => {
		if (peerNet) await peerNet.stop();
	});

	it("GET /peer/status returns height and peer count", async () => {
		const dids = [v1.did, v2.did];
		const { gossip } = createNode(dids);
		peerNet = new PeerNetwork(gossip, v1.did);
		await peerNet.startServer(0); // port 0 = random available port

		const server = peerNet.getServer()!;
		const resp = await server.inject({ method: "GET", url: "/peer/status" });
		expect(resp.statusCode).toBe(200);

		const body = resp.json() as PeerStatus;
		expect(body.height).toBe(0);
		expect(body.peerCount).toBe(0);
		expect(body.did).toBe(v1.did);
	});

	it("GET /peer/blocks/:height returns a block", async () => {
		const dids = [v1.did, v2.did];
		const { gossip, producer } = createNode(dids);
		producer.produceBlock(v2.did); // block 1

		peerNet = new PeerNetwork(gossip, v1.did);
		await peerNet.startServer(0);

		const server = peerNet.getServer()!;
		const resp = await server.inject({ method: "GET", url: "/peer/blocks/1" });
		expect(resp.statusCode).toBe(200);

		const block = resp.json() as SerializedBlock;
		expect(block.height).toBe(1);
		expect(block.proposer).toBe(v2.did);
	});

	it("GET /peer/blocks/:height returns 404 for missing block", async () => {
		const { gossip } = createNode([v1.did]);
		peerNet = new PeerNetwork(gossip, v1.did);
		await peerNet.startServer(0);

		const resp = await peerNet.getServer()!.inject({ method: "GET", url: "/peer/blocks/999" });
		expect(resp.statusCode).toBe(404);
	});

	it("GET /peer/sync/:from returns blocks from height to tip", async () => {
		const dids = [v1.did, v2.did];
		const { gossip, producer } = createNode(dids);
		producer.produceBlock(v2.did);
		producer.produceBlock(v1.did);
		producer.produceBlock(v2.did);

		peerNet = new PeerNetwork(gossip, v1.did);
		await peerNet.startServer(0);

		const resp = await peerNet.getServer()!.inject({ method: "GET", url: "/peer/sync/1" });
		expect(resp.statusCode).toBe(200);

		const body = resp.json() as { blocks: SerializedBlock[] };
		expect(body.blocks.length).toBe(3); // blocks 1, 2, 3
	});

	it("POST /peer/blocks applies a new block", async () => {
		const dids = [v1.did, v2.did];
		const node1 = createNode(dids);
		const node2 = createNode(dids);

		// Node 1 produces a block
		const block = node1.producer.produceBlock(v2.did)!;

		// Node 2 receives it via POST
		peerNet = new PeerNetwork(node2.gossip, v2.did);
		await peerNet.startServer(0);

		const { serializeBlock } = await import("../src/chain/types.js");
		const resp = await peerNet.getServer()!.inject({
			method: "POST",
			url: "/peer/blocks",
			payload: serializeBlock(block),
		});

		expect(resp.statusCode).toBe(200);
		const body = resp.json() as { applied: boolean };
		expect(body.applied).toBe(true);
		expect(node2.producer.getHeight()).toBe(1);
	});

	it("GET /peer/peers returns connected peers list", async () => {
		const { gossip } = createNode([v1.did]);
		peerNet = new PeerNetwork(gossip, v1.did);
		await peerNet.startServer(0);

		const resp = await peerNet.getServer()!.inject({ method: "GET", url: "/peer/peers" });
		expect(resp.statusCode).toBe(200);
		const body = resp.json() as { peers: unknown[] };
		expect(body.peers).toEqual([]);
	});
});

// ── PeerNetwork peer-to-peer sync ────────────────────────────────────

describe("PeerNetwork peer-to-peer sync", () => {
	let net1: PeerNetwork;
	let net2: PeerNetwork;

	afterEach(async () => {
		if (net1) await net1.stop();
		if (net2) await net2.stop();
	});

	it("new node syncs blocks from a peer on connect", async () => {
		const dids = [v1.did, v2.did];

		// Node 1: produce 3 blocks
		const node1 = createNode(dids);
		node1.producer.produceBlock(v2.did);
		node1.producer.produceBlock(v1.did);
		node1.producer.produceBlock(v2.did);

		net1 = new PeerNetwork(node1.gossip, v1.did);
		await net1.startServer(19100);

		// Node 2: fresh, connects to node 1
		const node2 = createNode(dids);
		expect(node2.producer.getHeight()).toBe(0);

		net2 = new PeerNetwork(node2.gossip, v2.did);
		await net2.startServer(19101);
		const connected = await net2.connectToPeers(["http://localhost:19100"]);

		expect(connected).toBe(1);
		expect(net2.getPeerCount()).toBe(1);
		expect(node2.producer.getHeight()).toBe(3);
	});

	it("block produced on one node propagates to connected peer", async () => {
		const dids = [v1.did, v2.did];

		const node1 = createNode(dids);
		const node2 = createNode(dids);

		net1 = new PeerNetwork(node1.gossip, v1.did);
		await net1.startServer(19200);
		net2 = new PeerNetwork(node2.gossip, v2.did);
		await net2.startServer(19201);

		// Node 2 connects to node 1
		await net2.connectToPeers(["http://localhost:19200"]);

		// Node 1 connects to node 2
		await net1.connectToPeers(["http://localhost:19201"]);

		// Node 1 produces a block (broadcast goes to node 2 via HTTP POST)
		node1.gossip.tryProduceBlock(v2.did);

		// Give HTTP a moment to propagate
		await new Promise((r) => setTimeout(r, 200));

		expect(node1.producer.getHeight()).toBe(1);
		expect(node2.producer.getHeight()).toBe(1);
	});

	it("getPeers returns correct peer info", async () => {
		const dids = [v1.did];
		const node1 = createNode(dids);
		const node2 = createNode(dids);

		net1 = new PeerNetwork(node1.gossip, v1.did);
		await net1.startServer(19300);
		net2 = new PeerNetwork(node2.gossip, v2.did);
		await net2.startServer(19301);

		await net2.connectToPeers(["http://localhost:19300"]);

		const peers = net2.getPeers();
		expect(peers.length).toBe(1);
		expect(peers[0]?.address).toBe("http://localhost:19300");
		expect(peers[0]?.height).toBe(0);
	});
});
