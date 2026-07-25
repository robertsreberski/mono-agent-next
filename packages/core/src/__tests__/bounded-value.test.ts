// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  assertOwnKeys,
  denseOwnDataArray,
  ownDataRecord,
  snapshotBoundedValue,
} from "../bounded-value.js";

const limits = {
  path: "value",
  maxBytes: 1_024,
  maxItems: 32,
  maxDepth: 8,
} as const;

describe("bounded value engine", () => {
  it("reads only plain own-data records and exact dense arrays", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return "unsafe";
      },
    });
    expect(() => ownDataRecord(accessor, "record")).toThrow(/data property/u);
    expect(reads).toBe(0);

    const symbolic = { value: true } as Record<PropertyKey, unknown>;
    symbolic[Symbol("extra")] = true;
    expect(() => ownDataRecord(symbolic, "record")).toThrow(/symbol key/u);

    const sparse = new Array(1);
    expect(() => denseOwnDataArray(sparse, "array", 2)).toThrow(/array\.0.*required/u);
    const extra = [true] as unknown[] & { extra?: boolean };
    extra.extra = true;
    expect(() => denseOwnDataArray(extra, "array", 2)).toThrow(/non-index/u);

    const record = ownDataRecord({ allowed: true }, "record");
    expect(() => assertOwnKeys(record, ["other"], "record")).toThrow(/unknown key/u);
  });

  it("detaches bytes, preserves opted-in aliases, and freezes config snapshots", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const shared = { bytes };
    const snapshot = snapshotBoundedValue<{
      readonly left: { readonly bytes: Uint8Array };
      readonly right: { readonly bytes: Uint8Array };
    }>({ left: shared, right: shared }, {
      ...limits,
      cloneBytes: true,
      freeze: true,
      preserveAliases: true,
      requireOrdinaryArrays: true,
    }).value;

    bytes[0] = 9;
    expect([...snapshot.left.bytes]).toEqual([1, 2, 3]);
    expect(snapshot.left).toBe(snapshot.right);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.left)).toBe(true);
  });

  it("fails closed on proxies, cycles, depth, items, bytes, and disallowed bytes", () => {
    expect(() => snapshotBoundedValue(new Proxy({}, {}), limits)).toThrow(/Proxy/u);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotBoundedValue(cycle, limits)).toThrow(/cycles/u);

    expect(() => snapshotBoundedValue({ a: { b: true } }, {
      ...limits,
      maxDepth: 1,
    })).toThrow(/depth boundary/u);
    expect(() => snapshotBoundedValue([1, 2], {
      ...limits,
      maxItems: 1,
    })).toThrow(/item/u);
    expect(() => snapshotBoundedValue("long", {
      ...limits,
      maxBytes: 3,
    })).toThrow(/byte.*boundary/u);
    expect(() => snapshotBoundedValue(new Uint8Array([1]), limits))
      .toThrow(/plain value values/u);
  });

  it("can safely preserve a cycle without undercounting repeated aliases", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cyclic = snapshotBoundedValue<Record<string, unknown>>(cycle, {
      ...limits,
      allowCycles: true,
    }).value;
    expect(cyclic.self).toBe(cyclic);

    const shared = { text: "1234" };
    expect(() => snapshotBoundedValue([shared, shared], {
      ...limits,
      maxBytes: 10,
      allowCycles: true,
    })).toThrow(/byte/u);
  });
});
