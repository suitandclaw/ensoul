import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity, hexToBytes } from "@ensoul/identity";
import type { AgentIdentity } from "@ensoul/identity";
import { encodeTxPayload } from "@ensoul/ledger";
import type { AccountState } from "@ensoul/ledger";
import type { Block, Transaction, TransactionType } from "@ensoul/ledger";
import { expandHome } from "./args.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const DECIMALS = 10n ** 18n;
const ENC = new TextEncoder();
const API_URL = process.env["ENSOUL_API_URL"] ?? "https://api.ensoul.dev";

/** Sign a transaction and broadcast via the API. */
async function signAndBroadcast(
	identity: AgentIdentity,
	type: string,
	to: string,
	amount: string,
	nonce: number,
	data?: Record<string, unknown>,
): Promise<{ applied: boolean; height?: number; hash?: string; error?: string }> {
	const ts = Date.now();
	const payload = JSON.stringify({ type, from: identity.did, to, amount, nonce, timestamp: ts });
	const sig = await identity.sign(ENC.encode(payload));
	const tx: Record<string, unknown> = {
		type, from: identity.did, to, amount, nonce, timestamp: ts,
		signature: bytesToHex(sig),
	};
	if (data) tx["data"] = Array.from(ENC.encode(JSON.stringify(data)));

	const resp = await fetch(`${API_URL}/v1/tx/broadcast`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(tx),
		signal: AbortSignal.timeout(30000),
	});
	return (await resp.json()) as { applied: boolean; height?: number; hash?: string; error?: string };
}

/** Parsed wallet command. */
export interface WalletCommand {
	subcommand:
		| "balance"
		| "send"
		| "receive"
		| "history"
		| "stake"
		| "unstake"
		| "delegate"
		| "undelegate"
		| "claim-rewards"
		| "delegations"
		| "none";
	recipientDid: string;
	amount: bigint;
	dataDir: string;
	rpc: string;
}

/** A formatted history entry for display. */
export interface HistoryEntry {
	blockHeight: number;
	type: "sent" | "received" | "staked" | "unstaked" | "reward" | "slashed";
	amount: string;
	counterparty: string;
	timestamp: string;
}

/** Result of a wallet send/stake/unstake operation. */
export interface WalletTxResult {
	txHash: string;
	blockHeight: number;
	type: TransactionType;
	amount: bigint;
}

/**
 * Parse wallet subcommand from argv.
 * Expected: wallet balance | wallet send <did> <amount> | wallet receive | wallet history | wallet stake <amount> | wallet unstake <amount>
 */
export function parseWalletArgs(argv: string[]): WalletCommand {
	const cmd: WalletCommand = {
		subcommand: "none",
		recipientDid: "",
		amount: 0n,
		dataDir: "~/.ensoul",
		rpc: process.env["ENSOUL_API_URL"] ?? "https://api.ensoul.dev",
	};

	let walletFound = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;

		if (arg === "--data-dir" && argv[i + 1]) {
			cmd.dataDir = argv[i + 1]!;
			i++;
			continue;
		}

		if (arg === "--rpc" && argv[i + 1]) {
			cmd.rpc = argv[i + 1]!;
			i++;
			continue;
		}

		if (arg === "wallet") {
			walletFound = true;
			continue;
		}

		if (!walletFound) continue;

		if (arg === "balance") {
			cmd.subcommand = "balance";
		} else if (arg === "send") {
			cmd.subcommand = "send";
			if (argv[i + 1]) cmd.recipientDid = argv[i + 1]!;
			if (argv[i + 2]) cmd.amount = parseEnslAmount(argv[i + 2]!);
			i += 2;
		} else if (arg === "receive") {
			cmd.subcommand = "receive";
		} else if (arg === "history") {
			cmd.subcommand = "history";
		} else if (arg === "stake") {
			cmd.subcommand = "stake";
			if (argv[i + 1]) cmd.amount = parseEnslAmount(argv[i + 1]!);
			i++;
		} else if (arg === "unstake") {
			cmd.subcommand = "unstake";
			if (argv[i + 1]) cmd.amount = parseEnslAmount(argv[i + 1]!);
			i++;
		} else if (arg === "delegate") {
			cmd.subcommand = "delegate";
			if (argv[i + 1]) cmd.recipientDid = argv[i + 1]!;
			if (argv[i + 2]) cmd.amount = parseEnslAmount(argv[i + 2]!);
			i += 2;
		} else if (arg === "undelegate") {
			cmd.subcommand = "undelegate";
			if (argv[i + 1]) cmd.recipientDid = argv[i + 1]!;
			if (argv[i + 2]) cmd.amount = parseEnslAmount(argv[i + 2]!);
			i += 2;
		} else if (arg === "claim-rewards") {
			cmd.subcommand = "claim-rewards";
		} else if (arg === "delegations") {
			cmd.subcommand = "delegations";
		}
	}

	return cmd;
}

