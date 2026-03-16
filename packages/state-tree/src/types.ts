/**
 * A single operation in a batch mutation.
 */
export interface BatchOp {
	op: "set" | "delete";
	key: string;
	value?: Uint8Array;
}

/**
 * Merkle inclusion proof for a key-value pair in the tree.
 */
export interface MerkleProof {
	siblings: Array<{ hash: string; position: "left" | "right" }>;
	leafHash: string;
}

/**
 * A signed record of a state mutation.
 * Links consecutive versions via root hashes and is signed by the agent identity.
 */
export interface StateTransition {
	version: number;
	rootHash: string;
	previousRootHash: string;
	timestamp: number;
	operations: Array<{ op: "set" | "delete"; key: string }>;
	signature: Uint8Array;
}

/**
 * Merklized key-value store representing an agent's consciousness.
 * Every mutation produces a new root hash and a signed state transition.
 * Full version history is preserved and traversable.
 */
export interface ConsciousnessTree {
	/** Blake3 Merkle root hash of the current tree state (hex) */
	readonly rootHash: string;
	/** Current version number (increments on every mutation) */
	readonly version: number;

	/** Get a value by key. Returns null if the key does not exist. */
	get(key: string): Promise<Uint8Array | null>;
	/** Get a value with its Merkle inclusion proof. */
	getWithProof(
		key: string,
	): Promise<{ value: Uint8Array | null; proof: MerkleProof }>;

	/** Set a key-value pair. Returns the new root hash. */
	set(key: string, value: Uint8Array): Promise<string>;
	/** Delete a key. Returns the new root hash. */
	delete(key: string): Promise<string>;
	/** Apply multiple operations atomically. Returns the new root hash. */
	batch(ops: BatchOp[]): Promise<string>;

	/** Get a snapshot of the tree at a previous version. */
	getVersion(version: number): Promise<ConsciousnessTree>;
	/** Get the history of state transitions between two versions. */
	getHistory(
		fromVersion: number,
		toVersion: number,
	): Promise<StateTransition[]>;

	/** Serialize the full tree state (entries + history) as bytes. */
	serialize(): Promise<Uint8Array>;
	/** Serialize only the changes since a given version. */
	serializeDelta(fromVersion: number): Promise<Uint8Array>;

	/** Verify a Merkle inclusion proof for a key-value pair against a root hash. */
	verifyProof(
		key: string,
		value: Uint8Array | null,
		proof: MerkleProof,
		rootHash: string,
	): boolean;

	/** Close underlying resources (LevelDB). */
	close(): Promise<void>;
}
