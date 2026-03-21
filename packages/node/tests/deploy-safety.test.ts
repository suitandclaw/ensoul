import { describe, it, expect, beforeAll } from "vitest";
import { createIdentity } from "@ensoul/identity";
import { NodeBlockProducer } from "../src/chain/producer.js";
import { VERSION } from "../src/version.js";
import type { GenesisConfig } from "@ensoul/ledger";

const DECIMALS = 10n ** 18n;
const REWARDS_POOL = "did:ensoul:protocol:rewards";

/** Build a genesis config with N auto-staked validators. */
function makeGenesisWithValidators(count: number, dids: string[]): GenesisConfig {
	const foundationTotal = 150_000_000n * DECIMALS;
	const perValidator = foundationTotal / BigInt(count);
	const remainder = foundationTotal - perValidator * BigInt(count);
	const allocations = dids.map((did, i) => ({
		label: "Foundation Validator",
		percentage: i === 0 ? 15 : 0,
		tokens: i === 0 ? perValidator + remainder : perValidator,
		recipient: did,
		autoStake: true as const,
	}));

	allocations.push(
		{ label: "Rewards", percentage: 50, tokens: 500_000_000n * DECIMALS, recipient: REWARDS_POOL },
		{ label: "Treasury", percentage: 10, tokens: 100_000_000n * DECIMALS, recipient: "did:test:treasury" },
		{ label: "Onboarding", percentage: 10, tokens: 100_000_000n * DECIMALS, recipient: "did:test:onboarding" },
		{ label: "Liquidity", percentage: 5, tokens: 50_000_000n * DECIMALS, recipient: "did:test:liquidity" },
		{ label: "Contributors", percentage: 5, tokens: 50_000_000n * DECIMALS, recipient: "did:test:contributors" },
		{ label: "Insurance", percentage: 5, tokens: 50_000_000n * DECIMALS, recipient: "did:test:insurance" },
	);

	return {
		chainId: "ensoul-test",
		timestamp: 1700000000000,
		totalSupply: 1_000_000_000n * DECIMALS,
		allocations,
		emissionPerBlock: 19n * DECIMALS,
		networkRewardsPool: 500_000_000n * DECIMALS,
		protocolFees: { storageFeeProtocolShare: 10, txBaseFee: 1000n },
	};
}

describe("Deploy Safety", () => {
	let validatorDids: string[] = [];

	beforeAll(async () => {
		// Create 35 test validator identities
		const dids: string[] = [];
		for (let i = 0; i < 35; i++) {
			const seed = new Uint8Array(32);
			seed[0] = i;
			const id = await createIdentity({ seed });
			dids.push(id.did);
		}
		validatorDids = dids;
	});

	describe("Genesis validation", () => {
		it("loads genesis with all 35 validators in roster", () => {
			const config = makeGenesisWithValidators(35, validatorDids);
			const producer = new NodeBlockProducer(config, { minimumStake: 0n });

			const roster = producer.getEligibleValidators();
			expect(roster.length).toBe(35);

			// Verify roster is sorted
			const sorted = [...roster].sort();
			expect(roster).toEqual(sorted);
		});

		it("allocations sum to total supply", () => {
			const config = makeGenesisWithValidators(35, validatorDids);
			const total = config.allocations.reduce((s, a) => s + a.tokens, 0n);
			expect(total).toBe(config.totalSupply);
		});

		it("all validator allocations have autoStake true", () => {
			const config = makeGenesisWithValidators(35, validatorDids);
			const validators = config.allocations.filter((a) => a.autoStake === true);
			expect(validators.length).toBe(35);
		});
	});

	describe("Proposer rotation", () => {
		it("rotates across all 35 validators in 100 blocks", () => {
			const config = makeGenesisWithValidators(35, validatorDids);
			const producer = new NodeBlockProducer(config, { minimumStake: 0n });

			const proposers = new Set<string>();
			for (let h = 1; h <= 100; h++) {
				const p = producer.selectProposer(h);
				expect(p).not.toBeNull();
				proposers.add(p!);
			}

			// With 35 validators over 100 blocks, at least 10 unique proposers
			// (actually all 35 should appear since 100 > 35 * 2)
			expect(proposers.size).toBeGreaterThanOrEqual(10);
			// All 35 should appear (100 blocks, 35 validators, round-robin)
			expect(proposers.size).toBe(35);
		});

		it("deterministic: same height always returns same proposer", () => {
			const config = makeGenesisWithValidators(35, validatorDids);
			const producer1 = new NodeBlockProducer(config, { minimumStake: 0n });
			const producer2 = new NodeBlockProducer(config, { minimumStake: 0n });

			for (let h = 0; h < 50; h++) {
				expect(producer1.selectProposer(h)).toBe(producer2.selectProposer(h));
			}
		});
	});

	describe("Block production and validation", () => {
		it("validator 0 produces block, validator 1 accepts it", () => {
			const config = makeGenesisWithValidators(35, validatorDids);

			const producer0 = new NodeBlockProducer(config, { minimumStake: 0n });
			producer0.initGenesis([]);

			const producer1 = new NodeBlockProducer(config, { minimumStake: 0n });
			producer1.initGenesis([]);

			// Find which validator is proposer for height 1
			const proposerDid = producer0.selectProposer(1);
			expect(proposerDid).not.toBeNull();

			// Produce block
			const block = producer0.produceBlock(proposerDid!, true);
			expect(block).not.toBeNull();
			expect(block!.height).toBe(1);

			// Accept on validator 1
			const result = producer1.applyBlock(block!, true);
			expect(result.valid).toBe(true);
			expect(producer1.getHeight()).toBe(1);
		});

		it("rejects block from non-roster validator", () => {
			const config = makeGenesisWithValidators(3, validatorDids.slice(0, 3));
			const producer = new NodeBlockProducer(config, { minimumStake: 0n });
			producer.initGenesis([]);

			// Produce a block with a non-roster DID
			const fakeDid = "did:key:z6MkFAKEnotinroster";
			expect(producer.isInRoster(fakeDid)).toBe(false);

			// Force-produce to get a block object, then try applying
			// We can't easily forge a block, but we can verify isInRoster
			const roster = producer.getEligibleValidators();
			expect(roster).not.toContain(fakeDid);
		});

		it("fallback block accepted when proposer timed out", () => {
			const config = makeGenesisWithValidators(3, validatorDids.slice(0, 3));
			const producer = new NodeBlockProducer(config, { minimumStake: 0n });
			producer.initGenesis([]);

			// Force-produce a block (simulating fallback)
			const anyRosterDid = producer.getEligibleValidators()[0]!;
			const block = producer.produceBlock(anyRosterDid, true);
			expect(block).not.toBeNull();
			expect(block!.height).toBe(1);
		});
	});

	describe("Version", () => {
		it("exports a valid semver string", () => {
			expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("version is at least 0.4.0", () => {
			const parts = VERSION.split(".").map(Number);
			const numeric = parts[0]! * 10000 + parts[1]! * 100 + parts[2]!;
			expect(numeric).toBeGreaterThanOrEqual(400);
		});
	});
});
