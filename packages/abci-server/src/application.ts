/**
 * ABCI 2.0 Application -- Ensoul chain logic.
 *
 * Wires the existing @ensoul/ledger state machine to CometBFT's ABCI
 * protocol. CometBFT handles consensus, P2P, and block storage. This
 * module handles: genesis initialization, transaction validation and
 * execution, block reward emission, state persistence, and queries.
 */

import type protobuf from "protobufjs";
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
	AccountState,
	validateTransaction,
	applyTransaction,
	computeBlockReward,
	EMISSION_V2_HEIGHT,
	DelegationRegistry,
} from "@ensoul/ledger";
import type { GenesisConfig, GenesisAllocation, Transaction, TransactionType } from "@ensoul/ledger";
import { createHash } from "node:crypto";

// -- Constants --

const REWARDS_POOL = "did:ensoul:protocol:rewards";
const PROTOCOL_TREASURY = "did:ensoul:protocol:treasury";
const HALVING_INTERVAL = 5_256_000; // ~1 year at 6s blocks
const DECIMALS = 10n ** 18n;
const ENC = new TextEncoder();

/**
 * Treasury split: percentage of each block's emission credited to the protocol treasury.
 * The remainder goes to the block proposer. Active from EMISSION_V2_HEIGHT onward.
 * Adjustable by governance in a future upgrade.
 */
const TREASURY_SPLIT_PERCENT = 20n; // 20% to treasury, 80% to proposer

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

/** Decode signature from either hex string or number array. */
function decodeSig(raw: unknown): Uint8Array {
	if (typeof raw === "string") {
		// Hex string (from API gateway)
		const bytes = new Uint8Array(raw.length / 2);
		for (let i = 0; i < raw.length; i += 2) {
			bytes[i / 2] = parseInt(raw.slice(i, i + 2), 16);
		}
		return bytes;
	}
	if (Array.isArray(raw)) {
		return new Uint8Array(raw as number[]);
	}
	return new Uint8Array(0);
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
			signature: decodeSig(obj["signature"]),
			data: obj["data"] ? new Uint8Array(obj["data"] as number[]) : undefined,
		};
	} catch {
		return null;
	}
}

// -- Signature Verification --

/** Transaction types that are protocol-generated and skip signature checks. */
const PROTOCOL_TX_TYPES = new Set<string>(["block_reward", "genesis_allocation"]);

/** Maximum size for tx.data payload (1 MB). */
const MAX_TX_DATA_SIZE = 1_048_576;

/** Maximum size for agent metadata (10 KB). */
const MAX_METADATA_SIZE = 10_240;

/**
 * Encode the signable payload of a transaction.
 * MUST match what signers produce. The canonical format is:
 * JSON.stringify({ type, from, to, amount, nonce, timestamp })
 *
 * Note: chainId is intentionally omitted for backward compatibility
 * with all existing signed transactions on-chain.
 */
function signingPayload(tx: Transaction): Uint8Array {
	return ENC.encode(JSON.stringify({
		type: tx.type,
		from: tx.from,
		to: tx.to,
		amount: tx.amount.toString(),
		nonce: tx.nonce,
		timestamp: tx.timestamp,
	}));
}

