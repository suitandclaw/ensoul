import { readdir, mkdir, cp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "../version.js";

const SNAPSHOT_DIR = join(homedir(), ".ensoul", "snapshots");
const MAX_SNAPSHOTS = 5;

/** Metadata stored alongside each snapshot. */
interface SnapshotMeta {
	timestamp: string;
	version: string;
	height: number;
	genesisHash: string;
	validatorDir: string;
}

/**
 * Create a snapshot of a validator's chain data.
 * Copies the chain/ directory to ~/.ensoul/snapshots/<timestamp>/.
 */
export async function createSnapshot(
	validatorDir: string,
	height: number,
	genesisHash: string,
): Promise<string> {
	await mkdir(SNAPSHOT_DIR, { recursive: true });

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const snapshotPath = join(SNAPSHOT_DIR, ts);
	const chainDir = join(validatorDir, "chain");

	await mkdir(snapshotPath, { recursive: true });

	// Copy chain directory if it exists
	try {
		await cp(chainDir, join(snapshotPath, "chain"), { recursive: true });
	} catch {
		// No chain dir to copy (fresh validator)
	}

	// Copy identity.json if present
	try {
		await cp(
			join(validatorDir, "identity.json"),
			join(snapshotPath, "identity.json"),
		);
	} catch {
		// No identity file
	}

	// Write metadata
	const meta: SnapshotMeta = {
		timestamp: new Date().toISOString(),
		version: VERSION,
		height,
		genesisHash,
		validatorDir,
	};
	await writeFile(
		join(snapshotPath, "snapshot.json"),
		JSON.stringify(meta, null, 2),
	);

	// Prune old snapshots (keep last MAX_SNAPSHOTS)
	await pruneSnapshots();

	return snapshotPath;
}

/**
 * Restore the most recent snapshot for a validator.
 * Replaces the chain/ directory with the snapshot copy.
 */
export async function rollbackToLatest(
	validatorDir: string,
): Promise<{ restored: boolean; snapshot?: string; meta?: SnapshotMeta }> {
	const snapshots = await listSnapshots();
	if (snapshots.length === 0) {
		return { restored: false };
	}

	// Find most recent snapshot for this validator dir
	for (const snap of snapshots) {
		if (snap.meta.validatorDir === validatorDir || !snap.meta.validatorDir) {
			const chainDest = join(validatorDir, "chain");
			const chainSrc = join(snap.path, "chain");

			// Remove current chain data
			try { await rm(chainDest, { recursive: true }); } catch { /* ok */ }

			// Restore from snapshot
			try {
				await cp(chainSrc, chainDest, { recursive: true });
			} catch {
				// Snapshot had no chain dir
			}

			return { restored: true, snapshot: snap.path, meta: snap.meta };
		}
	}

	return { restored: false };
}

/**
 * List all snapshots, newest first.
 */
export async function listSnapshots(): Promise<
	Array<{ path: string; meta: SnapshotMeta }>
> {
	try {
		await mkdir(SNAPSHOT_DIR, { recursive: true });
		const entries = await readdir(SNAPSHOT_DIR);
		const snapshots: Array<{ path: string; meta: SnapshotMeta }> = [];

		for (const entry of entries) {
			const metaPath = join(SNAPSHOT_DIR, entry, "snapshot.json");
			try {
				const raw = await readFile(metaPath, "utf-8");
				const meta = JSON.parse(raw) as SnapshotMeta;
				snapshots.push({ path: join(SNAPSHOT_DIR, entry), meta });
			} catch {
				// Not a valid snapshot
			}
		}

		// Sort newest first
		snapshots.sort((a, b) =>
			b.meta.timestamp.localeCompare(a.meta.timestamp),
		);

		return snapshots;
	} catch {
		return [];
	}
}

/**
 * Remove old snapshots, keeping only the last MAX_SNAPSHOTS.
 */
async function pruneSnapshots(): Promise<void> {
	const snapshots = await listSnapshots();
	if (snapshots.length <= MAX_SNAPSHOTS) return;

	const toRemove = snapshots.slice(MAX_SNAPSHOTS);
	for (const snap of toRemove) {
		try {
			await rm(snap.path, { recursive: true });
		} catch {
			// Non-fatal
		}
	}
}
