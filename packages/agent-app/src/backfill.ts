import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  buildRunReadableSpans,
  createDeterministicIdFactory,
  postOtlpProtobuf,
  serializeTraceSpans,
} from "@mono-agent/observability/otel";
import type {
  RunArtifactScope,
  RunExportContext,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";

import {
  resolveAppArtifactDir,
  resolveAppObservabilityExporters,
  resolveAppTraceSourceId,
  resolveAppTraceSourceLabel,
} from "./app-config.js";
import type { MonoAgentAppConfigInput, ResolvedExporter } from "./app-config.js";

const SUMMARY_SUFFIX = ".summary.json";
const EVENTS_SUFFIX = ".events.jsonl";
const MEMORY_ARTIFACT_NAMESPACE = "memory";
// Backfill is a deliberate foreground batch (not the live best-effort path), so
// a single very large run gets a generous POST budget regardless of the live
// exporter's small default timeout.
const BACKFILL_TIMEOUT_MS = 60_000;
// Phoenix has a bounded span-ingestion queue and returns 503 under backpressure
// when a large batch arrives faster than it drains. Retry transient failures
// with exponential backoff so a full backfill completes instead of dropping
// runs; deterministic ids make every retry idempotent.
const BACKFILL_MAX_ATTEMPTS = 6;
const BACKFILL_BASE_BACKOFF_MS = 500;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/** True for a thrown OTLP error whose status is transient (5xx/429/408) or a non-HTTP (network) error. */
export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = /responded (\d{3})/u.exec(message);
  if (match === null) {
    return true; // network/timeout/abort — worth a retry
  }
  return RETRYABLE_STATUSES.has(Number(match[1]));
}

export interface BackfillOptions {
  /** Export exactly this run id; mutually exclusive with `all`. */
  readonly run?: string;
  /** Export every run found in the artifact dir. */
  readonly all?: boolean;
  /** Only runs whose `startedAt` is >= this ISO instant. */
  readonly since?: string;
  /** Only runs whose `startedAt` is <= this ISO instant. */
  readonly until?: string;
  /** Map + serialize but do not POST; report span counts and byte sizes. */
  readonly dryRun?: boolean;
  /** With `all`, include memory-run artifacts in addition to default agent runs. */
  readonly includeMemory?: boolean;
}

export interface BackfillRunArtifacts {
  readonly summary: RunSummary;
  readonly events: RuntimeEventLike[];
  readonly warnings: readonly string[];
}

/**
 * Read a run's on-disk artifacts directly into the shapes the OTLP mapping
 * needs. Deliberately bypasses `readRecordedRun` (which returns the classified
 * `RecordedRunEvent` shape and caps events at a maximum) so backfill exports a
 * faithful, uncapped copy: `summary.json` parses straight to `RunSummary`, and
 * each `events.jsonl` line is a raw `RuntimeEventLike`.
 */
export async function readRunArtifacts(artifactDir: string, runId: string): Promise<BackfillRunArtifacts> {
  const warnings: string[] = [];
  const runArtifactDir = await resolveRunArtifactDir(artifactDir, runId);
  const summaryRaw = await readFile(join(runArtifactDir, `${runId}${SUMMARY_SUFFIX}`), "utf8");
  const summary = JSON.parse(summaryRaw) as RunSummary;

  let events: RuntimeEventLike[] = [];
  try {
    const eventsRaw = await readFile(join(runArtifactDir, `${runId}${EVENTS_SUFFIX}`), "utf8");
    events = parseEventsJsonl(eventsRaw, warnings);
  } catch {
    warnings.push(`No ${EVENTS_SUFFIX} for ${runId}; exporting a root-span-only trace.`);
  }
  return { summary, events, warnings };
}

async function resolveRunArtifactDir(artifactDir: string, runId: string): Promise<string> {
  const topLevel = resolve(artifactDir);
  if (await fileExists(join(topLevel, `${runId}${SUMMARY_SUFFIX}`))) {
    return topLevel;
  }
  const memoryDir = join(topLevel, MEMORY_ARTIFACT_NAMESPACE);
  if (await fileExists(join(memoryDir, `${runId}${SUMMARY_SUFFIX}`))) {
    return memoryDir;
  }
  return topLevel;
}

function parseEventsJsonl(raw: string, warnings: string[]): RuntimeEventLike[] {
  const events: RuntimeEventLike[] = [];
  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      events.push(JSON.parse(trimmed) as RuntimeEventLike);
    } catch {
      warnings.push(`Skipped malformed event line ${index + 1}.`);
    }
  });
  return events;
}

/**
 * Derive the run's [start, end] in epoch nanoseconds from the recorded summary.
 * Unlike the live exporter (which stamps wall-clock `now()`), backfill must use
 * the historical timestamps so Phoenix shows the run on its real time axis.
 * `endedAt` is missing for runs that never finished (≈crashed/running) — fall
 * back to `startedAt + durationMs`.
 */
