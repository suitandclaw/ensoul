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

	// Compute new app hash
	state.height = height;
	const appHash = computeAppHash(state);
	state.appHash = appHash;

	if (validTxCount > 0 || height % 100 === 0) {
		log(`FinalizeBlock: height=${height} txs=${validTxCount}/${rawTxs.length} hash=${appHash.toString("hex").slice(0, 16)}...`);
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
// Helpers
// ======================================================================

/** Compute deterministic app hash from account state. */
function computeAppHash(state: EnsoulState): Buffer {
	const stateRoot = state.working.computeStateRoot(
		state.delegations.computeRoot(),
	);
	return Buffer.from(blake3(ENC.encode(stateRoot)));
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
