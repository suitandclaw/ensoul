import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ClusterConfig,
	ClusterPidFile,
	ProcessEntry,
	SerializedGenesisConfig,
	ValidatorConfig,
	ValidatorStatus,
	WorkerMessage,
	WorkerStartMessage,
} from "./types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_MODULE = join(MODULE_DIR, "worker.js");

// ── Child handle abstraction (for testability) ──────────────────────

/** Abstraction over a child process for testability. */
export interface ChildHandle {
	readonly pid: number;
	send(msg: WorkerStartMessage): void;
	kill(signal?: string): void;
	onExit(cb: (code: number | null) => void): void;
	onMessage(cb: (msg: unknown) => void): void;
	onError(cb: (err: Error) => void): void;
	readonly connected: boolean;
}

/** Factory function that creates a ChildHandle. */
export type SpawnFn = () => ChildHandle;

/**
 * Wrap a Node.js ChildProcess into a ChildHandle.
 */
export function wrapChildProcess(child: ChildProcess): ChildHandle {
	return {
		get pid() {
			return child.pid ?? 0;
		},
		send(msg: WorkerStartMessage) {
			child.send(msg);
		},
		kill(signal = "SIGTERM") {
			try {
				child.kill(signal as NodeJS.Signals);
			} catch {
				// Process may already be dead
			}
		},
		onExit(cb: (code: number | null) => void) {
			child.on("exit", cb);
		},
		onMessage(cb: (msg: unknown) => void) {
			child.on("message", cb);
		},
		onError(cb: (err: Error) => void) {
			child.on("error", cb);
		},
		get connected() {
			return child.connected;
		},
	};
}

// ── Internal process tracking ────────────────────────────────────────

interface ManagedValidator {
	config: ValidatorConfig;
	handle: ChildHandle | null;
	restarts: number;
	blocksProduced: number;
	chainHeight: number;
	startedAt: number;
	stopping: boolean;
}

// ── ProcessManager ───────────────────────────────────────────────────

/**
 * Process manager for a cluster of validators.
 * Spawns, monitors, restarts, and gracefully shuts down validator processes.
 */
export class ProcessManager {
	/** Delay before restarting a crashed validator (ms). */
	restartDelayMs = 2000;
	/** Maximum restart attempts per validator before giving up. */
	maxRestarts = 5;
	/** Timeout for graceful shutdown before force killing (ms). */
	shutdownTimeoutMs = 5000;
	/** Delay after starting bootstrap peer before starting others (ms). */
	bootstrapDelayMs = 500;

	private managed: Map<number, ManagedValidator> = new Map();
	private clusterConfig: ClusterConfig | null = null;
	private dataDir = "";
	private spawnFn: SpawnFn | null = null;
	private genesisOverride: SerializedGenesisConfig | null = null;

	/**
	 * Set a custom spawn function (for testing).
	 */
	setSpawnFn(fn: SpawnFn): void {
		this.spawnFn = fn;
	}

	/**
	 * Start all validators in the cluster.
	 * Validator-0 starts first as the bootstrap peer, then the rest follow.
	 */
	async startAll(
		config: ClusterConfig,
		dataDir: string,
		genesisOverride?: SerializedGenesisConfig,
		log: (msg: string) => void = () => undefined,
	): Promise<void> {
		this.clusterConfig = config;
		this.dataDir = dataDir;
		if (genesisOverride) {
			this.genesisOverride = genesisOverride;
		}

		const genesis = this.genesisOverride ?? config.genesis;
		const validatorDids = config.validators.map((v) => v.did);

		// Start validator-0 first (bootstrap peer)
		const bootstrap = config.validators[0];
		if (!bootstrap) throw new Error("No validators in config");

		log(`Starting bootstrap validator-0: ${bootstrap.did}`);
		await this.spawnValidator(bootstrap, genesis, validatorDids, log);

		// Brief delay for bootstrap to initialize
		await delay(this.bootstrapDelayMs);

		// Start remaining validators
		for (let i = 1; i < config.validators.length; i++) {
			const v = config.validators[i];
			if (!v) continue;
			log(`Starting validator-${i}: ${v.did}`);
			await this.spawnValidator(v, genesis, validatorDids, log);
		}

		// Save PID file
		await this.savePidFile();
		log(`All ${config.validators.length} validators started`);
	}

