/**
 * Pure orchestration composite RunRecorder. Wraps a primary recorder (the JSONL
 * run recorder) and an injected best-effort {@link RunExporter}. The JSONL
 * recorder always runs FIRST and its summary is the value returned to the
 * caller, byte-for-byte unchanged. The exporter runs after, bounded by a
 * timeout, and its failures NEVER change the run outcome — they surface only as
 * warnings via the optional `onWarning` callback.
 *
 * Node-free: imports only ./types.js + ./guards.js. The concrete network
 * exporter is injected by agent-host; this module never reaches the transport.
 */

import { DEFAULT_MAX_EVENTS_PER_RUN, errorMessage } from "./guards.js";
import type {
  RunExportContext,
  RunExporter,
  RunRecorder,
  RunSummary,
  RuntimeEventLike,
  RuntimeResultLike,
} from "./types.js";

/** Injectable timer so tests can drive the timeout deterministically. */
export type SetTimer = (fn: () => void, ms: number) => void;

export interface CompositeRunRecorderOptions {
  readonly recorder: RunRecorder;
  readonly exporter: RunExporter;
  readonly context: RunExportContext;
  readonly timeoutMs: number;
  readonly onWarning?: (warning: { readonly phase: string; readonly message: string }) => void;
  readonly setTimer?: SetTimer;
}

const TIMEOUT_SENTINEL = Symbol("composite-export-timeout");

export function createCompositeRunRecorder(options: CompositeRunRecorderOptions): RunRecorder {
  const { recorder, exporter, context, timeoutMs, onWarning } = options;
  const setTimer: SetTimer =
    options.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // Do not keep the event loop alive solely for the export timeout.
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        (handle as { unref: () => void }).unref();
      }
    });

  const events: RuntimeEventLike[] = [];
  let preparePromise: Promise<void> | undefined;
  let terminalPromise: Promise<RunSummary> | undefined;
  let terminalStarted = false;
  let droppedEventCount = 0;

  function warn(phase: string, message: string): void {
    try {
      onWarning?.({ phase, message });
    } catch {
      // Host diagnostics are untrusted/best-effort. A throwing warning sink
      // must never turn an exporter degradation into a run failure or suppress
      // the outer recorder's sole terminal frame.
    }
  }

  function warnAboutDroppedEvents(): void {
    if (droppedEventCount === 0) return;
    warn(
      "event_buffer",
      `Exporter event buffer retained the first ${DEFAULT_MAX_EVENTS_PER_RUN} events and dropped ${droppedEventCount} later events.`,
    );
  }

  async function withTimeout(fn: () => Promise<void> | void): Promise<void> {
    if (!(timeoutMs > 0)) {
      await fn();
      return;
    }
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      setTimer(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });
    const result = await Promise.race([Promise.resolve(fn()).then(() => undefined), timeout]);
    if (result === TIMEOUT_SENTINEL) {
      throw new Error(`export timed out after ${timeoutMs}ms`);
    }
  }

  async function bestEffort(phase: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await withTimeout(fn);
    } catch (error) {
      warn(phase, errorMessage(error));
    }
  }

  async function replayEvents(): Promise<void> {
    if (exporter.onEvent === undefined) {
      return;
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) {
        continue;
      }
      await exporter.onEvent(event, { ...context, eventIndex: index });
    }
  }

  async function prepareFinish(result: RuntimeResultLike): Promise<void> {
    preparePromise ??= recorder.prepareFinish?.(result) ?? Promise.resolve();
    await preparePromise;
  }

  async function commitFinish(result: RuntimeResultLike): Promise<RunSummary> {
    if (terminalPromise === undefined) {
      terminalStarted = true;
      terminalPromise = (async () => {
        const summary = recorder.commitFinish === undefined
          ? await recorder.finish(result)
          : await recorder.commitFinish(result);
        warnAboutDroppedEvents();
        await bestEffort("finish", async () => {
          await replayEvents();
          await exporter.finish?.(summary, context);
          await exporter.flush?.();
        });
        return summary;
      })();
    }
    return await terminalPromise;
  }

  const composite: RunRecorder = {
    onEvent(event: RuntimeEventLike): void {
      if (terminalStarted) return;
      // JSONL recorder FIRST (synchronous), then buffer for batch export.
      recorder.onEvent(event);
      if (events.length < DEFAULT_MAX_EVENTS_PER_RUN) {
        events.push(event);
      } else {
        droppedEventCount += 1;
      }
    },
    prepareFinish,
    commitFinish,
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      await prepareFinish(result);
      return await commitFinish(result);
    },
    async fail(error: unknown): Promise<RunSummary> {
      if (terminalPromise === undefined) {
        terminalStarted = true;
        terminalPromise = (async () => {
          const summary = await recorder.fail(error);
          warnAboutDroppedEvents();
          await bestEffort("fail", async () => {
            await replayEvents();
            await exporter.fail?.(summary, error, context);
            await exporter.flush?.();
          });
          return summary;
        })();
      }
      return await terminalPromise;
    },
  };

  if (recorder.start !== undefined) {
    composite.start = async (): Promise<RunSummary> => {
      const summary = await recorder.start!();
      await bestEffort("start", () => exporter.start?.(context));
      return summary;
    };
  }

  return composite;
}
