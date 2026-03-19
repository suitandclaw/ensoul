#!/usr/bin/env npx tsx
/**
 * Generate keypairs for protocol accounts and write genesis-config.json.
 * Uses @noble/ed25519 directly (same crypto as @ensoul/identity).
 *
 * Run from repo root: pnpm --filter @ensoul/node exec npx tsx ../../scripts/generate-genesis-keys.ts
 * Or: npx tsx scripts/generate-genesis-keys.ts (if @noble deps are available)
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Configure @noble/ed25519
(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..", "..", "..");
const KEYS_DIR = join(REPO_DIR, "genesis-keys");
const CONFIG_PATH = join(REPO_DIR, "genesis-config.json");

const DECIMALS = "000000000000000000"; // 18 zeros

// Base58btc encoding (same as @ensoul/identity)
function base58btcEncode(data: Uint8Array): string {
	const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let num = 0n;
	for (const byte of data) num = num * 256n + BigInt(byte);
	let encoded = "";
	while (num > 0n) { encoded = ALPHABET[Number(num % 58n)] + encoded; num = num / 58n; }
	for (const byte of data) { if (byte === 0) encoded = "1" + encoded; else break; }
	return encoded;
}

function createDid(publicKey: Uint8Array): string {
	const multicodec = new Uint8Array(2 + publicKey.length);
	multicodec[0] = 0xed; multicodec[1] = 0x01;
	multicodec.set(publicKey, 2);
	return `did:key:z${base58btcEncode(multicodec)}`;
}

interface KeyFile { role: string; seed: string; publicKey: string; did: string; }

function generateKey(role: string): KeyFile {
	const seed = new Uint8Array(randomBytes(32));
	const pub = ed.getPublicKey(seed);
	return { role, seed: bytesToHex(seed), publicKey: bytesToHex(pub), did: createDid(pub) };
}

const FOUNDATION_DIDS = [
	"did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
	"did:key:z6Mkq4htxWS8jyLz3jjtDGtU36cXvE3kbXa9FTbF4xpPmr4g",
	"did:key:z6MkjWwm9vRwo25R8GCDFQmgCvXkKcG5AZGeCj5SSQeQuW9Q",
	"did:key:z6Mkk5HCbmULHwL6iDcVfNgsm5kzWQVFwGeupQqDw9D6SMpy",
	"did:key:z6MkmozExkxmdrSXtnhPeaSujw7KHtrP9gftBGjvVH7ZE3ZS",
	"did:key:z6MkfUJgmfDw9ipEtUEj1aM2KzvcL5V35YPfzeCqnhprH6pv",
	"did:key:z6Mkw5KkTJc3dZdMA47E71JavngQ4CDcL8qrmPEEBcc7p464",
	"did:key:z6MkoAs8JdFnQ3sDkhDGr1QyroUmVj5BMwXL1DzVLzRDyvJZ",
	"did:key:z6MkojPmKYrzFuoMqRVYrp4cdGsA4xsXdJ1vKkUmhKqn57Dr",
	"did:key:z6MkvxSyjdy7MZd4WmR3vQQsZaaDsLKvRfgYXjerKyF76b8g",
	"did:key:z6Mkgdqjyiwiie9hCy9hPkGmp2y8dtMUrgPvguy1wgtAHye5",
	"did:key:z6MkiB1iAqVCcFPm3PyZmFqmtQqN8UMWxWw3YuzC1HPzrsKt",
	"did:key:z6MkuTD3waVwDJnUq8eChVNdGN4LHp5xJqrbgyQUydqTDH5B",
	"did:key:z6MkmKGjf9oGWbF3oSgSDwJ3AFpgsY8eGtszf2F22p41Rnry",
	"did:key:z6MkvnQ4f36mPWiWKwy5EE2enreynbFw2YpmThAL68ECwsU5",
	"did:key:z6MkhJ5ErDvgXp1wpmSW55sDpbBxXJ9o4dGE9Ukue77rPSaR",
	"did:key:z6Mkf4e4mvWEbCM2HEhaU1QDo83wkdey8ZpEdJvFwekdAXbz",
	"did:key:z6MkpBHfsncKdRic3mrGRDsdfGRz76FoQs6EYDMzXw9YyNbT",
	"did:key:z6Mkp8jXR22REXjXAu8m1twNKGr9LAxdn9koqgDqWAZNFAbd",
	"did:key:z6MkeoBaLsJ2LTVQiZUwFQAS4zqxh5XsphqabEQpoTUdSzap",
	"did:key:z6MkpevsRF15MoNqs7ps1putD7vwfWGfgsvB48kGCPFt6XcC",
	"did:key:z6MkvRteszWtf5iWuHidJoaQ3SDsfrcPFEf6KxfCgCkLUkjj",
	"did:key:z6MkknRdWX6CK6Y4zqqrEFxSUFa2p48cC742AYuX5PoQHusa",
	"did:key:z6MkoWHBPQoeZAohxv83oemmh2tuF1XVa73jjbDGSk6Gx33S",
	"did:key:z6MksivyUdiNUhJWMxgSnzhvPLTSHUVZjZA8X6i72kyZ9KV8",
	"did:key:z6MkvmK2YQ9GzUJKfQzhmfwoEtmT2GQTLKqa941GSMszSb3U",
	"did:key:z6MknckwpzNtccdbwC85Z4T1Lb2H9yn9E6BDqNgxCnRgCsoB",
	"did:key:z6MkherrQNyVe5WykdW6vJpXiDdEMekGvaoBPW4WDzvqXoRo",
	"did:key:z6MkgYbeY93qhEDVRD1mSYkKdshrJsXHjjZfjGBVtXrUf9Rq",
	"did:key:z6MkpQYC7it5pRmbjKaiN3wqf4xpz5PY5eBPqiD7d3oEEbkR",
	"did:key:z6MkiW5UB7Xh2tPUstUNJTDYGUYwRE7LjtydWm2RWVoR3E9q",
	"did:key:z6MkiPYyZ5P75AY72FcBvzLMVdGnnyptoXvwp6zJjPPSEt1z",
	"did:key:z6MkonrzYoqNqD7iL87xz8Ppqrjtq73xYWaxA3pYxevURvDi",
	"did:key:z6MkgNxKbmse6px1xeXr1C2L53LXD6zUoCdxsHRygcYfUkXU",
	"did:key:z6MkgBaLg2KEK5bGcAax2PeVp1n6hJvBzM6ZRjMPrfwPQS1V",
];

async function main(): Promise<void> {
	await mkdir(KEYS_DIR, { recursive: true });
	process.stdout.write("Generating protocol keypairs...\n\n");

	const roles = ["treasury", "onboarding", "liquidity", "contributors", "insurance"];
	const keys: KeyFile[] = [];

	for (const role of roles) {
		const key = generateKey(role);
		keys.push(key);
		await writeFile(join(KEYS_DIR, `${role}.json`), JSON.stringify(key, null, 2));
		process.stdout.write(`  ${role}: ${key.did}\n`);
	}

	// Build genesis config
	const perValidator = Math.floor(150_000_000 / 35);
	const remainder = 150_000_000 - perValidator * 35;

	const foundationAllocations = FOUNDATION_DIDS.map((did, i) => ({
		label: "Foundation Validator",
		percentage: i === 0 ? 15 : 0,
		tokens: `${i === 0 ? perValidator + remainder : perValidator}${DECIMALS}`,
		recipient: did,
		autoStake: true,
	}));

	const t = keys.find((k) => k.role === "treasury")!;
	const o = keys.find((k) => k.role === "onboarding")!;
	const l = keys.find((k) => k.role === "liquidity")!;
	const c = keys.find((k) => k.role === "contributors")!;
	const ins = keys.find((k) => k.role === "insurance")!;

	// ~19 ENSL per block: 100M / 5,256,000 blocks = ~19.02
	const blocksPerYear = Math.floor((365 * 24 * 60 * 60) / 6);
	const year1Total = 100_000_000n * (10n ** 18n);
	const emissionPerBlock = year1Total / BigInt(blocksPerYear);

	const config = {
		chainId: "ensoul-1",
		timestamp: Date.now(),
		totalSupply: `1000000000${DECIMALS}`,
		allocations: [
			...foundationAllocations,
			{ label: "Network Rewards", percentage: 50, tokens: `500000000${DECIMALS}`, recipient: "did:ensoul:protocol:rewards" },
			{ label: "Protocol Treasury", percentage: 10, tokens: `100000000${DECIMALS}`, recipient: t.did },
			{ label: "Agent Onboarding", percentage: 10, tokens: `100000000${DECIMALS}`, recipient: o.did },
			{ label: "Initial Liquidity", percentage: 5, tokens: `50000000${DECIMALS}`, recipient: l.did },
			{ label: "Early Contributors", percentage: 5, tokens: `50000000${DECIMALS}`, recipient: c.did },
			{ label: "Insurance Reserve", percentage: 5, tokens: `50000000${DECIMALS}`, recipient: ins.did },
		],
		emissionPerBlock: emissionPerBlock.toString(),
		networkRewardsPool: `500000000${DECIMALS}`,
		protocolFees: { storageFeeProtocolShare: 10, txBaseFee: "1000" },
	};

	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));

	process.stdout.write(`\nGenesis config written to genesis-config.json\n`);
	process.stdout.write(`Keys saved to genesis-keys/\n`);
	process.stdout.write(`\nFoundation validators: ${FOUNDATION_DIDS.length}\n`);
	process.stdout.write(`Per validator: ${perValidator.toLocaleString()} ENSL (auto-staked)\n`);
	process.stdout.write(`First validator extra: ${remainder.toLocaleString()} ENSL (rounding)\n`);
}

main().catch((err: unknown) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
