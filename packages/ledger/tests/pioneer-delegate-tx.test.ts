/**
 * Tests for pioneer_delegate transaction type in the ledger layer.
 * The ledger validation is a pass-through (no-op); the real logic is in the ABCI.
 * These tests verify the ledger doesn't reject pioneer_delegate transactions.
 */

import { describe, it, expect } from "vitest";
import { validateTransaction, applyTransaction } from "../src/transactions.js";
import { AccountState } from "../src/accounts.js";
import type { Transaction } from "../src/types.js";

const DECIMALS = 10n ** 18n;
const GOVERNANCE_DID = "did:key:z6MkGOV";
const VALIDATOR_DID = "did:key:z6MkVAL";

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
	return {
		type: "pioneer_delegate",
		from: GOVERNANCE_DID,
		to: VALIDATOR_DID,
		amount: 1_000_000n * DECIMALS,
		nonce: 0,
		timestamp: Date.now(),
		signature: new Uint8Array(64),
		...overrides,
	};
}

describe("pioneer_delegate transaction", () => {
	it("validates successfully (ledger is pass-through)", () => {
		const state = new AccountState();
		// Governance account doesn't need balance; ABCI handles treasury debit
		state.setAccount({
			did: GOVERNANCE_DID,
			balance: 0n,
			stakedBalance: 0n,
			unstakingBalance: 0n,
			unstakingCompleteAt: 0,
			stakeLockedUntil: 0,
			delegatedBalance: 0n,
			pendingRewards: 0n,
			nonce: 0,
			storageCredits: 0n,
			lastActivity: 0,
		});

		const result = validateTransaction(makeTx(), state);
		expect(result.valid).toBe(true);
	});

	it("applies as no-op in the ledger (ABCI handles state changes)", () => {
		const state = new AccountState();
		state.setAccount({
			did: GOVERNANCE_DID,
			balance: 0n,
			stakedBalance: 0n,
			unstakingBalance: 0n,
			unstakingCompleteAt: 0,
			stakeLockedUntil: 0,
			delegatedBalance: 0n,
			pendingRewards: 0n,
			nonce: 0,
			storageCredits: 0n,
			lastActivity: 0,
		});

		// Should not throw
		applyTransaction(makeTx(), state, 10);

		// Balance unchanged (ABCI handles treasury movement)
		const acct = state.getAccount(GOVERNANCE_DID);
		expect(acct.balance).toBe(0n);
		expect(acct.delegatedBalance).toBe(0n);
	});
});
