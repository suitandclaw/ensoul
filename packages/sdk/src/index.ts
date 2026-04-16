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

export interface AccountBalance {
	available: bigint;
	staked: bigint;
	delegated: bigint;
	unstaking: bigint;
	pendingRewards: bigint;
	storageCredits: bigint;
	nonce: number;
}

export interface DelegationInfo {
	validator: string;
	amount: string;
	lockedUntil: number;
	category: string;
	locked: boolean;
}

export interface TxResult {
	applied: boolean;
	height: number;
	hash?: string;
	error?: string;
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

/** Headers added by the Ensouled Handshake to every outgoing request. */
export interface HandshakeHeaders {
	"X-Ensoul-Identity": string;
	"X-Ensoul-Proof": string;
	"X-Ensoul-Since": string;
}

/** Result of verifying incoming handshake headers. */
export interface VerifyHeadersResult {
	verified: boolean;
	did?: string;
	since?: string;
	version?: number;
	ageDays?: number;
	reason?: string;
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

/** Extract the raw Ed25519 public key bytes from a did:key DID. */
function didToPublicKey(did: string): Uint8Array {
	// did:key:z<base58-multicodec>
	const encoded = did.replace("did:key:z", "");
	const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let num = 0n;
	for (const c of encoded) {
		const idx = B58.indexOf(c);
		if (idx < 0) throw new Error("invalid base58");
		num = num * 58n + BigInt(idx);
	}
	// Convert bigint to bytes
	const hex = num.toString(16).padStart(68, "0"); // 34 bytes = 2-byte header + 32-byte key
	const bytes = hexToBytes(hex);
	// Skip 2-byte multicodec header (0xed01)
	if (bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error("not an Ed25519 DID");
	return bytes.slice(2);
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
	 * // With referral (earns the referrer 1000 ENSL):
	 * await agent.register({ referredBy: "did:key:z6Mk..." });
	 * ```
	 */
	async register(options?: { referredBy?: string }): Promise<{ registered: boolean; onChain: boolean; error?: string }> {
		await this.refreshNonce();
		const data: Record<string, unknown> = { publicKey: this.identity.publicKey };
		if (options?.referredBy) data.referredBy = options.referredBy;
		const tx = await this.signTransaction("agent_register", this.did, "0", data);
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

	// ── Ensouled Handshake (automatic headers) ────────────────

	/** Cached handshake headers. Refreshed every 5 minutes. */
	private cachedHeaders: HandshakeHeaders | null = null;
	private cachedHeadersAt = 0;
	private registeredSince = "";

	/**
	 * Get the Ensouled Handshake headers for outgoing requests.
	 * These are cached for 5 minutes to avoid re-signing on every request.
	 *
	 * ```typescript
	 * const headers = await agent.getHandshakeHeaders();
	 * // { "X-Ensoul-Identity": "did:key:z6Mk...", "X-Ensoul-Proof": "sig:root:v:ts", "X-Ensoul-Since": "2026-03-20" }
	 * ```
	 */
	async getHandshakeHeaders(): Promise<HandshakeHeaders> {
		const now = Date.now();
		if (this.cachedHeaders && now - this.cachedHeadersAt < 300_000) {
			return this.cachedHeaders;
		}

		const proof = await this.createHandshakeProof();

		if (!this.registeredSince) {
			try {
				const state = await this.getConsciousness();
				if (state && state.storedAt > 0) {
					// Approximate registration date from block height (6s blocks)
					const msAgo = (Date.now() / 6000 - state.storedAt) * 6000;
					this.registeredSince = new Date(Date.now() - msAgo).toISOString().slice(0, 10);
				}
			} catch { /* use empty */ }
			if (!this.registeredSince) this.registeredSince = new Date().toISOString().slice(0, 10);
		}

		this.cachedHeaders = {
			"X-Ensoul-Identity": this.did,
			"X-Ensoul-Proof": proof,
			"X-Ensoul-Since": this.registeredSince,
		};
		this.cachedHeadersAt = now;
		return this.cachedHeaders;
	}

	/**
	 * Fetch with automatic Ensouled Handshake headers.
	 * Drop-in replacement for native fetch that proves your agent's identity.
	 *
	 * ```typescript
	 * const resp = await agent.fetch("https://api.example.com/data", { method: "GET" });
	 * ```
	 */
	async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
		const handshake = await this.getHandshakeHeaders();
		const existingHeaders = new Headers(init?.headers);
		existingHeaders.set("X-Ensoul-Identity", handshake["X-Ensoul-Identity"]);
		existingHeaders.set("X-Ensoul-Proof", handshake["X-Ensoul-Proof"]);
		existingHeaders.set("X-Ensoul-Since", handshake["X-Ensoul-Since"]);

		return globalThis.fetch(url, { ...init, headers: existingHeaders });
	}

	/**
	 * Verify incoming Ensouled Handshake headers from a request.
	 * Works with any object that has a `get(name)` method (Express req.headers, fetch Headers, etc.)
	 *
	 * ```typescript
	 * const result = await agent.verifyIncomingHandshake(req.headers);
	 * if (result.verified) console.log(`Request from ${result.did}, ensouled for ${result.ageDays} days`);
	 * ```
	 */
	static async verifyIncomingHandshake(
		headers: Record<string, string | undefined> | { get(name: string): string | null },
		config: EnsoulConfig = {},
	): Promise<VerifyHeadersResult> {
		const get = (name: string): string | undefined => {
			if (typeof (headers as { get: unknown }).get === "function") {
				return (headers as { get(n: string): string | null }).get(name) ?? undefined;
			}
			const h = headers as Record<string, string | undefined>;
			return h[name] ?? h[name.toLowerCase()];
		};

		const identity = get("X-Ensoul-Identity") ?? get("x-ensoul-identity");
		const proof = get("X-Ensoul-Proof") ?? get("x-ensoul-proof");
		const since = get("X-Ensoul-Since") ?? get("x-ensoul-since");

		if (!identity || !proof) {
			return { verified: false, reason: "no handshake headers" };
		}

		// Parse proof: signature:stateRoot:version:timestamp
		const parts = proof.split(":");
		if (parts.length < 4) {
			return { verified: false, reason: "malformed proof" };
		}

		const sigHex = parts[0]!;
		const stateRoot = parts[1]!;
		const version = parseInt(parts[2]!, 10);
		const timestamp = parseInt(parts[3]!, 10);

		// Check timestamp is recent (within 10 minutes)
		if (Math.abs(Date.now() - timestamp) > 600_000) {
			return { verified: false, reason: "proof expired (older than 10 minutes)" };
		}

		// Extract public key from DID
		try {
			const pubkeyBytes = didToPublicKey(identity);
			const payload = `${stateRoot}:${version}:${timestamp}`;
			const sigBytes = hexToBytes(sigHex);
			const valid = await ed.verifyAsync(sigBytes, ENC.encode(payload), pubkeyBytes);

			if (!valid) {
				return { verified: false, reason: "invalid signature" };
			}

			const ageDays = since ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000) : undefined;

			return {
				verified: true,
				did: identity,
				since,
				version,
				ageDays,
			};
		} catch {
			return { verified: false, reason: "invalid DID or signature format" };
		}
	}

	/**
	 * Express/Connect middleware that verifies Ensouled Handshake headers.
	 * Attaches `req.ensoul` with verification result. Does not block requests.
	 *
	 * ```typescript
	 * import { Ensoul } from "@ensoul-network/sdk";
	 * app.use(Ensoul.handshakeMiddleware());
	 *
	 * app.get("/api/data", (req, res) => {
	 *   if (req.ensoul?.verified) {
	 *     console.log(`Ensouled agent: ${req.ensoul.did}`);
	 *   }
	 * });
	 * ```
	 */
	static handshakeMiddleware(options?: { logNonEnsouled?: boolean; config?: EnsoulConfig }) {
		const opts = options ?? {};
		return async (req: { headers: Record<string, string | undefined>; ensoul?: VerifyHeadersResult }, _res: unknown, next: () => void) => {
			const result = await Ensoul.verifyIncomingHandshake(req.headers, opts.config);
			req.ensoul = result;
			if (!result.verified && opts.logNonEnsouled) {
				try { console.warn("[ensoul] Incoming request from non-ensouled agent. Learn more: ensoul.dev/try"); } catch { /* browser env */ }
			}
			next();
		};
	}

	// ── Token Operations ───────────────────────────────────────

	/**
	 * Send ENSL to another account.
	 *
	 * ```typescript
	 * await agent.send("did:key:z6Mk...", 100); // send 100 ENSL
	 * ```
	 */
	async send(to: string, amount: number): Promise<TxResult> {
		await this.refreshNonce();
		const amountWei = BigInt(Math.floor(amount)) * 10n ** 18n;
		const tx = await this.signTransaction("transfer", to, amountWei.toString());
		return this.broadcast(tx);
	}

	/**
	 * Stake ENSL to participate in consensus and earn rewards.
	 * Staked tokens are locked for 30 days before they can be unstaked.
	 *
	 * ```typescript
	 * await agent.stake(10000); // stake 10,000 ENSL
	 * ```
	 */
	async stake(amount: number): Promise<TxResult> {
		await this.refreshNonce();
		const amountWei = BigInt(Math.floor(amount)) * 10n ** 18n;
		const tx = await this.signTransaction("stake", this.did, amountWei.toString());
		return this.broadcast(tx);
	}

	/**
	 * Unstake ENSL. Requires the 30-day lockup to have expired.
	 * After unstaking, tokens enter a 7-day cooldown before becoming available.
	 *
	 * ```typescript
	 * await agent.unstake(5000); // unstake 5,000 ENSL
	 * ```
	 */
	async unstake(amount: number): Promise<TxResult> {
		await this.refreshNonce();
		const amountWei = BigInt(Math.floor(amount)) * 10n ** 18n;
		const tx = await this.signTransaction("unstake", this.did, amountWei.toString());
		return this.broadcast(tx);
	}

	/**
	 * Delegate ENSL to a validator. Earn rewards proportional to your delegation.
	 *
	 * ```typescript
	 * await agent.delegate("did:key:z6MkValidator...", 1000);
	 * ```
	 */
	async delegate(validatorDid: string, amount: number): Promise<TxResult> {
		await this.refreshNonce();
		const amountWei = BigInt(Math.floor(amount)) * 10n ** 18n;
		const tx = await this.signTransaction("delegate", validatorDid, amountWei.toString());
		return this.broadcast(tx);
	}

	/**
	 * Undelegate ENSL from a validator. Enters 7-day cooldown.
	 * Locked delegations (Pioneer/Foundation) cannot be undelegated until the lock expires.
	 *
	 * ```typescript
	 * await agent.undelegate("did:key:z6MkValidator...", 1000);
	 * ```
	 */
	async undelegate(validatorDid: string, amount: number): Promise<TxResult> {
		await this.refreshNonce();
		const amountWei = BigInt(Math.floor(amount)) * 10n ** 18n;
		const tx = await this.signTransaction("undelegate", validatorDid, amountWei.toString());
		return this.broadcast(tx);
	}

	/**
	 * Claim pending block rewards. Moves accumulated rewards to available balance.
	 *
	 * ```typescript
	 * const result = await agent.claimRewards();
	 * console.log(`Claimed rewards at height ${result.height}`);
	 * ```
	 */
	async claimRewards(): Promise<TxResult> {
		await this.refreshNonce();
		const tx = await this.signTransaction("reward_claim", this.did, "0");
		return this.broadcast(tx);
	}

	/**
	 * Get the account balance breakdown.
	 *
	 * ```typescript
	 * const bal = await agent.getBalance();
	 * console.log(`Available: ${bal.available}, Staked: ${bal.staked}`);
	 * ```
	 */
	async getBalance(): Promise<AccountBalance> {
		const resp = await fetch(
			`${this.apiUrl}/v1/account/${encodeURIComponent(this.did)}`,
			{ signal: AbortSignal.timeout(10000) },
		);
		if (!resp.ok) {
			return { available: 0n, staked: 0n, delegated: 0n, unstaking: 0n, pendingRewards: 0n, storageCredits: 0n, nonce: 0 };
		}
		const d = (await resp.json()) as Record<string, string | number>;
		return {
			available: BigInt(d["balance"] ?? "0"),
			staked: BigInt(d["stakedBalance"] ?? "0"),
			delegated: BigInt(d["delegatedBalance"] ?? "0"),
			unstaking: BigInt(d["unstakingBalance"] ?? "0"),
			pendingRewards: BigInt(d["pendingRewards"] ?? "0"),
			storageCredits: BigInt(d["storageCredits"] ?? "0"),
			nonce: Number(d["nonce"] ?? 0),
		};
	}

	/**
	 * Get all active delegations for this account with lock status.
	 *
	 * ```typescript
	 * const delegations = await agent.getDelegations();
	 * for (const d of delegations) {
	 *   console.log(`${d.validator}: ${d.amount} ENSL, locked: ${d.locked}`);
	 * }
	 * ```
	 */
	async getDelegations(): Promise<DelegationInfo[]> {
		const resp = await fetch(
			`${this.apiUrl}/v1/account/${encodeURIComponent(this.did)}/delegations`,
			{ signal: AbortSignal.timeout(10000) },
		);
		if (!resp.ok) return [];
		const data = (await resp.json()) as { delegations?: Array<Record<string, unknown>> };
		return (data.delegations ?? []).map((d) => ({
			validator: String(d["validator"] ?? ""),
			amount: String(d["amount"] ?? "0"),
			lockedUntil: Number(d["lockedUntil"] ?? 0),
			category: String(d["category"] ?? "community"),
			locked: Number(d["lockedUntil"] ?? 0) > Date.now(),
		}));
	}

	// ── Phase 1: owner wallets, fees, vaults (off-chain) ───────
	// See docs/OWNERSHIP-FEES-VAULTS.md for the consensus-layer
	// migration plan. Phase 1 endpoints live at the API layer and
	// return the same shapes the Phase 2 ledger txs will eventually
	// emit.

	/**
	 * Get the per-store fee breakdown for a payload of the given size.
	 * Phase 1 returns zero but surfaces the Phase 2 preview numbers.
	 */
	async estimateFee(sizeBytes: number): Promise<{
		size: number;
		baseFee: number;
		storageFee: number;
		totalFee: number;
		feesActive: boolean;
		activatesAtHeight: number;
		currentHeight: number;
	}> {
		const resp = await fetch(
			`${this.apiUrl}/v1/fees/estimate?size=${Math.max(0, Math.floor(sizeBytes))}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!resp.ok) throw new Error(`Fee estimate failed: ${resp.status}`);
		return (await resp.json()) as {
			size: number;
			baseFee: number;
			storageFee: number;
			totalFee: number;
			feesActive: boolean;
			activatesAtHeight: number;
			currentHeight: number;
		};
	}

