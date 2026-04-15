/**
 * Bluesky client for the brand agent. Single-skeet and thread posting
 * via @atproto/api with handle + app password auth.
 */

import { BskyAgent } from "@atproto/api";
import { log, errMsg } from "./log.js";

interface PostRef { uri: string; cid: string }

export class BlueskyClient {
	private agent: BskyAgent | null;
	private readonly handle: string;
	private readonly appPassword: string;
	private readonly dryRun: boolean;
	private loggedIn = false;

	constructor(opts: { handle?: string; appPassword?: string; dryRun: boolean }) {
		this.handle = opts.handle ?? "";
		this.appPassword = opts.appPassword ?? "";
		this.dryRun = opts.dryRun;
		this.agent = (this.handle && this.appPassword)
			? new BskyAgent({ service: "https://bsky.social" })
			: null;
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

	async postSkeet(text: string): Promise<string | null> {
		if (this.dryRun || !this.agent) {
			await log(`[DRY RUN] post: ${text}`);
			return `dry-${Date.now()}`;
		}
		if (!(await this.ensureLogin())) return null;
		try {
			const result = await this.agent.post({
				text,
				createdAt: new Date().toISOString(),
			});
			await log(`Posted: ${result.uri}`);
			return result.uri;
		} catch (e) {
			await log(`Post failed: ${errMsg(e)}`);
			return null;
		}
	}

	async postThread(skeets: string[]): Promise<string[]> {
		if (skeets.length === 0) return [];
		if (this.dryRun || !this.agent) {
			for (let i = 0; i < skeets.length; i++) {
				await log(`[DRY RUN] thread[${i + 1}/${skeets.length}]: ${skeets[i]}`);
			}
			return skeets.map((_, i) => `dry-${Date.now()}-${i}`);
		}
		if (!(await this.ensureLogin())) return [];

		const uris: string[] = [];
		let root: PostRef | null = null;
		let parent: PostRef | null = null;

		for (let i = 0; i < skeets.length; i++) {
			const text = skeets[i] ?? "";
			try {
				const params: Record<string, unknown> = { text, createdAt: new Date().toISOString() };
				if (root && parent) params["reply"] = { root, parent };
				const result = await this.agent.post(params as never);
				const ref: PostRef = { uri: result.uri, cid: result.cid };
				uris.push(result.uri);
				if (!root) root = ref;
				parent = ref;
				await log(`Posted ${i + 1}/${skeets.length}: ${result.uri}`);
				if (i < skeets.length - 1) await new Promise(r => setTimeout(r, 1000));
			} catch (e) {
				await log(`Thread failed at ${i + 1}: ${errMsg(e)}`);
				break;
			}
		}
		return uris;
	}
}
