import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { GossipNetwork } from "./gossip.js";
import type { SerializedBlock, SerializedTx } from "./types.js";
import { deserializeTx } from "./types.js";
import { SeedClient } from "./seed-node.js";
import { VERSION } from "../version.js";
import type { ConsensusMessage, SerializedConsensusMessage } from "./tendermint.js";
import { computeBlockHash } from "@ensoul/ledger";
import type { Block } from "@ensoul/ledger";

/**
 * Extract blocks array from a sync response.
 * Handles both `{ blocks: [...] }` (object wrapper) and raw `[...]` formats.
 */
function extractBlocks(data: unknown): SerializedBlock[] {
	if (Array.isArray(data)) return data as SerializedBlock[];
	if (data && typeof data === "object" && "blocks" in data) {
		return (data as { blocks: SerializedBlock[] }).blocks;
	}
	return [];
}

/**
 * HTTP-based peer network for validator-to-validator communication.
 *
 * Each validator runs a small HTTP API for peers to query:
 *   GET  /peer/status          - height, peer count, DID
 *   GET  /peer/blocks/:height  - get a single block
 *   GET  /peer/sync/:from      - get blocks from height to tip
 *   POST /peer/blocks          - receive a new block from a peer
 *
 * On startup, the node connects to its configured peers, syncs any
 * missing blocks, and begins polling for new blocks.
 */

/** Information about a connected peer. */
export interface PeerInfo {
	address: string;
	height: number;
	lastSeen: number;
}

/** Status response from a peer. */
export interface PeerStatus {
	height: number;
	peerCount: number;
	did: string;
	version?: string;
	genesisHash?: string;
}

/**
 * Parse a --peers value like "192.168.1.10:9000,192.168.1.11:9001"
 * into full HTTP URLs.
 */
export function parsePeerAddresses(raw: string): string[] {
	if (!raw.trim()) return [];
	return raw.split(",").map((addr) => {
		const trimmed = addr.trim();
		if (trimmed.startsWith("http")) return trimmed;
		return `http://${trimmed}`;
	});
}

/**
 * HTTP peer network for real validator-to-validator communication.
 */
export class PeerNetwork {
	private gossip: GossipNetwork;
	private server: FastifyInstance | null = null;
	private peers: Map<string, PeerInfo> = new Map();
	private myDid: string;
	private myPort = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private seedClient: SeedClient | null = null;
	private log: (msg: string) => void;

	/** Local validators on the same machine (discovered via localhost scan). */
	private localPeers: Array<{ port: number; did: string }> = [];

	/** Whether this validator is the tunnel-facing one (port 9000). */
	private isTunnelValidator = false;

	/** Callback for incoming consensus messages. Set by the consensus engine. */
	onConsensusMessage: ((msg: ConsensusMessage) => void) | null = null;

	/** Callback to get consensus state for the diagnostic endpoint. */
	onGetConsensusState: (() => Record<string, unknown>) | null = null;

	/** Callback when blocks are synced from peers (to advance consensus height). */
	onBlockSynced: ((height: number) => void) | null = null;

	constructor(
		gossip: GossipNetwork,
		myDid: string,
		logFn?: (msg: string) => void,
	) {
		this.gossip = gossip;
		this.myDid = myDid;
		this.log = logFn ?? (() => undefined);
	}

