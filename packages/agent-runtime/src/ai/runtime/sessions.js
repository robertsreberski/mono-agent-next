// Provider session registries.
//
// Bridges that support continuous provider sessions (codex-app keeps the
// app-server subprocess + thread alive, pi-native keeps a pi Session
// transcript) register their live sessions here, keyed by provider session id.
// The host
// owns session lifetime policy (which conversation maps to which session,
// when to resume, when to retire); these registries only make sure nothing
// leaks if the host forgets: every entry carries an idle TTL backstop with an
// unref'd timer plus a lazy wall-clock check, so a stalled timer (laptop
// sleep) still cannot resurrect an expired session.
//
// `createSessionRegistry` instances self-register in a module-level set so
// the runtime surface can expose `syncSession(id)` / `refreshSession(id)` /
// `disposeSession(id)` / `disposeAllSessions()`
// without knowing which bridge owns the id. Provider session ids are unique
// across bridges (codex thread ids, pi uuids), so fan-out dispose is safe.

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const allRegistries = new Set();

function normalizeTtl(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1_000) return fallback;
  return n;
}

/**
 * @param {object} [options]
 * @param {number} [options.idleTimeoutMs]
 * @param {(value: any, reason: string) => (void | Promise<void>)} [options.onEvict]
 * @param {(value: any) => (void | Promise<void>)} [options.onSync]
 * @param {() => number} [options.now]
 * @param {(value: any) => boolean} [options.isBusy]
 */
export function createSessionRegistry({
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onEvict,
  onSync,
  now = Date.now,
  isBusy,
} = {}) {
  const entries = new Map();
  const defaultTtlMs = normalizeTtl(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  // A destructive invalidation must keep the id occupied until provider
  // cleanup is durably complete. Returning a busy placeholder makes existing
  // await-free liveness claims fail closed instead of treating the id as a
  // cold-reopen miss while its JSONL is still being unlinked.
  const unavailable = Object.freeze({ busy: true });

  async function evictBestEffort(id, reason) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state !== "active") {
      if ((entry.state === "invalidating" || entry.state === "refreshing") && entry.operation) {
        try { return await entry.operation; } catch { return false; }
      }
      return false;
    }
    if (reason === "idle_timeout" && isBusy?.(entry.value)) {
      // A session executing a turn must not be torn down by the idle timer;
      // give it a fresh TTL window. Explicit dispose still wins.
      entry.lastActivityAt = now();
      armTimer(id, entry);
      return false;
    }
    entries.delete(id);
    clearTimeout(entry.timer);
    if (onEvict) {
      try {
        await onEvict(entry.value, reason);
      } catch {
        // Eviction cleanup is best-effort; a failed close must not block
        // the registry from forgetting the session.
      }
    }
    return true;
  }

  async function sync(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state === "syncing" && entry.operation) return entry.operation;
    if (entry.state === "invalidating" && entry.operation) {
      await entry.operation;
      return false;
    }
    if (entry.state === "refreshing" && entry.operation) {
      await entry.operation;
      return false;
    }
    if (entry.state === "invalidation_failed") return false;

    clearTimeout(entry.timer);
    entry.state = "syncing";
    const operation = (async () => {
      try {
        await onSync?.(entry.value);
        if (entries.get(id) === entry) {
          entry.state = "active";
          entry.operation = null;
          entry.lastActivityAt = now();
          armTimer(id, entry);
        }
        return true;
      } catch (error) {
        // A provider that cannot prove its durable transcript is on disk must
        // not become resumable. Keep the busy marker in place so the host can
        // follow with destructive invalidation (or retry sync) honestly.
        if (entries.get(id) === entry) {
          entry.state = "sync_failed";
          entry.operation = null;
        }
        throw error;
      }
    })();
    entry.operation = operation;
    return operation;
  }

  async function invalidate(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state === "invalidating" && entry.operation) return entry.operation;
    if (entry.state === "syncing" && entry.operation) {
      try { await entry.operation; } catch { /* invalidation supersedes sync */ }
      return invalidate(id);
    }
    if (entry.state === "refreshing" && entry.operation) {
      try { await entry.operation; } catch { /* invalidation supersedes refresh */ }
      return invalidate(id);
    }

    clearTimeout(entry.timer);
    entry.state = "invalidating";
    const operation = (async () => {
      try {
        // Unlike ordinary eviction, destructive provider cleanup is the
        // operation being promised to the caller. Run it before removal and
        // let every error propagate; forgetting the entry first would report a
        // lie and permit a poisoned durable transcript to cold-reopen.
        await onEvict?.(entry.value, "invalidated");
        if (entries.get(id) === entry) entries.delete(id);
        return true;
      } catch (error) {
        if (entries.get(id) === entry) {
          entry.state = "invalidation_failed";
          entry.operation = null;
        }
        throw error;
      }
    })();
    entry.operation = operation;
    return operation;
  }

  async function refresh(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.state === "refreshing" && entry.operation) return entry.operation;
    if (entry.state === "invalidating" && entry.operation) {
      await entry.operation;
      return;
    }
    if (entry.state === "syncing" && entry.operation) {
      await entry.operation;
      return refresh(id);
    }
    if (entry.state === "invalidation_failed") {
      throw new Error(`Provider session ${String(id)} is awaiting destructive invalidation`);
    }

    clearTimeout(entry.timer);
    entry.state = "refreshing";
    const operation = (async () => {
      try {
        // A refresh is stronger than ordinary best-effort disposal: callers use
        // its successful completion as proof that a subsequent resume cannot
        // adopt stale process memory. Preserve provider-owned durable state,
        // but propagate cleanup failures and retain the unavailable marker.
        await onEvict?.(entry.value, "refreshed");
        if (entries.get(id) === entry) entries.delete(id);
      } catch (error) {
        if (entries.get(id) === entry) {
          entry.state = "refresh_failed";
          entry.operation = null;
        }
        throw error;
      }
    })();
    entry.operation = operation;
    return operation;
  }

  function armTimer(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void evictBestEffort(id, "idle_timeout");
    }, entry.ttlMs);
    entry.timer.unref?.();
  }

  const registry = {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (entry.state !== "active") return unavailable;
      if (now() - entry.lastActivityAt > entry.ttlMs && !isBusy?.(entry.value)) {
        void evictBestEffort(id, "idle_timeout");
        return undefined;
      }
      return entry.value;
    },
    /**
     * @param {any} id
     * @param {any} value
     * @param {{idleTimeoutMs?: number}} [options]
     */
    set(id, value, { idleTimeoutMs: entryTtl } = {}) {
      const previous = entries.get(id);
      // Never overwrite an in-flight/failed durability operation. The marker
      // deliberately owns this id until sync recovers or invalidation removes
      // it, preventing a cold reopen from winning an unlink race.
      if (previous && previous.state !== "active") return false;
      if (previous) clearTimeout(previous.timer);
      const entry = {
        value,
        lastActivityAt: now(),
        timer: null,
        ttlMs: normalizeTtl(entryTtl, defaultTtlMs),
        state: "active",
        operation: null,
      };
      entries.set(id, entry);
      armTimer(id, entry);
      return true;
    },
    /**
     * @param {any} id
     * @param {{idleTimeoutMs?: number}} [options]
     */
    touch(id, { idleTimeoutMs: entryTtl } = {}) {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.state !== "active") return;
      if (entryTtl !== undefined) entry.ttlMs = normalizeTtl(entryTtl, entry.ttlMs);
      entry.lastActivityAt = now();
      armTimer(id, entry);
    },
    has(id) {
      return registry.get(id) !== undefined;
    },
    /** Remove without running onEvict — for callers that already cleaned up. */
    delete(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.state !== "active") return false;
      entries.delete(id);
      clearTimeout(entry.timer);
      return true;
    },
    async dispose(id) {
      return evictBestEffort(id, "disposed");
    },
    async sync(id) {
      return sync(id);
    },
    async refresh(id) {
      return refresh(id);
    },
    async invalidate(id) {
      return invalidate(id);
    },
    async disposeAll() {
      const ids = [...entries.keys()];
      for (const id of ids) await evictBestEffort(id, "disposed");
    },
    size() {
      return entries.size;
    },
  };

  allRegistries.add(registry);
  return registry;
}

