import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createIdentity, hexToBytes } from "@ensoul/identity";
import { validateGenesis } from "@ensoul/ledger";
import {
	parseClusterArgs,
	printClusterHelp,
	initCluster,
	createClusterGenesis,
	mergeGenesisDids,
	serializeGenesis,
	deserializeGenesis,
	ProcessManager,
	formatStatusTable,
	formatUptime,
	shortenDid,
	loadClusterStatus,
} from "../src/index.js";
import type {
	ClusterConfig,
	DIDExport,
	ValidatorStatus,
	ChildHandle,
	WorkerStartMessage,
	WorkerStatusMessage,
} from "../src/index.js";

const DECIMALS = 10n ** 18n;

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "ensoul-cluster-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

// ── CLI Parsing ──────────────────────────────────────────────────────

describe("parseClusterArgs", () => {
	it("defaults to help command", () => {
		const cmd = parseClusterArgs([]);
		expect(cmd.command).toBe("help");
		expect(cmd.validators).toBe(10);
		expect(cmd.basePort).toBe(9000);
		expect(cmd.advertiseHost).toBe("127.0.0.1");
	});

	it("parses init command with all options", () => {
		const cmd = parseClusterArgs([
			"init",
			"--validators",
			"5",
			"--base-port",
			"8000",
			"--data-dir",
			"/data/ensoul",
			"--advertise-host",
			"192.168.1.10",
			"--export-dids",
			"dids.json",
			"--stake",
			"5000",
		]);
		expect(cmd.command).toBe("init");
		expect(cmd.validators).toBe(5);
		expect(cmd.basePort).toBe(8000);
		expect(cmd.dataDir).toBe("/data/ensoul");
		expect(cmd.advertiseHost).toBe("192.168.1.10");
		expect(cmd.exportDids).toBe("dids.json");
		expect(cmd.stakePerValidator).toBe(5000n * DECIMALS);
	});

	it("parses start command with data-dir", () => {
		const cmd = parseClusterArgs([
			"start",
			"--data-dir",
			"/data/ensoul",
		]);
		expect(cmd.command).toBe("start");
		expect(cmd.dataDir).toBe("/data/ensoul");
	});

	it("parses start with genesis override", () => {
		const cmd = parseClusterArgs([
			"start",
			"--data-dir",
			"/data",
			"--genesis",
			"genesis.json",
		]);
		expect(cmd.command).toBe("start");
		expect(cmd.genesisFile).toBe("genesis.json");
	});

	it("parses stop command", () => {
		expect(parseClusterArgs(["stop"]).command).toBe("stop");
	});

	it("parses status command", () => {
		expect(parseClusterArgs(["status"]).command).toBe("status");
	});

	it("parses genesis command with imports", () => {
		const cmd = parseClusterArgs([
			"genesis",
			"--import",
			"dids1.json,dids2.json,dids3.json",
			"--output",
			"genesis.json",
		]);
		expect(cmd.command).toBe("genesis");
		expect(cmd.importFiles).toEqual([
			"dids1.json",
			"dids2.json",
			"dids3.json",
		]);
		expect(cmd.outputFile).toBe("genesis.json");
	});

	it("parses help variants", () => {
		expect(parseClusterArgs(["help"]).command).toBe("help");
		expect(parseClusterArgs(["--help"]).command).toBe("help");
		expect(parseClusterArgs(["-h"]).command).toBe("help");
	});
});

describe("printClusterHelp", () => {
	it("returns help text with all commands and options", () => {
		const help = printClusterHelp();
		expect(help).toContain("ensoul-cluster");
		expect(help).toContain("init");
		expect(help).toContain("start");
		expect(help).toContain("stop");
		expect(help).toContain("status");
		expect(help).toContain("genesis");
		expect(help).toContain("--validators");
		expect(help).toContain("--advertise-host");
		expect(help).toContain("--export-dids");
		expect(help).toContain("--import");
	});
});

// ── Genesis Serialization ────────────────────────────────────────────

