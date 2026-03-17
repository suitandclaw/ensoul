import type { ClusterCommand } from "./types.js";

const DECIMALS = 10n ** 18n;
const DEFAULT_STAKE = 10_000n * DECIMALS;

/**
 * Parse command-line arguments for ensoul-cluster.
 */
export function parseClusterArgs(argv: string[]): ClusterCommand {
	const cmd: ClusterCommand = {
		command: "help",
		validators: 10,
		basePort: 9000,
		dataDir: "./ensoul-cluster",
		advertiseHost: "127.0.0.1",
		exportDids: null,
		importFiles: [],
		genesisFile: null,
		outputFile: null,
		stakePerValidator: DEFAULT_STAKE,
	};

	const first = argv[0];
	if (!first) return cmd;

	if (first === "init") cmd.command = "init";
	else if (first === "start") cmd.command = "start";
	else if (first === "stop") cmd.command = "stop";
	else if (first === "status") cmd.command = "status";
	else if (first === "genesis") cmd.command = "genesis";
	else cmd.command = "help";

	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;
		const next = argv[i + 1];

		if (arg === "--validators" && next) {
			cmd.validators = Number(next);
			i++;
		} else if (arg === "--base-port" && next) {
			cmd.basePort = Number(next);
			i++;
		} else if (arg === "--data-dir" && next) {
			cmd.dataDir = next;
			i++;
		} else if (arg === "--advertise-host" && next) {
			cmd.advertiseHost = next;
			i++;
		} else if (arg === "--export-dids" && next) {
			cmd.exportDids = next;
			i++;
		} else if (arg === "--import" && next) {
			cmd.importFiles = next.split(",");
			i++;
		} else if (arg === "--genesis" && next) {
			cmd.genesisFile = next;
			i++;
		} else if (arg === "--output" && next) {
			cmd.outputFile = next;
			i++;
		} else if (arg === "--stake" && next) {
			cmd.stakePerValidator = BigInt(next) * DECIMALS;
			i++;
		}
	}

	return cmd;
}

/**
 * Print help text for ensoul-cluster.
 */
export function printClusterHelp(): string {
	return `ensoul-cluster - Multi-validator cluster management for Ensoul L1

USAGE:
  ensoul-cluster init --validators <N> --base-port <port> --data-dir <path>
  ensoul-cluster start [--data-dir <path>] [--genesis <file>]
  ensoul-cluster stop [--data-dir <path>]
  ensoul-cluster status [--data-dir <path>]
  ensoul-cluster genesis --import <file1,file2,...> --output <file>

INIT OPTIONS:
  --validators <N>        Number of validators (default: 10)
  --base-port <port>      Base P2P port (default: 9000)
  --data-dir <path>       Data directory (default: ./ensoul-cluster)
  --advertise-host <ip>   External IP for cross-machine setup (default: 127.0.0.1)
  --export-dids <file>    Export DID list for genesis coordination
  --stake <amount>        Stake per validator in ENSL (default: 10000)

START OPTIONS:
  --data-dir <path>       Data directory containing cluster.json
  --genesis <file>        Use external genesis file (for cross-machine setup)

GENESIS COORDINATION:
  --import <files>        Comma-separated DID export files to merge
  --output <file>         Output genesis file path

EXAMPLES:
  # Single machine with 10 validators
  ensoul-cluster init --validators 10 --base-port 9000 --data-dir /data/ensoul
  ensoul-cluster start --data-dir /data/ensoul

  # Cross-machine setup (run on each machine)
  ensoul-cluster init --validators 10 --base-port 9000 --data-dir /data/ensoul \\
    --advertise-host 192.168.1.10 --export-dids dids-machine1.json

  # Coordinator merges all DIDs into genesis
  ensoul-cluster genesis --import dids-m1.json,dids-m2.json,dids-m3.json,dids-m4.json \\
    --output genesis.json

  # Start with external genesis (all machines)
  ensoul-cluster start --data-dir /data/ensoul --genesis genesis.json`;
}
