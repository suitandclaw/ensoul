import { loadGenesisBlock } from "../packages/node/src/cli/genesis-cmd.js";

async function main() {
	try {
		const result = await loadGenesisBlock("genesis-config-v3.json");
		console.log("SUCCESS");
		console.log("Block height:", result.block.height);
		console.log("Txs:", result.block.transactions.length);
		console.log("Config chainId:", result.config.chainId);
		console.log(
			"AutoStake:",
			result.config.allocations.filter((a) => a.autoStake).length,
		);
	} catch (err) {
		console.error("FAILED:", err);
	}
}

main();
