export type {
	ConsciousnessTree,
	StateTransition,
	MerkleProof,
	BatchOp,
} from "./types.js";

export { ConsciousnessTreeImpl } from "./tree.js";

export {
	computeLeafHash,
	buildMerkleTree,
	generateProof,
	verifyMerkleProof,
	EMPTY_HASH,
} from "./merkle.js";

import type { AgentIdentity } from "@ensoul/identity";
import type { AbstractLevel } from "abstract-level";
import type { ConsciousnessTree } from "./types.js";
import { ConsciousnessTreeImpl } from "./tree.js";
import { hexToBytes, bytesToHex } from "./merkle.js";
import { MemoryLevel } from "memory-level";
import { ClassicLevel } from "classic-level";

/** Options for creating a tree. */
export interface CreateTreeOptions {
	/** Path to a LevelDB directory for persistent storage. */
	dbPath?: string;
}

/**
 * Create a new empty consciousness tree.
 * @param identity - Agent identity for signing state transitions
 * @param opts - Optional: provide dbPath for LevelDB persistence
 */
export async function createTree(
	identity: AgentIdentity,
	opts?: CreateTreeOptions,
): Promise<ConsciousnessTree> {
	const db = opts?.dbPath
		? new ClassicLevel<string, string>(opts.dbPath, {
				valueEncoding: "utf8",
			})
		: new MemoryLevel<string, string>({ valueEncoding: "utf8" });

	const tree = new ConsciousnessTreeImpl(identity, db);
	return tree;
}

/**
 * Open an existing consciousness tree from LevelDB.
 * Reads all entries and transitions from disk.
 * @param dbPath - Path to the LevelDB directory
 * @param identity - Agent identity for signing state transitions
 */
export async function openTree(
	dbPath: string,
	identity: AgentIdentity,
): Promise<ConsciousnessTree> {
	const db = new ClassicLevel<string, string>(dbPath, {
		valueEncoding: "utf8",
	});
	const tree = new ConsciousnessTreeImpl(identity, db);
	await tree.loadFromDb();
	return tree;
}

/**
 * Deserialize a consciousness tree from bytes (output of serialize()).
 * @param serialized - Uint8Array from a previous serialize() call
 * @param identity - Agent identity for signing state transitions
 * @param opts - Optional: provide dbPath for LevelDB persistence of loaded data
 */
export async function loadTree(
	serialized: Uint8Array,
	identity: AgentIdentity,
	opts?: CreateTreeOptions,
): Promise<ConsciousnessTree> {
	const json = new TextDecoder().decode(serialized);
	const data = JSON.parse(json) as {
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
	};

	// Reconstruct entries
	const entries = new Map<string, Uint8Array>();
	for (const [key, hexValue] of data.entries) {
		entries.set(key, hexToBytes(hexValue));
	}

	// Reconstruct transitions
	const transitions = data.transitions.map((t) => ({
		version: t.version,
		rootHash: t.rootHash,
		previousRootHash: t.previousRootHash,
		timestamp: t.timestamp,
		operations: t.operations.map((op) => ({ op: op.op, key: op.key })),
		signature: hexToBytes(t.signature),
	}));

	// Rebuild snapshots by replaying transitions with embedded values
	const snapshots = new Map<number, Map<string, Uint8Array>>();
	snapshots.set(0, new Map());

	const replayEntries = new Map<string, Uint8Array>();
	for (const t of data.transitions) {
		for (const op of t.operations) {
			if (op.op === "set" && op.value) {
				replayEntries.set(op.key, hexToBytes(op.value));
			} else if (op.op === "delete") {
				replayEntries.delete(op.key);
			}
		}
		snapshots.set(t.version, new Map(replayEntries));
	}

	const db: AbstractLevel<string, string, string> | null = opts?.dbPath
		? new ClassicLevel<string, string>(opts.dbPath, {
				valueEncoding: "utf8",
			})
		: new MemoryLevel<string, string>({ valueEncoding: "utf8" });

	const tree = new ConsciousnessTreeImpl(
		identity,
		db,
		entries,
		data.version,
		data.rootHash,
		transitions,
		snapshots,
	);

	// Persist loaded data to LevelDB
	if (db) {
		await tree.persistAll();
	}

	return tree;
}

export { bytesToHex, hexToBytes };
