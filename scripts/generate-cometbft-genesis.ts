#!/usr/bin/env npx tsx
/**
 * Generate the production CometBFT genesis.json for Ensoul.
 *
 * Combines:
 *   1. Validator public keys from converted keys (MBP) and DID extraction (Minis)
 *   2. Ensoul genesis allocations as app_state
 *   3. CometBFT consensus parameters
 *
 * The Ed25519 public key is extracted directly from each DID.
 * DID format: did:key:z<base58btc(0xed01 + pubkey_32_bytes)>
 *
 * Usage:
 *   npx tsx scripts/generate-cometbft-genesis.ts [--output <path>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Base58btc decoding (matches @ensoul/identity encoding)
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcDecode(str: string): Uint8Array {
	let num = 0n;
	for (const char of str) {
		const idx = B58_ALPHABET.indexOf(char);
		if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
		num = num * 58n + BigInt(idx);
	}
	const bytes: number[] = [];
	while (num > 0n) {
		bytes.unshift(Number(num % 256n));
		num /= 256n;
	}
	// Leading zeros
	for (const char of str) {
		if (char !== "1") break;
		bytes.unshift(0);
	}
	return new Uint8Array(bytes);
}

/**
 * Extract the raw 32-byte Ed25519 public key from a did:key DID.
 * DID format: did:key:z<base58btc(multicodec_prefix + pubkey)>
 * Ed25519 multicodec prefix: 0xed 0x01
 */
function pubkeyFromDid(did: string): Uint8Array {
	if (!did.startsWith("did:key:z")) {
		throw new Error(`Invalid DID format: ${did.slice(0, 20)}...`);
	}
	const encoded = did.slice("did:key:z".length);
	const decoded = base58btcDecode(encoded);

	// Verify multicodec prefix (0xed, 0x01 for Ed25519)
	if (decoded.length < 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
		throw new Error(`Invalid Ed25519 multicodec prefix in DID: ${did.slice(0, 30)}...`);
	}

	return decoded.subarray(2, 34);
}

/**
 * Compute CometBFT validator address from public key.
 * address = SHA256(pubkey)[:20], uppercase hex
 */
function addressFromPubkey(pubkey: Uint8Array): string {
	return createHash("sha256")
		.update(pubkey)
		.digest()
		.subarray(0, 20)
		.toString("hex")
		.toUpperCase();
}

interface GenesisValidator {
	address: string;
	pub_key: {
		type: "tendermint/PubKeyEd25519";
		value: string;
	};
	power: string;
	name: string;
}

