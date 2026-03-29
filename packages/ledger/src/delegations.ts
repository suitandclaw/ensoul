import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const ENC = new TextEncoder();

/** Minimum delegation amount: 100 ENSL. */
const DECIMALS = 10n ** 18n;
export const MIN_DELEGATION = 100n * DECIMALS;

/** Validator commission rate: 10%. */
export const COMMISSION_RATE = 10n;

/** Storage credits per 10,000 ENSL delegated (1 MB-month equivalent). */
export const STORAGE_CREDIT_THRESHOLD = 10_000n * DECIMALS;

/**
 * Tracks delegation relationships: who delegated how much to which validator.
 * Stored as validator -> delegator -> amount.
 */
export class DelegationRegistry {
	/** validator DID -> (delegator DID -> amount) */
	private delegations: Map<string, Map<string, bigint>> = new Map();

	/**
	 * Add a delegation from delegator to validator.
	 */
	delegate(delegator: string, validator: string, amount: bigint): void {
		if (amount < MIN_DELEGATION) {
			throw new Error(
				`Delegation below minimum: ${amount} < ${MIN_DELEGATION}`,
			);
		}

		let validatorMap = this.delegations.get(validator);
		if (!validatorMap) {
			validatorMap = new Map();
			this.delegations.set(validator, validatorMap);
		}

		const existing = validatorMap.get(delegator) ?? 0n;
		validatorMap.set(delegator, existing + amount);
	}

	/**
	 * Remove a delegation (or part of it) from delegator to validator.
	 */
	undelegate(delegator: string, validator: string, amount: bigint): void {
		const validatorMap = this.delegations.get(validator);
		if (!validatorMap) {
			throw new Error("No delegation found");
		}

		const existing = validatorMap.get(delegator) ?? 0n;
		if (existing < amount) {
			throw new Error(
				`Insufficient delegation: ${existing} < ${amount}`,
			);
		}

		const remaining = existing - amount;
		if (remaining === 0n) {
			validatorMap.delete(delegator);
			if (validatorMap.size === 0) {
				this.delegations.delete(validator);
			}
		} else {
			validatorMap.set(delegator, remaining);
		}
	}

	/**
	 * Move a delegation from one validator to another.
	 * The delegator retains ownership; only the target validator changes.
	 */
	redelegate(delegator: string, fromValidator: string, toValidator: string, amount: bigint): void {
		this.undelegate(delegator, fromValidator, amount);
		// Skip MIN_DELEGATION check for redelegate since tokens were already validated at initial delegation
		let validatorMap = this.delegations.get(toValidator);
		if (!validatorMap) {
			validatorMap = new Map();
			this.delegations.set(toValidator, validatorMap);
		}
		const existing = validatorMap.get(delegator) ?? 0n;
		validatorMap.set(delegator, existing + amount);
	}

	/**
	 * Get all delegations to a validator.
	 */
	getDelegationsTo(validator: string): Map<string, bigint> {
		return new Map(this.delegations.get(validator) ?? []);
	}

	/**
	 * Get all delegations from a delegator.
	 */
	getDelegationsFrom(delegator: string): Map<string, bigint> {
		const result = new Map<string, bigint>();
		for (const [validator, delegatorMap] of this.delegations) {
			const amount = delegatorMap.get(delegator);
			if (amount !== undefined && amount > 0n) {
				result.set(validator, amount);
			}
		}
		return result;
	}

	/**
	 * Get total amount delegated to a validator.
	 */
	getTotalDelegatedTo(validator: string): bigint {
		const map = this.delegations.get(validator);
		if (!map) return 0n;
		let total = 0n;
		for (const amount of map.values()) {
			total += amount;
		}
		return total;
	}

	/**
	 * Get the total stake weight for a validator (own stake + delegations).
	 */
	getTotalStakeWeight(validator: string, ownStake: bigint): bigint {
		return ownStake + this.getTotalDelegatedTo(validator);
	}

	/**
	 * Get the number of delegators to a validator.
	 */
	getDelegatorCount(validator: string): number {
		return this.delegations.get(validator)?.size ?? 0;
	}