/**
 * Parse an $ENSL amount string to wei (bigint).
 * Accepts whole numbers like "500" → 500 * 10^18.
 */
function parseEnslAmount(input: string): bigint {
	const num = Number(input);
	if (Number.isNaN(num) || num < 0) return 0n;
	return BigInt(Math.floor(num)) * DECIMALS;
}

/**
 * Check if argv contains a wallet subcommand.
 */
export function isWalletCommand(argv: string[]): boolean {
	return argv.includes("wallet");
}

/**
 * Validate a DID format (must start with "did:").
 */
export function validateDid(did: string): boolean {
	return did.startsWith("did:") && did.length > 10;
}

/**
 * Shorten a DID for display: first 8 + last 3 chars of the method-specific identifier.
 */
export function shortenDid(did: string): string {
	if (did.length <= 24) return did;
	const parts = did.split(":");
	if (parts.length < 3) return did;
	const id = parts.slice(2).join(":");
	if (id.length <= 11) return did;
	return `${parts[0]}:${parts[1]}:${id.slice(0, 8)}...${id.slice(-3)}`;
}

/**
 * Format a bigint wei amount as human-readable $ENSL with commas and 2 decimals.
 */
export function formatEnsl(wei: bigint): string {
	const whole = wei / DECIMALS;
	const frac = wei % DECIMALS;
	const fracStr = frac.toString().padStart(18, "0").slice(0, 2);
	const wholeStr = addCommas(whole.toString());
	return `${wholeStr}.${fracStr} ENSL`;
}

/**
 * Add thousands-separator commas to a numeric string.
 */
function addCommas(s: string): string {
	const parts: string[] = [];
	let remaining = s;
	while (remaining.length > 3) {
		parts.unshift(remaining.slice(-3));
		remaining = remaining.slice(0, -3);
	}
	parts.unshift(remaining);
	return parts.join(",");
}

// ── WalletManager ────────────────────────────────────────────────────

/**
 * WalletManager wraps @ensoul/ledger account queries and @ensoul/identity
 * for signing wallet transactions.
 */
export class WalletManager {
	private identity: AgentIdentity;
	private state: AccountState;
	private blocks: Block[];

	constructor(
		identity: AgentIdentity,
		state: AccountState,
		blocks: Block[] = [],
	) {
		this.identity = identity;
		this.state = state;
		this.blocks = blocks;
	}

	/**
	 * Get the DID for this wallet.
	 */
	getDid(): string {
		return this.identity.did;
	}

	/**
	 * Get the current balance summary.
	 */
	getBalance(): { available: bigint; staked: bigint; total: bigint } {
		const account = this.state.getAccount(this.identity.did);
		return {
			available: account.balance,
			staked: account.stakedBalance,
			total: account.balance + account.stakedBalance,
		};
	}

	/**
	 * Format the balance for display.
	 */
	formatBalance(): string {
		const b = this.getBalance();
		return [
			`  Available: ${formatEnsl(b.available)}`,
			`  Staked:    ${formatEnsl(b.staked)}`,
			`  Total:     ${formatEnsl(b.total)}`,
		].join("\n");
	}

	/**
	 * Format the receive address for display.
	 */
	formatReceive(): string {
		return `  Send $ENSL to: ${this.identity.did}`;
	}