function log(msg: string): void {
	process.stdout.write(`[genesis] ${msg}\n`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const outputIdx = args.indexOf("--output");
	const outputPath = outputIdx >= 0 && args[outputIdx + 1]
		? args[outputIdx + 1]!
		: join(process.env["HOME"] ?? "/tmp", ".cometbft-ensoul", "genesis.json");

	log("Generating CometBFT genesis for Ensoul");

	// Load Ensoul genesis config
	const genesisRaw = await readFile("genesis-config-v3.json", "utf-8");
	const ensoulGenesis = JSON.parse(genesisRaw) as {
		chainId: string;
		timestamp: number;
		totalSupply: string;
		allocations: Array<{
			label: string;
			percentage: number;
			tokens: string;
			recipient: string;
			autoStake?: boolean;
		}>;
		emissionPerBlock: string;
		networkRewardsPool: string;
		protocolFees: {
			storageFeeProtocolShare: number;
			txBaseFee: string;
		};
	};

	const foundation = ensoulGenesis.allocations.filter(
		(a) => a.label === "Foundation Validator",
	);
	log(`Foundation validators: ${foundation.length}`);

	// Build CometBFT validator entries from DIDs
	const validators: GenesisValidator[] = [];
	const DECIMALS = 10n ** 18n;

	for (let i = 0; i < foundation.length; i++) {
		const alloc = foundation[i]!;
		const pubkey = pubkeyFromDid(alloc.recipient);
		const address = addressFromPubkey(pubkey);
		const pubkeyBase64 = Buffer.from(pubkey).toString("base64");

		// Voting power = staked ENSL (in whole tokens, not wei)
		const stakedTokens = BigInt(alloc.tokens) / DECIMALS;
		const power = stakedTokens.toString();

		// Machine assignment for naming
		let machine: string;
		if (i < 5) machine = "mbp";
		else if (i < 15) machine = "mini1";
		else if (i < 25) machine = "mini2";
		else machine = "mini3";

		validators.push({
			address,
			pub_key: {
				type: "tendermint/PubKeyEd25519",
				value: pubkeyBase64,
			},
			power,
			name: `${machine}-v${i}`,
		});
	}

	log(`Validators built: ${validators.length}`);

	// Verify total voting power
	const totalPower = validators.reduce((sum, v) => sum + BigInt(v.power), 0n);
	log(`Total voting power: ${totalPower.toString()}`);

	// Build the CometBFT genesis
	const genesis = {
		genesis_time: new Date(ensoulGenesis.timestamp).toISOString(),
		chain_id: "ensoul-1",
		initial_height: "1",
		consensus_params: {
			block: {
				max_bytes: "67108864",  // 64MB for consciousness payloads
				max_gas: "-1",          // No gas limit
			},
			evidence: {
				max_age_num_blocks: "100000",
				max_age_duration: "172800000000000", // 48 hours in nanoseconds
				max_bytes: "1048576",
			},
			validator: {
				pub_key_types: ["ed25519"],
			},
			version: {
				app: "1",
			},
			abci: {
				vote_extensions_enable_height: "0",
			},
		},
		validators,
		app_hash: "",
		app_state: ensoulGenesis,
	};

	await writeFile(outputPath, JSON.stringify(genesis, null, 2));

	log(`Genesis written to ${outputPath}`);
	log(`  Chain ID: ${genesis.chain_id}`);
	log(`  Genesis time: ${genesis.genesis_time}`);
	log(`  Validators: ${validators.length}`);
	log(`  Total voting power: ${totalPower.toString()}`);
	log(`  Block max bytes: ${genesis.consensus_params.block.max_bytes}`);

	// Print per-machine breakdown
	const mbp = validators.filter((v) => v.name.startsWith("mbp"));
	const m1 = validators.filter((v) => v.name.startsWith("mini1"));
	const m2 = validators.filter((v) => v.name.startsWith("mini2"));
	const m3 = validators.filter((v) => v.name.startsWith("mini3"));
	log(`  MBP: ${mbp.length} validators`);
	log(`  Mini1: ${m1.length} validators`);
	log(`  Mini2: ${m2.length} validators`);
	log(`  Mini3: ${m3.length} validators`);

	// Cross-verify MBP keys against converted keys if available
	try {
		const mappingRaw = await readFile(
			join(process.env["HOME"] ?? "/tmp", ".cometbft-ensoul", "validator-mapping.json"),
			"utf-8",
		);
		const mapping = JSON.parse(mappingRaw) as Array<{
			validatorIndex: number;
			did: string;
			address: string;
			pubKeyBase64: string;
		}>;

		log("");
		log("Cross-verification against converted MBP keys:");
		let mismatches = 0;
		for (const m of mapping) {
			const genValidator = validators[m.validatorIndex];
			if (!genValidator) continue;
			if (genValidator.address !== m.address) {
				log(`  V${m.validatorIndex}: ADDRESS MISMATCH genesis=${genValidator.address} converted=${m.address}`);
				mismatches++;
			} else if (genValidator.pub_key.value !== m.pubKeyBase64) {
				log(`  V${m.validatorIndex}: PUBKEY MISMATCH`);
				mismatches++;
			} else {
				log(`  V${m.validatorIndex}: OK`);
			}
		}
		if (mismatches === 0) {
			log("  All MBP keys match.");
		} else {
			log(`  WARNING: ${mismatches} mismatches found!`);
		}
	} catch {
		log("  (no converted keys to cross-verify)");
	}
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
