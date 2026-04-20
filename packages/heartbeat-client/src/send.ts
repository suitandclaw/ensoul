// POST signed heartbeat to the telemetry receiver.

import type { SignedHeartbeat } from "./types.js";

const ENDPOINT = "https://api.ensoul.dev/v1/telemetry/heartbeat";
const TIMEOUT_MS = 15_000;

export interface SendResult {
  status: number;
  body: Record<string, unknown>;
}

export async function sendHeartbeat(signed: SignedHeartbeat): Promise<SendResult> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ensoul-Version": "1",
    },
    body: JSON.stringify(signed),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}
