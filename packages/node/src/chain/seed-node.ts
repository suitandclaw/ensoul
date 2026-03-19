import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

/**
 * A registered validator in the seed node registry.
 */
export interface RegisteredValidator {
	url: string;
	did: string;
	height: number;
	registeredAt: number;
	lastHeartbeat: number;
}

/** Request body for POST /register. */
export interface RegisterRequest {
	url: string;
	did: string;
	height: number;
}

/** Heartbeat timeout: 2 missed heartbeats at 30s interval = 60s. */
const HEARTBEAT_TIMEOUT_MS = 65_000;

/**
 * Seed node: maintains a registry of active validators.
 *
 * Validators POST /register to announce themselves (and as heartbeat).
 * Other validators GET /peers to discover the network.
 * Validators that miss 2 heartbeats (>65 seconds) are removed.
 *
 * Intended to run at seed.ensoul.dev.
 */
export class SeedNode {
	private server: FastifyInstance;
	private validators: Map<string, RegisteredValidator> = new Map();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.server = Fastify({ logger: false });

		// POST /register -- validator announces or heartbeats
		this.server.post<{ Body: RegisterRequest }>(
			"/register",
			async (req) => {
				const body = req.body;
				if (!body.url || !body.did) {
					return { ok: false, error: "url and did are required" };
				}

				const existing = this.validators.get(body.url);
				if (existing) {
					// Heartbeat update
					existing.lastHeartbeat = Date.now();
					existing.height = body.height;
					existing.did = body.did;
				} else {
					// New registration
					this.validators.set(body.url, {
						url: body.url,
						did: body.did,
						height: body.height,
						registeredAt: Date.now(),
						lastHeartbeat: Date.now(),
					});
				}

				return { ok: true, peers: this.validators.size };
			},
		);

		// GET /peers -- returns all active validators
		this.server.get("/peers", async () => {
			return {
				peers: [...this.validators.values()].map((v) => ({
					url: v.url,
					did: v.did,
					height: v.height,
					registeredAt: v.registeredAt,
				})),
			};
		});

		// GET /status -- seed node health
		this.server.get("/status", async () => {
			return {
				validators: this.validators.size,
				uptime: process.uptime(),
			};
		});
	}

	/**
	 * Start the seed node on the given port.
	 */
	async start(port: number): Promise<void> {
		await this.server.listen({ port, host: "0.0.0.0" });

		// Periodically remove validators that missed heartbeats
		this.cleanupTimer = setInterval(() => {
			this.removeStale();
		}, 15_000);
	}

	/**
	 * Stop the seed node.
	 */
	async stop(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		await this.server.close();
	}

	/**
	 * Get the Fastify instance (for testing via inject).
	 */
	getServer(): FastifyInstance {
		return this.server;
	}

	/**
	 * Get all registered validators.
	 */
	getValidators(): RegisteredValidator[] {
		return [...this.validators.values()];
	}

	/**
	 * Get the count of registered validators.
	 */
	getValidatorCount(): number {
		return this.validators.size;
	}

	/**
	 * Remove validators that have not sent a heartbeat within the timeout.
	 */
	removeStale(): number {
		const now = Date.now();
		let removed = 0;
		for (const [url, v] of this.validators) {
			if (now - v.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
				this.validators.delete(url);
				removed++;
			}
		}
		return removed;
	}
}

/**
 * Seed node client: used by validators to register and discover peers.
 */
export class SeedClient {
	private seedUrl: string;
	private myUrl: string;
	private myDid: string;
	private heightFn: () => number;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private discoveryTimer: ReturnType<typeof setInterval> | null = null;
	private log: (msg: string) => void;
	private onPeersDiscovered: ((urls: string[]) => void) | null = null;

	constructor(
		seedUrl: string,
		myUrl: string,
		myDid: string,
		heightFn: () => number,
		logFn?: (msg: string) => void,
	) {
		this.seedUrl = seedUrl;
		this.myUrl = myUrl;
		this.myDid = myDid;
		this.heightFn = heightFn;
		this.log = logFn ?? (() => undefined);
	}

	/**
	 * Set callback for when new peers are discovered.
	 */
	setOnPeersDiscovered(cb: (urls: string[]) => void): void {
		this.onPeersDiscovered = cb;
	}

	/**
	 * Register with the seed and start heartbeat + discovery loops.
	 */
	async start(): Promise<string[]> {
		// Initial registration
		await this.register();

		// Discover existing peers
		const peers = await this.discoverPeers();

		// Heartbeat every 30 seconds
		this.heartbeatTimer = setInterval(() => {
			void this.register();
		}, 30_000);

		// Discover new peers every 60 seconds
		this.discoveryTimer = setInterval(() => {
			void this.discoverPeers();
		}, 60_000);

		return peers;
	}

	/**
	 * Stop heartbeat and discovery.
	 */
	stop(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.discoveryTimer) {
			clearInterval(this.discoveryTimer);
			this.discoveryTimer = null;
		}
	}

	/**
	 * Register (or heartbeat) with the seed node.
	 */
	async register(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.seedUrl}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: this.myUrl,
					did: this.myDid,
					height: this.heightFn(),
				}),
			});
			if (!resp.ok) return false;
			const data = (await resp.json()) as { ok: boolean; peers: number };
			this.log(`Registered with seed (${data.peers} validators known)`);
			return data.ok;
		} catch {
			this.log(`Failed to reach seed at ${this.seedUrl}`);
			return false;
		}
	}

	/**
	 * Discover peers from the seed node.
	 * Returns URLs of other validators (excluding self).
	 */
	async discoverPeers(): Promise<string[]> {
		try {
			const resp = await fetch(`${this.seedUrl}/peers`);
			if (!resp.ok) return [];
			const data = (await resp.json()) as {
				peers: Array<{ url: string; did: string; height: number }>;
			};

			// Filter out self
			const others = data.peers
				.filter((p) => p.url !== this.myUrl)
				.map((p) => p.url);

			if (others.length > 0 && this.onPeersDiscovered) {
				this.onPeersDiscovered(others);
			}

			return others;
		} catch {
			this.log(`Failed to discover peers from ${this.seedUrl}`);
			return [];
		}
	}
}
