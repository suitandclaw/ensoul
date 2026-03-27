#!/usr/bin/env npx tsx
/**
 * Test script for ENSOUL-001: Signature Verification
 *
 * Submits transactions with valid and invalid signatures to verify
 * that the ABCI application correctly accepts/rejects them.
 *
 * Requires CometBFT running on localhost:26657.
 */

const CMT_RPC = "http://localhost:26657";

async function broadcast(tx: Record<string, unknown>): Promise<{
	checkCode: number;
	checkLog: string;
	deliverCode: number;
	deliverLog: string;
	hash: string;
}> {
	const txBase64 = Buffer.from(JSON.stringify(tx)).toString("base64");
	const resp = await fetch(CMT_RPC, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "test",
			method: "broadcast_tx_commit",
			params: { tx: txBase64 },
		}),
		signal: AbortSignal.timeout(30000),
	});
	const data = (await resp.json()) as {
		result?: {
			check_tx?: { code?: number; log?: string };
			tx_result?: { code?: number; log?: string };
			hash?: string;
		};
		error?: { data?: string; message?: string };
	};

	if (data.error) {
		return {
			checkCode: -1,
			checkLog: data.error.data ?? data.error.message ?? "rpc error",
			deliverCode: -1,
			deliverLog: "",
			hash: "",
		};
	}

	return {
		checkCode: data.result?.check_tx?.code ?? -1,
		checkLog: data.result?.check_tx?.log ?? "",
		deliverCode: data.result?.tx_result?.code ?? -1,
		deliverLog: data.result?.tx_result?.log ?? "",
		hash: data.result?.hash ?? "",
	};
}

async function main(): Promise<void> {
	const ed = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

	// Generate a test keypair
	const seed = new Uint8Array(32);
	crypto.getRandomValues(seed);
	const publicKey = await ed.getPublicKeyAsync(seed);

	// Derive DID from public key (did:key:z format with ed25519 multicodec)
	const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	const mc = new Uint8Array(2 + publicKey.length);
	mc[0] = 0xed; mc[1] = 0x01;
	mc.set(publicKey, 2);
	let num = 0n;
	for (const byte of mc) num = num * 256n + BigInt(byte);
	let encoded = "";
	while (num > 0n) { encoded = B58[Number(num % 58n)]! + encoded; num = num / 58n; }
	for (const byte of mc) { if (byte === 0) encoded = "1" + encoded; else break; }
	const did = `did:key:z${encoded}`;

	console.log(`Test DID: ${did.slice(0, 30)}...`);
	console.log("");

	let passed = 0;
	let failed = 0;

	// ── Test 1: Valid signature (should be accepted by CheckTx) ────
	{
		const ts = Date.now();
		const payload = JSON.stringify({
			type: "transfer",
			from: did,
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: ts,
		});
		const sig = await ed.signAsync(new TextEncoder().encode(payload), seed);

		const result = await broadcast({
			type: "transfer",
			from: did,
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: ts,
			signature: Array.from(sig),
		});

		// CheckTx should accept (code 0) or reject for a ledger reason (code 3, like no balance)
		// but NOT reject for signature (code 31)
		const sigOk = result.checkCode !== 31;
		console.log(`Test 1: Valid signature      ${sigOk ? "PASS" : "FAIL"}  (checkCode=${result.checkCode}, log=${result.checkLog})`);
		if (sigOk) passed++; else failed++;
	}

	// ── Test 2: Tampered signature (one byte changed, should reject) ────
	{
		const ts2 = Date.now();
		const payload = JSON.stringify({
			type: "transfer",
			from: did,
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: ts2,
		});
		const sig = await ed.signAsync(new TextEncoder().encode(payload), seed);
		// Tamper one byte
		const tampered = new Uint8Array(sig);
		tampered[0] = (tampered[0]! + 1) % 256;

		const result = await broadcast({
			type: "transfer",
			from: did,
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: ts2,
			signature: Array.from(tampered),
		});

		const sigRejected = result.checkCode === 31;
		console.log(`Test 2: Tampered signature   ${sigRejected ? "PASS" : "FAIL"}  (checkCode=${result.checkCode}, log=${result.checkLog})`);
		if (sigRejected) passed++; else failed++;
	}

	// ── Test 3: Wrong key (sign with different key, should reject) ────
	{
		const wrongSeed = new Uint8Array(32);
		crypto.getRandomValues(wrongSeed);
		const ts3 = Date.now();

		const payload = JSON.stringify({
			type: "transfer",
			from: did, // DID corresponds to the original key
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: ts3,
		});
		// Sign with the WRONG key
		const sig = await ed.signAsync(new TextEncoder().encode(payload), wrongSeed);

		const result = await broadcast({
			type: "transfer",
			from: did,
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: ts3,
			signature: Array.from(sig),
		});

		const sigRejected = result.checkCode === 31;
		console.log(`Test 3: Wrong key signature  ${sigRejected ? "PASS" : "FAIL"}  (checkCode=${result.checkCode}, log=${result.checkLog})`);
		if (sigRejected) passed++; else failed++;
	}

	// ── Test 4: No signature (empty array, should reject) ────
	{
		const result = await broadcast({
			type: "transfer",
			from: did,
			to: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
			amount: "0",
			nonce: 0,
			timestamp: Date.now(),
			signature: [] as number[],
		});

		const sigRejected = result.checkCode === 31;
		console.log(`Test 4: No signature         ${sigRejected ? "PASS" : "FAIL"}  (checkCode=${result.checkCode}, log=${result.checkLog})`);
		if (sigRejected) passed++; else failed++;
	}

	console.log("");
	console.log(`Results: ${passed}/${passed + failed} passed`);
	if (failed > 0) {
		console.log("SIGNATURE VERIFICATION TESTS FAILED");
		process.exit(1);
	} else {
		console.log("ALL SIGNATURE VERIFICATION TESTS PASSED");
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
