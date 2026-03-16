import { sha512 } from "@noble/hashes/sha2.js";

export { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Curve25519 field prime: 2^255 - 19 */
const P = 2n ** 255n - 19n;

function mod(a: bigint, m: bigint): bigint {
	return ((a % m) + m) % m;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
	let result = 1n;
	base = mod(base, m);
	while (exp > 0n) {
		if (exp & 1n) {
			result = mod(result * base, m);
		}
		exp >>= 1n;
		base = mod(base * base, m);
	}
	return result;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
	let result = 0n;
	for (let i = bytes.length - 1; i >= 0; i--) {
		result = result * 256n + BigInt(bytes[i]!);
	}
	return result;
}

function bigIntToBytesLE(n: bigint, length: number): Uint8Array {
	const result = new Uint8Array(length);
	let val = n;
	for (let i = 0; i < length; i++) {
		result[i] = Number(val & 0xffn);
		val >>= 8n;
	}
	return result;
}

/**
 * Convert an Ed25519 public key to an X25519 public key.
 * Performs the Edwards-to-Montgomery point conversion: u = (1 + y) / (1 - y) mod p.
 */
export function edwardsToMontgomeryPub(edPub: Uint8Array): Uint8Array {
	if (edPub.length !== 32) {
		throw new Error("Ed25519 public key must be 32 bytes");
	}
	const bytes = new Uint8Array(edPub);
	bytes[31] = bytes[31]! & 0x7f; // clear sign bit to extract y coordinate
	const y = bytesToBigIntLE(bytes);
	const numerator = mod(1n + y, P);
	const denominator = mod(1n - y, P);
	const u = mod(numerator * modPow(denominator, P - 2n, P), P);
	return bigIntToBytesLE(u, 32);
}

/**
 * Derive an X25519 private key from an Ed25519 seed.
 * Hashes the seed with SHA-512, takes the first 32 bytes, and applies clamping.
 */
export function edwardsToMontgomeryPriv(seed: Uint8Array): Uint8Array {
	if (seed.length !== 32) {
		throw new Error("Ed25519 seed must be 32 bytes");
	}
	const h = sha512(seed);
	const key = h.slice(0, 32);
	key[0] = key[0]! & 248;
	key[31] = key[31]! & 127;
	key[31] = key[31]! | 64;
	return key;
}

const BASE58_ALPHABET =
	"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes to base58btc string.
 */
export function base58btcEncode(bytes: Uint8Array): string {
	let zeros = 0;
	for (const b of bytes) {
		if (b !== 0) break;
		zeros++;
	}
	let num = 0n;
	for (const b of bytes) {
		num = num * 256n + BigInt(b);
	}

	if (num === 0n) {
		return "1".repeat(zeros || 1);
	}

	let encoded = "";
	while (num > 0n) {
		encoded = BASE58_ALPHABET[Number(num % 58n)]! + encoded;
		num /= 58n;
	}
	return "1".repeat(zeros) + encoded;
}

/**
 * Decode a base58btc string to bytes.
 */
export function base58btcDecode(str: string): Uint8Array {
	if (str.length === 0) {
		return new Uint8Array(0);
	}

	let zeros = 0;
	for (const ch of str) {
		if (ch !== "1") break;
		zeros++;
	}

	let num = 0n;
	for (const ch of str) {
		const idx = BASE58_ALPHABET.indexOf(ch);
		if (idx === -1) {
			throw new Error(`Invalid base58 character: ${ch}`);
		}
		num = num * 58n + BigInt(idx);
	}

	if (num === 0n) {
		return new Uint8Array(zeros);
	}

	const hex = num.toString(16);
	const paddedHex = hex.length % 2 ? "0" + hex : hex;
	const dataBytes = new Uint8Array(paddedHex.length / 2);
	for (let i = 0; i < paddedHex.length; i += 2) {
		dataBytes[i / 2] = parseInt(paddedHex.slice(i, i + 2), 16);
	}

	const result = new Uint8Array(zeros + dataBytes.length);
	result.set(dataBytes, zeros);
	return result;
}

/**
 * Construct a DID:key identifier from an Ed25519 public key.
 * Format: did:key:z + base58btc(multicodec_ed25519_pub + publicKey)
 */
export function createDid(publicKey: Uint8Array): string {
	// Multicodec prefix for ed25519-pub: 0xed, 0x01
	const multicodecKey = new Uint8Array(2 + publicKey.length);
	multicodecKey[0] = 0xed;
	multicodecKey[1] = 0x01;
	multicodecKey.set(publicKey, 2);
	return "did:key:z" + base58btcEncode(multicodecKey);
}

/**
 * Derive a libp2p-compatible PeerId from an Ed25519 public key.
 * Uses the identity multihash of the protobuf-encoded public key.
 */
export function createPeerId(publicKey: Uint8Array): string {
	// Protobuf encoding for Ed25519 public key:
	// 0x08 0x01 = field 1, varint, value 1 (KeyType: Ed25519)
	// 0x12 0x20 = field 2, length-delimited, length 32
	const protobuf = new Uint8Array(4 + publicKey.length);
	protobuf[0] = 0x08;
	protobuf[1] = 0x01;
	protobuf[2] = 0x12;
	protobuf[3] = 0x20;
	protobuf.set(publicKey, 4);

	// Identity multihash (function code=0x00, length of digest)
	const multihash = new Uint8Array(2 + protobuf.length);
	multihash[0] = 0x00;
	multihash[1] = protobuf.length;
	multihash.set(protobuf, 2);

	return base58btcEncode(multihash);
}
