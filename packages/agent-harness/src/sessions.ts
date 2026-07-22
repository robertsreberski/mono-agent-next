export type RuntimeSessionEvictReason = "idle_timeout" | "stale" | "replaced" | "disposed";

export interface RuntimeSessionRecord {
  readonly conversationId: string;
  readonly providerSessionId: string;
  providerSessionRevision?: number;
  readonly createdAt: number;
  lastActivityAt: number;
  busy: boolean;
}

export interface RuntimeSessionSnapshot {
  readonly conversationId: string;
  readonly providerSessionId: string;
  readonly providerSessionRevision?: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly busy: boolean;
}

export interface RuntimeSessionStoreOptions {
  readonly idleTimeoutMs: number;
  readonly onEvict?: (record: RuntimeSessionRecord, reason: RuntimeSessionEvictReason) => void | Promise<void>;
  readonly now?: () => number;
}

export interface RuntimeSessionStore {
  /**
   * Returns the live record for a conversation and marks it busy, or
   * undefined when there is no session, another run already holds it, or it
   * idled out (lazy wall-clock check covers stalled timers). Busy records are
   * never evicted here — a session executing a turn must not be torn down.
   */
  acquire(conversationId: string): RuntimeSessionRecord | undefined;
  /** No-op unless `record` is still the conversation's live record. */
  release(conversationId: string, record: RuntimeSessionRecord): boolean | void;
  /**
   * Upsert. A differing stored id is evicted first with reason "replaced" —
   * unless that record is busy under another run (`owner` is the caller's
   * acquired record), in which case the save is skipped: the in-flight run's
   * session must not be disposed out from under it.
   */
  save(
    conversationId: string,
    providerSessionId: string,
    owner?: RuntimeSessionRecord,
    providerSessionRevision?: number,
  ): void;
  /**
   * When `providerSessionId` is given, evicts only if it still matches the
   * stored record — a stale-resume eviction must not retire a session some
   * other run replaced it with.
   */
  evict(conversationId: string, reason: RuntimeSessionEvictReason, providerSessionId?: string): Promise<void>;
  /** Forget only this process's mapping after the runtime handle was refreshed explicitly. */
  forget(conversationId: string, providerSessionId?: string): boolean;
  /** Read-only snapshot for detached status and diagnostics. */
  list?(): readonly RuntimeSessionSnapshot[];
  /** Evicts everything and latches the store shut: later save/acquire no-op. */
  disposeAll(): Promise<void>;
}

export interface RuntimeSessionStoreWithSnapshot extends RuntimeSessionStore {
  release(conversationId: string, record: RuntimeSessionRecord): boolean;
  list(): readonly RuntimeSessionSnapshot[];
}

interface StoredRecord {
  record: RuntimeSessionRecord;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createRuntimeSessionStore(options: RuntimeSessionStoreOptions): RuntimeSessionStoreWithSnapshot {
  const idleTimeoutMs = Math.max(1_000, options.idleTimeoutMs);
  const now = options.now ?? Date.now;
  const entries = new Map<string, StoredRecord>();
  let disposed = false;

  async function evictStored(conversationId: string, reason: RuntimeSessionEvictReason): Promise<void> {
    const stored = entries.get(conversationId);
    if (stored === undefined) {
      return;
    }
    entries.delete(conversationId);
    if (stored.timer !== undefined) {
      clearTimeout(stored.timer);
    }
    if (options.onEvict !== undefined) {
      try {
        await options.onEvict(stored.record, reason);
      } catch {
        // Eviction cleanup is best-effort; the store must forget the session
        // even when the provider-side dispose fails.
      }
    }
  }

  function armTimer(conversationId: string, stored: StoredRecord): void {
    if (stored.timer !== undefined) {
      clearTimeout(stored.timer);
    }
    stored.timer = setTimeout(() => {
      if (!stored.record.busy) {
        void evictStored(conversationId, "idle_timeout");
      }
    }, idleTimeoutMs);
    stored.timer.unref?.();
  }

  function clearTimer(stored: StoredRecord): void {
    if (stored.timer !== undefined) {
      clearTimeout(stored.timer);
      stored.timer = undefined;
    }
  }

  return {
    acquire(conversationId: string): RuntimeSessionRecord | undefined {
      if (disposed) {
        return undefined;
      }
      const stored = entries.get(conversationId);
      if (stored === undefined) {
        return undefined;
      }
      if (stored.record.busy) {
        return undefined;
      }
      if (now() - stored.record.lastActivityAt > idleTimeoutMs) {
        void evictStored(conversationId, "idle_timeout");
        return undefined;
      }
      stored.record.busy = true;
      stored.record.lastActivityAt = now();
      // No idle eviction while a run holds the session.
      clearTimer(stored);
      return stored.record;
    },
    release(conversationId: string, record: RuntimeSessionRecord): boolean {
      const stored = entries.get(conversationId);
      if (stored === undefined || stored.record !== record) {
        return false;
      }
      stored.record.busy = false;
      stored.record.lastActivityAt = now();
      armTimer(conversationId, stored);
      return true;
    },
    save(
      conversationId: string,
      providerSessionId: string,
      owner?: RuntimeSessionRecord,
      providerSessionRevision?: number,
    ): void {
      if (disposed) {
        return;
      }
      if (
        providerSessionRevision !== undefined
        && (!Number.isSafeInteger(providerSessionRevision) || providerSessionRevision < 0)
      ) {
        throw new TypeError("providerSessionRevision must be a non-negative safe integer when present.");
      }
      const stored = entries.get(conversationId);
      if (stored !== undefined && stored.record.providerSessionId === providerSessionId) {
        stored.record.lastActivityAt = now();
        if (providerSessionRevision === undefined) delete stored.record.providerSessionRevision;
        else stored.record.providerSessionRevision = providerSessionRevision;
        if (!stored.record.busy) {
          armTimer(conversationId, stored);
        }
        return;
      }
      if (stored !== undefined) {
        if (stored.record.busy && stored.record !== owner) {
          // Another run is mid-turn on the stored session; keep its mapping.
          // The caller's provider session is reclaimed by the bridge TTL.
          return;
        }
        void evictStored(conversationId, "replaced");
      }
      const timestamp = now();
      const next: StoredRecord = {
        record: {
          conversationId,
          providerSessionId,
          ...(providerSessionRevision === undefined ? {} : { providerSessionRevision }),
          createdAt: timestamp,
          lastActivityAt: timestamp,
          busy: false,
        },
        timer: undefined,
      };
      entries.set(conversationId, next);
      armTimer(conversationId, next);
    },
    async evict(conversationId: string, reason: RuntimeSessionEvictReason, providerSessionId?: string): Promise<void> {
      const stored = entries.get(conversationId);
      if (stored === undefined) {
        return;
      }
      if (providerSessionId !== undefined && stored.record.providerSessionId !== providerSessionId) {
        return;
      }
      await evictStored(conversationId, reason);
    },
    forget(conversationId: string, providerSessionId?: string): boolean {
      const stored = entries.get(conversationId);
      if (stored === undefined) return false;
      if (providerSessionId !== undefined && stored.record.providerSessionId !== providerSessionId) return false;
      entries.delete(conversationId);
      if (stored.timer !== undefined) clearTimeout(stored.timer);
      return true;
    },
    list(): readonly RuntimeSessionSnapshot[] {
      return [...entries.values()].map((stored) => ({ ...stored.record }));
    },
    async disposeAll(): Promise<void> {
      disposed = true;
      const conversationIds = [...entries.keys()];
      for (const conversationId of conversationIds) {
        await evictStored(conversationId, "disposed");
      }
    },
  };
}
