/**
 * Redistribute voting power: redelegate from home operators to cloud validators.
 *
 * Each of the 31 delegator identities signs a REDELEGATE transaction
 * that moves their 4,285,714 ENSL delegation from a home operator
 * to a cloud validator. Zero treasury spend. Delegators retain ownership.
 *
 * After redistribution:
 *   Home (4 validators): ~4.28M each, 9.4% total
 *   Cloud (16 validators): ~6.3M to ~10.6M each, 90.6% total
 *   Cooper City outage: 90.6% power remains, chain continues
 *
 * Done in 4 batches (one per home operator) to maintain consensus safety.
 *
 * Usage: npx tsx scripts/redistribute-power.ts
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	return bytes;
}

const ENC = new TextEncoder();
const API_URL = "https://api.ensoul.dev";
const DECIMALS = 10n ** 18n;
const DELEGATION_AMOUNT = 4_285_714n * DECIMALS;

// Cloud validator DIDs (targets for redelegation)
const CLOUD_TARGETS = [
	{ name: "ashburn1", did: "did:key:z6Mkf3a7MhLm2Ate22pTDAcnAYyvep176gRas6Qxrr4yKKSv" },
	{ name: "uswest1", did: "did:key:z6MkmjpHc9ae5WGf6WYjyiy6q4vyyvUj78Ybn7ca2KytsuJS" },
	{ name: "helsinki1", did: "did:key:z6MkiHUm3mnutJ2zQn9dxTNTsVd9TdtF52KwhEJe8vTN5uY7" },
	{ name: "nuremberg1", did: "did:key:z6MktaVcKeyFLd3Y9i1kL6eVJesHUhQL8Z4aBhWAom8cLV2R" },
	{ name: "nyc1", did: "did:key:z6Mkk4SoTsrTC1SFLMVyNHDus1KVjY4M2Fa4iHjPtg7g2JUu" },
	{ name: "singapore1", did: "did:key:z6MkrHHv7iHKC9tNaCchMtaxL8L3tSPZoVPGJNvNY6H2FMDd" },
	{ name: "london1", did: "did:key:z6MksWvh8dYLMyZnjxxeA8UnZVwQx5nipptDomYkjh6q7Dbm" },
	{ name: "singapore2", did: "did:key:z6MkizqcK1oovKYgosSw2UWyUbTUCh43qhkQD8trvvHJq2v9" },
	{ name: "boston1", did: "did:key:z6MktBn22qC9iYT69uAvLSDRLoKkADqnimGQK5g9UmqUTy7o" },
	{ name: "lithuania1", did: "did:key:z6MknspWy1YHKCrDSDKzMBDaAjKV22VG2v1didFaAjcYLUXp" },
	{ name: "france1", did: "did:key:z6MkhzppwzKBMbdgjYhs9vh38f7imWNa2wEtQ74MsoAJBnPn" },
	{ name: "frankfurt1", did: "did:key:z6MktGKyB8y3pjVSAjHmSt9DorEFdg9kZueBrfv3gXjp4n9A" },
	{ name: "uk2", did: "did:key:z6MkkkktTaa25E1P9Vh5Y7Abb4uJ5u9ChWn4G4Hwr1nJixmV" },
	{ name: "bangalore1", did: "did:key:z6MkkF7Vsf74yfUVmauMBGnTfpE6dGTwSdxPfs1qmDws6tPG" },
	{ name: "sydney1", did: "did:key:z6Mki2nw2XUJe1KqW5L6TEvqgBSVyvJPUqNUhT6xpUWFVha6" },
	{ name: "toronto1", did: "did:key:z6MkpsgG1gJio5529CiCKPmTKcs14Y9GBwEKdTa5imQNFcz7" },
];

// Home operator DIDs (sources for redelegation)
const MINI1 = "did:key:z6MkfUJgmfDw9ipEtUEj1aM2KzvcL5V35YPfzeCqnhprH6pv";
const MINI2 = "did:key:z6MkhJ5ErDvgXp1wpmSW55sDpbBxXJ9o4dGE9Ukue77rPSaR";
const MINI3 = "did:key:z6MkvmK2YQ9GzUJKfQzhmfwoEtmT2GQTLKqa941GSMszSb3U";
const MBP = "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X";

// 31 delegators: DID, seed, current validator
const DELEGATORS = [
	// Mini1 delegators (9)
	{ did: "did:key:z6Mkw5KkTJc3dZdMA47E71JavngQ4CDcL8qrmPEEBcc7p464", seed: "abbb3c243c372a66a3aac62a6f5e96becea41c45e5cdbd26060a913e71d0ad08", from: MINI1 },
	{ did: "did:key:z6MkoAs8JdFnQ3sDkhDGr1QyroUmVj5BMwXL1DzVLzRDyvJZ", seed: "2e5ffb39b868dd0e2f6b046b09014702551d356734d92270f1c7484f2d97eebf", from: MINI1 },
	{ did: "did:key:z6MkojPmKYrzFuoMqRVYrp4cdGsA4xsXdJ1vKkUmhKqn57Dr", seed: "6912919ef75a0e0e739015eb089637006278c34a1c0d84c8cbbbdd917c706136", from: MINI1 },
	{ did: "did:key:z6MkvxSyjdy7MZd4WmR3vQQsZaaDsLKvRfgYXjerKyF76b8g", seed: "aa30a6199cd3e62bf9278346fc7f4376f176219b1fbf3efc03fe4a1cd6859dbf", from: MINI1 },
	{ did: "did:key:z6Mkgdqjyiwiie9hCy9hPkGmp2y8dtMUrgPvguy1wgtAHye5", seed: "87893a20574f0e764fc7f0361d02a6dff4038897a366a30253b65fe668181b7b", from: MINI1 },
	{ did: "did:key:z6MkiB1iAqVCcFPm3PyZmFqmtQqN8UMWxWw3YuzC1HPzrsKt", seed: "b4de293dcb00e2bb5db08e3f7cc3213ae962872104d709ef8694348f024b83c9", from: MINI1 },
	{ did: "did:key:z6MkuTD3waVwDJnUq8eChVNdGN4LHp5xJqrbgyQUydqTDH5B", seed: "6536ba764268b7574aa8a4a56fd71d4eabcd5c16784e364ce8945987860cbd05", from: MINI1 },
	{ did: "did:key:z6MkmKGjf9oGWbF3oSgSDwJ3AFpgsY8eGtszf2F22p41Rnry", seed: "41f4b2d233f11ef95595abd9e9eca365ba3757e4e6fe667f7dfd2718dd272c43", from: MINI1 },
	{ did: "did:key:z6MkvnQ4f36mPWiWKwy5EE2enreynbFw2YpmThAL68ECwsU5", seed: "316998304b4917d92f402e09166ad07aeb122953a7dd5586756faf3eba87b658", from: MINI1 },
	// Mini2 delegators (9)
	{ did: "did:key:z6Mkf4e4mvWEbCM2HEhaU1QDo83wkdey8ZpEdJvFwekdAXbz", seed: "e80d1324587a936eaa7f4a96c04cb67a1cae929b3b864aae152c7da59c6c9630", from: MINI2 },
	{ did: "did:key:z6MkpBHfsncKdRic3mrGRDsdfGRz76FoQs6EYDMzXw9YyNbT", seed: "69f4f4bd08c4ce8a54269681105a69e74309ead6cb28da7ad5b90a53b1e3b2c3", from: MINI2 },
	{ did: "did:key:z6Mkp8jXR22REXjXAu8m1twNKGr9LAxdn9koqgDqWAZNFAbd", seed: "1354429266a70563fc952bb9a464d377db284e9aa04db7a2153075191c05d6b9", from: MINI2 },
	{ did: "did:key:z6MkeoBaLsJ2LTVQiZUwFQAS4zqxh5XsphqabEQpoTUdSzap", seed: "401273738eb279e995075dc98dbebace6af1cd26574963eafc33ee155c189a8d", from: MINI2 },
	{ did: "did:key:z6MkpevsRF15MoNqs7ps1putD7vwfWGfgsvB48kGCPFt6XcC", seed: "1754fe377e618b08254f3ba89e9df5b5dacf5a957acc32de6bec6cc09e154843", from: MINI2 },
	{ did: "did:key:z6MkvRteszWtf5iWuHidJoaQ3SDsfrcPFEf6KxfCgCkLUkjj", seed: "f1b840f403427872de1f2c9b72306936f03f1d1d25a6bc022ce00c9de1e02a0c", from: MINI2 },
	{ did: "did:key:z6MkknRdWX6CK6Y4zqqrEFxSUFa2p48cC742AYuX5PoQHusa", seed: "dd31d294beb80e29941fe871b678b3d275a325efe9461f76966521fcc9dca717", from: MINI2 },
	{ did: "did:key:z6MkoWHBPQoeZAohxv83oemmh2tuF1XVa73jjbDGSk6Gx33S", seed: "1b897181932cc24ae420b31cb2260ae2592fa37f975de9842c234a2b773a6d6d", from: MINI2 },
	{ did: "did:key:z6MksivyUdiNUhJWMxgSnzhvPLTSHUVZjZA8X6i72kyZ9KV8", seed: "ff1a4f0656b1ee243714346e70b30a843397ea7b625254cc0b1761a5372ede85", from: MINI2 },
	// Mini3 delegators (9)
	{ did: "did:key:z6MknckwpzNtccdbwC85Z4T1Lb2H9yn9E6BDqNgxCnRgCsoB", seed: "27c53f4cba5995b81cacdc95cfc9633c8dfe8c59e8a5981f0cbd2cac4e2270bc", from: MINI3 },
	{ did: "did:key:z6MkherrQNyVe5WykdW6vJpXiDdEMekGvaoBPW4WDzvqXoRo", seed: "ec2e9912f9e8b617ff1f4672d818ca18cbe6753d7df7fb5c88925947427c097b", from: MINI3 },
	{ did: "did:key:z6MkgYbeY93qhEDVRD1mSYkKdshrJsXHjjZfjGBVtXrUf9Rq", seed: "46a9ae6d4238157235d105c26f27c2c76e7e0bbaed0ca90a8a8cc351ab3533d1", from: MINI3 },
	{ did: "did:key:z6MkpQYC7it5pRmbjKaiN3wqf4xpz5PY5eBPqiD7d3oEEbkR", seed: "ff9735639d9363069f9480782ad6c5204854eeeed10eb68e459ff9896c168510", from: MINI3 },
	{ did: "did:key:z6MkiW5UB7Xh2tPUstUNJTDYGUYwRE7LjtydWm2RWVoR3E9q", seed: "53c454e60979f557880bf167343c2ea78dbfde2cac63d97c488e4bed381cacec", from: MINI3 },
	{ did: "did:key:z6MkiPYyZ5P75AY72FcBvzLMVdGnnyptoXvwp6zJjPPSEt1z", seed: "9b706ac0b92e74d0e80b500e17d9ebab768855456d4178727ba594eed198a34a", from: MINI3 },
	{ did: "did:key:z6MkonrzYoqNqD7iL87xz8Ppqrjtq73xYWaxA3pYxevURvDi", seed: "6548e9e2e10a11223cb8361da3d54f4fac28106dde8a8ce831de3ea1dbe3d98c", from: MINI3 },
	{ did: "did:key:z6MkgNxKbmse6px1xeXr1C2L53LXD6zUoCdxsHRygcYfUkXU", seed: "84a62a9539a56f216bc0cd42e7a1f357a21597daa0e2de878da5adb1cb78bcf8", from: MINI3 },
	{ did: "did:key:z6MkgBaLg2KEK5bGcAax2PeVp1n6hJvBzM6ZRjMPrfwPQS1V", seed: "32e0e38c9c40507206cda7457aae0d7f4de765f84bc8679c72c82042536445c1", from: MINI3 },
	// MBP delegators (4)
	{ did: "did:key:z6Mkq4htxWS8jyLz3jjtDGtU36cXvE3kbXa9FTbF4xpPmr4g", seed: "a9dbf4d2dbe7d28aa6c093ce7881816772d9197d3eb6b0f7eeb25c67d7f67c49", from: MBP },
	{ did: "did:key:z6MkjWwm9vRwo25R8GCDFQmgCvXkKcG5AZGeCj5SSQeQuW9Q", seed: "01bdf665cc7d506b67aed53aec65aab5c1933fe11c330345773869c69af6d7e5", from: MBP },
	{ did: "did:key:z6Mkk5HCbmULHwL6iDcVfNgsm5kzWQVFwGeupQqDw9D6SMpy", seed: "4fdfcba66f93a7b80afb54f506ed4a584535307415c65f12ff45f79966f58f71", from: MBP },
	{ did: "did:key:z6MkmozExkxmdrSXtnhPeaSujw7KHtrP9gftBGjvVH7ZE3ZS", seed: "9eda8dd6497e6d61c80169f8dd92b4c45e3fc7e427f75a903ad7c29983b04a0c", from: MBP },
];

async function signTx(type: string, from: string, to: string, amount: string, nonce: number, seed: Uint8Array, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
	const ts = Date.now();
	const payload = JSON.stringify({ type, from, to, amount, nonce, timestamp: ts });
	const sig = await ed.signAsync(ENC.encode(payload), seed);
	const tx: Record<string, unknown> = { type, from, to, amount, nonce, timestamp: ts, signature: bytesToHex(sig) };
	if (data) {
		tx["data"] = Array.from(ENC.encode(JSON.stringify(data)));
	}
	return tx;
}

async function broadcast(tx: Record<string, unknown>): Promise<{ applied: boolean; height?: number; error?: string }> {
	const resp = await fetch(`${API_URL}/v1/tx/broadcast`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(tx),
		signal: AbortSignal.timeout(30000),
	});
	return (await resp.json()) as { applied: boolean; height?: number; error?: string };
}

async function queryNonce(did: string): Promise<number> {
	const resp = await fetch("http://localhost:26657", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "q", method: "abci_query", params: { path: `balance/${did}` } }),
		signal: AbortSignal.timeout(5000),
	});
	const d = (await resp.json()) as { result: { response: { value: string } } };
	const decoded = JSON.parse(Buffer.from(d.result.response.value, "base64").toString());
	return decoded.nonce as number;
}

async function main() {
	console.log("=== Voting Power Redistribution ===\n");
	console.log("Redelegating 31 delegators from 4 home operators to 16 cloud validators.");
	console.log("Zero treasury spend. Delegators retain ownership.\n");

	// Assign delegators to cloud targets (round-robin)
	// 31 delegators across 16 targets: 15 get 2 each, 1 gets 1
	const assignments: Array<{ delegator: typeof DELEGATORS[0]; target: typeof CLOUD_TARGETS[0] }> = [];
	for (let i = 0; i < DELEGATORS.length; i++) {
		const target = CLOUD_TARGETS[i % CLOUD_TARGETS.length]!;
		assignments.push({ delegator: DELEGATORS[i]!, target });
	}

	// Group by source operator for batched processing
	const bySource = new Map<string, typeof assignments>();
	for (const a of assignments) {
		const list = bySource.get(a.delegator.from) ?? [];
		list.push(a);
		bySource.set(a.delegator.from, list);
	}

	const sourceNames: Record<string, string> = {
		[MINI1]: "Mini1",
		[MINI2]: "Mini2",
		[MINI3]: "Mini3",
		[MBP]: "MBP",
	};

	let totalRedelegated = 0;
	let batchNum = 0;

	for (const [sourceValidator, batch] of bySource) {
		batchNum++;
		const sourceName = sourceNames[sourceValidator] ?? sourceValidator.slice(-12);
		console.log(`\n--- Batch ${batchNum}/4: ${sourceName} (${batch.length} delegators) ---\n`);

		for (const { delegator, target } of batch) {
			const nonce = await queryNonce(delegator.did);
			const seed = hexToBytes(delegator.seed);

			console.log(`  ${delegator.did.slice(-12)} -> ${target.name} (nonce=${nonce})`);

			const tx = await signTx(
				"redelegate",
				delegator.did,
				target.did,
				DELEGATION_AMOUNT.toString(),
				nonce,
				seed,
				{ fromValidator: sourceValidator },
			);
			const result = await broadcast(tx);
			if (!result.applied) {
				console.log(`    FAILED: ${result.error}`);
				continue;
			}
			console.log(`    OK (height ${result.height})`);
			totalRedelegated++;
			await new Promise(r => setTimeout(r, 500));
		}

		// Verify chain health after each batch
		await new Promise(r => setTimeout(r, 3000));
		const statusResp = await fetch("https://api.ensoul.dev/v1/network/status", { signal: AbortSignal.timeout(5000) });
		const status = (await statusResp.json()) as { blockHeight: number; validatorCount: number };
		console.log(`\n  Chain health: height=${status.blockHeight} validators=${status.validatorCount}`);
	}

	// Final power distribution
	console.log(`\n\n=== Results ===\n`);
	console.log(`Redelegated: ${totalRedelegated}/31 delegators`);

	await new Promise(r => setTimeout(r, 5000));

	const resp = await fetch("http://localhost:26657", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "q", method: "abci_query", params: { path: "validators" } }),
		signal: AbortSignal.timeout(5000),
	});
	const d = (await resp.json()) as { result: { response: { value: string } } };
	const decoded = JSON.parse(Buffer.from(d.result.response.value, "base64").toString()) as {
		validators: Array<{ did: string; power: number; stakedBalance: string; delegatedToThis: string }>;
	};

	let totalPower = 0;
	let homePower = 0;
	let cloudPower = 0;
	const homeOps = new Set([MINI1, MINI2, MINI3, MBP]);

	for (const v of decoded.validators.sort((a, b) => b.power - a.power)) {
		totalPower += v.power;
		const isHome = homeOps.has(v.did);
		if (isHome) homePower += v.power; else cloudPower += v.power;
		const label = isHome ? "(HOME)" : "(CLOUD)";
		console.log(`  ${v.did.slice(-15)} power=${v.power.toLocaleString().padStart(12)} ${label}`);
	}

	console.log(`\nTotal: ${totalPower.toLocaleString()}`);
	console.log(`Home:  ${homePower.toLocaleString()} (${(homePower / totalPower * 100).toFixed(1)}%)`);
	console.log(`Cloud: ${cloudPower.toLocaleString()} (${(cloudPower / totalPower * 100).toFixed(1)}%)`);
	console.log(`\nCooper City outage: ${((totalPower - homePower) / totalPower * 100).toFixed(1)}% power remains`);
}

main().catch(console.error);
