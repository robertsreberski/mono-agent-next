import { constants as fsConstants } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  artifactDirForKind,
  normalizeRunArtifactScope,
  relativeSummaryFileName,
  summaryMatchesArtifactScope,
  type SummaryFileLocation,
} from "./artifact-scope.js";
import {
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_STRING_BYTES,
  errorMessage,
  isErrno,
  isRecord,
  minInteger,
  normalizeRunId as normalizeRunIdGuard,
  positiveInteger,
  safeArtifactName,
  safeJoin as safeJoinGuard,
  stringField,
  writeJsonAtomic,
} from "./artifact-fs.js";
import { buildEventDescriptors, classifyRecordedRunEvent } from "./event-classify.js";
import { redactJsonValue } from "./recorder.js";
import { normalizeFailoverHistory } from "./run-export-mapping.js";
import {
  EVENTS_SUFFIX,
  SUMMARY_SUFFIX,
  isRunSummaryStatus,
  isStaleRunningSummary,
} from "./summary-schema.js";
import type {
  JsonlRunReaderOptions,
  RecordedRunDetail,
  RecordedRunEvent,
  RecordedRunListItem,
  RecordedRunListResult,
  RunSummary,
  RunSummaryStatus,
  RuntimeEventLike,
} from "./types.js";

export { classifyRecordedRunEvent };

interface NormalizedReaderOptions {
  readonly artifactDir: string;
  readonly scope: "agent" | "memory" | "all";
  readonly scopeProvided: boolean;
  readonly maxRuns: number;
  readonly maxEventsPerRun: number;
  readonly eventSelection: "head" | "head-tail";
  readonly maxStringBytes: number;
}

interface ParsedSummaryFile {
  readonly fileName: string;
  readonly artifactDir: string;
  readonly summary: RunSummary;
  readonly updatedAt: string;
  readonly mtimeMs: number;
}

const MAX_HEAD_TAIL_EVENT_ARTIFACT_BYTES = 16 * 1_024 * 1_024;

export type ObservabilityReadErrorCode = "invalid_reader_options" | "invalid_run_id";
export type ObservabilityReadErrorDetails = Record<string, unknown> & { readonly code: ObservabilityReadErrorCode };

export class ObservabilityReadError extends Error {
  readonly code: ObservabilityReadErrorCode;
  readonly details: ObservabilityReadErrorDetails;

