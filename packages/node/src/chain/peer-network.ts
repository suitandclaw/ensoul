import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { GossipNetwork } from "./gossip.js";
import type { SerializedBlock } from "./types.js";

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
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private log: (msg: string) => void;

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
		this.server = Fastify({ logger: false });

		// GET /peer/status
		this.server.get("/peer/status", async () => {
			return {
				height: this.gossip.getProducer().getHeight(),
				peerCount: this.peers.size,
				did: this.myDid,
			} satisfies PeerStatus;
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
				return result;
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

		await this.server.listen({ port, host: "0.0.0.0" });
		this.log(`Peer API listening on port ${port}`);
	}

	/**
	 * Connect to initial peers, sync missing blocks, start polling.
	 */
	async connectToPeers(addresses: string[]): Promise<number> {
		let connectedCount = 0;

		for (const addr of addresses) {
			try {
				const resp = await fetch(`${addr}/peer/status`);
				if (!resp.ok) continue;
				const status = (await resp.json()) as PeerStatus;
				this.peers.set(addr, {
					address: addr,
					height: status.height,
					lastSeen: Date.now(),
				});
				this.log(
					`Connected to peer ${addr} (height: ${status.height}, did: ${status.did.slice(0, 24)}...)`,
				);
				connectedCount++;
			} catch {
				this.log(`Failed to connect to peer ${addr}`);
			}
		}

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
	 * Stop the peer network (server + polling).
	 */
	async stop(): Promise<void> {
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
		if (bestHeight <= myHeight || !bestAddr) return;

		this.log(
			`Syncing blocks ${myHeight + 1}..${bestHeight} from ${bestAddr}`,
		);

		try {
			const resp = await fetch(
				`${bestAddr}/peer/sync/${myHeight + 1}`,
			);
			if (!resp.ok) return;
			const data = (await resp.json()) as {
				blocks: SerializedBlock[];
			};
			const result = this.gossip.applySyncBlocks(data.blocks);
			this.log(
				`Synced ${result.applied} blocks (${result.errors.length} errors)`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log(`Sync failed: ${msg}`);
		}
	}

	/**
	 * Broadcast a new block to all connected peers.
	 */
	private async broadcastBlock(block: SerializedBlock): Promise<void> {
		const promises = [...this.peers.keys()].map(async (addr) => {
			try {
				await fetch(`${addr}/peer/blocks`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(block),
				});
			} catch {
				// Peer might be down, non-fatal
			}
		});
		await Promise.allSettled(promises);
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
						const data = (await syncResp.json()) as {
							blocks: SerializedBlock[];
						};
						this.gossip.applySyncBlocks(data.blocks);
					}
				}
			} catch {
				// Peer offline, keep it in the list for retry
			}
		}
	}
}
