import type { AgentIdentity } from "@ensoul/identity";
import type { AbstractLevel } from "abstract-level";
import type {
	ConsciousnessTree,
	StateTransition,
	MerkleProof,
	BatchOp,
} from "./types.js";
import {
	buildMerkleTree,
	generateProof,
	verifyMerkleProof,
	EMPTY_HASH,
	bytesToHex,
	hexToBytes,
} from "./merkle.js";

/** Prefix constants for LevelDB keys */
const PREFIX = {
	ENTRY: "entry:",
	TRANSITION: "transition:",
	META_VERSION: "meta:version",
	META_ROOT: "meta:rootHash",
} as const;

/**
 * JSON shape used for full serialization.
 */
interface SerializedTreeData {
	version: number;
	rootHash: string;
	entries: Array<[string, string]>;
	transitions: Array<{
		version: number;
		rootHash: string;
		previousRootHash: string;
		timestamp: number;
		operations: Array<{
			op: "set" | "delete";
			key: string;
			value?: string;
		}>;
		signature: string;
	}>;
}

/**
 * JSON shape used for delta serialization.
 */
interface DeltaData {
	fromVersion: number;
	toVersion: number;
	rootHash: string;
	entries: Array<[string, string | null]>;
	transitions: Array<{
		version: number;
		rootHash: string;
		previousRootHash: string;
		timestamp: number;
		operations: Array<{ op: "set" | "delete"; key: string }>;
		signature: string;
	}>;
}

/**
 * Create the canonical message bytes for signing a state transition.
 * Deterministic JSON encoding of all transition fields except signature.
 */
function transitionMessage(fields: {
	version: number;
	rootHash: string;
	previousRootHash: string;
	timestamp: number;
	operations: Array<{ op: "set" | "delete"; key: string }>;
}): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(fields));
}

/**
 * Merklized key-value store backed by Blake3 Merkle trees,
 * signed state transitions, and optional LevelDB persistence.
 */
export class ConsciousnessTreeImpl implements ConsciousnessTree {
	private entries: Map<string, Uint8Array>;
	private _rootHash: string;
	private _version: number;
	private transitions: StateTransition[];
	private snapshots: Map<number, Map<string, Uint8Array>>;
	private identity: AgentIdentity;
	private db: AbstractLevel<string, string, string> | null;

	constructor(
		identity: AgentIdentity,
		db: AbstractLevel<string, string, string> | null,
		entries?: Map<string, Uint8Array>,
		version?: number,
		rootHash?: string,
		transitions?: StateTransition[],
		snapshots?: Map<number, Map<string, Uint8Array>>,
	) {
		this.identity = identity;
		this.db = db;
		this.entries = entries ?? new Map();
		this._version = version ?? 0;
		this.transitions = transitions ? [...transitions] : [];
		this.snapshots = snapshots ?? new Map();

		if (rootHash !== undefined) {
			this._rootHash = rootHash;
		} else {
			const result = buildMerkleTree(this.entries);
			this._rootHash = result.root;
		}

		if (!this.snapshots.has(this._version)) {
			this.snapshots.set(this._version, new Map(this.entries));
		}
	}

	get rootHash(): string {
		return this._rootHash;
	}

	get version(): number {
		return this._version;
	}

	/** Get a value by key. */
	async get(key: string): Promise<Uint8Array | null> {
		return this.entries.get(key) ?? null;
	}

	/** Get a value with its Merkle inclusion proof. */
	async getWithProof(
		key: string,
	): Promise<{ value: Uint8Array | null; proof: MerkleProof }> {
		const value = this.entries.get(key) ?? null;

		if (value === null) {
			return { value: null, proof: { siblings: [], leafHash: "" } };
		}

		const treeResult = buildMerkleTree(this.entries);
		const leafIndex = treeResult.sortedKeys.indexOf(key);

		if (leafIndex === -1) {
			return { value: null, proof: { siblings: [], leafHash: "" } };
		}

		const proof = generateProof(treeResult.layers, leafIndex);
		return { value, proof };
	}

	/** Set a key-value pair. Returns the new root hash. */
	async set(key: string, value: Uint8Array): Promise<string> {
		return this.applyBatch([{ op: "set", key, value }]);
	}

	/** Delete a key. Returns the new root hash. */
	async delete(key: string): Promise<string> {
		return this.applyBatch([{ op: "delete", key }]);
	}

	/** Apply multiple operations atomically. Returns the new root hash. */
	async batch(ops: BatchOp[]): Promise<string> {
		return this.applyBatch(ops);
	}

