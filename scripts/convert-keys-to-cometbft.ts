#!/usr/bin/env npx tsx
/**
 * Convert Ensoul validator Ed25519 keys to CometBFT priv_validator_key.json format.
 *
 * Reads each validator's identity.json from ~/.ensoul/validator-N/
 * and writes a CometBFT-compatible priv_validator_key.json.
 *
 * Key format mapping:
 *   Ensoul seed (32 bytes hex)   -> CometBFT priv_key (seed+pubkey, 64 bytes base64)
 *   Ensoul publicKey (32 bytes)  -> CometBFT pub_key (32 bytes base64)
 *   SHA256(pubkey)[:20]          -> CometBFT address (20 bytes uppercase hex)
 *   Ensoul DID (multicodec+b58)  -> Verified to match the same Ed25519 pubkey
 *
 * Usage:
 *   npx tsx scripts/convert-keys-to-cometbft.ts [--dry-run] [--output-dir <dir>]
 *
 * Backs up original keys before any conversion.
 */

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createIdentity, hexToBytes, bytesToHex } from "../packages/identity/src/index.js";

const HOME = process.env["HOME"] ?? "/tmp";
const ENSOUL_DIR = join(HOME, ".ensoul");
const DEFAULT_OUTPUT = join(HOME, ".cometbft-ensoul");
const BACKUP_DIR = join(ENSOUL_DIR, "key-backup");

interface EnsoulIdentity {
	seed?: string;
	publicKey: string;
	did: string;
	encrypted?: string;
	nonce?: string;
	salt?: string;
}

interface CometBFTKey {
	address: string;
	pub_key: {
		type: "tendermint/PubKeyEd25519";
		value: string;
	};
	priv_key: {
		type: "tendermint/PrivKeyEd25519";
		value: string;
	};
}

interface ConversionResult {
	validatorIndex: number;
	did: string;
	address: string;
	pubKeyBase64: string;
	success: boolean;
	error?: string;
}

function log(msg: string): void {
	process.stdout.write(`[convert] ${msg}\n`);
}

/**
 * Convert a single Ensoul identity to CometBFT key format.
 */
function convertKey(identity: EnsoulIdentity): CometBFTKey | null {
	if (!identity.seed) {
		return null; // Encrypted keys need password decryption first
	}

	const seed = hexToBytes(identity.seed);
	const pubkey = hexToBytes(identity.publicKey);

	// CometBFT address = first 20 bytes of SHA256(pubkey), uppercase hex
	const addressBytes = createHash("sha256").update(pubkey).digest().subarray(0, 20);
	const address = Buffer.from(addressBytes).toString("hex").toUpperCase();

	// CometBFT priv_key = seed (32) + pubkey (32) = 64 bytes, base64
	const privKeyBytes = Buffer.concat([Buffer.from(seed), Buffer.from(pubkey)]);
	const privKeyBase64 = privKeyBytes.toString("base64");

	// CometBFT pub_key = pubkey (32 bytes), base64
	const pubKeyBase64 = Buffer.from(pubkey).toString("base64");

	return {
		address,
		pub_key: {
			type: "tendermint/PubKeyEd25519",
			value: pubKeyBase64,
		},
		priv_key: {
			type: "tendermint/PrivKeyEd25519",
			value: privKeyBase64,
		},
	};
}

/**
 * Verify that a CometBFT key matches the original Ensoul DID.
 * The DID encodes the same Ed25519 public key in multicodec format.
 */
