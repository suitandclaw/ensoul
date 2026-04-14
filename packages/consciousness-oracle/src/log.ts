import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

let logPath = "";

export function setLogPath(p: string): void {
	logPath = p;
}

export async function log(msg: string): Promise<void> {
	const ts = new Date().toISOString();
	const line = `[${ts}] ${msg}\n`;
	process.stdout.write(line);
	if (logPath) {
		try {
			await mkdir(join(logPath, ".."), { recursive: true });
			await appendFile(logPath, line);
		} catch { /* non-fatal */ }
	}
}

export function sha256Short(s: string): string {
	// Simple FNV-1a hash for dedup IDs (sufficient, not cryptographic)
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