  constructor(code: ObservabilityReadErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ObservabilityReadError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export async function listRecordedRuns(options: JsonlRunReaderOptions): Promise<RecordedRunListResult> {
  const normalized = normalizeReaderOptions(options);
  const { summaries, warnings } = await loadSummaryFiles(normalized, true);
  return {
    totalRuns: summaries.length,
    runs: [...summaries]
      // Newest first by logical update time, with file mtime then runId as deterministic
      // tiebreakers — two runs finishing in the same millisecond share an `updatedAt`, and
      // without a tiebreaker their order (and any top-N slice) is unstable.
      .sort(
        (a: ParsedSummaryFile, b: ParsedSummaryFile) =>
          summaryUpdatedAtMs(b) - summaryUpdatedAtMs(a)
          || b.mtimeMs - a.mtimeMs
          || b.summary.runId.localeCompare(a.summary.runId),
      )
      .slice(0, normalized.maxRuns)
      .map((entry) => summaryToListItem(entry.summary, entry.updatedAt, normalized.maxStringBytes, entry)),
    warnings,
  };
}

export interface ReconcileStaleRunsResult {
  /** runIds whose summaries were rewritten from "running" to "interrupted". */
  readonly reconciled: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Reclaims orphaned run summaries: a process that dies mid-run (OOM/SIGKILL/crash) leaves its
 * summary stuck at status "running" forever, so `status`/observability show a ghost run that never
 * ends. On startup the host calls this to rewrite any "running" summary that began BEFORE this
 * process started to status "interrupted" (failureKind "process_death"). Runs started at/after
 * `startedBeforeMs` belong to the live process and are left untouched — so this is safe to call
 * once at startup, before new runs begin. Read-only-safe and best-effort: a bad file is skipped
 * with a warning, never thrown.
 *
 * Reconciliation repairs summary status only and can report only persisted artifacts. The JSONL
 * recorder creates empty events plus a running summary at `start()`, then schedules key-redacted,
 * bounded running snapshots after 25 new events or five seconds and writes a terminal snapshot at
 * `finish()`/`fail()`. Each boundary replaces events first and summary second. A crash can retain
 * only the last completed prefix, lose the unsaved tail, leave newer events beside the prior
 * summary, or still yield `eventCount: 0` when no incremental pair completed. The host's live
 * broadcast is best-effort visibility for connected clients, not disk recovery.
 */
export async function reconcileStaleRunArtifacts(
  artifactDir: string,
  options: { readonly startedBeforeMs: number; readonly clock?: () => number },
): Promise<ReconcileStaleRunsResult> {
  const warnings: string[] = [];
  const reconciled: string[] = [];
  const now = (options.clock ?? (() => Date.now()))();
  const nowIso = new Date(now).toISOString();

  let entries;
  try {
    entries = await readdir(resolve(artifactDir), { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { reconciled, warnings };
    }
    return { reconciled, warnings: [`Unable to read artifact directory: ${errorMessage(error)}.`] };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUMMARY_SUFFIX)) {
      continue;
    }
    const filePath = safeJoin(resolve(artifactDir), entry.name);
    let parsed: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (!isRecord(raw)) {
        continue;
      }
      parsed = raw;
    } catch {
      continue; // unreadable/invalid summary — leave it for the reader's own warnings
    }
    // Only reclaim runs that began before this process started — a live run of THIS process
    // (started at/after the cutoff) is genuinely in flight and must not be touched.
    if (!isStaleRunningSummary(parsed, options.startedBeforeMs)) {
      continue;
    }
    const updated = {
      ...parsed,
      status: "interrupted",
      failureKind: typeof parsed.failureKind === "string" ? parsed.failureKind : "process_death",
      endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : nowIso,
      updatedAt: nowIso,
    };
    try {
      await writeJsonAtomic(filePath, `${JSON.stringify(updated, null, 2)}\n`);
      reconciled.push(typeof parsed.runId === "string" ? parsed.runId : entry.name.slice(0, -SUMMARY_SUFFIX.length));
    } catch (error) {
      warnings.push(`Unable to reconcile ${entry.name}: ${errorMessage(error)}.`);
    }
  }

  return { reconciled, warnings };
}

export async function readRecordedRun(
  options: JsonlRunReaderOptions,
  runId: string,
): Promise<RecordedRunDetail | undefined> {
  const normalized = normalizeReaderOptions(options);
  const normalizedRunId = normalizeRunId(runId);
  const baseName = safeArtifactName(normalizedRunId);
  const warnings: string[] = [];

  const locations = readLocationsForRun(normalized, `${baseName}${SUMMARY_SUFFIX}`);
  let summary: ParsedSummaryFile | undefined;
  for (const location of locations) {
    const parsed = await readSummaryFile(safeJoin(location.artifactDir, location.fileName), location, normalized, warnings);
    if (parsed === undefined || parsed.summary.runId !== normalizedRunId) {
      continue;
    }
    if (summaryAllowedForRead(location.namespaceKind, parsed.summary, normalized)) {
      summary = parsed;
      break;
    }
  }
  if (summary === undefined) {
    return undefined;
  }

  const eventsPath = safeJoin(summary.artifactDir, `${baseName}${EVENTS_SUFFIX}`);
  const events = await readEventsFile(eventsPath, normalized, warnings);

  return {
    summary: summaryToListItem(summary.summary, summary.updatedAt, normalized.maxStringBytes, summary),
    events,
    warnings,
  };
}

async function loadSummaryFiles(normalized: NormalizedReaderOptions, includeTopLevelUnknownWarnings: boolean): Promise<{
  readonly summaries: readonly ParsedSummaryFile[];
  readonly warnings: readonly string[];
}> {
  const warnings: string[] = [];
  const summaries: ParsedSummaryFile[] = [];

  await loadSummaryFilesFromNamespace(normalized, "agent", summaries, warnings, {
    includeUnknownWarnings: includeTopLevelUnknownWarnings && normalized.scope !== "memory",
  });
  if (normalized.scope === "memory" || normalized.scope === "all") {
    await loadSummaryFilesFromNamespace(normalized, "memory", summaries, warnings, { includeUnknownWarnings: true });
  }
  return { summaries, warnings };
}

async function loadSummaryFilesFromNamespace(
  normalized: NormalizedReaderOptions,
  namespaceKind: "agent" | "memory",
  summaries: ParsedSummaryFile[],
  warnings: string[],
  options: { readonly includeUnknownWarnings: boolean },
): Promise<void> {
  const artifactDir = artifactDirForKind(normalized.artifactDir, namespaceKind);
  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    warnings.push(`Unable to read artifact directory: ${errorMessage(error)}.`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SUMMARY_SUFFIX)) {
      continue;
    }
    const location: SummaryFileLocation = {
      artifactDir,
      fileName: entry.name,
      relativeFileName: relativeSummaryFileName(entry.name, namespaceKind),
      namespaceKind,
    };
    const targetWarnings = options.includeUnknownWarnings ? warnings : [];
    const parsed = await readSummaryFile(safeJoin(artifactDir, entry.name), location, normalized, targetWarnings);
    if (
      parsed !== undefined &&
      summaryMatchesArtifactScope(namespaceKind, parsed.summary, normalized.scope)
    ) {
      summaries.push(parsed);
    }
  }
}

