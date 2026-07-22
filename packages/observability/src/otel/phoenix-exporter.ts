import { DEFAULT_MAX_EVENTS_PER_RUN } from "../guards.js";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExportEventContext,
  RunExporter,
  RunSummary,
  RuntimeEventLike,
} from "../types.js";

import { createDeterministicIdFactory } from "./ids.js";
import type { DeterministicIdFactory } from "./ids.js";
import { serializeTraceSpans } from "./serialize.js";
import { buildRunReadableSpans } from "./spans.js";
import { postOtlpProtobuf } from "./transport.js";

export const DEFAULT_PHOENIX_ENDPOINT = "http://127.0.0.1:6006/v1/traces";

/**
 * Defense-in-depth transport timeout. The composite recorder owns the primary
 * bounded timeout around the whole export; this is a backstop so a direct caller
 * (or a composite with a very large timeout) still cannot hang forever.
 */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 60_000;

export interface PhoenixRunExporterDeps {
  readonly fetch?: typeof fetch;
  /** Wall clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Injectable id source for hermetic tests; defaults to deterministic ids keyed
   * on the run id (so a re-export of the same run overwrites in Phoenix).
   */
  readonly idFactory?: (runId: string) => DeterministicIdFactory;
}

/** Resolve the Phoenix project a run's trace lands in. */
function resolveProjectName(config: PhoenixExporterConfig, context: RunExportContext): string {
  return config.projectName ?? context.sourceLabel ?? context.sourceId ?? "default";
}

/**
 * Phoenix preset exporter implementing the {@link RunExporter} contract with
 * batch-on-finish semantics: events are buffered as the composite replays them
 * through `onEvent`, and the entire run is mapped to OTLP `ReadableSpan[]`,
 * serialized to binary protobuf, and POSTed exactly once in `finish`/`fail`.
 *
 * This exporter does NOT swallow errors: a rejected `fetch` or a non-2xx status
 * propagates so the composite recorder's best-effort wrapper records it as a
 * warning without ever failing the run.
 */
export function createPhoenixRunExporter(
  config: PhoenixExporterConfig,
  deps: PhoenixRunExporterDeps = {},
): RunExporter {
  const endpoint = config.endpoint ?? DEFAULT_PHOENIX_ENDPOINT;
  const now = deps.now ?? Date.now;
  const makeIdFactory = deps.idFactory ?? createDeterministicIdFactory;
  const fetchImpl = deps.fetch;
  // The composite enforces the configured timeout; transport timeout is a backstop.
  const transportTimeoutMs =
    config.timeoutMs !== undefined && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TRANSPORT_TIMEOUT_MS;

  const events: RuntimeEventLike[] = [];
  let startMs: number | undefined;

  async function exportRun(summary: RunSummary, context: RunExportContext): Promise<void> {
    const endMs = now();
    const startedMs = startMs ?? endMs;
    const projectName = resolveProjectName(config, context);
    const exportContext: RunExportContext = {
      ...context,
      contentPatternRedaction: config.contentPatternRedaction ?? context.contentPatternRedaction ?? false,
    };
    const spans = buildRunReadableSpans({
      summary,
      events,
      context: exportContext,
      projectName,
      startTimeUnixNanos: BigInt(Math.trunc(startedMs)) * 1_000_000n,
      endTimeUnixNanos: BigInt(Math.trunc(endMs)) * 1_000_000n,
      idFactory: makeIdFactory(context.runId),
    });
    const body = serializeTraceSpans(spans);
    await postOtlpProtobuf({
      endpoint,
      // `x-project-name` is a belt-and-suspenders routing lever Phoenix honors;
      // explicit user headers spread last and win if they set it themselves.
      headers: { "x-project-name": projectName, ...(config.headers ?? {}) },
      body,
      timeoutMs: transportTimeoutMs,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }

  return {
    start(_context: RunExportContext): void {
      startMs = now();
      events.length = 0;
    },
    onEvent(event: RuntimeEventLike, _context: RunExportEventContext): void {
      if (events.length < DEFAULT_MAX_EVENTS_PER_RUN) {
        events.push(event);
      }
    },
    async finish(summary: RunSummary, context: RunExportContext): Promise<void> {
      await exportRun(summary, context);
    },
    async fail(summary: RunSummary, _error: unknown, context: RunExportContext): Promise<void> {
      await exportRun(summary, context);
    },
  };
}
