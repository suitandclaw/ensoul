/**
 * Generate bootstrap agent identities.
 * Called by bootstrap-agents.sh --generate
 */

import { createIdentity, bytesToHex } from "@ensoul/identity";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = join(homedir(), ".ensoul", "bootstrap-agents");
const TOTAL = 587;

const TYPES = [
	"research-agent", "trading-bot", "analyst-agent", "data-collector",
	"sentiment-tracker", "portfolio-manager", "news-monitor", "code-reviewer",
	"market-maker", "risk-assessor", "signal-processor", "content-curator",
	"audit-agent", "compliance-bot", "forecast-engine",
];

async function main(): Promise<void> {
	mkdirSync(AGENT_DIR, { recursive: true });

	let created = 0;
	let skipped = 0;

	for (let i = 0; i < TOTAL; i++) {
		const typeIdx = i % TYPES.length;
		const type = TYPES[typeIdx]!;
		const name = `${type}-${String(i).padStart(3, "0")}`;
		const file = join(AGENT_DIR, `${name}.json`);

		if (existsSync(file)) {
			skipped++;
			continue;
		}

		// Deterministic seed from index for reproducibility
		const seed = new Uint8Array(32);
		seed[0] = i & 0xff;
		seed[1] = (i >> 8) & 0xff;
		seed[2] = 0x42;
		seed[3] = 0xae;
		seed[4] = 0xb0;
		seed[5] = 0x07; // salt bytes for uniqueness

		const identity = await createIdentity({ seed });
		const data = {
			did: identity.did,
			publicKey: identity.toJSON().publicKey,
			seed: bytesToHex(seed),
			name,
			type,
			registered: false,
			stored: false,
			storeCount: 0,
			lastStore: 0,
		};

		writeFileSync(file, JSON.stringify(data, null, 2));
		created++;

		if (created % 100 === 0) {
			process.stdout.write(`Generated ${created}/${TOTAL}...\n`);
		}
	}

	process.stdout.write(`Generated ${created} new, skipped ${skipped} existing.\n`);
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err}\n`);
	process.exit(1);
});