describe("genesis serialization", () => {
	it("round-trips GenesisConfig through serialize/deserialize", () => {
		const original = createClusterGenesis(
			["did:key:z6MkTest1", "did:key:z6MkTest2"],
			10_000n * DECIMALS,
		);
		const serialized = serializeGenesis(original);
		const restored = deserializeGenesis(serialized);

		expect(restored.chainId).toBe(original.chainId);
		expect(restored.totalSupply).toBe(original.totalSupply);
		expect(restored.emissionPerBlock).toBe(original.emissionPerBlock);
		expect(restored.allocations.length).toBe(
			original.allocations.length,
		);
		expect(restored.protocolFees.txBaseFee).toBe(
			original.protocolFees.txBaseFee,
		);
	});

	it("produces JSON-safe output (no BigInt)", () => {
		const genesis = createClusterGenesis(
			["did:key:z6MkTest"],
			10_000n * DECIMALS,
		);
		const serialized = serializeGenesis(genesis);
		const json = JSON.stringify(serialized);
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(typeof parsed["totalSupply"]).toBe("string");
	});

	it("preserves per-validator allocation details", () => {
		const genesis = createClusterGenesis(
			["did:key:z6MkA", "did:key:z6MkB"],
			10_000n * DECIMALS,
		);
		const serialized = serializeGenesis(genesis);
		const restored = deserializeGenesis(serialized);

		const validatorAllocs = restored.allocations.filter(
			(a) => a.label === "Validator Stake",
		);
		expect(validatorAllocs.length).toBe(2);
		expect(validatorAllocs[0]?.tokens).toBe(10_000n * DECIMALS);
		expect(validatorAllocs[0]?.recipient).toBe("did:key:z6MkA");
		expect(validatorAllocs[1]?.recipient).toBe("did:key:z6MkB");
	});
});

// ── Cluster Genesis Creation ─────────────────────────────────────────

describe("createClusterGenesis", () => {
	it("creates valid genesis with validator stakes", () => {
		const dids = ["did:key:z6Mk1", "did:key:z6Mk2", "did:key:z6Mk3"];
		const genesis = createClusterGenesis(dids, 10_000n * DECIMALS);
		expect(validateGenesis(genesis).valid).toBe(true);
	});

	it("includes validator allocations at 0% percentage", () => {
		const dids = ["did:key:z6Mk1", "did:key:z6Mk2"];
		const genesis = createClusterGenesis(dids, 10_000n * DECIMALS);

		const validatorAllocs = genesis.allocations.filter(
			(a) => a.label === "Validator Stake",
		);
		expect(validatorAllocs.length).toBe(2);
		for (const a of validatorAllocs) {
			expect(a.percentage).toBe(0);
			expect(a.tokens).toBe(10_000n * DECIMALS);
		}
	});

	it("reduces Foundation allocation by total validator stake", () => {
		const dids = ["did:key:z6Mk1", "did:key:z6Mk2"];
		const stake = 10_000n * DECIMALS;
		const genesis = createClusterGenesis(dids, stake);

		const foundation = genesis.allocations.find(
			(a) => a.label === "Foundation Validators",
		);
		expect(foundation).toBeDefined();
		expect(foundation?.tokens).toBe(
			150_000_000n * DECIMALS - 2n * stake,
		);
	});

	it("throws if total stake exceeds Foundation allocation", () => {
		const dids = Array.from(
			{ length: 20000 },
			(_, i) => `did:key:z6Mk${i}`,
		);
		expect(() =>
			createClusterGenesis(dids, 10_000n * DECIMALS),
		).toThrow("exceeds Foundation allocation");
	});

	it("handles 35 validators (real deployment scenario)", () => {
		const dids = Array.from(
			{ length: 35 },
			(_, i) => `did:key:z6Mk${i}`,
		);
		const genesis = createClusterGenesis(dids, 10_000n * DECIMALS);
		expect(validateGenesis(genesis).valid).toBe(true);
		// 7 standard allocations + 35 validator stakes
		expect(genesis.allocations.length).toBe(42);
	});
});

// ── Cluster Init ─────────────────────────────────────────────────────

