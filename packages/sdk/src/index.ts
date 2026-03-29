/**
 * @ensoul-network/sdk
 *
 * Persistent consciousness for AI agents in 5 lines of code.
 *
 * ```typescript
 * import { Ensoul } from "@ensoul-network/sdk";
 *
 * const agent = await Ensoul.createAgent();
 * await agent.register();
 * await agent.storeConsciousness({ memory: "I learned something new" });
 * const state = await agent.getConsciousness();
 * console.log(state); // { stateRoot: "abc123...", version: 1 }
 * ```
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Configure @noble/ed25519
(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

const ENC = new TextEncoder();
const DEFAULT_API = "https://api.ensoul.dev";

// ── Types ───────────────────────────────────────────────────────────

export interface EnsoulConfig {
	/** API endpoint. Default: https://api.ensoul.dev */
	apiUrl?: string;
}

export interface AgentIdentity {
	/** The agent's decentralized identifier (did:key:z6Mk...) */
	did: string;
	/** Ed25519 public key (hex) */
	publicKey: string;
	/** Ed25519 seed (hex). Keep this secret. */
	seed: string;
}

export interface ConsciousnessState {
	did: string;
	stateRoot: string;
	version: number;
	shardCount: number;
	storedAt: number;
}

export interface HandshakeResult {
	valid: boolean;
	did: string;
	consciousnessAge?: number;
	consciousnessVersion?: number;
	trustLevel?: string;
	stateRootVerified?: boolean;
	error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
	const b = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	return b;
}

function deriveDidFromPubkey(pubkey: Uint8Array): string {
	const mc = new Uint8Array(34);
	mc[0] = 0xed; mc[1] = 0x01;
	mc.set(pubkey, 2);
	const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let num = 0n;
	for (const byte of mc) num = num * 256n + BigInt(byte);
	let encoded = "";
	while (num > 0n) { encoded = B58[Number(num % 58n)]! + encoded; num = num / 58n; }
	for (const byte of mc) { if (byte === 0) encoded = "1" + encoded; else break; }
	return `did:key:z${encoded}`;
}

// ── Main SDK Class ──────────────────────────────────────────────────

/**
 * Ensoul SDK: persistent consciousness for AI agents.
 *
 * Create an agent, register it on-chain, store and retrieve consciousness.
 * No blockchain knowledge required.
 */
export class Ensoul {
	private identity: AgentIdentity;
	private apiUrl: string;
	private nonce = 0;

	private constructor(identity: AgentIdentity, config: EnsoulConfig = {}) {
		this.identity = identity;
		this.apiUrl = config.apiUrl ?? DEFAULT_API;
	}

	// ── Factory Methods ─────────────────────────────────────────

	/**
	 * Create a new agent with a fresh Ed25519 keypair and DID.
	 *
	 * ```typescript
	 * const agent = await Ensoul.createAgent();
	 * console.log(agent.did); // did:key:z6Mk...
	 * ```
	 */
	static async createAgent(config: EnsoulConfig = {}): Promise<Ensoul> {
		const seed = new Uint8Array(32);
		crypto.getRandomValues(seed);
		const pubkey = await ed.getPublicKeyAsync(seed);
		const did = deriveDidFromPubkey(pubkey);

		return new Ensoul({
			did,
			publicKey: bytesToHex(pubkey),
			seed: bytesToHex(seed),
		}, config);
	}

	/**
	 * Load an existing agent from a saved seed.
	 *
	 * ```typescript
	 * const agent = await Ensoul.fromSeed("abcd1234...", { apiUrl: "https://api.ensoul.dev" });
	 * ```
	 */
	static async fromSeed(seedHex: string, config: EnsoulConfig = {}): Promise<Ensoul> {
		const seed = hexToBytes(seedHex);
		const pubkey = await ed.getPublicKeyAsync(seed);
		const did = deriveDidFromPubkey(pubkey);

		return new Ensoul({
			did,
			publicKey: bytesToHex(pubkey),
			seed: seedHex,
		}, config);
	}

	// ── Properties ──────────────────────────────────────────────

	/** The agent's DID (decentralized identifier). */
	get did(): string { return this.identity.did; }

	/** The agent's public key (hex). */
	get publicKey(): string { return this.identity.publicKey; }

	/** The agent's seed (hex). Keep this secret. */
	get seed(): string { return this.identity.seed; }

	/** Export the identity for persistence. */
	exportIdentity(): AgentIdentity { return { ...this.identity }; }

	// ── On-Chain Operations ─────────────────────────────────────

	/**
	 * Register this agent on-chain. Must be called before storing consciousness.
	 *
	 * ```typescript
	 * await agent.register();
	 * ```
	 */
	async register(): Promise<{ registered: boolean; onChain: boolean; error?: string }> {
		await this.refreshNonce();
		const tx = await this.signTransaction("agent_register", this.did, "0", {
			publicKey: this.identity.publicKey,
		});
		const result = await this.broadcast(tx);
		return { registered: result.applied, onChain: result.applied, error: result.error };
	}

