/**
 * ABCI 2.0 Application -- Ensoul chain logic.
 *
 * Wires the existing @ensoul/ledger state machine to CometBFT's ABCI
 * protocol. CometBFT handles consensus, P2P, and block storage. This
 * module handles: genesis initialization, transaction validation and
 * execution, block reward emission, state persistence, and queries.
 */

import type protobuf from "protobufjs";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
	AccountState,
	validateTransaction,
	applyTransaction,
	computeBlockReward,
	DelegationRegistry,
} from "@ensoul/ledger";
import type { GenesisConfig, GenesisAllocation, Transaction, TransactionType } from "@ensoul/ledger";
import { createHash } from "node:crypto";

// -- Constants --

const REWARDS_POOL = "did:ensoul:protocol:rewards";
const HALVING_INTERVAL = 5_256_000; // ~1 year at 6s blocks
const DECIMALS = 10n ** 18n;
const ENC = new TextEncoder();

// -- DID to Ed25519 pubkey extraction --

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcDecode(str: string): Uint8Array {
	let num = 0n;
	for (const char of str) {
		const idx = B58_ALPHABET.indexOf(char);
		if (idx < 0) throw new Error(`Invalid base58 char: ${char}`);
		num = num * 58n + BigInt(idx);
	}
	const bytes: number[] = [];
	while (num > 0n) {
		bytes.unshift(Number(num % 256n));
		num /= 256n;
	}
	for (const char of str) {
		if (char !== "1") break;
		bytes.unshift(0);
	}
	return new Uint8Array(bytes);
}

/**
 * Extract the raw 32-byte Ed25519 public key from a did:key DID.
 * Returns null for non-did:key DIDs (protocol accounts).
 */
