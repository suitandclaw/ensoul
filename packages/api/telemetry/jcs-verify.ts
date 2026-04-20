// JCS (RFC 8785) canonicalization and Ed25519 signature verification
// for the heartbeat telemetry protocol.
//
// didKeyToPubkey is duplicated from packages/api/start.ts (line 2984).
// TODO: extract to @ensoul/identity or @ensoul/sdk for shared use.

import canonicalizeLib from "canonicalize";
import type { Heartbeat, ContactRegistration } from "./types.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * JCS-canonicalize a JSON-serializable object per RFC 8785.
 * The underlying `canonicalize` package (by RFC 8785 co-author) already
 * throws on NaN, Infinity, and -Infinity. No redundant checks needed.
 */
export function canonicalize(obj: unknown): string {
  const result = canonicalizeLib(obj);
  if (result === undefined) {
    throw new Error("canonicalize returned undefined");
  }
  return result;
}

/**
 * Decode a did:key:z... DID to its raw 32-byte Ed25519 public key.
 * Returns null on malformed DID, wrong multicodec prefix, or wrong length.
 */
export function didKeyToPubkey(did: string): Uint8Array | null {
  if (!did.startsWith("did:key:z")) return null;
  const encoded = did.slice(9);
  let num = 0n;
  for (const c of encoded) {
    const idx = B58.indexOf(c);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(68, "0");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  // Ed25519 multicodec prefix: 0xed 0x01, followed by 32-byte pubkey
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
  return bytes.slice(2);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return b;
}

/**
 * Verify an Ed25519 signature over a JCS-canonicalized payload.
 * Follows spec Section 3: strip signature field, canonicalize, verify.
 */
export async function verifySignature(
  payload: Heartbeat | ContactRegistration,
  signature: string,
  did: string,
): Promise<boolean> {
  const pubkey = didKeyToPubkey(did);
  if (!pubkey) return false;

  const sigBytes = hexToBytes(signature);
  if (!sigBytes || sigBytes.length !== 64) return false;

  // Strip signature field and canonicalize
  const { signature: _sig, ...rest } = payload;
  const canonical = canonicalize(rest);
  const message = new TextEncoder().encode(canonical);

  // Dynamic import to match existing pattern in start.ts
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  (ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

  try {
    return ed.verify(sigBytes, message, pubkey);
  } catch {
    return false;
  }
}