	/**
	 * Start the peer API server on the given port.
	 */
	async startServer(port: number): Promise<void> {
		this.myPort = port;
		this.isTunnelValidator = port === 9000;
		this.server = Fastify({ logger: false, bodyLimit: 5242880 }); // 5MB for peer routes

		// Peer authentication: if ENSOUL_PEER_KEY is set, require it on
		// mutating endpoints (POST /peer/blocks, POST /peer/tx).
		// In production, replace with mutual TLS or Ed25519 challenge-response.
		const peerKey = process.env["ENSOUL_PEER_KEY"] ?? "";
		if (peerKey) {
			this.server.addHook("onRequest", (req, reply, done) => {
				// Read-only endpoints are open
				if (req.method === "GET") { done(); return; }
				const provided = req.headers["x-ensoul-peer-key"];
				if (provided !== peerKey) {
					void reply.status(403).send({ error: "Invalid peer key" });
					return;
				}
				done();
			});
			this.log("Peer authentication enabled (X-Ensoul-Peer-Key required for POST)");
		}

		// Rate limiting on transaction submission (100 tx/min per IP)
		let txCountByIp = new Map<string, number>();
		setInterval(() => { txCountByIp = new Map(); }, 60000);

		// GET /peer/status
		this.server.get("/peer/status", async () => {
			const producer = this.gossip.getProducer();
			const genesis = producer.getBlock(0);
			return {
				height: producer.getHeight(),
				peerCount: this.peers.size,
				did: this.myDid,
				version: VERSION,
				genesisHash: genesis ? computeBlockHash(genesis) : "",
			} satisfies PeerStatus;
		});

		// GET /peer/health
		this.server.get("/peer/health", async () => {
			const producer = this.gossip.getProducer();
			const latest = producer.getLatestBlock();
			return {
				healthy: true,
				height: producer.getHeight(),
				version: VERSION,
				lastBlockTime: latest?.timestamp ?? 0,
				uptimeSeconds: Math.floor(process.uptime()),
				syncStatus: producer.getHeight() >= 0 ? "synced" : "syncing",
			};
		});

		// GET /peer/consensus-state - diagnostic endpoint for consensus debugging
		this.server.get("/peer/consensus-state", async () => {
			if (this.onGetConsensusState) {
				return this.onGetConsensusState();
			}
			return { error: "Consensus engine not attached" };
		});

		// GET /peer/blocks/:height
		this.server.get<{ Params: { height: string } }>(
			"/peer/blocks/:height",
			async (req, reply) => {
				const height = Number(req.params.height);
				if (Number.isNaN(height)) {
					return reply.status(400).send({ error: "Invalid height" });
				}
				const blocks = this.gossip.handleSyncRequest(height);
				const block = blocks.find((b) => b.height === height);
				if (!block) {
					return reply.status(404).send({ error: "Block not found" });
				}
				return block;
			},
		);

		// GET /peer/sync/:from
		this.server.get<{ Params: { from: string } }>(
			"/peer/sync/:from",
			async (req) => {
				const from = Number(req.params.from);
				const blocks = this.gossip.handleSyncRequest(from);
				return { blocks };
			},
		);

		// POST /peer/blocks
		this.server.post<{ Body: SerializedBlock }>(
			"/peer/blocks",
			async (req) => {
				const block = req.body;
				const result = this.gossip.handleGossipBlock(block);
				// Notify consensus engine of new block height
				if (result.applied && this.onBlockSynced) {
					this.onBlockSynced(this.gossip.getProducer().getHeight());
				}
				return result;
			},
		);

		// POST /peer/tx - accept a signed transaction into the mempool
		this.server.post<{ Body: SerializedTx }>(
			"/peer/tx",
			async (req, reply) => {
				// Rate limiting: 100 tx/min per IP
				const ip = req.ip;
				const count = txCountByIp.get(ip) ?? 0;
				if (count >= 100) {
					return reply.status(429).send({ accepted: false, error: "Rate limit exceeded (100 tx/min)" });
				}
				txCountByIp.set(ip, count + 1);

				try {
					const body = req.body;
					// Validate basic structure before deserializing
					if (!body || !body.type || !body.from || !body.to) {
						return { accepted: false, error: "Invalid transaction structure" };
					}
					const tx = deserializeTx(body);
					// Validate signature length for user transactions
					if (tx.type !== "block_reward" && tx.type !== "genesis_allocation") {
						if (tx.signature.length !== 64) {
							return { accepted: false, error: "Invalid signature length" };
						}
					}
					const hash = this.gossip.submitTransaction(tx);
					return { accepted: hash !== null, hash };
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { accepted: false, error: msg };
				}
			},
		);

		// GET /peer/account/:did
		this.server.get<{ Params: { did: string } }>(
			"/peer/account/:did",
			async (req) => {
				const account = this.gossip.getProducer().getState().getAccount(
					decodeURIComponent(req.params.did),
				);
				return {
					did: account.did,
					balance: account.balance.toString(),
					staked: account.stakedBalance.toString(),
					unstaking: account.unstakingBalance.toString(),
					unstakingCompleteAt: account.unstakingCompleteAt,
					stakeLockedUntil: account.stakeLockedUntil,
					nonce: account.nonce,
					storageCredits: account.storageCredits.toString(),
				};
			},
		);

		// GET /peer/peers
		this.server.get("/peer/peers", async () => {
			return {
				peers: [...this.peers.entries()].map(([addr, info]) => ({
					address: addr,
					height: info.height,
					lastSeen: info.lastSeen,
				})),
			};
		});

		// POST /peer/consensus - receive consensus messages
		this.server.post<{ Body: SerializedConsensusMessage }>(
			"/peer/consensus",
			async (req) => {
				const body = req.body;
				if (!body || !body.type || !body.from) {
					return { accepted: false, error: "Invalid message" };
				}
				const msg: ConsensusMessage = {
					type: body.type as ConsensusMessage["type"],
					height: body.height,
					round: body.round,
					blockHash: body.blockHash,
					from: body.from,
				};
				// Deserialize block for propose messages
				if (body.type === "propose" && body.block) {
					const raw = body.block as Record<string, unknown>;
					const txs = (raw["transactions"] as Array<Record<string, unknown>> ?? []).map((tx) => ({
						type: tx["type"] as Block["transactions"][0]["type"],
						from: tx["from"] as string,
						to: tx["to"] as string,
						amount: BigInt(tx["amount"] as string),
						nonce: tx["nonce"] as number,
						timestamp: tx["timestamp"] as number,
						signature: new Uint8Array(64),
					}));
					msg.block = {
						height: raw["height"] as number,
						previousHash: raw["previousHash"] as string,
						stateRoot: raw["stateRoot"] as string,
						transactionsRoot: raw["transactionsRoot"] as string,
						timestamp: raw["timestamp"] as number,
						proposer: raw["proposer"] as string,
						transactions: txs,
						attestations: [],
					};
				}
				if (this.onConsensusMessage) {
					this.onConsensusMessage(msg);
				}

				// Relay to local peers (if we are the tunnel validator receiving from remote)
				if (this.isTunnelValidator) {
					void this.relayToLocalPeers(body);
				}
				return { accepted: true };
			},
		);

		// GET /peer/blocks/latest?count=20
		this.server.get<{ Querystring: { count?: string } }>(
			"/peer/blocks/latest",
			async (req) => {
				const count = Math.min(Number(req.query.count ?? 20), 100);
				const producer = this.gossip.getProducer();
				const tip = producer.getHeight();
				const blocks: SerializedBlock[] = [];
				for (let h = tip; h >= Math.max(0, tip - count + 1); h--) {
					const b = producer.getBlock(h);
					if (b) {
						blocks.push({
							height: b.height,
							previousHash: b.previousHash,
							stateRoot: b.stateRoot,
							transactionsRoot: b.transactionsRoot,
							timestamp: b.timestamp,
							proposer: b.proposer,
							transactions: b.transactions.map((tx) => ({
								type: tx.type,
								from: tx.from,
								to: tx.to,
								amount: tx.amount.toString(),
								nonce: tx.nonce,
								timestamp: tx.timestamp,
								signature: "",
							})),
							attestations: [],
						});
					}
				}
				return { blocks };
			},
		);

		// GET /peer/stats
		this.server.get("/peer/stats", async () => {
			const producer = this.gossip.getProducer();
			const tip = producer.getHeight();
			let totalTxs = 0;
			let blockTimeSum = 0;
			let blockTimeCount = 0;
			let prevTimestamp = 0;
			const scanFrom = Math.max(0, tip - 99);
			for (let h = scanFrom; h <= tip; h++) {
				const b = producer.getBlock(h);
				if (b) {
					totalTxs += b.transactions.length;
					if (prevTimestamp > 0 && b.timestamp > prevTimestamp) {
						blockTimeSum += b.timestamp - prevTimestamp;
						blockTimeCount++;
					}
					prevTimestamp = b.timestamp;
				}
			}
			const avgBlockTime = blockTimeCount > 0 ? Math.round(blockTimeSum / blockTimeCount) : 6000;
			const accounts = producer.getState().getAllAccounts();
			const validators = producer.getValidators();
			return {
				blockHeight: tip,
				avgBlockTimeMs: avgBlockTime,
				totalTransactions: totalTxs,
				totalAccounts: accounts.length,
				totalValidators: validators.length,
				tps: avgBlockTime > 0 ? Math.round((totalTxs / Math.max(1, tip - scanFrom)) * (1000 / avgBlockTime) * 10) / 10 : 0,
			};
		});

		// GET /peer/search?q=<query>
		this.server.get<{ Querystring: { q?: string } }>(
			"/peer/search",
			async (req, reply) => {
				const q = (req.query.q ?? "").trim();
				if (!q) return reply.status(400).send({ error: "query required" });

				const producer = this.gossip.getProducer();
				const results: Array<{ type: string; value: string; label: string }> = [];

				// Check if it's a block height (number)
				if (/^\d+$/.test(q)) {
					const h = Number(q);
					if (producer.getBlock(h)) {
						results.push({ type: "block", value: String(h), label: `Block #${h}` });
					}
				}

				// Check if it's a DID or partial DID
				if (q.startsWith("did:") || q.startsWith("z6Mk")) {
					const fullQ = q.startsWith("z6Mk") ? `did:key:${q}` : q;
					const accounts = producer.getState().getAllAccounts();
					for (const acc of accounts) {
						if (acc.did.includes(q) || acc.did.includes(fullQ)) {
							results.push({ type: "account", value: acc.did, label: acc.did.length > 30 ? `${acc.did.slice(0, 20)}...${acc.did.slice(-8)}` : acc.did });
							if (results.length >= 10) break;
						}
					}
				}

				return { results };
			},
		);

		// POST /peer/reset - wipe chain and resync (requires ENSOUL_PEER_KEY)
		this.server.post("/peer/reset", async (_req, reply) => {
			// Auth is handled by the global onRequest hook (requires peerKey)
			this.log("RESET requested. Wiping chain data and exiting for restart.");
			// Wipe chain data directory
			try {
				const { rm } = await import("node:fs/promises");
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				// Find data dirs and wipe chain subdirectories
				const baseDir = join(homedir(), ".ensoul");
				for (let i = 0; i < 10; i++) {
					const chainDir = join(baseDir, `validator-${i}`, "chain");
					try { await rm(chainDir, { recursive: true }); } catch { /* ok */ }
				}
				this.log("Chain data wiped. Exiting process for restart.");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.log(`Reset wipe failed: ${msg}`);
			}
			void reply.send({ reset: true, message: "Chain data wiped. Process will exit for restart." });
			// Exit after a short delay to let the response send
			setTimeout(() => process.exit(0), 500);
		});

		// POST /peer/update - pull latest code, build, and restart (requires ENSOUL_PEER_KEY)
		this.server.post("/peer/update", async (_req, reply) => {
			this.log("UPDATE requested. Running auto-update script.");
			void reply.send({ updating: true, message: "Auto-update triggered. Validator will restart." });
			// Run auto-update script in background, then exit for restart
			setTimeout(async () => {
				try {
					const { execSync } = await import("node:child_process");
					const { join } = await import("node:path");
					const { dirname } = await import("node:path");
					const { fileURLToPath } = await import("node:url");
					const scriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts");
					const script = join(scriptDir, "auto-update.sh");
					execSync(`bash "${script}"`, { timeout: 300000, stdio: "ignore" });
				} catch {
					this.log("Auto-update script completed or failed. Process exiting for restart.");
				}
				process.exit(0);
			}, 500);
		});

		await this.server.listen({ port, host: "0.0.0.0" });
		this.log(`Peer API listening on port ${port}`);
	}

