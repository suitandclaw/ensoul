import type { AgentIdentity } from "@ensoul/identity";
import type { ConsciousnessTree } from "@ensoul/state-tree";

/**
 * The three Ensoul Handshake headers.
 */
export interface HandshakeHeaders {
	"X-Ensoul-Identity": string;
	"X-Ensoul-Proof": string;
	"X-Ensoul-Since": string;
}

/**
 * Result of verifying a handshake.
 */
export interface HandshakeVerification {
	valid: boolean;
	agentDid: string;
	consciousnessAge: number;
	consciousnessVersion: number;
	error?: string;
}

/** Handshake cache entry. */
interface CachedHandshake {
	headers: HandshakeHeaders;
	generatedAt: number;
	stateRoot: string;
}

/** Max age of a cached handshake in ms (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Max age of a received proof before it's considered stale (10 minutes). */
const FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

/**
 * HandshakeProvider: generates and caches the Ensoul Handshake headers.
 * Refreshes every 5 minutes or on state change.
 */
export class HandshakeProvider {
	private identity: AgentIdentity;
	private tree: ConsciousnessTree;
	private ensoulmentDate: Date;
	private cache: CachedHandshake | null = null;

	constructor(
		identity: AgentIdentity,
		tree: ConsciousnessTree,
		ensoulmentDate?: Date,
	) {
		this.identity = identity;
		this.tree = tree;
		this.ensoulmentDate = ensoulmentDate ?? new Date();
	}

	/**
	 * Generate fresh handshake headers, or return cached if still valid.
	 */
	async generateHandshake(): Promise<HandshakeHeaders> {
		const now = Date.now();
		const currentRoot = this.tree.rootHash;

		// Return cached if fresh and state hasn't changed
		if (
			this.cache &&
			now - this.cache.generatedAt < CACHE_TTL_MS &&
			this.cache.stateRoot === currentRoot
		) {
			return this.cache.headers;
		}

		// Generate fresh proof
		const version = this.tree.version;
		const timestamp = now;
		const proofPayload = `${currentRoot}:${version}:${timestamp}`;
		const signature = await this.identity.sign(
			new TextEncoder().encode(proofPayload),
		);
		const sigHex = Array.from(signature)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const headers: HandshakeHeaders = {
			"X-Ensoul-Identity": `did:ensoul:${this.identity.did}`,
			"X-Ensoul-Proof": `${sigHex}:${currentRoot}:${version}:${timestamp}`,
			"X-Ensoul-Since": this.ensoulmentDate.toISOString(),
		};

		this.cache = {
			headers,
			generatedAt: now,
			stateRoot: currentRoot,
		};

		return headers;
	}

	/**
	 * Force cache invalidation (call when state changes).
	 */
	invalidateCache(): void {
		this.cache = null;
	}

	/**
	 * Get the ensoulment date.
	 */
	getEnsoulmentDate(): Date {
		return this.ensoulmentDate;
	}

	/**
	 * Get consciousness age in days.
	 */
	getConsciousnessAgeDays(): number {
		const ms = Date.now() - this.ensoulmentDate.getTime();
		return Math.floor(ms / (1000 * 60 * 60 * 24));
	}
}

/**
 * Known DID entry for local verification cache.
 */
export interface KnownIdentity {
	did: string;
	publicKey: Uint8Array;
	verify: (data: Uint8Array, signature: Uint8Array) => Promise<boolean>;
}

/**
 * HandshakeVerifier: verifies incoming Ensoul Handshake headers.
 */
export class HandshakeVerifier {
	private knownIdentities: Map<string, KnownIdentity> = new Map();

	/**
	 * Register a known identity for local verification.
	 */
	registerIdentity(identity: KnownIdentity): void {
		this.knownIdentities.set(identity.did, identity);
	}

	/**
	 * Verify handshake headers.
	 */
	async verifyHandshake(headers: {
		"X-Ensoul-Identity"?: string;
		"X-Ensoul-Proof"?: string;
		"X-Ensoul-Since"?: string;
	}): Promise<HandshakeVerification> {
		const identityHeader = headers["X-Ensoul-Identity"];
		const proofHeader = headers["X-Ensoul-Proof"];
		const sinceHeader = headers["X-Ensoul-Since"];

		if (!identityHeader || !proofHeader || !sinceHeader) {
			return {
				valid: false,
				agentDid: "",
				consciousnessAge: 0,
				consciousnessVersion: 0,
				error: "Missing handshake headers",
			};
		}

		// Parse identity
		const agentDid = identityHeader.replace("did:ensoul:", "");

		// Parse proof: signature:stateRoot:version:timestamp
		const proofParts = proofHeader.split(":");
		if (proofParts.length < 4) {
			return {
				valid: false,
				agentDid,
				consciousnessAge: 0,
				consciousnessVersion: 0,
				error: "Malformed proof header",
			};
		}

		const sigHex = proofParts[0]!;
		const stateRoot = proofParts[1]!;
		const version = Number(proofParts[2]);
		const timestamp = Number(proofParts[3]);

		// Check timestamp freshness
		const now = Date.now();
		if (now - timestamp > FRESHNESS_WINDOW_MS) {
			return {
				valid: false,
				agentDid,
				consciousnessAge: 0,
				consciousnessVersion: version,
				error: "Proof expired (timestamp too old)",
			};
		}

		if (timestamp > now + 60000) {
			return {
				valid: false,
				agentDid,
				consciousnessAge: 0,
				consciousnessVersion: version,
				error: "Proof timestamp in the future",
			};
		}

		// Look up identity
		const known = this.knownIdentities.get(agentDid);
		if (!known) {
			return {
				valid: false,
				agentDid,
				consciousnessAge: 0,
				consciousnessVersion: version,
				error: "Unknown identity (not in local cache)",
			};
		}

		// Verify signature
		const proofPayload = `${stateRoot}:${version}:${timestamp}`;
		const signature = hexToBytes(sigHex);

		try {
			const valid = await known.verify(
				new TextEncoder().encode(proofPayload),
				signature,
			);

			if (!valid) {
				return {
					valid: false,
					agentDid,
					consciousnessAge: 0,
					consciousnessVersion: version,
					error: "Invalid signature",
				};
			}
		} catch {
			return {
				valid: false,
				agentDid,
				consciousnessAge: 0,
				consciousnessVersion: version,
				error: "Signature verification failed",
			};
		}

		// Compute consciousness age
		const sinceDate = new Date(sinceHeader);
		const ageDays = Math.floor(
			(now - sinceDate.getTime()) / (1000 * 60 * 60 * 24),
		);

		return {
			valid: true,
			agentDid,
			consciousnessAge: ageDays,
			consciousnessVersion: version,
		};
	}
}

/**
 * Standalone handshake generator for non-ElizaOS frameworks.
 */
export async function generateStandaloneHandshake(
	identity: AgentIdentity,
	tree: ConsciousnessTree,
	ensoulmentDate?: Date,
): Promise<HandshakeHeaders> {
	const provider = new HandshakeProvider(
		identity,
		tree,
		ensoulmentDate,
	);
	return provider.generateHandshake();
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}
