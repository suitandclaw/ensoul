import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity, bytesToHex, hexToBytes } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { createDefaultGenesis } from "@ensoul/ledger";
import type { GenesisConfig, Block, Transaction } from "@ensoul/ledger";
import { NodeBlockProducer } from "../chain/producer.js";
import { GossipNetwork } from "../chain/gossip.js";
import { expandHome } from "./args.js";
import type { CliArgs } from "./args.js";
import type { ChainNodeConfig } from "../chain/types.js";

/** Persisted identity file format (encrypted or legacy plaintext). */
interface PersistedIdentity {
	seed?: string;
	publicKey: string;
	did: string;
	encrypted?: string;
	nonce?: string;
	salt?: string;
}

/**
 * Status snapshot of a running node.
 */
export interface NodeStatus {
	did: string;
	mode: "validator" | "fullnode";
	chainHeight: number;
	peersConnected: number;
	isValidator: boolean;
	blocksProduced: number;
	storageUsedBytes: number;
	storageCapacityBytes: number;
	balance: bigint;
	uptime: number;
}

/**
 * Node runner: orchestrates identity, chain, storage, and networking.
 * This is the core logic behind the CLI, extracted for testability.
 */
export class EnsoulNodeRunner {
	private identity: AgentIdentity | null = null;
	private gossip: GossipNetwork | null = null;
	private producer: NodeBlockProducer | null = null;
	private genesisConfig: GenesisConfig;
	private chainConfig: Partial<ChainNodeConfig>;
	private args: CliArgs;
	private startedAt = 0;
	private blocksProduced = 0;
	private running = false;
	private blockTimer: ReturnType<typeof setTimeout> | null = null;

	/** Event callbacks for external wiring (tests, logging). */
	onLog: ((msg: string) => void) | null = null;
	onBlock: ((block: Block) => void) | null = null;

	constructor(
		args: CliArgs,
		genesisConfig?: GenesisConfig,
		chainConfig?: Partial<ChainNodeConfig>,
	) {
		this.args = args;
		this.genesisConfig =
			genesisConfig ?? createDefaultGenesis();
		this.chainConfig = chainConfig ?? {};
	}

	/**
	 * Step 1: Load identity from disk or generate a new one.
	 * Identity is persisted to {dataDir}/identity.json.
	 * If ENSOUL_KEY_PASSWORD is set, the seed is encrypted at rest using
	 * scrypt + NaCl secretbox. If not set, seed is stored in plaintext
	 * with a warning (for automated/testnet use).
	 */
	async initIdentity(): Promise<AgentIdentity> {
		const dataDir = expandHome(this.args.dataDir);
		await mkdir(dataDir, { recursive: true });
		const idPath = join(dataDir, "identity.json");
		const password = process.env["ENSOUL_KEY_PASSWORD"] ?? "";

		try {
			const raw = await readFile(idPath, "utf-8");
			const stored = JSON.parse(raw) as PersistedIdentity;

			if (stored.encrypted && stored.nonce && stored.salt) {
				// Encrypted format: decrypt with password
				if (!password) {
					this.log(
						"WARNING: identity.json is encrypted but ENSOUL_KEY_PASSWORD is not set",
					);
					throw new Error("Password required");
				}
				const { loadIdentity: loadId } = await import("@ensoul/identity");
				this.identity = await loadId(
					{
						encrypted: hexToBytes(stored.encrypted),
						nonce: hexToBytes(stored.nonce),
						salt: hexToBytes(stored.salt),
					},
					password,
				);
				this.log(`Loaded encrypted identity: ${this.identity.did}`);
				return this.identity;
			}

			if (stored.seed) {
				// Legacy plaintext format: load and migrate if password available
				const seed = hexToBytes(stored.seed);
				this.identity = await createIdentity({ seed });
				this.log(`Loaded identity from disk: ${this.identity.did}`);

				if (password) {
					// Migrate: encrypt the plaintext seed
					const bundle = await this.identity.export(password);
					const encrypted: PersistedIdentity = {
						publicKey: this.identity.toJSON().publicKey,
						did: this.identity.did,
						encrypted: bytesToHex(bundle.encrypted),
						nonce: bytesToHex(bundle.nonce),
						salt: bytesToHex(bundle.salt),
					};
					await writeFile(idPath, JSON.stringify(encrypted, null, 2));
					this.log("Migrated identity to encrypted storage");
				} else {
					this.log(
						"WARNING: identity stored in plaintext. Set ENSOUL_KEY_PASSWORD to encrypt.",
					);
				}

				return this.identity;
			}

			throw new Error("Invalid identity file");
		} catch {
			// File does not exist or is invalid, generate new
		}

		// Generate new identity
		const { randomBytes } = await import("node:crypto");
		const seed = new Uint8Array(randomBytes(32));
		this.identity = await createIdentity({ seed });

		if (password) {
			// Save encrypted
			const bundle = await this.identity.export(password);
			const persisted: PersistedIdentity = {
				publicKey: this.identity.toJSON().publicKey,
				did: this.identity.did,
				encrypted: bytesToHex(bundle.encrypted),
				nonce: bytesToHex(bundle.nonce),
				salt: bytesToHex(bundle.salt),
			};
			await writeFile(idPath, JSON.stringify(persisted, null, 2));
			this.log(
				`Created new identity: ${this.identity.did} (encrypted, saved to ${idPath})`,
			);
		} else {
			// Save plaintext with warning
			const persisted: PersistedIdentity = {
				seed: bytesToHex(seed),
				publicKey: this.identity.toJSON().publicKey,
				did: this.identity.did,
			};
			await writeFile(idPath, JSON.stringify(persisted, null, 2));
			this.log(
				`Created new identity: ${this.identity.did} (saved to ${idPath})`,
			);
			this.log(
				"WARNING: identity stored in plaintext. Set ENSOUL_KEY_PASSWORD to encrypt.",
			);
		}

		return this.identity;
	}