	/**
	 * Stop all validators gracefully.
	 * Sends SIGTERM, waits for shutdown timeout, then SIGKILL if needed.
	 */
	async stopAll(
		log: (msg: string) => void = () => undefined,
	): Promise<void> {
		log("Stopping all validators...");

		// Mark all as stopping and send SIGTERM
		for (const [index, mv] of this.managed) {
			mv.stopping = true;
			if (mv.handle?.connected) {
				log(
					`Sending SIGTERM to validator-${index} (pid ${mv.handle.pid})`,
				);
				mv.handle.kill("SIGTERM");
			}
		}

		// Wait for graceful shutdown
		const deadline = Date.now() + this.shutdownTimeoutMs;
		while (Date.now() < deadline) {
			const alive = [...this.managed.values()].filter(
				(mv) => mv.handle !== null,
			);
			if (alive.length === 0) break;
			await delay(100);
		}

		// Force kill any remaining processes
		for (const [index, mv] of this.managed) {
			if (mv.handle) {
				log(
					`Force killing validator-${index} (pid ${mv.handle.pid})`,
				);
				mv.handle.kill("SIGKILL");
				mv.handle = null;
			}
		}

		// Clean up PID file
		try {
			await unlink(join(this.dataDir, "cluster.pid"));
		} catch {
			// PID file may not exist
		}

		this.managed.clear();
		log("All validators stopped");
	}

	/**
	 * Get status of all managed validators.
	 */
	getStatuses(): ValidatorStatus[] {
		const statuses: ValidatorStatus[] = [];

		for (const [, mv] of this.managed) {
			const isRunning = mv.handle !== null && mv.handle.connected;
			const uptime = isRunning ? Date.now() - mv.startedAt : 0;

			statuses.push({
				index: mv.config.index,
				did: mv.config.did,
				didShort: shortenDid(mv.config.did),
				port: mv.config.port,
				apiPort: mv.config.apiPort,
				status: isRunning ? "running" : "stopped",
				pid: mv.handle?.pid ?? null,
				blocksProduced: mv.blocksProduced,
				uptime: formatUptime(uptime),
			});
		}

		return statuses;
	}

	/**
	 * Get count of currently running validator processes.
	 */
	getRunningCount(): number {
		return [...this.managed.values()].filter(
			(mv) => mv.handle !== null && mv.handle.connected,
		).length;
	}

	// ── Internal ─────────────────────────────────────────────────

	private async spawnValidator(
		config: ValidatorConfig,
		genesis: SerializedGenesisConfig,
		validatorDids: string[],
		log: (msg: string) => void,
	): Promise<void> {
		const handle = this.spawnFn
			? this.spawnFn()
			: this.defaultSpawn();

		const mv: ManagedValidator = {
			config,
			handle,
			restarts: this.managed.get(config.index)?.restarts ?? 0,
			blocksProduced: 0,
			chainHeight: 0,
			startedAt: Date.now(),
			stopping: false,
		};

		this.managed.set(config.index, mv);

		// Handle status messages from worker
		handle.onMessage((raw: unknown) => {
			const msg = raw as WorkerMessage;
			if (msg.type === "status") {
				mv.blocksProduced = msg.blocksProduced;
				mv.chainHeight = msg.chainHeight;
			}
		});

		// Handle unexpected exits with auto-restart
		handle.onExit((code: number | null) => {
			log(
				`validator-${config.index} exited with code ${String(code)}`,
			);
			mv.handle = null;

			if (!mv.stopping && mv.restarts < this.maxRestarts) {
				mv.restarts++;
				log(
					`Restarting validator-${config.index} (attempt ${mv.restarts}/${this.maxRestarts})`,
				);
				setTimeout(() => {
					if (!mv.stopping) {
						void this.spawnValidator(
							config,
							genesis,
							validatorDids,
							log,
						);
					}
				}, this.restartDelayMs);
			}
		});

		handle.onError((err: Error) => {
			log(`validator-${config.index} error: ${err.message}`);
		});

		// Read seed and send start message to worker
		const seedHex = await readFile(
			join(config.dataDir, "seed.hex"),
			"utf-8",
		);

		const startMsg: WorkerStartMessage = {
			type: "start",
			seed: seedHex,
			port: config.port,
			apiPort: config.apiPort,
			bootstrapPeer: this.clusterConfig?.bootstrapPeer ?? "",
			dataDir: config.dataDir,
			genesis,
			validatorDids,
		};

		handle.send(startMsg);
	}

