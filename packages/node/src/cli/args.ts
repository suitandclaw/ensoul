/**
 * Parsed CLI arguments.
 */
export interface CliArgs {
	mode: "validate" | "fullnode" | "status" | "genesis";
	dataDir: string;
	genesisConfig: string;
	genesisOutput: string;
	genesisFile: string;
	storageGB: number;
	bootstrapPeers: string[];
	peers: string[];
	seed: string;
	publicUrl: string;
	storeConsciousness: string | null;
	port: number;
	apiPort: number;
	help: boolean;
	install: boolean;
	uninstall: boolean;
	noMinStake: boolean;
}

/** Default seed node URL. Empty means no seed unless --seed is provided. */
export const DEFAULT_SEED_URL = "";

const DEFAULT_DATA_DIR = "~/.ensoul";
const DEFAULT_STORAGE_GB = 10;
const DEFAULT_PORT = 9000;
const DEFAULT_API_PORT = 3000;

/**
 * Default bootstrap peers for the Ensoul mainnet.
 * These are Foundation-operated nodes for initial discovery.
 */
export const DEFAULT_BOOTSTRAP_PEERS: string[] = [
	"/ip4/bootstrap1.ensoul.dev/tcp/9000",
	"/ip4/bootstrap2.ensoul.dev/tcp/9000",
	"/ip4/bootstrap3.ensoul.dev/tcp/9000",
];

/**
 * Parse command-line arguments.
 */
export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		mode: "fullnode",
		dataDir: DEFAULT_DATA_DIR,
		genesisConfig: "",
		genesisOutput: "",
		genesisFile: "",
		storageGB: DEFAULT_STORAGE_GB,
		bootstrapPeers: [],
		peers: [],
		seed: DEFAULT_SEED_URL,
		publicUrl: "",
		storeConsciousness: null,
		port: DEFAULT_PORT,
		apiPort: DEFAULT_API_PORT,
		help: false,
		install: false,
		uninstall: false,
		noMinStake: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;

		if (arg === "--validate" || arg === "-v") {
			args.mode = "validate";
		} else if (arg === "genesis") {
			args.mode = "genesis";
		} else if (arg === "status") {
			args.mode = "status";
		} else if (arg === "--config" && argv[i + 1]) {
			args.genesisConfig = argv[++i]!;
		} else if (arg === "--output" && argv[i + 1]) {
			args.genesisOutput = argv[++i]!;
		} else if (arg === "--genesis" && argv[i + 1]) {
			args.genesisFile = argv[++i]!;
		} else if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else if (arg === "--data-dir" && argv[i + 1]) {
			args.dataDir = argv[++i]!;
		} else if (arg === "--storage" && argv[i + 1]) {
			args.storageGB = Number(argv[++i]);
		} else if (arg === "--bootstrap" && argv[i + 1]) {
			args.bootstrapPeers.push(argv[++i]!);
		} else if (arg === "--store-consciousness" && argv[i + 1]) {
			args.storeConsciousness = argv[++i]!;
		} else if (arg === "--port" && argv[i + 1]) {
			args.port = Number(argv[++i]);
		} else if (arg === "--api-port" && argv[i + 1]) {
			args.apiPort = Number(argv[++i]);
		} else if (arg === "--peers" && argv[i + 1]) {
			args.peers = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
		} else if (arg === "--seed" && argv[i + 1]) {
			args.seed = argv[++i]!;
		} else if (arg === "--public-url" && argv[i + 1]) {
			args.publicUrl = argv[++i]!;
		} else if (arg === "--no-min-stake") {
			args.noMinStake = true;
		} else if (arg === "--install") {
			args.install = true;
		} else if (arg === "uninstall" || arg === "--uninstall") {
			args.uninstall = true;
		}
	}

	if (args.bootstrapPeers.length === 0) {
		args.bootstrapPeers = DEFAULT_BOOTSTRAP_PEERS;
	}

	return args;
}

/**
 * Expand ~ in a path to the home directory.
 */
export function expandHome(path: string): string {
	if (path.startsWith("~/")) {
		const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
		return home + path.slice(1);
	}
	return path;
}

/**
 * Print help text.
 */
export function printHelp(): string {
	return `ensoul-node - Ensoul L1 validator and full node

USAGE:
  npx ensoul-node [OPTIONS]                Run as full node
  npx ensoul-node --validate               Run as validator (produce blocks)
  npx ensoul-node --validate --install     Install as auto-start service
  npx ensoul-node genesis --config <file>   Generate genesis block from config
  npx ensoul-node status                   Check service status
  npx ensoul-node uninstall                Remove the background service

OPTIONS:
  --validate, -v            Run as validator (participate in consensus)
  --install                 Install as a background service (auto-start, auto-restart)
  --data-dir <path>         Data directory (default: ~/.ensoul)
  --storage <GB>            Storage allocation in GB (default: 10)
  --peers <addrs>           Comma-separated peer addresses (host:port)
  --seed <url>              Seed node URL (no default, disabled unless set)
  --public-url <url>        This validator's public URL for seed registration
  --bootstrap <multiaddr>   Bootstrap peer (can specify multiple)
  --store-consciousness <path>  Store local consciousness while validating
  --port <port>             P2P port (default: 9000)
  --api-port <port>         API port (default: 3000)
  --genesis <file>          Load genesis block from file on startup
  --config <file>           Genesis config JSON (for genesis subcommand)
  --output <file>           Output path for generated genesis block
  --no-min-stake            Disable minimum stake requirement (bootstrap phase)
  --help, -h                Show this help

EXAMPLES:
  npx ensoul-node --validate
  npx ensoul-node --validate --install
  npx ensoul-node --validate --storage 50 --data-dir /data/ensoul
  npx ensoul-node --validate --bootstrap /ip4/192.168.1.100/tcp/9000
  npx ensoul-node --validate --peers 192.168.1.10:9000,192.168.1.11:9000
  npx ensoul-node status
  npx ensoul-node uninstall`;
}
