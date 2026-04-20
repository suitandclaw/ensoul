import { describe, it, expect } from "vitest";
import {
  validateRequiredFields,
  validateBounds,
  validateTimestampSkew,
  validateTimestampMonotonicity,
} from "../../telemetry/validate.js";
import type { Heartbeat } from "../../telemetry/types.js";

function validPayload(overrides?: Partial<Heartbeat>): Heartbeat {
  return {
    version: 1,
    chain_id: "ensoul-1",
    did: "did:key:z6MkiewFKEurCmchb4HV98oD3Rjbw4yqxQGnivYJ6otzLF7X",
    timestamp: Date.now(),
    height: 378000,
    catching_up: false,
    peers: 12,
    cometbft_version: "0.38.17",
    abci_version: "1.4.91",
    uptime_seconds: 604800,
    restart_count: 0,
    disk_used_pct: 42,
    mem_used_pct: 65,
    signature: "a".repeat(128),
    ...overrides,
  };
}

describe("validateRequiredFields", () => {
  // Test 1
  it("accepts a valid payload", () => {
    const result = validateRequiredFields(validPayload());
    expect(result).toEqual({ ok: true });
  });

  // Test 2
  it("rejects missing version", () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).version;
    const result = validateRequiredFields(p);
    expect(result).toEqual({ ok: false, code: 400, error: "version must be exactly 1" });
  });

  // Test 3
  it("rejects version: 2", () => {
    const result = validateRequiredFields(validPayload({ version: 2 }));
    expect(result).toEqual({ ok: false, code: 400, error: "version must be exactly 1" });
  });

  // Test 4
  it("rejects version: 0", () => {
    const result = validateRequiredFields(validPayload({ version: 0 }));
    expect(result).toEqual({ ok: false, code: 400, error: "version must be exactly 1" });
  });

  // Test 5
  it("rejects missing chain_id", () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).chain_id;
    const result = validateRequiredFields(p);
    expect(result).toEqual({ ok: false, code: 400, error: "chain_id is required and must be a string" });
  });

  // Test 7
  it("rejects missing did", () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).did;
    const result = validateRequiredFields(p);
    expect(result).toEqual({ ok: false, code: 400, error: "did is required and must be a string" });
  });

  // Test 9
  it("rejects missing timestamp", () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).timestamp;
    const result = validateRequiredFields(p);
    expect(result).toEqual({ ok: false, code: 400, error: "timestamp is required and must be an integer" });
  });

  // Test 33
  it("rejects catching_up as string", () => {
    const result = validateRequiredFields(
      validPayload({ catching_up: "true" as unknown as boolean }),
    );
    expect(result).toEqual({ ok: false, code: 400, error: "catching_up is required and must be a boolean" });
  });

  // Test 34
  it("rejects peers as float", () => {
    const result = validateRequiredFields(
      validPayload({ peers: 12.5 }),
    );
    expect(result).toEqual({ ok: false, code: 400, error: "peers is required and must be an integer" });
  });

  // Test 32
  it("accepts payload with optional fields omitted", () => {
    const p = validPayload();
    delete p.uptime_seconds;
    delete p.restart_count;
    delete p.disk_used_pct;
    delete p.mem_used_pct;
    const result = validateRequiredFields(p);
    expect(result).toEqual({ ok: true });
  });
});

