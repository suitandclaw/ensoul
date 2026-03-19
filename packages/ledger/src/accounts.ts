import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Account } from "./types.js";

/**
 * Account state manager.
 * Tracks balances, stakes, nonces, storage credits, and lockup state.
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
				unstakingBalance: 0n,
				unstakingCompleteAt: 0,
				stakeLockedUntil: 0,
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
	 * Records lockup start time. lockupDurationSec defaults to 30 days.
	 */
	stake(did: string, amount: bigint, lockupDurationSec = 2592000): void {
		const acc = this.getAccount(did);
		if (acc.balance < amount) {
			throw new Error(
				`Insufficient balance to stake: ${acc.balance} < ${amount}`,
			);
		}
		acc.balance -= amount;
		acc.stakedBalance += amount;
		acc.stakeLockedUntil = Math.floor(Date.now() / 1000) + lockupDurationSec;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Check if a validator's stake is locked.
	 * Returns remaining seconds, or 0 if unlocked.
	 */
	getLockupRemaining(did: string): number {
		const acc = this.getAccount(did);
		const now = Math.floor(Date.now() / 1000);
		if (acc.stakeLockedUntil > now) {
			return acc.stakeLockedUntil - now;
		}
		return 0;
	}

	/**
	 * Begin unstaking: move tokens from staked to unstaking with cooldown.
	 * Tokens are unavailable during the cooldown period.
	 * @throws If lockup period has not expired or insufficient staked balance.
	 */
	unstake(did: string, amount: bigint, cooldownDurationSec = 604800): void {
		const acc = this.getAccount(did);
		if (acc.stakedBalance < amount) {
			throw new Error(
				`Insufficient staked balance: ${acc.stakedBalance} < ${amount}`,
			);
		}

		// Check lockup
		const now = Math.floor(Date.now() / 1000);
		if (acc.stakeLockedUntil > now) {
			const remaining = acc.stakeLockedUntil - now;
			const days = Math.ceil(remaining / 86400);
			throw new Error(
				`Cannot unstake: lockup period has ${days} days remaining`,
			);
		}

		acc.stakedBalance -= amount;
		acc.unstakingBalance += amount;
		acc.unstakingCompleteAt = now + cooldownDurationSec;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
	}

	/**
	 * Complete unstaking: move tokens from unstaking to available balance.
	 * Only works if the cooldown period has expired.
	 * Returns the amount completed, or 0 if cooldown is still active.
	 */
	completeUnstaking(did: string): bigint {
		const acc = this.getAccount(did);
		if (acc.unstakingBalance === 0n) return 0n;

		const now = Math.floor(Date.now() / 1000);
		if (acc.unstakingCompleteAt > now) return 0n;

		const completed = acc.unstakingBalance;
		acc.balance += completed;
		acc.unstakingBalance = 0n;
		acc.unstakingCompleteAt = 0;
		acc.lastActivity = Date.now();
		this.accounts.set(did, acc);
		return completed;
	}

	/**
	 * Check if a validator is currently unstaking (in cooldown).
	 */
	isUnstaking(did: string): boolean {
		return this.getAccount(did).unstakingBalance > 0n;
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
					acc.unstakingBalance.toString(),
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
