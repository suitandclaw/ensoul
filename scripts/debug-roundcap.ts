import { createIdentity } from "../packages/identity/src/index.js";
import { createDefaultGenesis } from "../packages/ledger/src/index.js";
import { NodeBlockProducer } from "../packages/node/src/chain/producer.js";
import { TendermintConsensus } from "../packages/node/src/chain/tendermint.js";

async function main() {
	const v1 = await createIdentity({ seed: new Uint8Array(32).fill(1) });
	const v2 = await createIdentity({ seed: new Uint8Array(32).fill(2) });
	const v3 = await createIdentity({ seed: new Uint8Array(32).fill(3) });
	const dids = [v1.did, v2.did, v3.did].sort();

	const genesis = createDefaultGenesis(dids);
	const producer = new NodeBlockProducer(genesis, { minimumStake: 0n });
	producer.initGenesis(dids);
	for (const did of dids) producer.getState().joinConsensus(did);

	console.log("Producer height:", producer.getHeight());
	console.log("My DID:", dids[2]!.slice(0, 30));

	const c = new TendermintConsensus(producer, dids[2]!, {
		thresholdFraction: 0.5,
		proposeTimeoutMs: 10,
		prevoteTimeoutMs: 10,
		precommitTimeoutMs: 10,
		roundTimeoutIncrement: 1,
		commitTimeoutMs: 0,
		minBlockIntervalMs: 0,
	});
	c.onBroadcast = () => {};
	const logs: string[] = [];
	c.onLog = (msg: string) => logs.push(msg);
	c.start(1);

	await new Promise((r) => setTimeout(r, 3000));
	c.stop();

	const roundNums = logs
		.filter((l) => l.includes(" R="))
		.map((l) => {
			const m = l.match(/R=(\d+)/);
			return m ? parseInt(m[1], 10) : 0;
		});
	const maxRound = roundNums.length > 0 ? Math.max(...roundNums) : 0;

	console.log("Max round reached:", maxRound);
	console.log("Total log lines:", logs.length);
	console.log(
		"Round cap hits:",
		logs.filter((l) => l.includes("Round cap")).length,
	);
	console.log(
		"Chain catch-up hits:",
		logs.filter((l) => l.includes("catching up")).length,
	);
	console.log("First 5 logs:", logs.slice(0, 5));
	console.log("Last 5 logs:", logs.slice(-5));
}

main();