/**
 * Recover a run's kind + memory operation from its persisted conversationId.
 * Memory runs use `memory:<label>` (e.g. `memory:capture:distill`); the operation
 * is the trailing label segment (`distill`), excluding the bare `memory:bujo` fallback.
 */
function memoryRunInfo(conversationId: string): { runKind: "memory" | "channel"; operation?: string } {
  if (!conversationId.startsWith("memory:")) {
    return { runKind: "channel" };
  }
  const tail = conversationId.split(":").pop();
  return tail === undefined || tail.length === 0 || tail === "bujo"
    ? { runKind: "memory" }
    : { runKind: "memory", operation: tail };
}

export function runStartEndNanos(summary: RunSummary): { start: bigint; end: bigint } {
  const startMs = summary.startedAt !== undefined ? Date.parse(summary.startedAt) : Number.NaN;
  const safeStartMs = Number.isNaN(startMs) ? 0 : startMs;
  const endMsRaw = summary.endedAt !== undefined ? Date.parse(summary.endedAt) : Number.NaN;
  const endMs = Number.isNaN(endMsRaw) ? safeStartMs + (summary.durationMs ?? 0) : endMsRaw;
  return {
    start: BigInt(Math.trunc(safeStartMs)) * 1_000_000n,
    end: BigInt(Math.trunc(endMs < safeStartMs ? safeStartMs : endMs)) * 1_000_000n,
  };
}

function resolveProjectName(exporter: ResolvedExporter, sourceLabel: string, sourceId: string): string {
  return exporter.projectName ?? sourceLabel ?? sourceId ?? "default";
}

