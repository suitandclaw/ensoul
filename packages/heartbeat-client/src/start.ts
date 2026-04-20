// Ensoul Heartbeat Client
// Sends signed telemetry to the receiver every 60 seconds.
// Runs as a systemd service alongside the validator.

import { loadIdentity } from "./identity.js";
import { collectMetrics, RpcUnreachableError } from "./collect.js";
import { signHeartbeat } from "./sign.js";
import { sendHeartbeat } from "./send.js";

const INTERVAL_MS = 60_000;
const MAX_JITTER_MS = 30_000;

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

async function tick(did: string, privKey: Uint8Array): Promise<void> {
  // 1. Collect metrics
  let metrics;
  try {
    metrics = await collectMetrics();
  } catch (err) {
    if (err instanceof RpcUnreachableError) {
      log("skipping tick, RPC down");
      return;
    }
    log(`collect error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. Build payload
  const payload = {
    version: 1 as const,
    did,
    timestamp: Date.now(),
    ...metrics,
  };

  // 3. Sign
  let signed;
  try {
    signed = await signHeartbeat(payload, privKey);
  } catch (err) {
    log(`sign error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 4. Send
  try {
    const result = await sendHeartbeat(signed);
    if (result.status === 200) {
      log(`sent height=${payload.height} peers=${payload.peers} catching_up=${payload.catching_up}`);
    } else {
      const errMsg =
        typeof result.body === "object" && result.body !== null
          ? ((result.body as Record<string, unknown>).error ?? JSON.stringify(result.body))
          : String(result.body ?? "no body");
      if (result.status >= 400 && result.status < 500) {
        log(`rejected (HTTP ${result.status}): ${errMsg}`);
      } else {
        log(`failed (HTTP ${result.status}): ${errMsg}, retrying next tick`);
      }
    }
  } catch (err) {
    log(`send error: ${err instanceof Error ? err.message : String(err)}, retrying next tick`);
  }
}

async function main(): Promise<void> {
  // Load identity (fail hard if missing)
  const { did, privKey } = loadIdentity();

  log("Ensoul Heartbeat Client started");
  log(`  DID: ${did}`);
  log(`  Endpoint: https://api.ensoul.dev/v1/telemetry/heartbeat`);
  log(`  Interval: ${INTERVAL_MS / 1000}s`);

  // Jitter initial delay to spread load across validators
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
  log(`  Initial delay: ${(jitter / 1000).toFixed(1)}s (jitter)`);

  // Graceful shutdown
  let interval: ReturnType<typeof setInterval> | null = null;
  const shutdown = (): void => {
    log("shutting down");
    if (interval) clearInterval(interval);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Wait for jitter, then first tick, then start interval
  await new Promise<void>(resolve => setTimeout(resolve, jitter));
  await tick(did, privKey);

  interval = setInterval(() => void tick(did, privKey), INTERVAL_MS);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
