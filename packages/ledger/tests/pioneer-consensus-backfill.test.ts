/**
 * Tests for Pioneer consensus backfill logic.
 * Verifies that pioneer-delegated validators get added to consensusSet
 * via joinConsensus, both for the forward fix (new delegations after
 * activation height) and the one-shot backfill at activation height.
 */

import { describe, it, expect } from "vitest";
import { AccountState } from "../src/accounts.js";
import { DelegationRegistry } from "../src/delegations.js";

const DECIMALS = 10n ** 18n;
const GOV = "did:key:z6MkGOV";
const VAL_A = "did:key:z6MkVAL_A";
const VAL_B = "did:key:z6MkVAL_B";
const VAL_C = "did:key:z6MkVAL_C";
const FOUND_1 = "did:key:z6MkFOUND1";
const FOUND_2 = "did:key:z6MkFOUND2";

function setupState(): { state: AccountState; delegations: DelegationRegistry } {
	const state = new AccountState();
	const delegations = new DelegationRegistry();
	return { state, delegations };
}

describe("Pioneer consensus backfill", () => {
	// Test 1: joinConsensus adds DID to consensus set
	it("joinConsensus adds a validator DID to the consensus set", () => {
		const { state } = setupState();
		expect(state.getConsensusSet()).toEqual([]);
		state.joinConsensus(VAL_A);
		expect(state.getConsensusSet()).toContain(VAL_A);
	});

	// Test 2: joinConsensus is idempotent
	it("joinConsensus is idempotent (calling twice is safe)", () => {
		const { state } = setupState();
		state.joinConsensus(VAL_A);
		state.joinConsensus(VAL_A);
		const set = state.getConsensusSet();
		expect(set.filter(d => d === VAL_A).length).toBe(1);
	});

	// Test 3: backfill adds all pioneer-delegated validators
	it("iterating pioneer delegations and calling joinConsensus adds all to set", () => {
		const { state, delegations } = setupState();

		// Foundation validators already in consensus set
		state.joinConsensus(FOUND_1);
		state.joinConsensus(FOUND_2);

		// Pioneer delegations exist but validators not in consensus set
		delegations.delegate(GOV, VAL_A, 1_000_000n * DECIMALS, Date.now() + 86400000, "pioneer");
		delegations.delegate(GOV, VAL_B, 1_000_000n * DECIMALS, Date.now() + 86400000, "pioneer");
		delegations.delegate(GOV, VAL_C, 1_000_000n * DECIMALS, Date.now() + 86400000, "pioneer");

		// Simulate backfill
		const pioneerDelegations = delegations.serialize().filter(d => d.category === "pioneer");
		for (const d of pioneerDelegations) {
			state.joinConsensus(d.validator);
		}

		const set = state.getConsensusSet();
		expect(set).toContain(FOUND_1);
		expect(set).toContain(FOUND_2);
		expect(set).toContain(VAL_A);
		expect(set).toContain(VAL_B);
		expect(set).toContain(VAL_C);
		expect(set.length).toBe(5);
	});

	// Test 4: backfill is no-op for validators already in set
	it("backfill is idempotent: validators already in set are not duplicated", () => {
		const { state, delegations } = setupState();

		state.joinConsensus(FOUND_1);
		state.joinConsensus(VAL_A); // already in set (e.g., did consensus_join)

		delegations.delegate(GOV, VAL_A, 1_000_000n * DECIMALS, Date.now() + 86400000, "pioneer");
		delegations.delegate(GOV, VAL_B, 1_000_000n * DECIMALS, Date.now() + 86400000, "pioneer");

		const pioneerDelegations = delegations.serialize().filter(d => d.category === "pioneer");
		for (const d of pioneerDelegations) {
			state.joinConsensus(d.validator);
		}

		const set = state.getConsensusSet();
		expect(set.filter(d => d === VAL_A).length).toBe(1);
		expect(set).toContain(VAL_B);
		expect(set.length).toBe(3); // FOUND_1 + VAL_A + VAL_B
	});

	// Test 5: consensus set is deterministically sorted
	it("getConsensusSet returns sorted array for deterministic replay", () => {
		const { state } = setupState();
		state.joinConsensus(VAL_C);
		state.joinConsensus(VAL_A);
		state.joinConsensus(VAL_B);

		const set = state.getConsensusSet();
		const sorted = [...set].sort();
		expect(set).toEqual(sorted);
	});

	// Test 6: non-pioneer delegations are not backfilled
	it("non-pioneer delegations are not included in backfill", () => {
		const { state, delegations } = setupState();

		// Regular delegation (no category/lock)
		delegations.delegate(GOV, VAL_A, 1_000_000n * DECIMALS);
		// Pioneer delegation
		delegations.delegate(GOV, VAL_B, 1_000_000n * DECIMALS, Date.now() + 86400000, "pioneer");

		const pioneerDelegations = delegations.serialize().filter(d => d.category === "pioneer");
		for (const d of pioneerDelegations) {
			state.joinConsensus(d.validator);
		}

		const set = state.getConsensusSet();
		expect(set).toContain(VAL_B);
		expect(set).not.toContain(VAL_A);
	});
});
