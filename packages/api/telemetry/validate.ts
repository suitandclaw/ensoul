import { TELEMETRY_CONFIG } from "./types.js";
import type { Heartbeat } from "./types.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: number; error: string };

const HEX_RE = /^[0-9a-f]{128}$/i;

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

export function validateRequiredFields(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, code: 400, error: "payload must be a JSON object" };
  }
  const p = body as Record<string, unknown>;

  if (!("version" in p) || p.version !== 1) {
    return { ok: false, code: 400, error: "version must be exactly 1" };
  }
  if (!("chain_id" in p) || typeof p.chain_id !== "string") {
    return { ok: false, code: 400, error: "chain_id is required and must be a string" };
  }
  if (!("did" in p) || typeof p.did !== "string") {
    return { ok: false, code: 400, error: "did is required and must be a string" };
  }
  if (!("timestamp" in p) || !isInteger(p.timestamp)) {
    return { ok: false, code: 400, error: "timestamp is required and must be an integer" };
  }
  if (!("height" in p) || !isInteger(p.height)) {
    return { ok: false, code: 400, error: "height is required and must be an integer" };
  }
  if (!("catching_up" in p) || typeof p.catching_up !== "boolean") {
    return { ok: false, code: 400, error: "catching_up is required and must be a boolean" };
  }
  if (!("peers" in p) || !isInteger(p.peers)) {
    return { ok: false, code: 400, error: "peers is required and must be an integer" };
  }
  if (!("cometbft_version" in p) || typeof p.cometbft_version !== "string") {
    return { ok: false, code: 400, error: "cometbft_version is required and must be a string" };
  }
  if (!("abci_version" in p) || typeof p.abci_version !== "string") {
    return { ok: false, code: 400, error: "abci_version is required and must be a string" };
  }
  if (!("signature" in p) || typeof p.signature !== "string") {
    return { ok: false, code: 400, error: "signature is required and must be a string" };
  }

  // Type-check optional fields if present
  if ("uptime_seconds" in p && p.uptime_seconds !== undefined && !isInteger(p.uptime_seconds)) {
    return { ok: false, code: 400, error: "uptime_seconds must be an integer" };
  }
  if ("restart_count" in p && p.restart_count !== undefined && !isInteger(p.restart_count)) {
    return { ok: false, code: 400, error: "restart_count must be an integer" };
  }
  if ("disk_used_pct" in p && p.disk_used_pct !== undefined && !isInteger(p.disk_used_pct)) {
    return { ok: false, code: 400, error: "disk_used_pct must be an integer" };
  }
  if ("mem_used_pct" in p && p.mem_used_pct !== undefined && !isInteger(p.mem_used_pct)) {
    return { ok: false, code: 400, error: "mem_used_pct must be an integer" };
  }

  return { ok: true };
}

export function validateBounds(payload: Heartbeat): ValidationResult {
  if (payload.chain_id !== TELEMETRY_CONFIG.CHAIN_ID) {
    return { ok: false, code: 400, error: `chain_id must be "${TELEMETRY_CONFIG.CHAIN_ID}"` };
  }
  if (payload.did.length > 256) {
    return { ok: false, code: 400, error: "did must be at most 256 characters" };
  }
  if (payload.height < 0) {
    return { ok: false, code: 400, error: "height must be >= 0" };
  }
  if (payload.peers < 0) {
    return { ok: false, code: 400, error: "peers must be >= 0" };
  }
  if (payload.disk_used_pct !== undefined && (payload.disk_used_pct < 0 || payload.disk_used_pct > 100)) {
    return { ok: false, code: 400, error: "disk_used_pct must be in [0, 100]" };
  }
  if (payload.mem_used_pct !== undefined && (payload.mem_used_pct < 0 || payload.mem_used_pct > 100)) {
    return { ok: false, code: 400, error: "mem_used_pct must be in [0, 100]" };
  }
  if (payload.uptime_seconds !== undefined && payload.uptime_seconds < 0) {
    return { ok: false, code: 400, error: "uptime_seconds must be >= 0" };
  }
  if (payload.restart_count !== undefined && payload.restart_count < 0) {
    return { ok: false, code: 400, error: "restart_count must be >= 0" };
  }
  if (!HEX_RE.test(payload.signature)) {
    return { ok: false, code: 400, error: "signature must be exactly 128 hex characters" };
  }

  return { ok: true };
}

export function validateTimestampSkew(
  payloadTimestamp: number,
  serverNow?: number,
): ValidationResult {
  const now = serverNow ?? Date.now();
  if (Math.abs(payloadTimestamp - now) > TELEMETRY_CONFIG.TIMESTAMP_SKEW_MS) {
    return { ok: false, code: 400, error: "timestamp out of range" };
  }
  return { ok: true };
}

export function validateTimestampMonotonicity(
  payloadTimestamp: number,
  lastStoredTimestamp: number | undefined,
): ValidationResult {
  if (lastStoredTimestamp !== undefined && payloadTimestamp <= lastStoredTimestamp) {
    return { ok: false, code: 400, error: "replayed or out-of-order timestamp" };
  }
  return { ok: true };
}
