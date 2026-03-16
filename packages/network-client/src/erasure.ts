import type { ErasureConfig } from "./types.js";

/**
 * GF(256) arithmetic with irreducible polynomial x^8 + x^4 + x^3 + x + 1 (0x11b).
 * Used for erasure coding parity computation and reconstruction.
 */

const GF_POLY = 0x11b;

/** Precomputed exp table for GF(256). exp[i] = α^i. */
const EXP_TABLE = new Array<number>(512).fill(0);
/** Precomputed log table for GF(256). log[x] = i where α^i = x. */
const LOG_TABLE = new Array<number>(256).fill(0);

// Initialize tables using generator α=3 (x+1) in GF(256) with polynomial 0x11b.
// 3 is a generator of the full multiplicative group of order 255.
(() => {
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP_TABLE[i] = x;
		LOG_TABLE[x] = i;
		// Multiply x by 3 in GF(256): x*3 = x*2 XOR x
		let doubled = x << 1;
		if (doubled & 0x100) doubled ^= GF_POLY;
		x = doubled ^ x;
	}
	for (let i = 255; i < 512; i++) {
		EXP_TABLE[i] = EXP_TABLE[i - 255]!;
	}
})();

/** Multiply two elements in GF(256). */
export function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return EXP_TABLE[LOG_TABLE[a]! + LOG_TABLE[b]!]!;
}

/** Divide two elements in GF(256). */
export function gfDiv(a: number, b: number): number {
	if (b === 0) throw new Error("Division by zero in GF(256)");
	if (a === 0) return 0;
	return EXP_TABLE[(LOG_TABLE[a]! - LOG_TABLE[b]! + 255) % 255]!;
}

/** Inverse of an element in GF(256). */
export function gfInv(a: number): number {
	if (a === 0) throw new Error("Inverse of zero in GF(256)");
	return EXP_TABLE[255 - LOG_TABLE[a]!]!;
}

/**
 * Encoding matrix for K=2 erasure coding.
 *
 * Row i of the encoding matrix: [a_i, b_i]
 *   - Row 0: [1, 0]  → data shard (chunk 0)
 *   - Row 1: [0, 1]  → data shard (chunk 1)
 *   - Row i (i≥2): [1, i-1]  → parity shard
 *
 * Any 2 rows form an invertible 2×2 matrix over GF(256).
 */
function encodingRow(i: number): [number, number] {
	if (i === 0) return [1, 0];
	if (i === 1) return [0, 1];
	return [1, i - 1];
}

/**
 * Encode data into N shards using K-of-N erasure coding (K=2).
 * Any K shards are sufficient to reconstruct the original data.
 *
 * @param data - The data to encode
 * @param config - Erasure configuration (dataShards=K, totalShards=N)
 * @returns Array of N shards
 */
export function encode(data: Uint8Array, config: ErasureConfig): Uint8Array[] {
	if (config.dataShards !== 2) {
		throw new Error("Only K=2 erasure coding is currently supported");
	}
	if (config.totalShards < 2) {
		throw new Error("Total shards must be at least 2");
	}
	if (config.totalShards > 255) {
		throw new Error("Total shards must be at most 255");
	}

	// Pad data to even length
	const chunkSize = Math.ceil(data.length / 2);
	const padded = new Uint8Array(chunkSize * 2);
	padded.set(data);

	const chunk0 = padded.subarray(0, chunkSize);
	const chunk1 = padded.subarray(chunkSize, chunkSize * 2);

	const shards: Uint8Array[] = [];

	for (let i = 0; i < config.totalShards; i++) {
		const [a, b] = encodingRow(i);
		const shard = new Uint8Array(chunkSize);
		for (let j = 0; j < chunkSize; j++) {
			shard[j] = gfMul(a, chunk0[j]!) ^ gfMul(b, chunk1[j]!);
		}
		shards.push(shard);
	}

	// Prepend original data length to first shard for unpadding
	const header = new Uint8Array(4);
	new DataView(header.buffer).setUint32(0, data.length, false);

	// Return shards with the original length encoded in a separate header
	// The header is stored externally (in metadata), not in shards
	return shards;
}

/**
 * Decode data from K available shards out of N total.
 *
 * @param shards - Array of N slots, with at least K non-null entries
 * @param config - Erasure configuration
 * @param originalLength - Original data length (before padding)
 * @returns Reconstructed data
 */
export function decode(
	shards: (Uint8Array | null)[],
	config: ErasureConfig,
	originalLength: number,
): Uint8Array {
	if (config.dataShards !== 2) {
		throw new Error("Only K=2 erasure coding is currently supported");
	}

	// Find K available shards
	const available: Array<{ index: number; data: Uint8Array }> = [];
	for (let i = 0; i < shards.length; i++) {
		const s = shards[i];
		if (s) {
			available.push({ index: i, data: s });
			if (available.length >= config.dataShards) break;
		}
	}

	if (available.length < config.dataShards) {
		throw new Error(
			`Need ${config.dataShards} shards but only ${available.length} available`,
		);
	}

	const s0 = available[0]!;
	const s1 = available[1]!;
	const chunkSize = s0.data.length;

	// Get the encoding matrix rows for these two shards
	const [a0, b0] = encodingRow(s0.index);
	const [a1, b1] = encodingRow(s1.index);

	// Compute determinant: det = a0*b1 XOR a1*b0
	const det = gfMul(a0, b1) ^ gfMul(a1, b0);
	if (det === 0) {
		throw new Error("Selected shards form a singular matrix");
	}

	const detInv = gfInv(det);

	// Inverse matrix: [b1, b0; a1, a0] * detInv  (in GF(256), negation = identity)
	const invA0 = gfMul(b1, detInv);
	const invB0 = gfMul(b0, detInv);
	const invA1 = gfMul(a1, detInv);
	const invB1 = gfMul(a0, detInv);

	// Reconstruct chunks
	const chunk0 = new Uint8Array(chunkSize);
	const chunk1 = new Uint8Array(chunkSize);

	for (let j = 0; j < chunkSize; j++) {
		chunk0[j] =
			gfMul(invA0, s0.data[j]!) ^ gfMul(invB0, s1.data[j]!);
		chunk1[j] =
			gfMul(invA1, s0.data[j]!) ^ gfMul(invB1, s1.data[j]!);
	}

	// Concatenate and trim to original length
	const result = new Uint8Array(chunkSize * 2);
	result.set(chunk0);
	result.set(chunk1, chunkSize);

	return result.subarray(0, originalLength);
}
