// Load validator identity (DID + Ed25519 seed) from identity.json.
// Auto-detects location across standard install paths.

import { readFileSync } from "node:fs";
import type { Identity } from "./types.js";

const IDENTITY_PATHS = [
  "/root/.ensoul/identity.json",
  "/root/.ensoul/validator-0/identity.json",
  "/home/ensoul/.ensoul/identity.json",
  "/home/ensoul/.ensoul/validator-0/identity.json",
];

export function loadIdentity(): { did: string; privKey: Uint8Array } {
  let lastError: Error | null = null;

  for (const path of IDENTITY_PATHS) {
    try {
      const raw = readFileSync(path, "utf-8");
      const id = JSON.parse(raw) as Identity;

      if (!id.did || !id.seed) {
        throw new Error(`identity.json at ${path} missing 'did' or 'seed' field`);
      }
      if (id.seed.length !== 64 || !/^[0-9a-fA-F]+$/.test(id.seed)) {
        throw new Error(`identity.json at ${path} has invalid seed (expected 64 hex chars)`);
      }

      const privKey = new Uint8Array(
        id.seed.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)),
      );

      return { did: id.did, privKey };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `No valid identity.json found. Checked: ${IDENTITY_PATHS.join(", ")}. ` +
    `Last error: ${lastError?.message ?? "unknown"}`,
  );
}