	/**
	 * Build a signed transaction.
	 */
	async buildTransaction(
		type: TransactionType,
		to: string,
		amount: bigint,
	): Promise<Transaction> {
		const account = this.state.getAccount(this.identity.did);
		const partial = {
			type,
			from: this.identity.did,
			to,
			amount,
			nonce: account.nonce,
			timestamp: Date.now(),
		};
		const payload = encodeTxPayload(partial as Transaction);
		const signature = await this.identity.sign(payload);
		return { ...partial, signature } as Transaction;
	}

	/**
	 * Build a confirmation prompt for a send transaction.
	 */
	formatSendConfirmation(recipientDid: string, amount: bigint): string {
		return `Send ${formatEnsl(amount)} to ${shortenDid(recipientDid)}? (y/n)`;
	}

	/**
	 * Get transaction history for this wallet (last N transactions).
	 */
	getHistory(limit = 20): HistoryEntry[] {
		const did = this.identity.did;
		const entries: HistoryEntry[] = [];

		// Walk blocks from latest to earliest
		for (let i = this.blocks.length - 1; i >= 0 && entries.length < limit; i--) {
			const block = this.blocks[i];
			if (!block) continue;

			for (const tx of block.transactions) {
				if (tx.from !== did && tx.to !== did) continue;

				entries.push({
					blockHeight: block.height,
					type: classifyTx(tx, did),
					amount: formatEnsl(tx.amount),
					counterparty: shortenDid(
						tx.from === did ? tx.to : tx.from,
					),
					timestamp: formatTimestamp(tx.timestamp),
				});

				if (entries.length >= limit) break;
			}
		}

		return entries;
	}

	/**
	 * Format history entries as a table string.
	 */
	formatHistory(limit = 20): string {
		const entries = this.getHistory(limit);
		if (entries.length === 0) return "  No transactions found.";

		const header =
			"  Block    Type       Amount                 Counterparty           Time";
		const separator =
			"  ─────    ────       ──────                 ────────────           ────";

		const rows = entries.map(
			(e) =>
				`  ${String(e.blockHeight).padEnd(8)} ${e.type.padEnd(10)} ${e.amount.padEnd(22)} ${e.counterparty.padEnd(22)} ${e.timestamp}`,
		);

		return [header, separator, ...rows].join("\n");
	}
}

/**
 * Classify a transaction relative to a given DID.
 */
function classifyTx(
	tx: Transaction,
	myDid: string,
): HistoryEntry["type"] {
	switch (tx.type) {
		case "transfer":
			return tx.from === myDid ? "sent" : "received";
		case "stake":
			return "staked";
		case "unstake":
			return "unstaked";
		case "reward_claim":
			return "reward";
		case "slash":
			return "slashed";
		case "storage_payment":
			return tx.from === myDid ? "sent" : "received";
		default:
			return tx.from === myDid ? "sent" : "received";
	}
}

/**
 * Format a timestamp (ms since epoch) as a short date-time string.
 */