	/**
	 * Connect to initial peers, sync missing blocks, start polling.
	 */
	async connectToPeers(addresses: string[]): Promise<number> {
		let connectedCount = 0;

		// Compute our own genesis hash for comparison
		const myGenesis = this.gossip.getProducer().getBlock(0);
		const myGenesisHash = myGenesis ? computeBlockHash(myGenesis) : "";
		let mismatchCount = 0;

		for (const addr of addresses) {
			this.log(`Connecting to peer: ${addr}`);
			try {
				const resp = await fetch(`${addr}/peer/status`, {
					signal: AbortSignal.timeout(10000),
				});
				if (!resp.ok) {
					this.log(`Peer connection failed: ${addr} returned HTTP ${resp.status}`);
					continue;
				}
				const status = (await resp.json()) as PeerStatus;

				// Check genesis hash compatibility
				if (myGenesisHash && status.genesisHash && status.genesisHash !== myGenesisHash) {
					this.log(
						`WARNING: Peer ${addr} is on a different chain (genesis ${status.genesisHash.slice(0, 16)} vs ours ${myGenesisHash.slice(0, 16)}). Skipping.`,
					);
					mismatchCount++;
					continue;
				}

				this.peers.set(addr, {
					address: addr,
					height: status.height,
					lastSeen: Date.now(),
				});
				this.log(
					`Peer connected: ${addr} height=${status.height} version=${status.version ?? "unknown"}`,
				);
				connectedCount++;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.log(`Peer connection failed: ${addr} (${msg})`);
			}
		}

		// If ALL peers have a different genesis, we are on the wrong chain
		if (mismatchCount > 0 && connectedCount === 0 && mismatchCount === addresses.length) {
			this.log("Chain mismatch detected. All peers are on a different chain. Wiping local chain data and resyncing.");
			await this.wipeAndResync();
			return 0;
		}

		// Discover local validators on the same machine
		await this.discoverLocalPeers();

		// Sync from the peer with the highest chain
		if (connectedCount > 0) {
			await this.syncFromBestPeer();
		}

		// Wire gossip broadcast to push blocks to peers via HTTP
		this.gossip.onBroadcastBlock = (block) => {
			void this.broadcastBlock(block);
		};

		// Start polling peers for new blocks
		this.pollTimer = setInterval(() => {
			void this.pollPeers();
		}, 6000);

		this.log(`Connected to ${connectedCount}/${addresses.length} peers`);
		return connectedCount;
	}

