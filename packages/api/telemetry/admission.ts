// DID admission check for heartbeat telemetry.
// Accepts heartbeats only from DIDs in the active CometBFT validator set
// or the approved Pioneer application set.

interface PioneerApp {
  did: string;
  status: string;
}

interface CacheEntry {
  admitted: boolean;
  cachedAt: number;
}

type AbciQueryFn = (path: string) => Promise<Record<string, unknown> | null>;
type PioneerAppsGetter = () => PioneerApp[];

const CACHE_TTL_MS = 60_000;

export class AdmissionChecker {
  private readonly abciQuery: AbciQueryFn;
  private readonly getPioneerApps: PioneerAppsGetter;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(abciQuery: AbciQueryFn, getPioneerApps: PioneerAppsGetter) {
    this.abciQuery = abciQuery;
    this.getPioneerApps = getPioneerApps;
  }

  async isAdmitted(did: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(did);
    // Cache hits: only trust positive results within TTL.
    // Negative results re-check every time to handle just-approved
    // Pioneers and just-removed validators promptly.
    if (cached && cached.admitted && now - cached.cachedAt < CACHE_TTL_MS) {
      return true;
    }

    const admitted = await this.checkOnChain(did);
    if (admitted) {
      this.cache.set(did, { admitted: true, cachedAt: now });
    } else {
      // Clear any stale positive cache entry
      this.cache.delete(did);
    }
    return admitted;
  }

  private async checkOnChain(did: string): Promise<boolean> {
    // Check active CometBFT validator set via ABCI
    try {
      const result = await this.abciQuery("/validators");
      if (result && Array.isArray(result)) {
        for (const v of result) {
          if (v && (v as Record<string, unknown>).did === did) return true;
        }
      }
    } catch {
      // ABCI unreachable: fall through to Pioneer check
    }

    // Check approved Pioneer applications (live getter, reflects runtime approvals)
    for (const app of this.getPioneerApps()) {
      if (app.did === did && app.status === "approved") return true;
    }

    return false;
  }
}
