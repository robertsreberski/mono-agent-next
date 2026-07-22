import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeSessionStore } from "../sessions.js";

describe("createRuntimeSessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("save then acquire returns the record and marks it busy", () => {
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000 });
    store.save("conv-1", "ps-1");
    const record = store.acquire("conv-1");
    expect(record).toMatchObject({ conversationId: "conv-1", providerSessionId: "ps-1", busy: true });
    expect(store.acquire("conv-1")).toBeUndefined();
    store.release("conv-1", record!);
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-1" });
  });

  it("lists read-only snapshots of live session records", () => {
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, now: () => 1000 });
    store.save("conv-1", "ps-1");
    const snapshot = store.list();
    expect(snapshot).toEqual([
      {
        conversationId: "conv-1",
        providerSessionId: "ps-1",
        createdAt: 1000,
        lastActivityAt: 1000,
        busy: false,
      },
    ]);
    const record = store.acquire("conv-1");
    expect(record).toBeDefined();
    expect(store.list()).toEqual([
      {
        conversationId: "conv-1",
        providerSessionId: "ps-1",
        createdAt: 1000,
        lastActivityAt: 1000,
        busy: true,
      },
    ]);
  });

  it("evicts after the idle timeout and reports the record to onEvict", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(store.acquire("conv-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: "ps-1" }),
      "idle_timeout",
    );
  });

  it("lazily evicts on acquire when the wall clock outran the timer", () => {
    let nowValue = 0;
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict, now: () => nowValue });
    store.save("conv-1", "ps-1");
    nowValue = 120_000;
    expect(store.acquire("conv-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "idle_timeout");
  });

  it("never evicts a busy record — not by timer, not by the lazy wall-clock check", async () => {
    let nowValue = 0;
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict, now: () => nowValue });
    store.save("conv-1", "ps-1");
    const record = store.acquire("conv-1");
    expect(record).toBeDefined();
    // Wall clock and timers both blow far past the TTL mid-turn.
    nowValue = 10_000_000;
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(store.acquire("conv-1")).toBeUndefined();
    expect(onEvict).not.toHaveBeenCalled();
    store.release("conv-1", record!);
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-1" });
  });

  it("release is a no-op for a record that is no longer the live one", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    const stale = store.acquire("conv-1");
    await store.evict("conv-1", "stale", "ps-1");
    store.save("conv-1", "ps-2");
    const live = store.acquire("conv-1");
    expect(live).toMatchObject({ providerSessionId: "ps-2", busy: true });
    // The old run finishing must not clear the new run's busy flag.
    store.release("conv-1", stale!);
    expect(store.acquire("conv-1")).toBeUndefined();
    store.release("conv-1", live!);
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-2" });
  });

  it("saving a different provider session id evicts the old record with reason replaced", () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    store.save("conv-1", "ps-2");
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "replaced");
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-2" });
  });

  it("save by a non-owner is skipped while the stored record is busy under another run", () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    const held = store.acquire("conv-1");
    // A concurrent fresh run completing must not dispose the held session.
    store.save("conv-1", "ps-other", undefined);
    expect(onEvict).not.toHaveBeenCalled();
    store.release("conv-1", held!);
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-1" });
  });

  it("save by the owner replaces the busy record (provider session rotation)", () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    const owner = store.acquire("conv-1");
    store.save("conv-1", "ps-2", owner);
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-1" }), "replaced");
    // Owner release after rotation is identity-checked and a no-op.
    store.release("conv-1", owner!);
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-2" });
  });

  it("saving the same id refreshes activity without eviction", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    await vi.advanceTimersByTimeAsync(50_000);
    store.save("conv-1", "ps-1");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(onEvict).not.toHaveBeenCalled();
    expect(store.acquire("conv-1")).toMatchObject({ providerSessionId: "ps-1" });
  });

  it("tracks the durable provider revision and can forget a refreshed local handle without provider eviction", () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1", undefined, 3);
    expect(store.acquire("conv-1")).toMatchObject({
      providerSessionId: "ps-1",
      providerSessionRevision: 3,
    });
    const held = store.list()[0];
    expect(held).toMatchObject({ providerSessionRevision: 3, busy: true });
    expect(store.forget("conv-1", "wrong-id")).toBe(false);
    expect(store.forget("conv-1", "ps-1")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("scoped evict only retires the record when the provider session id still matches", async () => {
    const onEvict = vi.fn();
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-2");
    await store.evict("conv-1", "stale", "ps-1");
    expect(onEvict).not.toHaveBeenCalled();
    await store.evict("conv-1", "stale", "ps-2");
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "ps-2" }), "stale");
  });

  it("disposeAll evicts everything, swallows onEvict errors, and latches the store", async () => {
    const onEvict = vi.fn().mockRejectedValue(new Error("close failed"));
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000, onEvict });
    store.save("conv-1", "ps-1");
    store.save("conv-2", "ps-2");
    await expect(store.disposeAll()).resolves.toBeUndefined();
    expect(onEvict).toHaveBeenCalledTimes(2);
    // Latched: late saves from in-flight runs must not re-retain sessions.
    store.save("conv-3", "ps-3");
    expect(store.acquire("conv-3")).toBeUndefined();
  });

  it("release after eviction is a no-op", async () => {
    const store = createRuntimeSessionStore({ idleTimeoutMs: 60_000 });
    store.save("conv-1", "ps-1");
    const record = store.acquire("conv-1");
    await store.evict("conv-1", "stale");
    expect(() => store.release("conv-1", record!)).not.toThrow();
  });
});
