import type { GenesisConfig } from "./types.js";

const DECIMALS = 10n ** 18n;

/**
 * Create the default genesis configuration for the Ensoul chain.
 * Token allocations match the architecture docs:
 * - 15% Foundation Validators (150M)
 * - 50% Network Rewards (500M)
 * - 10% Protocol Treasury (100M)
 * - 10% Agent Onboarding (100M)
 * - 5% Initial Liquidity (50M)
 * - 5% Early Contributors (50M)
 * - 5% Insurance Reserve (50M)
 */
export function createDefaultGenesis(
	foundationValidatorDids: string[] = ["did:ensoul:foundation"],
): GenesisConfig {
	const totalSupply = 1_000_000_000n * DECIMALS;

	// ~19 ENSL per block at 6s blocks in year 1 (100M / 5,256,000 blocks)
	const blocksPerYear = (365 * 24 * 60 * 60) / 6;
	const year1Emission = 100_000_000n * DECIMALS;
	const emissionPerBlock = year1Emission / BigInt(blocksPerYear);

	return {
		chainId: "ensoul-1",
		timestamp: Date.now(),
		totalSupply,
		allocations: [
			{
				label: "Foundation Validators",
				percentage: 15,
				tokens: 150_000_000n * DECIMALS,
				recipient:
					foundationValidatorDids[0] ??
					"did:ensoul:foundation",
			},
			{
				label: "Network Rewards",
				percentage: 50,
				tokens: 500_000_000n * DECIMALS,
				recipient: "did:ensoul:protocol:rewards",
			},
			{
				label: "Protocol Treasury",
				percentage: 10,
				tokens: 100_000_000n * DECIMALS,
				recipient: "did:ensoul:protocol:treasury",
			},
			{
				label: "Agent Onboarding",
				percentage: 10,
				tokens: 100_000_000n * DECIMALS,
				recipient: "did:ensoul:protocol:onboarding",
			},
			{
				label: "Initial Liquidity",
				percentage: 5,
				tokens: 50_000_000n * DECIMALS,
				recipient: "did:ensoul:protocol:liquidity",
			},
			{
				label: "Early Contributors",
				percentage: 5,
				tokens: 50_000_000n * DECIMALS,
				recipient: "did:ensoul:protocol:contributors",
			},
			{
				label: "Insurance Reserve",
				percentage: 5,
				tokens: 50_000_000n * DECIMALS,
				recipient: "did:ensoul:protocol:insurance",
			},
		],
		emissionPerBlock,
		networkRewardsPool: 500_000_000n * DECIMALS,
		protocolFees: {
			storageFeeProtocolShare: 10, // 10% to protocol treasury
			txBaseFee: 1000n,
		},
	};
}

/**
 * Validate that genesis allocations sum to 100%.
 */
export function validateGenesis(config: GenesisConfig): {
	valid: boolean;
	error?: string;
} {
	const totalPct = config.allocations.reduce(
		(sum, a) => sum + a.percentage,
		0,
	);
	if (totalPct !== 100) {
		return {
			valid: false,
			error: `Allocations sum to ${totalPct}%, expected 100%`,
		};
	}

	const totalTokens = config.allocations.reduce(
		(sum, a) => sum + a.tokens,
		0n,
	);
	if (totalTokens !== config.totalSupply) {
		return {
			valid: false,
			error: `Token allocations ${totalTokens} != total supply ${config.totalSupply}`,
		};
	}

	return { valid: true };
}