function pubkeyFromDid(did: string): Uint8Array | null {
	if (!did.startsWith("did:key:z")) return null;
	const decoded = base58btcDecode(did.slice("did:key:z".length));
	if (decoded.length < 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return null;
	return decoded.subarray(2, 34);
}

function log(msg: string): void {
	const ts = new Date().toISOString().slice(11, 19);
	process.stdout.write(`[${ts}] [abci] ${msg}\n`);
}

// -- Transaction encoding --

/** Encode an Ensoul transaction to bytes for CometBFT mempool. */
export function encodeTx(tx: Transaction): Buffer {
	return Buffer.from(JSON.stringify({
		type: tx.type,
		from: tx.from,
		to: tx.to,
		amount: tx.amount.toString(),
		nonce: tx.nonce,
		timestamp: tx.timestamp,
		signature: Array.from(tx.signature),
		data: tx.data ? Array.from(tx.data) : undefined,
	}));
}

/** Decode an Ensoul transaction from CometBFT bytes. */
export function decodeTx(buf: Buffer): Transaction | null {
	try {
		const obj = JSON.parse(buf.toString("utf-8")) as Record<string, unknown>;
		return {
			type: obj["type"] as TransactionType,
			from: obj["from"] as string,
			to: obj["to"] as string,
			amount: BigInt(obj["amount"] as string),
			nonce: obj["nonce"] as number,
			timestamp: obj["timestamp"] as number,
			signature: new Uint8Array(obj["signature"] as number[]),
			data: obj["data"] ? new Uint8Array(obj["data"] as number[]) : undefined,
		};
	} catch {
		return null;
	}
}

// -- Upgrade Plan --

interface UpgradePlan {
	name: string;
	height: number;
	info: string; // JSON: {"binaries":{"darwin/arm64":"url","linux/amd64":"url"}}
}

interface CompletedUpgrade {
	name: string;
	height: number;
	completedAt: number; // timestamp ms
}

// Pioneer key DID (governance authority for upgrade proposals)
const PIONEER_KEY = "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X";

// -- Application State --

interface EnsoulState {
	/** Committed state (after last Commit). */
	committed: AccountState;
	/** Working state (being built during FinalizeBlock). */
	working: AccountState;
	/** CheckTx state (copy of committed, for mempool validation). */
	checkTx: AccountState;
	/** Delegation registry. */
	delegations: DelegationRegistry;
	/** Genesis config (loaded during InitChain). */
	genesis: GenesisConfig | null;
	/** Total emission already paid out. */
	totalEmitted: bigint;
	/** Last committed height. */
	height: number;
	/** Last committed app hash. */
	appHash: Buffer;
	/** Data directory for persistence. */
	dataDir: string;
	/** Active upgrade plan (null if none scheduled). */
	upgradePlan: UpgradePlan | null;
	/** History of completed upgrades. */
	upgradeHistory: CompletedUpgrade[];
}

// -- Application Factory --

export function createApplication(dataDir = "/tmp/ensoul-abci"): {
	handler: (request: protobuf.Message, field: string) => Promise<Record<string, unknown>>;
	state: EnsoulState;
} {
	const state: EnsoulState = {
		committed: new AccountState(),
		working: new AccountState(),
		checkTx: new AccountState(),
		delegations: new DelegationRegistry(),
		genesis: null,
		totalEmitted: 0n,
		height: 0,
		appHash: Buffer.alloc(32),
		dataDir,
		upgradePlan: null,
		upgradeHistory: [],
	};

	async function handler(
		request: protobuf.Message,
		field: string,
	): Promise<Record<string, unknown>> {
		switch (field) {
			case "echo": {
				const req = request as unknown as { echo?: { message?: string } };
				return { echo: { message: req.echo?.message ?? "" } };
			}
			case "flush":
				return { flush: {} };
			case "info":
				return await handleInfo(state);
			case "initChain":
				return await handleInitChain(request, state);
			case "checkTx":
				return handleCheckTx(request, state);
			case "query":
				return handleQuery(request, state);
			case "commit":
				return await handleCommit(state);
			case "listSnapshots":
				return { listSnapshots: {} };
			case "offerSnapshot":
				return { offerSnapshot: { result: 0 } };
			case "loadSnapshotChunk":
				return { loadSnapshotChunk: { chunk: Buffer.alloc(0) } };
			case "applySnapshotChunk":
				return { applySnapshotChunk: { result: 0 } };
			case "prepareProposal":
				return handlePrepareProposal(request);
			case "processProposal":
				return { processProposal: { status: 1 } }; // ACCEPT
			case "finalizeBlock":
				return handleFinalizeBlock(request, state);
			case "extendVote":
				return { extendVote: { voteExtension: Buffer.alloc(0) } };
			case "verifyVoteExtension":
				return { verifyVoteExtension: { status: 1 } }; // ACCEPT
			default:
				log(`Unknown ABCI method: ${field}`);
				return { exception: { error: `Unknown method: ${field}` } };
		}
	}

	return { handler, state };
}

// ======================================================================
// 1. Info
// ======================================================================

async function handleInfo(state: EnsoulState): Promise<Record<string, unknown>> {
	// Load persisted state on first Info call (CometBFT calls this at startup)
	if (state.height === 0) {
		await loadPersistedState(state);
	}

	log(`Info: height=${state.height}`);

	return {
		info: {
			data: "ensoul",
			version: "0.1.0",
			appVersion: 1,
			lastBlockHeight: state.height,
			lastBlockAppHash: state.appHash,
		},
	};
}

// ======================================================================
// 2. InitChain -- process genesis allocations
// ======================================================================

async function handleInitChain(
	request: protobuf.Message,
	state: EnsoulState,
): Promise<Record<string, unknown>> {
	const req = request as unknown as {
		initChain?: {
			chainId?: string;
			validators?: Array<{ pubKey?: { ed25519?: Buffer }; power?: number }>;
			appStateBytes?: Buffer;
		};
	};

	const chainId = req.initChain?.chainId ?? "ensoul-1";
	const appStateBytes = req.initChain?.appStateBytes;

	log(`InitChain: chainId=${chainId}`);

	// Parse app_state from genesis.json
	if (appStateBytes && appStateBytes.length > 0) {
		try {
			const raw = JSON.parse(appStateBytes.toString("utf-8")) as Record<string, unknown>;
			const genesis = parseGenesisFromAppState(raw);
			state.genesis = genesis;

			// Process genesis allocations
			const accountState = new AccountState();
			const delegationRegistry = new DelegationRegistry();

			// First pass: credit all accounts and stake autoStake validators
			for (const alloc of genesis.allocations) {
				accountState.credit(alloc.recipient, alloc.tokens);
				if (alloc.autoStake) {
					accountState.stake(alloc.recipient, alloc.tokens);
					accountState.joinConsensus(alloc.recipient);
				}
			}

			// Second pass: auto-delegate non-autoStake foundation validators
			// to their machine's operator (the autoStake validator on that machine).
			// Machine assignment: V0-V4 -> V0, V5-V14 -> V5, V15-V24 -> V15, V25-V34 -> V25
			const foundationValidators = genesis.allocations.filter(
				(a) => a.label === "Foundation Validator",
			);
			const operators = foundationValidators.filter((a) => a.autoStake);

			for (let i = 0; i < foundationValidators.length; i++) {
				const v = foundationValidators[i]!;
				if (v.autoStake) continue; // Operators stake directly, not delegate

				// Find this validator's operator based on index ranges
				let operator: GenesisAllocation | undefined;
				if (i < 5) operator = operators.find((o) => o.recipient === foundationValidators[0]!.recipient);
				else if (i < 15) operator = operators.find((o) => o.recipient === foundationValidators[5]!.recipient);
				else if (i < 25) operator = operators.find((o) => o.recipient === foundationValidators[15]!.recipient);
				else operator = operators.find((o) => o.recipient === foundationValidators[25]!.recipient);

				if (operator && v.tokens > 0n) {
					// Delegate: deduct from balance, track in registry
					accountState.delegateTokens(v.recipient, v.tokens);
					delegationRegistry.delegate(v.recipient, operator.recipient, v.tokens);
				}
			}

			state.delegations = delegationRegistry;
			state.committed = accountState;
			state.working = accountState.clone();
			state.checkTx = accountState.clone();

			const root = computeAppHash(state);
			state.appHash = root;

			const validators = genesis.allocations.filter((a) => a.autoStake);
			log(`  Allocations: ${genesis.allocations.length}`);
			log(`  Validators: ${validators.length}`);
			log(`  App hash: ${root.toString("hex").slice(0, 16)}...`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`  Failed to parse app_state: ${msg}`);
		}
	}

	return {
		initChain: {
			appHash: state.appHash,
		},
	};
}

function parseGenesisFromAppState(raw: Record<string, unknown>): GenesisConfig {
	const allocations = (raw["allocations"] as Array<Record<string, unknown>> ?? []).map(
		(a): GenesisAllocation => ({
			label: (a["label"] as string) ?? "",
			percentage: (a["percentage"] as number) ?? 0,
			tokens: BigInt((a["tokens"] as string) ?? "0"),
			recipient: (a["recipient"] as string) ?? "",
			autoStake: (a["autoStake"] as boolean) ?? false,
		}),
	);

	return {
		chainId: (raw["chainId"] as string) ?? "ensoul-1",
		timestamp: (raw["timestamp"] as number) ?? Date.now(),
		totalSupply: BigInt((raw["totalSupply"] as string) ?? "1000000000000000000000000000"),
		allocations,
		emissionPerBlock: BigInt((raw["emissionPerBlock"] as string) ?? "19025875190258751"),
		networkRewardsPool: BigInt((raw["networkRewardsPool"] as string) ?? "500000000000000000000000000"),
		protocolFees: {
			storageFeeProtocolShare: ((raw["protocolFees"] as Record<string, unknown>)?.["storageFeeProtocolShare"] as number) ?? 10,
			txBaseFee: BigInt(((raw["protocolFees"] as Record<string, unknown>)?.["txBaseFee"] as string) ?? "1000"),
		},
	};
}

// ======================================================================
// 3. CheckTx -- validate transaction for mempool admission
// ======================================================================

function handleCheckTx(
	request: protobuf.Message,
	state: EnsoulState,
): Record<string, unknown> {
	const req = request as unknown as {
		checkTx?: { tx?: Buffer; type?: number };
	};
	const txBytes = req.checkTx?.tx;
	if (!txBytes || txBytes.length === 0) {
		return { checkTx: { code: 1, log: "empty transaction" } };
	}

	const tx = decodeTx(txBytes as Buffer);
	if (!tx) {
		return { checkTx: { code: 2, log: "failed to decode transaction" } };
	}

	// Handle upgrade transactions (governance, not standard ledger txs)
	if (tx.type === "software_upgrade" as TransactionType) {
		return validateUpgradeTx(tx, state);
	}
	if (tx.type === "cancel_upgrade" as TransactionType) {
		return validateCancelUpgradeTx(tx, state);
	}

	// Validate against CheckTx state (copy of last committed state)
	const result = validateTransaction(tx, state.checkTx);
	if (!result.valid) {
		log(`CheckTx REJECT: ${tx.type} from ${tx.from.slice(0, 20)}... -- ${result.error}`);
		return {
			checkTx: {
				code: 3,
				log: result.error ?? "validation failed",
			},
		};
	}

	return {
		checkTx: {
			code: 0,
			log: "ok",
			sender: tx.from,
			priority: 1,
		},
	};
}

// ======================================================================
// 4. PrepareProposal -- order transactions for block
// ======================================================================

function handlePrepareProposal(request: protobuf.Message): Record<string, unknown> {
	const req = request as unknown as {
		prepareProposal?: { txs?: Buffer[]; maxTxBytes?: number };
	};
	const txs = req.prepareProposal?.txs ?? [];

	// Pass through transactions for now.
	// Future: enforce per-identity limits, add block_reward tx.
	return { prepareProposal: { txs } };
}

// ======================================================================
// 5. FinalizeBlock -- execute transactions and compute emission
// ======================================================================

function handleFinalizeBlock(
	request: protobuf.Message,
	state: EnsoulState,
): Record<string, unknown> {
	const req = request as unknown as {
		finalizeBlock?: {
			txs?: Buffer[];
			height?: number | string;
			time?: { seconds?: number | string; nanos?: number };
			proposerAddress?: Buffer;
		};
	};

	const rawTxs = req.finalizeBlock?.txs ?? [];
	const height = Number(req.finalizeBlock?.height ?? state.height + 1);

	// Clone committed state to build working state
	state.working = state.committed.clone();

	// Execute each transaction
	const txResults: Array<{ code: number; log: string }> = [];
	let validTxCount = 0;

	for (const txBytes of rawTxs) {
		const tx = decodeTx(txBytes as Buffer);
		if (!tx) {
			txResults.push({ code: 1, log: "decode failed" });
			continue;
		}

		// Handle upgrade transactions (governance, not standard ledger txs)
		if (tx.type === "software_upgrade" as TransactionType) {
			if (tx.from !== PIONEER_KEY) {
				txResults.push({ code: 10, log: "unauthorized" });
				continue;
			}
			if (executeUpgradeTx(tx, state)) {
				validTxCount++;
				txResults.push({ code: 0, log: "upgrade scheduled" });
			} else {
				txResults.push({ code: 11, log: "invalid upgrade plan" });
			}
			continue;
		}

		if (tx.type === "cancel_upgrade" as TransactionType) {
			if (tx.from !== PIONEER_KEY) {
				txResults.push({ code: 10, log: "unauthorized" });
				continue;
			}
			if (executeCancelUpgradeTx(tx, state)) {
				validTxCount++;
				txResults.push({ code: 0, log: "upgrade cancelled" });
			} else {
				txResults.push({ code: 17, log: "no matching upgrade to cancel" });
			}
			continue;
		}

		const validation = validateTransaction(tx, state.working);
		if (!validation.valid) {
			txResults.push({ code: 2, log: validation.error ?? "invalid" });
			continue;
		}

		// Apply the transaction to working state
		applyTransaction(
			tx,
			state.working,
			state.genesis?.protocolFees.storageFeeProtocolShare ?? 10,
		);
		state.working.incrementNonce(tx.from);
		validTxCount++;
		txResults.push({ code: 0, log: "ok" });
	}

	// Compute block emission
	if (state.genesis) {
		const reward = computeBlockReward(
			height,
			state.genesis.emissionPerBlock,
			HALVING_INTERVAL,
			state.genesis.networkRewardsPool,
			state.totalEmitted,
		);

		if (reward > 0n) {
			const poolBalance = state.working.getBalance(REWARDS_POOL);
			if (poolBalance >= reward) {
				state.working.debit(REWARDS_POOL, reward);
				// For now, credit the first validator in the set as proposer.
				// In production, map proposerAddress to a DID.
				const consensusSet = state.working.getConsensusSet();
				const proposerDid = consensusSet.length > 0
					? consensusSet[0]!
					: state.genesis.allocations.find((a) => a.autoStake)?.recipient ?? REWARDS_POOL;
				state.working.credit(proposerDid, reward);
				state.totalEmitted += reward;
			}
		}
	}

	// Emit CometBFT validator updates for consensus_join/leave transactions.
	// CometBFT applies these at height H+2.
	const validatorUpdates: Array<{ pubKey: { ed25519: Buffer }; power: string }> = [];

	for (const txBytes of rawTxs) {
		const tx = decodeTx(txBytes as Buffer);
		if (!tx) continue;
		if (tx.type !== "consensus_join" && tx.type !== "consensus_leave") continue;

		const pubkey = pubkeyFromDid(tx.from);
		if (!pubkey) continue;

		if (tx.type === "consensus_join") {
			const acct = state.working.getAccount(tx.from);
			const power = acct.stakedBalance / DECIMALS;
			validatorUpdates.push({
				pubKey: { ed25519: Buffer.from(pubkey) },
				power: power.toString(),
			});
			log(`Validator update: ADD ${tx.from.slice(0, 30)}... power=${power}`);
		} else {
			// Power 0 removes the validator
			validatorUpdates.push({
				pubKey: { ed25519: Buffer.from(pubkey) },
				power: "0",
			});
			log(`Validator update: REMOVE ${tx.from.slice(0, 30)}...`);
		}
	}

	// Compute new app hash (include upgrade plan in the hash for determinism)
	state.height = height;
	const appHash = computeAppHash(state);
	state.appHash = appHash;

	if (validTxCount > 0 || height % 100 === 0) {
		log(`FinalizeBlock: height=${height} txs=${validTxCount}/${rawTxs.length} hash=${appHash.toString("hex").slice(0, 16)}...`);
	}

	// Check if this block triggers an upgrade halt.
	// This runs AFTER all transactions are executed and state is finalized.
	// The halt happens asynchronously after Commit completes.
	if (state.upgradePlan && state.height >= state.upgradePlan.height) {
		log(`UPGRADE "${state.upgradePlan.name}" will trigger at Commit`);
	}

	return {
		finalizeBlock: {
			txResults,
			validatorUpdates,
			appHash,
		},
	};
}

// ======================================================================
// 6. Commit -- persist state to disk
// ======================================================================

async function handleCommit(state: EnsoulState): Promise<Record<string, unknown>> {
	// Advance committed state to working state
	state.committed = state.working;
	state.checkTx = state.committed.clone();

	// Persist to disk
	await persistState(state);

	if (state.height % 100 === 0) {
		log(`Commit: height=${state.height} emitted=${(state.totalEmitted / DECIMALS).toString()} ENSL`);
	}

	// After commit is complete and state is persisted, check for upgrade halt.
	// This must happen AFTER the response is sent so CometBFT records the commit.
	// We use setImmediate to let the response flush first.
	if (state.upgradePlan && state.height >= state.upgradePlan.height) {
		setImmediate(() => checkUpgradeHalt(state));
	}

	return {
		commit: {
			retainHeight: 0,
		},
	};
}

// ======================================================================
// 7. Query -- read state
// ======================================================================

function handleQuery(
	request: protobuf.Message,
	state: EnsoulState,
): Record<string, unknown> {
	const req = request as unknown as {
		query?: { path?: string; data?: Buffer; height?: number | string };
	};
	const path = req.query?.path ?? "";
	const data = req.query?.data;

	// Route by path
	const parts = path.split("/").filter(Boolean);
	const route = parts[0] ?? "";
	const param = parts[1] ?? (data ? data.toString("utf-8") : "");

	let value: Record<string, unknown> = {};

	switch (route) {
		case "balance": {
			const account = state.committed.getAccount(param);
			value = {
				did: param,
				balance: account.balance.toString(),
				stakedBalance: account.stakedBalance.toString(),
				delegatedBalance: account.delegatedBalance.toString(),
				pendingRewards: account.pendingRewards.toString(),
				nonce: account.nonce,
				storageCredits: account.storageCredits.toString(),
			};
			break;
		}
		case "validators": {
			const set = state.committed.getConsensusSet();
			value = {
				validators: set.map((did) => {
					const acct = state.committed.getAccount(did);
					const delegatedTo = state.delegations.getTotalDelegatedTo(did);
					const totalPower = acct.stakedBalance + delegatedTo;
					return {
						did,
						stakedBalance: acct.stakedBalance.toString(),
						delegatedToThis: delegatedTo.toString(),
						totalPower: totalPower.toString(),
						power: Number(totalPower / DECIMALS),
					};
				}),
				count: set.length,
			};
			break;
		}
		case "stats": {
			value = {
				height: state.height,
				totalEmitted: state.totalEmitted.toString(),
				totalEmittedEnsl: Number(state.totalEmitted / DECIMALS),
				consensusSetSize: state.committed.getConsensusSet().length,
			};
			break;
		}
		case "agent": {
			const acct = state.committed.getAccount(param);
			value = {
				did: param,
				balance: acct.balance.toString(),
				stakedBalance: acct.stakedBalance.toString(),
				delegatedBalance: acct.delegatedBalance.toString(),
				nonce: acct.nonce,
				lastActivity: acct.lastActivity,
			};
			break;
		}
		case "upgrade": {
			// Sub-routes: /upgrade/current, /upgrade/history, /upgrade/applied/{name}
			const subRoute = parts[1] ?? "";
			if (subRoute === "current") {
				value = { plan: state.upgradePlan };
			} else if (subRoute === "history") {
				value = { upgrades: state.upgradeHistory };
			} else if (subRoute === "applied") {
				const upgradeName = parts[2] ?? "";
				const found = state.upgradeHistory.find((u) => u.name === upgradeName);
				value = { name: upgradeName, applied: !!found, upgrade: found ?? null };
			} else {
				value = { plan: state.upgradePlan, history: state.upgradeHistory };
			}
			break;
		}
		case "delegations": {
			// Show delegations TO this validator
			const delegationsMap = state.delegations.getDelegationsTo(param);
			const delegators: Array<{ did: string; amount: string }> = [];
			for (const [did, amount] of delegationsMap) {
				delegators.push({ did, amount: amount.toString() });
			}
			const totalDelegated = state.delegations.getTotalDelegatedTo(param);
			value = {
				validator: param,
				totalDelegated: totalDelegated.toString(),
				totalDelegatedEnsl: Number(totalDelegated / DECIMALS),
				delegatorCount: delegators.length,
				delegators,
			};
			break;
		}
		default:
			return {
				query: {
					code: 1,
					log: `Unknown query path: ${path}`,
					key: Buffer.alloc(0),
					value: Buffer.alloc(0),
				},
			};
	}

	return {
		query: {
			code: 0,
			log: "ok",
			key: Buffer.from(path),
			value: Buffer.from(JSON.stringify(value)),
		},
	};
}

// ======================================================================
// 8. Software Upgrade System
// ======================================================================

/**
 * Validate a SOFTWARE_UPGRADE transaction.
 * The upgrade plan data is encoded in the tx.data field as JSON:
 *   {"name": "v2.0.0", "height": 1000, "info": "{\"binaries\":{...}}"}
 */
function validateUpgradeTx(tx: Transaction, state: EnsoulState): Record<string, unknown> {
	// Only the pioneer key can submit upgrades
	if (tx.from !== PIONEER_KEY) {
		return { checkTx: { code: 10, log: "Only pioneer key can submit upgrade proposals" } };
	}

	// Decode upgrade plan from tx.data
	const plan = decodeUpgradePlan(tx);
	if (!plan) {
		return { checkTx: { code: 11, log: "Invalid upgrade plan in tx.data (expected JSON with name, height, info)" } };
	}

	if (!plan.name || plan.name.length === 0) {
		return { checkTx: { code: 12, log: "Upgrade name must be non-empty" } };
	}

	if (plan.height <= state.height) {
		return { checkTx: { code: 13, log: `Target height ${plan.height} must be greater than current height ${state.height}` } };
	}

	if (state.upgradePlan !== null) {
		return { checkTx: { code: 14, log: `Upgrade "${state.upgradePlan.name}" already scheduled at height ${state.upgradePlan.height}` } };
	}

	// Check name not previously used
	if (state.upgradeHistory.some((u) => u.name === plan.name)) {
		return { checkTx: { code: 15, log: `Upgrade name "${plan.name}" was already used` } };
	}

	return { checkTx: { code: 0, log: "ok", sender: tx.from, priority: 10 } };
}

/**
 * Validate a CANCEL_UPGRADE transaction.
 */
function validateCancelUpgradeTx(tx: Transaction, state: EnsoulState): Record<string, unknown> {
	if (tx.from !== PIONEER_KEY) {
		return { checkTx: { code: 10, log: "Only pioneer key can cancel upgrades" } };
	}

	if (state.upgradePlan === null) {
		return { checkTx: { code: 16, log: "No upgrade plan to cancel" } };
	}

	// Decode the name from tx.data
	const plan = decodeUpgradePlan(tx);
	if (!plan || plan.name !== state.upgradePlan.name) {
		return { checkTx: { code: 17, log: `Cancel name must match active plan "${state.upgradePlan.name}"` } };
	}

	if (state.height >= state.upgradePlan.height) {
		return { checkTx: { code: 18, log: "Cannot cancel: upgrade height already reached" } };
	}

	return { checkTx: { code: 0, log: "ok", sender: tx.from, priority: 10 } };
}

/**
 * Decode an upgrade plan from a transaction's data field.
 */
function decodeUpgradePlan(tx: Transaction): UpgradePlan | null {
	if (!tx.data || tx.data.length === 0) return null;
	try {
		const json = new TextDecoder().decode(tx.data);
		const obj = JSON.parse(json) as { name?: string; height?: number; info?: string };
		if (!obj.name) return null;
		return {
			name: obj.name,
			height: obj.height ?? 0,
			info: obj.info ?? "{}",
		};
	} catch {
		return null;
	}
}

/**
 * Execute a SOFTWARE_UPGRADE transaction in FinalizeBlock.
 */
function executeUpgradeTx(tx: Transaction, state: EnsoulState): boolean {
	const plan = decodeUpgradePlan(tx);
	if (!plan) return false;

	state.upgradePlan = plan;
	log(`UPGRADE SCHEDULED: "${plan.name}" at height ${plan.height}`);
	return true;
}

/**
 * Execute a CANCEL_UPGRADE transaction in FinalizeBlock.
 */
function executeCancelUpgradeTx(tx: Transaction, state: EnsoulState): boolean {
	const plan = decodeUpgradePlan(tx);
	if (!plan || !state.upgradePlan) return false;

	log(`UPGRADE CANCELLED: "${state.upgradePlan.name}"`);
	state.upgradePlan = null;
	return true;
}

/**
 * Check if the current block height triggers an upgrade halt.
 * Called at the END of FinalizeBlock, after all transactions are executed.
 *
 * Cosmos SDK signals Cosmovisor by panicking with a specific message format:
 *   UPGRADE "<name>" NEEDED at height: <height>: <info>
 *
 * Cosmovisor detects this in the process stderr and:
 * 1. Stops the process
 * 2. Looks for a new binary at cosmovisor/upgrades/<name>/bin/
 * 3. If DAEMON_ALLOW_DOWNLOAD_URLS=true, downloads from URLs in <info>
 * 4. Swaps the binary and restarts
 *
 * Since we're a Node.js process (not Go), we write the message to stderr
 * and exit with code 1. Cosmovisor monitors stderr regardless of language.
 */
function checkUpgradeHalt(state: EnsoulState): void {
	if (!state.upgradePlan) return;
	if (state.height < state.upgradePlan.height) return;

	const plan = state.upgradePlan;

	// Record the upgrade as applied before halting
	state.upgradeHistory.push({
		name: plan.name,
		height: plan.height,
		completedAt: Date.now(),
	});

	// Clear the plan (so after restart we don't halt again)
	state.upgradePlan = null;

	// Persist state before halting (so the restart loads correct state)
	void persistState(state).then(() => {
		// Write the exact Cosmos SDK panic message format to stderr
		// Cosmovisor scans stderr for this pattern
		const msg = `UPGRADE "${plan.name}" NEEDED at height: ${plan.height}: ${plan.info}`;
		process.stderr.write(`\npanic: ${msg}\n\n`);
		log(`UPGRADE HALT: ${msg}`);
		log("Exiting for Cosmovisor binary swap...");

		// Exit with code 1 (Cosmovisor treats non-zero exit as upgrade signal
		// when it finds the UPGRADE NEEDED message in stderr)
		setTimeout(() => process.exit(1), 500);
	});
}

// ======================================================================
// Helpers
// ======================================================================

/** Compute deterministic app hash from account state + upgrade plan. */
function computeAppHash(state: EnsoulState): Buffer {
	const stateRoot = state.working.computeStateRoot(
		state.delegations.computeRoot(),
	);
	// Include upgrade plan in the hash for determinism across nodes
	const upgradeSuffix = state.upgradePlan
		? `:upgrade:${state.upgradePlan.name}:${state.upgradePlan.height}`
		: "";
	return Buffer.from(blake3(ENC.encode(stateRoot + upgradeSuffix)));
}

/** Persist state to disk. */
async function persistState(state: EnsoulState): Promise<void> {
	try {
		await mkdir(state.dataDir, { recursive: true });
		const snapshot = {
			height: state.height,
			appHash: state.appHash.toString("hex"),
			totalEmitted: state.totalEmitted.toString(),
			accounts: serializeAccounts(state.committed),
			consensusSet: state.committed.getConsensusSet(),
			genesis: state.genesis ? {
				emissionPerBlock: state.genesis.emissionPerBlock.toString(),
				networkRewardsPool: state.genesis.networkRewardsPool.toString(),
				storageFeeProtocolShare: state.genesis.protocolFees.storageFeeProtocolShare,
			} : null,
			upgradePlan: state.upgradePlan,
			upgradeHistory: state.upgradeHistory,
		};
		await writeFile(
			join(state.dataDir, "state.json"),
			JSON.stringify(snapshot),
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`Persist failed: ${msg}`);
	}
}

/** Load persisted state from disk. */
async function loadPersistedState(state: EnsoulState): Promise<void> {
	try {
		const raw = await readFile(join(state.dataDir, "state.json"), "utf-8");
		const snapshot = JSON.parse(raw) as {
			height: number;
			appHash: string;
			totalEmitted: string;
			accounts: Array<{ did: string; balance: string; stakedBalance: string; nonce: number; storageCredits: string; delegatedBalance: string; pendingRewards: string; lastActivity: number }>;
			consensusSet: string[];
		};

		const accountState = new AccountState();
		for (const acct of snapshot.accounts) {
			// Set account fields directly to avoid balance check issues
			// (stake() would fail because it requires balance >= amount)
			accountState.setAccount({
				did: acct.did,
				balance: BigInt(acct.balance),
				stakedBalance: BigInt(acct.stakedBalance),
				unstakingBalance: 0n,
				unstakingCompleteAt: 0,
				stakeLockedUntil: 0,
				delegatedBalance: BigInt(acct.delegatedBalance),
				pendingRewards: BigInt(acct.pendingRewards),
				nonce: acct.nonce,
				storageCredits: BigInt(acct.storageCredits),
				lastActivity: acct.lastActivity,
			});
		}
		for (const did of snapshot.consensusSet) {
			accountState.joinConsensus(did);
		}

		state.committed = accountState;
		state.working = accountState.clone();
		state.checkTx = accountState.clone();
		state.height = snapshot.height;
		state.totalEmitted = BigInt(snapshot.totalEmitted);
		state.appHash = Buffer.from(snapshot.appHash, "hex");

		// Restore genesis config for emission calculations
		const gen = (snapshot as Record<string, unknown>)["genesis"] as Record<string, unknown> | null;
		if (gen) {
			state.genesis = {
				chainId: "ensoul-1",
				timestamp: 0,
				totalSupply: 1_000_000_000n * DECIMALS,
				allocations: [],
				emissionPerBlock: BigInt(gen["emissionPerBlock"] as string),
				networkRewardsPool: BigInt(gen["networkRewardsPool"] as string),
				protocolFees: {
					storageFeeProtocolShare: gen["storageFeeProtocolShare"] as number,
					txBaseFee: 1000n,
				},
			};
		}

		// Restore upgrade state
		const snap = snapshot as Record<string, unknown>;
		state.upgradePlan = (snap["upgradePlan"] as UpgradePlan | null) ?? null;
		state.upgradeHistory = (snap["upgradeHistory"] as CompletedUpgrade[] | null) ?? [];

		log(`Loaded persisted state: height=${state.height} emitted=${(state.totalEmitted / DECIMALS).toString()} ENSL`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`No persisted state (${msg}), starting fresh`);
	}
}

/** Serialize all accounts for persistence. */
function serializeAccounts(accountState: AccountState): Array<Record<string, unknown>> {
	const accounts: Array<Record<string, unknown>> = [];
	// Use getAccount for known DIDs. The AccountState doesn't expose iteration,
	// so we track accounts via the consensus set + any touched accounts.
	// For a full implementation, AccountState should expose an iterator.
	// For now, serialize the consensus set members and protocol accounts.
	const knownDids = new Set<string>();
	for (const did of accountState.getConsensusSet()) {
		knownDids.add(did);
	}
	// Add protocol accounts
	knownDids.add(REWARDS_POOL);
	knownDids.add("did:ensoul:protocol:treasury");
	knownDids.add("did:ensoul:protocol:onboarding");
	knownDids.add("did:ensoul:protocol:liquidity");
	knownDids.add("did:ensoul:protocol:contributors");
	knownDids.add("did:ensoul:protocol:insurance");
	knownDids.add("did:ensoul:protocol:burn");

	for (const did of knownDids) {
		const acct = accountState.getAccount(did);
		accounts.push({
			did,
			balance: acct.balance.toString(),
			stakedBalance: acct.stakedBalance.toString(),
			nonce: acct.nonce,
			storageCredits: acct.storageCredits.toString(),
			delegatedBalance: acct.delegatedBalance.toString(),
			pendingRewards: acct.pendingRewards.toString(),
			lastActivity: acct.lastActivity,
		});
	}
	return accounts;
}