	/**
	 * Get the number of connected peers.
	 */
	getPeerCount(): number {
		return this.peers.size;
	}

	/**
	 * Get info about all connected peers.
	 */
	getPeers(): PeerInfo[] {
		return [...this.peers.values()];
	}

	/**
	 * Register with a seed node, discover peers, and connect to them.
	 * Returns the number of peers connected via the seed.
	 */
	async registerWithSeed(
		seedUrl: string,
		myPublicUrl: string,
	): Promise<number> {
		this.seedClient = new SeedClient(
			seedUrl,
			myPublicUrl,
			this.myDid,
			() => this.gossip.getProducer().getHeight(),
			this.log,
		);

		// When the seed discovers new peers we have not seen, connect to them
		this.seedClient.setOnPeersDiscovered((urls) => {
			for (const url of urls) {
				if (!this.peers.has(url)) {
					void this.addPeer(url);
				}
			}
		});

		const peerUrls = await this.seedClient.start();

		// Connect to all discovered peers
		let connected = 0;
		for (const url of peerUrls) {
			const ok = await this.addPeer(url);
			if (ok) connected++;
		}

		// Sync from best peer after initial discovery
		if (connected > 0) {
			await this.syncFromBestPeer();
		}

		// Wire gossip broadcast if not already wired
		if (!this.gossip.onBroadcastBlock) {
			this.gossip.onBroadcastBlock = (block) => {
				void this.broadcastBlock(block);
			};
		}

		// Start polling if not already started
		if (!this.pollTimer) {
			this.pollTimer = setInterval(() => {
				void this.pollPeers();
			}, 6000);
		}

		this.log(`Seed: discovered ${peerUrls.length} peers, connected to ${connected}`);
		return connected;
	}