	/**
	 * Core mutation: apply a batch of operations, recompute the root,
	 * create and sign a state transition, persist to LevelDB.
	 */
	private async applyBatch(ops: BatchOp[]): Promise<string> {
		const previousRootHash = this._rootHash;

		const appliedOps: Array<{ op: "set" | "delete"; key: string }> = [];
		for (const op of ops) {
			if (op.op === "set" && op.value) {
				this.entries.set(op.key, op.value);
				appliedOps.push({ op: "set", key: op.key });
			} else if (op.op === "delete") {
				this.entries.delete(op.key);
				appliedOps.push({ op: "delete", key: op.key });
			}
		}

		const result = buildMerkleTree(this.entries);
		this._rootHash = result.root;
		this._version += 1;

		const timestamp = Date.now();
		const message = transitionMessage({
			version: this._version,
			rootHash: this._rootHash,
			previousRootHash,
			timestamp,
			operations: appliedOps,
		});
		const signature = await this.identity.sign(message);

		const transition: StateTransition = {
			version: this._version,
			rootHash: this._rootHash,
			previousRootHash,
			timestamp,
			operations: appliedOps,
			signature,
		};

		this.transitions.push(transition);
		this.snapshots.set(this._version, new Map(this.entries));

		await this.persistTransition(transition);

		return this._rootHash;
	}

	/** Get a snapshot of the tree at a previous version. */
	async getVersion(version: number): Promise<ConsciousnessTree> {
		if (version < 0 || version > this._version) {
			throw new Error(
				`Version ${version} out of range (0..${this._version})`,
			);
		}

		const snapshot = this.snapshots.get(version);
		if (!snapshot) {
			throw new Error(`Snapshot for version ${version} not available`);
		}

		const entries = new Map(snapshot);
		const transitions = this.transitions.filter(
			(t) => t.version <= version,
		);
		const lastTransition = transitions[transitions.length - 1];
		const rootHash =
			version === 0
				? EMPTY_HASH
				: lastTransition?.rootHash ?? EMPTY_HASH;

		// Historical snapshots share identity but have independent snapshots
		const versionSnapshots = new Map<number, Map<string, Uint8Array>>();
		for (const [v, snap] of this.snapshots) {
			if (v <= version) {
				versionSnapshots.set(v, snap);
			}
		}

		return new ConsciousnessTreeImpl(
			this.identity,
			null, // historical snapshots are in-memory only
			entries,
			version,
			rootHash,
			transitions,
			versionSnapshots,
		);
	}

	/** Get the history of state transitions between two versions. */
	async getHistory(
		fromVersion: number,
		toVersion: number,
	): Promise<StateTransition[]> {
		if (
			fromVersion < 0 ||
			toVersion > this._version ||
			fromVersion > toVersion
		) {
			throw new Error(
				`Invalid version range: ${fromVersion}..${toVersion}`,
			);
		}
		return this.transitions.filter(
			(t) => t.version > fromVersion && t.version <= toVersion,
		);
	}

	/**
	 * Serialize the full tree state: all entries, transitions (with values for replay),
	 * and metadata. Returns a Uint8Array (JSON-encoded).
	 */
	async serialize(): Promise<Uint8Array> {
		const data: SerializedTreeData = {
			version: this._version,
			rootHash: this._rootHash,
			entries: [...this.entries.entries()].map(([k, v]) => [
				k,
				bytesToHex(v),
			]),
			transitions: this.transitions.map((t) => ({
				version: t.version,
				rootHash: t.rootHash,
				previousRootHash: t.previousRootHash,
				timestamp: t.timestamp,
				operations: t.operations.map((op) => {
					if (op.op === "set") {
						const snap = this.snapshots.get(t.version);
						const val = snap?.get(op.key);
						if (val) {
							return {
								op: op.op as "set" | "delete",
								key: op.key,
								value: bytesToHex(val),
							};
						}
					}
					return { op: op.op as "set" | "delete", key: op.key };
				}),
				signature: bytesToHex(t.signature),
			})),
		};
		return new TextEncoder().encode(JSON.stringify(data));
	}