	private defaultSpawn(): ChildHandle {
		const child = fork(WORKER_MODULE, [], {
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});
		return wrapChildProcess(child);
	}

	private async savePidFile(): Promise<void> {
		const entries: ProcessEntry[] = [];

		for (const [, mv] of this.managed) {
			if (mv.handle) {
				entries.push({
					index: mv.config.index,
					did: mv.config.did,
					pid: mv.handle.pid,
					startedAt: mv.startedAt,
				});
			}
		}

		const pidFile: ClusterPidFile = {
			processes: entries,
			startedAt: Date.now(),
		};

		await writeFile(
			join(this.dataDir, "cluster.pid"),
			JSON.stringify(pidFile, null, 2),
		);
	}
}

// ── Status display ───────────────────────────────────────────────────

/**
 * Format validator statuses as an ASCII table.
 */
export function formatStatusTable(statuses: ValidatorStatus[]): string {
	const header =
		"+---------+----------------------+-------+-------+---------+--------+----------+\n" +
		"| Index   | DID                  | Port  | API   | Status  | Blocks | Uptime   |\n" +
		"+---------+----------------------+-------+-------+---------+--------+----------+";

	const rows = statuses.map(
		(s) =>
			`| ${String(s.index).padEnd(7)} | ${s.didShort.padEnd(20)} | ${String(s.port).padEnd(5)} | ${String(s.apiPort).padEnd(5)} | ${s.status.padEnd(7)} | ${String(s.blocksProduced).padEnd(6)} | ${s.uptime.padEnd(8)} |`,
	);

	const footer =
		"+---------+----------------------+-------+-------+---------+--------+----------+";

	return [header, ...rows, footer].join("\n");
}

/**
 * Load cluster config and check process status from PID file.
 * Uses kill(pid, 0) to probe whether each process is alive.
 */
export async function loadClusterStatus(
	dataDir: string,
): Promise<ValidatorStatus[]> {
	const configPath = join(dataDir, "cluster.json");
	const pidPath = join(dataDir, "cluster.pid");

	const configContent = await readFile(configPath, "utf-8");
	const config = JSON.parse(configContent) as ClusterConfig;

	let pidFile: ClusterPidFile | null = null;
	try {
		const pidContent = await readFile(pidPath, "utf-8");
		pidFile = JSON.parse(pidContent) as ClusterPidFile;
	} catch {
		// No PID file means all stopped
	}

	return config.validators.map((v): ValidatorStatus => {
		const proc = pidFile?.processes.find((p) => p.index === v.index);
		let isRunning = false;

		if (proc) {
			try {
				process.kill(proc.pid, 0);
				isRunning = true;
			} catch {
				isRunning = false;
			}
		}

		const uptime =
			isRunning && proc ? Date.now() - proc.startedAt : 0;

		return {
			index: v.index,
			did: v.did,
			didShort: shortenDid(v.did),
			port: v.port,
			apiPort: v.apiPort,
			status: isRunning ? "running" : "stopped",
			pid: proc?.pid ?? null,
			blocksProduced: 0,
			uptime: formatUptime(uptime),
		};
	});
}

// ── Helpers ──────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Shorten a DID for display (first 12 + last 6 chars).
 */
export function shortenDid(did: string): string {
	if (did.length <= 20) return did;
	return `${did.slice(0, 12)}...${did.slice(-6)}`;
}

/**
 * Format milliseconds as a human-readable uptime string.
 */
export function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h ${m % 60}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}
