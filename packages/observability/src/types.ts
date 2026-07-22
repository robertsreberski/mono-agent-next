export interface RuntimeEventLike {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeResultLike {
  readonly cancelled?: boolean;
  readonly error?: string | null;
  readonly failureKind?: string | null;
  /**
   * Per-attempt provider failover detail emitted by the fallback router. Loosely
   * typed here because the router stores ModelRef objects and a `retryableSubkind`
   * field; {@link normalizeFailoverHistory} canonicalizes it into {@link FailoverAttempt}.
   */
  readonly failoverHistory?: unknown;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly durationMs?: number;
  readonly providerSessionId?: string | null;
  readonly isolated?: boolean;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  /** Model id this run used (e.g. the provider model string). */
  readonly model?: string;
  /** System prompt the main run was driven with (the compiled context prompt). */
  readonly systemPrompt?: string;
  readonly [key: string]: unknown;
}

export type RunSummaryStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type RunArtifactKind = "agent" | "memory";
export type RunArtifactScope = RunArtifactKind | "all";

export type KnownArtifactFailureKind =
  | "provider_unavailable"
  | "provider_unavailable_exhausted"
  | "provider_auth"
  | "skipped_capability_mismatch"
  | "context_limit"
  | "usage_limit"
  | "process_death"
  | "runtime_error"
  | "cancelled"
  | "cancelled_user"
  | "cancelled_stale"
  | "cancelled_shutdown"
  | "cancelled_signal";

export interface ArtifactAuditFileIssue {
  readonly fileName: string;
  readonly reason: string;
  readonly value?: string;
}

export interface ArtifactFailureKindRate {
  readonly failureKind: KnownArtifactFailureKind;
  readonly count: number;
  readonly rateOfParsedSummaries: number;
  readonly rateOfSummariesWithFailureKind: number;
}

export interface ArtifactAuditReport {
  readonly artifactDir: string;
  readonly totalSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly parseFailureCount: number;
  readonly parseFailures: readonly ArtifactAuditFileIssue[];
  readonly statusHistogram: Readonly<Record<RunSummaryStatus, number>>;
  readonly unrecognizedStatusCount: number;
  readonly unrecognizedStatuses: readonly ArtifactAuditFileIssue[];
  readonly failureKindHistogram: Readonly<Record<KnownArtifactFailureKind, number>>;
  readonly summariesWithFailureKind: number;
  readonly unrecognizedFailureKindCount: number;
  readonly unrecognizedFailureKinds: readonly ArtifactAuditFileIssue[];
  readonly staleRunningCount: number;
  readonly staleRunning: readonly ArtifactAuditFileIssue[];
  readonly failureKindRates: readonly ArtifactFailureKindRate[];
  readonly rateDenominators: {
    readonly parsedSummaries: number;
    readonly summariesWithFailureKind: number;
  };
  readonly warnings: readonly string[];
}

/**
 * One provider attempt recorded by the fallback router when a run fails over.
 * Canonicalized (model reference flattened to a string, `retryableSubkind` →
 * `subkind`) so the persisted shape is stable across router/runtime versions.
 */
export interface FailoverAttempt {
  /** Model reference tried, e.g. "pi:openai-codex:gpt-5.5". */
  readonly model?: string;
  /** Failure kind for this attempt, e.g. "provider_unavailable" or "skipped_capability_mismatch". */
  readonly failureKind?: string;
  /** Retryable sub-classification, e.g. "timeout", "server_error", "overloaded", "rate_limited". */
  readonly subkind?: string;
  /** Provider request id, when the underlying error text carried one. */
  readonly requestId?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
  /**
   * Underlying provider/runtime error message for a failed run. Retained free
   * text: bounded at recorder/reader boundaries and content-scanned by the
   * recorder for a closed set of high-confidence credential shapes.
   * `failureKind` is the taxonomy label ("provider_unavailable_exhausted"); this is
   * the human-readable "why" (the actual provider message), persisted so the trace
   * shows it instead of only the collapsed kind.
   */
  readonly error?: string;
  /**
   * Per-attempt provider failover detail when the fallback router exhausted its
   * chain. Lets a trace show which models were tried and how each failed, instead
   * of only the collapsed `provider_unavailable_exhausted` kind.
   */
  readonly failoverHistory?: readonly FailoverAttempt[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt?: string;
  readonly durationMs: number;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly providerSessionId?: string | null;
  readonly isolated?: boolean;
  readonly eventCount: number;
  readonly artifactPaths: readonly string[];
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  /**
   * The user's prompt for this run, persisted so backfill can show it as input.
   * Retained free text: bounded at recorder/reader boundaries and content-scanned
   * by the recorder for a closed set of high-confidence credential shapes.
   */
  readonly userInput?: string;
  /** Model id this run used; surfaced as `llm.model_name` on the exported span. */
  readonly model?: string;
  /**
   * System instructions for this run (the memory maintenance prompt for memory
   * runs, the compiled identity+skills+memory prompt for channel runs), persisted
   * as retained free text so the trace shows what the model was instructed to do.
   * It is capped by the dedicated recorder limit and content-scanned by the
   * recorder for a closed set of high-confidence credential shapes.
   */
  readonly systemPrompt?: string;
  /** Resolved reasoning-effort level the run executed with (e.g. "low", "high"). */
  readonly effort?: string;
  /** Originating channel/trigger kind, e.g. "tui" | "telegram" | "slack" | "cron" | "webhook" | "memory". */
  readonly source?: string;
  /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
  readonly sourceDetail?: string;
}

export interface RunRecorder {
  start?(): Promise<RunSummary>;
  onEvent(event: RuntimeEventLike): void;
  /**
   * Awaitable, non-terminal preflight for a successful result. Harnesses use
   * this as the last cancellation window before committing conversation state.
   * It MUST NOT write/export a terminal summary or publish `run_finished`.
   */
  prepareFinish?(result: RuntimeResultLike): Promise<void>;
  /**
   * Commit the prepared result exactly once. Implementations should make this
   * idempotent so repeated callers observe the same terminal summary without a
   * second export or terminal live frame.
   */
  commitFinish?(result: RuntimeResultLike): Promise<RunSummary>;
  finish(result: RuntimeResultLike): Promise<RunSummary>;
  fail(error: unknown): Promise<RunSummary>;
}

export interface RunExportContext {
  readonly runId: string;
  readonly conversationId: string;
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly configPath?: string;
  readonly artifactDir?: string;
  readonly includeSensitiveData: boolean;
  /**
   * Defense-in-depth scan for high-confidence credential shapes inside retained
   * free text. Opt-in and false by default; key-name redaction remains always on.
   */
  readonly contentPatternRedaction?: boolean;
  /**
   * The user's prompt for this run, used as the root span's `input.value` so the
   * trace shows what was asked. Live export threads the request value directly;
   * backfill forwards persisted `summary.userInput` when the artifact carries
   * it (older artifacts may omit it). This retained free text is bounded at the
   * Phoenix span boundary. It is not content-scanned by default;
   * `contentPatternRedaction` enables the closed high-confidence scan.
   */
  readonly userInput?: string;
  /**
   * Classifies the run so memory runs are distinguishable from channel runs in
   * Phoenix: drives the root `openinference.span.kind` ("memory" vs "AGENT") and
   * the `mono.agent.run.kind` attribute. Threaded explicitly rather than sniffed
   * from the run-id prefix.
   */
  readonly runKind?: "memory" | "channel";
  /** Memory sub-operation for memory runs: distill|reconcile|entities|reflect|migrate. */
  readonly memoryOperation?: string;
}

export interface RunExportEventContext extends RunExportContext {
  readonly eventIndex: number;
}

export interface RunExporter {
  start?(context: RunExportContext): Promise<void> | void;
  onEvent?(event: RuntimeEventLike, context: RunExportEventContext): Promise<void> | void;
  finish?(summary: RunSummary, context: RunExportContext): Promise<void> | void;
  fail?(summary: RunSummary, error: unknown, context: RunExportContext): Promise<void> | void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface PhoenixExporterConfig {
  readonly type: "phoenix";
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly includeSensitiveData?: boolean;
  /**
   * Scan retained exported free-text values for a closed set of high-confidence
   * credential shapes. Defaults to false; key redaction remains enabled.
   */
  readonly contentPatternRedaction?: boolean;
  readonly timeoutMs?: number;
  /**
   * Phoenix project the traces land in (resource attr `openinference.project.name`).
   * Defaults to the run's trace source label/id, else "default".
   */
  readonly projectName?: string;
}

export type ObservabilityExporterConfig = PhoenixExporterConfig;

export interface JsonlRunRecorderOptions {
  readonly runId: string;
  readonly conversationId: string;
  readonly artifactDir: string;
  /**
   * Physical artifact namespace under `artifactDir`. Defaults to top-level
   * agent artifacts; memory maintenance runs should use the dedicated
   * `memory/` namespace while still stamping `source: "memory"` when relevant.
   */
  readonly artifactKind?: RunArtifactKind;
  readonly clock?: () => number;
  readonly maxStringBytes?: number;
  /** Whether this run is intentionally detached from the shared warm provider session. */
  readonly isolated?: boolean;
  /**
   * The user's prompt; persisted as retained free text into the summary as
   * `userInput`. It is bounded by `maxStringBytes` and content-scanned for a
   * closed set of high-confidence credential shapes.
   */
  readonly userInput?: string;
  /**
   * System instructions for this run; persisted as retained free text, capped to
   * a dedicated larger limit than `maxStringBytes`, into the summary as
   * `systemPrompt`. The prompt is content-scanned for a closed set of
   * high-confidence credential shapes. Used by the memory path, which supplies
   * its constant prompt at recorder-creation time.
   */
  readonly systemPrompt?: string;
  /**
   * Originating channel/trigger kind for this run, e.g. "tui" | "telegram" |
   * "slack" | "cron" | "webhook" | "memory". Persisted verbatim into the summary
   * as `source`. See {@link deriveRunSource} for the conversationId-based fallback
   * consumers use when a summary predates this field.
   */
  readonly source?: string;
  /**
   * Trigger name for `source`, e.g. the cron job id or webhook endpoint name.
   * Persisted verbatim into the summary as `sourceDetail`.
   */
  readonly sourceDetail?: string;
}

export type RecordedRunEventCategory = "tool" | "thinking" | "message" | "runtime" | "error";

export interface RecordedRunListItem {
  readonly runId: string;
  readonly conversationId: string;
  readonly status: RunSummaryStatus;
  readonly failureKind?: string;
  /**
   * Underlying provider/runtime error message for a failed run. Retained free
   * text: re-bounded by the reader. Current recorder artifacts were content-scanned
   * for high-confidence credential shapes; the reader does not retroactively scan
   * legacy artifacts.
   */
  readonly error?: string;
  /** Per-attempt provider failover detail when the fallback router exhausted its chain. */
  readonly failoverHistory?: readonly FailoverAttempt[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs: number;
  readonly eventCount: number;
  readonly updatedAt: string;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly model?: string;
  readonly providerSessionId?: string | null;
  readonly isolated?: boolean;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  /** Resolved reasoning-effort level the run executed with (e.g. "low", "high"). */
  readonly effort?: string;
  /** Originating channel/trigger kind, e.g. "tui" | "telegram" | "slack" | "cron" | "webhook" | "memory". */
  readonly source?: string;
  /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
  readonly sourceDetail?: string;
  /**
   * The user's prompt for this run, persisted so backfill/replay can show it as
   * input. Retained free text is re-bounded by the reader. Current recorder
   * artifacts were content-scanned for high-confidence credential shapes; the
   * reader does not retroactively scan legacy artifacts.
   */
  readonly userInput?: string;
  /**
   * System instructions for this run, surfaced so replay can show what the model
   * was instructed with. Retained free text is re-bounded by the reader. Current
   * recorder artifacts were content-scanned for high-confidence credential
   * shapes; the reader does not retroactively scan legacy artifacts.
   */
  readonly systemPrompt?: string;
  /** Summary artifact filename under the artifact dir, when the list item came from disk. */
  readonly summaryFileName?: string;
  /** Summary artifact mtime in milliseconds, when the list item came from disk. */
  readonly summaryMtimeMs?: number;
}

export interface RecordedRunEvent {
  readonly index: number;
  readonly type?: string;
  readonly category: RecordedRunEventCategory;
  readonly timestamp?: string;
  readonly label: string;
  readonly summary: string;
  readonly payload: unknown;
}

export interface RecordedRunTimelineItem extends RecordedRunEvent {
  readonly sourceEventCount: number;
  readonly sourceEventStartIndex: number;
  readonly sourceEventEndIndex: number;
  /**
   * Total character count of the coalesced group's joined thinking/text block
   * text, captured BEFORE {@link SUMMARY_MAX_CHARS} summary compaction — so
   * consumers that need the real content volume (e.g. turn thinking stats)
   * aren't limited by the display-oriented summary cap. Set for coalesced
   * thinking/text groups (`sourceEventCount > 1`); left undefined for
   * single-event items and for groups without a joinable text (e.g. tool
   * events, which are never coalesced).
   */
  readonly contentChars?: number;
  /**
   * The group's last source event's (normalized ISO) timestamp. Single-event
   * items reuse their own `timestamp`. Undefined when no source event in the
   * group carried a timestamp (e.g. artifacts recorded before the recorder
   * began stamping events).
   */
  readonly endTimestamp?: string;
}

/**
 * One agent-loop turn within a single recorded run's timeline: one recorded
 * run corresponds to one user request, and each turn is the work the agent
 * did before/after a round-trip through one or more tools. Turn 0 starts at
 * the first timeline item; once a `user` `tool_result` item has been seen in
 * the current turn, the turn ends immediately BEFORE the next `assistant`-
 * typed item (a PARALLEL tool batch streams all its `tool_use` items before
 * any `tool_timing`/`tool_result` pairs arrive, so non-assistant items after
 * the first tool_result — more tool_results, tool_timing, runtime events —
 * stay in the current turn rather than each starting a new one; see
 * {@link segmentTimelineTurns}).
 */
export interface TimelineTurn {
  readonly turnIndex: number;
  /** Inclusive start index into the `items` array passed to `segmentTimelineTurns`. */
  readonly startItemIndex: number;
  /** Inclusive end index into the `items` array passed to `segmentTimelineTurns`. */
  readonly endItemIndex: number;
  /** First item-with-timestamp's timestamp in the turn; undefined when none carried one. */
  readonly startedAt?: string;
  /** `durationMs` = last item's `endTimestamp`/`timestamp` minus `startedAt`, when both parse. */
  readonly durationMs?: number;
  /** Sum of `contentChars` over the turn's `"thinking"`-category items. */
  readonly thinkingChars: number;
  /**
   * Completed tool calls in the turn: the number of `tool_result` content
   * blocks across the turn's `user`-typed tool items (category `"tool"`), not
   * a flat 1-per-item count — a single `user` event can carry more than one
   * `tool_result` block.
   */
  readonly toolCalls: number;
}

export interface RecordedRunDetail {
  readonly summary: RecordedRunListItem;
  readonly events: readonly RecordedRunEvent[];
  readonly warnings: readonly string[];
}

export interface RecordedRunListResult {
  readonly totalRuns: number;
  readonly runs: readonly RecordedRunListItem[];
  readonly warnings: readonly string[];
}

export interface JsonlRunReaderOptions {
  readonly artifactDir: string;
  readonly scope?: RunArtifactScope;
  readonly maxRuns?: number;
  readonly maxEventsPerRun?: number;
  /** Keep the default prefix, or retain an equal-sized tail when the event cap is reached. */
  readonly eventSelection?: "head" | "head-tail";
  readonly maxStringBytes?: number;
}

export type TraceSourceStatus = "running" | "stopped" | "failed";
export type TraceSourceHealth = "running" | "stale" | "stopped" | "failed";

export type TraceSourceMemoryBackend = "bujo" | "supermemory" | "none";
export type TraceSourceMemoryMode = "lite" | "journal" | "bujo";
export type TraceSourceMemoryStatus =
  | "healthy"
  | "in_progress"
  | "degraded"
  | "unhealthy"
  | "unknown"
  | "not_configured";
export type TraceSourceMemoryIssue =
  | "manifest_missing"
  | "manifest_invalid"
  | "configured_identity_mismatch"
  | "database_missing"
  | "database_unavailable"
  | "native_module_unavailable"
  | "health_check_failed"
  | "sqlite_integrity_failed"
  | "metadata_mismatch"
  | "fts_mismatch"
  | "vector_mismatch"
  | "orphaned_rows"
  | "canonical_mismatch"
  | "canonical_invalid"
  | "mutation_in_progress"
  | "intake_invalid"
  | "intake_pending"
  | "dead_letters"
  | "outbox_invalid"
  | "outbox_pending"
  | "work_stalled"
  | "temporary_artifacts"
  | "runtime_missing"
  | "runtime_stale"
  | "runtime_invalid";

export interface TraceSourceMemoryCounts {
  readonly pending?: number;
  readonly due?: number;
  readonly dead?: number;
  readonly outbox?: number;
  readonly temporary?: number;
  readonly memories?: number;
  readonly vectors?: number;
  readonly missingVectors?: number;
}

interface TraceSourceMemoryHealthBase {
  /** ISO-8601 instant for the audit that produced this health snapshot. */
  readonly checkedAt: string;
}

/** Strict built-in health. Status is the deterministic projection of `issues`. */
export interface TraceSourceBujoMemoryHealth extends TraceSourceMemoryHealthBase {
  readonly backend: "bujo";
  readonly mode: TraceSourceMemoryMode;
  readonly status: Exclude<TraceSourceMemoryStatus, "not_configured">;
  readonly issues: readonly TraceSourceMemoryIssue[];
  readonly counts?: TraceSourceMemoryCounts;
}

/** Remote Supermemory cannot be inspected by the local trace registry. */
export interface TraceSourceSupermemoryMemoryHealth extends TraceSourceMemoryHealthBase {
  readonly backend: "supermemory";
  readonly status: "unknown";
  readonly mode?: never;
  readonly issues?: never;
  readonly counts?: never;
}

/** No configured backend, or configuration could not be loaded safely. */
export interface TraceSourceNoMemoryHealth extends TraceSourceMemoryHealthBase {
  readonly backend: "none";
  readonly status: "not_configured" | "unknown";
  readonly mode?: never;
  readonly issues?: never;
  readonly counts?: never;
}

/** Content-free memory health safe to publish in a trace-source manifest. */
export type TraceSourceMemoryHealth =
  | TraceSourceBujoMemoryHealth
  | TraceSourceSupermemoryMemoryHealth
  | TraceSourceNoMemoryHealth;

export interface TraceSourceManifest {
  readonly schema: "agent-runtime.trace-source.v1";
  readonly sourceId: string;
  readonly label: string;
  readonly artifactDir: string;
  readonly pid?: number;
  readonly status: TraceSourceStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
  readonly memoryHealth?: TraceSourceMemoryHealth;
}

export interface TraceSourceListItem extends TraceSourceManifest {
  readonly health: TraceSourceHealth;
  readonly warnings: readonly string[];
}

export interface TraceRunListItem extends RecordedRunListItem {
  /**
   * The trace-source PROCESS this run was read from (which agent instance).
   * Distinct from the inherited `source`, the run's originating channel/trigger
   * kind (e.g. "telegram") — a run can carry both.
   */
  readonly traceSource: TraceSourceListItem;
}

export interface TraceRunDetail {
  /** The trace-source PROCESS this run was read from (which agent instance). */
  readonly traceSource: TraceSourceListItem;
  readonly run: RecordedRunDetail;
}

export interface TraceSourceRegistryOptions {
  readonly registryDir: string;
  readonly staleAfterMs?: number;
  readonly clock?: () => number;
}

export interface RegisterTraceSourceOptions extends TraceSourceRegistryOptions {
  readonly sourceId?: string;
  readonly label: string;
  readonly artifactDir: string;
  readonly pid?: number;
  readonly status?: TraceSourceStatus;
  readonly startedAt?: string;
  readonly heartbeatMs?: number;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
  readonly memoryHealth?: TraceSourceMemoryHealth;
}

export interface UpdateTraceSourceOptions {
  readonly status?: TraceSourceStatus;
  readonly artifactDir?: string;
  readonly transports?: readonly string[];
  readonly configPath?: string;
  readonly metadata?: Record<string, unknown>;
  readonly memoryHealth?: TraceSourceMemoryHealth;
}

export interface TraceSourceHandle {
  readonly manifest: TraceSourceManifest;
  update(patch: UpdateTraceSourceOptions): Promise<TraceSourceManifest>;
  heartbeat(): Promise<TraceSourceManifest>;
  stop(patch?: Omit<UpdateTraceSourceOptions, "status"> & { readonly status?: "stopped" | "failed" }): Promise<TraceSourceManifest>;
}

export interface TraceSourceListResult {
  readonly registryDir: string;
  readonly sources: readonly TraceSourceListItem[];
  readonly warnings: readonly string[];
}

export interface TraceRunListOptions extends TraceSourceRegistryOptions {
  readonly scope?: RunArtifactScope;
  readonly maxRuns?: number;
  readonly maxEventsPerRun?: number;
  readonly maxStringBytes?: number;
}

export interface TraceRunListResult {
  readonly registryDir: string;
  readonly sources: readonly TraceSourceListItem[];
  readonly runs: readonly TraceRunListItem[];
  readonly warnings: readonly string[];
}

export interface PruneTraceSourcesOptions {
  readonly registryDir: string;
  /** Manifests whose heartbeat is older than this AND whose pid is dead are removed. Default {@link DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS}. */
  readonly olderThanMs?: number;
  /** Test seam for pid liveness; defaults to a real `process.kill(pid, 0)` probe. */
  readonly isAlive?: (pid: number) => boolean;
  readonly clock?: () => number;
}

export interface PruneTraceSourcesResult {
  readonly removed: number;
}
