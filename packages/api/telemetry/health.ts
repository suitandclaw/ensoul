// Health state computation and alert dispatch for heartbeat telemetry.
// Implements spec Section 8: state machine, transition rules, debounce,
// boot-resume suppression, offline detection via 60s tick, and version
// drift quorum.

import { TELEMETRY_CONFIG } from "./types.js";
import type { Heartbeat, HealthState, ValidatorTelemetry } from "./types.js";
import type { StateStore } from "./state-store.js";
import type { AlertDispatcher } from "./alerts.js";

export class HealthEngine {
  private readonly store: StateStore;
  private readonly dispatcher: AlertDispatcher;
  constructor(store: StateStore, dispatcher: AlertDispatcher) {
    this.store = store;
    this.dispatcher = dispatcher;
  }

  async onHeartbeat(payload: Heartbeat, allReporters: ValidatorTelemetry[]): Promise<void> {
    const did = payload.did;
    const now = Date.now();
    let entry = this.store.get(did);

    if (!entry) {
      entry = {
        did,
        lastHeartbeat: payload,
        lastSeenAt: now,
        healthState: "healthy",
        healthChangedAt: now,
        heightHistory: [payload.height],
        alertSentAt: 0,
        consecutivePeersZero: 0,
        consecutiveCatchingUp: 0,
      };
      this.store.set(did, entry);
      return; // First heartbeat: start healthy, no alert
    }

    // Update telemetry
    entry.lastHeartbeat = payload;
    entry.lastSeenAt = now;
    entry.heightHistory.push(payload.height);
    if (entry.heightHistory.length > 10) {
      entry.heightHistory = entry.heightHistory.slice(-10);
    }

    // Track consecutive counters (persisted in entry)
    entry.consecutivePeersZero = payload.peers === 0 ? entry.consecutivePeersZero + 1 : 0;
    entry.consecutiveCatchingUp = payload.catching_up ? entry.consecutiveCatchingUp + 1 : 0;

    const oldState = entry.healthState;
    const wasBootResumed = entry.bootResumed === true;
    entry.bootResumed = false; // Clear unconditionally (applies once)

    const newState = this.computeState(entry, allReporters);
    entry.healthState = newState;

    if (oldState !== newState) {
      entry.healthChangedAt = now;
      if (wasBootResumed && newState !== "healthy") {
        // Boot resume: state changed but not improving. Suppress alert.
        // (If it improved to healthy, we DO alert below.)
      } else {
        const result = this.shouldFireAlert(entry, oldState, newState);
        if (result.fire) {
          await this.dispatcher.dispatch(did, oldState, newState, result.reason);
          entry.alertSentAt = now;
        }
      }
    }
    // If state unchanged and wasBootResumed: flag already cleared, no alert

    this.store.set(did, entry);
  }

  async tick(allReporters: ValidatorTelemetry[]): Promise<void> {
    const now = Date.now();

    for (const entry of this.store.all()) {
      const wasBootResumed = entry.bootResumed === true;
      entry.bootResumed = false;

      if (now - entry.lastSeenAt > TELEMETRY_CONFIG.OFFLINE_THRESHOLD_MS) {
        if (entry.healthState !== "offline") {
          // Fresh transition to offline
          const oldState = entry.healthState;
          entry.healthState = "offline";
          entry.healthChangedAt = now;
          await this.dispatcher.dispatch(
            entry.did, oldState, "offline",
            "No heartbeat for " + Math.floor((now - entry.lastSeenAt) / 60_000) + " minutes",
          );
          entry.alertSentAt = now;
          this.store.set(entry.did, entry);
        } else {
          // Already offline
          if (wasBootResumed) {
            // First post-boot eval for a DID loaded as offline: suppress reminder
            this.store.set(entry.did, entry);
          } else if (now - entry.alertSentAt >= TELEMETRY_CONFIG.OFFLINE_REMINDER_MS) {
            await this.dispatcher.dispatch(
              entry.did, "offline", "offline",
              "No heartbeat for " + Math.floor((now - entry.lastSeenAt) / 60_000) + " minutes",
              true,
            );
            entry.alertSentAt = now;
            this.store.set(entry.did, entry);
          }
        }
      } else {
        // Live validator: recompute state (quorum might have shifted)
        const oldState = entry.healthState;
        const newState = this.computeState(entry, allReporters);
        if (oldState !== newState) {
          entry.healthState = newState;
          entry.healthChangedAt = now;
          const result = this.shouldFireAlert(entry, oldState, newState);
          if (result.fire) {
            await this.dispatcher.dispatch(entry.did, oldState, newState, result.reason);
            entry.alertSentAt = now;
          }
          this.store.set(entry.did, entry);
        }
      }
    }
  }

