/**
 * Bluesky poster for the Consciousness Oracle.
 *
 * Uses the @atproto/api SDK with handle + app password auth.
 * App passwords are created at https://bsky.app/settings/app-passwords
 *
 * Bluesky thread semantics:
 *   - First post: agent.post({ text, createdAt })
 *     Response: { uri, cid }  -> these become the "root" of the thread
 *   - Subsequent posts: agent.post({
 *       text, createdAt,
 *       reply: { root: { uri, cid }, parent: { uri, cid } }
 *     })
 *     The "root" never changes within a thread; "parent" is the previous post.
 */

import { BskyAgent } from "@atproto/api";
import { log, errMsg } from "./log.js";

interface PostRef { uri: string; cid: string }

export class BlueskyPoster {
	private agent: BskyAgent | null = null;
	private readonly handle: string;
	private readonly appPassword: string;
	private readonly dryRun: boolean;
	private loggedIn = false;

	constructor(opts: { handle?: string; appPassword?: string; dryRun: boolean }) {
		this.handle = opts.handle ?? "";
		this.appPassword = opts.appPassword ?? "";
		this.dryRun = opts.dryRun;
		if (this.handle && this.appPassword) {
			this.agent = new BskyAgent({ service: "https://bsky.social" });
		}
	}

	isConfigured(): boolean { return this.agent !== null; }

	private async ensureLogin(): Promise<boolean> {
		if (this.loggedIn) return true;
		if (!this.agent) return false;
		try {
			await this.agent.login({ identifier: this.handle, password: this.appPassword });
			this.loggedIn = true;
			await log(`Bluesky logged in as ${this.handle}`);
			return true;
		} catch (e) {
			await log(`Bluesky login failed: ${errMsg(e)}`);
			return false;
		}
	}

	/** Post a single skeet. Returns the post URI (or fake in dry-run). */
	async postSkeet(text: string): Promise<string | null> {
		if (this.dryRun || !this.agent) {
			await log(`[DRY RUN bsky] Would post: ${text}`);
			return `dry-bsky-${Date.now()}`;
		}
		if (!(await this.ensureLogin())) return null;
		try {
			const result = await this.agent.post({
				text,
				createdAt: new Date().toISOString(),
			});
			await log(`Bluesky posted: ${result.uri}`);
			return result.uri;
		} catch (e) {
			await log(`Bluesky post failed: ${errMsg(e)}`);
			return null;
		}
	}

	/** Post a thread. First skeet via post(), subsequent via post() with reply refs. */
	async postThread(skeets: string[]): Promise<string[]> {
		if (skeets.length === 0) return [];

		if (this.dryRun || !this.agent) {
			await log(`[DRY RUN bsky] Would post thread (${skeets.length} skeets):`);
			for (let i = 0; i < skeets.length; i++) {
				await log(`  [${i + 1}/${skeets.length}] ${skeets[i]}`);
			}
			return skeets.map((_, i) => `dry-bsky-${Date.now()}-${i}`);
		}

		if (!(await this.ensureLogin())) return [];

		const uris: string[] = [];
		let root: PostRef | null = null;
		let parent: PostRef | null = null;

		for (let i = 0; i < skeets.length; i++) {
			const text = skeets[i] ?? "";
			try {
				const params: Record<string, unknown> = {
					text,
					createdAt: new Date().toISOString(),
				};
				if (root && parent) {
					params["reply"] = { root, parent };
				}
				const result = await this.agent.post(params as never);
				const ref: PostRef = { uri: result.uri, cid: result.cid };
				uris.push(result.uri);
				if (!root) root = ref;
				parent = ref;
				await log(`Bluesky posted ${i + 1}/${skeets.length}: ${result.uri}`);
				if (i < skeets.length - 1) await new Promise(r => setTimeout(r, 1000));
			} catch (e) {
				await log(`Bluesky thread failed at ${i + 1}/${skeets.length}: ${errMsg(e)}`);
				break;
			}
		}
		return uris;
	}
}
