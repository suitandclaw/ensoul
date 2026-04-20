// Fastify route handlers for heartbeat telemetry endpoints.
// Implements the full 8-step processing pipeline from spec Section 2.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import {
  validateRequiredFields,
  validateBounds,
  validateTimestampSkew,
  validateTimestampMonotonicity,
} from "./validate.js";
import { verifySignature } from "./jcs-verify.js";
import type { Heartbeat, ContactRegistration } from "./types.js";
import type { StateStore } from "./state-store.js";
import type { RetentionStore } from "./retention-store.js";
import type { AdmissionChecker } from "./admission.js";
import type { RateLimiter } from "./rate-limit.js";
import type { HealthEngine } from "./health.js";

export function telemetryRoutes(
  stateStore: StateStore,
  retentionStore: RetentionStore,
  admissionChecker: AdmissionChecker,
  rateLimiter: RateLimiter,
  healthEngine: HealthEngine,
): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    // Step 0: Per-IP rate limit (before body parse)
    app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.url.startsWith("/v1/telemetry")) return;
      const ipResult = rateLimiter.checkPerIp(request.ip);
      if (!ipResult.allowed) {
        reply.header("Retry-After", String(ipResult.retryAfter ?? 30));
        return reply.status(429).send({ error: "rate limit exceeded" });
      }
    });

    // POST /v1/telemetry/heartbeat
    app.post("/v1/telemetry/heartbeat", async (request, reply) => {
      // Step 1: Parse + required fields
      const fieldResult = validateRequiredFields(request.body);
      if (!fieldResult.ok) {
        return reply.status(fieldResult.code).send({ error: fieldResult.error });
      }
      const payload = request.body as Heartbeat;

      // Step 2: Bounds validation
      const boundsResult = validateBounds(payload);
      if (!boundsResult.ok) {
        return reply.status(boundsResult.code).send({ error: boundsResult.error });
      }

      // Step 3: Timestamp skew tolerance
      const skewResult = validateTimestampSkew(payload.timestamp);
      if (!skewResult.ok) {
        return reply.status(skewResult.code).send({ error: skewResult.error });
      }

      // Step 4: DID admission
      const admitted = await admissionChecker.isAdmitted(payload.did);
      if (!admitted) {
        return reply.status(403).send({ error: "unknown DID" });
      }

      // Step 5: Timestamp monotonicity
      const entry = stateStore.get(payload.did);
      const lastTs = entry?.lastHeartbeatTs ?? undefined;
      const monoResult = validateTimestampMonotonicity(payload.timestamp, lastTs);
      if (!monoResult.ok) {
        return reply.status(monoResult.code).send({ error: monoResult.error });
      }

      // Step 6: Signature verification
      const sigValid = await verifySignature(payload, payload.signature, payload.did);
      if (!sigValid) {
        return reply.status(403).send({ error: "signature invalid" });
      }

      // Step 7: Per-DID rate limit
      const didResult = rateLimiter.checkPerDid(payload.did);
      if (!didResult.allowed) {
        reply.header("Retry-After", String(didResult.retryAfter ?? 30));
        return reply.status(429).send({ error: "rate limit exceeded" });
      }

      // Step 8: Accept and process
      try {
        await retentionStore.appendRaw(payload);
      } catch (err) {
        console.error("[telemetry] appendRaw failed:", err);
      }

      // Update monotonicity timestamp
      if (entry) {
        entry.lastHeartbeatTs = payload.timestamp;
        stateStore.set(payload.did, entry);
      }

      await healthEngine.onHeartbeat(payload, stateStore.all());

      return reply.status(200).send({
        status: "ok",
        server_time: Date.now(),
      });
    });

    // POST /v1/telemetry/contact
    app.post("/v1/telemetry/contact", async (request, reply) => {
      // Step 1: Parse + required fields (contact schema)
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== "object") {
        return reply.status(400).send({ error: "payload must be a JSON object" });
      }
      if (body.version !== 1) {
        return reply.status(400).send({ error: "version must be exactly 1" });
      }
      if (typeof body.did !== "string" || !body.did) {
        return reply.status(400).send({ error: "did is required" });
      }
      if (typeof body.timestamp !== "number" || !Number.isInteger(body.timestamp)) {
        return reply.status(400).send({ error: "timestamp is required and must be an integer" });
      }
      if (!Array.isArray(body.contacts)) {
        return reply.status(400).send({ error: "contacts array is required" });
      }
      if (typeof body.signature !== "string") {
        return reply.status(400).send({ error: "signature is required" });
      }
      const payload = body as unknown as ContactRegistration;

      // Step 3: Timestamp skew
      const skewResult = validateTimestampSkew(payload.timestamp);
      if (!skewResult.ok) {
        return reply.status(skewResult.code).send({ error: skewResult.error });
      }

      // Step 4: DID admission
      const admitted = await admissionChecker.isAdmitted(payload.did);
      if (!admitted) {
        return reply.status(403).send({ error: "unknown DID" });
      }

      // Step 5: Timestamp monotonicity (contact-specific)
      const entry = stateStore.get(payload.did);
      const lastContactTs = entry?.lastContactTs ?? undefined;
      const monoResult = validateTimestampMonotonicity(payload.timestamp, lastContactTs);
      if (!monoResult.ok) {
        return reply.status(monoResult.code).send({ error: monoResult.error });
      }

      // Step 6: Signature verification
      const sigValid = await verifySignature(payload, payload.signature, payload.did);
      if (!sigValid) {
        return reply.status(403).send({ error: "signature invalid" });
      }

      // Accept: store contact
      if (entry) {
        entry.lastContactTs = payload.timestamp;
        stateStore.setContact(payload.did, payload);
        stateStore.set(payload.did, entry);
      }

      return reply.status(200).send({
        status: "ok",
        server_time: Date.now(),
      });
    });
  };
}
