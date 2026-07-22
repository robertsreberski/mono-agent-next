import { describe, expect, it } from "vitest";

import { createDeterministicIdFactory, idToHex } from "../ids.js";

describe("createDeterministicIdFactory", () => {
  it("derives stable 16-byte trace ids and 8-byte span ids from the run id", () => {
    const f = createDeterministicIdFactory("run-1");
    expect(f.traceId()).toHaveLength(16);
    expect(f.spanId(0)).toHaveLength(8);
  });

  it("is deterministic: same run id -> identical ids (idempotent re-export)", () => {
    const a = createDeterministicIdFactory("run-1");
    const b = createDeterministicIdFactory("run-1");
    expect(idToHex(a.traceId())).toBe(idToHex(b.traceId()));
    expect(idToHex(a.spanId(0))).toBe(idToHex(b.spanId(0)));
    expect(idToHex(a.spanId(3))).toBe(idToHex(b.spanId(3)));
  });

  it("varies by run id and by ordinal", () => {
    const a = createDeterministicIdFactory("run-1");
    const b = createDeterministicIdFactory("run-2");
    expect(idToHex(a.traceId())).not.toBe(idToHex(b.traceId()));
    expect(idToHex(a.spanId(0))).not.toBe(idToHex(a.spanId(1)));
  });

  it("never emits an all-zero id", () => {
    const f = createDeterministicIdFactory("run-1");
    expect(f.traceId().every((byte) => byte === 0)).toBe(false);
    expect(f.spanId(0).every((byte) => byte === 0)).toBe(false);
  });
});
