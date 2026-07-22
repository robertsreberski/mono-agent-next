import { describe, expect, it } from "vitest";

import { createCircuitBreakerEmbeddingProvider, MemorySearchError } from "../index.js";
import type { EmbeddingProvider } from "../index.js";

/** A counting fake inner provider whose behaviour is driven by a queue of outcomes. */
class FakeInner implements EmbeddingProvider {
  readonly id = "fake:inner";
  calls = 0;
  /** When false, embed() throws; when true, embed() resolves with a single zero vector. */
  succeed = true;

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    if (!this.succeed) {
      throw new Error("inner failed");
    }
    return texts.map(() => [0]);
  }
}

/** A controllable clock for deterministic cooldown testing. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("createCircuitBreakerEmbeddingProvider", () => {
  it("derives its id from the inner provider", () => {
    const inner = new FakeInner();
    const provider = createCircuitBreakerEmbeddingProvider(inner, { now: () => 0 });
    expect(provider.id).toBe("fake:inner");
  });

  it("passes through successful calls while closed", async () => {
    const inner = new FakeInner();
    const provider = createCircuitBreakerEmbeddingProvider(inner, { now: () => 0 });
    expect(await provider.embed(["a", "b"])).toEqual([[0], [0]]);
    expect(inner.calls).toBe(1);
  });

  it("trips open after the threshold of consecutive failures", async () => {
    const inner = new FakeInner();
    inner.succeed = false;
    const provider = createCircuitBreakerEmbeddingProvider(inner, { failureThreshold: 3, now: () => 0 });

    for (let i = 0; i < 3; i += 1) {
      await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    }
    expect(inner.calls).toBe(3);

    // The 4th call must fast-fail without touching inner.
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
    expect(inner.calls).toBe(3);
  });

  it("fast-fails with the embedding_circuit_open code while open and never calls inner", async () => {
    const inner = new FakeInner();
    inner.succeed = false;
    const provider = createCircuitBreakerEmbeddingProvider(inner, { failureThreshold: 2, now: () => 0 });

    await expect(provider.embed(["x"])).rejects.toThrow();
    await expect(provider.embed(["x"])).rejects.toThrow();
    expect(inner.calls).toBe(2);

    let captured: unknown;
    try {
      await provider.embed(["x"]);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(MemorySearchError);
    expect((captured as MemorySearchError).code).toBe("embedding_circuit_open");
    expect(inner.calls).toBe(2);
  });

  it("enters half-open after cooldown and a success closes it", async () => {
    const inner = new FakeInner();
    inner.succeed = false;
    const clock = fakeClock();
    const provider = createCircuitBreakerEmbeddingProvider(inner, {
      failureThreshold: 2,
      cooldownMs: 1000,
      now: clock.now,
    });

    await expect(provider.embed(["x"])).rejects.toThrow();
    await expect(provider.embed(["x"])).rejects.toThrow();
    expect(inner.calls).toBe(2);

    // Still open before cooldown elapses.
    clock.advance(999);
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
    expect(inner.calls).toBe(2);

    // Cooldown elapsed -> half-open trial reaches inner; success closes the breaker.
    clock.advance(1);
    inner.succeed = true;
    expect(await provider.embed(["x"])).toEqual([[0]]);
    expect(inner.calls).toBe(3);

    // Closed again: further calls pass through.
    expect(await provider.embed(["y"])).toEqual([[0]]);
    expect(inner.calls).toBe(4);
  });

  it("re-opens when the half-open trial fails and resets the cooldown window", async () => {
    const inner = new FakeInner();
    inner.succeed = false;
    const clock = fakeClock();
    const provider = createCircuitBreakerEmbeddingProvider(inner, {
      failureThreshold: 2,
      cooldownMs: 1000,
      now: clock.now,
    });

    await expect(provider.embed(["x"])).rejects.toThrow();
    await expect(provider.embed(["x"])).rejects.toThrow();
    expect(inner.calls).toBe(2);

    // Cooldown elapsed -> exactly one half-open trial reaches inner, which fails.
    clock.advance(1000);
    await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    expect(inner.calls).toBe(3);

    // Re-opened: fast-fails again without calling inner.
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
    expect(inner.calls).toBe(3);

    // New cooldown window: still open just before it elapses.
    clock.advance(999);
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
    expect(inner.calls).toBe(3);

    // After the new window, another single trial is allowed.
    clock.advance(1);
    await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    expect(inner.calls).toBe(4);
  });

  it("permits only one in-flight half-open trial; a concurrent caller fast-fails", async () => {
    let calls = 0;
    let release!: () => void;
    const trialGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mode: "fail" | "gate" = "fail";
    const inner: EmbeddingProvider = {
      id: "fake:gated",
      async embed(texts: readonly string[]): Promise<number[][]> {
        calls += 1;
        if (mode === "fail") {
          throw new Error("inner failed");
        }
        await trialGate; // hold the single half-open trial open
        return texts.map(() => [0]);
      },
    };
    const clock = fakeClock();
    const provider = createCircuitBreakerEmbeddingProvider(inner, {
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Trip OPEN (threshold 1).
    await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    expect(calls).toBe(1);

    // Cooldown elapses -> the next call promotes to half-open and gates inside inner.
    clock.advance(1000);
    mode = "gate";
    const trial = provider.embed(["first"]);
    await Promise.resolve();

    // While the single trial is in flight, a concurrent caller must fast-fail
    // instead of also reaching the unhealthy backend.
    await expect(provider.embed(["second"])).rejects.toThrow(MemorySearchError);
    expect(calls).toBe(2);

    // Releasing the trial succeeds and closes the breaker.
    release();
    expect(await trial).toEqual([[0]]);
    expect(await provider.embed(["y"])).toEqual([[0]]);
    expect(calls).toBe(3);
  });

  it("resets the consecutive-failure count on a closed-state success", async () => {
    const inner = new FakeInner();
    const clock = fakeClock();
    const provider = createCircuitBreakerEmbeddingProvider(inner, {
      failureThreshold: 3,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Two failures (below threshold), then a success resets the counter.
    inner.succeed = false;
    await expect(provider.embed(["x"])).rejects.toThrow();
    await expect(provider.embed(["x"])).rejects.toThrow();
    inner.succeed = true;
    expect(await provider.embed(["x"])).toEqual([[0]]);

    // Two more failures should NOT trip the breaker (counter was reset).
    inner.succeed = false;
    await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    expect(inner.calls).toBe(5);

    // Third consecutive failure trips it; fourth fast-fails.
    await expect(provider.embed(["x"])).rejects.toThrow(/inner failed/u);
    expect(inner.calls).toBe(6);
    await expect(provider.embed(["x"])).rejects.toThrow(MemorySearchError);
    expect(inner.calls).toBe(6);
  });
});
