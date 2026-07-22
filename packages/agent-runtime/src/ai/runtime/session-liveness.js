// @ts-check
// Synchronous session-liveness primitives over a createSessionRegistry.
//
// A provider bridge owns session DURABILITY (pi keeps a Session transcript,
// codex keeps an app-server thread); this kernel layer owns session LIVENESS —
// the concurrency claim that keeps two turns from driving one session at once.
// The primitives here are deliberately SYNCHRONOUS: each does its registry
// get -> check -> set in a single await-free span, so the "busy claim must be
// await-free" invariant (I1) and the create-on-miss reservation race (R8) are
// enforced by construction rather than by careful inline sequencing.
//
// The registry stays the storage + idle-TTL + dispose fan-out layer (its
// exports are unchanged, worklab-compatible); liveness only adds the claim /
// reserve / release / adoptIfPresent seam that pi-native's session-lifecycle and
// codex-app both consume.

/**
 * @typedef {object} SessionRegistryLike
 * @property {(id: string) => any} get
 * @property {(id: string, value: any, opts?: {idleTimeoutMs?: number}) => void} set
 * @property {(id: string) => boolean} delete
 */

/**
 * @typedef {{ok: true, entry: any} | {ok: false, reason: "busy" | "missing"}} ClaimResult
 * @typedef {{ok: true, id: string, release: () => void, commit: (entry: any) => void} | {ok: false, entry: any}} ReserveResult
 */

/**
 * @typedef {object} SessionLiveness
 * @property {(id: string) => ClaimResult} claim
 * @property {(id: string) => any} adoptIfPresent
 * @property {(id: string, seed: any, ttl: number|undefined) => ReserveResult} reserve
 * @property {(id: string) => void} release
 */

/**
 * Wrap a session registry with the synchronous liveness primitives. The
 * explicit return typedef pins the claim/reserve discriminated unions so
 * callers narrow on `ok` (object-literal inference would otherwise widen `ok`
 * to boolean and break narrowing).
 * @param {SessionRegistryLike} registry
 * @returns {SessionLiveness}
 */
export function createSessionLiveness(registry) {
  return {
    /**
     * Claim a live entry for a turn. The registry get -> busy check -> set-busy
     * span is await-free (I1): a concurrent claim of a busy entry loses and is
     * told `busy`, never adopting the session mid-turn.
     * @param {string} id
     * @returns {{ok: true, entry: any} | {ok: false, reason: "busy" | "missing"}}
     */
    claim(id) {
      const entry = registry.get(id);
      if (!entry) return { ok: false, reason: "missing" };
      if (entry.busy) return { ok: false, reason: "busy" };
      entry.busy = true;
      return { ok: true, entry };
    },

    /**
     * Re-read the registry after an awaited step (F4): a second concurrent cold
     * resume could have reopened+inserted its own entry in the await window, so
     * the caller adopts whatever is present (possibly busy) instead of racing a
     * second insert. Returns null when nothing is present.
     * @param {string} id
     * @returns {any | null}
     */
    adoptIfPresent(id) {
      return registry.get(id) ?? null;
    },

    /**
     * Reserve an id with a BUSY placeholder before an awaited create (R8). The
     * get -> check -> set span is await-free, so a second concurrent first turn
     * observes the placeholder (busy) and loses the reservation — exactly one
     * create per durable id. On loss the concurrent entry is returned so the
     * caller can fall into the busy-claim path.
     * @param {string} id
     * @param {any} seed BUSY placeholder entry to insert.
     * @param {number|undefined} ttl per-entry idle timeout.
     * @returns {{ok: true, id: string, release: () => void, commit: (entry: any) => void} | {ok: false, entry: any}}
     */
    reserve(id, seed, ttl) {
      const concurrent = registry.get(id);
      if (concurrent) return { ok: false, entry: concurrent };
      registry.set(id, seed, { idleTimeoutMs: ttl });
      return {
        ok: true,
        id,
        // Drop the placeholder (drop / error / abort paths). delete() removes
        // without running onEvict, matching the raw registry.delete it replaces.
        release: () => { registry.delete(id); },
        // Overwrite the placeholder with the finalized entry on the keep-alive
        // success path (same id, same ttl).
        commit: (entry) => { registry.set(id, entry, { idleTimeoutMs: ttl }); },
      };
    },

    /**
     * Release a session's liveness (remove without running onEvict — the caller
     * has already cleaned up, or is dropping an uncommitted session).
     * @param {string} id
     */
    release(id) {
      registry.delete(id);
    },
  };
}