async function readSummaryFile(
  filePath: string,
  location: SummaryFileLocation,
  normalized: NormalizedReaderOptions,
  warnings: string[],
): Promise<ParsedSummaryFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    warnings.push(`Unable to read ${location.relativeFileName}: ${errorMessage(error)}.`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Skipping ${location.relativeFileName}: invalid JSON (${errorMessage(error)}).`);
    return undefined;
  }

  const summary = coerceRunSummary(parsed, location.relativeFileName, warnings, normalized.maxStringBytes);
  if (summary === undefined) {
    return undefined;
  }

  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    warnings.push(`Unable to stat ${location.relativeFileName}: ${errorMessage(error)}.`);
    return undefined;
  }

  return {
    fileName: location.relativeFileName,
    artifactDir: location.artifactDir,
    summary,
    updatedAt: stats.mtime.toISOString(),
    mtimeMs: stats.mtimeMs,
  };
}

async function readEventsFile(
  filePath: string,
  normalized: NormalizedReaderOptions,
  warnings: string[],
): Promise<readonly RecordedRunEvent[]> {
  if (normalized.eventSelection === "head-tail") {
    return await readEventsFileHeadTail(filePath, normalized, warnings);
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      warnings.push("Event artifact is missing for this run.");
      return [];
    }
    warnings.push(`Unable to read event artifact: ${errorMessage(error)}.`);
    return [];
  }

  const events: RecordedRunEvent[] = [];
  const lines = raw.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    if (events.length >= normalized.maxEventsPerRun) {
      warnings.push(`Event list was capped at ${normalized.maxEventsPerRun} events.`);
      break;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      events.push(toRecordedEvent(parsed, events.length, normalized.maxStringBytes));
    } catch (error) {
      warnings.push(`Skipping malformed event line ${i + 1}: ${errorMessage(error)}.`);
    }
  }
  return events;
}

interface SelectedEventLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly eventIndex: number;
}

async function readEventsFileHeadTail(
  filePath: string,
  normalized: NormalizedReaderOptions,
  warnings: string[],
): Promise<readonly RecordedRunEvent[]> {
  let file;
  try {
    file = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      warnings.push("Event artifact is missing for this run.");
      return [];
    }
    warnings.push(`Unable to read event artifact: ${errorMessage(error)}.`);
    return [];
  }

  const firstCount = Math.ceil(normalized.maxEventsPerRun / 2);
  const lastCount = normalized.maxEventsPerRun - firstCount;
  const head: SelectedEventLine[] = [];
  const tail: SelectedEventLine[] = [];
  let tailCursor = 0;
  let eventCount = 0;
  let lineNumber = 0;
  let exceededReadBound = false;
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_HEAD_TAIL_EVENT_ARTIFACT_BYTES) {
      warnings.push("Event artifact exceeds the safe head-tail read bound.");
      return [];
    }
    // `end` is inclusive and constrains raw reads before readline can buffer an
    // unterminated/growing line. Re-stat the same open descriptor afterward to
    // turn concurrent growth beyond the bound into an explicit omission.
    const input = file.createReadStream({
      encoding: "utf8",
      autoClose: false,
      start: 0,
      end: MAX_HEAD_TAIL_EVENT_ARTIFACT_BYTES - 1,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      const selected = { line, lineNumber, eventIndex: eventCount };
      eventCount += 1;
      if (head.length < firstCount) {
        head.push(selected);
      } else if (lastCount > 0 && tail.length < lastCount) {
        tail.push(selected);
      } else if (lastCount > 0) {
        tail[tailCursor] = selected;
        tailCursor = (tailCursor + 1) % lastCount;
      }
    }
    exceededReadBound = (await file.stat()).size > MAX_HEAD_TAIL_EVENT_ARTIFACT_BYTES;
  } catch (error) {
    warnings.push(`Unable to read event artifact: ${errorMessage(error)}.`);
    return [];
  } finally {
    await file.close().catch(() => undefined);
  }
  if (exceededReadBound) {
    warnings.push("Event artifact exceeds the safe head-tail read bound.");
    return [];
  }

  const capped = eventCount > normalized.maxEventsPerRun;
  const orderedTail = capped && tail.length === lastCount && lastCount > 0
    ? [...tail.slice(tailCursor), ...tail.slice(0, tailCursor)]
    : tail;
  if (capped) {
    warnings.push(
      `Event list was capped at ${normalized.maxEventsPerRun} events using first-and-last selection.`,
    );
  }

  const events: RecordedRunEvent[] = [];
  for (const selected of [...head, ...orderedTail]) {
    try {
      const parsed = JSON.parse(selected.line) as unknown;
      events.push(toRecordedEvent(parsed, selected.eventIndex, normalized.maxStringBytes));
    } catch (error) {
      warnings.push(`Skipping malformed event line ${selected.lineNumber}: ${errorMessage(error)}.`);
    }
  }
  return events;
}

function coerceRunSummary(
  value: unknown,
  fileName: string,
  warnings: string[],
  maxStringBytes: number,
): RunSummary | undefined {
  if (!isRecord(value)) {
    warnings.push(`Skipping ${fileName}: summary is not an object.`);
    return undefined;
  }
  const runId = stringField(value, "runId");
  const conversationId = stringField(value, "conversationId");
  const status = isRunSummaryStatus(value.status) ? value.status : undefined;
  const durationMs = finiteNumberField(value, "durationMs");
  const eventCount = integerNumberField(value, "eventCount");
  if (runId === undefined || conversationId === undefined || status === undefined || durationMs === undefined || eventCount === undefined) {
    warnings.push(`Skipping ${fileName}: summary is missing required run metadata.`);
    return undefined;
  }

  const failureKind = stringField(value, "failureKind");
  const error = stringField(value, "error");
  const failoverHistory = normalizeFailoverHistory(value.failoverHistory);
  const startedAt = stringField(value, "startedAt");
  const endedAt = stringField(value, "endedAt");
  const updatedAt = stringField(value, "updatedAt");
  const providerSessionId = providerSessionIdField(value.providerSessionId);
  const isolated = booleanField(value, "isolated");
  const artifactPaths = Array.isArray(value.artifactPaths) ? value.artifactPaths.filter((entry): entry is string => typeof entry === "string") : [];
  const model = stringField(value, "model");
  const effort = stringField(value, "effort");
  const source = stringField(value, "source");
  const sourceDetail = stringField(value, "sourceDetail");
  const userInput = stringField(value, "userInput");
  const systemPrompt = stringField(value, "systemPrompt");
  const summary: RunSummary = {
    runId,
    conversationId,
    status,
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(error === undefined ? {} : { error: redactJsonValue(error, maxStringBytes) as string }),
    ...(failoverHistory === undefined ? {} : { failoverHistory }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    durationMs,
    ...(value.usage === undefined ? {} : { usage: redactJsonValue(value.usage, maxStringBytes) }),
    ...(value.cost === undefined ? {} : { cost: redactJsonValue(value.cost, maxStringBytes) }),
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(isolated === undefined ? {} : { isolated }),
    eventCount,
    artifactPaths,
    ...(model === undefined ? {} : { model }),
    ...(userInput === undefined ? {} : { userInput: redactJsonValue(userInput, maxStringBytes) as string }),
    ...(systemPrompt === undefined ? {} : { systemPrompt: redactJsonValue(systemPrompt, maxStringBytes) as string }),
    ...(value.runtimeWarnings === undefined ? {} : { runtimeWarnings: redactJsonValue(value.runtimeWarnings, maxStringBytes) }),
    ...(value.diagnostics === undefined ? {} : { diagnostics: redactJsonValue(value.diagnostics, maxStringBytes) }),
    ...(value.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: redactJsonValue(value.capabilitiesUsed, maxStringBytes) }),
    ...(effort === undefined ? {} : { effort }),
    ...(source === undefined ? {} : { source }),
    ...(sourceDetail === undefined ? {} : { sourceDetail }),
  };
  return summary;
}

function summaryToListItem(
  summary: RunSummary,
  updatedAt: string,
  maxStringBytes: number,
  artifact?: Pick<ParsedSummaryFile, "fileName" | "mtimeMs">,
): RecordedRunListItem {
  return {
    runId: summary.runId,
    conversationId: summary.conversationId,
    status: summary.status,
    ...(summary.failureKind === undefined ? {} : { failureKind: summary.failureKind }),
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(summary.failoverHistory === undefined ? {} : { failoverHistory: summary.failoverHistory }),
    ...(summary.startedAt === undefined ? {} : { startedAt: summary.startedAt }),
    ...(summary.endedAt === undefined ? {} : { endedAt: summary.endedAt }),
    durationMs: summary.durationMs,
    eventCount: summary.eventCount,
    updatedAt: summary.updatedAt ?? updatedAt,
    ...(summary.usage === undefined ? {} : { usage: redactJsonValue(summary.usage, maxStringBytes) }),
    ...(summary.cost === undefined ? {} : { cost: redactJsonValue(summary.cost, maxStringBytes) }),
    ...(summary.model === undefined ? {} : { model: summary.model }),
    ...(summary.providerSessionId === undefined ? {} : { providerSessionId: summary.providerSessionId }),
    ...(summary.isolated === undefined ? {} : { isolated: summary.isolated }),
    ...(summary.runtimeWarnings === undefined ? {} : { runtimeWarnings: redactJsonValue(summary.runtimeWarnings, maxStringBytes) }),
    ...(summary.diagnostics === undefined ? {} : { diagnostics: redactJsonValue(summary.diagnostics, maxStringBytes) }),
    ...(summary.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: redactJsonValue(summary.capabilitiesUsed, maxStringBytes) }),
    ...(summary.effort === undefined ? {} : { effort: summary.effort }),
    ...(summary.source === undefined ? {} : { source: summary.source }),
    ...(summary.sourceDetail === undefined ? {} : { sourceDetail: summary.sourceDetail }),
    ...(summary.userInput === undefined ? {} : { userInput: summary.userInput }),
    ...(summary.systemPrompt === undefined ? {} : { systemPrompt: summary.systemPrompt }),
    ...(artifact === undefined ? {} : { summaryFileName: artifact.fileName, summaryMtimeMs: artifact.mtimeMs }),
  };
}

function toRecordedEvent(raw: unknown, index: number, maxStringBytes: number): RecordedRunEvent {
  const payload = redactJsonValue(raw, maxStringBytes);
  const record = isRecord(payload) ? payload : {};
  const type = stringField(record, "type");
  const timestamp =
    normalizeEventTimestamp(record.timestamp) ?? normalizeEventTimestamp(record.createdAt) ?? normalizeEventTimestamp(record.time);
  // Use the shared single-source-of-truth descriptors so the reader and the
  // export path always agree on category/label/summary. buildEventDescriptors
  // redacts the raw event itself (mirroring the prior inline path: redact ->
  // classify -> eventLabel/eventSummary), so we pass the RAW event in.
  const { category, label, summary } = buildEventDescriptors(raw as RuntimeEventLike, maxStringBytes);
  return {
    index,
    ...(type === undefined ? {} : { type }),
    category,
    ...(timestamp === undefined ? {} : { timestamp }),
    label,
    summary,
    payload,
  };
}

function normalizeReaderOptions(options: JsonlRunReaderOptions): NormalizedReaderOptions {
  if (typeof options.artifactDir !== "string" || options.artifactDir.trim().length === 0) {
    throw new ObservabilityReadError("invalid_reader_options", "artifactDir must be a non-empty path.");
  }
  const raiseOptions = (message: string, field: string): never => {
    throw new ObservabilityReadError("invalid_reader_options", message, { field });
  };
  return {
    artifactDir: resolve(options.artifactDir),
    scope: normalizeRunArtifactScope(options.scope, raiseOptions),
    scopeProvided: options.scope !== undefined,
    maxRuns: positiveInteger(options.maxRuns, DEFAULT_MAX_RUNS, "maxRuns", raiseOptions),
    maxEventsPerRun: positiveInteger(options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN, "maxEventsPerRun", raiseOptions),
    eventSelection: options.eventSelection === undefined || options.eventSelection === "head"
      ? "head"
      : options.eventSelection === "head-tail"
        ? "head-tail"
        : raiseOptions("eventSelection must be 'head' or 'head-tail'.", "eventSelection"),
    maxStringBytes: minInteger(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 64, "maxStringBytes", raiseOptions),
  };
}

function readLocationsForRun(normalized: NormalizedReaderOptions, summaryFileName: string): readonly SummaryFileLocation[] {
  const locations: SummaryFileLocation[] = [];
  if (normalized.scope === "memory" || normalized.scope === "all") {
    locations.push({
      artifactDir: artifactDirForKind(normalized.artifactDir, "memory"),
      fileName: summaryFileName,
      relativeFileName: relativeSummaryFileName(summaryFileName, "memory"),
      namespaceKind: "memory",
    });
  }
  if (normalized.scope === "agent" || normalized.scope === "memory" || normalized.scope === "all") {
    locations.push({
      artifactDir: normalized.artifactDir,
      fileName: summaryFileName,
      relativeFileName: summaryFileName,
      namespaceKind: "agent",
    });
  }
  return locations;
}

function summaryAllowedForRead(
  namespaceKind: "agent" | "memory",
  summary: RunSummary,
  normalized: NormalizedReaderOptions,
): boolean {
  if (!normalized.scopeProvided && namespaceKind === "agent") {
    return true;
  }
  return summaryMatchesArtifactScope(namespaceKind, summary, normalized.scope);
}

function normalizeRunId(runId: string): string {
  return normalizeRunIdGuard(runId, (message) => {
    throw new ObservabilityReadError("invalid_run_id", message);
  });
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new ObservabilityReadError("invalid_run_id", "Resolved artifact path escapes artifactDir.");
  });
}

function summaryUpdatedAtMs(entry: ParsedSummaryFile): number {
  const parsed = entry.summary.updatedAt === undefined ? Number.NaN : Date.parse(entry.summary.updatedAt);
  return Number.isFinite(parsed) ? parsed : entry.mtimeMs;
}

function providerSessionIdField(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function finiteNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

const EPOCH_DIGITS_PATTERN = /^\d{10,13}$/u;

/**
 * Normalize a raw event timestamp field into an ISO string. Real runtime events
 * (e.g. `provider_request_started`) carry raw epoch values as either a
 * 10-13 digit string or a bare number — pre-normalization these rendered as an
 * empty clock in consumers that expect ISO. 10-digit values are epoch seconds
 * (`* 1000`); 11-13 digit values are epoch milliseconds. Already-ISO strings and
 * any other shape pass through unchanged (or drop, matching prior behavior).
 */
function normalizeEventTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    return EPOCH_DIGITS_PATTERN.test(trimmed) ? epochDigitsToIso(trimmed) : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const digits = Math.trunc(Math.abs(value)).toString();
    return EPOCH_DIGITS_PATTERN.test(digits) ? epochDigitsToIso(digits) : undefined;
  }
  return undefined;
}

function epochDigitsToIso(digits: string): string {
  const ms = digits.length <= 10 ? Number(digits) * 1000 : Number(digits);
  return new Date(ms).toISOString();
}