async function verifyKeyMatch(identity: EnsoulIdentity, cometKey: CometBFTKey): Promise<boolean> {
	if (!identity.seed) return false;

	// Recreate identity from seed and verify DID matches
	const seed = hexToBytes(identity.seed);
	const recreated = await createIdentity({ seed });

	if (recreated.did !== identity.did) {
		log(`  DID mismatch: recreated=${recreated.did.slice(0, 30)}... stored=${identity.did.slice(0, 30)}...`);
		return false;
	}

	// Verify public key matches
	const recreatedPub = recreated.toJSON().publicKey;
	if (recreatedPub !== identity.publicKey) {
		log(`  PublicKey mismatch: recreated=${recreatedPub.slice(0, 16)}... stored=${identity.publicKey.slice(0, 16)}...`);
		return false;
	}

	// Verify CometBFT address derivation
	const pubkeyBytes = hexToBytes(identity.publicKey);
	const expectedAddr = createHash("sha256").update(pubkeyBytes).digest().subarray(0, 20);
	const expectedAddrHex = Buffer.from(expectedAddr).toString("hex").toUpperCase();

	if (cometKey.address !== expectedAddrHex) {
		log(`  Address mismatch: computed=${expectedAddrHex} key=${cometKey.address}`);
		return false;
	}

	return true;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const outputIdx = args.indexOf("--output-dir");
	const outputDir = outputIdx >= 0 && args[outputIdx + 1] ? args[outputIdx + 1]! : DEFAULT_OUTPUT;

	log("Ensoul to CometBFT Key Converter");
	log(`Output: ${outputDir}`);
	if (dryRun) log("DRY RUN: no files will be written");
	log("");

	// Find all validator directories
	const results: ConversionResult[] = [];
	let found = 0;

	for (let i = 0; i < 35; i++) {
		const idPath = join(ENSOUL_DIR, `validator-${i}`, "identity.json");
		let identity: EnsoulIdentity;

		try {
			const raw = await readFile(idPath, "utf-8");
			identity = JSON.parse(raw) as EnsoulIdentity;
			found++;
		} catch {
			continue; // No identity at this index
		}

		const result: ConversionResult = {
			validatorIndex: i,
			did: identity.did,
			address: "",
			pubKeyBase64: "",
			success: false,
		};

		// Check if key is encrypted
		if (!identity.seed) {
			if (identity.encrypted) {
				result.error = "Key is encrypted. Set ENSOUL_KEY_PASSWORD to decrypt.";
				log(`validator-${i}: SKIP (encrypted)`);
			} else {
				result.error = "No seed found in identity file";
				log(`validator-${i}: SKIP (no seed)`);
			}
			results.push(result);
			continue;
		}

		// Convert
		const cometKey = convertKey(identity);
		if (!cometKey) {
			result.error = "Conversion failed";
			log(`validator-${i}: FAIL`);
			results.push(result);
			continue;
		}

		// Verify
		const verified = await verifyKeyMatch(identity, cometKey);
		if (!verified) {
			result.error = "Key verification failed after conversion";
			log(`validator-${i}: VERIFY FAILED`);
			results.push(result);
			continue;
		}

		result.address = cometKey.address;
		result.pubKeyBase64 = cometKey.pub_key.value;
		result.success = true;

		log(`validator-${i}: ${identity.did.slice(0, 40)}...`);
		log(`  Address: ${cometKey.address}`);
		log(`  PubKey:  ${cometKey.pub_key.value.slice(0, 20)}...`);
		log(`  Verified: OK`);

		if (!dryRun) {
			// Backup original key
			const backupPath = join(BACKUP_DIR, `validator-${i}`);
			await mkdir(backupPath, { recursive: true });
			await copyFile(idPath, join(backupPath, "identity.json"));

			// Write CometBFT key
			const cometDir = join(outputDir, `validator-${i}`, "config");
			await mkdir(cometDir, { recursive: true });
			await writeFile(
				join(cometDir, "priv_validator_key.json"),
				JSON.stringify(cometKey, null, 2),
			);

			// Write initial validator state
			const dataDir = join(outputDir, `validator-${i}`, "data");
			await mkdir(dataDir, { recursive: true });
			await writeFile(
				join(dataDir, "priv_validator_state.json"),
				JSON.stringify({ height: "0", round: 0, step: 0 }, null, 2),
			);
		}

		results.push(result);
	}

	// Summary
	log("");
	log("=== SUMMARY ===");
	log(`Found: ${found} validator keys`);
	log(`Converted: ${results.filter((r) => r.success).length}`);
	log(`Failed: ${results.filter((r) => !r.success).length}`);

	if (!dryRun && results.some((r) => r.success)) {
		log(`Backups: ${BACKUP_DIR}`);
		log(`CometBFT keys: ${outputDir}`);

		// Write a mapping file for genesis generation
		const mapping = results
			.filter((r) => r.success)
			.map((r) => ({
				validatorIndex: r.validatorIndex,
				did: r.did,
				address: r.address,
				pubKeyBase64: r.pubKeyBase64,
			}));

		await writeFile(
			join(outputDir, "validator-mapping.json"),
			JSON.stringify(mapping, null, 2),
		);
		log(`Mapping: ${join(outputDir, "validator-mapping.json")}`);
	}

	if (dryRun) {
		log("");
		log("Run without --dry-run to write files.");
	}
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
