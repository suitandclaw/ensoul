#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseClusterArgs, printClusterHelp } from "./cli.js";
import { loadGenesisFile, mergeGenesisDids } from "./genesis.js";
import { initCluster } from "./init.js";
import {
	ProcessManager,
	formatStatusTable,
	loadClusterStatus,
} from "./manager.js";
import type { ClusterConfig } from "./types.js";

/**
 * Write a line to stdout (avoids console.log for biome compliance).
 */
function out(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

/**
 * Structured log to stderr.
 */
function log(msg: string): void {
	process.stderr.write(`[ensoul-cluster] ${msg}\n`);
}

/**
 * Main entry point for the ensoul-cluster CLI.
 */
async function main(): Promise<void> {
	const cmd = parseClusterArgs(process.argv.slice(2));

	switch (cmd.command) {
		case "help": {
			out(printClusterHelp());
			break;
		}

		case "init": {
			const result = await initCluster(
				{
					validators: cmd.validators,
					basePort: cmd.basePort,
					dataDir: cmd.dataDir,
					advertiseHost: cmd.advertiseHost,
					exportDids: cmd.exportDids,
					stakePerValidator: cmd.stakePerValidator,
				},
				log,
			);

			out("");
			out("Cluster initialized:");
			out(`  Validators: ${result.config.validators.length}`);
			out(`  Bootstrap:  ${result.config.bootstrapPeer}`);
			out(`  Data dir:   ${cmd.dataDir}`);
			out("");
			out("Validator DIDs:");
			for (const v of result.config.validators) {
				out(
					`  ${v.index}: ${v.did} (port ${v.port}, api ${v.apiPort})`,
				);
			}
			break;
		}

		case "start": {
			const configPath = join(cmd.dataDir, "cluster.json");
			const configContent = await readFile(configPath, "utf-8");
			const config = JSON.parse(configContent) as ClusterConfig;

			let genesisOverride = undefined;
			if (cmd.genesisFile) {
				genesisOverride = await loadGenesisFile(cmd.genesisFile);
			}

			const manager = new ProcessManager();
			await manager.startAll(
				config,
				cmd.dataDir,
				genesisOverride,
				log,
			);

			// Print aggregated status periodically
			const statusInterval = setInterval(() => {
				const statuses = manager.getStatuses();
				const running = manager.getRunningCount();
				out(
					`\n[status] ${running}/${statuses.length} validators running`,
				);
				out(formatStatusTable(statuses));
			}, 30000);

			// Graceful shutdown
			const shutdown = async (): Promise<void> => {
				clearInterval(statusInterval);
				await manager.stopAll(log);
				process.exit(0);
			};

			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());
			break;
		}

		case "stop": {
			const statuses = await loadClusterStatus(cmd.dataDir);
			for (const s of statuses) {
				if (s.status === "running" && s.pid) {
					try {
						process.kill(s.pid, "SIGTERM");
						log(
							`Sent SIGTERM to validator-${s.index} (pid ${s.pid})`,
						);
					} catch {
						log(
							`validator-${s.index} (pid ${s.pid}) already stopped`,
						);
					}
				}
			}
			log(
				"Stop signals sent. Use 'ensoul-cluster status' to verify.",
			);
			break;
		}

		case "status": {
			const statuses = await loadClusterStatus(cmd.dataDir);
			out(formatStatusTable(statuses));
			const running = statuses.filter(
				(s) => s.status === "running",
			).length;
			out(`\n${running}/${statuses.length} validators running`);
			break;
		}

		case "genesis": {
			if (cmd.importFiles.length === 0) {
				process.stderr.write(
					"Error: --import required for genesis command\n",
				);
				process.exit(1);
			}
			if (!cmd.outputFile) {
				process.stderr.write(
					"Error: --output required for genesis command\n",
				);
				process.exit(1);
			}

			await mergeGenesisDids(
				{
					importFiles: cmd.importFiles,
					outputFile: cmd.outputFile,
					stakePerValidator: cmd.stakePerValidator,
				},
				log,
			);

			out(`Genesis file written to ${cmd.outputFile}`);
			break;
		}
	}
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`Fatal: ${message}\n`);
	process.exit(1);
});
