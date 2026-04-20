import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  didKeyToPubkey,
  verifySignature,
} from "../../telemetry/jcs-verify.js";
import type { Heartbeat } from "../../telemetry/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "jcs");

// Helper: generate Ed25519 keypair and derive did:key
async function makeIdentity() {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  (ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

  const seed = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(seed);

  // Encode as did:key:z<base58btc(0xed01 + pubkey)>
  const multicodec = new Uint8Array(34);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(pubkey, 2);

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const b of multicodec) num = num * 256n + BigInt(b);
  let b58 = "";
  while (num > 0n) {
    b58 = B58[Number(num % 58n)] + b58;
    num = num / 58n;
  }
  // Leading zero bytes become '1' in base58
  for (const b of multicodec) {
    if (b !== 0) break;
    b58 = "1" + b58;
  }

  const did = `did:key:z${b58}`;
  return { seed, pubkey, did, ed };
}

// Helper: sign a heartbeat payload
async function signPayload(
  payload: Omit<Heartbeat, "signature">,
  seed: Uint8Array,
): Promise<string> {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  (ed as unknown as { hashes: { sha512: ((m: Uint8Array) => Uint8Array) | undefined } }).hashes.sha512 = (m: Uint8Array) => sha512(m);

  const canonical = canonicalize(payload);
  const message = new TextEncoder().encode(canonical);
  const sig = await ed.signAsync(message, seed);
  return Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join("");
}

function makeHeartbeat(overrides?: Partial<Omit<Heartbeat, "signature">>): Omit<Heartbeat, "signature"> {
  return {
    version: 1,
    chain_id: "ensoul-1",
    did: "placeholder",
    timestamp: Date.now(),
    height: 378000,
    catching_up: false,
    peers: 12,
    cometbft_version: "0.38.17",
    abci_version: "1.4.91",
    ...overrides,
  };
}

let identity1: Awaited<ReturnType<typeof makeIdentity>>;
let identity2: Awaited<ReturnType<typeof makeIdentity>>;

beforeAll(async () => {
  identity1 = await makeIdentity();
  identity2 = await makeIdentity();
});

// ── JCS Canonicalization (Tests 35-40) ──────────────────────────────