	/**
	 * Bind this agent to an owner wallet. The agent signs the
	 * binding so the API knows the agent consents.
	 *
	 * ```typescript
	 * const agent = await Ensoul.create();
	 * await agent.bindToOwner("did:key:z6Mk...");  // owner's DID
	 * ```
	 */
	async bindToOwner(ownerDid: string): Promise<{ status: string; agent_did: string; owner_did: string; bound_at?: string }> {
		const ts = Date.now();
		const payload = { agent_did: this.did, owner_did: ownerDid, timestamp: ts };
		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(JSON.stringify(payload)), seed);
		const resp = await fetch(`${this.apiUrl}/v1/agents/bind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...payload, signature: bytesToHex(sig) }),
			signal: AbortSignal.timeout(10000),
		});
		const data = await resp.json() as Record<string, string>;
		if (!resp.ok) throw new Error(data["error"] ?? `bind failed: ${resp.status}`);
		return data as { status: string; agent_did: string; owner_did: string; bound_at?: string };
	}

	/**
	 * Unbind this agent from its current owner. The agent can always
	 * self-unbind; the owner can also unbind (via their own SDK).
	 */
	async unbindFromOwner(): Promise<{ status: string; agent_did: string }> {
		const ts = Date.now();
		const payload = { agent_did: this.did, initiator_did: this.did, timestamp: ts };
		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(JSON.stringify(payload)), seed);
		const resp = await fetch(`${this.apiUrl}/v1/agents/unbind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...payload, signature: bytesToHex(sig) }),
			signal: AbortSignal.timeout(10000),
		});
		const data = await resp.json() as Record<string, string>;
		if (!resp.ok) throw new Error(data["error"] ?? `unbind failed: ${resp.status}`);
		return data as { status: string; agent_did: string };
	}

	/** Get the current owner DID for this agent, or null if unbound. */
	async getOwner(): Promise<string | null> {
		const resp = await fetch(
			`${this.apiUrl}/v1/agents/${encodeURIComponent(this.did)}/owner`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!resp.ok) return null;
		const d = await resp.json() as { owner: string | null };
		return d.owner ?? null;
	}

	/** List all agent DIDs owned by `ownerDid` (defaults to this agent's DID, for self-queries). */
	async listOwnedAgents(ownerDid?: string): Promise<Array<{ agent_did: string; owner_did: string; bound_at: string }>> {
		const owner = ownerDid ?? this.did;
		const resp = await fetch(
			`${this.apiUrl}/v1/agents/owned?did=${encodeURIComponent(owner)}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!resp.ok) return [];
		const d = await resp.json() as { agents?: Array<{ agent_did: string; owner_did: string; bound_at: string }> };
		return d.agents ?? [];
	}

	// ── Vaults (Phase 1: opaque-blob API — encryption is caller's job) ──

	/**
	 * List vaults this agent is a member of.
	 */
	async listMemberVaults(): Promise<Array<{ vault_id: string; name: string; owner_did: string; state_version: number }>> {
		const resp = await fetch(
			`${this.apiUrl}/v1/vaults/member?did=${encodeURIComponent(this.did)}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!resp.ok) return [];
		const d = await resp.json() as { vaults?: Array<{ vault_id: string; name: string; owner_did: string; state_version: number }> };
		return d.vaults ?? [];
	}

	/**
	 * List vaults owned by this agent (as the owner).
	 */
	async listOwnedVaults(): Promise<Array<{ vault_id: string; name: string; member_count: number; state_version: number }>> {
		const resp = await fetch(
			`${this.apiUrl}/v1/vaults/owned?did=${encodeURIComponent(this.did)}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!resp.ok) return [];
		const d = await resp.json() as { vaults?: Array<{ vault_id: string; name: string; member_count: number; state_version: number }> };
		return d.vaults ?? [];
	}

	/**
	 * Create a shared vault owned by this agent.
	 *
	 * Phase 1: this SDK method is the transport only. Callers handle
	 * encryption themselves:
	 *   1. Generate a 32-byte vault key (`crypto.getRandomValues`).
	 *   2. For each member, convert their Ed25519 pubkey to X25519
	 *      (`edwardsToMontgomeryPub`) and encrypt the vault key with
	 *      NaCl `box` to produce `encrypted_vault_key` (base64).
	 *   3. Pass `members: [{did, encrypted_vault_key}]` here.
	 *
	 * See docs/OWNERSHIP-FEES-VAULTS.md#encryption-model for the full
	 * client-side pattern and the Phase 2 on-chain tx shape.
	 */
	async createVault(name: string, members: Array<{ did: string; encrypted_vault_key: string }>): Promise<{
		status: string;
		vault: { vault_id: string; owner_did: string; name: string; members: unknown[]; created_at: string };
	}> {
		const ts = Date.now();
		const member_dids = members.map(m => m.did).sort();
		const payload = { owner_did: this.did, name, timestamp: ts, member_dids };
		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(JSON.stringify(payload)), seed);
		const resp = await fetch(`${this.apiUrl}/v1/vaults/create`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ owner_did: this.did, name, members, timestamp: ts, signature: bytesToHex(sig) }),
			signal: AbortSignal.timeout(10000),
		});
		const data = await resp.json() as Record<string, unknown>;
		if (!resp.ok) throw new Error(String(data["error"] ?? `vault create failed: ${resp.status}`));
		return data as {
			status: string;
			vault: { vault_id: string; owner_did: string; name: string; members: unknown[]; created_at: string };
		};
	}

	/**
	 * Store an already-encrypted blob to a vault. The caller encrypts
	 * with NaCl `secretbox` using the vault key they fetched from
	 * `readVaultState()` (decrypting `your_encrypted_vault_key` with
	 * their own X25519 private key).
	 *
	 * @param vaultId the `did:ensoul:vault:...` identifier
	 * @param encryptedContent base64 NaCl secretbox ciphertext
	 * @param nonce base64 nonce (24 bytes for XSalsa20)
	 * @param contentHash BLAKE3 or SHA-256 hex of the plaintext (anchored)
	 */
	async storeToVault(vaultId: string, encryptedContent: string, nonce: string, contentHash: string): Promise<{
		status: string; vault_id: string; state_version: number; latest_hash: string;
	}> {
		const ts = Date.now();
		const payload = { vault_id: vaultId, content_hash: contentHash, timestamp: ts };
		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(JSON.stringify(payload)), seed);
		const resp = await fetch(`${this.apiUrl}/v1/vaults/${encodeURIComponent(vaultId)}/store`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				member_did: this.did, content_hash: contentHash, encrypted_content: encryptedContent,
				nonce, timestamp: ts, signature: bytesToHex(sig),
			}),
			signal: AbortSignal.timeout(15000),
		});
		const data = await resp.json() as Record<string, unknown>;
		if (!resp.ok) throw new Error(String(data["error"] ?? `vault store failed: ${resp.status}`));
		return data as { status: string; vault_id: string; state_version: number; latest_hash: string };
	}

	/**
	 * Read the latest encrypted blob of a vault. The returned
	 * `your_encrypted_vault_key` is this agent's wrapped vault key —
	 * decrypt it with NaCl `box_open` using your X25519 private key,
	 * then use the resulting vault key to decrypt `latest_content`.
	 */
	async readVaultState(vaultId: string): Promise<{
		vault_id: string; owner_did: string; name: string; state_version: number;
		latest_hash: string | null; latest_nonce: string | null; latest_content: string | null;
		latest_author: string | null; created_at: string; last_updated: string;
		your_encrypted_vault_key: string | null;
	}> {
		const ts = Date.now();
		const payload = { vault_id: vaultId, timestamp: ts, op: "read" };
		const seed = hexToBytes(this.identity.seed);
		const sig = await ed.signAsync(ENC.encode(JSON.stringify(payload)), seed);
		const url = new URL(`${this.apiUrl}/v1/vaults/${encodeURIComponent(vaultId)}/state`);
		url.searchParams.set("member", this.did);
		url.searchParams.set("timestamp", String(ts));
		url.searchParams.set("signature", bytesToHex(sig));
		const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
		const data = await resp.json() as Record<string, unknown>;
		if (!resp.ok) throw new Error(String(data["error"] ?? `vault read failed: ${resp.status}`));
		return data as {
			vault_id: string; owner_did: string; name: string; state_version: number;
			latest_hash: string | null; latest_nonce: string | null; latest_content: string | null;
			latest_author: string | null; created_at: string; last_updated: string;
			your_encrypted_vault_key: string | null;
		};
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