  computeState(telemetry: ValidatorTelemetry, allReporters: ValidatorTelemetry[]): HealthState {
    const hb = telemetry.lastHeartbeat;
    const hist = telemetry.heightHistory;

    // UNHEALTHY checks

    // peers == 0 for PEER_ZERO_CONSECUTIVE consecutive heartbeats
    if (telemetry.consecutivePeersZero >= TELEMETRY_CONFIG.PEER_ZERO_CONSECUTIVE) return "unhealthy";

    // catching_up for CATCHING_UP_CONSECUTIVE consecutive heartbeats
    if (telemetry.consecutiveCatchingUp >= TELEMETRY_CONFIG.CATCHING_UP_CONSECUTIVE) return "unhealthy";

    // Height stall: unchanged across last HEIGHT_STALL_CONSECUTIVE
    if (hist.length >= TELEMETRY_CONFIG.HEIGHT_STALL_CONSECUTIVE) {
      const recent = hist.slice(-TELEMETRY_CONFIG.HEIGHT_STALL_CONSECUTIVE);
      if (recent.every(h => h === recent[0])) return "unhealthy";
    }

    // DEGRADED checks
    if (hb.peers > 0 && hb.peers < TELEMETRY_CONFIG.DEGRADED_PEER_THRESHOLD) {
      return "degraded";
    }
    if (hb.disk_used_pct !== undefined && hb.disk_used_pct > TELEMETRY_CONFIG.DEGRADED_DISK_THRESHOLD) {
      return "degraded";
    }
    if (hb.restart_count !== undefined && hb.restart_count > TELEMETRY_CONFIG.DEGRADED_RESTART_THRESHOLD) {
      return "degraded";
    }

    // Version drift (only with quorum)
    const now = Date.now();
    const recent = allReporters.filter(
      r => now - r.lastSeenAt < TELEMETRY_CONFIG.VERSION_QUORUM_WINDOW_MS,
    );
    if (recent.length >= TELEMETRY_CONFIG.VERSION_QUORUM_MIN) {
      const abciVersions = new Map<string, number>();
      const cmtVersions = new Map<string, number>();
      for (const r of recent) {
        abciVersions.set(
          r.lastHeartbeat.abci_version,
          (abciVersions.get(r.lastHeartbeat.abci_version) || 0) + 1,
        );
        cmtVersions.set(
          r.lastHeartbeat.cometbft_version,
          (cmtVersions.get(r.lastHeartbeat.cometbft_version) || 0) + 1,
        );
      }
      const majority = Math.floor(recent.length / 2) + 1;
      const abciMaj = [...abciVersions.entries()].find(([, c]) => c >= majority);
      const cmtMaj = [...cmtVersions.entries()].find(([, c]) => c >= majority);
      if (abciMaj && hb.abci_version !== abciMaj[0]) return "degraded";
      if (cmtMaj && hb.cometbft_version !== cmtMaj[0]) return "degraded";
    }

    return "healthy";
  }

  private shouldFireAlert(
    entry: ValidatorTelemetry,
    oldState: HealthState,
    newState: HealthState,
  ): { fire: boolean; reason: string } {
    const hb = entry.lastHeartbeat;
    let reason = `${oldState} -> ${newState}`;

    if (newState === "unhealthy") {
      if (entry.consecutivePeersZero >= TELEMETRY_CONFIG.PEER_ZERO_CONSECUTIVE) reason = "peers == 0 for " + entry.consecutivePeersZero + " consecutive heartbeats";
      else if (hb.catching_up) reason = "catching_up for consecutive heartbeats";
      else {
        const hist = entry.heightHistory;
        if (hist.length >= TELEMETRY_CONFIG.HEIGHT_STALL_CONSECUTIVE) {
          const recent = hist.slice(-TELEMETRY_CONFIG.HEIGHT_STALL_CONSECUTIVE);
          if (recent.every(h => h === recent[0])) reason = "height stalled at " + recent[0];
        }
      }
    } else if (newState === "healthy") {
      reason = "Recovered";
    }

    // Rule 5 (spec alert rules): degraded is dashboard-only
    if (newState === "degraded") return { fire: false, reason };

    // Rule 3: recovery to healthy always fires
    if (newState === "healthy") return { fire: true, reason };

    // Rule 1 and 2: first transition fires; subsequent within debounce window suppressed
    const now = Date.now();
    if (entry.alertSentAt === 0 || now - entry.alertSentAt >= TELEMETRY_CONFIG.DEBOUNCE_WINDOW_MS) {
      return { fire: true, reason };
    }

    return { fire: false, reason };
  }
}
