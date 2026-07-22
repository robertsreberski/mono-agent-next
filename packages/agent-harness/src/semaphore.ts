/**
 * Minimal FIFO counting semaphore for bounding concurrent runtime runs.
 *
 * Admission-control only: a caller acquires immediately before starting work
 * and releases when done. Callers waiting for a permit hold nothing, so a
 * queued follow-up (waiting in the live-session queue) never occupies a slot —
 * which is what keeps `maxConcurrentRuns` from deadlocking against the
 * per-conversation queue.
 */
export interface Semaphore {
  /**
   * Acquire a permit. If `signal` aborts while waiting for admission, the
   * returned promise rejects with {@link SemaphoreAcquireAbortedError} and the
   * waiter is dropped from the queue without ever consuming a permit.
   */
  acquire(signal?: AbortSignal): Promise<void>;
  release(): void;
  /** Permits currently held. */
  inUse(): number;
}

/** Thrown by {@link Semaphore.acquire} when the wait is aborted before admission. */
export class SemaphoreAcquireAbortedError extends Error {
  constructor() {
    super("Semaphore acquire aborted before a slot was available.");
    this.name = "SemaphoreAcquireAbortedError";
  }
}

interface Waiter {
  settled: boolean;
  grant(): void;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let held = 0;
  const waiters: Waiter[] = [];

  return {
    acquire(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted === true) {
        return Promise.reject(new SemaphoreAcquireAbortedError());
      }
      if (held < limit) {
        held += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          settled: false,
          grant(): void {
            if (waiter.settled) {
              return;
            }
            waiter.settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = (): void => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new SemaphoreAcquireAbortedError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    release(): void {
      // Skip any waiter that aborted between enqueue and now so the permit is
      // handed to a live waiter (or freed). Aborted waiters never held a permit.
      while (waiters.length > 0) {
        const next = waiters.shift();
        if (next !== undefined && !next.settled) {
          // Hand the permit directly to the next waiter (held stays the same).
          next.grant();
          return;
        }
      }
      held = Math.max(0, held - 1);
    },
    inUse(): number {
      return held;
    },
  };
}