describe("validateBounds", () => {
  // Test 6
  it('rejects chain_id: "ensoul-test-1"', () => {
    const result = validateBounds(validPayload({ chain_id: "ensoul-test-1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("chain_id");
  });

  // Test 8
  it("rejects did longer than 256 chars", () => {
    const result = validateBounds(validPayload({ did: "d".repeat(257) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did");
  });

  // Test 16
  it("rejects height: -1", () => {
    const result = validateBounds(validPayload({ height: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("height");
  });

  // Test 17
  it("accepts height: 0", () => {
    const result = validateBounds(validPayload({ height: 0 }));
    expect(result.ok).toBe(true);
  });

  // Test 18
  it("rejects peers: -1", () => {
    const result = validateBounds(validPayload({ peers: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("peers");
  });

  // Test 19
  it("accepts peers: 0", () => {
    const result = validateBounds(validPayload({ peers: 0 }));
    expect(result.ok).toBe(true);
  });

  // Test 20
  it("rejects disk_used_pct: -1", () => {
    const result = validateBounds(validPayload({ disk_used_pct: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("disk_used_pct");
  });

  // Test 21
  it("rejects disk_used_pct: 101", () => {
    const result = validateBounds(validPayload({ disk_used_pct: 101 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("disk_used_pct");
  });

  // Test 22
  it("accepts disk_used_pct: 0", () => {
    const result = validateBounds(validPayload({ disk_used_pct: 0 }));
    expect(result.ok).toBe(true);
  });

  // Test 23
  it("accepts disk_used_pct: 100", () => {
    const result = validateBounds(validPayload({ disk_used_pct: 100 }));
    expect(result.ok).toBe(true);
  });

  // Test 24
  it("rejects mem_used_pct: -1", () => {
    const result = validateBounds(validPayload({ mem_used_pct: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mem_used_pct");
  });

  // Test 25
  it("rejects mem_used_pct: 101", () => {
    const result = validateBounds(validPayload({ mem_used_pct: 101 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mem_used_pct");
  });

  // Test 26
  it("rejects uptime_seconds: -1", () => {
    const result = validateBounds(validPayload({ uptime_seconds: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("uptime_seconds");
  });

  // Test 27
  it("rejects restart_count: -1", () => {
    const result = validateBounds(validPayload({ restart_count: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("restart_count");
  });

  // Test 28
  it("rejects signature with 127 hex chars", () => {
    const result = validateBounds(validPayload({ signature: "a".repeat(127) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("signature");
  });

  // Test 29
  it("rejects signature with 129 hex chars", () => {
    const result = validateBounds(validPayload({ signature: "a".repeat(129) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("signature");
  });

  // Test 30
  it("rejects signature with 128 non-hex chars", () => {
    const result = validateBounds(validPayload({ signature: "g".repeat(128) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("signature");
  });

  // Test 31
  it("accepts signature with exactly 128 hex chars", () => {
    const result = validateBounds(validPayload({ signature: "abcdef0123456789".repeat(8) }));
    expect(result.ok).toBe(true);
  });
});

describe("validateTimestampSkew", () => {
  const now = 1700000000000;

  // Test 10
  it("accepts timestamp at +300000ms boundary", () => {
    const result = validateTimestampSkew(now + 300000, now);
    expect(result.ok).toBe(true);
  });

  // Test 11
  it("rejects timestamp at +300001ms", () => {
    const result = validateTimestampSkew(now + 300001, now);
    expect(result).toEqual({ ok: false, code: 400, error: "timestamp out of range" });
  });

  // Test 12
  it("accepts timestamp at -300000ms boundary", () => {
    const result = validateTimestampSkew(now - 300000, now);
    expect(result.ok).toBe(true);
  });

  // Test 13
  it("rejects timestamp at -300001ms", () => {
    const result = validateTimestampSkew(now - 300001, now);
    expect(result).toEqual({ ok: false, code: 400, error: "timestamp out of range" });
  });
});

describe("validateTimestampMonotonicity", () => {
  // Test 14
  it("rejects timestamp <= last stored", () => {
    const result = validateTimestampMonotonicity(1000, 2000);
    expect(result).toEqual({ ok: false, code: 400, error: "replayed or out-of-order timestamp" });
  });

  // Test 15
  it("rejects timestamp == last stored", () => {
    const result = validateTimestampMonotonicity(2000, 2000);
    expect(result).toEqual({ ok: false, code: 400, error: "replayed or out-of-order timestamp" });
  });

  it("accepts timestamp > last stored", () => {
    const result = validateTimestampMonotonicity(2001, 2000);
    expect(result.ok).toBe(true);
  });

  it("accepts when no previous timestamp exists", () => {
    const result = validateTimestampMonotonicity(1000, undefined);
    expect(result.ok).toBe(true);
  });
});
