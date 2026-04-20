import { join } from "node:path";
import { homedir } from "node:os";

export type HealthState = "healthy" | "degraded" | "unhealthy" | "offline";

export interface Heartbeat {
  version: number;
  chain_id: string;
  did: string;
  timestamp: number;
  height: number;
  catching_up: boolean;
  peers: number;
  cometbft_version: string;
  abci_version: string;
  uptime_seconds?: number;
  restart_count?: number;
  disk_used_pct?: number;
  mem_used_pct?: number;
  signature: string;
}

export interface ContactRegistration {
  version: number;
  did: string;
  timestamp: number;
  contacts: ContactEntry[];
  signature: string;
}

export interface ContactEntry {
  type: "ntfy" | "telegram" | "email";
  target: string;
}

export interface ValidatorTelemetry {
  did: string;
  lastHeartbeat: Heartbeat;
  lastSeenAt: number;
  healthState: HealthState;
  healthChangedAt: number;
  heightHistory: number[];
  alertSentAt: number;
  contact?: ContactRegistration;
  bootResumed?: boolean;
}

export const TELEMETRY_CONFIG = {
  TIMESTAMP_SKEW_MS: 300_000,
  PER_IP_MAX_PER_MIN: 30,
  PER_DID_MAX_PER_MIN: 2,
  OFFLINE_THRESHOLD_MS: 300_000,
  PEER_ZERO_CONSECUTIVE: 3,
  CATCHING_UP_CONSECUTIVE: 5,
  HEIGHT_STALL_CONSECUTIVE: 5,
  DEGRADED_PEER_THRESHOLD: 3,
  DEGRADED_DISK_THRESHOLD: 90,
  DEGRADED_RESTART_THRESHOLD: 5,
  VERSION_QUORUM_MIN: 10,
  VERSION_QUORUM_WINDOW_MS: 600_000,
  DEBOUNCE_WINDOW_MS: 1_800_000,
  OFFLINE_REMINDER_MS: 3_600_000,
  STATE_FILE: join(homedir(), ".ensoul", "telemetry-state.json"),
  RAW_DIR: join(homedir(), ".ensoul", "telemetry-raw"),
  AGGREGATE_DIR: join(homedir(), ".ensoul", "telemetry-aggregates"),
  ALERT_LOG: join(homedir(), ".ensoul", "telemetry-alerts.log"),
  STATE_FLUSH_INTERVAL_MS: 60_000,
  HEALTH_TICK_INTERVAL_MS: 60_000,
  RAW_RETENTION_DAYS: 7,
  AGGREGATE_RETENTION_DAYS: 90,
  CHAIN_ID: "ensoul-1",
} as const;
