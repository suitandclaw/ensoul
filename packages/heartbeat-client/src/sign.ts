// Sign a heartbeat payload per spec Section 3.
// JCS canonicalize (RFC 8785) then Ed25519 sign.

import canonicalize from "canonicalize";
import type { HeartbeatPayload, SignedHeartbeat } from "./types.js";

export async function signHeartbeat(
  payload: HeartbeatPayload,
  privKey: Uint8Array,
): Promise<SignedHeartbeat> {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  (ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

  const canonical = canonicalize(payload);
  if (!canonical) throw new Error("canonicalize returned undefined");

  const message = new TextEncoder().encode(canonical);
  const sig = await ed.signAsync(message, privKey);
  const sigHex = Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join("");

  return { ...payload, signature: sigHex };
}
