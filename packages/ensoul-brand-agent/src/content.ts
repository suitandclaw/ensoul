/**
 * Loads pre-written educational posts from content/*.md.
 *
 * Each markdown file is one post or thread. If the file contains
 * "---" separator lines, they become a thread; otherwise it's a
 * single skeet.
 *
 * The agent rotates through files using a "least recently used"
 * strategy persisted in state.json so the same content does not
 * repeat for at least 10 days.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, "..", "content");

export interface ContentPick {
	filename: string;
	skeets: string[];
}

export async function listContent(): Promise<string[]> {
	try {
		const files = await readdir(CONTENT_DIR);
		return files.filter(f => f.endsWith(".md")).sort();
	} catch {
		return [];
	}
}

export async function loadContent(filename: string): Promise<ContentPick | null> {
	try {
		const raw = await readFile(join(CONTENT_DIR, filename), "utf-8");
		// Strip an optional H1 title line at the top
		const body = raw.replace(/^#\s+.+\n+/, "").trim();
		// Split on "---" lines
		const skeets = body.split(/\n\s*---\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
		// Truncate any over-280 skeets defensively
		const trimmed = skeets.map(s => s.length <= 280 ? s : s.slice(0, 277) + "...");
		return { filename, skeets: trimmed };
	} catch {
		return null;
	}
}

/**
 * Pick the next content file to post. Excludes any file used in the
 * last `recentlyUsed` array (most recent first). Returns the oldest
 * unused file. If all files are recent, returns the longest-ago one.
 */
export async function pickNext(recentlyUsed: string[]): Promise<ContentPick | null> {
	const all = await listContent();
	if (all.length === 0) {
		await log("No content files found in content/");
		return null;
	}
	// Files NOT in recentlyUsed are eligible first
	const fresh = all.filter(f => !recentlyUsed.includes(f));
	const candidate = fresh[0] ?? recentlyUsed[recentlyUsed.length - 1] ?? all[0];
	if (!candidate) return null;
	return await loadContent(candidate);
}
