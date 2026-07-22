import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionRegistry } from "../../ai/runtime/sessions.js";
import { createSessionLiveness } from "../../ai/runtime/session-liveness.js";

// Build a registry + liveness pair with a controllable clock and a fake repo so
// idle-TTL eviction and onEvict fan-out are observable.
function setup({ idleTimeoutMs = 60_000 } = {}) {
  const evicted = [];
  let clock = 0;
  const registry = createSessionRegistry({
    idleTimeoutMs,
    now: () => clock,
    isBusy: (entry) => entry.busy === true,
    onEvict: async (entry, reason) => { evicted.push({ entry, reason }); },
  });
  const liveness = createSessionLiveness(registry);
  return { registry, liveness, evicted, advance: (ms) => { clock += ms; } };
}

const seed = (over = {}) => ({ session: {}, metadata: {}, repo: {}, durable: false, busy: false, ...over });

describe("createSessionLiveness — claim", () => {
  it("reports missing for an id with no live entry", () => {
    const { liveness } = setup();
    expect(liveness.claim("nope")).toEqual({ ok: false, reason: "missing" });
  });

  it("claims a free entry and sets busy synchronously", () => {
    const { registry, liveness } = setup();
    const entry = seed();
    registry.set("s1", entry);
    const claimed = liveness.claim("s1");
    expect(claimed).toEqual({ ok: true, entry });
    // busy set on the stored object in the same call — no await needed.
    expect(entry.busy).toBe(true);
    expect(registry.get("s1").busy).toBe(true);
  });

  it("a second concurrent claim of a busy entry loses with reason busy", () => {
    const { registry, liveness } = setup();
    registry.set("s1", seed());
    const first = liveness.claim("s1");
    const second = liveness.claim("s1");
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "busy" });
  });
});

describe("createSessionLiveness — reserve (R8 placeholder)", () => {
  it("inserts a busy placeholder when the id is free and hands back release/commit", () => {
    const { registry, liveness } = setup();
    const placeholder = seed({ session: null, busy: true });
    const reservation = liveness.reserve("s1", placeholder, 60_000);
    expect(reservation.ok).toBe(true);
    // placeholder is live + busy: a concurrent claim would lose.
    expect(registry.get("s1")).toBe(placeholder);
    expect(liveness.claim("s1")).toEqual({ ok: false, reason: "busy" });
  });

  it("loses the reservation when a concurrent entry already holds the id", () => {
    const { registry, liveness } = setup();
    const existing = seed();
    registry.set("s1", existing);
    const reservation = liveness.reserve("s1", seed({ busy: true }), 60_000);
    expect(reservation).toEqual({ ok: false, entry: existing });
    // the existing entry is untouched (no placeholder overwrite).
    expect(registry.get("s1")).toBe(existing);
  });

  it("commit overwrites the placeholder with the finalized entry", () => {
    const { registry, liveness } = setup();
    const reservation = liveness.reserve("s1", seed({ session: null, busy: true }), 60_000);
    if (!reservation.ok) throw new Error("expected reservation");
    const finalized = seed({ busy: false });
    reservation.commit(finalized);
    expect(registry.get("s1")).toBe(finalized);
    expect(registry.get("s1").busy).toBe(false);
  });

  it("release drops the placeholder", () => {
    const { registry, liveness } = setup();
    const reservation = liveness.reserve("s1", seed({ busy: true }), 60_000);
    if (!reservation.ok) throw new Error("expected reservation");
    reservation.release();
    expect(registry.get("s1")).toBeUndefined();
  });
});

