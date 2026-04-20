import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../../telemetry/state-store.js";
import { RetentionStore } from "../../telemetry/retention-store.js";
import { AdmissionChecker } from "../../telemetry/admission.js";
import { RateLimiter } from "../../telemetry/rate-limit.js";
import { StubAlertDispatcher } from "../../telemetry/alerts.js";
import { HealthEngine } from "../../telemetry/health.js";
import { telemetryRoutes } from "../../telemetry/routes.js";
import { canonicalize } from "../../telemetry/jcs-verify.js";
import type { Heartbeat } from "../../telemetry/types.js";

let app: FastifyInstance;
let testDir: string;
let stateStore: StateStore;
let rateLimiter: RateLimiter;
let testSeed: Uint8Array;
let testDid: string;
let testSeed2: Uint8Array;
let testDid2: string;
let admittedDids: Set<string>;

async function makeIdentity() {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  (ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
  const seed = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(seed);
  const mc = new Uint8Array(34);
  mc[0] = 0xed; mc[1] = 0x01;
  mc.set(pubkey, 2);
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const b of mc) num = num * 256n + BigInt(b);
  let b58 = "";
  while (num > 0n) { b58 = B58[Number(num % 58n)] + b58; num = num / 58n; }
  for (const b of mc) { if (b !== 0) break; b58 = "1" + b58; }
  return { seed, did: `did:key:z${b58}` };
}

async function signPayload(payload: Record<string, unknown>, seed: Uint8Array): Promise<string> {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  (ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);
  const canonical = canonicalize(payload);
  const sig = await ed.signAsync(new TextEncoder().encode(canonical), seed);
  return Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join("");
}

function makeHeartbeat(did: string, ts?: number): Omit<Heartbeat, "signature"> {
  return {
    version: 1, chain_id: "ensoul-1", did,
    timestamp: ts ?? Date.now(),
    height: 378000, catching_up: false, peers: 12,
    cometbft_version: "0.38.17", abci_version: "1.4.91",
  };
}

async function signedHeartbeat(did: string, seed: Uint8Array, ts?: number): Promise<Heartbeat> {
  const payload = makeHeartbeat(did, ts);
  const sig = await signPayload(payload, seed);
  return { ...payload, signature: sig };
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "integration-test-"));
  const identity = await makeIdentity();
  testSeed = identity.seed;
  testDid = identity.did;
  const identity2 = await makeIdentity();
  testSeed2 = identity2.seed;
  testDid2 = identity2.did;
  admittedDids = new Set([testDid, testDid2]);

  stateStore = new StateStore(join(testDir, "state.json"));
  const retentionStore = new RetentionStore(join(testDir, "raw"), join(testDir, "agg"));
  rateLimiter = new RateLimiter();
  const mockAbci = async () => [] as unknown as Record<string, unknown>;
  const mockPioneerApps = [
    { did: testDid, status: "approved" },
    { did: testDid2, status: "approved" },
  ];
  const admission = new AdmissionChecker(mockAbci, () => mockPioneerApps);
  const alerts = new StubAlertDispatcher(stateStore, join(testDir, "alerts.log"));
  const healthEngine = new HealthEngine(stateStore, alerts);

  app = Fastify({ logger: false });
  await app.register(
    telemetryRoutes(stateStore, retentionStore, admission, rateLimiter, healthEngine),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(testDir, { recursive: true, force: true });
});

// Fresh state for each test (clear store + rate limiter)
beforeEach(() => {
  for (const entry of stateStore.all()) stateStore.delete(entry.did);
  // Reset rate limiter by creating a new one... but we can't swap it.
  // Instead, we accept that rate limit tests must account for cumulative state.
  // Tests 75-76 use dedicated DIDs/IPs and run in sequence.
});

describe("POST /v1/telemetry/heartbeat", () => {
  // Test 70: valid signed heartbeat
  it("returns 200 with status and server_time for valid heartbeat", async () => {
    const hb = await signedHeartbeat(testDid, testSeed);
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.server_time).toBe("number");
  });

  // Test 71: bad JSON body
  it("returns 400 for invalid JSON", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/telemetry/heartbeat",
      headers: { "content-type": "application/json" },
      payload: "not json{",
    });
    // Fastify parses JSON before handler; returns 400 for bad JSON
    expect(res.statusCode).toBe(400);
  });

  // Test 72: unknown DID
  it("returns 403 for unknown DID before signature check", async () => {
    const unknownDid = "did:key:z6MkUnknownAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const payload = makeHeartbeat(unknownDid);
    // Sign with test seed (valid sig, wrong DID for admission)
    const sig = await signPayload(payload, testSeed);
    const hb = { ...payload, signature: sig };
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("unknown DID");
  });

  // Test 73: known DID but bad signature
  it("returns 403 for known DID with invalid signature", async () => {
    const payload = makeHeartbeat(testDid, Date.now() + 100);
    const hb = { ...payload, signature: "ab".repeat(64) }; // valid hex, wrong sig
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("signature invalid");
  });

  // Test 74: replay (identical payload twice)
  it("returns 400 on replayed timestamp (second submit)", async () => {
    const ts = Date.now() + 200;
    const hb = await signedHeartbeat(testDid, testSeed, ts);
    const r1 = await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toContain("replayed");
  });

  // Test 80: processing order (bad bounds checked before admission)
  it("returns 400 for bad bounds even with unknown DID (bounds before admission)", async () => {
    const payload = {
      version: 1, chain_id: "ensoul-test-1", // wrong chain_id = bounds fail
      did: "did:key:z6MkUnknownBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      timestamp: Date.now(), height: 100, catching_up: false, peers: 5,
      cometbft_version: "0.38.17", abci_version: "1.4.91",
      signature: "aa".repeat(64),
    };
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("chain_id");
  });
});