	/**
	 * Compute reward splits for a block reward.
	 * Returns a map of DID -> reward amount.
	 * Commission (10%) goes to the validator, rest split by stake weight.
	 */
	computeRewardSplit(
		validator: string,
		ownStake: bigint,
		totalReward: bigint,
	): Map<string, bigint> {
		const splits = new Map<string, bigint>();
		if (totalReward === 0n) return splits;

		const commission = (totalReward * COMMISSION_RATE) / 100n;
		const distributable = totalReward - commission;
		const totalWeight = this.getTotalStakeWeight(validator, ownStake);

		// If no stake weight, all goes to validator
		if (totalWeight === 0n) {
			splits.set(validator, totalReward);
			return splits;
		}

		// Validator gets commission + proportional share of own stake
		let validatorShare = commission;
		if (ownStake > 0n) {
			validatorShare += (distributable * ownStake) / totalWeight;
		}
		splits.set(validator, validatorShare);

		// Each delegator gets proportional share
		const delegatorMap = this.delegations.get(validator);
		let distributed = validatorShare;
		if (delegatorMap) {
			for (const [delegator, amount] of delegatorMap) {
				const share = (distributable * amount) / totalWeight;
				if (share > 0n) {
					splits.set(delegator, share);
					distributed += share;
				}
			}
		}

		// Assign dust (rounding remainder) to validator
		const dust = totalReward - distributed;
		if (dust > 0n) {
			splits.set(validator, (splits.get(validator) ?? 0n) + dust);
		}

		return splits;
	}

	/**
	 * Compute storage credits earned from a delegation amount.
	 * 10,000 ENSL = 1 credit (1 MB-month equivalent).
	 */
	computeStorageCredits(amount: bigint): bigint {
		return amount / STORAGE_CREDIT_THRESHOLD;
	}

	/**
	 * Slash delegations to a validator proportionally.
	 * Returns map of delegator -> slashed amount.
	 */
	slashDelegations(
		validator: string,
		slashFraction: bigint,
		denominator: bigint,
	): Map<string, bigint> {
		const slashed = new Map<string, bigint>();
		const delegatorMap = this.delegations.get(validator);
		if (!delegatorMap) return slashed;

		for (const [delegator, amount] of delegatorMap) {
			const cut = (amount * slashFraction) / denominator;
			if (cut > 0n) {
				const remaining = amount - cut;
				if (remaining === 0n) {
					delegatorMap.delete(delegator);
				} else {
					delegatorMap.set(delegator, remaining);
				}
				slashed.set(delegator, cut);
			}
		}

		if (delegatorMap.size === 0) {
			this.delegations.delete(validator);
		}

		return slashed;
	}

	/**
	 * Compute a deterministic hash of all delegations for state root.
	 */
	computeRoot(): string {
		const sorted = [...this.delegations.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([validator, delegatorMap]) => {
				const delegators = [...delegatorMap.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([d, a]) => `${d}:${a.toString()}`);
				return `${validator}=${delegators.join(",")}`;
			});
		return bytesToHex(blake3(ENC.encode(sorted.join("|"))));
	}

	/**
	 * Serialize all delegations for persistence.
	 */
	serialize(): Array<{ validator: string; delegator: string; amount: string }> {
		const entries: Array<{
			validator: string;
			delegator: string;
			amount: string;
		}> = [];
		for (const [validator, delegatorMap] of this.delegations) {
			for (const [delegator, amount] of delegatorMap) {
				entries.push({
					validator,
					delegator,
					amount: amount.toString(),
				});
			}
		}
		return entries;
	}

	/**
	 * Load delegations from serialized form.
	 */
	static deserialize(
		entries: Array<{ validator: string; delegator: string; amount: string }>,
	): DelegationRegistry {
		const registry = new DelegationRegistry();
		for (const e of entries) {
			let validatorMap = registry.delegations.get(e.validator);
			if (!validatorMap) {
				validatorMap = new Map();
				registry.delegations.set(e.validator, validatorMap);
			}
			validatorMap.set(e.delegator, BigInt(e.amount));
		}
		return registry;
	}

	/**
	 * Create a deep copy.
	 */
	clone(): DelegationRegistry {
		const copy = new DelegationRegistry();
		for (const [validator, delegatorMap] of this.delegations) {
			const copyMap = new Map<string, bigint>();
			for (const [delegator, amount] of delegatorMap) {
				copyMap.set(delegator, amount);
			}
			copy.delegations.set(validator, copyMap);
		}
		return copy;
	}
}
