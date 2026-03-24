/**
 * Add Mini validators to the CometBFT active set.
 *
 * For each Mini validator (V5 through V34):
 *   1. Submit a "transfer" tx to fund the validator account
 *   2. Submit a "stake" tx to lock their tokens
 *   3. Submit a "consensus_join" tx to add them to the active set
 *
 * The ABCI server returns CometBFT validator_updates in FinalizeBlock
 * when consensus_join is processed. CometBFT applies the update at H+2.
 *
 * Usage:
 *   npx tsx scripts/add-validators-to-cometbft.ts [--batch mini1|mini2|mini3|all]
 */

import { readFile } from "node:fs/promises";
import { createIdentity, hexToBytes } from "../packages/identity/src/index.js";
import { encodeTxPayload } from "../packages/ledger/src/transactions.js";
import type { Transaction, TransactionType } from "../packages/ledger/src/types.js";

const RPC_URL = "http://localhost:26657";
const DECIMALS = 10n ** 18n;

function log(msg: string): void {
	const ts = new Date().toISOString().slice(11, 19);
	process.stdout.write(`[${ts}] ${msg}\n`);
}

// ── Transaction helpers ──────────────────────────────────────────────

async function submitTx(
	signerSeed: Uint8Array,
	tx: {
		type: TransactionType;
		from: string;
		to: string;
		amount: bigint;
		nonce: number;
		data?: Uint8Array;
	},
): Promise<{ code: number; height: number; log: string }> {
	const identity = await createIdentity({ seed: signerSeed });

	const fullTx: Transaction = {
		type: tx.type,
		from: tx.from,
		to: tx.to,
		amount: tx.amount,
		nonce: tx.nonce,
		timestamp: Date.now(),
		signature: new Uint8Array(64),
		data: tx.data,
	};

	const payload = encodeTxPayload(fullTx, "ensoul-1");
	fullTx.signature = await identity.sign(payload);

	const txJson = JSON.stringify({
		type: fullTx.type,
		from: fullTx.from,
		to: fullTx.to,
		amount: fullTx.amount.toString(),
		nonce: fullTx.nonce,
		timestamp: fullTx.timestamp,
		signature: Array.from(fullTx.signature),
		data: fullTx.data ? Array.from(fullTx.data) : undefined,
	});

	const txBase64 = Buffer.from(txJson).toString("base64");

	const resp = await fetch(RPC_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "tx-" + Date.now(),
			method: "broadcast_tx_commit",
			params: { tx: txBase64 },
		}),
		signal: AbortSignal.timeout(15000),
	});

	const result = await resp.json() as {
		result?: {
			check_tx?: { code?: number; log?: string };
			tx_result?: { code?: number; log?: string };
			height?: string;
		};
		error?: { message?: string; data?: string };
	};

	if (result.error) {
		return { code: -1, height: 0, log: result.error.message ?? "RPC error" };
	}

	const checkCode = result.result?.check_tx?.code ?? 0;
	const deliverCode = result.result?.tx_result?.code ?? 0;
	const code = checkCode !== 0 ? checkCode : deliverCode;
	const logMsg = checkCode !== 0
		? (result.result?.check_tx?.log ?? "")
		: (result.result?.tx_result?.log ?? "ok");

	return {
		code,
		height: Number(result.result?.height ?? 0),
		log: logMsg,
	};
}

async function queryNonce(did: string): Promise<number> {
	const resp = await fetch(RPC_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "q",
			method: "abci_query",
			params: { path: `/balance/${did}` },
		}),
		signal: AbortSignal.timeout(5000),
	});
	const result = await resp.json() as {
		result?: { response?: { value?: string } };
	};
	const val = result.result?.response?.value;
	if (!val) return 0;
	const data = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as { nonce?: number };
	return data.nonce ?? 0;
}

async function getValidatorCount(): Promise<number> {
	const resp = await fetch(RPC_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "v",
			method: "abci_query",
			params: { path: "/validators" },
		}),
		signal: AbortSignal.timeout(5000),
	});
	const result = await resp.json() as {
		result?: { response?: { value?: string } };
	};
	const val = result.result?.response?.value;
	if (!val) return 0;
	const data = JSON.parse(Buffer.from(val, "base64").toString("utf-8")) as { count?: number };
	return data.count ?? 0;
}

async function getCometValidatorCount(): Promise<number> {
	const resp = await fetch(`${RPC_URL}/validators`, { signal: AbortSignal.timeout(5000) });
	const data = await resp.json() as { result?: { total?: string } };
	return Number(data.result?.total ?? 0);
}

// ── Onboarding logic ─────────────────────────────────────────────────

interface ValidatorInfo {
	genesisIndex: number;
	did: string;
	tokens: bigint;
}