export async function disposeProviderSession(providerSessionId) {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let disposed = false;
  for (const registry of allRegistries) {
    if (await registry.dispose(providerSessionId)) disposed = true;
  }
  return disposed;
}

/**
 * Flush provider-owned durable session state after a successful run and before
 * the host commits canonical history. Providers without durable live state
 * acknowledge the barrier immediately; provider sync errors propagate.
 */
export async function syncProviderSession(providerSessionId) {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let synced = false;
  for (const registry of allRegistries) {
    if (await registry.sync(providerSessionId)) synced = true;
  }
  return synced;
}

/**
 * Guarantee that no provider registry can reuse process-local state for this
 * id. Durable provider transcripts are preserved so the next resume reopens
 * them from disk. Absence is success; cleanup failure rejects.
 */
export async function refreshProviderSession(providerSessionId) {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) {
    throw new TypeError("providerSessionId must be a non-empty string");
  }
  for (const registry of allRegistries) {
    await registry.refresh(providerSessionId);
  }
}

/**
 * Irreversibly discard a provider session whose transcript is not represented
 * by canonical host history. Unlike ordinary disposal, providers with durable
 * session caches must remove the persisted transcript as well as the live
 * registry entry.
 */
export async function invalidateProviderSession(providerSessionId) {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let invalidated = false;
  for (const registry of allRegistries) {
    if (await registry.invalidate(providerSessionId)) invalidated = true;
  }
  return invalidated;
}

export async function disposeAllProviderSessions() {
  for (const registry of allRegistries) {
    await registry.disposeAll();
  }
}
