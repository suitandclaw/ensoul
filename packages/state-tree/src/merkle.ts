import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import type { MerkleProof } from "./types.js";

/** Root hash of an empty tree. */
export const EMPTY_HASH: string = bytesToHex(blake3(new Uint8Array(0)));

/**
 * Compute the Blake3 leaf hash for a key-value pair.
 * Format: blake3( uint32BE(keyLen) || keyUTF8 || value )
 */
export function computeLeafHash(key: string, value: Uint8Array): Uint8Array {
	const keyBytes = new TextEncoder().encode(key);
	const prefix = new Uint8Array(4);
	new DataView(prefix.buffer).setUint32(0, keyBytes.length, false);
	return blake3(concatBytes(prefix, keyBytes, value));
}

/**
 * Compute a Blake3 internal node hash from two children.
 */
function computeNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
	return blake3(concatBytes(left, right));
}

/**
 * Result of building a Merkle tree: the root hash, all layers, and the sorted key order.
 */
export interface MerkleTreeResult {
	root: string;
	layers: Uint8Array[][];
	sortedKeys: string[];
}

/**
 * Build a balanced binary Merkle tree over sorted key-value entries.
 * Leaves are sorted by key. Internal nodes are Blake3(left || right).
 * Odd nodes at any level are promoted without hashing.
 */
export function buildMerkleTree(
	entries: Map<string, Uint8Array>,
): MerkleTreeResult {
	const sortedKeys = [...entries.keys()].sort();

	if (sortedKeys.length === 0) {
		return { root: EMPTY_HASH, layers: [], sortedKeys: [] };
	}

	const leafHashes = sortedKeys.map((key) => {
		const value = entries.get(key);
		if (!value) throw new Error(`Missing value for key: ${key}`);
		return computeLeafHash(key, value);
	});

	const layers: Uint8Array[][] = [leafHashes];
	let current = leafHashes;

	while (current.length > 1) {
		const next: Uint8Array[] = [];
		for (let i = 0; i < current.length; i += 2) {
			const left = current[i]!;
			const right = current[i + 1];
			if (right) {
				next.push(computeNodeHash(left, right));
			} else {
				next.push(left);
			}
		}
		layers.push(next);
		current = next;
	}

	return {
		root: bytesToHex(current[0]!),
		layers,
		sortedKeys,
	};
}

/**
 * Generate a Merkle inclusion proof for the leaf at the given index.
 */
export function generateProof(
	layers: Uint8Array[][],
	leafIndex: number,
): MerkleProof {
	const firstLayer = layers[0];
	if (!firstLayer || leafIndex < 0 || leafIndex >= firstLayer.length) {
		return { siblings: [], leafHash: "" };
	}

	const siblings: Array<{ hash: string; position: "left" | "right" }> = [];
	let index = leafIndex;

	for (let level = 0; level < layers.length - 1; level++) {
		const layer = layers[level]!;
		if (index % 2 === 0) {
			const sibling = layer[index + 1];
			if (sibling) {
				siblings.push({
					hash: bytesToHex(sibling),
					position: "right",
				});
			}
		} else {
			const sibling = layer[index - 1];
			if (sibling) {
				siblings.push({
					hash: bytesToHex(sibling),
					position: "left",
				});
			}
		}
		index = Math.floor(index / 2);
	}

	return {
		siblings,
		leafHash: bytesToHex(firstLayer[leafIndex]!),
	};
}

/**
 * Verify a Merkle inclusion proof against a root hash.
 * For non-existent keys (value === null), accepts empty proofs.
 */
export function verifyMerkleProof(
	key: string,
	value: Uint8Array | null,
	proof: MerkleProof,
	rootHash: string,
): boolean {
	if (value === null) {
		return proof.siblings.length === 0 && proof.leafHash === "";
	}

	const leafHash = computeLeafHash(key, value);
	if (bytesToHex(leafHash) !== proof.leafHash) {
		return false;
	}

	let current = leafHash;
	for (const sibling of proof.siblings) {
		const siblingBytes = hexToBytes(sibling.hash);
		if (sibling.position === "left") {
			current = computeNodeHash(siblingBytes, current);
		} else {
			current = computeNodeHash(current, siblingBytes);
		}
	}

	return bytesToHex(current) === rootHash;
}

export { bytesToHex, hexToBytes };