describe("initCluster", () => {
	it("creates validator directories", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 3,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const { access } = await import("node:fs/promises");
		for (let i = 0; i < 3; i++) {
			await expect(
				access(join(dataDir, `validator-${i}`)),
			).resolves.toBeUndefined();
		}
	});

	it("generates unique identities for each validator", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 5,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const dids = new Set(result.config.validators.map((v) => v.did));
		expect(dids.size).toBe(5);
	});

	it("saves seed files to each validator directory", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 2,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const seed0 = await readFile(
			join(dataDir, "validator-0", "seed.hex"),
			"utf-8",
		);
		expect(seed0.length).toBe(64); // 32 bytes = 64 hex chars

		const seed1 = await readFile(
			join(dataDir, "validator-1", "seed.hex"),
			"utf-8",
		);
		expect(seed1).not.toBe(seed0);
	});

	it("saves identity.json with correct DID", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 1,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const idJson = JSON.parse(
			await readFile(
				join(dataDir, "validator-0", "identity.json"),
				"utf-8",
			),
		) as { did: string };
		expect(idJson.did).toBe(result.config.validators[0]?.did);
	});

	it("recreates identity from saved seed", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 1,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const seedHex = await readFile(
			join(dataDir, "validator-0", "seed.hex"),
			"utf-8",
		);
		const identity = await createIdentity({
			seed: hexToBytes(seedHex),
		});
		expect(identity.did).toBe(result.config.validators[0]?.did);
	});

	it("assigns correct P2P and API ports", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 3,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const vs = result.config.validators;
		expect(vs[0]?.port).toBe(9000);
		expect(vs[1]?.port).toBe(9001);
		expect(vs[2]?.port).toBe(9002);
		expect(vs[0]?.apiPort).toBe(10000);
		expect(vs[1]?.apiPort).toBe(10001);
		expect(vs[2]?.apiPort).toBe(10002);
	});

	it("designates validator-0 as bootstrap peer", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 3,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		expect(result.config.bootstrapPeer).toBe(
			"/ip4/127.0.0.1/tcp/9000",
		);
	});

	it("uses advertise-host in bootstrap peer multiaddr", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 1,
			basePort: 8000,
			dataDir,
			advertiseHost: "10.0.0.5",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		expect(result.config.bootstrapPeer).toBe(
			"/ip4/10.0.0.5/tcp/8000",
		);
	});

	it("writes cluster.json with correct structure", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 2,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const config = JSON.parse(
			await readFile(join(dataDir, "cluster.json"), "utf-8"),
		) as ClusterConfig;
		expect(config.version).toBe(1);
		expect(config.validators.length).toBe(2);
		expect(config.bootstrapPeer).toContain("/ip4/");
		expect(config.genesis.chainId).toBe("ensoul-cluster");
	});

	it("exports DID file when --export-dids is specified", async () => {
		const dataDir = join(tmpDir, "cluster");
		const exportPath = join(tmpDir, "dids.json");
		const result = await initCluster({
			validators: 2,
			basePort: 9000,
			dataDir,
			advertiseHost: "192.168.1.10",
			exportDids: exportPath,
			stakePerValidator: 10_000n * DECIMALS,
		});

		expect(result.didExport).not.toBeNull();

		const didExport = JSON.parse(
			await readFile(exportPath, "utf-8"),
		) as DIDExport;
		expect(didExport.advertiseHost).toBe("192.168.1.10");
		expect(didExport.validators.length).toBe(2);
	});

	it("genesis passes validation", async () => {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: 10,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const genesis = deserializeGenesis(result.config.genesis);
		expect(validateGenesis(genesis).valid).toBe(true);
	});
});

// ── Genesis Coordination ─────────────────────────────────────────────

