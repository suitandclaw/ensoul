import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import type { CliArgs } from "./args.js";
import { expandHome } from "./args.js";

const LABEL = "dev.ensoul.validator";
const LAUNCH_DIR = join(homedir(), "Library", "LaunchAgents");
const LOG_DIR = join(homedir(), ".ensoul");

/** Result of a service operation. */
export interface ServiceResult {
	ok: boolean;
	message: string;
}

/**
 * Build the full plist file path for this validator.
 */
function plistPath(): string {
	return join(LAUNCH_DIR, `${LABEL}.plist`);
}

/**
 * Resolve the npx binary path.
 */
function findNpx(): string {
	try {
		return execSync("which npx", { encoding: "utf-8" }).trim();
	} catch {
		return "/usr/local/bin/npx";
	}
}

/**
 * Resolve the node bin directory for PATH.
 */
function nodeBinDir(): string {
	const npx = findNpx();
	const parts = npx.split("/");
	parts.pop();
	return parts.join("/");
}

/**
 * Build the launchd plist XML for a validator service.
 */
export function buildPlist(args: CliArgs): string {
	const npx = findNpx();
	const nodeDir = nodeBinDir();
	const home = homedir();
	const dataDir = expandHome(args.dataDir);
	const logFile = join(LOG_DIR, "validator.log");

	// Wrap with caffeinate -s to prevent system sleep while validating
	const programArgs = [
		`    <string>/usr/bin/caffeinate</string>`,
		`    <string>-s</string>`,
		`    <string>${npx}</string>`,
		`    <string>ensoul-node</string>`,
		`    <string>--validate</string>`,
		`    <string>--port</string>`,
		`    <string>${args.port}</string>`,
		`    <string>--api-port</string>`,
		`    <string>${args.apiPort}</string>`,
		`    <string>--data-dir</string>`,
		`    <string>${dataDir}</string>`,
	];

	if (args.storageGB !== 10) {
		programArgs.push(`    <string>--storage</string>`);
		programArgs.push(`    <string>${args.storageGB}</string>`);
	}

	// Pass through genesis and peers flags if set
	if (args.genesisFile) {
		programArgs.push(`    <string>--genesis</string>`);
		programArgs.push(`    <string>${args.genesisFile}</string>`);
	}

	if (args.peers.length > 0) {
		programArgs.push(`    <string>--peers</string>`);
		programArgs.push(`    <string>${args.peers.join(",")}</string>`);
	}

	if (args.noMinStake) {
		programArgs.push(`    <string>--no-min-stake</string>`);
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs.join("\n")}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logFile}</string>

  <key>StandardErrorPath</key>
  <string>${logFile}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${nodeDir}:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>`;
}

/**
 * Install the validator as a macOS launchd service.
 */
export async function installService(args: CliArgs): Promise<ServiceResult> {
	const os = platform();
	if (os !== "darwin") {
		return {
			ok: false,
			message: `Service installation is only supported on macOS for now. Detected: ${os}`,
		};
	}

	try {
		await mkdir(LAUNCH_DIR, { recursive: true });
		await mkdir(LOG_DIR, { recursive: true });
		await mkdir(expandHome(args.dataDir), { recursive: true });

		const plist = buildPlist(args);
		const path = plistPath();

		// Unload existing service first (ignore errors)
		try {
			execSync(
				`launchctl bootout gui/$(id -u) "${path}" 2>/dev/null`,
				{ stdio: "ignore" },
			);
		} catch {
			// Not loaded, that is fine
		}

		await writeFile(path, plist);

		execSync(`launchctl bootstrap gui/$(id -u) "${path}"`, {
			stdio: "ignore",
		});

		const logFile = join(LOG_DIR, "validator.log");
		return {
			ok: true,
			message: [
				"",
				"Validator installed as a background service.",
				"",
				"  - Runs in the background (close your terminal, it keeps running)",
				"  - Prevents your Mac from sleeping",
				"  - Auto-restarts if it crashes",
				"  - Starts automatically on boot",
				`  - Logs: tail -f ${logFile}`,
				"  - Stop: npx ensoul-node --uninstall",
				"",
				`  Plist:  ${path}`,
				`  Port:   ${args.port}`,
				`  API:    ${args.apiPort}`,
				`  Data:   ${expandHome(args.dataDir)}`,
			].join("\n"),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `Install failed: ${msg}` };
	}
}

/**
 * Uninstall the validator launchd service.
 */
export async function uninstallService(): Promise<ServiceResult> {
	const os = platform();
	if (os !== "darwin") {
		return {
			ok: false,
			message: `Service uninstall is only supported on macOS for now. Detected: ${os}`,
		};
	}

	const path = plistPath();

	try {
		execSync(`launchctl bootout gui/$(id -u) "${path}" 2>/dev/null`, {
			stdio: "ignore",
		});
	} catch {
		// May not be loaded
	}

	try {
		await unlink(path);
	} catch {
		return {
			ok: false,
			message: `No installed service found at ${path}`,
		};
	}

	return {
		ok: true,
		message: "Validator service removed.",
	};
}

/**
 * Check the status of the validator launchd service.
 */
export function checkServiceStatus(): ServiceResult {
	const os = platform();
	if (os !== "darwin") {
		return {
			ok: false,
			message: `Service status is only supported on macOS for now. Detected: ${os}`,
		};
	}

	try {
		const output = execSync("launchctl list", {
			encoding: "utf-8",
		});

		const lines = output.split("\n");
		const match = lines.find((l) => l.includes(LABEL));

		if (!match) {
			return {
				ok: true,
				message: "Validator service is not installed.",
			};
		}

		// launchctl list format: PID\tStatus\tLabel
		const parts = match.trim().split(/\t/);
		const pid = parts[0] ?? "-";
		const exitCode = parts[1] ?? "-";

		if (pid === "-") {
			return {
				ok: true,
				message: [
					"Validator service is installed but not running.",
					`  Last exit code: ${exitCode}`,
					`  Log: ${join(LOG_DIR, "validator.log")}`,
				].join("\n"),
			};
		}

		// Fetch live status from the local peer API
		let statusLine = "";
		try {
			const resp = execSync("curl -s http://localhost:9000/peer/status", { encoding: "utf-8", timeout: 3000 });
			const data = JSON.parse(resp) as { height: number; did: string; peerCount: number };
			statusLine = [
				`  Height: ${data.height}`,
				`  DID: ${data.did}`,
				`  Peers: ${data.peerCount}`,
			].join("\n");
		} catch {
			statusLine = "  (could not query local peer API)";
		}

		return {
			ok: true,
			message: [
				"Validator service is running.",
				`  PID: ${pid}`,
				statusLine,
				`  Log: ${join(LOG_DIR, "validator.log")}`,
			].join("\n"),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `Status check failed: ${msg}` };
	}
}
