import {
  combineRecordedRunEvents,
  deriveRunSource,
  listRecordedRuns,
  readRecordedRun,
  segmentTimelineTurns,
} from "@mono-agent/observability";
import type {
  RecordedRunDetail,
  RecordedRunEvent,
  RecordedRunListItem,
  RecordedRunTimelineItem,
  RunArtifactScope,
  TimelineTurn,
} from "@mono-agent/observability";

export type { RecordedRunDetail, RecordedRunListItem, RecordedRunTimelineItem, TimelineTurn };

const DEFAULT_MAX_RUNS = 200;

// When `sourceFilter` narrows the result, we widen the underlying read past
// the display cap so a rare source isn't starved by a naive cap-then-filter
// ordering (a source with few runs could be entirely outside the top 200
// newest runs even though it has matches further back). Filtering happens
// AFTER this wider read and BEFORE the final `maxRuns` slice below.
const FILTERED_READ_CEILING = 500;

/**
 * observability's own default (~4096 bytes, see DEFAULT_MAX_STRING_BYTES in
 * @mono-agent/observability/src/guards.ts) is tuned for compact summaries and
 * guts tool/message payload expansion in the replay detail view. Replay asks
 * for a larger, still-bounded projection for drill-down. The reader's
 * key-pattern pass ensures non-numeric values under sensitive-looking object
 * keys are redacted; numeric values under matched keys are retained; retained
 * free text is not content-scanned.
 */
const REPLAY_MAX_STRING_BYTES = 32_768;

export interface ReplayRunListItem extends RecordedRunListItem {
  /** `source` when persisted, else {@link deriveRunSource} on `conversationId`. */
  readonly resolvedSource: string;
}

export interface ListReplayRunsOptions {
  /** Display cap on the returned run list (default 200). */
  readonly maxRuns?: number;
  /** When set, keep only runs whose `resolvedSource` matches exactly. */
  readonly sourceFilter?: string;
}

export interface ListReplayRunsResult {
  readonly runs: readonly ReplayRunListItem[];
  readonly warnings: readonly string[];
  /** Total runs found in the artifact dir, independent of `sourceFilter`/`maxRuns`. */
  readonly totalRuns: number;
}

/**
 * Newest-first recorded runs read straight from the agent's artifact dir.
 *
 * @param options - Either a {@link ListReplayRunsOptions} object, or (legacy
 * back-compat form, kept for published-API callers predating `sourceFilter`)
 * a bare `number` treated as `{ maxRuns: number }`.
 */
export async function listReplayRuns(
  artifactDir: string,
  options: number | ListReplayRunsOptions = {},
): Promise<ListReplayRunsResult> {
  const normalized = typeof options === "number" ? { maxRuns: options } : options;
  const maxRuns = normalized.maxRuns ?? DEFAULT_MAX_RUNS;
  // Fast path (no filter): read exactly what we'll show, same as before.
  // Filtering path: read the wider ceiling so filtering doesn't get starved
  // by a cap applied before we even know what matches.
  const readCeiling = normalized.sourceFilter === undefined ? maxRuns : Math.max(maxRuns, FILTERED_READ_CEILING);
  const scope = replayScopeForSourceFilter(normalized.sourceFilter);
  const result = await listRecordedRuns({
    artifactDir,
    maxRuns: readCeiling,
    ...(scope === undefined ? {} : { scope }),
  });
  const resolved = result.runs.map(
    (run): ReplayRunListItem => ({
      ...run,
      resolvedSource: run.source ?? deriveRunSource(run.conversationId),
    }),
  );
  const filtered =
    normalized.sourceFilter === undefined
      ? resolved
      : resolved.filter((run) => run.resolvedSource === normalized.sourceFilter);
  return {
    runs: filtered.slice(0, maxRuns),
    warnings: result.warnings,
    totalRuns: result.totalRuns,
  };
}

/** Per-item replay annotations layered onto the coalesced timeline. */
export interface ReplayTimelineItem extends RecordedRunTimelineItem {
  /** `item.timestamp` parsed to epoch ms; undefined when absent/unparseable. */
  readonly timestampMs?: number;
  /**
   * `timestampMs` minus the PREVIOUS timeline item's END (its `endTimestampMs`
   * when parseable, else its own `timestampMs`) — anchoring on the previous
   * item's end rather than its start matters for a coalesced group (e.g. a
   * multi-chunk thinking block), whose start can be well before the moment it
   * actually finished. Undefined for the first item, or when either side
   * lacks a timestamp. Negative values (clock skew) are clamped to 0.
   */
  readonly deltaMs?: number;
  /** Which {@link TimelineTurn.turnIndex} (from segmentTimelineTurns) this item belongs to. */
  readonly turnIndex: number;
}

/** Fallback run-level model/effort/override metadata parsed from a `run_config` event. */
export interface ReplayRunConfig {
  readonly model?: string;
  readonly effort?: string;
  readonly overridden?: boolean;
}

