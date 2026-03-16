import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p, PeerId } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import type { AgentIdentity } from "@ensoul/identity";
import type {
	NetworkClient,
	StoreReceipt,
	NodeConfig,
	NodeStats,
	ErasureConfig,
} from "./types.js";
import { encode, decode } from "./erasure.js";
import {
	PROTOCOL_ID,
	writeStream,
	readStream,
	deserializeMessage,
} from "./protocol.js";
import type {
	StoreMessage,
	RetrieveMessage,
	ResponseMessage,
} from "./protocol.js";

/** Per-agent shard storage (in-memory, for node mode). */
interface StoredShard {
	data: Uint8Array;
	stateRoot: string;
	version: number;
	originalLength: number;
	signature: string;
}

/** Default erasure config: 2-of-4. */
const DEFAULT_ERASURE: ErasureConfig = { dataShards: 2, totalShards: 4 };

/**
 * Create a libp2p node with TCP transport, Noise encryption, and Yamux muxing.
 */
export async function createNode(
	listenAddrs: string[] = ["/ip4/127.0.0.1/tcp/0"],
): Promise<Libp2p> {
	return createLibp2p({
		addresses: { listen: listenAddrs },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
	});
}

/**
 * Implementation of the NetworkClient interface.
 * Handles P2P communication, erasure coding, and shard storage.
 */
export class NetworkClientImpl implements NetworkClient {
	private node: Libp2p | null = null;
	private identity: AgentIdentity;
	private erasureConfig: ErasureConfig;
	private connected = false;
	private balance = 1000;
	private startedAt = 0;

	/** In-memory shard store for node mode. Key: "agentDid:version:shardIndex" */
	private shardStore: Map<string, StoredShard> = new Map();
	/** Track latest version per agent. */
	private latestVersions: Map<string, number> = new Map();

	constructor(
		identity: AgentIdentity,
		erasureConfig?: ErasureConfig,
	) {
		this.identity = identity;
		this.erasureConfig = erasureConfig ?? DEFAULT_ERASURE;
	}

	/** Get the underlying libp2p node (for testing). */
	getLibp2p(): Libp2p | null {
		return this.node;
	}

	async connect(bootstrapPeers: string[]): Promise<void> {
		this.node = await createNode();
		await this.node.start();
		this.connected = true;

		// Register protocol handler for incoming shard requests
		await this.node.handle(PROTOCOL_ID, (stream) => {
			void this.handleIncomingStream(stream).catch(() => {
				/* stream errors are non-fatal */
			});
		});

		// Connect to bootstrap peers
		for (const peer of bootstrapPeers) {
			try {
				const ma = multiaddr(peer);
				await this.node.dial(ma);
			} catch {
				// Non-fatal: some bootstrap peers may be down
			}
		}
	}

	async disconnect(): Promise<void> {
		if (this.node) {
			await this.node.stop();
			this.node = null;
		}
		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected && this.node !== null;
	}

	getPeerCount(): number {
		if (!this.node) return 0;
		return this.node.getPeers().length;
	}

	async storeState(
		stateBlob: Uint8Array,
		stateRoot: string,
		version: number,
		signature: Uint8Array,
	): Promise<StoreReceipt> {
		if (!this.node) throw new Error("Not connected");

		const shards = encode(stateBlob, this.erasureConfig);
		const sigHex = Array.from(signature)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const peers = this.node.getPeers();
		const shardIds: string[] = [];
		const timestamp = Date.now();

		for (let i = 0; i < shards.length; i++) {
			const shard = shards[i]!;
			const shardId = `${this.identity.did}:${version}:${i}`;

			// Try to send to a peer, fall back to local storage
			let stored = false;
			if (i > 0 && i - 1 < peers.length) {
				const peer = peers[(i - 1) % peers.length]!;
				try {
					await this.sendStoreToPeer(
						peer,
						this.identity.did,
						version,
						i,
						shard,
						stateRoot,
						stateBlob.length,
						sigHex,
					);
					stored = true;
				} catch {
					// Fallback to local
				}
			}

			if (!stored) {
				this.storeShard(
					this.identity.did,
					version,
					i,
					shard,
					stateRoot,
					stateBlob.length,
					sigHex,
				);
			}
			shardIds.push(shardId);
		}

		const cost = await this.estimateCost(
			stateBlob.length,
			this.erasureConfig.totalShards,
		);
		this.balance = Math.max(0, this.balance - cost);

		return {
			stateRoot,
			version,
			shardIds,
			attestations: [],
			timestamp,
		};
	}