describe("canonicalize", () => {
  // Test 35: identical output for different key orderings
  it("produces identical output for alphabetical and reverse key order", () => {
    const a = { a: 1, b: 2, c: 3 };
    const b = { c: 3, b: 2, a: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":1,"b":2,"c":3}');
  });

  // Test 36: nested objects have keys sorted at every depth
  it("sorts keys in nested objects recursively", () => {
    const obj = { z: { b: 2, a: 1 }, a: { d: 4, c: 3 } };
    expect(canonicalize(obj)).toBe('{"a":{"c":3,"d":4},"z":{"a":1,"b":2}}');
  });

  // Test 37: arrays preserve element order
  it("preserves array element order (does not sort)", () => {
    const obj = { arr: [3, 1, 2] };
    expect(canonicalize(obj)).toBe('{"arr":[3,1,2]}');
  });

  // Test 38: -0 serialized as 0
  it("serializes -0 as 0", () => {
    expect(canonicalize({ v: -0 })).toBe('{"v":0}');
  });

  // Test 39: NaN throws
  it("throws on NaN", () => {
    expect(() => canonicalize({ v: NaN })).toThrow();
  });

  // Test 40: Infinity throws
  it("throws on Infinity", () => {
    expect(() => canonicalize({ v: Infinity })).toThrow();
    expect(() => canonicalize({ v: -Infinity })).toThrow();
  });
});

// ── Signature Verification (Tests 41-45a) ───────────────────────────

describe("verifySignature", () => {
  // Test 41: valid signature verifies
  it("verifies a valid Ed25519 signature over JCS canonical form", async () => {
    const payload = makeHeartbeat({ did: identity1.did });
    const sig = await signPayload(payload, identity1.seed);
    const full: Heartbeat = { ...payload, signature: sig };
    const result = await verifySignature(full, sig, identity1.did);
    expect(result).toBe(true);
  });

  // Test 42: tampered payload fails
  it("rejects a tampered payload (height changed after signing)", async () => {
    const payload = makeHeartbeat({ did: identity1.did, height: 100 });
    const sig = await signPayload(payload, identity1.seed);
    const tampered: Heartbeat = { ...payload, height: 101, signature: sig };
    const result = await verifySignature(tampered, sig, identity1.did);
    expect(result).toBe(false);
  });

  // Test 43: valid signature from wrong DID fails
  it("rejects a valid signature verified against the wrong DID", async () => {
    const payload = makeHeartbeat({ did: identity1.did });
    const sig = await signPayload(payload, identity1.seed);
    const full: Heartbeat = { ...payload, signature: sig };
    // Verify against identity2's DID (wrong pubkey)
    const result = await verifySignature(full, sig, identity2.did);
    expect(result).toBe(false);
  });

  // Test 44: cross-chain replay fails
  it("rejects cross-chain replay (signed as ensoul-test-1, posted as ensoul-1)", async () => {
    const payload = makeHeartbeat({ did: identity1.did, chain_id: "ensoul-test-1" });
    const sig = await signPayload(payload, identity1.seed);
    // Attacker changes chain_id after signing
    const tampered: Heartbeat = { ...payload, chain_id: "ensoul-1", signature: sig };
    const result = await verifySignature(tampered, sig, identity1.did);
    expect(result).toBe(false);
  });

  // Test 45: malformed DID returns false gracefully
  it("returns false for a malformed DID", async () => {
    const payload = makeHeartbeat({ did: "not-a-did" });
    const full: Heartbeat = { ...payload, signature: "a".repeat(128) };
    const result = await verifySignature(full, full.signature, "not-a-did");
    expect(result).toBe(false);
  });

  // Test 45a: parameterized field tampering
  describe("field tampering (45a)", () => {
    const fields = ["chain_id", "height", "peers", "timestamp", "did"] as const;

    for (const field of fields) {
      it(`rejects tampered ${field} without re-signing`, async () => {
        const payload = makeHeartbeat({
          did: identity1.did,
          height: 100,
          peers: 10,
          timestamp: 1700000000000,
          chain_id: "ensoul-1",
        });
        const sig = await signPayload(payload, identity1.seed);

        // Mutate one field
        const tampered = { ...payload } as Record<string, unknown>;
        if (field === "chain_id") tampered[field] = "ensoul-test-1";
        else if (field === "did") tampered[field] = "did:key:z6Mk" + "A".repeat(40);
        else tampered[field] = (tampered[field] as number) + 1;

        const full = { ...tampered, signature: sig } as Heartbeat;
        const verifyDid = identity1.did;
        const result = await verifySignature(full, sig, verifyDid);
        expect(result).toBe(false);
      });
    }
  });
});

// ── DID Decoding ────────────────────────────────────────────────────

describe("didKeyToPubkey", () => {
  it("decodes a valid did:key to 32-byte pubkey matching generated key", () => {
    const pubkey = didKeyToPubkey(identity1.did);
    expect(pubkey).not.toBeNull();
    expect(pubkey!.length).toBe(32);
    expect(Buffer.from(pubkey!).toString("hex")).toBe(
      Buffer.from(identity1.pubkey).toString("hex"),
    );
  });

  it("returns null for non-did:key prefix", () => {
    expect(didKeyToPubkey("did:web:example.com")).toBeNull();
  });

  it("returns null for truncated DID", () => {
    expect(didKeyToPubkey("did:key:z")).toBeNull();
  });

  it("returns null for invalid base58 characters", () => {
    expect(didKeyToPubkey("did:key:z0OIl")).toBeNull();
  });
});

// ── Cyberphone Test Vectors (Tests 46-48) ───────────────────────────

describe("cyberphone test vectors", () => {
  const vectorFiles = ["arrays", "structures", "values", "weird", "french"];

  for (const name of vectorFiles) {
    it(`${name}.json matches expected canonical output`, () => {
      const input = JSON.parse(
        readFileSync(join(FIXTURES, "input", `${name}.json`), "utf-8"),
      );
      const expected = readFileSync(
        join(FIXTURES, "output", `${name}.json`),
        "utf-8",
      );
      const result = canonicalize(input);
      expect(result).toBe(expected);
    });
  }
});