/** POST one run's protobuf body, retrying transient failures (e.g. Phoenix 503 backpressure) with backoff. */
async function postWithRetry(exporter: ResolvedExporter, projectName: string, body: Uint8Array): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BACKFILL_MAX_ATTEMPTS; attempt += 1) {
    try {
      await postOtlpProtobuf({
        endpoint: exporter.endpoint,
        headers: { "x-project-name": projectName, ...(exporter.headers ?? {}) },
        body,
        timeoutMs: BACKFILL_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === BACKFILL_MAX_ATTEMPTS || !isRetryable(error)) {
        throw error;
      }
      await delay(BACKFILL_BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** List run ids (base names) present in an artifact dir, sorted oldest-first by id. */
async function listRunIds(artifactDir: string, scope: RunArtifactScope): Promise<string[]> {
  const root = resolve(artifactDir);
  const ids = new Set<string>();
  for (const runId of await listRunIdsFromDir(root, "agent", scope)) {
    ids.add(runId);
  }
  if (scope === "memory" || scope === "all") {
    for (const runId of await listRunIdsFromDir(join(root, MEMORY_ARTIFACT_NAMESPACE), "memory", scope)) {
      ids.add(runId);
    }
  }
  return [...ids].sort();
}

async function listRunIdsFromDir(
  artifactDir: string,
  namespaceKind: "agent" | "memory",
  scope: RunArtifactScope,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUMMARY_SUFFIX)) {
      continue;
    }
    const runId = entry.name.slice(0, -SUMMARY_SUFFIX.length);
    if (scope === "all" || namespaceKind === "memory") {
      ids.push(runId);
      continue;
    }
    const raw = await readSummaryJson(join(artifactDir, entry.name));
    const memoryRun = raw === undefined ? runId.startsWith("mem-") : isMemoryRunSummary(raw);
    if (scope === "agent" ? !memoryRun : memoryRun) {
      ids.push(runId);
    }
  }
  return ids;
}

async function readSummaryJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isMemoryRunSummary(summary: Record<string, unknown>): boolean {
  return summary.source === "memory" ||
    (typeof summary.conversationId === "string" && summary.conversationId.startsWith("memory:")) ||
    (typeof summary.runId === "string" && summary.runId.startsWith("mem-"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}

function withinWindow(summary: RunSummary, since?: string, until?: string): boolean {
  if (since === undefined && until === undefined) {
    return true;
  }
  const startedMs = summary.startedAt !== undefined ? Date.parse(summary.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) {
    return false;
  }
  if (since !== undefined && startedMs < Date.parse(since)) {
    return false;
  }
  if (until !== undefined && startedMs > Date.parse(until)) {
    return false;
  }
  return true;
}

type RunOutcome =
  | { readonly runId: string; readonly status: "ok"; readonly spanCount: number; readonly bytes: number; readonly dryRun: boolean }
  | { readonly runId: string; readonly status: "skip"; readonly reason: string }
  | { readonly runId: string; readonly status: "fail"; readonly reason: string };

/**
 * Export already-recorded runs to the configured Phoenix exporter. Returns one
 * outcome per attempted run; a single run's network failure is non-fatal (it
 * becomes a `fail` outcome) so a partial backfill still reports. Trace/span ids
 * are deterministic (keyed on run id) so re-running is idempotent: Phoenix
 * overwrites rather than duplicating. Backfill forwards persisted
 * `summary.userInput` through the shared export context when an artifact carries
 * it; older artifacts without that field retain the root descriptor fallback.
 */
export async function backfillRuns(
  input: MonoAgentAppConfigInput,
  options: BackfillOptions,
): Promise<{ readonly artifactDir: string; readonly endpoint: string; readonly outcomes: RunOutcome[] }> {
  const exporters = await resolveAppObservabilityExporters(input);
  const exporter = exporters[0];
  if (exporter === undefined) {
    throw new Error("No observability exporter configured; add an observability.exporters phoenix entry.");
  }
  const artifactDir = await resolveAppArtifactDir(input);
  const sourceId = await resolveAppTraceSourceId(input);
  const sourceLabel = await resolveAppTraceSourceLabel(input);
  const projectName = resolveProjectName(exporter, sourceLabel, sourceId);
  const includeSensitiveData = exporter.includeSensitiveData ?? false;
  const contentPatternRedaction = exporter.contentPatternRedaction ?? false;

  const scope: RunArtifactScope = options.run !== undefined ? "all" : options.includeMemory === true ? "all" : "agent";
  const runIds = options.run !== undefined ? [options.run] : await listRunIds(artifactDir, scope);

  const outcomes: RunOutcome[] = [];
  for (const runId of runIds) {
    try {
      const { summary, events } = await readRunArtifacts(artifactDir, runId);
      if (!withinWindow(summary, options.since, options.until)) {
        outcomes.push({ runId, status: "skip", reason: "outside --since/--until window" });
        continue;
      }
      // Live runs thread runKind/memoryOperation through the export context, but
      // the artifact only persists conversationId — so recover them from it
      // (`memory:<label>` for memory runs) to keep backfilled traces' kind + memory
      // operation consistent with live exports.
      const memInfo = memoryRunInfo(summary.conversationId);
      const context: RunExportContext = {
        runId: summary.runId,
        conversationId: summary.conversationId,
        sourceId,
        sourceLabel,
        configPath: input.configPath,
        artifactDir,
        includeSensitiveData,
        contentPatternRedaction,
        runKind: memInfo.runKind,
        ...(memInfo.operation === undefined ? {} : { memoryOperation: memInfo.operation }),
        // Recorded since this feature shipped; absent for older runs (input then
        // falls back to the run descriptor on the root span).
        ...(typeof summary.userInput === "string" ? { userInput: summary.userInput } : {}),
      };
      const { start, end } = runStartEndNanos(summary);
      const spans = buildRunReadableSpans({
        summary,
        events,
        context,
        projectName,
        startTimeUnixNanos: start,
        endTimeUnixNanos: end,
        idFactory: createDeterministicIdFactory(summary.runId),
      });
      const body = serializeTraceSpans(spans);
      if (options.dryRun !== true) {
        await postWithRetry(exporter, projectName, body);
      }
      outcomes.push({ runId, status: "ok", spanCount: spans.length, bytes: body.length, dryRun: options.dryRun === true });
    } catch (error) {
      outcomes.push({ runId, status: "fail", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { artifactDir, endpoint: exporter.endpoint, outcomes };
}

export interface RunBackfillArgs {
  readonly configPath?: string;
  readonly run?: string;
  readonly all: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly dryRun: boolean;
  readonly includeMemory?: boolean;
}

/** CLI entry: resolve config, run the backfill, and print a per-run report. */
export async function runBackfill(args: RunBackfillArgs): Promise<number> {
  if (args.run === undefined && !args.all) {
    process.stderr.write("mono-agent backfill requires --run <id> or --all.\n");
    return 2;
  }
  const cwd = process.cwd();
  const input: MonoAgentAppConfigInput = {
    env: process.env,
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
  };

  let result;
  try {
    result = await backfillRuns(input, {
      ...(args.run === undefined ? {} : { run: args.run }),
      all: args.all,
      ...(args.since === undefined ? {} : { since: args.since }),
      ...(args.until === undefined ? {} : { until: args.until }),
      dryRun: args.dryRun,
      ...(args.includeMemory === undefined ? {} : { includeMemory: args.includeMemory }),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(
    `Backfilling from ${result.artifactDir} -> ${result.endpoint}${args.dryRun ? " (dry run)" : ""}\n`,
  );
  let ok = 0;
  let failed = 0;
  let totalBytes = 0;
  for (const outcome of result.outcomes) {
    if (outcome.status === "ok") {
      ok += 1;
      totalBytes += outcome.bytes;
      process.stdout.write(
        `  [ok]   ${outcome.runId} (${outcome.spanCount} spans, ${outcome.bytes} bytes)${outcome.dryRun ? " [not sent]" : ""}\n`,
      );
    } else if (outcome.status === "skip") {
      process.stdout.write(`  [skip] ${outcome.runId} (${outcome.reason})\n`);
    } else {
      failed += 1;
      process.stdout.write(`  [fail] ${outcome.runId} (${outcome.reason})\n`);
    }
  }
  process.stdout.write(`\n${ok} run(s) exported, ${failed} failed, ${totalBytes} bytes total.\n`);
  return failed > 0 ? 1 : 0;
}
