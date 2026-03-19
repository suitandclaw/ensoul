import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Transaction } from "./types.js";
import type { AccountState } from "./accounts.js";

/**
 * Compute the hash of a transaction (excludes signature from the hash).
 */
export function computeTxHash(tx: Transaction): string {
	const data = new TextEncoder().encode(
		JSON.stringify({
			type: tx.type,
			from: tx.from,
			to: tx.to,
			amount: tx.amount.toString(),
			nonce: tx.nonce,
			timestamp: tx.timestamp,
		}),
	);
	return bytesToHex(blake3(data));
}

/**
 * Encode a transaction's signable payload.
 */
export function encodeTxPayload(tx: Transaction): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			type: tx.type,
			from: tx.from,
			to: tx.to,
			amount: tx.amount.toString(),
			nonce: tx.nonce,
			timestamp: tx.timestamp,
		}),
	);
}

/**
 * Verify a transaction's Ed25519 signature against the sender's public key.
 */
export async function verifyTxSignature(
	tx: Transaction,
	publicKey: Uint8Array,
): Promise<boolean> {
	const { verify } = await import("@noble/ed25519");
	const { sha512 } = await import("@noble/hashes/sha2.js");
	const { hashes } = await import("@noble/ed25519");
	if (!hashes.sha512) {
		hashes.sha512 = (msg: Uint8Array) => sha512(msg);
	}
	try {
		return verify(tx.signature, encodeTxPayload(tx), publicKey);
	} catch {
		return false;
	}
}

/** Protocol treasury DID for fee collection. */
export const PROTOCOL_TREASURY = "did:ensoul:protocol:treasury";
/** Burn address DID. */
export const BURN_ADDRESS = "did:ensoul:protocol:burn";
/** Network rewards pool DID. */
export const REWARDS_POOL = "did:ensoul:protocol:rewards";

/**
 * Validate a transaction against the current account state.
 * Checks balance, nonce, and basic structure.
 */
export function validateTransaction(
	tx: Transaction,
	state: AccountState,
): { valid: boolean; error?: string } {
	if (tx.amount < 0n) {
		return { valid: false, error: "Negative amount" };
	}

	// Protocol-generated txs skip nonce/signature checks
	if (tx.type === "block_reward") {
		if (tx.from !== REWARDS_POOL) {
			return { valid: false, error: "Block reward must come from rewards pool" };
		}
		return { valid: true };
	}

	if (tx.type === "genesis_allocation") {
		// Genesis allocations are protocol-generated
		return { valid: true };
	}

	const sender = state.getAccount(tx.from);

	// Nonce check
	if (tx.nonce !== sender.nonce) {
		return {
			valid: false,
			error: `Invalid nonce: expected ${sender.nonce}, got ${tx.nonce}`,
		};
	}

	// Signature length check
	if (tx.signature.length !== 64) {
		return { valid: false, error: "Invalid signature length" };
	}

	switch (tx.type) {
		case "transfer": {
			if (sender.balance < tx.amount) {
				return { valid: false, error: "Insufficient balance" };
			}
			if (tx.from === tx.to) {
				return { valid: false, error: "Cannot transfer to self" };
			}
			break;
		}
		case "stake": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance to stake",
				};
			}
			break;
		}
		case "unstake": {
			if (sender.stakedBalance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient staked balance",
				};
			}
			break;
		}
		case "storage_payment": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance for storage payment",
				};
			}
			break;
		}
		case "reward_claim": {
			// Rewards are credited by the protocol; the claim tx
			// just triggers the distribution. Amount should be 0.
			break;
		}
		case "slash": {
			// Only protocol can slash — from must be protocol treasury
			if (tx.from !== PROTOCOL_TREASURY) {
				return {
					valid: false,
					error: "Only protocol can slash",
				};
			}
			break;
		}
		case "burn": {
			if (sender.balance < tx.amount) {
				return {
					valid: false,
					error: "Insufficient balance to burn",
				};
			}
			if (tx.to !== BURN_ADDRESS) {
				return {
					valid: false,
					error: "Burn must target burn address",
				};
			}
			break;
		}
	}

	return { valid: true };
}

/**
 * Apply a validated transaction to the account state.
 * Mutates the state in place.
 */
export function applyTransaction(
	tx: Transaction,
	state: AccountState,
	protocolFeeShare: number,
): void {
	switch (tx.type) {
		case "transfer": {
			state.debit(tx.from, tx.amount);
			state.credit(tx.to, tx.amount);
			break;
		}
		case "stake": {
			state.stake(tx.from, tx.amount);
			break;
		}
		case "unstake": {
			state.unstake(tx.from, tx.amount);
			break;
		}
		case "storage_payment": {
			state.debit(tx.from, tx.amount);
			// Split: protocolFeeShare% to treasury, rest to node operators
			const protocolCut =
				(tx.amount * BigInt(protocolFeeShare)) / 100n;
			const operatorCut = tx.amount - protocolCut;
			state.credit(PROTOCOL_TREASURY, protocolCut);
			state.credit(tx.to, operatorCut);
			// Give storage credits to the payer
			state.addStorageCredits(tx.from, tx.amount);
			break;
		}
		case "reward_claim": {
			// Rewards are pre-computed; this tx triggers transfer from pool
			if (tx.amount > 0n) {
				state.debit(REWARDS_POOL, tx.amount);
				state.credit(tx.from, tx.amount);
			}
			break;
		}
		case "block_reward": {
			// Protocol-generated: debit pool, credit proposer
			if (tx.amount > 0n) {
				state.debit(REWARDS_POOL, tx.amount);
				state.credit(tx.to, tx.amount);
			}
			break;
		}
		case "genesis_allocation": {
			// Protocol-generated: credit recipient (and optionally auto-stake)
			state.credit(tx.to, tx.amount);
			// If data field contains "stake", auto-stake the tokens
			if (tx.data && new TextDecoder().decode(tx.data) === "stake") {
				state.stake(tx.to, tx.amount);
			}
			break;
		}
		case "slash": {
			state.slash(tx.to, tx.amount);
			break;
		}
		case "burn": {
			state.debit(tx.from, tx.amount);
			// Tokens are burned — not credited to anyone
			break;
		}
	}

	// Protocol-generated txs do not track nonces
	if (tx.type !== "block_reward" && tx.type !== "genesis_allocation") {
		state.incrementNonce(tx.from);
	}
}
