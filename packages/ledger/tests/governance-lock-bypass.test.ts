/**
 * Tests for governance lock bypass on undelegate.
 * Verifies bypassLock parameter allows undelegating locked Pioneer delegations.
 */

import { describe, it, expect } from "vitest";
import { DelegationRegistry } from "../src/delegations.js";

const DECIMALS = 10n ** 18n;
const GOV = "did:key:z6MkGOV";
const VAL = "did:key:z6MkVAL";

function setup(): DelegationRegistry {
	const reg = new DelegationRegistry();
	// Pioneer delegation with 24-month lock (far in the future)
	reg.delegate(GOV, VAL, 1_000_000n * DECIMALS, Date.now() + 730 * 86400000, "pioneer");
	return reg;
}

describe("governance lock bypass", () => {
	it("bypassLock=false with active lock throws", () => {
		const reg = setup();
		expect(() => {
			reg.undelegate(GOV, VAL, 1_000_000n * DECIMALS, Date.now(), false);
		}).toThrow(/locked until/);
	});

	it("bypassLock=true with active lock succeeds", () => {
		const reg = setup();
		reg.undelegate(GOV, VAL, 1_000_000n * DECIMALS, Date.now(), true);
		// Verify delegation is removed
		const entries = reg.serialize();
		const remaining = entries.filter(e => e.validator === VAL && e.delegator === GOV);
		expect(remaining.length).toBe(0);
	});

	it("bypassLock=true without lock succeeds (no regression)", () => {
		const reg = new DelegationRegistry();
		// Delegation without lock
		reg.delegate(GOV, VAL, 500n * DECIMALS);
		reg.undelegate(GOV, VAL, 500n * DECIMALS, Date.now(), true);
		const entries = reg.serialize();
		expect(entries.filter(e => e.validator === VAL).length).toBe(0);
	});

	it("nowMs parameter still respected when bypassLock=false", () => {
		const reg = new DelegationRegistry();
		const lockUntil = Date.now() + 1000; // 1 second from now
		reg.delegate(GOV, VAL, 100n * DECIMALS, lockUntil, "pioneer");

		// Before lock expiry: should throw
		expect(() => {
			reg.undelegate(GOV, VAL, 100n * DECIMALS, lockUntil - 1, false);
		}).toThrow(/locked until/);

		// After lock expiry: should succeed
		reg.undelegate(GOV, VAL, 100n * DECIMALS, lockUntil + 1, false);
		expect(reg.serialize().filter(e => e.validator === VAL).length).toBe(0);
	});

	it("default bypassLock is false (preserves existing behavior)", () => {
		const reg = setup();
		// Call without bypassLock parameter
		expect(() => {
			reg.undelegate(GOV, VAL, 1_000_000n * DECIMALS, Date.now());
		}).toThrow(/locked until/);
	});
});
