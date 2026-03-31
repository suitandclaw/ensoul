/**
 * Tests for Pioneer delegation locks and unstaking state persistence.
 */

import { describe, it, expect } from "vitest";
import { DelegationRegistry, PIONEER_LOCK_DURATION_MS, MIN_DELEGATION } from "../src/delegations.js";

const DECIMALS = 10n ** 18n;
const ONE_MILLION = 1_000_000n * DECIMALS;
const NOW = Date.now();
const LOCK_EXPIRY = NOW + PIONEER_LOCK_DURATION_MS;
const PAST_EXPIRY = NOW - 1000; // 1 second ago

describe("Pioneer delegation locks", () => {
	it("creates a Pioneer delegation with 24-month lock", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-a", "validator-x", ONE_MILLION, LOCK_EXPIRY, "pioneer");

		const lock = reg.getLock("delegator-a", "validator-x");
		expect(lock).not.toBeNull();
		expect(lock!.lockedUntil).toBe(LOCK_EXPIRY);
		expect(lock!.category).toBe("pioneer");
		expect(reg.isLocked("delegator-a", "validator-x", NOW)).toBe(true);
	});

	it("rejects undelegate before lock expires", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-a", "validator-x", ONE_MILLION, LOCK_EXPIRY, "pioneer");

		expect(() => {
			reg.undelegate("delegator-a", "validator-x", ONE_MILLION, NOW);
		}).toThrow(/locked until/i);
	});

	it("carries lock forward on redelegate", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-a", "validator-x", ONE_MILLION, LOCK_EXPIRY, "pioneer");

		// Redelegate should succeed (lock does not block redelegation)
		reg.redelegate("delegator-a", "validator-x", "validator-y", ONE_MILLION);

		// Lock should now be on the destination
		const destLock = reg.getLock("delegator-a", "validator-y");
		expect(destLock).not.toBeNull();
		expect(destLock!.lockedUntil).toBe(LOCK_EXPIRY);
		expect(destLock!.category).toBe("pioneer");

		// Source lock should be gone (delegation fully moved)
		const srcLock = reg.getLock("delegator-a", "validator-x");
		expect(srcLock).toBeNull();

		// Undelegate from new validator should still fail (locked)
		expect(() => {
			reg.undelegate("delegator-a", "validator-y", ONE_MILLION, NOW);
		}).toThrow(/locked until/i);
	});

	it("allows undelegate after lock expires", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-a", "validator-x", ONE_MILLION, PAST_EXPIRY, "pioneer");

		// Lock is expired, should not be locked
		expect(reg.isLocked("delegator-a", "validator-x", NOW)).toBe(false);

		// Undelegate should succeed
		reg.undelegate("delegator-a", "validator-x", ONE_MILLION, NOW);

		// Delegation should be gone
		expect(reg.getTotalDelegatedTo("validator-x")).toBe(0n);
	});

	it("community delegations have no lock", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-b", "validator-x", MIN_DELEGATION);

		const lock = reg.getLock("delegator-b", "validator-x");
		expect(lock).toBeNull();
		expect(reg.isLocked("delegator-b", "validator-x")).toBe(false);

		// Undelegate should succeed immediately
		reg.undelegate("delegator-b", "validator-x", MIN_DELEGATION);
		expect(reg.getTotalDelegatedTo("validator-x")).toBe(0n);
	});

	it("serialization round-trips lock metadata", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-a", "validator-x", ONE_MILLION, LOCK_EXPIRY, "pioneer");
		reg.delegate("delegator-b", "validator-x", MIN_DELEGATION);

		const serialized = reg.serialize();
		const restored = DelegationRegistry.deserialize(serialized);

		// Pioneer lock survives
		const lock = restored.getLock("delegator-a", "validator-x");
		expect(lock).not.toBeNull();
		expect(lock!.lockedUntil).toBe(LOCK_EXPIRY);
		expect(lock!.category).toBe("pioneer");

		// Community delegation has no lock
		expect(restored.getLock("delegator-b", "validator-x")).toBeNull();

		// Amounts survive
		expect(restored.getTotalDelegatedTo("validator-x")).toBe(ONE_MILLION + MIN_DELEGATION);
	});

	it("clone preserves lock metadata", () => {
		const reg = new DelegationRegistry();
		reg.delegate("delegator-a", "validator-x", ONE_MILLION, LOCK_EXPIRY, "foundation");

		const copy = reg.clone();

		const lock = copy.getLock("delegator-a", "validator-x");
		expect(lock).not.toBeNull();
		expect(lock!.lockedUntil).toBe(LOCK_EXPIRY);
		expect(lock!.category).toBe("foundation");

		// Mutations to clone do not affect original
		copy.delegate("delegator-c", "validator-x", MIN_DELEGATION);
		expect(reg.getDelegatorCount("validator-x")).toBe(1);
		expect(copy.getDelegatorCount("validator-x")).toBe(2);
	});

	it("computeRoot includes lock data", () => {
		const regA = new DelegationRegistry();
		regA.delegate("d1", "v1", ONE_MILLION);

		const regB = new DelegationRegistry();
		regB.delegate("d1", "v1", ONE_MILLION, LOCK_EXPIRY, "pioneer");

		// Different lock metadata should produce different roots
		expect(regA.computeRoot()).not.toBe(regB.computeRoot());
	});
});