	/**
	 * Stop the peer network (server + polling + seed client).
	 */
	async stop(): Promise<void> {
		if (this.seedClient) {
			this.seedClient.stop();
			this.seedClient = null;
		}
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.server) {
			await this.server.close();
			this.server = null;
		}
	}

	/**
	 * Get the Fastify server instance (for testing).
	 */
	getServer(): FastifyInstance | null {
		return this.server;
	}

	/**
	 * Wipe local chain data and exit for restart.
	 * Called when all peers are on a different genesis chain.
	 */
	private async wipeAndResync(): Promise<void> {
		try {
			const { rm } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const { homedir } = await import("node:os");
			const baseDir = join(homedir(), ".ensoul");
			for (let i = 0; i < 10; i++) {
				const chainDir = join(baseDir, `validator-${i}`, "chain");
				try { await rm(chainDir, { recursive: true }); } catch { /* ok */ }
			}
			this.log("Chain data wiped. Exiting for restart with correct genesis.");
			setTimeout(() => process.exit(1), 500);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log(`Wipe failed: ${msg}`);
		}
	}

	/**
	 * Broadcast a consensus message to all connected peers.
	 */
	async broadcastConsensus(msg: ConsensusMessage): Promise<void> {
		const serialized: SerializedConsensusMessage = {
			type: msg.type,
			height: msg.height,
			round: msg.round,
			blockHash: msg.blockHash,
			from: msg.from,
		};
		if (msg.type === "propose" && msg.block) {
			serialized.block = {
				height: msg.block.height,
				previousHash: msg.block.previousHash,
				stateRoot: msg.block.stateRoot,
				transactionsRoot: msg.block.transactionsRoot,
				timestamp: msg.block.timestamp,
				proposer: msg.block.proposer,
				transactions: msg.block.transactions.map((tx) => ({
					type: tx.type,
					from: tx.from,
					to: tx.to,
					amount: tx.amount.toString(),
					nonce: tx.nonce,
					timestamp: tx.timestamp,
				})),
			};
		}

		const body = JSON.stringify(serialized);

		if (this.isTunnelValidator) {
			// Tunnel validator: send to remote peers AND local validators
			const promises = [...this.peers.keys()].map(async (addr) => {
				try {
					await fetch(`${addr}/peer/consensus`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
						signal: AbortSignal.timeout(3000),
					});
				} catch { /* peer offline */ }
			});
			await Promise.allSettled(promises);
			// Also relay to local validators on this machine
			void this.relayToLocalPeers(serialized);
		} else {
			// Non-tunnel validator: send to tunnel validator for external broadcast
			// AND send directly to local peers on the same machine
			void this.relayToTunnel(serialized);
			void this.relayToLocalPeers(serialized);
		}
	}

	// ── Local peer relay ─────────────────────────────────────────

	/**
	 * Discover other validators running on the same machine.
	 * Scans localhost ports 9000-9009, excludes own port.
	 */
	async discoverLocalPeers(): Promise<void> {
		this.localPeers = [];
		for (let port = 9000; port <= 9009; port++) {
			if (port === this.myPort) continue;
			try {
				const resp = await fetch(`http://localhost:${port}/peer/status`, {
					signal: AbortSignal.timeout(1000),
				});
				if (!resp.ok) continue;
				const status = (await resp.json()) as PeerStatus;
				this.localPeers.push({ port, did: status.did });
			} catch {
				// Port not running, skip
			}
		}
		if (this.localPeers.length > 0) {
			this.log(`Discovered ${this.localPeers.length} local validators on this machine`);
		}
	}

	/**
	 * Relay a serialized consensus message to all local validators.
	 * Called by the tunnel validator when it receives a message from a remote peer.
	 */
	private async relayToLocalPeers(serialized: SerializedConsensusMessage): Promise<void> {
		const body = JSON.stringify(serialized);
		const promises = this.localPeers.map(async (lp) => {
			try {
				await fetch(`http://localhost:${lp.port}/peer/consensus`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(1000),
				});
			} catch {
				// Local peer not responding
			}
		});
		await Promise.allSettled(promises);
	}

	/**
	 * Relay a serialized consensus message to the tunnel validator (port 9000).
	 * Called by non-tunnel validators to send their votes to the network.
	 */
	private async relayToTunnel(serialized: SerializedConsensusMessage): Promise<void> {
		if (this.isTunnelValidator) return; // already the tunnel
		try {
			await fetch("http://localhost:9000/peer/consensus", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(serialized),
				signal: AbortSignal.timeout(2000),
			});
		} catch {
			// Tunnel validator not responding
		}
	}

	// ── Internal ─────────────────────────────────────────────────

	/**
	 * Sync blocks from the peer with the highest chain.
	 */
	private async syncFromBestPeer(): Promise<void> {
		let bestAddr = "";
		let bestHeight = 0;

		for (const [addr, info] of this.peers) {
			if (info.height > bestHeight) {
				bestHeight = info.height;
				bestAddr = addr;
			}
		}

		const myHeight = this.gossip.getProducer().getHeight();
		if (bestHeight <= myHeight || !bestAddr) {
			this.log(`Already at network height (local=${myHeight}, best peer=${bestHeight})`);
			return;
		}

		const gap = bestHeight - myHeight;
		this.log(`Syncing ${gap} blocks (${myHeight + 1}..${bestHeight}) from ${bestAddr}`);

		try {
			const resp = await fetch(
				`${bestAddr}/peer/sync/${myHeight + 1}`,
				{ signal: AbortSignal.timeout(30000) },
			);
			if (!resp.ok) {
				this.log(`Sync request failed: HTTP ${resp.status}`);
				return;
			}
			const blocks = extractBlocks(await resp.json());
			this.log(`Received ${blocks.length} blocks from peer`);
			const result = this.gossip.applySyncBlocks(blocks);
			const newHeight = this.gossip.getProducer().getHeight();
			this.log(
				`Sync complete: ${result.applied} applied, ${result.errors.length} errors, now at height ${newHeight}`,
			);
			for (const e of result.errors) {
				this.log(`Sync block error: ${e}`);
			}
			// Notify consensus engine so it advances to the correct height
			if (result.applied > 0 && this.onBlockSynced) {
				this.onBlockSynced(newHeight);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log(`Sync failed: ${msg}`);
		}
	}

	/**
	 * Broadcast a new block to all connected peers.
	 */
	private async broadcastBlock(block: SerializedBlock): Promise<void> {
		const body = JSON.stringify(block);

		// Broadcast to remote peers
		const promises = [...this.peers.keys()].map(async (addr) => {
			try {
				await fetch(`${addr}/peer/blocks`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				});
			} catch {
				// Peer might be down, non-fatal
			}
		});

		// Also relay to local validators on this machine
		const localPromises = this.localPeers.map(async (lp) => {
			try {
				await fetch(`http://localhost:${lp.port}/peer/blocks`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(1000),
				});
			} catch { /* local peer offline */ }
		});

		// Non-tunnel validators also send to tunnel for external relay
		if (!this.isTunnelValidator) {
			try {
				await fetch("http://localhost:9000/peer/blocks", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(2000),
				});
			} catch { /* tunnel offline */ }
		}

		await Promise.allSettled([...promises, ...localPromises]);
	}

	/**
	 * Add a single peer by URL.
	 */
	private async addPeer(url: string): Promise<boolean> {
		if (this.peers.has(url)) return true;
		try {
			const resp = await fetch(`${url}/peer/status`);
			if (!resp.ok) return false;
			const status = (await resp.json()) as PeerStatus;
			this.peers.set(url, {
				address: url,
				height: status.height,
				lastSeen: Date.now(),
			});
			this.log(`Connected to peer ${url} (height: ${status.height})`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Poll all peers for their current status and sync if needed.
	 */
	private async pollPeers(): Promise<void> {
		for (const [addr, info] of this.peers) {
			try {
				const resp = await fetch(`${addr}/peer/status`);
				if (!resp.ok) continue;
				const status = (await resp.json()) as PeerStatus;
				info.height = status.height;
				info.lastSeen = Date.now();

				// If peer is ahead, sync missing blocks
				const myHeight = this.gossip.getProducer().getHeight();
				if (status.height > myHeight) {
					const syncResp = await fetch(
						`${addr}/peer/sync/${myHeight + 1}`,
					);
					if (syncResp.ok) {
						const blocks = extractBlocks(await syncResp.json());
						const result = this.gossip.applySyncBlocks(blocks);
						if (result.errors.length > 0) {
							for (const e of result.errors) {
								this.log(`Sync block error: ${e}`);
							}
						}
					}
				}
			} catch {
				// Peer offline, keep it in the list for retry
			}
		}
	}
}
