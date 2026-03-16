import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Account } from "./types.js";

/**
 * Account state manager.
 * Tracks balances, stakes, nonces, and storage credits for all identities.
 */
export class AccountState {
	private accounts: Map<string, Account> = new Map();

	/**
	 * Get an account. Returns a default zero-balance account if not found.
	 */
	getAccount(did: string): Account {
		return (
			this.accounts.get(did) ?? {
				did,
				balance: 0n,
				stakedBalance: 0n,
				nonce: 0,
				storageCredits: 0n,
				lastActivity: 0,
			}
		);
	}

	/**
	 * Get balance for a DID.
	 */
	getBalance(did: string): bigint {
		return this.getAccount(did).balance;
	}

	/**
	 * Check if an account exists.
	 */
	hasAccount(did: string): boolean {
		return this.accounts.has(did);
	}

	/**
	 * Create or update an account.
	 */
	setAccount(account: Account): void {
		this.accounts.set(account.did, account);
	}

	/**
	 * Credit tokens to an account.
	 */
	credit(did: string, amount: bigint): void {
		const acc = this.getAccount(did);
		acc.balance += amount;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Debit tokens from an account.
	 * @throws If insufficient balance.
	 */
	debit(did: string, amount: bigint): void {
		const acc = this.getAccount(did);
		if (acc.balance < amount) {
			throw new Error(
				`Insufficient balance: ${acc.balance} < ${amount}`,
			);
		}
		acc.balance -= amount;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Add to staked balance (deducted from available balance).
	 */
	stake(did: string, amount: bigint): void {
		const acc = this.getAccount(did);
		if (acc.balance < amount) {
			throw new Error(
				`Insufficient balance to stake: ${acc.balance} < ${amount}`,
			);
		}
		acc.balance -= amount;
		acc.stakedBalance += amount;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Remove from staked balance (returned to available balance).
	 */
	unstake(did: string, amount: bigint): void {
		const acc = this.getAccount(did);
		if (acc.stakedBalance < amount) {
			throw new Error(
				`Insufficient staked balance: ${acc.stakedBalance} < ${amount}`,
			);
		}
		acc.stakedBalance -= amount;
		acc.balance += amount;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Slash staked tokens from a validator (burned, not returned).
	 */
	slash(did: string, amount: bigint): bigint {
		const acc = this.getAccount(did);
		const slashed = amount > acc.stakedBalance ? acc.stakedBalance : amount;
		acc.stakedBalance -= slashed;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
		return slashed;
	}

	/**
	 * Add storage credits.
	 */
	addStorageCredits(did: string, amount: bigint): void {
		const acc = this.getAccount(did);
		acc.storageCredits += amount;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Increment nonce for a DID.
	 */
	incrementNonce(did: string): void {
		const acc = this.getAccount(did);
		acc.nonce += 1;
		this.accounts.set(did, acc);
	}

	/**
	 * Get all accounts.
	 */
	getAllAccounts(): Account[] {
		return [...this.accounts.values()];
	}

	/**
	 * Compute a state root from all account data.
	 */
	computeStateRoot(): string {
		const sorted = [...this.accounts.entries()].sort(([a], [b]) =>
			a.localeCompare(b),
		);
		const data = new TextEncoder().encode(
			JSON.stringify(
				sorted.map(([, acc]) => [
					acc.did,
					acc.balance.toString(),
					acc.stakedBalance.toString(),
					acc.nonce,
					acc.storageCredits.toString(),
				]),
			),
		);
		return bytesToHex(blake3(data));
	}

	/**
	 * Create a deep copy of the account state.
	 */
	clone(): AccountState {
		const copy = new AccountState();
		for (const [, acc] of this.accounts) {
			copy.setAccount({ ...acc });
		}
		return copy;
	}
}
