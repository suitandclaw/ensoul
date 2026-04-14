/**
 * Identity and seed management.
 *
 * Vault (survives kill):  ~/ensoul-key-vault/resurrection-agent-seed.json
 *                         Just the seed + DID + pubkey. Never deleted.
 *                         Also caches the last known on-chain pointer
 *                         (state root + version + block) so the
 *                         resurrection script knows what to verify.
 *
 * Data dir (wiped on kill): ~/.ensoul/resurrection-agent/
 *                           Consciousness payload, posts ledger, logs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Ensoul } from "@ensoul-network/sdk";
import { log, errMsg } from "./log.js";

interface VaultEntry {
	did: string;
	publicKey: string;
	seed: string;
	bornAt: string;
	/** Pointer to on-chain state for verification on resurrection. */
	lastOnChain?: {
		version: number;
		stateRoot: string;
		blockHeight: number;
		syncedAt: string;
	};
	/** Last known topic titles (cached for resurrection thread narrative). */
	lastTopicTitles?: string[];
	/** Last known resurrection count. */
	lastResurrectionCount?: number;
}

export class Identity {
	private readonly vaultFile: string;
	private agent: Ensoul | null = null;
	private vault: VaultEntry | null = null;

	constructor(vaultDir: string) {
		this.vaultFile = join(vaultDir, "resurrection-agent-seed.json");
	}

	/** Load existing identity from vault, or create new one. */
	async init(): Promise<void> {
		try {
			const raw = await readFile(this.vaultFile, "utf-8");
			this.vault = JSON.parse(raw) as VaultEntry;
			this.agent = await Ensoul.fromSeed(this.vault.seed);
			await log(`Identity loaded from vault: ${this.vault.did}`);
		} catch {
			await log("No vault found, creating new agent identity...");
			this.agent = await Ensoul.createAgent();
			const exported = this.agent.exportIdentity();
			this.vault = {
				did: exported.did,
				publicKey: exported.publicKey,
				seed: exported.seed,
				bornAt: new Date().toISOString(),
			};
			await mkdir(join(this.vaultFile, ".."), { recursive: true });
			await writeFile(this.vaultFile, JSON.stringify(this.vault, null, "\t"), { mode: 0o600 });
			await log(`New identity written to vault: ${this.vault.did}`);
			try {
				const reg = await this.agent.register();
				await log(`On-chain registration: ${reg.registered}`);
			} catch (e) {
				await log(`Registration failed (will retry): ${errMsg(e)}`);
			}
		}
	}

	getAgent(): Ensoul {
		if (!this.agent) throw new Error("Identity not initialized");
		return this.agent;
	}

	getVault(): VaultEntry {
		if (!this.vault) throw new Error("Identity not initialized");
		return this.vault;
	}

	getDid(): string {
		return this.vault?.did ?? "unknown";
	}

	getBornAt(): string {
		return this.vault?.bornAt ?? new Date().toISOString();
	}

	getLastOnChain(): VaultEntry["lastOnChain"] | undefined {
		return this.vault?.lastOnChain;
	}

	async recordOnChain(version: number, stateRoot: string, blockHeight: number): Promise<void> {
		if (!this.vault) return;
		this.vault.lastOnChain = {
			version, stateRoot, blockHeight,
			syncedAt: new Date().toISOString(),
		};
		await writeFile(this.vaultFile, JSON.stringify(this.vault, null, "\t"), { mode: 0o600 });
	}

	/** Cache a minimal narrative snapshot for the resurrection thread. */
	async cacheNarrativeSnapshot(topicTitles: string[], resurrectionCount: number): Promise<void> {
		if (!this.vault) return;
		this.vault.lastTopicTitles = topicTitles.slice(0, 10);
		this.vault.lastResurrectionCount = resurrectionCount;
		await writeFile(this.vaultFile, JSON.stringify(this.vault, null, "\t"), { mode: 0o600 });
	}

	getCachedTopicTitles(): string[] {
		return this.vault?.lastTopicTitles ?? [];
	}

	getCachedResurrectionCount(): number {
		return this.vault?.lastResurrectionCount ?? 0;
	}
}