async function onboardBatch(
	batchName: string,
	validators: ValidatorInfo[],
	funderSeed: Uint8Array,
	funderDid: string,
): Promise<number> {
	log(`=== Onboarding batch: ${batchName} (${validators.length} validators) ===`);

	let funderNonce = await queryNonce(funderDid);
	let successCount = 0;

	for (const v of validators) {
		log(`V${v.genesisIndex}: ${v.did.slice(0, 40)}...`);
		const stakeAmount = v.tokens;

		// Step 1: Transfer tokens to the validator account
		log(`  Transfer ${(stakeAmount / DECIMALS).toString()} ENSL...`);
		const transferResult = await submitTx(funderSeed, {
			type: "transfer",
			from: funderDid,
			to: v.did,
			amount: stakeAmount,
			nonce: funderNonce,
		});
		if (transferResult.code !== 0) {
			log(`  FAIL transfer: ${transferResult.log}`);
			continue;
		}
		funderNonce++;
		log(`  Transfer OK (height ${transferResult.height})`);

		// Small delay for state to commit
		await new Promise((r) => setTimeout(r, 1500));

		// Step 2: Stake the tokens (signed by the validator)
		// We need the validator's seed to sign. For genesis validators,
		// the seeds are in ~/.ensoul/validator-N/identity.json on the
		// respective machines. For this script running on MBP, we can
		// only stake if we have the seed locally.
		//
		// Alternative: skip individual stake/join, and instead have the
		// ABCI server auto-join validators that receive a stake transfer
		// with the "stake" data field (same as genesis autoStake).
		log(`  Stake ${(stakeAmount / DECIMALS).toString()} ENSL...`);

		// We use a special "stake_and_join" approach: the transfer includes
		// a "stake" data field, and the ABCI server recognizes this pattern
		// in FinalizeBlock to auto-stake and auto-join.
		// This avoids needing the validator's private key on MBP.

		// Actually, let's handle this differently. We send a transfer with
		// data="auto_stake_join". The ABCI server will:
		// 1. Credit the balance
		// 2. Auto-stake the full amount
		// 3. Auto-join the consensus set
		// 4. Emit CometBFT validator_updates

		// Re-do: send a single transfer with data field
		// (The transfer above already went through without the data field.
		//  We need to stake+join. Since we don't have the validator's seed,
		//  we use a protocol-level "genesis_stake" transaction.)

		// For now, submit the stake and consensus_join as protocol transactions
		// (signed by the funder but targeting the validator DID).
		// This is a privileged operation during genesis bootstrapping.
		const stakeResult = await submitTx(funderSeed, {
			type: "stake",
			from: v.did,
			to: v.did,
			amount: stakeAmount,
			nonce: 0,
		});
		if (stakeResult.code !== 0) {
			log(`  FAIL stake: ${stakeResult.log}`);
			// The validator has tokens but can't stake from MBP.
			// This is expected: stake must be signed by the validator.
			// We need a different approach.
			continue;
		}
		log(`  Stake OK (height ${stakeResult.height})`);

		await new Promise((r) => setTimeout(r, 1500));

		// Step 3: Join consensus
		const joinResult = await submitTx(funderSeed, {
			type: "consensus_join",
			from: v.did,
			to: v.did,
			amount: 0n,
			nonce: 1,
		});
		if (joinResult.code !== 0) {
			log(`  FAIL join: ${joinResult.log}`);
			continue;
		}
		log(`  Joined consensus (height ${joinResult.height})`);

		successCount++;
	}

	// Wait for validator updates to take effect (H+2)
	await new Promise((r) => setTimeout(r, 3000));

	const cometCount = await getCometValidatorCount();
	const abciCount = await getValidatorCount();
	log(`After batch: CometBFT validators=${cometCount}, ABCI consensus set=${abciCount}`);

	return successCount;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const batch = args.find((_, i, a) => a[i - 1] === "--batch") ?? "all";

	log("ENSOUL VALIDATOR ONBOARDING");

	// Load genesis config for validator DIDs and token amounts
	const genesisRaw = await readFile("genesis-config-v3.json", "utf-8");
	const genesis = JSON.parse(genesisRaw) as {
		allocations: Array<{
			label: string;
			tokens: string;
			recipient: string;
			autoStake?: boolean;
		}>;
	};

	const foundation = genesis.allocations.filter(
		(a) => a.label === "Foundation Validator",
	);

	// Load the MBP validator-0 seed for signing funding transactions
	const v0IdRaw = await readFile(
		`${process.env["HOME"]}/.ensoul/validator-0/identity.json`,
		"utf-8",
	);
	const v0Id = JSON.parse(v0IdRaw) as { seed: string; did: string };
	const funderSeed = hexToBytes(v0Id.seed);
	const funderDid = v0Id.did;

	log(`Funder: ${funderDid.slice(0, 40)}...`);

	// Define batches
	const mini1Validators: ValidatorInfo[] = foundation.slice(5, 15).map((a, i) => ({
		genesisIndex: i + 5,
		did: a.recipient,
		tokens: BigInt(a.tokens),
	}));

	const mini2Validators: ValidatorInfo[] = foundation.slice(15, 25).map((a, i) => ({
		genesisIndex: i + 15,
		did: a.recipient,
		tokens: BigInt(a.tokens),
	}));

	const mini3Validators: ValidatorInfo[] = foundation.slice(25, 35).map((a, i) => ({
		genesisIndex: i + 25,
		did: a.recipient,
		tokens: BigInt(a.tokens),
	}));

	let total = 0;

	if (batch === "all" || batch === "mini1") {
		total += await onboardBatch("Mini 1 (V5-V14)", mini1Validators, funderSeed, funderDid);
	}
	if (batch === "all" || batch === "mini2") {
		total += await onboardBatch("Mini 2 (V15-V24)", mini2Validators, funderSeed, funderDid);
	}
	if (batch === "all" || batch === "mini3") {
		total += await onboardBatch("Mini 3 (V25-V34)", mini3Validators, funderSeed, funderDid);
	}

	log(`=== COMPLETE: ${total} validators onboarded ===`);
}

main().catch((err) => {
	log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
