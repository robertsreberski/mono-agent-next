import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionRegistry,
  disposeProviderSession,
  invalidateProviderSession,
  refreshProviderSession,
  syncProviderSession,
} from "../../ai/runtime/sessions.js";

describe("createSessionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and returns live entries", () => {
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000 });
    registry.set("session-1", { name: "alpha" });
    expect(registry.get("session-1")).toEqual({ name: "alpha" });
    expect(registry.has("session-1")).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it("evicts entries after the idle timeout fires", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(registry.get("session-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "idle_timeout");
  });

  it("lazily evicts when the wall clock advanced past the TTL without the timer firing", () => {
    let nowValue = 0;
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict, now: () => nowValue });
    registry.set("session-1", { name: "alpha" });
    nowValue = 120_000;
    expect(registry.get("session-1")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "idle_timeout");
  });

  it("does not idle-evict a busy session; explicit dispose still wins", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({
      idleTimeoutMs: 60_000,
      onEvict,
      isBusy: (value) => value.busy === true,
    });
    const value = { name: "alpha", busy: true };
    registry.set("session-1", value);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onEvict).not.toHaveBeenCalled();
    value.busy = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onEvict).toHaveBeenCalledWith(value, "idle_timeout");

    const disposable = { name: "beta", busy: true };
    registry.set("session-2", disposable);
    await registry.dispose("session-2");
    expect(onEvict).toHaveBeenCalledWith(disposable, "disposed");
  });

  it("honors a per-entry idle timeout over the registry default", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("short", { name: "short" }, { idleTimeoutMs: 5_000 });
    registry.set("long", { name: "long" }, { idleTimeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(registry.get("short")).toBeUndefined();
    expect(registry.get("long")).toEqual({ name: "long" });
    await vi.advanceTimersByTimeAsync(595_000);
    expect(registry.get("long")).toBeUndefined();
  });

  it("touch can extend an entry's idle timeout", async () => {
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000 });
    registry.set("session-1", { name: "alpha" }, { idleTimeoutMs: 5_000 });
    registry.touch("session-1", { idleTimeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.get("session-1")).toEqual({ name: "alpha" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(registry.get("session-1")).toBeUndefined();
  });

  it("touch re-arms the idle timer", async () => {
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000 });
    registry.set("session-1", { name: "alpha" });
    await vi.advanceTimersByTimeAsync(40_000);
    registry.touch("session-1");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(registry.get("session-1")).toEqual({ name: "alpha" });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(registry.get("session-1")).toBeUndefined();
  });

  it("delete removes without running onEvict", () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    expect(registry.delete("session-1")).toBe(true);
    expect(onEvict).not.toHaveBeenCalled();
    expect(registry.get("session-1")).toBeUndefined();
  });

  it("dispose runs onEvict with the disposed reason", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    await registry.dispose("session-1");
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "disposed");
    expect(registry.size()).toBe(0);
  });

  it("strictly refreshes a live entry while treating absence as success", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-refresh", { name: "alpha" });

    await expect(registry.refresh("session-refresh")).resolves.toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "refreshed");
    expect(registry.get("session-refresh")).toBeUndefined();
    await expect(registry.refresh("session-refresh")).resolves.toBeUndefined();
  });

  it("keeps a failed strict refresh unavailable and permits an honest retry", async () => {
    const onEvict = vi.fn()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValueOnce(undefined);
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("failed-refresh", { name: "alpha" });

    await expect(registry.refresh("failed-refresh")).rejects.toThrow("close failed");
    expect(registry.get("failed-refresh")).toMatchObject({ busy: true });
    expect(registry.size()).toBe(1);
    await expect(registry.refresh("failed-refresh")).resolves.toBeUndefined();
    expect(registry.get("failed-refresh")).toBeUndefined();
  });

  it("syncs a live entry and propagates provider sync failures", async () => {
    const onSync = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onSync });
    const value = { name: "alpha" };
    registry.set("session-sync", value);

    await expect(registry.sync("session-sync")).resolves.toBe(true);
    expect(onSync).toHaveBeenCalledWith(value);

    onSync.mockRejectedValueOnce(new Error("fsync failed"));
    await expect(registry.sync("session-sync")).rejects.toThrow("fsync failed");
    // Failed sync stays fail-closed, but a subsequent sync can repair it.
    expect(registry.get("session-sync")).toMatchObject({ busy: true });
    await expect(registry.sync("session-sync")).resolves.toBe(true);
    expect(registry.get("session-sync")).toBe(value);
  });

  it("acknowledges a live session when its provider has no durable sync hook", async () => {
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000 });
    registry.set("session-memory-only", { name: "memory-only" });
    await expect(registry.sync("session-memory-only")).resolves.toBe(true);
  });

  it("disposeAll evicts every entry", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    registry.set("session-2", { name: "beta" });
    await registry.disposeAll();
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(0);
  });

  it("survives an onEvict that throws", async () => {
    const registry = createSessionRegistry({
      idleTimeoutMs: 60_000,
      onEvict: () => {
        throw new Error("close failed");
      },
    });
    registry.set("session-1", { name: "alpha" });
    await expect(registry.dispose("session-1")).resolves.toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("replacing an entry clears the previous timer", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("session-1", { name: "alpha" });
    await vi.advanceTimersByTimeAsync(50_000);
    registry.set("session-1", { name: "beta" });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(registry.get("session-1")).toEqual({ name: "beta" });
  });
});

