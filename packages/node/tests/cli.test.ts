import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createIdentity } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { encodeTxPayload, REWARDS_POOL, PROTOCOL_TREASURY } from "@ensoul/ledger";
import type { GenesisConfig, Transaction } from "@ensoul/ledger";
import {
	parseArgs,
	expandHome,
	printHelp,
	EnsoulNodeRunner,
	formatStatus,
	DEFAULT_BOOTSTRAP_PEERS,
} from "../src/cli/index.js";

const DECIMALS = 10n ** 18n;

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

async function signTx(
	identity: AgentIdentity,
	partial: Omit<Transaction, "signature">,
): Promise<Transaction> {
	const payload = encodeTxPayload(partial as Transaction);
	const signature = await identity.sign(payload);
	return { ...partial, signature } as Transaction;
}

// ── Arg parsing ──────────────────────────────────────────────────────

describe("parseArgs", () => {
	it("defaults to fullnode mode", () => {
		const args = parseArgs([]);
		expect(args.mode).toBe("fullnode");
		expect(args.storageGB).toBe(10);
		expect(args.help).toBe(false);
	});

	it("parses --validate flag", () => {
		const args = parseArgs(["--validate"]);
		expect(args.mode).toBe("validate");
	});

	it("parses -v shorthand", () => {
		expect(parseArgs(["-v"]).mode).toBe("validate");
	});

	it("parses status subcommand", () => {
		expect(parseArgs(["status"]).mode).toBe("status");
	});

	it("parses --help flag", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-h"]).help).toBe(true);
	});

	it("parses --data-dir", () => {
		expect(parseArgs(["--data-dir", "/tmp/ensoul"]).dataDir).toBe(
			"/tmp/ensoul",
		);
	});

	it("parses --storage", () => {
		expect(parseArgs(["--storage", "50"]).storageGB).toBe(50);
	});

	it("parses --port and --api-port", () => {
		const args = parseArgs(["--port", "8000", "--api-port", "4000"]);
		expect(args.port).toBe(8000);
		expect(args.apiPort).toBe(4000);
	});

	it("parses --bootstrap peers", () => {
		const args = parseArgs([
			"--bootstrap", "/ip4/1.2.3.4/tcp/9000",
			"--bootstrap", "/ip4/5.6.7.8/tcp/9000",
		]);
		expect(args.bootstrapPeers.length).toBe(2);
	});

	it("uses default bootstrap peers when none specified", () => {
		const args = parseArgs([]);
		expect(args.bootstrapPeers).toEqual(DEFAULT_BOOTSTRAP_PEERS);
	});

	it("parses --store-consciousness", () => {
		const args = parseArgs([
			"--validate",
			"--store-consciousness",
			"./agent-state",
		]);
		expect(args.storeConsciousness).toBe("./agent-state");
	});

	it("parses combined flags", () => {
		const args = parseArgs([
			"--validate",
			"--storage", "100",
			"--data-dir", "/data/ensoul",
			"--port", "7000",
		]);
		expect(args.mode).toBe("validate");
		expect(args.storageGB).toBe(100);
		expect(args.dataDir).toBe("/data/ensoul");
		expect(args.port).toBe(7000);
	});
});

describe("expandHome", () => {
	it("expands ~/path", () => {
		const expanded = expandHome("~/ensoul");
		expect(expanded).not.toContain("~");
		expect(expanded.endsWith("/ensoul")).toBe(true);
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandHome("/tmp/ensoul")).toBe("/tmp/ensoul");
	});

	it("leaves relative paths unchanged", () => {
		expect(expandHome("./data")).toBe("./data");
	});
});

describe("printHelp", () => {
	it("returns help text with usage", () => {
		const help = printHelp();
		expect(help).toContain("ensoul-node");
		expect(help).toContain("--validate");
		expect(help).toContain("--storage");
		expect(help).toContain("--bootstrap");
	});
});

// ── EnsoulNodeRunner ─────────────────────────────────────────────────