function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hour = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${month}-${day} ${hour}:${min}`;
}

// ── RPC wallet runner (no node, just query and exit) ─────────────────

/** Account info returned from the peer API. */
interface RpcAccountInfo {
	did: string;
	balance: string;
	staked: string;
	unstaking: string;
	unstakingCompleteAt: number;
	nonce: number;
	storageCredits: string;
	delegated?: string;
	pendingRewards?: string;
}

/**
 * Load identity from {dataDir}/identity.json.
 * Returns null if the file does not exist.
 */
async function loadIdentityFromDisk(dataDir: string): Promise<AgentIdentity | null> {
	try {
		const idPath = join(expandHome(dataDir), "identity.json");
		const raw = await readFile(idPath, "utf-8");
		const stored = JSON.parse(raw) as { seed: string };
		const seed = hexToBytes(stored.seed);
		return await createIdentity({ seed });
	} catch {
		return null;
	}
}

/**
 * Query account info from a validator's peer API.
 */
async function queryAccount(rpc: string, did: string): Promise<RpcAccountInfo | null> {
	try {
		const url = `${rpc}/v1/account/${encodeURIComponent(did)}`;
		const resp = await fetch(url);
		if (!resp.ok) return null;
		const d = (await resp.json()) as Record<string, unknown>;
		const raw = (d["raw"] as Record<string, string>) ?? {};
		return {
			did: String(d["did"] ?? did),
			balance: raw["available"] ?? raw["balance"] ?? "0",
			staked: raw["staked"] ?? raw["stakedBalance"] ?? "0",
			unstaking: raw["unstaking"] ?? raw["unstakingBalance"] ?? "0",
			unstakingCompleteAt: Number(d["unstakingCompleteAt"] ?? 0),
			nonce: Number(d["nonce"] ?? raw["nonce"] ?? 0),
			storageCredits: raw["storageCredits"] ?? "0",
			delegated: raw["delegated"] ?? raw["delegatedBalance"] ?? "0",
			pendingRewards: raw["pendingRewards"] ?? "0",
		};
	} catch {
		return null;
	}
}

/**
 * Run a wallet subcommand: load identity, query RPC, print result, exit.
 * Returns true if the command was handled.
 */
export async function runWalletCommand(cmd: WalletCommand): Promise<boolean> {
	if (cmd.subcommand === "none") return false;

	const out = (msg: string): void => {
		process.stdout.write(`${msg}\n`);
	};

	// "receive" only needs the DID, no RPC query
	if (cmd.subcommand === "receive") {
		const identity = await loadIdentityFromDisk(cmd.dataDir);
		if (!identity) {
			out("No identity found. Run ensoul-node first to generate one.");
			return true;
		}
		out(`\n  Send $ENSL to: ${identity.did}\n`);
		return true;
	}

	// All other commands need identity + RPC
	const identity = await loadIdentityFromDisk(cmd.dataDir);
	if (!identity) {
		out("No identity found. Run ensoul-node first to generate one.");
		return true;
	}

	const account = await queryAccount(cmd.rpc, identity.did);
	if (!account) {
		out(`Cannot connect to validator at ${cmd.rpc}`);
		out("Make sure a validator is running, or use --rpc to specify the endpoint.");
		return true;
	}

	const balance = BigInt(account.balance);
	const staked = BigInt(account.staked);
	const delegated = BigInt(account.delegated ?? "0");
	const unstaking = BigInt(account.unstaking ?? "0");
	const rewards = BigInt(account.pendingRewards ?? "0");
	const total = balance + staked + delegated + unstaking + rewards;

	switch (cmd.subcommand) {
		case "balance": {
			const completesAt = account.unstakingCompleteAt
				? new Date(account.unstakingCompleteAt * 1000).toISOString().slice(0, 16)
				: "N/A";
			out("");
			out(`  DID:             ${identity.did}`);
			out(`  Available:       ${formatEnsl(balance)}`);
			out(`  Staked:          ${formatEnsl(staked)}`);
			out(`  Delegated:       ${formatEnsl(delegated)}`);
			out(`  Unstaking:       ${formatEnsl(unstaking)} (completes: ${completesAt})`);
			out(`  Pending Rewards: ${formatEnsl(rewards)}`);
			out(`  Total:           ${formatEnsl(total)}`);
			out(`  Nonce:           ${account.nonce}`);
			out("");
			break;
		}

		case "send": {
			if (!cmd.recipientDid || cmd.amount === 0n) {
				out("Usage: ensoul-node wallet send <recipient_did> <amount>");
				break;
			}
			if (!validateDid(cmd.recipientDid)) {
				out(`Invalid DID: ${cmd.recipientDid}`);
				break;
			}
			out(`\n  Sending ${formatEnsl(cmd.amount)} to ${shortenDid(cmd.recipientDid)}...`);
			const sendResult = await signAndBroadcast(identity, "transfer", cmd.recipientDid, cmd.amount.toString(), account.nonce);
			if (sendResult.applied) {
				out(`  Confirmed at height ${sendResult.height}. Hash: ${sendResult.hash ?? "pending"}`);
			} else {
				out(`  Failed: ${sendResult.error ?? "unknown error"}`);
			}
			out("");
			break;
		}

		case "history": {
			out("\n  Transaction history requires a full node connection.");
			out("  (RPC-based history query not yet implemented)");
			out("");
			break;
		}

		case "stake": {
			if (cmd.amount === 0n) {
				out("Usage: ensoul-node wallet stake <amount>");
				break;
			}
			out(`\n  Staking ${formatEnsl(cmd.amount)}...`);
			const stakeResult = await signAndBroadcast(identity, "stake", identity.did, cmd.amount.toString(), account.nonce);
			if (stakeResult.applied) {
				out(`  Confirmed at height ${stakeResult.height}. Tokens locked for 30 days.`);
			} else {
				out(`  Failed: ${stakeResult.error ?? "unknown error"}`);
			}
			out("");
			break;
		}

		case "unstake": {
			if (cmd.amount === 0n) {
				out("Usage: ensoul-node wallet unstake <amount>");
				break;
			}
			out(`\n  Unstaking ${formatEnsl(cmd.amount)}...`);
			const unstakeResult = await signAndBroadcast(identity, "unstake", identity.did, cmd.amount.toString(), account.nonce);
			if (unstakeResult.applied) {
				out(`  Confirmed at height ${unstakeResult.height}. 7-day cooldown started.`);
			} else {
				out(`  Failed: ${unstakeResult.error ?? "unknown error"}`);
			}
			out("");
			break;
		}

		case "delegate": {
			if (!cmd.recipientDid || cmd.amount === 0n) {
				out("Usage: ensoul-node wallet delegate <validator_did> <amount>");
				break;
			}
			if (!validateDid(cmd.recipientDid)) {
				out(`Invalid validator DID: ${cmd.recipientDid}`);
				break;
			}
			out(`\n  Delegating ${formatEnsl(cmd.amount)} to ${shortenDid(cmd.recipientDid)}...`);
			const delResult = await signAndBroadcast(identity, "delegate", cmd.recipientDid, cmd.amount.toString(), account.nonce);
			if (delResult.applied) {
				out(`  Confirmed at height ${delResult.height}. Earning rewards proportional to delegation.`);
			} else {
				out(`  Failed: ${delResult.error ?? "unknown error"}`);
			}
			out("");
			break;
		}

		case "undelegate": {
			if (!cmd.recipientDid || cmd.amount === 0n) {
				out("Usage: ensoul-node wallet undelegate <validator_did> <amount>");
				break;
			}
			out(`\n  Undelegating ${formatEnsl(cmd.amount)} from ${shortenDid(cmd.recipientDid)}...`);
			const undelResult = await signAndBroadcast(identity, "undelegate", cmd.recipientDid, cmd.amount.toString(), account.nonce);
			if (undelResult.applied) {
				out(`  Confirmed at height ${undelResult.height}. 7-day cooldown started.`);
			} else {
				out(`  Failed: ${undelResult.error ?? "unknown error"}`);
			}
			out("");
			break;
		}

		case "claim-rewards": {
			out(`\n  Claiming rewards for ${shortenDid(identity.did)}...`);
			out(`  Pending: ${account.pendingRewards ?? "0"} ENSL`);
			const claimResult = await signAndBroadcast(identity, "reward_claim", identity.did, "0", account.nonce);
			if (claimResult.applied) {
				out(`  Confirmed at height ${claimResult.height}. Rewards moved to available balance.`);
			} else {
				out(`  Failed: ${claimResult.error ?? "unknown error"}`);
			}
			out("");
			break;
		}

		case "delegations": {
			out(`\n  Delegations for ${shortenDid(identity.did)}`);
			try {
				const delResp = await fetch(`${API_URL}/v1/account/${encodeURIComponent(identity.did)}/delegations`, { signal: AbortSignal.timeout(10000) });
				if (delResp.ok) {
					const delData = (await delResp.json()) as { delegations?: Array<{ validator: string; amount: string; lockedUntil?: number; category?: string }> };
					const dels = delData.delegations ?? [];
					if (dels.length === 0) {
						out("  No active delegations.\n");
					} else {
						for (const d of dels) {
							const locked = d.lockedUntil && d.lockedUntil > Date.now();
							const lockStr = locked ? `locked until ${new Date(d.lockedUntil!).toISOString().slice(0, 10)}` : "unlocked";
							const cat = d.category ? ` [${d.category}]` : "";
							const amt = formatEnsl(BigInt(d.amount));
							out(`  ${shortenDid(d.validator)}: ${amt} (${lockStr})${cat}`);
						}
						out("");
					}
				} else {
					out("  Could not fetch delegations.\n");
				}
			} catch {
				out("  Could not reach the API.\n");
			}
			break;
		}
	}

	return true;
}

// formatSendConfirmation removed: send now broadcasts directly