describe("disposeProviderSession", () => {
  it("disposes a session in whichever registry holds it", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("cross-registry-session", { name: "alpha" });
    await expect(disposeProviderSession("cross-registry-session")).resolves.toBe(true);
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "disposed");
  });

  it("returns false for unknown or blank ids", async () => {
    await expect(disposeProviderSession("definitely-not-registered")).resolves.toBe(false);
    await expect(disposeProviderSession("")).resolves.toBe(false);
    await expect(disposeProviderSession(undefined)).resolves.toBe(false);
  });
});

describe("syncProviderSession", () => {
  it("fans out to the registry that owns the live session", async () => {
    const onSync = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onSync });
    registry.set("cross-registry-sync", { name: "alpha" });
    await expect(syncProviderSession("cross-registry-sync")).resolves.toBe(true);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("returns false for unknown or blank ids", async () => {
    await expect(syncProviderSession("definitely-not-registered-sync")).resolves.toBe(false);
    await expect(syncProviderSession("")).resolves.toBe(false);
    await expect(syncProviderSession(undefined)).resolves.toBe(false);
  });
});

describe("refreshProviderSession", () => {
  it("guarantees a cold reopen whether the live id is present or absent", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("cross-registry-refresh", { name: "alpha" });

    await expect(refreshProviderSession("cross-registry-refresh")).resolves.toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "refreshed");
    await expect(refreshProviderSession("definitely-not-registered-refresh")).resolves.toBeUndefined();
  });

  it("rejects ids that cannot name a provider session", async () => {
    await expect(refreshProviderSession("")).rejects.toThrow("providerSessionId");
    await expect(refreshProviderSession(undefined)).rejects.toThrow("providerSessionId");
  });
});

describe("invalidateProviderSession", () => {
  it("uses the destructive invalidation reason", async () => {
    const onEvict = vi.fn();
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("poisoned-session", { name: "alpha" });
    await expect(invalidateProviderSession("poisoned-session")).resolves.toBe(true);
    expect(onEvict).toHaveBeenCalledWith({ name: "alpha" }, "invalidated");
  });

  it("returns false for unknown or blank ids", async () => {
    await expect(invalidateProviderSession("definitely-not-registered")).resolves.toBe(false);
    await expect(invalidateProviderSession("")).resolves.toBe(false);
    await expect(invalidateProviderSession(undefined)).resolves.toBe(false);
  });

  it("propagates cleanup failure and keeps the id unavailable for an honest retry", async () => {
    const onEvict = vi.fn()
      .mockRejectedValueOnce(new Error("unlink failed"))
      .mockResolvedValueOnce(undefined);
    const registry = createSessionRegistry({ idleTimeoutMs: 60_000, onEvict });
    registry.set("failed-invalidation", { name: "alpha" });

    await expect(registry.invalidate("failed-invalidation")).rejects.toThrow("unlink failed");
    expect(registry.get("failed-invalidation")).toMatchObject({ busy: true });
    expect(registry.size()).toBe(1);

    await expect(registry.invalidate("failed-invalidation")).resolves.toBe(true);
    expect(registry.get("failed-invalidation")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("keeps a busy placeholder visible until destructive cleanup completes", async () => {
    let releaseCleanup;
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    const registry = createSessionRegistry({
      idleTimeoutMs: 60_000,
      onEvict: () => cleanupGate,
    });
    registry.set("unlink-race", { name: "alpha", busy: false });

    const pending = registry.invalidate("unlink-race");
    expect(registry.get("unlink-race")).toMatchObject({ busy: true });
    // A cold-reopen insertion cannot replace the marker mid-unlink.
    expect(registry.set("unlink-race", { name: "replacement", busy: false })).toBe(false);
    expect(registry.get("unlink-race")).toMatchObject({ busy: true });

    releaseCleanup();
    await expect(pending).resolves.toBe(true);
    expect(registry.get("unlink-race")).toBeUndefined();
  });
});
