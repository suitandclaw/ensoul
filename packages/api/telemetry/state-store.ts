// In-memory telemetry state with atomic JSON persistence.
// Loaded at API boot, flushed to disk every 60s.
// Boot-resume logic: DIDs loaded in unhealthy/offline state are marked
// bootResumed=true so the first health tick does not fire a redundant
// alert (spec Section 8 rule 5).

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { TELEMETRY_CONFIG } from "./types.js";
import type { ValidatorTelemetry, ContactRegistration } from "./types.js";

export class StateStore {
  private readonly state = new Map<string, ValidatorTelemetry>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly stateFile: string;

  constructor(stateFile?: string) {
    this.stateFile = stateFile ?? TELEMETRY_CONFIG.STATE_FILE;
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, "utf-8");
      const entries: ValidatorTelemetry[] = JSON.parse(raw);
      for (const entry of entries) {
        // Boot-resume: mark unhealthy/offline DIDs so first tick
        // does not fire a redundant alert
        if (entry.healthState === "unhealthy" || entry.healthState === "offline") {
          entry.bootResumed = true;
        }
        this.state.set(entry.did, entry);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First boot: no state file yet
        return;
      }
      console.error("[telemetry] Failed to load state:", err);
    }
  }

  async flushToDisk(): Promise<void> {
    const tmpPath = this.stateFile + ".tmp";
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      const data = JSON.stringify(this.all(), null, 2);
      await writeFile(tmpPath, data);
      await rename(tmpPath, this.stateFile);
    } catch (err) {
      console.error("[telemetry] Failed to flush state:", err);
    }
  }

  startFlushInterval(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      () => void this.flushToDisk(),
      TELEMETRY_CONFIG.STATE_FLUSH_INTERVAL_MS,
    );
  }

  stopFlushInterval(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  get(did: string): ValidatorTelemetry | undefined {
    return this.state.get(did);
  }

  set(did: string, telemetry: ValidatorTelemetry): void {
    this.state.set(did, telemetry);
  }

  delete(did: string): boolean {
    return this.state.delete(did);
  }

  has(did: string): boolean {
    return this.state.has(did);
  }

  all(): ValidatorTelemetry[] {
    return [...this.state.values()];
  }

  getContact(did: string): ContactRegistration | undefined {
    return this.state.get(did)?.contact;
  }

  setContact(did: string, contact: ContactRegistration): void {
    const entry = this.state.get(did);
    if (entry) {
      entry.contact = contact;
    }
  }

  clearBootResumed(did: string): void {
    const entry = this.state.get(did);
    if (entry) {
      entry.bootResumed = false;
    }
  }
}