// Lazy-loaded Ed25519 verify function (loaded once on first use)
let _ed25519Verify: ((sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean) | null = null;

async function loadEd25519(): Promise<(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean> {
	if (_ed25519Verify) return _ed25519Verify;
	const ed = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	(ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
	_ed25519Verify = (sig, msg, pub) => {
		try {
			return ed.verify(sig, msg, pub);
		} catch {
			return false;
		}
	};
	return _ed25519Verify;
}

/**
 * Verify the Ed25519 signature on a transaction.
 * Extracts the public key from the sender's DID.
 * Returns an error string if verification fails, or null if valid.
 */
async function verifySignature(tx: Transaction): Promise<string | null> {
	// Protocol transactions are not user-signed
	if (PROTOCOL_TX_TYPES.has(tx.type)) return null;

	// Extract public key from DID
	const pubkey = pubkeyFromDid(tx.from);
	if (!pubkey) {
		// Protocol accounts (did:ensoul:protocol:*) are not user-signed
		if (tx.from.startsWith("did:ensoul:protocol:")) return null;
		return "Cannot extract public key from sender DID";
	}

	// Validate signature length
	if (!tx.signature || tx.signature.length !== 64) {
		return "Missing or invalid signature (expected 64 bytes)";
	}

	// Verify Ed25519 signature
	const verify = await loadEd25519();
	const payload = signingPayload(tx);
	const valid = verify(tx.signature, payload, pubkey);

	if (!valid) {
		return "Ed25519 signature verification failed";
	}

	return null; // Signature is valid
}

/**
 * Validate a DID format. Must be did:key:z with valid multicodec ed25519 prefix.
 * Returns an error string if invalid, or null if valid.
 */
function validateDid(did: string): string | null {
	if (!did || typeof did !== "string") return "DID is required";
	// Protocol accounts are valid
	if (did.startsWith("did:ensoul:protocol:")) return null;
	// Agent DIDs must be did:key:z format
	if (!did.startsWith("did:key:z")) return "DID must use did:key:z format";
	if (did.length < 20) return "DID too short";
	if (did.length > 200) return "DID too long";
	// Validate that the base58btc decodes to a valid ed25519 multicodec prefix
	const pubkey = pubkeyFromDid(did);
	if (!pubkey) return "DID does not encode a valid ed25519 public key";
	return null;
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

// Nonce fix activation height. Before this height, FinalizeBlock applies a
// double nonce increment (applyTransaction increments once, then FinalizeBlock
// again). At and after this height, only applyTransaction increments.
// Set to 0 to disable (pre-upgrade behavior). Updated when the upgrade deploys.
const NONCE_FIX_HEIGHT = 57000;

// Snapshot configuration
const SNAPSHOT_INTERVAL = 1000;  // Create snapshot every N blocks
const SNAPSHOT_KEEP = 3;         // Keep last N snapshots
const SNAPSHOT_FORMAT = 1;       // Snapshot format version
const SNAPSHOT_CHUNK_SIZE = 1024 * 1024; // 1MB per chunk

// -- On-chain Agent Registry --

interface OnChainAgent {
	did: string;
	publicKey: string;
	registeredAt: number; // block height
	metadata?: string;    // JSON metadata
}

interface OnChainConsciousness {
	did: string;
	stateRoot: string;
	version: number;
	shardCount: number;
	storedAt: number;     // block height
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
	/** Active upgrade plan (null if none scheduled). */
	upgradePlan: UpgradePlan | null;
	/** History of completed upgrades. */
	upgradeHistory: CompletedUpgrade[];
	/** On-chain agent registry (DID -> agent data). */
	agents: Map<string, OnChainAgent>;
	/** On-chain consciousness state (DID -> latest consciousness). */
	consciousness: Map<string, OnChainConsciousness>;
	/** Running count of all successfully processed transactions. */
	totalTransactions: number;
	/** Temporary buffer for accumulating snapshot chunks during state sync. */
	_snapshotBuffer?: Buffer;
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
		agents: new Map(),
		consciousness: new Map(),
		totalTransactions: 0,
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
				return await handleCheckTx(request, state);
			case "query":
				return handleQuery(request, state);
			case "commit":
				return await handleCommit(state);
			case "listSnapshots": {
				log("ListSnapshots called");
				const lsResult = handleListSnapshots(state);
				const lsSnaps = (lsResult["listSnapshots"] as Record<string, unknown>)?.["snapshots"] as unknown[];
				log(`ListSnapshots returning ${lsSnaps?.length ?? 0} snapshots`);
				return lsResult;
			}
			case "offerSnapshot":
				log("OfferSnapshot called");
				return handleOfferSnapshot(request, state);
			case "loadSnapshotChunk":
				log("LoadSnapshotChunk called");
				return handleLoadSnapshotChunk(request, state);
			case "applySnapshotChunk":
				log("ApplySnapshotChunk called");
				return await handleApplySnapshotChunk(request, state);
			case "prepareProposal":
				return handlePrepareProposal(request);
			case "processProposal":
				return { processProposal: { status: 1 } }; // ACCEPT
			case "finalizeBlock":
				return await handleFinalizeBlock(request, state);
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

	// Clean up stale upgrade-info.json if no upgrade plan exists on-chain.
	// This prevents Cosmovisor from halting for an upgrade that was cancelled.
	if (!state.upgradePlan) {
		const daemonHome = process.env["DAEMON_HOME"] ?? join(state.dataDir, "..", "node");
		const upgradeInfoPath = join(daemonHome, "data", "upgrade-info.json");
		try {
			await unlink(upgradeInfoPath);
			log("Removed stale upgrade-info.json (no active upgrade plan)");
		} catch { /* file doesn't exist, which is correct */ }
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

async function handleCheckTx(
	request: protobuf.Message,
	state: EnsoulState,
): Promise<Record<string, unknown>> {
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

	// ── Step 1: DID format validation ────────────────────────────
	const didErr = validateDid(tx.from);
	if (didErr) {
		return { checkTx: { code: 30, log: `Invalid sender DID: ${didErr}` } };
	}

	// ── Step 2: Ed25519 signature verification (FIRST, before any logic) ──
	const sigErr = await verifySignature(tx);
	if (sigErr) {
		log(`CheckTx SIG REJECT: ${tx.type} from ${tx.from.slice(0, 24)}... sig error: ${sigErr}`);
		return { checkTx: { code: 31, log: sigErr } };
	}

	// ── Step 3: Payload size limits ──────────────────────────────
	if (tx.data && tx.data.length > MAX_TX_DATA_SIZE) {
		return { checkTx: { code: 32, log: `Payload too large: ${tx.data.length} bytes (max ${MAX_TX_DATA_SIZE})` } };
	}

	// ── Step 4: Type-specific validation ─────────────────────────

	// Upgrade transactions (governance, restricted to pioneer key)
	if (tx.type === "software_upgrade" as TransactionType) {
		return validateUpgradeTx(tx, state);
	}
	if (tx.type === "cancel_upgrade" as TransactionType) {
		return validateCancelUpgradeTx(tx, state);
	}

	// Agent registration: validate structure and uniqueness
	if (tx.type === "agent_register" as TransactionType) {
		if (state.agents.has(tx.from)) {
			return { checkTx: { code: 21, log: "agent already registered" } };
		}
		// Validate payload structure
		if (tx.data) {
			try {
				const data = JSON.parse(new TextDecoder().decode(tx.data)) as Record<string, unknown>;
				if (!data["publicKey"] || typeof data["publicKey"] !== "string") {
					return { checkTx: { code: 20, log: "agent_register requires publicKey in data" } };
				}
				if (data["metadata"] && typeof data["metadata"] === "string" && (data["metadata"] as string).length > MAX_METADATA_SIZE) {
					return { checkTx: { code: 33, log: `Metadata too large (max ${MAX_METADATA_SIZE} bytes)` } };
				}
			} catch {
				return { checkTx: { code: 34, log: "Invalid JSON in tx.data" } };
			}
		} else {
			return { checkTx: { code: 20, log: "agent_register requires data with publicKey" } };
		}
		// Nonce check for agent registration
		const sender = state.checkTx.getAccount(tx.from);
		if (tx.nonce !== sender.nonce) {
			return { checkTx: { code: 3, log: `Invalid nonce: expected ${sender.nonce}, got ${tx.nonce}` } };
		}
		return { checkTx: { code: 0, log: "ok", sender: tx.from, priority: 1 } };
	}

	// Consciousness store: validate agent exists and payload
	if (tx.type === "consciousness_store" as TransactionType) {
		if (!state.agents.has(tx.from)) {
			return { checkTx: { code: 35, log: "Agent not registered. Register first." } };
		}
		if (tx.data) {
			try {
				const data = JSON.parse(new TextDecoder().decode(tx.data)) as Record<string, unknown>;
				if (!data["stateRoot"] || typeof data["stateRoot"] !== "string") {
					return { checkTx: { code: 22, log: "consciousness_store requires stateRoot in data" } };
				}
			} catch {
				return { checkTx: { code: 34, log: "Invalid JSON in tx.data" } };
			}
		} else {
			return { checkTx: { code: 22, log: "consciousness_store requires data with stateRoot" } };
		}
		// Nonce check for consciousness store
		const sender = state.checkTx.getAccount(tx.from);
		if (tx.nonce !== sender.nonce) {
			return { checkTx: { code: 3, log: `Invalid nonce: expected ${sender.nonce}, got ${tx.nonce}` } };
		}
		return { checkTx: { code: 0, log: "ok", sender: tx.from, priority: 1 } };
	}

	// Standard ledger transactions: validate against CheckTx state
	const result = validateTransaction(tx, state.checkTx);
	if (!result.valid) {
		log(`CheckTx REJECT: ${tx.type} from ${tx.from.slice(0, 20)}... : ${result.error}`);
		return { checkTx: { code: 3, log: result.error ?? "validation failed" } };
	}

	return { checkTx: { code: 0, log: "ok", sender: tx.from, priority: 1 } };
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

async function handleFinalizeBlock(
	request: protobuf.Message,
	state: EnsoulState,
): Promise<Record<string, unknown>> {
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

		// ── Signature verification (Byzantine proposer protection) ────
		// Only enforced from EMISSION_V2_HEIGHT onward for deterministic replay
		if (height >= EMISSION_V2_HEIGHT) {
			const sigErr = await verifySignature(tx);
			if (sigErr) {
				txResults.push({ code: 31, log: sigErr });
				continue;
			}

			// Payload size limit
			if (tx.data && tx.data.length > MAX_TX_DATA_SIZE) {
				txResults.push({ code: 32, log: "payload too large" });
				continue;
			}
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

		// Agent registration
		if (tx.type === "agent_register" as TransactionType) {
			if (height >= EMISSION_V2_HEIGHT) {
				// v2: full validation with nonce tracking
				let agentData: { publicKey?: string; metadata?: string } | null = null;
				try {
					agentData = tx.data ? JSON.parse(new TextDecoder().decode(tx.data)) as { publicKey?: string; metadata?: string } : null;
				} catch {
					txResults.push({ code: 34, log: "Invalid JSON in tx.data" });
					continue;
				}
				if (!agentData?.publicKey) {
					txResults.push({ code: 20, log: "agent_register requires publicKey in data" });
					continue;
				}
				if (agentData.metadata && agentData.metadata.length > MAX_METADATA_SIZE) {
					txResults.push({ code: 33, log: "metadata too large" });
					continue;
				}
				if (state.agents.has(tx.from)) {
					txResults.push({ code: 21, log: "agent already registered" });
					continue;
				}
				state.agents.set(tx.from, {
					did: tx.from,
					publicKey: agentData.publicKey,
					registeredAt: height,
					metadata: agentData.metadata,
				});
				state.working.incrementNonce(tx.from);
			} else {
				// v1: original behavior (no nonce increment, lenient validation)
				const agentData = tx.data ? JSON.parse(new TextDecoder().decode(tx.data)) as {
					publicKey?: string; metadata?: string;
				} : null;
				if (!agentData?.publicKey) {
					txResults.push({ code: 20, log: "agent_register requires publicKey in data" });
					continue;
				}
				if (state.agents.has(tx.from)) {
					txResults.push({ code: 21, log: "agent already registered" });
					continue;
				}
				state.agents.set(tx.from, {
					did: tx.from,
					publicKey: agentData.publicKey,
					registeredAt: height,
					metadata: agentData.metadata,
				});
			}
			validTxCount++;
			txResults.push({ code: 0, log: "agent registered" });
			continue;
		}

		// Consciousness store
		if (tx.type === "consciousness_store" as TransactionType) {
			if (height >= EMISSION_V2_HEIGHT) {
				// v2: full validation with nonce tracking and agent check
				if (!state.agents.has(tx.from)) {
					txResults.push({ code: 35, log: "agent not registered" });
					continue;
				}
				let csData: { stateRoot?: string; version?: number; shardCount?: number } | null = null;
				try {
					csData = tx.data ? JSON.parse(new TextDecoder().decode(tx.data)) as { stateRoot?: string; version?: number; shardCount?: number } : null;
				} catch {
					txResults.push({ code: 34, log: "Invalid JSON in tx.data" });
					continue;
				}
				if (!csData?.stateRoot) {
					txResults.push({ code: 22, log: "consciousness_store requires stateRoot in data" });
					continue;
				}
				state.consciousness.set(tx.from, {
					did: tx.from,
					stateRoot: csData.stateRoot,
					version: csData.version ?? 1,
					shardCount: csData.shardCount ?? 0,
					storedAt: height,
				});
				state.working.incrementNonce(tx.from);
			} else {
				// v1: original behavior (no nonce increment, no agent check)
				const csData = tx.data ? JSON.parse(new TextDecoder().decode(tx.data)) as {
					stateRoot?: string; version?: number; shardCount?: number;
				} : null;
				if (!csData?.stateRoot) {
					txResults.push({ code: 22, log: "consciousness_store requires stateRoot in data" });
					continue;
				}
				state.consciousness.set(tx.from, {
					did: tx.from,
					stateRoot: csData.stateRoot,
					version: csData.version ?? 1,
					shardCount: csData.shardCount ?? 0,
					storedAt: height,
				});
			}
			validTxCount++;
			txResults.push({ code: 0, log: "consciousness stored" });
			continue;
		}

		const validation = validateTransaction(tx, state.working);
		if (!validation.valid) {
			txResults.push({ code: 2, log: validation.error ?? "invalid" });
			continue;
		}

		// Apply the transaction to working state.
		// applyTransaction calls incrementNonce once for non-protocol txs.
		applyTransaction(
			tx,
			state.working,
			state.genesis?.protocolFees.storageFeeProtocolShare ?? 10,
		);
		// Before the nonce fix upgrade, a second increment was applied here.
		// This preserves backward compatibility for blocks before the fix.
		if (height < NONCE_FIX_HEIGHT) {
			state.working.incrementNonce(tx.from);
		}
		validTxCount++;
		txResults.push({ code: 0, log: "ok" });
	}

	// Compute block emission (v1 or v2 depending on height)
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
			const consensusSet = state.working.getConsensusSet();
			const proposerDid = consensusSet.length > 0
				? consensusSet[0]!
				: state.genesis.allocations.find((a) => a.autoStake)?.recipient ?? REWARDS_POOL;

			// Determine the actual emission amount (may be limited by pool balance)
			let emitted = 0n;
			if (poolBalance >= reward) {
				state.working.debit(REWARDS_POOL, reward);
				emitted = reward;
			} else if (poolBalance > 0n) {
				state.working.debit(REWARDS_POOL, poolBalance);
				emitted = poolBalance;
			} else {
				// Pool depleted: tail emission as new issuance (no pool debit)
				emitted = reward;
			}

			// Distribute the emitted reward
			if (height >= EMISSION_V2_HEIGHT) {
				// v2: split between proposer (80%) and protocol treasury (20%)
				const treasuryCut = (emitted * TREASURY_SPLIT_PERCENT) / 100n;
				const proposerCut = emitted - treasuryCut;
				state.working.credit(proposerDid, proposerCut);
				state.working.credit(PROTOCOL_TREASURY, treasuryCut);
			} else {
				// v1: 100% to proposer (preserve deterministic replay)
				state.working.credit(proposerDid, emitted);
			}

			state.totalEmitted += emitted;
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

	// Update running transaction counter
	state.totalTransactions += validTxCount;

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

	// Persist to disk, then verify the persisted state is loadable and produces
	// the same app_hash (catches serialization bugs before they cause replay panics)
	await persistState(state);

	// Verify persistence integrity every 500 blocks
	if (state.height % 500 === 0) {
		try {
			const raw = await readFile(join(state.dataDir, "state.json"), "utf-8");
			const saved = JSON.parse(raw) as { appHash: string; height: number; delegations?: unknown[] };
			if (saved.appHash !== state.appHash.toString("hex")) {
				log(`CRITICAL: Persisted app_hash MISMATCH at h=${state.height}! saved=${saved.appHash.slice(0,16)}... computed=${state.appHash.toString("hex").slice(0,16)}...`);
			}
			if (saved.height !== state.height) {
				log(`CRITICAL: Persisted height MISMATCH! saved=${saved.height} expected=${state.height}`);
			}
		} catch { /* verification is best-effort */ }
	}

	// Create snapshot at regular intervals for state sync
	if (state.height > 0 && state.height % SNAPSHOT_INTERVAL === 0) {
		await createSnapshot(state);
	}

	if (state.height % 100 === 0) {
		log(`Commit: height=${state.height} emitted=${(state.totalEmitted / DECIMALS).toString()} ENSL agents=${state.agents.size}`);
	}

	// After commit is complete and state is persisted, check for upgrade halt.
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

	// Route by path, separating query string if present
	const [pathPart, queryPart] = path.split("?", 2);
	const parts = pathPart.split("/").filter(Boolean);
	const route = parts[0] ?? "";
	const param = parts[1] ?? (data ? data.toString("utf-8") : "");
	const queryParams = new URLSearchParams(queryPart ?? "");

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
				agentCount: state.agents.size,
				consciousnessCount: state.consciousness.size,
				totalTransactions: state.totalTransactions,
			};
			break;
		}
		case "agents": {
			// List all registered agents. Paginated via query params.
			const agentPage = Math.max(1, Number(queryParams.get("page") ?? 1));
			const agentLimit = Math.min(500, Math.max(1, Number(queryParams.get("limit") ?? 100)));
			const allAgents = Array.from(state.agents.values());
			const agentStart = (agentPage - 1) * agentLimit;
			const agentSlice = allAgents.slice(agentStart, agentStart + agentLimit);
			value = {
				agents: agentSlice,
				total: allAgents.length,
				page: agentPage,
				pages: Math.ceil(allAgents.length / agentLimit),
			};
			break;
		}
		case "agent": {
			const agent = state.agents.get(param);
			const acct = state.committed.getAccount(param);
			const cs = state.consciousness.get(param);
			value = {
				did: param,
				registered: !!agent,
				publicKey: agent?.publicKey ?? null,
				registeredAt: agent?.registeredAt ?? null,
				metadata: agent?.metadata ?? null,
				consciousnessVersion: cs?.version ?? null,
				consciousnessStateRoot: cs?.stateRoot ?? null,
				consciousnessAge: agent ? state.height - agent.registeredAt : 0,
				balance: acct.balance.toString(),
				stakedBalance: acct.stakedBalance.toString(),
				delegatedBalance: acct.delegatedBalance.toString(),
				nonce: acct.nonce,
			};
			break;
		}
		case "consciousness": {
			const csData = state.consciousness.get(param);
			if (csData) {
				value = {
					did: param,
					stateRoot: csData.stateRoot,
					version: csData.version,
					shardCount: csData.shardCount,
					storedAt: csData.storedAt,
				};
			} else {
				value = { did: param, found: false };
			}
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
		case "accounts": {
			// Paginated account listing. /accounts?page=1&limit=50
			const page = Math.max(1, Number(queryParams.get("page") ?? (param || "1")));
			const limit = Math.min(200, Math.max(1, Number(queryParams.get("limit") ?? 50)));

			// Get all account DIDs
			const allDids = state.committed.getAllAccountDids();
			const consensusSet = new Set(state.committed.getConsensusSet());

			// Build account entries with labels
			const allAccounts = allDids.map((did) => {
				const acct = state.committed.getAccount(did);
				const total = acct.balance + acct.stakedBalance + acct.delegatedBalance;
				const agent = state.agents.get(did);
				const isValidator = consensusSet.has(did);
				const isAgent = !!agent;

				let label = "Account";
				if (did.startsWith("did:ensoul:protocol:")) label = "Protocol";
				else if (isValidator && acct.stakedBalance > 10_000_000n * DECIMALS) label = "Foundation Validator";
				else if (isValidator) label = "Cloud Validator";
				else if (isAgent) label = "Agent";
				else if (acct.stakedBalance > 0n) label = "Staker";
				else if (acct.delegatedBalance > 0n) label = "Delegator";

				return {
					did,
					balance: acct.balance.toString(),
					stakedBalance: acct.stakedBalance.toString(),
					delegatedBalance: acct.delegatedBalance.toString(),
					total: total.toString(),
					totalEnsl: Number(total / DECIMALS),
					label,
					nonce: acct.nonce,
					lastActivity: acct.lastActivity,
				};
			});

			// Sort by total descending
			allAccounts.sort((a, b) => {
				const diff = BigInt(b.total) - BigInt(a.total);
				return diff > 0n ? 1 : diff < 0n ? -1 : 0;
			});

			const start = (page - 1) * limit;
			const pageAccounts = allAccounts.slice(start, start + limit);

			value = {
				accounts: pageAccounts,
				total: allAccounts.length,
				page,
				limit,
				pages: Math.ceil(allAccounts.length / limit),
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

	// Remove upgrade-info.json to prevent Cosmovisor from halting on restart.
	// Without this, a cancelled upgrade still causes Cosmovisor to look for the
	// upgrade binary and refuse to start if the binary directory doesn't exist.
	const daemonHome = process.env["DAEMON_HOME"] ?? join(state.dataDir, "..", "node");
	const upgradeInfoPath = join(daemonHome, "data", "upgrade-info.json");
	void unlink(upgradeInfoPath).catch(() => { /* file may not exist yet */ });

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

	// Persist state and write upgrade-info.json before halting
	void (async () => {
		await persistState(state);

		// Write upgrade-info.json (Cosmovisor reads this from DAEMON_HOME/data/)
		const daemonHome = process.env["DAEMON_HOME"] ?? join(state.dataDir, "..", "node");
		try {
			await writeFile(
				join(daemonHome, "data", "upgrade-info.json"),
				JSON.stringify({ name: plan.name, height: plan.height, info: plan.info }),
			);
		} catch { /* data dir may not exist */ }

		// Write the exact Cosmos SDK panic message format to stderr
		// Cosmovisor scans stderr for this pattern
		const msg = `UPGRADE "${plan.name}" NEEDED at height: ${plan.height}: ${plan.info}`;
		process.stderr.write(`\npanic: ${msg}\n\n`);
		log(`UPGRADE HALT: ${msg}`);
		log("Exiting for Cosmovisor binary swap...");

		// Exit with code 2 (matches Go's panic exit code, which Cosmovisor
		// expects along with the UPGRADE NEEDED message in stderr)
		setTimeout(() => process.exit(2), 500);
	})();
}

// ======================================================================
// 9. State Sync Snapshots
// ======================================================================

/**
 * Serialize the full application state into a snapshot buffer.
 * This is the complete state that a syncing node needs to reconstruct
 * the application at a given height without replaying blocks.
 */
function serializeFullState(state: EnsoulState): Buffer {
	const snapshot = {
		height: state.height,
		appHash: state.appHash.toString("hex"),
		totalEmitted: state.totalEmitted.toString(),
		accounts: serializeAccounts(state.committed),
		consensusSet: state.committed.getConsensusSet(),
		agents: Array.from(state.agents.values()),
		consciousness: Array.from(state.consciousness.values()),
		upgradePlan: state.upgradePlan,
		upgradeHistory: state.upgradeHistory,
		delegations: state.delegations.serialize(),
		totalTransactions: state.totalTransactions,
		genesis: state.genesis ? {
			emissionPerBlock: state.genesis.emissionPerBlock.toString(),
			networkRewardsPool: state.genesis.networkRewardsPool.toString(),
			storageFeeProtocolShare: state.genesis.protocolFees.storageFeeProtocolShare,
		} : null,
	};
	return Buffer.from(JSON.stringify(snapshot));
}

/**
 * Create a snapshot at the current height and save to disk.
 * Keeps only the most recent SNAPSHOT_KEEP snapshots.
 */
async function createSnapshot(state: EnsoulState): Promise<void> {
	const snapDir = join(state.dataDir, "snapshots");
	await mkdir(snapDir, { recursive: true });

	const data = serializeFullState(state);
	const hash = blake3(data);
	const chunks = Math.ceil(data.length / SNAPSHOT_CHUNK_SIZE);

	// Write snapshot metadata
	const meta = {
		height: state.height,
		format: SNAPSHOT_FORMAT,
		chunks,
		hash: bytesToHex(hash),
		size: data.length,
		createdAt: Date.now(),
	};

	const snapPath = join(snapDir, `snapshot-${state.height}`);
	await mkdir(snapPath, { recursive: true });
	await writeFile(join(snapPath, "meta.json"), JSON.stringify(meta, null, 2));
	await writeFile(join(snapPath, "data.bin"), data);

	log(`Snapshot created: height=${state.height} size=${data.length} chunks=${chunks}`);

	// Clean old snapshots
	try {
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(snapDir);
		const snapshots = entries
			.filter((e) => e.startsWith("snapshot-"))
			.map((e) => ({ name: e, height: Number(e.split("-")[1]) }))
			.sort((a, b) => b.height - a.height);

		for (const old of snapshots.slice(SNAPSHOT_KEEP)) {
			const { rm } = await import("node:fs/promises");
			await rm(join(snapDir, old.name), { recursive: true });
		}
	} catch { /* cleanup is best-effort */ }
}

/**
 * List available snapshots for state sync.
 */
function handleListSnapshots(state: EnsoulState): Record<string, unknown> {
	const snapDir = join(state.dataDir, "snapshots");
	const snapshots: Array<Record<string, unknown>> = [];

	try {
		const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
		const entries = readdirSync(snapDir);

		for (const entry of entries) {
			if (!entry.startsWith("snapshot-")) continue;
			try {
				const meta = JSON.parse(
					readFileSync(join(snapDir, entry, "meta.json"), "utf-8"),
				) as { height: number; format: number; chunks: number; hash: string };
				snapshots.push({
					height: meta.height,
					format: meta.format,
					chunks: meta.chunks,
					hash: Buffer.from(meta.hash, "hex"),
				});
			} catch { /* skip corrupt snapshots */ }
		}
	} catch { /* no snapshots dir */ }

	return { listSnapshots: { snapshots } };
}

/**
 * Accept or reject a snapshot offer during state sync.
 */
function handleOfferSnapshot(
	request: protobuf.Message,
	_state: EnsoulState,
): Record<string, unknown> {
	const req = request as unknown as {
		offerSnapshot?: {
			snapshot?: { height?: number; format?: number; chunks?: number; hash?: Buffer };
			appHash?: Buffer;
		};
	};

	const snap = req.offerSnapshot?.snapshot;
	if (!snap) return { offerSnapshot: { result: 2 } }; // REJECT

	// Accept if format matches
	if (snap.format === SNAPSHOT_FORMAT) {
		log(`OfferSnapshot: accepting height=${snap.height} chunks=${snap.chunks}`);
		return { offerSnapshot: { result: 1 } }; // ACCEPT
	}

	return { offerSnapshot: { result: 2 } }; // REJECT
}

/**
 * Serve a snapshot chunk to a syncing node.
 */
function handleLoadSnapshotChunk(
	request: protobuf.Message,
	state: EnsoulState,
): Record<string, unknown> {
	const req = request as unknown as {
		loadSnapshotChunk?: { height?: number; format?: number; chunk?: number };
	};

	const height = req.loadSnapshotChunk?.height ?? 0;
	const chunkIdx = req.loadSnapshotChunk?.chunk ?? 0;

	const snapPath = join(state.dataDir, "snapshots", `snapshot-${height}`, "data.bin");

	try {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const data = readFileSync(snapPath);
		const start = chunkIdx * SNAPSHOT_CHUNK_SIZE;
		const end = Math.min(start + SNAPSHOT_CHUNK_SIZE, data.length);
		const chunk = data.subarray(start, end);

		return { loadSnapshotChunk: { chunk: Buffer.from(chunk) } };
	} catch {
		return { loadSnapshotChunk: { chunk: Buffer.alloc(0) } };
	}
}

/**
 * Apply a received snapshot chunk during state sync.
 * Reconstructs the full application state from the snapshot data.
 */
async function handleApplySnapshotChunk(
	request: protobuf.Message,
	state: EnsoulState,
): Promise<Record<string, unknown>> {
	const req = request as unknown as {
		applySnapshotChunk?: { index?: number; chunk?: Buffer; sender?: string };
	};

	const chunk = req.applySnapshotChunk?.chunk;
	const index = req.applySnapshotChunk?.index ?? 0;

	if (!chunk || chunk.length === 0) {
		return { applySnapshotChunk: { result: 2 } }; // REJECT
	}

	// Accumulate chunks in a temporary buffer
	if (!state._snapshotBuffer) {
		state._snapshotBuffer = Buffer.alloc(0);
	}
	state._snapshotBuffer = Buffer.concat([state._snapshotBuffer, chunk]);

	// If this might be the last chunk, try to parse the full snapshot
	try {
		const fullData = state._snapshotBuffer!;
		const snapshot = JSON.parse(fullData.toString("utf-8")) as {
			height: number;
			appHash: string;
			totalEmitted: string;
			accounts: Array<{ did: string; balance: string; stakedBalance: string; nonce: number; storageCredits: string; delegatedBalance: string; pendingRewards: string; lastActivity: number }>;
			consensusSet: string[];
			agents: OnChainAgent[];
			consciousness: OnChainConsciousness[];
			upgradePlan: UpgradePlan | null;
			upgradeHistory: CompletedUpgrade[];
			delegations: Array<{ validator: string; delegator: string; amount: string }>;
			genesis: { emissionPerBlock: string; networkRewardsPool: string; storageFeeProtocolShare: number } | null;
		};

		// Rebuild state from snapshot
		const accountState = new AccountState();
		for (const acct of snapshot.accounts) {
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
		state.agents = new Map(snapshot.agents.map((a) => [a.did, a]));
		state.consciousness = new Map(snapshot.consciousness.map((c) => [c.did, c]));
		state.upgradePlan = snapshot.upgradePlan;
		state.upgradeHistory = snapshot.upgradeHistory ?? [];
		state.totalTransactions = (snapshot as Record<string, unknown>)["totalTransactions"] as number ?? 0;
		if (snapshot.delegations && snapshot.delegations.length > 0) {
			state.delegations = DelegationRegistry.deserialize(snapshot.delegations);
		}

		if (snapshot.genesis) {
			state.genesis = {
				chainId: "ensoul-1",
				timestamp: 0,
				totalSupply: 1_000_000_000n * DECIMALS,
				allocations: [],
				emissionPerBlock: BigInt(snapshot.genesis.emissionPerBlock),
				networkRewardsPool: BigInt(snapshot.genesis.networkRewardsPool),
				protocolFees: {
					storageFeeProtocolShare: snapshot.genesis.storageFeeProtocolShare,
					txBaseFee: 1000n,
				},
			};
		}

		// Persist the restored state
		await persistState(state);

		log(`Snapshot applied: height=${state.height} agents=${state.agents.size} consciousness=${state.consciousness.size}`);

		// Clear the buffer
		state._snapshotBuffer = undefined;

		return { applySnapshotChunk: { result: 1 } }; // ACCEPT
	} catch {
		// Not a complete snapshot yet, keep accumulating
		return { applySnapshotChunk: { result: 1 } }; // ACCEPT (keep sending chunks)
	}
}

// ======================================================================
// Helpers
// ======================================================================

/** Compute deterministic app hash from all state. */
function computeAppHash(state: EnsoulState): Buffer {
	const stateRoot = state.working.computeStateRoot(
		state.delegations.computeRoot(),
	);
	// Include all state components for determinism
	const upgradeSuffix = state.upgradePlan
		? `:upgrade:${state.upgradePlan.name}:${state.upgradePlan.height}`
		: "";
	// Include agent and consciousness counts (the full data is too large for the hash,
	// but the count ensures consistency across nodes)
	const agentSuffix = `:agents:${state.agents.size}:cs:${state.consciousness.size}`;
	return Buffer.from(blake3(ENC.encode(stateRoot + upgradeSuffix + agentSuffix)));
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
			agents: Array.from(state.agents.values()),
			consciousness: Array.from(state.consciousness.values()),
			delegations: state.delegations.serialize(),
			totalTransactions: state.totalTransactions,
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

		// Restore agent registry
		const agentList = (snap["agents"] as OnChainAgent[] | null) ?? [];
		state.agents = new Map(agentList.map((a) => [a.did, a]));

		// Restore consciousness state
		const csList = (snap["consciousness"] as OnChainConsciousness[] | null) ?? [];
		state.consciousness = new Map(csList.map((c) => [c.did, c]));

		// Restore delegation registry
		const delegationEntries = (snap["delegations"] as Array<{ validator: string; delegator: string; amount: string }> | null) ?? [];
		if (delegationEntries.length > 0) {
			state.delegations = DelegationRegistry.deserialize(delegationEntries);
		}

		// Restore transaction counter
		state.totalTransactions = (snap["totalTransactions"] as number | null) ?? 0;

		log(`Loaded persisted state: height=${state.height} emitted=${(state.totalEmitted / DECIMALS).toString()} ENSL agents=${state.agents.size} consciousness=${state.consciousness.size} txs=${state.totalTransactions} delegations=${delegationEntries.length}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`No persisted state (${msg}), starting fresh`);
	}
}

/** Serialize all accounts for persistence. */
function serializeAccounts(accountState: AccountState): Array<Record<string, unknown>> {
	const accounts: Array<Record<string, unknown>> = [];
	// Serialize ALL accounts that have been touched (non-default state).
	// This is critical for deterministic replay: missing accounts cause
	// computeStateRoot to produce different hashes.
	for (const did of accountState.getAllAccountDids()) {
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
