// Per-IP and per-DID sliding window rate limiters for heartbeat telemetry.
// Per-IP runs BEFORE signature verification (step 0).
// Per-DID runs AFTER signature verification (step 7).

import { TELEMETRY_CONFIG } from "./types.js";

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly perIp = new Map<string, number[]>();
  private readonly perDid = new Map<string, number[]>();

  checkPerIp(ip: string): RateLimitResult {
    return this.check(this.perIp, ip, TELEMETRY_CONFIG.PER_IP_MAX_PER_MIN);
  }

  checkPerDid(did: string): RateLimitResult {
    return this.check(this.perDid, did, TELEMETRY_CONFIG.PER_DID_MAX_PER_MIN);
  }

  /** Remove keys whose last entry is older than the window. */
  gc(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, timestamps] of this.perIp) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
        this.perIp.delete(key);
      }
    }
    for (const [key, timestamps] of this.perDid) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
        this.perDid.delete(key);
      }
    }
  }

  private check(
    store: Map<string, number[]>,
    key: string,
    maxPerMinute: number,
  ): RateLimitResult {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    let timestamps = store.get(key);
    if (!timestamps) {
      timestamps = [];
      store.set(key, timestamps);
    }

    // Prune entries outside the window
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxPerMinute) {
      // Oldest entry in window determines when the next slot opens
      const retryAfter = Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    // Record AFTER the allowed check (atomic: avoids off-by-one under load)
    timestamps.push(now);
    return { allowed: true };
  }
}