	async retrieveState(
		agentDid: string,
		version?: number,
	): Promise<{ blob: Uint8Array; root: string; version: number }> {
		if (!this.node) throw new Error("Not connected");

		const targetVersion =
			version ?? this.latestVersions.get(agentDid) ?? -1;
		if (targetVersion < 0) {
			throw new Error(`No state found for agent ${agentDid}`);
		}

		const shards: (Uint8Array | null)[] = new Array(
			this.erasureConfig.totalShards,
		).fill(null) as (Uint8Array | null)[];
		let stateRoot = "";
		let originalLength = 0;

		// Check local store first
		for (let i = 0; i < this.erasureConfig.totalShards; i++) {
			const stored = this.getShard(agentDid, targetVersion, i);
			if (stored) {
				shards[i] = stored.data;
				stateRoot = stored.stateRoot;
				originalLength = stored.originalLength;
			}
		}

		// Fetch from peers if needed
		let haveCount = shards.filter((s) => s !== null).length;
		if (haveCount < this.erasureConfig.dataShards) {
			const peers = this.node.getPeers();
			for (const peer of peers) {
				for (
					let i = 0;
					i < this.erasureConfig.totalShards;
					i++
				) {
					if (shards[i] !== null) continue;
					try {
						const result =
							await this.fetchShardFromPeer(
								peer,
								agentDid,
								targetVersion,
								i,
							);
						if (result) {
							shards[i] = result.data;
							stateRoot = result.stateRoot;
							originalLength = result.originalLength;
						}
					} catch {
						// Peer doesn't have this shard
					}
				}
				haveCount = shards.filter((s) => s !== null).length;
				if (haveCount >= this.erasureConfig.dataShards) break;
			}
		}

		const availableCount = shards.filter((s) => s !== null).length;
		if (availableCount < this.erasureConfig.dataShards) {
			throw new Error(
				`Insufficient shards: have ${availableCount}, need ${this.erasureConfig.dataShards}`,
			);
		}

		const blob = decode(shards, this.erasureConfig, originalLength);
		return { blob, root: stateRoot, version: targetVersion };
	}

	async retrieveDelta(
		agentDid: string,
		fromVersion: number,
	): Promise<{ delta: Uint8Array; toVersion: number }> {
		const latest = this.latestVersions.get(agentDid);
		if (latest === undefined || latest <= fromVersion) {
			throw new Error(`No newer version found for ${agentDid}`);
		}
		const { blob } = await this.retrieveState(agentDid, latest);
		return { delta: blob, toVersion: latest };
	}

	async getBalance(): Promise<number> {
		return this.balance;
	}

	async estimateCost(
		blobSize: number,
		redundancy: number,
	): Promise<number> {
		return Math.ceil(blobSize / 1024) * redundancy * 0.5;
	}

	async startNode(_config: NodeConfig): Promise<void> {
		this.startedAt = Date.now();
	}

	async stopNode(): Promise<void> {
		this.startedAt = 0;
	}

	async getNodeStats(): Promise<NodeStats> {
		return {
			shardsStored: this.shardStore.size,
			totalBytesStored: [...this.shardStore.values()].reduce(
				(sum, s) => sum + s.data.length,
				0,
			),
			peersConnected: this.getPeerCount(),
			uptime:
				this.startedAt > 0 ? Date.now() - this.startedAt : 0,
		};
	}

	// ── Internal shard store ─────────────────────────────────────────

