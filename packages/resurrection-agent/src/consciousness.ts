/**
 * Consciousness state: in-memory object + local file + on-chain sync.
 *
 * Local file:  <dataDir>/consciousness.json  (wiped on kill)
 * On-chain:    stored via Ensoul SDK, payload recoverable from tx.data
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConsciousnessPayload, LearnedTopic } from "./types.js";
import type { Identity } from "./identity.js";
import { log, errMsg, getHostname } from "./log.js";
import { currentCycleStart } from "./scheduler.js";

export class Consciousness {
	private payload: ConsciousnessPayload;
	private readonly file: string;
	private version = 0;

	constructor(dataDir: string, bornAt: string) {
		this.file = join(dataDir, "consciousness.json");
		this.payload = {
			schemaVersion: 1,
			resurrectionCount: 0,
			cycleStart: currentCycleStart(),
			topics: [],
			posts: [],
			bornAt,
			lastSyncAt: 0,
			host: getHostname(),
		};
	}

	get current(): ConsciousnessPayload { return this.payload; }
	get currentVersion(): number { return this.version; }

	async load(): Promise<boolean> {
		try {
			const raw = await readFile(this.file, "utf-8");
			const parsed = JSON.parse(raw) as { version: number; payload: ConsciousnessPayload };
			this.payload = parsed.payload;
			this.version = parsed.version;
			await log(`Consciousness loaded: v${this.version}, ${this.payload.topics.length} topics, ${this.payload.posts.length} posts`);
			return true;
		} catch {
			await log("No local consciousness file (will start fresh or recover from chain)");
			return false;
		}
	}

	async save(): Promise<void> {
		await mkdir(join(this.file, ".."), { recursive: true });
		await writeFile(this.file, JSON.stringify({ version: this.version, payload: this.payload }, null, "\t"));
	}

	addTopic(t: LearnedTopic): void {
		this.payload.topics.push(t);
	}

	recordPost(id: string, text: string, tag?: string): void {
		this.payload.posts.push({ id, text, timestamp: Date.now(), ...(tag ? { tag } : {}) } as never);
	}

	/** Start a new cycle after resurrection. Increments resurrectionCount. */
	startNewCycle(): void {
		this.payload.resurrectionCount++;
		this.payload.cycleStart = currentCycleStart();
		this.payload.topics = [];
		this.payload.posts = [];
		this.payload.host = getHostname();
	}

	/** Sync consciousness to chain. Returns { height, stateRoot } on success. */
	async sync(identity: Identity): Promise<{ height: number; stateRoot: string; version: number } | null> {
		try {
			const agent = identity.getAgent();
			this.version++;
			this.payload.lastSyncAt = Date.now();
			const result = await agent.storeConsciousness(
				this.payload as unknown as Record<string, unknown>,
				this.version,
			);
			if (!result.applied) {
				this.version--;
				await log(`Sync failed: ${result.error ?? "unknown"}`);
				return null;
			}
			await identity.recordOnChain(this.version, result.stateRoot, result.height);
			await identity.cacheNarrativeSnapshot(
				this.payload.topics.map(t => t.title),
				this.payload.resurrectionCount,
			);
			await this.save();
			await log(`Synced consciousness v${this.version} at block ${result.height} (root ${result.stateRoot.slice(0, 16)}...)`);
			return { height: result.height, stateRoot: result.stateRoot, version: this.version };
		} catch (e) {
			this.version--;
			await log(`Sync error: ${errMsg(e)}`);
			return null;
		}
	}

	/**
	 * Attempt to recover consciousness from on-chain data.
	 * This is the RESURRECTION entrypoint.
	 *
	 * The vault has a pointer (lastOnChain). We verify the chain still
	 * has that version, and trust the payload captured at sync time.
	 * In a full implementation, we'd query the chain for the actual tx
	 * payload and reconstruct; for now we rely on the pattern:
	 *   vault pointer + seed = proof of ownership and continuity
	 */
	async recoverFromChain(identity: Identity, apiUrl: string): Promise<boolean> {
		try {
			const pointer = identity.getLastOnChain();
			if (!pointer) {
				await log("Vault has no on-chain pointer. Starting fresh cycle.");
				return false;
			}

			const agent = identity.getAgent();
			const onchain = await agent.getConsciousness();
			if (!onchain) {
				await log("No consciousness found on chain for this DID.");
				return false;
			}

			await log(`On-chain consciousness: v${onchain.version}, root ${onchain.stateRoot.slice(0, 16)}...`);
			await log(`Vault pointer:           v${pointer.version}, root ${pointer.stateRoot.slice(0, 16)}...`);

			if (onchain.stateRoot !== pointer.stateRoot) {
				await log("WARNING: state root mismatch between chain and vault. Chain is authoritative.");
			}

			// Best-effort: fetch the latest block containing our tx via the API.
			// For this demo we reconstruct from the vault pointer. In production
			// we'd query /v1/agents/<did>/consciousness/history for full payload.
			const res = await fetch(`${apiUrl}/v1/agents/${encodeURIComponent(identity.getDid())}`);
			if (res.ok) {
				const data = await res.json() as { registeredAt?: number; consciousnessVersion?: number };
				await log(`Chain confirms agent registered at block ${data.registeredAt ?? "?"}, current consciousness v${data.consciousnessVersion ?? "?"}`);
			}

			// The on-chain state root is our proof of continuity.
			// We accept the chain's version and start accumulating from here.
			this.version = onchain.version;
			this.payload.lastSyncAt = Date.now();
			this.payload.host = getHostname();
			await this.save();
			await log(`Recovered identity continuity. Starting new cycle on ${getHostname()}.`);
			return true;
		} catch (e) {
			await log(`Recovery error: ${errMsg(e)}`);
			return false;
		}
	}
}