describe("rate limiting", () => {
  // Test 75: per-IP flood
  it("returns 429 on 31st request from same IP", async () => {
    // Create a fresh Fastify app with its own rate limiter for isolation
    const rl = new RateLimiter();
    const ss = new StateStore(join(testDir, "state-rl.json"));
    const rs = new RetentionStore(join(testDir, "raw-rl"), join(testDir, "agg-rl"));
    const mockAbci = async () => [] as unknown as Record<string, unknown>;
    const admission = new AdmissionChecker(mockAbci, () => [{ did: testDid, status: "approved" }]);
    const alerts = new StubAlertDispatcher(ss, join(testDir, "alerts-rl.log"));
    const he = new HealthEngine(ss, alerts);
    const rlApp = Fastify({ logger: false });
    await rlApp.register(telemetryRoutes(ss, rs, admission, rl, he));
    await rlApp.ready();

    let lastCode = 200;
    for (let i = 0; i < 31; i++) {
      const res = await rlApp.inject({
        method: "POST", url: "/v1/telemetry/heartbeat",
        payload: { version: 1 }, // will fail at bounds, but IP rate limit fires first at 31
        remoteAddress: "10.0.0.1",
      });
      lastCode = res.statusCode;
    }
    expect(lastCode).toBe(429);
    await rlApp.close();
  });

  // Test 76: per-DID flood
  it("returns 429 on 3rd heartbeat from same DID in 1 minute", async () => {
    const rl = new RateLimiter();
    const ss = new StateStore(join(testDir, "state-did-rl.json"));
    const rs = new RetentionStore(join(testDir, "raw-did-rl"), join(testDir, "agg-did-rl"));
    const mockAbci = async () => [] as unknown as Record<string, unknown>;
    const admission = new AdmissionChecker(mockAbci, () => [{ did: testDid, status: "approved" }]);
    const alerts = new StubAlertDispatcher(ss, join(testDir, "alerts-did-rl.log"));
    const he = new HealthEngine(ss, alerts);
    const rlApp = Fastify({ logger: false });
    await rlApp.register(telemetryRoutes(ss, rs, admission, rl, he));
    await rlApp.ready();

    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const hb = await signedHeartbeat(testDid, testSeed, Date.now() + 1000 + i);
      const res = await rlApp.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });
      codes.push(res.statusCode);
    }
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(200);
    expect(codes[2]).toBe(429);
    await rlApp.close();
  });
});

describe("POST /v1/telemetry/contact", () => {
  // Test 77: valid signed contact registration
  it("returns 200 for valid contact registration", async () => {
    // Use testDid2 to avoid per-DID rate limit exhaustion from heartbeat tests
    const hb = await signedHeartbeat(testDid2, testSeed2, Date.now() + 3000);
    await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hb });

    const contactPayload = {
      version: 1, did: testDid2, timestamp: Date.now() + 4000,
      contacts: [{ type: "ntfy", target: "my-topic" }],
    };
    const sig = await signPayload(contactPayload, testSeed2);
    const full = { ...contactPayload, signature: sig };
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/contact", payload: full });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  // Test 78: contact with timestamp <= last
  it("returns 400 for contact with replayed timestamp", async () => {
    // Create entry via heartbeat first (beforeEach cleared state)
    const hbPayload = await signedHeartbeat(testDid2, testSeed2, Date.now() + 6000);
    await app.inject({ method: "POST", url: "/v1/telemetry/heartbeat", payload: hbPayload });

    const contactTs = Date.now() + 7000;
    // First contact
    const c1 = { version: 1, did: testDid2, timestamp: contactTs, contacts: [{ type: "ntfy", target: "t" }] };
    const s1 = await signPayload(c1, testSeed2);
    const r1 = await app.inject({ method: "POST", url: "/v1/telemetry/contact", payload: { ...c1, signature: s1 } });
    expect(r1.statusCode).toBe(200);
    // Replay exact same timestamp (must be rejected)
    const c2 = { version: 1, did: testDid2, timestamp: contactTs, contacts: [{ type: "ntfy", target: "t2" }] };
    const s2 = await signPayload(c2, testSeed2);
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/contact", payload: { ...c2, signature: s2 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("replayed");
  });

  // Test 79: contact with unknown DID
  it("returns 403 for contact with unknown DID", async () => {
    const unknownDid = "did:key:z6MkUnknownCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const payload = { version: 1, did: unknownDid, timestamp: Date.now(), contacts: [], signature: "aa".repeat(64) };
    const res = await app.inject({ method: "POST", url: "/v1/telemetry/contact", payload });
    expect(res.statusCode).toBe(403);
  });
});