describe("createSessionLiveness — reserve then claim interleaving (concurrent first turns)", () => {
  it("the reservation winner creates; the loser adopts the placeholder and is told busy", () => {
    const { liveness } = setup();
    // Turn A reserves the durable id first (winner).
    const winner = liveness.reserve("conv", seed({ session: null, busy: true }), 60_000);
    expect(winner.ok).toBe(true);
    // Turn B misses, tries to reserve → loses (placeholder present), then falls
    // into the busy claim path exactly as pi-native's resolveSession does.
    const loserReserve = liveness.reserve("conv", seed({ busy: true }), 60_000);
    expect(loserReserve.ok).toBe(false);
    const loserClaim = liveness.claim("conv");
    expect(loserClaim).toEqual({ ok: false, reason: "busy" });
  });
});

describe("createSessionLiveness — adoptIfPresent (F4 post-await re-read)", () => {
  it("returns the live entry (possibly busy) or null", () => {
    const { registry, liveness } = setup();
    expect(liveness.adoptIfPresent("s1")).toBeNull();
    const busyEntry = seed({ busy: true });
    registry.set("s1", busyEntry);
    expect(liveness.adoptIfPresent("s1")).toBe(busyEntry);
  });
});

describe("createSessionLiveness — release + idle-TTL invariants", () => {
  it("release removes without running onEvict", () => {
    const { registry, liveness, evicted } = setup();
    registry.set("s1", seed());
    liveness.release("s1");
    expect(registry.get("s1")).toBeUndefined();
    expect(evicted).toHaveLength(0);
  });

  it("a claimed (busy) entry is not idle-evicted by the lazy wall-clock check", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    registry.set("s1", seed());
    liveness.claim("s1");
    advance(10_000);
    // busy entries survive the lazy TTL sweep (I11): still adoptable.
    expect(liveness.adoptIfPresent("s1")).not.toBeNull();
  });

  it("a free entry past its TTL is lazily evicted on read", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    registry.set("s1", seed());
    advance(10_000);
    expect(liveness.adoptIfPresent("s1")).toBeNull();
    expect(liveness.claim("s1")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("createSessionLiveness — fake timers idle eviction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the idle timer evicts a free entry and runs onEvict", async () => {
    const evicted = [];
    const registry = createSessionRegistry({
      idleTimeoutMs: 5_000,
      isBusy: (entry) => entry.busy === true,
      onEvict: async (entry, reason) => { evicted.push(reason); },
    });
    const liveness = createSessionLiveness(registry);
    registry.set("s1", seed());
    liveness.claim("s1");
    // busy → the timer fires but re-arms instead of evicting.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evicted).toHaveLength(0);
    // release the busy flag; next timer window evicts.
    registry.get("s1").busy = false;
    registry.touch("s1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evicted).toEqual(["idle_timeout"]);
  });
});

// Phase 7 hardening: interleavings of claim / reserve / adoptIfPresent / release
// against each other and against idle eviction — the concurrency edges pi-native's
// session-lifecycle relies on, isolated at the liveness layer.
describe("createSessionLiveness — claim after a lost reservation, then commit reopens the claim", () => {
  it("loser claims busy; after the winner commits a free entry, a later claim succeeds then re-busies", () => {
    const { liveness } = setup();
    const placeholder = seed({ session: null, busy: true });
    // Turn A wins the reservation (busy placeholder live).
    const winner = liveness.reserve("conv", placeholder, 60_000);
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error("expected reservation");

    // Turn B loses the reservation and adopts the winner's placeholder …
    const loser = liveness.reserve("conv", seed({ busy: true }), 60_000);
    expect(loser).toEqual({ ok: false, entry: placeholder });
    // … so B's follow-on claim observes the busy placeholder → session_busy.
    expect(liveness.claim("conv")).toEqual({ ok: false, reason: "busy" });

    // Turn A finishes: commit overwrites the placeholder with a FREE entry.
    const finalized = seed({ busy: false, session: { id: "s" } });
    winner.commit(finalized);

    // A later resume now claims it (sets busy); a second concurrent claim loses.
    const claimed = liveness.claim("conv");
    expect(claimed).toEqual({ ok: true, entry: finalized });
    expect(finalized.busy).toBe(true);
    expect(liveness.claim("conv")).toEqual({ ok: false, reason: "busy" });
  });
});

describe("createSessionLiveness — adoptIfPresent racing idle eviction (F4)", () => {
  it("returns null when the sole free entry idle-evicted in the await window", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    registry.set("s1", seed()); // free
    advance(2_000); // past TTL
    // The post-await re-read lazily evicts the stale free entry and adopts nothing.
    expect(liveness.adoptIfPresent("s1")).toBeNull();
  });

  it("adopts a concurrent insert that replaced the idle-evicted entry (loser collapses to busy-claim)", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    registry.set("s1", seed()); // E1, free
    advance(2_000); // E1 now past TTL
    // A concurrent cold resume reopened + inserted its own busy entry in the window
    // (fresh lastActivityAt at the current clock).
    const concurrent = seed({ busy: true });
    registry.set("s1", concurrent);
    // adoptIfPresent adopts the concurrent winner, not null and not the stale E1.
    expect(liveness.adoptIfPresent("s1")).toBe(concurrent);
    // The loser then claims → busy (it adopts the winner's in-flight entry).
    expect(liveness.claim("s1")).toEqual({ ok: false, reason: "busy" });
  });

  it("does not evict a BUSY entry past its TTL (I11): adoptIfPresent still returns it", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    const busyEntry = seed({ busy: true });
    registry.set("s1", busyEntry);
    advance(10_000);
    expect(liveness.adoptIfPresent("s1")).toBe(busyEntry);
  });
});