	/**
	 * Serialize only the changes since a given version.
	 * Includes changed entries and transitions in the range.
	 */
	async serializeDelta(fromVersion: number): Promise<Uint8Array> {
		if (fromVersion < 0 || fromVersion > this._version) {
			throw new Error(`Invalid fromVersion: ${fromVersion}`);
		}

		const relevantTransitions = this.transitions.filter(
			(t) => t.version > fromVersion && t.version <= this._version,
		);

		const changedKeys = new Set<string>();
		for (const t of relevantTransitions) {
			for (const op of t.operations) {
				changedKeys.add(op.key);
			}
		}

		const deltaEntries: Array<[string, string | null]> = [];
		for (const key of changedKeys) {
			const value = this.entries.get(key);
			deltaEntries.push([key, value ? bytesToHex(value) : null]);
		}

		const data: DeltaData = {
			fromVersion,
			toVersion: this._version,
			rootHash: this._rootHash,
			entries: deltaEntries,
			transitions: relevantTransitions.map((t) => ({
				version: t.version,
				rootHash: t.rootHash,
				previousRootHash: t.previousRootHash,
				timestamp: t.timestamp,
				operations: t.operations,
				signature: bytesToHex(t.signature),
			})),
		};
		return new TextEncoder().encode(JSON.stringify(data));
	}

	/** Verify a Merkle inclusion proof for a key-value pair. */
	verifyProof(
		key: string,
		value: Uint8Array | null,
		proof: MerkleProof,
		rootHash: string,
	): boolean {
		return verifyMerkleProof(key, value, proof, rootHash);
	}

	/** Close underlying LevelDB (if any). */
	async close(): Promise<void> {
		if (this.db) {
			await this.db.close();
		}
	}

	// ── LevelDB persistence helpers ──────────────────────────────────

	/** Write current entries and metadata to LevelDB. */
	async persistAll(): Promise<void> {
		if (!this.db) return;

		for (const [key, value] of this.entries) {
			await this.db.put(PREFIX.ENTRY + key, bytesToHex(value));
		}

		for (const t of this.transitions) {
			await this.db.put(
				PREFIX.TRANSITION + t.version,
				JSON.stringify({ ...t, signature: bytesToHex(t.signature) }),
			);
		}

		await this.db.put(PREFIX.META_VERSION, String(this._version));
		await this.db.put(PREFIX.META_ROOT, this._rootHash);
	}

	/** Persist a single transition to LevelDB after a mutation. */
	private async persistTransition(t: StateTransition): Promise<void> {
		if (!this.db) return;

		for (const op of t.operations) {
			if (op.op === "set") {
				const val = this.entries.get(op.key);
				if (val) {
					await this.db.put(
						PREFIX.ENTRY + op.key,
						bytesToHex(val),
					);
				}
			} else {
				await this.db.del(PREFIX.ENTRY + op.key);
			}
		}

		await this.db.put(
			PREFIX.TRANSITION + t.version,
			JSON.stringify({ ...t, signature: bytesToHex(t.signature) }),
		);
		await this.db.put(PREFIX.META_VERSION, String(this._version));
		await this.db.put(PREFIX.META_ROOT, this._rootHash);
	}

	/**
	 * Load all entries and transitions from LevelDB into memory.
	 * Called during openTree() to restore from disk.
	 */
	async loadFromDb(): Promise<void> {
		if (!this.db) return;

		for await (const [key, value] of this.db.iterator()) {
			if (key.startsWith(PREFIX.ENTRY)) {
				const entryKey = key.slice(PREFIX.ENTRY.length);
				this.entries.set(entryKey, hexToBytes(value));
			} else if (key.startsWith(PREFIX.TRANSITION)) {
				const parsed = JSON.parse(value) as {
					version: number;
					rootHash: string;
					previousRootHash: string;
					timestamp: number;
					operations: Array<{
						op: "set" | "delete";
						key: string;
					}>;
					signature: string;
				};
				this.transitions.push({
					...parsed,
					signature: hexToBytes(parsed.signature),
				});
			} else if (key === PREFIX.META_VERSION) {
				this._version = Number(value);
			} else if (key === PREFIX.META_ROOT) {
				this._rootHash = value;
			}
		}

		// Sort transitions by version
		this.transitions.sort((a, b) => a.version - b.version);

		// Rebuild snapshots by replaying transitions
		const replayEntries = new Map<string, Uint8Array>();
		this.snapshots.set(0, new Map());
		for (const t of this.transitions) {
			for (const op of t.operations) {
				if (op.op === "set") {
					const val = this.entries.get(op.key);
					if (val) replayEntries.set(op.key, val);
				} else {
					replayEntries.delete(op.key);
				}
			}
			// Note: replay from transitions without stored values gives
			// only current values for set keys. Snapshots for intermediate
			// versions may be incomplete if overwritten values aren't stored.
			// Full version replay is available via serialize() which stores values.
		}

		// Set current snapshot
		this.snapshots.set(this._version, new Map(this.entries));
	}
}
