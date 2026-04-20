// Alert dispatcher interface and stub implementation.
// Stub logs transitions in the exact format real dispatch will produce.
// Real Telegram/ntfy wiring replaces the log call only; format is stable.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { TELEMETRY_CONFIG } from "./types.js";
import type { HealthState } from "./types.js";
import type { StateStore } from "./state-store.js";

export interface AlertDispatcher {
  dispatch(
    did: string,
    oldState: HealthState,
    newState: HealthState,
    reason: string,
    isReminder?: boolean,
  ): Promise<void>;
}

export class StubAlertDispatcher implements AlertDispatcher {
  private readonly stateStore: StateStore;
  private readonly logPath: string;
  readonly logged: string[] = [];

  constructor(stateStore: StateStore, logPath?: string) {
    this.stateStore = stateStore;
    this.logPath = logPath ?? TELEMETRY_CONFIG.ALERT_LOG;
  }

  async dispatch(
    did: string,
    oldState: HealthState,
    newState: HealthState,
    reason: string,
    isReminder?: boolean,
  ): Promise<void> {
    const contact = this.stateStore.getContact(did);
    const targets = contact
      ? contact.contacts.map(c => `${c.type}:${c.target}`).join(",")
      : "NO_CONTACT";
    const severity = isReminder ? "REMINDER" : (newState === "healthy" ? "RECOVERY" : "ALERT");
    const ts = new Date().toISOString();
    const line = `[${ts}] [${severity}] ${did} -> ${targets} | ${oldState} -> ${newState} | ${reason}`;

    this.logged.push(line);

    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      await appendFile(this.logPath, line + "\n");
    } catch {
      // Log write failure is non-fatal
    }
  }
}
