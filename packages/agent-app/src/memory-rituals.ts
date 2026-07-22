/**
 * In-app memory ritual scheduler for the `bujo` tier.
 *
 * Schedules lightweight `store.consolidate()` on its configured cron cadence
 * (default: every two hours). Cron validation and next-run calculation use the
 * same parser contract as the cron adapter. Memory consolidation has no
 * timezone setting, so its historical UTC cadence remains explicit here.
 *
 * Design guarantees:
 * - Only schedules for `store.tier() === "bujo"` (needs the LLM tier).
 * - Consolidation defaults enabled; set `enabled: false` to opt out.
 * - Skip-overlap: never starts a run while the previous is in flight.
 * - Never-throws: errors are caught and logged via `logger.warn`; the
 *   scheduler reschedules after every run (success or failure).
 * - Injectable `now` / `setTimer` / `clearTimer` for deterministic testing.
 */

import { validateCronExpression } from "@mono-agent/cron-adapter";

const DEFAULT_CONSOLIDATION_CRON = "0 */2 * * *";

// Node's setTimeout stores the delay in a 32-bit signed int; anything larger
// silently fires after 1ms (with a TimeoutOverflowWarning). A very sparse custom
// consolidation cron can be >24.8 days out, so the raw cron delay must be capped
// and re-armed instead of busy-looping every ~1ms until its target date arrives.
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface MemoryRitualSchedule {
  readonly enabled?: boolean;
  readonly cron?: string;
}

export interface StartMemoryRitualsInput {
  readonly store: {
    tier(): string;
    consolidate(): Promise<unknown>;
  };
  /** From config.memory.consolidation */
  readonly consolidation?: MemoryRitualSchedule;
  readonly logger?: {
    info(m: string): void;
    warn(m: string): void;
  };
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Injectable timer factory for tests.
   * Defaults to a `setTimeout` wrapper returning the timeout handle.
   */
  readonly setTimer?: (cb: () => void, ms: number) => { unref?: () => void };
  /** Injectable timer canceller. Defaults to `clearTimeout`. */
  readonly clearTimer?: (handle: unknown) => void;
}

export interface RunningRituals {
  stop(): void;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startMemoryRituals(input: StartMemoryRitualsInput): RunningRituals {
  const { store, logger } = input;

  // Only schedule for the bujo tier.
  if (store.tier() !== "bujo") {
    return noopRituals();
  }

  const now = input.now ?? (() => new Date());
  const setTimer = input.setTimer ?? defaultSetTimer;
  const clearTimer = input.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const handles: Array<{ unref?: () => void } | undefined> = [];
  let stopped = false;

  function scheduleConsolidation(cronExpr: string): void {
    let inFlight = false;
    let currentHandle: { unref?: () => void } | undefined;

    function schedule(): void {
      if (stopped) {
        return;
      }
      const current = now();
      let delayMs: number;
      try {
        delayMs = nextCronDelayMs(cronExpr, current);
      } catch (err) {
        logger?.warn(
          `Memory consolidation has an invalid cron expression "${cronExpr}": ${err instanceof Error ? err.message : String(err)}. Consolidation disabled.`,
        );
        return;
      }

      const handle = setTimer(() => {
        // Remove from tracked handles (it has fired)
        const idx = handles.indexOf(handle);
        if (idx !== -1) {
          handles.splice(idx, 1);
        }
        currentHandle = undefined;

        if (stopped) {
          return;
        }

        if (delayMs > MAX_TIMEOUT_MS) {
          // The timer was capped below the real target — consolidation isn't due
          // yet. Re-arm for the remaining time instead of running it.
          schedule();
          return;
        }

        schedule();

        if (inFlight) {
          logger?.warn("Memory consolidation skipped — previous run is still in flight.");
          return;
        }

        inFlight = true;
        store.consolidate()
          .catch((err: unknown) => {
            logger?.warn(
              `Memory consolidation failed: ${err instanceof Error ? err.message : String(err)}.`,
            );
          })
          .finally(() => {
            inFlight = false;
          });
      }, Math.min(delayMs, MAX_TIMEOUT_MS));

      handle.unref?.();
      currentHandle = handle;
      handles.push(handle);
    }

    schedule();
    void currentHandle; // suppress unused-variable lint; reference is in handles
  }

  if (input.consolidation?.enabled !== false) {
    scheduleConsolidation(input.consolidation?.cron ?? DEFAULT_CONSOLIDATION_CRON);
  }

  return {
    stop() {
      stopped = true;
      for (const h of handles.splice(0)) {
        if (h !== undefined) {
          clearTimer(h);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared cron next-run calculation
// ---------------------------------------------------------------------------

function nextCronDelayMs(expression: string, from: Date): number {
  const result = validateCronExpression(expression, {
    currentDate: from,
    timezone: "UTC",
  });
  if (result.ok) {
    return result.nextDate.getTime() - from.getTime();
  }
  if (result.code === "required") {
    throw new Error("Cron expression is required");
  }
  if (result.code === "field_count") {
    throw new Error(`Expected 5 fields; got ${result.fieldCount}`);
  }
  throw new Error(result.reason);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopRituals(): RunningRituals {
  return { stop() { /* no-op */ } };
}

function defaultSetTimer(cb: () => void, ms: number): { unref?: () => void } {
  const handle = setTimeout(cb, ms);
  return { unref: () => handle.unref() };
}