export interface ReplayRunDetail {
  readonly detail: RecordedRunDetail;
  /** Coalesced timeline: streamed assistant/thinking deltas merged into one item each. */
  readonly timeline: readonly ReplayTimelineItem[];
  /** Agent-loop turns segmented from `timeline` (see segmentTimelineTurns); durationMs clamped to >= 0. */
  readonly turns: readonly TimelineTurn[];
  /**
   * The run's LAST `run_config` event, when the run emitted one. A run can
   * double-fire this event on a session-resume-retry; the last one reflects
   * the actually-used configuration.
   */
  readonly runConfig?: ReplayRunConfig;
  /** Resolved effort: `detail.summary.effort` when present, else `runConfig?.effort`. */
  readonly effort?: string;
}

export interface ReadReplayRunOptions {
  readonly scope?: RunArtifactScope;
}

export async function readReplayRun(
  artifactDir: string,
  runId: string,
  options: ReadReplayRunOptions = {},
): Promise<ReplayRunDetail | undefined> {
  const scope = options.scope ?? "agent";
  const detail = await readRecordedRun({
    artifactDir,
    maxStringBytes: REPLAY_MAX_STRING_BYTES,
    scope,
  }, runId);
  if (detail === undefined) {
    return undefined;
  }
  const coalesced = combineRecordedRunEvents(detail.events);
  const turns = segmentTimelineTurns(coalesced).map(clampTurnDuration);
  const timeline = annotateTimeline(coalesced, turns);
  const runConfig = lastRunConfig(detail.events);
  const effort = detail.summary.effort ?? runConfig?.effort;
  return {
    detail,
    timeline,
    turns,
    ...(runConfig === undefined ? {} : { runConfig }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function replayScopeForSourceFilter(sourceFilter: string | undefined): RunArtifactScope | undefined {
  if (sourceFilter === "memory") {
    return "memory";
  }
  return undefined;
}

/**
 * `TimelineTurn.durationMs` is derived from raw event timestamps and can go
 * negative under clock skew (e.g. a resumed session). We clamp to 0 rather
 * than dropping to undefined: consumers treat `durationMs` as "elapsed time
 * for this turn" and a defined-but-zero value is easier to render (e.g. in a
 * duration column) than an extra undefined-check, at the cost of slightly
 * under-reporting the (already-untrustworthy) skewed turn.
 */
function clampTurnDuration(turn: TimelineTurn): TimelineTurn {
  if (turn.durationMs === undefined || turn.durationMs >= 0) {
    return turn;
  }
  return { ...turn, durationMs: 0 };
}

function annotateTimeline(
  items: readonly RecordedRunTimelineItem[],
  turns: readonly TimelineTurn[],
): readonly ReplayTimelineItem[] {
  const turnIndexByItem = buildTurnIndexLookup(turns, items.length);
  // Anchored on the previous item's END (its own endTimestamp when parseable,
  // else its timestamp) rather than its START — see the deltaMs doc comment.
  let previousEndMs: number | undefined;
  return items.map((item, index) => {
    const timestampMs = parseTimestampMs(item.timestamp);
    const endTimestampMs = parseTimestampMs(item.endTimestamp) ?? timestampMs;
    const deltaMs =
      previousEndMs === undefined || timestampMs === undefined ? undefined : Math.max(0, timestampMs - previousEndMs);
    previousEndMs = endTimestampMs;
    return {
      ...item,
      ...(timestampMs === undefined ? {} : { timestampMs }),
      ...(deltaMs === undefined ? {} : { deltaMs }),
      turnIndex: turnIndexByItem[index] ?? 0,
    };
  });
}

function buildTurnIndexLookup(turns: readonly TimelineTurn[], itemCount: number): number[] {
  const lookup = new Array<number>(itemCount).fill(0);
  for (const turn of turns) {
    for (let index = turn.startItemIndex; index <= turn.endItemIndex; index += 1) {
      lookup[index] = turn.turnIndex;
    }
  }
  return lookup;
}

function parseTimestampMs(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Scan the run's RAW events (not the coalesced timeline) for `run_config`
 * events and return the LAST one's fields. The harness can double-fire this
 * event on a session-resume-retry within a single run; the last occurrence
 * reflects the configuration actually used.
 */
function lastRunConfig(events: readonly RecordedRunEvent[]): ReplayRunConfig | undefined {
  let found: ReplayRunConfig | undefined;
  for (const event of events) {
    if (event.type !== "run_config" || !isRecord(event.payload)) {
      continue;
    }
    const payload = event.payload;
    found = {
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      ...(typeof payload.effort === "string" ? { effort: payload.effort } : {}),
      ...(typeof payload.overridden === "boolean" ? { overridden: payload.overridden } : {}),
    };
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
