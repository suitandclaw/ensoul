/**
 * Shamir's Secret Sharing over GF(256)
 *
 * Splits a secret into N shares where any K can reconstruct.
 * Uses polynomial interpolation over the Galois Field GF(2^8).
 *
 * This is the same mathematical foundation used by:
 *   SLIP-0039 (Shamir Backup for BIP-39 mnemonics)
 *   Vault by HashiCorp (key unsealing)
 *   Keybase (device key recovery)
 *
 * GF(256) arithmetic uses the irreducible polynomial x^8 + x^4 + x^3 + x + 1
 * (0x11B), which is the same field used in AES.
 */

// ── GF(256) Arithmetic ──────────────────────────────────────────────

// Precomputed log and exp tables for GF(256) with irreducible polynomial 0x11D
// (x^8 + x^4 + x^3 + x^2 + 1). Generator element is 2.
// This polynomial makes 2 a primitive element (generates all 255 nonzero elements).
// Used by SLIP-0039 (Shamir Backup standard for cryptocurrency wallets).
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);

(() => {
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		// Multiply by generator 2: left shift, reduce modulo 0x11D if overflow
		x = x << 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 510; i++) {
		EXP[i] = EXP[i - 255]!;
	}
})();

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}

function gfDiv(a: number, b: number): number {
	if (b === 0) throw new Error("Division by zero in GF(256)");
	if (a === 0) return 0;
	return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

// ── Polynomial Evaluation and Interpolation ─────────────────────────

/**
 * Evaluate a polynomial at point x in GF(256).
 * coeffs[0] is the constant term (the secret).
 */
function polyEval(coeffs: Uint8Array, x: number): number {
	let result = 0;
	for (let i = coeffs.length - 1; i >= 0; i--) {
		result = gfMul(result, x) ^ coeffs[i]!;
	}
	return result;
}

/**
 * Lagrange interpolation at x=0 to recover the secret.
 * points: array of [x, y] pairs in GF(256).
 */
function lagrangeInterpolate(points: Array<[number, number]>): number {
	let secret = 0;
	for (let i = 0; i < points.length; i++) {
		let basis = 1;
		for (let j = 0; j < points.length; j++) {
			if (i === j) continue;
			// basis *= x_j / (x_j - x_i)
			// At x=0: basis *= (0 - x_j) / (x_i - x_j) = x_j / (x_j ^ x_i)
			basis = gfMul(basis, gfDiv(points[j]![0], points[j]![0] ^ points[i]![0]));
		}
		secret ^= gfMul(basis, points[i]![1]);
	}
	return secret;
}

// ── Split and Reconstruct ───────────────────────────────────────────

/**
 * Split a secret byte array into N shares, any K of which can reconstruct.
 * Returns N shares, each the same length as the secret.
 */
export function split(secret: Uint8Array, n: number, k: number): Uint8Array[] {
	if (k < 2) throw new Error("Threshold must be at least 2");
	if (n < k) throw new Error("Total shares must be >= threshold");
	if (n > 254) throw new Error("Maximum 254 shares");

	const shares: Uint8Array[] = [];
	for (let i = 0; i < n; i++) {
		shares.push(new Uint8Array(secret.length));
	}

	// For each byte of the secret, create a random polynomial of degree k-1
	// where the constant term is the secret byte
	for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
		const coeffs = new Uint8Array(k);
		coeffs[0] = secret[byteIdx]!;
		// Cryptographically random coefficients for degrees 1 through k-1
		const randBytes = new Uint8Array(k - 1);
		crypto.getRandomValues(randBytes);
		for (let c = 1; c < k; c++) {
			coeffs[c] = randBytes[c - 1]!;
			// Ensure the highest coefficient is nonzero
			if (c === k - 1 && coeffs[c] === 0) coeffs[c] = 1;
		}

		// Evaluate the polynomial at x = 1, 2, ..., n
		for (let i = 0; i < n; i++) {
			shares[i]![byteIdx] = polyEval(coeffs, i + 1);
		}
	}

	return shares;
}

