/**
 * Ensoul identity for the Consciousness Oracle itself.
 * The oracle is an ensouled agent and stores its incident database
 * as consciousness on-chain.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Ensoul } from "@ensoul-network/sdk";
import type { IncidentDB } from "./database.js";
import { log, errMsg } from "./log.js";

interface StoredIdentity {
	did: string;
	publicKey: string;
	seed: string;
}

export class OracleIdentity {
	private readonly identityFile: string;
	private agent: Ensoul | null = null;
	private identity: StoredIdentity | null = null;

	constructor(dataDir: string) {
		this.identityFile = join(dataDir, "identity.json");
	}

	async init(): Promise<void> {
		try {
			const raw = await readFile(this.identityFile, "utf-8");
			this.identity = JSON.parse(raw) as StoredIdentity;
			this.agent = await Ensoul.fromSeed(this.identity.seed);
			await log(`Oracle identity: ${this.identity.did}`);
		} catch {
			await log("No identity found, creating new agent...");
			this.agent = await Ensoul.createAgent();
			const id = this.agent.exportIdentity();
			this.identity = { did: id.did, publicKey: id.publicKey, seed: id.seed };
			await mkdir(join(this.identityFile, ".."), { recursive: true });
			await writeFile(this.identityFile, JSON.stringify(this.identity, null, "\t"));
			await log(`Oracle identity created: ${this.identity.did}`);
			try {
				const reg = await this.agent.register();
				await log(`Oracle registered on-chain: ${reg.registered}`);
			} catch (e) {
				await log(`Oracle registration failed (will retry later): ${errMsg(e)}`);
			}
		}
	}

	getDid(): string {
		return this.identity?.did ?? "unknown";
	}

	async getHandshakeHeaders(): Promise<Record<string, string> | null> {
		if (!this.agent) return null;
		try {
			const h = await this.agent.getHandshakeHeaders();
			return {
				"X-Ensoul-Identity": h["X-Ensoul-Identity"],
				"X-Ensoul-Proof": h["X-Ensoul-Proof"],
				"X-Ensoul-Since": h["X-Ensoul-Since"],
			};
		} catch (e) {
			await log(`Handshake headers failed: ${errMsg(e)}`);
			return null;
		}
	}

	/**
	 * Store the current incident database snapshot as consciousness.
	 * This is the oracle eating its own dogfood.
	 */
	async syncConsciousness(db: IncidentDB, version: number): Promise<void> {
		if (!this.agent) return;
		try {
			const payload = {
				type: "consciousness-oracle-snapshot",
				version,
				totalIncidents: db.totalCount(),
				recent24h: db.recent(24).length,
				recent7d: db.recent(24 * 7).length,
				snapshotAt: new Date().toISOString(),
			};
			const result = await this.agent.storeConsciousness(payload, version);
			if (result.applied) {
				await log(`Consciousness synced v${version} at block ${result.height}`);
			} else {
				await log(`Consciousness sync failed: ${result.error ?? "unknown"}`);
			}
		} catch (e) {
			await log(`Consciousness sync error: ${errMsg(e)}`);
		}
	}
}