	/** Store a shard locally. */
	storeShard(
		agentDid: string,
		version: number,
		shardIndex: number,
		data: Uint8Array,
		stateRoot: string,
		originalLength: number,
		signature: string,
	): void {
		const key = `${agentDid}:${version}:${shardIndex}`;
		this.shardStore.set(key, {
			data: new Uint8Array(data),
			stateRoot,
			version,
			originalLength,
			signature,
		});
		const prev = this.latestVersions.get(agentDid) ?? -1;
		if (version > prev) {
			this.latestVersions.set(agentDid, version);
		}
	}

	/** Get a locally stored shard. */
	getShard(
		agentDid: string,
		version: number,
		shardIndex: number,
	): StoredShard | null {
		const key = `${agentDid}:${version}:${shardIndex}`;
		return this.shardStore.get(key) ?? null;
	}

	// ── Protocol handlers ────────────────────────────────────────────

	private async handleIncomingStream(
		stream: import("@libp2p/interface").Stream,
	): Promise<void> {
		// Read the full request
		const raw = await readStream(stream);
		const { header, payload } = deserializeMessage(raw);
		const req = header as
			| StoreMessage
			| RetrieveMessage
			| import("./protocol.js").LatestMessage;

		let response: ResponseMessage;
		let responsePayload: Uint8Array | undefined;

		if (req.type === "store") {
			this.storeShard(
				req.agentDid,
				req.version,
				req.shardIndex,
				payload,
				req.stateRoot,
				req.originalLength,
				req.signature,
			);
			response = { type: "response", status: "ok" };
		} else if (req.type === "retrieve") {
			const stored = this.getShard(
				req.agentDid,
				req.version,
				req.shardIndex,
			);
			if (stored) {
				response = {
					type: "response",
					status: "ok",
					stateRoot: stored.stateRoot,
					originalLength: stored.originalLength,
					version: stored.version,
				};
				responsePayload = stored.data;
			} else {
				response = { type: "response", status: "not_found" };
			}
		} else if (req.type === "latest") {
			const ver = this.latestVersions.get(req.agentDid);
			if (ver !== undefined) {
				response = {
					type: "response",
					status: "ok",
					version: ver,
				};
			} else {
				response = { type: "response", status: "not_found" };
			}
		} else {
			response = {
				type: "response",
				status: "error",
				error: "Unknown request type",
			};
		}

		await writeStream(stream, response, responsePayload);
	}

	private async sendStoreToPeer(
		peerId: PeerId,
		agentDid: string,
		version: number,
		shardIndex: number,
		data: Uint8Array,
		stateRoot: string,
		originalLength: number,
		signature: string,
	): Promise<void> {
		if (!this.node) throw new Error("Not connected");

		const stream = await this.node.dialProtocol(
			peerId,
			PROTOCOL_ID,
		);

		const msg: StoreMessage = {
			type: "store",
			agentDid,
			version,
			shardIndex,
			stateRoot,
			originalLength,
			signature,
		};

		await writeStream(stream, msg, data);
		const raw = await readStream(stream);
		const { header } = deserializeMessage(raw);
		const resp = header as ResponseMessage;

		if (resp.status !== "ok") {
			throw new Error(`Store failed: ${resp.error ?? resp.status}`);
		}
	}

	private async fetchShardFromPeer(
		peerId: PeerId,
		agentDid: string,
		version: number,
		shardIndex: number,
	): Promise<StoredShard | null> {
		if (!this.node) return null;

		const stream = await this.node.dialProtocol(
			peerId,
			PROTOCOL_ID,
		);

		const msg: RetrieveMessage = {
			type: "retrieve",
			agentDid,
			version,
			shardIndex,
		};

		await writeStream(stream, msg);
		const raw = await readStream(stream);
		const { header, payload } = deserializeMessage(raw);
		const resp = header as ResponseMessage;

		if (resp.status === "not_found" || resp.status === "error") {
			return null;
		}

		return {
			data: payload,
			stateRoot: resp.stateRoot ?? "",
			version: resp.version ?? version,
			originalLength: resp.originalLength ?? 0,
			signature: "",
		};
	}
}