describe("EnsoulNodeRunner", () => {
	let runner: EnsoulNodeRunner;
	let identity: AgentIdentity;

	beforeEach(async () => {
		identity = await createIdentity({ seed: new Uint8Array(32).fill(1) });
		runner = new EnsoulNodeRunner(
			parseArgs(["--validate"]),
			testGenesis(),
		);
	});

	afterEach(() => {
		runner.stopBlockLoop();
	});

	it("initializes identity", async () => {
		const id = await runner.initIdentity();
		expect(id.did).toBeTruthy();
		expect(id.publicKey.length).toBe(32);
	});

	it("sets identity externally", () => {
		runner.setIdentity(identity);
		const status = runner.getStatus();
		expect(status.did).toBe(identity.did);
	});

	it("initializes chain with validators", () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);
		expect(runner.getProducer()?.getHeight()).toBe(0);
	});

	it("produces blocks in validator mode", () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);

		// Height 1 proposer: index 1 % 1 = 0 = identity.did
		const block = runner.tryProduceBlock();
		expect(block).not.toBeNull();
		expect(block!.height).toBe(1);

		const status = runner.getStatus();
		expect(status.blocksProduced).toBe(1);
	});

	it("submits transactions", async () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);

		// Fund alice
		runner.getProducer()!.getState().credit(identity.did, 100n * DECIMALS);

		const alice = await createIdentity({ seed: new Uint8Array(32).fill(10) });
		runner.getProducer()!.getState().credit(alice.did, 50n * DECIMALS);

		const tx = await signTx(alice, {
			type: "transfer",
			from: alice.did,
			to: identity.did,
			amount: 5n * DECIMALS,
			nonce: 0,
			timestamp: Date.now(),
		});

		const hash = runner.submitTransaction(tx);
		expect(hash).not.toBeNull();
	});

	it("getStatus returns correct shape", () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);

		const status = runner.getStatus();
		expect(status.did).toBe(identity.did);
		expect(status.mode).toBe("validator");
		expect(status.chainHeight).toBe(0);
		expect(status.isValidator).toBe(true);
		expect(status.storageCapacityBytes).toBe(10 * 1024 * 1024 * 1024);
	});

	it("fullnode mode does not validate", () => {
		const fullnodeRunner = new EnsoulNodeRunner(
			parseArgs([]),
			testGenesis(),
		);
		fullnodeRunner.setIdentity(identity);
		fullnodeRunner.initChain([]);
		const status = fullnodeRunner.getStatus();
		expect(status.mode).toBe("fullnode");
		expect(status.isValidator).toBe(false);
	});

	it("startBlockLoop and stopBlockLoop", () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);

		expect(runner.isRunning()).toBe(false);
		runner.startBlockLoop();
		expect(runner.isRunning()).toBe(true);
		runner.stopBlockLoop();
		expect(runner.isRunning()).toBe(false);
	});

	it("startBlockLoop is idempotent", () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);
		runner.startBlockLoop();
		runner.startBlockLoop(); // should not throw or create duplicate
		expect(runner.isRunning()).toBe(true);
		runner.stopBlockLoop();
	});

	it("onBlock callback fires", () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);

		let received = false;
		runner.onBlock = () => { received = true; };
		runner.tryProduceBlock();
		expect(received).toBe(true);
	});

	it("onLog callback fires", () => {
		const logs: string[] = [];
		runner.onLog = (msg) => logs.push(msg);
		runner.setIdentity(identity);
		runner.initChain([identity.did]);
		expect(logs.length).toBeGreaterThan(0);
	});

	it("syncFromPeers returns 0 (genesis only)", async () => {
		runner.setIdentity(identity);
		runner.initChain([identity.did]);
		const synced = await runner.syncFromPeers();
		expect(synced).toBe(0);
	});

	it("throws submitTransaction before init", () => {
		runner.setIdentity(identity);
		expect(() =>
			runner.submitTransaction({
				type: "transfer", from: "a", to: "b",
				amount: 1n, nonce: 0, timestamp: 0,
				signature: new Uint8Array(64),
			}),
		).toThrow("not initialized");
	});

	it("tryProduceBlock returns null before init", () => {
		runner.setIdentity(identity);
		expect(runner.tryProduceBlock()).toBeNull();
	});

	it("getGossip returns null before init", () => {
		expect(runner.getGossip()).toBeNull();
	});
});

describe("formatStatus", () => {
	it("formats status for console", () => {
		const output = formatStatus({
			did: "did:key:z6MkTestDID1234567890abcdef",
			mode: "validator",
			chainHeight: 42,
			peersConnected: 5,
			isValidator: true,
			blocksProduced: 10,
			storageUsedBytes: 0,
			storageCapacityBytes: 10737418240,
			balance: 100n,
			uptime: 3600000,
		});
		expect(output).toContain("ENSOUL NODE STATUS");
		expect(output).toContain("validator");
	});

	it("formats uptime correctly", () => {
		const short = formatStatus({
			did: "did:test", mode: "fullnode", chainHeight: 0,
			peersConnected: 0, isValidator: false, blocksProduced: 0,
			storageUsedBytes: 0, storageCapacityBytes: 0, balance: 0n, uptime: 5000,
		});
		expect(short).toContain("5s");

		const medium = formatStatus({
			did: "did:test", mode: "fullnode", chainHeight: 0,
			peersConnected: 0, isValidator: false, blocksProduced: 0,
			storageUsedBytes: 0, storageCapacityBytes: 0, balance: 0n, uptime: 120000,
		});
		expect(medium).toContain("2m");

		const long = formatStatus({
			did: "did:test", mode: "fullnode", chainHeight: 0,
			peersConnected: 0, isValidator: false, blocksProduced: 0,
			storageUsedBytes: 0, storageCapacityBytes: 0, balance: 0n, uptime: 7200000,
		});
		expect(long).toContain("2h");
	});
});
