// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  deriveOtlpSpanIdentity,
  serializeOtlpSpans,
} from "../otlp.js";
import { record } from "./helpers.js";

describe("OTLP span identity", () => {
  it("uses distinct span ids for byte-identical records", () => {
    const input = record("identical");
    const first = deriveOtlpSpanIdentity(input, 0n);
    const second = deriveOtlpSpanIdentity(input, 1n);
    const payload = serializeOtlpSpans([
      { record: input, enqueueSequence: 0n },
      { record: input, enqueueSequence: 1n },
    ], "test-agent");

    expect(second.spanId).not.toBe(first.spanId);
    expect(payload.includes(Buffer.from(first.spanId, "hex"))).toBe(true);
    expect(payload.includes(Buffer.from(second.spanId, "hex"))).toBe(true);
    expect(deriveOtlpSpanIdentity(input, 0n)).toEqual(first);
  });
});
