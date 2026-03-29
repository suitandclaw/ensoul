/**
 * Stake 9 new cloud validators.
 *
 * For each validator:
 * 1. Transfer 2M ENSL from genesis treasury
 * 2. Stake 2M ENSL (signed by the validator's key)
 * 3. Submit consensus_join (signed by the validator's key)
 *
 * Usage: npx tsx scripts/stake-new-validators.ts
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	return bytes;
}

// Configure @noble/ed25519 to use sha512
(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

const ENC = new TextEncoder();
const API_URL = "https://api.ensoul.dev";
const DECIMALS = 10n ** 18n;
const STAKE_AMOUNT = 2_000_000n * DECIMALS;

// Treasury key
const TREASURY = {
	did: "did:key:z6Mki9jwpYMBB93zxYfsmNUHThpSgKATqydN4xJA1xcxGecm",
	seed: "7687a6d13a43177d5871a84f1cd9c8e84fc4cdb1ba04f34a70fb94fb55a07568",
};

// New validators: CometBFT priv_key contains seed (first 32 bytes) + pubkey (last 32 bytes)
const VALIDATORS = [
	{
		name: "Singapore",
		ip: "5.223.51.228",
		did: "did:key:z6MkizqcK1oovKYgosSw2UWyUbTUCh43qhkQD8trvvHJq2v9",
		privKey: "6R+C5v1EOM0nB/GzHFduVZ9PZaFmCcDDFMlhIwlb7AtDhbQxj9v8RQkEA7IEjVQ5ndQc5khc5NstE8tPBCHbfg==",
	},
	{
		name: "Boston",
		ip: "72.60.117.56",
		did: "did:key:z6MktBn22qC9iYT69uAvLSDRLoKkADqnimGQK5g9UmqUTy7o",
		privKey: "GByhvR2RHL6/WrC6Yg7qELnvQtZlefwUDcQOL/akZI/MDDb5URdQN1WUMAcmIUlOwOd+VePkUs4A7tfmPj10qg==",
	},
	{
		name: "Lithuania",
		ip: "45.93.137.173",
		did: "did:key:z6MknspWy1YHKCrDSDKzMBDaAjKV22VG2v1didFaAjcYLUXp",
		privKey: "a7EPB8xTIuDdmgD58AJ4jlCRLEwYdKi6KDvTD6XXOc99KCapUpp28afFJTsCPDhkwtDO04W7mjmxTv0pdiBujw==",
	},
	{
		name: "France",
		ip: "187.124.48.67",
		did: "did:key:z6MkhzppwzKBMbdgjYhs9vh38f7imWNa2wEtQ74MsoAJBnPn",
		privKey: "WBRE19+RefeoFeIyEJYv0ShMOXPH7Onj7UVbPaLuu2o0qSHzPApuwLr8MlzGxRB3QL4E0Ae5VMCekYXU13lpPQ==",
	},
	{
		name: "Frankfurt",
		ip: "187.124.6.203",
		did: "did:key:z6MktGKyB8y3pjVSAjHmSt9DorEFdg9kZueBrfv3gXjp4n9A",
		privKey: "F9nZcaWLdipUwv5AYI6SXZEF4yf88H9FMv0ZRKK1OsbNNqowYRWVpV/gvD4RoyVrqKQLVGC74rKLf7RFQd6K1Q==",
	},
	{
		name: "UK",
		ip: "72.61.201.200",
		did: "did:key:z6MkkkktTaa25E1P9Vh5Y7Abb4uJ5u9ChWn4G4Hwr1nJixmV",
		privKey: "MG3qJI5DndK26QnHgTWLSTItxWVW+VX8LP70oPnSHOhdoZuRTizdvE4W6bmf5rXpNEdAJM9nxl7RbINZXW/k6A==",
	},
	{
		name: "Bangalore",
		ip: "167.71.234.198",
		did: "did:key:z6MkkF7Vsf74yfUVmauMBGnTfpE6dGTwSdxPfs1qmDws6tPG",
		privKey: "GJkCLxwGcRglBd9+w9VmAowGFzNBduG8gfrmsNN+LrRWCXznBJCmrOpWzNBppeUGl4U34SWha4nGdJBBhZ4j3w==",
	},
	{
		name: "Sydney",
		ip: "209.38.27.136",
		did: "did:key:z6Mki2nw2XUJe1KqW5L6TEvqgBSVyvJPUqNUhT6xpUWFVha6",
		privKey: "SITkwuBU3VZoDivHmgGYlHOylShhw9rADtoISfk87Fk1Kia9Gyl5eXSHwV3cxv6Ynwt+ybwDXb9xbXDF/tWCvw==",
	},
	{
		name: "Toronto",
		ip: "138.197.135.114",
		did: "did:key:z6MkpsgG1gJio5529CiCKPmTKcs14Y9GBwEKdTa5imQNFcz7",
		privKey: "U3xIiHgEmPDI75bKQYoj/s7DgReqNTFRK1GP6Tmxz6Ka1jAOUwzJuFOPmM4+qA4wqJBTDCbapr6/hTNi7V2yPA==",
	},
];

async function signTx(
	type: string,
	from: string,
	to: string,
	amount: string,
	nonce: number,
	seed: Uint8Array,
): Promise<Record<string, unknown>> {
	const ts = Date.now();
	const payload = JSON.stringify({ type, from, to, amount, nonce, timestamp: ts });
	const sig = await ed.signAsync(ENC.encode(payload), seed);
	return { type, from, to, amount, nonce, timestamp: ts, signature: bytesToHex(sig) };
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

async function main() {
	const treasurySeed = hexToBytes(TREASURY.seed);
	let treasuryNonce = 1050;

	console.log("=== Staking 9 New Validators ===\n");
	console.log(`Treasury: ${TREASURY.did}`);
	console.log(`Starting nonce: ${treasuryNonce}`);
	console.log(`Amount per validator: 2,000,000 ENSL\n`);

	for (const v of VALIDATORS) {
		console.log(`\n--- ${v.name} (${v.ip}) ---`);
		console.log(`  DID: ${v.did}`);

		// Extract seed (first 32 bytes of the 64-byte CometBFT private key)
		const fullKey = Buffer.from(v.privKey, "base64");
		const validatorSeed = fullKey.subarray(0, 32);

		// Step 1: Transfer 2M ENSL from treasury
		console.log("  [1/3] Transferring 2,000,000 ENSL from treasury...");
		const transferTx = await signTx(
			"transfer",
			TREASURY.did,
			v.did,
			STAKE_AMOUNT.toString(),
			treasuryNonce,
			treasurySeed,
		);
		const transferResult = await broadcast(transferTx);
		if (!transferResult.applied) {
			console.log(`  FAILED: ${transferResult.error}`);
			console.log("  Skipping this validator.");
			continue;
		}
		console.log(`  Transfer OK (height ${transferResult.height})`);
		treasuryNonce++;

		// Brief pause between transactions
		await new Promise((r) => setTimeout(r, 1000));

		// Step 2: Stake 2M ENSL (signed by validator)
		console.log("  [2/3] Staking 2,000,000 ENSL...");
		const stakeTx = await signTx(
			"stake",
			v.did,
			v.did,
			STAKE_AMOUNT.toString(),
			0, // New account, nonce starts at 0
			validatorSeed,
		);
		const stakeResult = await broadcast(stakeTx);
		if (!stakeResult.applied) {
			console.log(`  FAILED: ${stakeResult.error}`);
			continue;
		}
		console.log(`  Stake OK (height ${stakeResult.height})`);

		await new Promise((r) => setTimeout(r, 1000));

		// Step 3: consensus_join (signed by validator)
		console.log("  [3/3] Joining consensus...");
		const joinTx = await signTx(
			"consensus_join",
			v.did,
			v.did,
			"0",
			1, // After stake, nonce is 1
			validatorSeed,
		);
		const joinResult = await broadcast(joinTx);
		if (!joinResult.applied) {
			console.log(`  FAILED: ${joinResult.error}`);
			continue;
		}
		console.log(`  Consensus join OK (height ${joinResult.height})`);

		await new Promise((r) => setTimeout(r, 500));
	}

	// Final status
	console.log("\n\n=== Final Status ===");
	console.log(`Treasury nonce: ${treasuryNonce}`);
	console.log(`Treasury spent: ${(treasuryNonce - 1050) * 2},000,000 ENSL`);

	// Check validator count
	const resp = await fetch(`${API_URL}/v1/network/status`, { signal: AbortSignal.timeout(10000) });
	const status = (await resp.json()) as { validatorCount: number; blockHeight: number };
	console.log(`Validator count: ${status.validatorCount}`);
	console.log(`Block height: ${status.blockHeight}`);
}

main().catch(console.error);