describe("mergeGenesisDids", () => {
	it("merges multiple DID export files", async () => {
		const dids1: DIDExport = {
			advertiseHost: "192.168.1.10",
			validators: [
				{
					index: 0,
					did: "did:key:z6MkA",
					peerId: "pA",
					publicKey: "pkA",
					port: 9000,
					apiPort: 10000,
				},
				{
					index: 1,
					did: "did:key:z6MkB",
					peerId: "pB",
					publicKey: "pkB",
					port: 9001,
					apiPort: 10001,
				},
			],
		};
		const dids2: DIDExport = {
			advertiseHost: "192.168.1.11",
			validators: [
				{
					index: 0,
					did: "did:key:z6MkC",
					peerId: "pC",
					publicKey: "pkC",
					port: 9000,
					apiPort: 10000,
				},
			],
		};

		const file1 = join(tmpDir, "dids1.json");
		const file2 = join(tmpDir, "dids2.json");
		const output = join(tmpDir, "genesis.json");

		await writeFile(file1, JSON.stringify(dids1));
		await writeFile(file2, JSON.stringify(dids2));

		const genesis = await mergeGenesisDids({
			importFiles: [file1, file2],
			outputFile: output,
			stakePerValidator: 10_000n * DECIMALS,
		});

		expect(validateGenesis(genesis).valid).toBe(true);
		const validatorAllocs = genesis.allocations.filter(
			(a) => a.label === "Validator Stake",
		);
		expect(validatorAllocs.length).toBe(3);
	});

	it("writes genesis output file as JSON", async () => {
		const dids: DIDExport = {
			advertiseHost: "127.0.0.1",
			validators: [
				{
					index: 0,
					did: "did:key:z6MkX",
					peerId: "pX",
					publicKey: "pkX",
					port: 9000,
					apiPort: 10000,
				},
			],
		};

		const file = join(tmpDir, "dids.json");
		const output = join(tmpDir, "genesis.json");
		await writeFile(file, JSON.stringify(dids));

		await mergeGenesisDids({
			importFiles: [file],
			outputFile: output,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const content = JSON.parse(
			await readFile(output, "utf-8"),
		) as Record<string, unknown>;
		expect(content["chainId"]).toBe("ensoul-cluster");
	});

	it("simulates 4-machine deployment with 35 validators", async () => {
		const machines = [
			{
				host: "192.168.1.10",
				count: 10,
				prefix: "M1",
			},
			{
				host: "192.168.1.11",
				count: 10,
				prefix: "M2",
			},
			{
				host: "192.168.1.12",
				count: 10,
				prefix: "M3",
			},
			{
				host: "192.168.1.13",
				count: 5,
				prefix: "M4",
			},
		];

		const files: string[] = [];
		for (const machine of machines) {
			const didExport: DIDExport = {
				advertiseHost: machine.host,
				validators: Array.from({ length: machine.count }, (_, i) => ({
					index: i,
					did: `did:key:z6Mk${machine.prefix}V${i}`,
					peerId: `p${machine.prefix}${i}`,
					publicKey: `pk${machine.prefix}${i}`,
					port: 9000 + i,
					apiPort: 10000 + i,
				})),
			};
			const filePath = join(
				tmpDir,
				`dids-${machine.prefix.toLowerCase()}.json`,
			);
			await writeFile(filePath, JSON.stringify(didExport));
			files.push(filePath);
		}

		const output = join(tmpDir, "genesis.json");
		const genesis = await mergeGenesisDids({
			importFiles: files,
			outputFile: output,
			stakePerValidator: 10_000n * DECIMALS,
		});

		expect(validateGenesis(genesis).valid).toBe(true);

		const validatorAllocs = genesis.allocations.filter(
			(a) => a.label === "Validator Stake",
		);
		expect(validatorAllocs.length).toBe(35);

		// Foundation allocation reduced by 35 * 10,000 ENSL
		const foundation = genesis.allocations.find(
			(a) => a.label === "Foundation Validators",
		);
		expect(foundation).toBeDefined();
		const expectedRemaining =
			150_000_000n * DECIMALS - 35n * 10_000n * DECIMALS;
		expect(foundation?.tokens).toBe(expectedRemaining);
	});
});

// ── Process Management ───────────────────────────────────────────────

interface MockHandle {
	pid: number;
	sentMessages: WorkerStartMessage[];
	exitCb: ((code: number | null) => void) | null;
	msgCb: ((msg: unknown) => void) | null;
	errCb: ((err: Error) => void) | null;
	killed: boolean;
	killSignal: string | null;
	connected: boolean;
	send(msg: WorkerStartMessage): void;
	kill(signal?: string): void;
	onExit(cb: (code: number | null) => void): void;
	onMessage(cb: (msg: unknown) => void): void;
	onError(cb: (err: Error) => void): void;
}

function createMockHandle(): MockHandle {
	const handle: MockHandle = {
		pid: Math.floor(Math.random() * 100000) + 1000,
		sentMessages: [],
		exitCb: null,
		msgCb: null,
		errCb: null,
		killed: false,
		killSignal: null,
		connected: true,
		send(msg: WorkerStartMessage) {
			handle.sentMessages.push(msg);
		},
		kill(signal = "SIGTERM") {
			handle.killed = true;
			handle.killSignal = signal;
			handle.connected = false;
		},
		onExit(cb: (code: number | null) => void) {
			handle.exitCb = cb;
		},
		onMessage(cb: (msg: unknown) => void) {
			handle.msgCb = cb;
		},
		onError(cb: (err: Error) => void) {
			handle.errCb = cb;
		},
	};
	return handle;
}

describe("ProcessManager", () => {
	let manager: ProcessManager;
	let handles: MockHandle[];

	beforeEach(() => {
		manager = new ProcessManager();
		manager.restartDelayMs = 50;
		manager.maxRestarts = 5;
		manager.shutdownTimeoutMs = 300;
		manager.bootstrapDelayMs = 10;
		handles = [];
		manager.setSpawnFn(() => {
			const handle = createMockHandle();
			handles.push(handle);
			return handle;
		});
	});

	async function setupAndStart(
		validatorCount: number,
	): Promise<ClusterConfig> {
		const dataDir = join(tmpDir, "cluster");
		const result = await initCluster({
			validators: validatorCount,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		await manager.startAll(result.config, dataDir);
		return result.config;
	}

	it("spawns correct number of validator processes", async () => {
		await setupAndStart(3);
		expect(handles.length).toBe(3);
	});

	it("sends start message with correct config to each worker", async () => {
		await setupAndStart(2);

		expect(handles[0]?.sentMessages.length).toBe(1);
		expect(handles[0]?.sentMessages[0]?.type).toBe("start");
		expect(handles[0]?.sentMessages[0]?.port).toBe(9000);

		expect(handles[1]?.sentMessages.length).toBe(1);
		expect(handles[1]?.sentMessages[0]?.port).toBe(9001);
	});

	it("sends all validator DIDs to each worker", async () => {
		await setupAndStart(3);

		const msg = handles[0]?.sentMessages[0];
		expect(msg?.validatorDids.length).toBe(3);
	});

	it("includes seed in start message", async () => {
		await setupAndStart(1);

		const msg = handles[0]?.sentMessages[0];
		expect(msg?.seed).toBeTruthy();
		expect(msg?.seed.length).toBe(64); // 32 bytes hex
	});

	it("tracks running count correctly", async () => {
		await setupAndStart(3);
		expect(manager.getRunningCount()).toBe(3);
	});

	it("receives status updates from workers", async () => {
		await setupAndStart(2);

		const statusMsg: WorkerStatusMessage = {
			type: "status",
			chainHeight: 42,
			blocksProduced: 10,
		};
		handles[0]?.msgCb?.(statusMsg);

		const statuses = manager.getStatuses();
		expect(statuses[0]?.blocksProduced).toBe(10);
	});

	it("restarts crashed validator automatically", async () => {
		await setupAndStart(1);
		expect(handles.length).toBe(1);

		// Simulate unexpected exit
		handles[0]?.exitCb?.(1);

		// Wait for restart
		await vi.waitFor(() => {
			expect(handles.length).toBe(2);
		}, { timeout: 2000 });
	});

	it("stops restarting after max attempts", async () => {
		manager.maxRestarts = 2;
		await setupAndStart(1);

		// 1st crash → restart
		handles[handles.length - 1]?.exitCb?.(1);
		await vi.waitFor(
			() => expect(handles.length).toBe(2),
			{ timeout: 2000 },
		);

		// 2nd crash → restart
		handles[handles.length - 1]?.exitCb?.(1);
		await vi.waitFor(
			() => expect(handles.length).toBe(3),
			{ timeout: 2000 },
		);

		// 3rd crash → no restart (max 2)
		handles[handles.length - 1]?.exitCb?.(1);
		await new Promise((resolve) => {
			setTimeout(resolve, 200);
		});
		expect(handles.length).toBe(3);
	});

	it("graceful shutdown sends SIGTERM to all", async () => {
		await setupAndStart(3);

		// Make processes exit on SIGTERM
		for (const h of handles) {
			const origKill = h.kill.bind(h);
			h.kill = (signal = "SIGTERM") => {
				origKill(signal);
				setTimeout(() => h.exitCb?.(0), 10);
			};
		}

		await manager.stopAll();

		for (const h of handles) {
			expect(h.killed).toBe(true);
			expect(h.killSignal).toBe("SIGTERM");
		}
	});

	it("force kills after shutdown timeout", async () => {
		await setupAndStart(1);

		// Make the process ignore SIGTERM (simulate hung process)
		const h = handles[0]!;
		h.kill = (signal = "SIGTERM") => {
			h.killSignal = signal;
			if (signal === "SIGKILL") {
				h.connected = false;
			}
			// SIGTERM does NOT cause exit or disconnect
		};

		await manager.stopAll();

		// Should have escalated to SIGKILL
		expect(h.killSignal).toBe("SIGKILL");
	});

	it("does not restart validators during stop", async () => {
		await setupAndStart(2);
		const handleCountBeforeStop = handles.length;

		// Stop sets mv.stopping = true, preventing restarts
		for (const h of handles) {
			const origKill = h.kill.bind(h);
			h.kill = (signal = "SIGTERM") => {
				origKill(signal);
				setTimeout(() => h.exitCb?.(0), 10);
			};
		}

		await manager.stopAll();
		await new Promise((resolve) => {
			setTimeout(resolve, 200);
		});

		// No new handles spawned during/after stop
		expect(handles.length).toBe(handleCountBeforeStop);
	});
});

// ── Status Display ───────────────────────────────────────────────────

describe("formatStatusTable", () => {
	it("formats validator statuses as a table", () => {
		const statuses: ValidatorStatus[] = [
			{
				index: 0,
				did: "did:key:z6MkLongDIDString12345",
				didShort: "did:key:z6Mk...12345",
				port: 9000,
				apiPort: 10000,
				status: "running",
				pid: 12345,
				blocksProduced: 42,
				uptime: "1h 30m",
			},
			{
				index: 1,
				did: "did:key:z6MkAnotherDIDString",
				didShort: "did:key:z6Mk...tring",
				port: 9001,
				apiPort: 10001,
				status: "stopped",
				pid: null,
				blocksProduced: 0,
				uptime: "0s",
			},
		];

		const table = formatStatusTable(statuses);
		expect(table).toContain("Index");
		expect(table).toContain("DID");
		expect(table).toContain("Status");
		expect(table).toContain("running");
		expect(table).toContain("stopped");
		expect(table).toContain("9000");
		expect(table).toContain("10001");
	});

	it("handles empty status list", () => {
		const table = formatStatusTable([]);
		expect(table).toContain("Index");
		expect(table).toContain("DID");
	});
});

describe("formatUptime", () => {
	it("formats seconds", () => {
		expect(formatUptime(5000)).toBe("5s");
	});

	it("formats minutes", () => {
		expect(formatUptime(125000)).toBe("2m 5s");
	});

	it("formats hours", () => {
		expect(formatUptime(3_661_000)).toBe("1h 1m");
	});

	it("formats zero", () => {
		expect(formatUptime(0)).toBe("0s");
	});
});

describe("shortenDid", () => {
	it("shortens long DIDs", () => {
		const did = "did:key:z6MkhaXgBZDvotDkL5257faWxcsSqBrdR7g5gqjvroHyMjZ";
		const short = shortenDid(did);
		expect(short).toContain("...");
		expect(short.length).toBeLessThan(did.length);
	});

	it("keeps short DIDs unchanged", () => {
		expect(shortenDid("did:key:z6Mk")).toBe("did:key:z6Mk");
	});
});

// ── Load Cluster Status ──────────────────────────────────────────────

describe("loadClusterStatus", () => {
	it("reports all stopped when no PID file exists", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 3,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const statuses = await loadClusterStatus(dataDir);
		expect(statuses.length).toBe(3);
		for (const s of statuses) {
			expect(s.status).toBe("stopped");
			expect(s.pid).toBeNull();
		}
	});

	it("detects dead processes from stale PID file", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 2,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		// Write fake PID file with non-existent PIDs
		const pidFile = {
			processes: [
				{
					index: 0,
					did: "did:test",
					pid: 999999,
					startedAt: Date.now(),
				},
			],
			startedAt: Date.now(),
		};
		await writeFile(
			join(dataDir, "cluster.pid"),
			JSON.stringify(pidFile),
		);

		const statuses = await loadClusterStatus(dataDir);
		expect(statuses[0]?.status).toBe("stopped");
	});

	it("includes correct port information", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 2,
			basePort: 8000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const statuses = await loadClusterStatus(dataDir);
		expect(statuses[0]?.port).toBe(8000);
		expect(statuses[0]?.apiPort).toBe(9000);
		expect(statuses[1]?.port).toBe(8001);
		expect(statuses[1]?.apiPort).toBe(9001);
	});

	it("shortens DIDs in status output", async () => {
		const dataDir = join(tmpDir, "cluster");
		await initCluster({
			validators: 1,
			basePort: 9000,
			dataDir,
			advertiseHost: "127.0.0.1",
			exportDids: null,
			stakePerValidator: 10_000n * DECIMALS,
		});

		const statuses = await loadClusterStatus(dataDir);
		expect(statuses[0]?.didShort).toContain("...");
	});
});
