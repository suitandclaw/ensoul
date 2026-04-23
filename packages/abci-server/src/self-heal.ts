/**
 * Self-Heal: Background service file watchdog.
 *
 * Every hour, compares live systemd service files against canonical
 * templates shipped in the repo. If critical fields are missing or
 * wrong (e.g. ExecStopPost absent), rewrites the service file from
 * the template and runs `systemctl daemon-reload`.
 *
 * This eliminates the need for operators to manually run repair.sh
 * and ensures every validator self-corrects after a SOFTWARE_UPGRADE
 * delivers the templates.
 *
 * Only runs on Linux with systemd. No-ops silently on macOS.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { platform, homedir } from "node:os";
import { appendFileSync } from "node:fs";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const LOG_PATH = join(homedir(), ".ensoul", "self-heal.log");

// Critical fields that MUST be present in the ABCI service file.
// If any are missing, the service file is regenerated.
const CRITICAL_FIELDS = [
	"ExecStopPost",
	"TimeoutStopSec",
	"KillMode",
] as const;

interface Environment {
	user: string;
	home: string;
	repoPath: string;
	daemonHome: string;
	dataDir: string;
	nodeBinDir: string;
}

function log(msg: string): void {
	const ts = new Date().toISOString();
	const line = `[${ts}] [self-heal] ${msg}\n`;
	process.stdout.write(line);
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		appendFileSync(LOG_PATH, line);
	} catch {
		// Best-effort logging
	}
}

function detectEnvironment(): Environment | null {
	if (platform() !== "linux") return null;

	// Detect repo path from ENSOUL_REPO env or cwd
	const repoPath = process.env["ENSOUL_REPO"]
		?? process.cwd();

	if (!existsSync(join(repoPath, "package.json"))) return null;

	const home = process.env["HOME"] ?? homedir();
	const user = process.env["USER"]
		?? execSafe("whoami")
		?? "root";

	const daemonHome = process.env["DAEMON_HOME"]
		?? join(home, ".cometbft-ensoul", "node");

	const dataDir = join(home, ".ensoul");

	// Find node binary directory
	const nodeBin = execSafe("which node") ?? "/usr/local/bin/node";
	const nodeBinDir = dirname(nodeBin);

	return { user, home, repoPath, daemonHome, dataDir, nodeBinDir };
}

function execSafe(cmd: string): string | null {
	try {
		return execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
	} catch {
		return null;
	}
}

function renderTemplate(templatePath: string, env: Environment, liveServicePath: string): string {
	let content = readFileSync(templatePath, "utf8");

	// Replace template variables
	content = content.replace(/\{\{USER\}\}/g, env.user);
	content = content.replace(/\{\{HOME\}\}/g, env.home);
	content = content.replace(/\{\{REPO_PATH\}\}/g, env.repoPath);
	content = content.replace(/\{\{DAEMON_HOME\}\}/g, env.daemonHome);
	content = content.replace(/\{\{DATA_DIR\}\}/g, env.dataDir);
	content = content.replace(/\{\{NODE_BIN_DIR\}\}/g, env.nodeBinDir);

	// Preserve extra Environment= lines from the live service file
	// that aren't in the template (e.g. ENSOUL_ADMIN_KEY, NVM_DIR)
	const extraEnvLines = extractExtraEnvVars(liveServicePath, content);
	content = content.replace(/\{\{ENV_VARS\}\}\n?/, extraEnvLines);

	return content;
}

function extractExtraEnvVars(liveServicePath: string, renderedTemplate: string): string {
	if (!existsSync(liveServicePath)) return "";

	const liveContent = readFileSync(liveServicePath, "utf8");
	const liveEnvLines = liveContent
		.split("\n")
		.filter(l => l.startsWith("Environment="));

	const templateEnvKeys = new Set(
		renderedTemplate
			.split("\n")
			.filter(l => l.startsWith("Environment="))
			.map(l => l.split("=")[1]) // key from Environment=KEY=value
	);

	const extras = liveEnvLines.filter(l => {
		const key = l.split("=")[1];
		return !templateEnvKeys.has(key);
	});

	return extras.length > 0 ? extras.join("\n") + "\n" : "";
}

interface ServiceCheck {
	name: string;
	templateFile: string;
	liveFile: string;
}

function getServiceChecks(repoPath: string): ServiceCheck[] {
	return [
		{
			name: "ensoul-abci",
			templateFile: join(repoPath, "scripts/templates/ensoul-abci.service"),
			liveFile: "/etc/systemd/system/ensoul-abci.service",
		},
		{
			name: "ensoul-cometbft",
			templateFile: join(repoPath, "scripts/templates/ensoul-cometbft.service"),
			liveFile: "/etc/systemd/system/ensoul-cometbft.service",
		},
		{
			name: "ensoul-heartbeat",
			templateFile: join(repoPath, "scripts/templates/ensoul-heartbeat.service"),
			liveFile: "/etc/systemd/system/ensoul-heartbeat.service",
		},
	];
}

function checkCriticalFields(liveContent: string): string[] {
	const missing: string[] = [];
	for (const field of CRITICAL_FIELDS) {
		if (!liveContent.includes(field)) {
			missing.push(field);
		}
	}
	return missing;
}

function healService(check: ServiceCheck, env: Environment): boolean {
	if (!existsSync(check.templateFile)) {
		log(`Template not found: ${check.templateFile} — skipping ${check.name}`);
		return false;
	}

	if (!existsSync(check.liveFile)) {
		log(`Service file not installed: ${check.liveFile} — skipping ${check.name}`);
		return false;
	}

	const liveContent = readFileSync(check.liveFile, "utf8");
	const missing = checkCriticalFields(liveContent);

	if (missing.length === 0) {
		return false; // Healthy
	}

	log(`${check.name}: missing critical fields: ${missing.join(", ")}`);

	// Render canonical template
	const rendered = renderTemplate(check.templateFile, env, check.liveFile);

	// Back up live file before overwriting
	const backupPath = `${check.liveFile}.bak.${Date.now()}`;
	try {
		writeFileSync(backupPath, liveContent);
		log(`Backed up ${check.liveFile} to ${backupPath}`);
	} catch (err) {
		log(`WARNING: could not back up ${check.liveFile}: ${err}`);
		// Continue anyway — the fix is more important than the backup
	}

	// Write new service file
	writeFileSync(check.liveFile, rendered);
	log(`Rewrote ${check.liveFile} from template`);

	return true;
}

function runHealCycle(env: Environment): void {
	const checks = getServiceChecks(env.repoPath);
	let anyChanged = false;

	for (const check of checks) {
		try {
			if (healService(check, env)) {
				anyChanged = true;
			}
		} catch (err) {
			log(`ERROR healing ${check.name}: ${err}`);
		}
	}

	if (anyChanged) {
		log("Running systemctl daemon-reload...");
		try {
			execSync("systemctl daemon-reload", { timeout: 10000 });
			log("daemon-reload complete. Changes take effect on next service stop/start.");
		} catch (err) {
			log(`ERROR: daemon-reload failed: ${err}`);
		}
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startHealer(): void {
	const env = detectEnvironment();
	if (!env) {
		// Not Linux or not a valid repo — silently skip
		return;
	}

	log("Self-heal watchdog started (1h interval)");

	// Run immediately on startup
	try {
		runHealCycle(env);
	} catch (err) {
		log(`ERROR on initial heal cycle: ${err}`);
	}

	// Then every hour
	timer = setInterval(() => {
		try {
			runHealCycle(env);
		} catch (err) {
			log(`ERROR on heal cycle: ${err}`);
		}
	}, INTERVAL_MS);

	// Don't prevent process exit
	if (timer && typeof timer === "object" && "unref" in timer) {
		timer.unref();
	}
}

export function stopHealer(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
		log("Self-heal watchdog stopped");
	}
}