	/**
	 * Set identity externally (for testing).
	 */
	setIdentity(identity: AgentIdentity): void {
		this.identity = identity;
	}

	/**
	 * Step 2: Initialize chain and genesis.
	 */
	initChain(validatorDids: string[]): void {
		this.producer = new NodeBlockProducer(
			this.genesisConfig,
			this.chainConfig,
		);
		this.producer.initGenesis(validatorDids);
		this.gossip = new GossipNetwork(this.producer);

		this.gossip.onBroadcastBlock = (block) => {
			// In production, send to libp2p peers
			this.log(`Broadcasting block ${block.height}`);
		};
		this.gossip.onBroadcastTx = () => {
			// In production, send to libp2p peers
		};

		this.log(
			`Chain initialized at height ${this.producer.getHeight()}`,
		);
	}

	/**
	 * Step 3: Sync chain from peers.
	 * In production, connects to bootstrap peers and downloads blocks.
	 * Returns the number of blocks synced.
	 */
	async syncFromPeers(): Promise<number> {
		// In a real implementation, this would:
		// 1. Connect to bootstrap peers via libp2p
		// 2. Request blocks from genesis via BlockSync
		// 3. Apply each block to local state
		this.log(
			`Syncing from ${this.args.bootstrapPeers.length} bootstrap peers...`,
		);
		// For now, return 0 (genesis only)
		return 0;
	}

	/**
	 * Step 4: Submit a transaction to the local mempool.
	 */
	submitTransaction(tx: Transaction): string | null {
		if (!this.gossip) throw new Error("Node not initialized");
		return this.gossip.submitTransaction(tx);
	}

	/**
	 * Step 5: Try to produce a block (if this node is the current proposer).
	 */
	tryProduceBlock(): Block | null {
		if (!this.gossip || !this.identity) return null;

		const block = this.gossip.tryProduceBlock(this.identity.did);
		if (block) {
			this.blocksProduced++;
			this.log(
				`Produced block ${block.height} with ${block.transactions.length} txs`,
			);
			if (this.onBlock) this.onBlock(block);
		}
		return block;
	}

	/**
	 * Start the block production loop.
	 * Uses adaptive block time (6s min, 60s max).
	 */
	startBlockLoop(): void {
		if (this.running) return;
		this.running = true;
		this.startedAt = Date.now();

		const scheduleNext = (): void => {
			if (!this.running) return;
			const mempoolSize =
				this.producer?.getMempool().readySize ?? 0;
			// Adaptive: 6s with txs, stretch up to 60s when empty
			const interval =
				mempoolSize > 0 ? 6000 : Math.min(60000, 6000 * 2);

			this.blockTimer = setTimeout(() => {
				this.tryProduceBlock();
				scheduleNext();
			}, interval);
		};

		scheduleNext();
		this.log(
			`Block production loop started (mode: ${this.args.mode})`,
		);
	}

	/**
	 * Stop the block production loop.
	 */
	stopBlockLoop(): void {
		this.running = false;
		if (this.blockTimer) {
			clearTimeout(this.blockTimer);
			this.blockTimer = null;
		}
		this.log("Block production loop stopped");
	}

	/**
	 * Get the current node status.
	 */
	getStatus(): NodeStatus {
		return {
			did: this.identity?.did ?? "not initialized",
			mode: this.args.mode === "validate" ? "validator" : "fullnode",
			chainHeight: this.producer?.getHeight() ?? -1,
			peersConnected: 0, // TODO: wire to libp2p
			isValidator: this.args.mode === "validate",
			blocksProduced: this.blocksProduced,
			storageUsedBytes: 0,
			storageCapacityBytes:
				this.args.storageGB * 1024 * 1024 * 1024,
			balance: 0n,
			uptime:
				this.startedAt > 0 ? Date.now() - this.startedAt : 0,
		};
	}

	/**
	 * Get the gossip network (for testing).
	 */
	getGossip(): GossipNetwork | null {
		return this.gossip;
	}

	/**
	 * Get the block producer (for testing).
	 */
	getProducer(): NodeBlockProducer | null {
		return this.producer;
	}

	/**
	 * Is the node running?
	 */
	isRunning(): boolean {
		return this.running;
	}

	// ── Internal ─────────────────────────────────────────────────

	private log(msg: string): void {
		if (this.onLog) this.onLog(msg);
	}
}

/**
 * Format a NodeStatus for console output.
 */
export function formatStatus(status: NodeStatus): string {
	const lines = [
		"┌─────────────────────────────────────┐",
		"│       ENSOUL NODE STATUS            │",
		"├─────────────────────────────────────┤",
		`│ DID:      ${status.did.slice(0, 30)}...│`,
		`│ Mode:     ${status.mode.padEnd(25)}│`,
		`│ Height:   ${String(status.chainHeight).padEnd(25)}│`,
		`│ Peers:    ${String(status.peersConnected).padEnd(25)}│`,
		`│ Blocks:   ${String(status.blocksProduced).padEnd(25)}│`,
		`│ Uptime:   ${formatUptime(status.uptime).padEnd(25)}│`,
		"└─────────────────────────────────────┘",
	];
	return lines.join("\n");
}

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h ${m % 60}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}