describe("createSessionLiveness — reserve → commit → claim → idle lifecycle", () => {
  it("a committed entry is claimable while busy, then idle-evicts once free (manual clock)", () => {
    const { liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    const reservation = liveness.reserve("s1", seed({ session: null, busy: true }), 1_000);
    if (!reservation.ok) throw new Error("expected reservation");
    const finalized = seed({ busy: false });
    reservation.commit(finalized); // lastActivityAt = clock 0, ttl 1_000

    // Claimable now (the placeholder was overwritten with a free entry).
    const claimed = liveness.claim("s1");
    expect(claimed.ok).toBe(true);

    // While busy, the lazy TTL check does NOT evict it even far past the window.
    advance(5_000);
    expect(liveness.adoptIfPresent("s1")).toBe(finalized);

    // Turn ends → free; the next read past the TTL lazily evicts it.
    finalized.busy = false;
    expect(liveness.adoptIfPresent("s1")).toBeNull();
    expect(liveness.claim("s1")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("createSessionLiveness — release vs. the idle timer (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("release() clears the idle timer so no onEvict fires afterward", async () => {
    const evicted = [];
    const registry = createSessionRegistry({
      idleTimeoutMs: 5_000,
      isBusy: (entry) => entry.busy === true,
      onEvict: async (entry, reason) => { evicted.push(reason); },
    });
    const liveness = createSessionLiveness(registry);
    // A committed FREE entry whose idle timer would otherwise fire.
    registry.set("s1", { busy: false });
    liveness.release("s1");
    expect(registry.get("s1")).toBeUndefined();
    // release() removed via delete (no onEvict) AND cleared the armed timer, so
    // advancing past the TTL runs nothing — the session is already forgotten.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evicted).toHaveLength(0);
  });

  it("releasing a busy reservation placeholder leaves no entry the idle timer could resurrect", async () => {
    const evicted = [];
    const registry = createSessionRegistry({
      idleTimeoutMs: 5_000,
      isBusy: (entry) => entry.busy === true,
      onEvict: async (entry, reason) => { evicted.push(reason); },
    });
    const liveness = createSessionLiveness(registry);
    const reservation = liveness.reserve("s1", { busy: true }, 5_000);
    if (!reservation.ok) throw new Error("expected reservation");
    reservation.release();
    expect(registry.get("s1")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evicted).toHaveLength(0);
    // No wedge: the id is immediately free to reserve again.
    const again = liveness.reserve("s1", { busy: true }, 5_000);
    expect(again.ok).toBe(true);
  });
});
