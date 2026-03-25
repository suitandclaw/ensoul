/**
 * Migrate all agent registrations and consciousness stores to on-chain state.
 *
 * Reads the API gateway's disk files (registered-agents.json,
 * consciousness-store.json) and submits transactions to CometBFT
 * so the data is replicated across all validators by consensus.
 *
 * Usage:
 *   npx tsx scripts/migrate-agents-onchain.ts [--batch-size 10] [--dry-run]
 */

import { readFile } from "node:fs/promises";
import { createIdentity, hexToBytes } from "../packages/identity/src/index.js";
import { encodeTxPayload } from "../packages/ledger/src/transactions.js";
import type { Transaction, TransactionType } from "../packages/ledger/src/types.js";

const RPC = "http://localhost:26657";
const ENC = new TextEncoder();
const HOME = process.env["HOME"] ?? "/tmp";
const BATCH_SIZE = Number(process.argv.find((_, i, a) => a[i - 1] === "--batch-size") ?? 10);
const DRY_RUN = process.argv.includes("--dry-run");

function log(msg: string): void {
	const ts = new Date().toISOString().slice(11, 19);
	process.stdout.write(`[${ts}] ${msg}\n`);
}

// Load the onboarding key for signing
let signerSeed: Uint8Array;
let signerDid: string;

async function loadSigner(): Promise<void> {
	const keyRaw = await readFile(`${HOME}/ensoul/genesis-keys/onboarding.json`, "utf-8");
	const key = JSON.parse(keyRaw) as { seed: string; did: string };
	signerSeed = hexToBytes(key.seed);
	signerDid = key.did;
	log(`Signer: ${signerDid.slice(0, 40)}...`);
}

async function submitTx(
	type: string,
	from: string,
	data: Record<string, unknown>,
	nonce: number,
): Promise<{ code: number; height: number; log: string }> {
	const tx: Transaction = {
		type: type as TransactionType,
		from,
		to: from,
		amount: 0n,
		nonce,
		timestamp: Date.now(),
		signature: new Uint8Array(64),
		data: ENC.encode(JSON.stringify(data)),
	};

	const identity = await createIdentity({ seed: signerSeed });
	const payload = encodeTxPayload(tx, "ensoul-1");
	tx.signature = await identity.sign(payload);

	const txJson = JSON.stringify({
		type: tx.type,
		from: tx.from,
		to: tx.to,
		amount: tx.amount.toString(),
		nonce: tx.nonce,
		timestamp: tx.timestamp,
		signature: Array.from(tx.signature),
		data: Array.from(tx.data!),
	});

	if (DRY_RUN) {
		return { code: 0, height: 0, log: "dry-run" };
	}

	const resp = await fetch(RPC, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "tx",
			method: "broadcast_tx_commit",
			params: { tx: Buffer.from(txJson).toString("base64") },
		}),
		signal: AbortSignal.timeout(15000),
	});

	const result = await resp.json() as {
		result?: {
			check_tx?: { code?: number; log?: string };
			tx_result?: { code?: number; log?: string };
			height?: string;
		};
		error?: { message?: string };
	};

	if (result.error) return { code: -1, height: 0, log: result.error.message ?? "rpc error" };
	const cc = result.result?.check_tx?.code ?? 0;
	const dc = result.result?.tx_result?.code ?? 0;
	return {
		code: cc !== 0 ? cc : dc,
		height: Number(result.result?.height ?? 0),
		log: cc !== 0 ? (result.result?.check_tx?.log ?? "") : (result.result?.tx_result?.log ?? "ok"),
	};
}

async function queryAgentCount(): Promise<number> {
	const resp = await fetch(RPC, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "q", method: "abci_query", params: { path: "/stats" } }),
		signal: AbortSignal.timeout(5000),
	});
	const r = await resp.json() as { result?: { response?: { value?: string } } };
	const v = r.result?.response?.value;
	if (!v) return 0;
	const data = JSON.parse(Buffer.from(v, "base64").toString("utf-8")) as { agentCount?: number };
	return data.agentCount ?? 0;
}