/**
 * Reconstruct a secret from K or more shares.
 * shareIndices: 1-based indices of the shares used.
 * shareData: the share byte arrays.
 */
export function reconstruct(shareIndices: number[], shareData: Uint8Array[]): Uint8Array {
	if (shareIndices.length !== shareData.length) {
		throw new Error("Index count must match share count");
	}
	if (shareIndices.length < 2) {
		throw new Error("Need at least 2 shares to reconstruct");
	}

	const secretLen = shareData[0]!.length;
	const secret = new Uint8Array(secretLen);

	for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
		const points: Array<[number, number]> = [];
		for (let i = 0; i < shareIndices.length; i++) {
			points.push([shareIndices[i]!, shareData[i]![byteIdx]!]);
		}
		secret[byteIdx] = lagrangeInterpolate(points);
	}

	return secret;
}

// ── CLI ─────────────────────────────────────────────────────────────

function hexEncode(buf: Uint8Array): string {
	return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexDecode(hex: string): Uint8Array {
	const buf = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		buf[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return buf;
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const VAULT_DIR = join(homedir(), "ensoul-key-vault", "shamir-shares");

function splitKey(keyFile: string, n: number, k: number): void {
	// Read the key file
	const raw = readFileSync(keyFile, "utf-8");
	const keyData = JSON.parse(raw) as Record<string, unknown>;
	const seed = String(keyData["seed"] ?? "");
	const did = String(keyData["did"] ?? "");
	const role = String(keyData["role"] ?? basename(keyFile, ".json"));

	if (!seed || seed.length < 32) {
		console.error(`Error: key file does not contain a valid seed`);
		process.exit(1);
	}

	const secretBytes = hexDecode(seed);
	const shares = split(secretBytes, n, k);

	// Create output directory
	const keyName = basename(keyFile, ".json");
	const outDir = join(VAULT_DIR, keyName);
	mkdirSync(outDir, { recursive: true });

	console.log(`\nSplitting: ${keyFile}`);
	console.log(`  Key: ${role} (${did.slice(0, 30)}...)`);
	console.log(`  Scheme: ${k}-of-${n} (need ${k} shares to reconstruct)`);
	console.log(`  Output: ${outDir}\n`);

	for (let i = 0; i < n; i++) {
		const shareFile = join(outDir, `share-${i + 1}.txt`);
		const content = [
			`ENSOUL SHAMIR SHARE ${i + 1} OF ${n}`,
			``,
			`Key: ${role}`,
			`DID: ${did}`,
			`Scheme: ${k}-of-${n}`,
			`Share index: ${i + 1}`,
			`Created: ${new Date().toISOString()}`,
			``,
			`Share data (hex):`,
			hexEncode(shares[i]!),
			``,
			`This share alone reveals NOTHING about the key.`,
			`Combine any ${k} of ${n} shares to reconstruct.`,
		].join("\n");
		writeFileSync(shareFile, content);
		console.log(`  Created: share-${i + 1}.txt (${shares[i]!.length} bytes)`);
	}

	// Write metadata
	const metaFile = join(outDir, "metadata.json");
	writeFileSync(metaFile, JSON.stringify({
		keyName,
		role,
		did,
		totalShares: n,
		threshold: k,
		secretLength: secretBytes.length,
		createdAt: new Date().toISOString(),
	}, null, 2));

	console.log(`\n  Metadata: metadata.json`);
	console.log(`  Total: ${n} share files created\n`);
}

function reconstructKey(shareFiles: string[]): void {
	const indices: number[] = [];
	const data: Uint8Array[] = [];
	let keyName = "";
	let did = "";
	let role = "";
	let scheme = "";

	for (const file of shareFiles) {
		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");

		// Parse share index
		const indexLine = lines.find(l => l.startsWith("Share index:"));
		if (!indexLine) { console.error(`Invalid share file: ${file}`); process.exit(1); }
		const index = Number(indexLine.split(":")[1]?.trim());

		// Parse share data
		const dataIdx = lines.findIndex(l => l.startsWith("Share data"));
		if (dataIdx < 0) { console.error(`No share data in: ${file}`); process.exit(1); }
		const shareHex = lines[dataIdx + 1]?.trim() ?? "";

		indices.push(index);
		data.push(hexDecode(shareHex));

		// Extract metadata from first share
		if (!keyName) {
			const keyLine = lines.find(l => l.startsWith("Key:"));
			keyName = keyLine?.split(":").slice(1).join(":").trim() ?? "";
			const didLine = lines.find(l => l.startsWith("DID:"));
			did = didLine?.split(":").slice(1).join(":").trim() ?? "";
			role = keyName;
			const schemeLine = lines.find(l => l.startsWith("Scheme:"));
			scheme = schemeLine?.split(":")[1]?.trim() ?? "";
		}
	}

	console.log(`\nReconstructing: ${keyName}`);
	console.log(`  Scheme: ${scheme}`);
	console.log(`  Using ${indices.length} shares: ${indices.join(", ")}\n`);

	const secret = reconstruct(indices, data);
	const seedHex = hexEncode(secret);

	// Rebuild the key file
	const keyObj = { seed: seedHex, did, role };
	const outFile = join(VAULT_DIR, `${role}-reconstructed.json`);
	writeFileSync(outFile, JSON.stringify(keyObj, null, 2));

	console.log(`  Reconstructed seed: ${seedHex.slice(0, 16)}...${seedHex.slice(-8)}`);
	console.log(`  DID: ${did}`);
	console.log(`  Output: ${outFile}\n`);
}

// ── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === "split") {
	const keyFile = args[1];
	const n = Number(args[2] ?? 5);
	const k = Number(args[3] ?? 3);
	if (!keyFile) { console.error("Usage: shamir.ts split <keyfile> [total] [threshold]"); process.exit(1); }
	splitKey(keyFile, n, k);
} else if (command === "reconstruct") {
	const shareFiles = args.slice(1);
	if (shareFiles.length < 2) { console.error("Usage: shamir.ts reconstruct <share1> <share2> [share3] ..."); process.exit(1); }
	reconstructKey(shareFiles);
} else if (command === "test") {
	// Self-test: split a known secret, reconstruct from subset, verify
	console.log("Running Shamir SSS self-test...\n");
	const testSecret = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x13, 0x37, 0x00]);
	const n = 5, k = 3;
	const shares = split(testSecret, n, k);

	// Test all C(5,3) = 10 combinations of 3 shares
	let passed = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			for (let m = j + 1; m < n; m++) {
				const result = reconstruct([i + 1, j + 1, m + 1], [shares[i]!, shares[j]!, shares[m]!]);
				const match = hexEncode(result) === hexEncode(testSecret);
				if (!match) {
					console.error(`FAIL: shares [${i + 1},${j + 1},${m + 1}] produced ${hexEncode(result)}, expected ${hexEncode(testSecret)}`);
				} else {
					passed++;
				}
			}
		}
	}
	console.log(`${passed}/10 combinations passed`);

	// Test that 2 shares (below threshold) produce garbage
	const partial = reconstruct([1, 2], [shares[0]!, shares[1]!]);
	const partialMatch = hexEncode(partial) === hexEncode(testSecret);
	console.log(`Below-threshold test: ${partialMatch ? "FAIL (should not reconstruct)" : "PASS (correctly produces different output)"}`);

	console.log(`\nSelf-test ${passed === 10 && !partialMatch ? "PASSED" : "FAILED"}`);
} else {
	console.log("Ensoul Shamir's Secret Sharing\n");
	console.log("Commands:");
	console.log("  split <keyfile> [total] [threshold]   Split a key into shares");
	console.log("  reconstruct <share1> <share2> ...     Reconstruct from shares");
	console.log("  test                                  Run self-test\n");
	console.log("Examples:");
	console.log("  npx tsx scripts/shamir.ts split genesis-keys/treasury.json 5 3");
	console.log("  npx tsx scripts/shamir.ts reconstruct share-1.txt share-3.txt share-5.txt");
}
