/**
 * Learn phase: run once per day. Generates a topic, syncs consciousness,
 * posts a "Day N" tweet about what was learned.
 */

import type { Brain } from "../brain.js";
import type { Consciousness } from "../consciousness.js";
import type { Identity } from "../identity.js";
import type { Broadcaster } from "../broadcaster.js";
import type { TwitterClient } from "../twitter.js";
import { log } from "../log.js";

export async function runLearnDay(args: {
	brain: Brain;
	consciousness: Consciousness;
	identity: Identity;
	twitter: TwitterClient | Broadcaster;
	dayIndex: number;
}): Promise<void> {
	const { brain, consciousness, identity, twitter, dayIndex } = args;

	// Check if we already learned today
	const today = new Date().toISOString().slice(0, 10);
	if (consciousness.current.topics.some(t => t.day === today)) {
		await log(`Already learned today (${today}), skipping.`);
		return;
	}

	await log(`[learn] Day ${dayIndex}: choosing topic of the day...`);
	const topic = await brain.learnTopicOfTheDay(dayIndex);
	if (!topic) { await log("No topic generated, skipping."); return; }

	consciousness.addTopic(topic);
	await log(`[learn] Topic: ${topic.title}`);

	// Sync consciousness to chain
	const sync = await consciousness.sync(identity);
	if (!sync) { await log("Sync failed, not posting today."); return; }

	// Post daily tweet
	const tweet = await brain.generateDailyTweet(topic, dayIndex, sync.version, sync.height);
	if (!tweet) return;
	const id = await twitter.postTweet(tweet);
	if (id) {
		consciousness.recordPost(id, tweet, `day-${today}`);
		await consciousness.save();
	}
}