async function main(): Promise<void> {
	log("AGENT DATA ON-CHAIN MIGRATION");
	if (DRY_RUN) log("MODE: DRY RUN");
	log("");

	await loadSigner();

	// Load disk data
	const agentsRaw = await readFile(`${HOME}/.ensoul/registered-agents.json`, "utf-8");
	const agents = JSON.parse(agentsRaw) as Array<{ did: string; publicKey: string; registeredAt?: number }>;
	log(`Agents on disk: ${agents.length}`);

	const storesRaw = await readFile(`${HOME}/.ensoul/consciousness-store.json`, "utf-8");
	const stores = JSON.parse(storesRaw) as Array<{ did: string; stateRoot: string; version: number; shardCount?: number; storedAt?: number }>;
	log(`Consciousness stores on disk: ${stores.length}`);

	const beforeCount = await queryAgentCount();
	log(`Agents on-chain before: ${beforeCount}`);
	log("");

	// Phase 1: Register all agents
	// Each agent DID is unique and has nonce 0 (never transacted before)
	log("=== PHASE 1: Agent Registration ===");
	let registered = 0;
	let regSkipped = 0;
	let regFailed = 0;

	for (let i = 0; i < agents.length; i += BATCH_SIZE) {
		const batch = agents.slice(i, i + BATCH_SIZE);

		for (const agent of batch) {
			const result = await submitTx("agent_register", agent.did, {
				publicKey: agent.publicKey,
			}, 0); // nonce 0 for each unique agent DID

			if (result.code === 0) {
				registered++;
			} else if (result.log.includes("already registered")) {
				regSkipped++;
			} else {
				regFailed++;
				if (regFailed <= 3) log(`  FAIL: ${agent.did.slice(0, 30)}... code=${result.code} ${result.log}`);
			}
		}

		if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= agents.length) {
			log(`  Progress: ${Math.min(i + BATCH_SIZE, agents.length)}/${agents.length} (registered=${registered} skipped=${regSkipped} failed=${regFailed})`);
		}

		// Small delay between batches to avoid overwhelming CometBFT
		if (!DRY_RUN) await new Promise((r) => setTimeout(r, 500));
	}

	log(`Phase 1 complete: ${registered} registered, ${regSkipped} skipped, ${regFailed} failed`);
	log("");

	// Phase 2: Store consciousness
	log("=== PHASE 2: Consciousness Stores ===");
	let stored = 0;
	let storeSkipped = 0;
	let storeFailed = 0;

	for (let i = 0; i < stores.length; i += BATCH_SIZE) {
		const batch = stores.slice(i, i + BATCH_SIZE);

		for (const cs of batch) {
			// Consciousness stores use the agent's nonce.
			// After registration, the agent has nonce 0 (agent_register doesn't increment).
			// So consciousness_store also uses nonce 0 for the DID.
			const result = await submitTx("consciousness_store", cs.did, {
				stateRoot: cs.stateRoot,
				version: cs.version,
				shardCount: cs.shardCount ?? 0,
			}, 0);

			if (result.code === 0) {
				stored++;
			} else {
				storeFailed++;
				if (storeFailed <= 3) log(`  FAIL: ${cs.did.slice(0, 30)}... code=${result.code} ${result.log}`);
			}
		}

		if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= stores.length) {
			log(`  Progress: ${Math.min(i + BATCH_SIZE, stores.length)}/${stores.length} (stored=${stored} failed=${storeFailed})`);
		}

		if (!DRY_RUN) await new Promise((r) => setTimeout(r, 500));
	}

	log(`Phase 2 complete: ${stored} stored, ${storeFailed} failed`);
	log("");

	// Verification
	log("=== VERIFICATION ===");
	const afterCount = await queryAgentCount();
	log(`Agents on-chain after: ${afterCount}`);

	// Spot check 3 random agents
	const sample = [agents[0], agents[Math.floor(agents.length / 2)], agents[agents.length - 1]].filter(Boolean);
	for (const a of sample) {
		if (!a) continue;
		const resp = await fetch(RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "v", method: "abci_query", params: { path: `/agent/${a.did}` } }),
			signal: AbortSignal.timeout(5000),
		});
		const r = await resp.json() as { result?: { response?: { value?: string } } };
		const v = r.result?.response?.value;
		if (v) {
			const data = JSON.parse(Buffer.from(v, "base64").toString("utf-8")) as { registered?: boolean; publicKey?: string };
			log(`  ${a.did.slice(0, 35)}... registered=${data.registered} key=${data.publicKey?.slice(0, 16) ?? "null"}...`);
		}
	}

	log("");
	log("=== SUMMARY ===");
	log(`Agents: ${registered} registered on-chain (${regSkipped} already existed, ${regFailed} failed)`);
	log(`Consciousness: ${stored} stored on-chain (${storeFailed} failed)`);
	log(`On-chain total: ${afterCount} agents`);
}

main().catch((err) => {
	log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
