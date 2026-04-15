/**
 * Announce phase: Friday 3-4pm EST. Three countdown tweets.
 */

import type { Brain } from "../brain.js";
import type { Consciousness } from "../consciousness.js";
import type { Identity } from "../identity.js";
import type { Broadcaster } from "../broadcaster.js";
import type { TwitterClient } from "../twitter.js";
import { log } from "../log.js";
import { countdownBucket } from "../scheduler.js";

export async function maybeAnnounce(args: {
	brain: Brain;
	consciousness: Consciousness;
	identity: Identity;
	twitter: TwitterClient | Broadcaster;
	apiUrl: string;
}): Promise<void> {
	const { brain, consciousness, identity, twitter, apiUrl } = args;
	const bucket = countdownBucket();
	if (!bucket) return;

	const tag = `announce-${bucket}`;
	if (consciousness.current.posts.some(p => (p as unknown as { tag?: string }).tag === tag)) {
		return; // already posted this bucket
	}

	// For T-60 and T-5 we do a final sync; for T-30 just use latest
	if (bucket === "t60" || bucket === "t5") {
		const s = await consciousness.sync(identity);
		if (!s) { await log(`[announce ${bucket}] sync failed`); return; }
	}

	const pointer = identity.getLastOnChain();
	if (!pointer) { await log(`[announce ${bucket}] no on-chain pointer yet`); return; }

	// Get current validator count from API (best-effort)
	let validatorCount = 21;
	try {
		const res = await fetch(`${apiUrl}/v1/network/status`);
		if (res.ok) {
			const d = await res.json() as { validatorCount?: number };
			validatorCount = d.validatorCount ?? 21;
		}
	} catch { /* non-fatal */ }

	const tweet = await brain.generateAnnouncement(bucket, pointer.version, pointer.blockHeight, pointer.stateRoot, validatorCount);
	if (!tweet) return;

	const id = await twitter.postTweet(tweet);
	if (id) {
		consciousness.recordPost(id, tweet, tag);
		await consciousness.save();
		await log(`[announce ${bucket}] posted tweet ${id}`);
	}
}
