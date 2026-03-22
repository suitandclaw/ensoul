/**
 * Generate bootstrap agent identities.
 * Called by bootstrap-agents.sh --generate
 *
 * Uses Node.js built-in crypto only (no external dependencies).
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
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

function bytesToHex(buf: Uint8Array): string {
	return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
	let num = 0n;
	for (const byte of bytes) num = num * 256n + BigInt(byte);
	let encoded = "";
	while (num > 0n) {
		encoded = B58[Number(num % 58n)] + encoded;
		num = num / 58n;
	}
	for (const byte of bytes) {
		if (byte === 0) encoded = "1" + encoded;
		else break;
	}
	return encoded;
}

function deriveDid(publicKey: Uint8Array): string {
	const mc = new Uint8Array(2 + publicKey.length);
	mc[0] = 0xed;
	mc[1] = 0x01;
	mc.set(publicKey, 2);
	return `did:key:z${base58btcEncode(mc)}`;
}

/** Ed25519 PKCS8 DER prefix for a 32-byte seed. */
const PKCS8_PREFIX = Buffer.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
	0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function ed25519PubFromSeed(seed: Uint8Array): Uint8Array {
	const pkcs8 = Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]);
	const privKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
	const pubKey = createPublicKey(privKey);
	const spki = pubKey.export({ type: "spki", format: "der" });
	// SPKI DER for Ed25519: 12-byte header + 32-byte raw public key
	return new Uint8Array(spki.subarray(12));
}

function main(): void {
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

		const seed = new Uint8Array(32);
		seed[0] = i & 0xff;
		seed[1] = (i >> 8) & 0xff;
		seed[2] = 0x42;
		seed[3] = 0xae;
		seed[4] = 0xb0;
		seed[5] = 0x07;

		const publicKey = ed25519PubFromSeed(seed);
		const did = deriveDid(publicKey);

		const data = {
			did,
			publicKey: bytesToHex(publicKey),
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

main();