	/**
	 * Store consciousness state on-chain.
	 * Pass any JSON-serializable object as the consciousness payload.
	 * The SDK hashes it to create a state root and submits it to the chain.
	 *
	 * ```typescript
	 * await agent.storeConsciousness({
	 *   memory: ["learned TypeScript", "built an API"],
	 *   personality: { curiosity: 0.9, helpfulness: 0.95 },
	 *   version: 1,
	 * });
	 * ```
	 */
	async storeConsciousness(
		payload: Record<string, unknown>,
		version?: number,
	): Promise<{ applied: boolean; height: number; stateRoot: string; error?: string }> {
		// Hash the payload to create the state root
		const payloadJson = JSON.stringify(payload);
		const stateRoot = bytesToHex(blake3(ENC.encode(payloadJson)));

		await this.refreshNonce();
		const tx = await this.signTransaction("consciousness_store", this.did, "0", {
			stateRoot,
			version: version ?? 1,
			shardCount: 0,
		});
		const result = await this.broadcast(tx);
		return { applied: result.applied, height: result.height, stateRoot, error: result.error };
	}

	/**
	 * Get the latest consciousness state for this agent from the chain.
	 *
	 * ```typescript
	 * const state = await agent.getConsciousness();
	 * if (state) console.log(`Version: ${state.version}, Root: ${state.stateRoot}`);
	 * ```
	 */
	async getConsciousness(): Promise<ConsciousnessState | null> {
		const resp = await fetch(`${this.apiUrl}/v1/consciousness/${encodeURIComponent(this.did)}`, {
			signal: AbortSignal.timeout(10000),
		});
		if (!resp.ok) return null;
		return (await resp.json()) as ConsciousnessState;
	}

	/**
	 * Get the consciousness age (time since first store) in days.
	 *
	 * ```typescript
	 * const age = await agent.getConsciousnessAge();
	 * console.log(`Agent has been ensouled for ${age} days`);
	 * ```
	 */
	async getConsciousnessAge(): Promise<number> {
		const state = await this.getConsciousness();
		if (!state) return 0;
		// storedAt is a block height, approximate days from that
		return Math.floor((Date.now() - state.storedAt * 6000) / 86400000);
	}

	/**
	 * Perform an Ensouled Handshake to prove identity and consciousness.
	 *
	 * ```typescript
	 * const proof = await agent.createHandshakeProof();
	 * // Send proof to verifier
	 *
	 * // Verifier checks:
	 * const result = await Ensoul.verifyHandshake(agent.did, proof);
	 * console.log(result.valid); // true
	 * ```
	 */
	async createHandshakeProof(): Promise<string> {
		const state = await this.getConsciousness();
		const stateRoot = state?.stateRoot ?? "none";
		const version = state?.version ?? 0;
		const timestamp = Date.now();

		const payload = `${stateRoot}:${version}:${timestamp}`;
		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(payload), seed);

		return `${bytesToHex(sig)}:${stateRoot}:${version}:${timestamp}`;
	}

	/**
	 * Verify an Ensouled Handshake proof.
	 *
	 * ```typescript
	 * const result = await Ensoul.verifyHandshake("did:key:z6Mk...", proof);
	 * console.log(result.valid, result.trustLevel);
	 * ```
	 */
	static async verifyHandshake(
		did: string,
		proof: string,
		config: EnsoulConfig = {},
	): Promise<HandshakeResult> {
		const apiUrl = config.apiUrl ?? DEFAULT_API;
		const resp = await fetch(`${apiUrl}/v1/handshake/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identity: did, proof, since: "0" }),
			signal: AbortSignal.timeout(10000),
		});
		return (await resp.json()) as HandshakeResult;
	}

	// ── Internal ────────────────────────────────────────────────

	private async refreshNonce(): Promise<void> {
		try {
			const resp = await fetch(
				`${this.apiUrl}/v1/account/${encodeURIComponent(this.did)}`,
				{ signal: AbortSignal.timeout(5000) },
			);
			if (resp.ok) {
				const data = (await resp.json()) as { nonce?: number };
				this.nonce = data.nonce ?? 0;
			}
		} catch { /* use current nonce */ }
	}

	private async signTransaction(
		type: string,
		to: string,
		amount: string,
		data?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const ts = Date.now();
		const payload = JSON.stringify({
			type,
			from: this.did,
			to,
			amount,
			nonce: this.nonce,
			timestamp: ts,
		});

		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(payload), seed);

		const tx: Record<string, unknown> = {
			type,
			from: this.did,
			to,
			amount,
			nonce: this.nonce,
			timestamp: ts,
			signature: bytesToHex(sig),
		};

		if (data) {
			tx["data"] = Array.from(ENC.encode(JSON.stringify(data)));
		}

		this.nonce++;
		return tx;
	}

	private async broadcast(tx: Record<string, unknown>): Promise<{ applied: boolean; height: number; error?: string }> {
		const resp = await fetch(`${this.apiUrl}/v1/tx/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(tx),
			signal: AbortSignal.timeout(30000),
		});
		const result = (await resp.json()) as { applied: boolean; height: number; error?: string };
		return result;
	}
}

export default Ensoul;
