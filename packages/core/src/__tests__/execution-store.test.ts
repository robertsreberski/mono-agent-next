import { describe, expect, it } from "vitest";

import {
  ExecutionStore,
  decodeExecutionRecord,
  encodeExecutionRecord,
} from "../execution-store.js";
import { MemoryStateStore } from "./durable-state-fixture.js";

const signal = new AbortController().signal;

describe("ExecutionStore", () => {
  it("commits encoded records atomically and returns typed copies", async () => {
    const state = new MemoryStateStore();
    const store = new ExecutionStore(state);
    const result = await store.transaction({
      puts: [
        { key: "core/runs/a", expectedVersion: null, value: { schemaVersion: 1, value: "a" } },
        { key: "core/runs/b", expectedVersion: null, value: { schemaVersion: 1, value: "b" } },
      ],
      signal,
    });
    expect(result.status).toBe("applied");
    await expect(store.read(
      "core/runs/a",
      (value) => value as { readonly schemaVersion: number; readonly value: string },
      signal,
    )).resolves.toMatchObject({ value: { schemaVersion: 1, value: "a" } });
  });

  it("uses a forward last-key cursor that survives intervening commits", async () => {
    const state = new MemoryStateStore();
    const store = new ExecutionStore(state);
    await store.transaction({
      puts: [
        { key: "core/runs/history/a", expectedVersion: null, value: { id: "a" } },
        { key: "core/runs/history/c", expectedVersion: null, value: { id: "c" } },
      ],
      signal,
    });
    const first = await store.scan(
      "core/runs/history/",
      undefined,
      1,
      (value) => value as { readonly id: string },
      signal,
    );
    expect(first.records.map((record) => record.value.id)).toEqual(["a"]);
    expect(first.cursor).toBeDefined();

    await store.transaction({
      puts: [{ key: "core/runs/history/b", expectedVersion: null, value: { id: "b" } }],
      signal,
    });
    const second = await store.scan(
      "core/runs/history/",
      first.cursor,
      10,
      (value) => value as { readonly id: string },
      signal,
    );
    expect(second.records.map((record) => record.value.id)).toEqual(["b", "c"]);
  });

  it("does not mutate unknown schemas or call state after local encoding failure", async () => {
    const state = new MemoryStateStore();
    const store = new ExecutionStore(state);
    await store.transaction({
      puts: [{ key: "core/admissions/unknown", expectedVersion: null, value: { schemaVersion: 99 } }],
      signal,
    });
    const before = state.records.get("core/admissions/unknown")?.value;
    await expect(store.read(
      "core/admissions/unknown",
      () => {
        throw new TypeError("unsupported schema");
      },
      signal,
    )).rejects.toThrow(/unsupported schema/u);
    expect(state.records.get("core/admissions/unknown")?.value).toEqual(before);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const transactionCalls = state.transactionCalls;
    await expect(store.transaction({
      puts: [{ key: "core/runs/cyclic", expectedVersion: null, value: cyclic }],
      signal,
    })).rejects.toThrow(/cycles/u);
    expect(state.transactionCalls).toBe(transactionCalls);

    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "secret" });
    await expect(store.transaction({
      puts: [{ key: "core/runs/accessor", expectedVersion: null, value: accessor }],
      signal,
    })).rejects.toThrow(/own data property/u);
    expect(state.transactionCalls).toBe(transactionCalls);
  });

  it("bounds record bytes at both encode and decode boundaries", () => {
    expect(() => encodeExecutionRecord({ value: "x".repeat(1024 * 1024) })).toThrow(
      /exceeds/u,
    );
    expect(() => decodeExecutionRecord(new Uint8Array(1024 * 1024 + 1))).toThrow(
      /exceeds/u,
    );
  });

  it("verifies artifact content authority on publication and read", async () => {
    const state = new MemoryStateStore();
    const store = new ExecutionStore(state);
    const ref = await store.putArtifact(
      Buffer.from("expected", "utf8"),
      "text/plain",
      "result.txt",
      signal,
    );
    await expect(store.readArtifact(ref, signal)).resolves.toEqual(
      new Uint8Array(Buffer.from("expected", "utf8")),
    );
    Object.defineProperty(state, "deleteArtifact", {
      configurable: true,
      value: async () => "yes",
    });
    await expect(store.deleteArtifact(ref, signal)).rejects.toThrow(
      /did not return a boolean/u,
    );
    state.artifacts.set(ref.id, new Uint8Array(Buffer.from("tampered", "utf8")));
    await expect(store.readArtifact(ref, signal)).rejects.toThrow(
      /mismatched content authority/u,
    );
  });
});
