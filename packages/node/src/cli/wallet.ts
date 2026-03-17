import type { AgentIdentity } from "@ensoul/identity";
import { encodeTxPayload } from "@ensoul/ledger";
import type { AccountState } from "@ensoul/ledger";
import type { Block, Transaction, TransactionType } from "@ensoul/ledger";

const DECIMALS = 10n ** 18n;

/** Parsed wallet command. */
export interface WalletCommand {
	subcommand:
		| "balance"
		| "send"
		| "receive"
		| "history"
		| "stake"
		| "unstake"
		| "none";
	recipientDid: string;
	amount: bigint;
	dataDir: string;
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
