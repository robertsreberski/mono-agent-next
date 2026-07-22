import { readdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_STRING_BYTES,
  errorMessage,
  isErrno,
  isRecord,
  mkdir,
  minInteger,
  normalizeRunId as normalizeRunIdGuard,
  positiveInteger,
  safeJoin as safeJoinGuard,
  stringField,
  writeJsonAtomic,
} from "./artifact-fs.js";
import { normalizeRunArtifactScope } from "./artifact-scope.js";
import { listRecordedRuns, readRecordedRun } from "./recorded-runs.js";
import { redactJsonValue } from "./recorder.js";
import type {
  JsonlRunReaderOptions,
  PruneTraceSourcesOptions,
  PruneTraceSourcesResult,
  RegisterTraceSourceOptions,
  TraceRunDetail,
  TraceRunListItem,
  TraceRunListOptions,
  TraceRunListResult,
  TraceSourceHandle,
  TraceSourceListItem,
  TraceSourceListResult,
  TraceSourceManifest,
  TraceSourceMemoryBackend,
  TraceSourceMemoryCounts,
  TraceSourceMemoryHealth,
  TraceSourceMemoryIssue,
  TraceSourceMemoryMode,
  TraceSourceMemoryStatus,
  TraceSourceRegistryOptions,
  TraceSourceStatus,
  UpdateTraceSourceOptions,
} from "./types.js";

const DEFAULT_STALE_AFTER_MS = 30_000;
const MANIFEST_SUFFIX = ".json";
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const DEFAULT_MAX_RUNS = 100;
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

const MEMORY_BACKENDS = ["bujo", "supermemory", "none"] as const satisfies readonly TraceSourceMemoryBackend[];
const MEMORY_MODES = ["lite", "journal", "bujo"] as const satisfies readonly TraceSourceMemoryMode[];
const MEMORY_ISSUES = [
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "mutation_in_progress",
  "intake_invalid",
  "intake_pending",
  "dead_letters",
  "outbox_invalid",
  "outbox_pending",
  "work_stalled",
  "temporary_artifacts",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
] as const satisfies readonly TraceSourceMemoryIssue[];
const MEMORY_ISSUE_INDEX = new Map<string, number>(
  MEMORY_ISSUES.map((issue, index) => [issue, index]),
);
const MEMORY_COUNT_KEYS = [
  "pending",
  "due",
  "dead",
  "outbox",
  "temporary",
  "memories",
  "vectors",
  "missingVectors",
] as const satisfies readonly (keyof TraceSourceMemoryCounts)[];

const MEMORY_UNKNOWN_ISSUES = new Set<TraceSourceMemoryIssue>([
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
]);
const MEMORY_UNHEALTHY_ISSUES = new Set<TraceSourceMemoryIssue>([
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "intake_invalid",
  "outbox_invalid",
  "temporary_artifacts",
]);
const MEMORY_DEGRADED_ISSUES = new Set<TraceSourceMemoryIssue>([
  "dead_letters",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
  "work_stalled",
]);

/** Default retention window for {@link pruneTraceSources}: 7 days. */
export const DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

export type TraceSourceRegistryErrorCode =
  | "invalid_registry_options"
  | "invalid_source_id"
  | "invalid_run_id"
  | "manifest_write_failed";
export type TraceSourceRegistryErrorDetails = Record<string, unknown> & { readonly code: TraceSourceRegistryErrorCode };

export class TraceSourceRegistryError extends Error {
  readonly code: TraceSourceRegistryErrorCode;
  readonly details: TraceSourceRegistryErrorDetails;

  constructor(code: TraceSourceRegistryErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TraceSourceRegistryError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export async function registerTraceSource(options: RegisterTraceSourceOptions): Promise<TraceSourceHandle> {
  const normalized = normalizeRegistryOptions(options);
  const sourceId = normalizeSourceId(options.sourceId ?? sourceIdFromLabel(options.label));
  const label = normalizeNonEmpty(options.label, "label");
  const artifactDir = resolvePath(options.artifactDir, "artifactDir");
  const startedAt = options.startedAt ?? isoNow(normalized.clock);
  const heartbeatMs = options.heartbeatMs;
  if (heartbeatMs !== undefined && (!Number.isInteger(heartbeatMs) || heartbeatMs < 250)) {
    throw new TraceSourceRegistryError("invalid_registry_options", "heartbeatMs must be an integer of at least 250.", {
      field: "heartbeatMs",
    });
  }
  let manifest = buildManifest({
    sourceId,
    label,
    artifactDir,
    status: options.status ?? "running",
    startedAt,
    updatedAt: isoNow(normalized.clock),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.transports === undefined ? {} : { transports: options.transports }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.memoryHealth === undefined ? {} : { memoryHealth: options.memoryHealth }),
  });

  await writeManifest(normalized.registryDir, manifest);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let timerWritePending = false;
  let terminal = false;
  let terminalWrite: Promise<TraceSourceManifest> | undefined;
  // Every admitted write captures one immutable manifest and joins this one
  // serialized tail. Rejections remain visible to their caller but are absorbed
  // by the tail so a later stop can still publish the terminal state.
  let writeTail: Promise<void> = Promise.resolve();
  const enqueueManifest = (snapshot: TraceSourceManifest): Promise<TraceSourceManifest> => {
    const operation = writeTail.then(async () => {
      await writeManifest(normalized.registryDir, snapshot);
      return snapshot;
    });
    writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const terminalResult = (): Promise<TraceSourceManifest> =>
    terminalWrite === undefined
      ? Promise.resolve(manifest)
      : terminalWrite.then(() => manifest, () => manifest);
  const nextManifest = (patch: UpdateTraceSourceOptions): TraceSourceManifest => {
    const { memoryHealth: memoryHealthInput, ...otherPatch } = patch;
    const nextMemoryHealth = freshestMemoryHealth(
      manifest.memoryHealth,
      normalizeMemoryHealth(memoryHealthInput),
      "candidate",
    );
    return buildManifest({
      ...manifest,
      ...otherPatch,
      updatedAt: isoNow(normalized.clock),
      ...(nextMemoryHealth === undefined ? {} : { memoryHealth: nextMemoryHealth }),
    });
  };
  const writePatch = (patch: UpdateTraceSourceOptions): Promise<TraceSourceManifest> => {
    if (terminal) return terminalResult();
    manifest = nextManifest(patch);
    return enqueueManifest(manifest);
  };

  if (heartbeatMs !== undefined) {
    heartbeatTimer = setInterval(() => {
      // At most one timer-owned write may wait behind explicit updates. A slow
      // filesystem therefore cannot turn interval ticks into an unbounded tail.
      if (terminal || timerWritePending) return;
      timerWritePending = true;
      void writePatch({}).catch(() => undefined).finally(() => {
        timerWritePending = false;
      });
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  return {
    get manifest() {
      return manifest;
    },
    update: writePatch,
    async heartbeat() {
      return await writePatch({});
    },
    stop(patch = {}) {
      if (terminal) return terminalWrite ?? Promise.resolve(manifest);
      // Terminal admission is synchronous: no update/heartbeat can enter after
      // this point. Its write is queued after every operation that already did.
      terminal = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      manifest = nextManifest({ ...patch, status: patch.status ?? "stopped" });
      terminalWrite = enqueueManifest(manifest);
      return terminalWrite;
    },
  };
}

export async function listTraceSources(options: TraceSourceRegistryOptions): Promise<TraceSourceListResult> {
  const normalized = normalizeRegistryOptions(options);
  const { manifests, warnings } = await readManifestFiles(normalized);
  return {
    registryDir: normalized.registryDir,
    sources: manifests.map((manifest) => toListItem(manifest, normalized)).sort(compareSources),
    warnings,
  };
}

/**
 * Merge {@link listTraceSources} results from several registries (e.g. an
 * agent's own config-local registry plus the machine-wide global one) by
 * `sourceId`: a source unique to any list is kept as-is, and a source present
 * in more than one keeps whichever copy has the fresher `updatedAt` heartbeat
 * (earlier lists win ties). Memory health is selected independently by its
 * `checkedAt` instant, with the manifest winner's health winning a timestamp
 * tie. All other fields come from the manifest winner. Object identity is
 * preserved when no memory health needs normalization or overlay; otherwise
 * the winner is shallow-cloned. The union is sorted like `listTraceSources`
 * output (fresher first).
 */
export function mergeTraceSources(
  ...lists: ReadonlyArray<readonly TraceSourceListItem[]>
): TraceSourceListItem[] {
  const bySourceId = new Map<string, TraceSourceListItem>();
  // Later-processed entries win ties (>=), so process lists back-to-front to
  // give EARLIER lists tie precedence.
  for (let index = lists.length - 1; index >= 0; index -= 1) {
    for (const source of lists[index] ?? []) {
      const existing = bySourceId.get(source.sourceId);
      if (existing === undefined || Date.parse(source.updatedAt) >= Date.parse(existing.updatedAt)) {
        bySourceId.set(source.sourceId, source);
      }
    }
  }

  const freshestHealthBySourceId = new Map<string, TraceSourceMemoryHealth>();
  for (const list of lists) {
    for (const source of list) {
      const candidate = normalizeMemoryHealth(source.memoryHealth);
      if (candidate === undefined) {
        continue;
      }
      const existing = freshestHealthBySourceId.get(source.sourceId);
      if (existing === undefined || Date.parse(candidate.checkedAt) > Date.parse(existing.checkedAt)) {
        freshestHealthBySourceId.set(source.sourceId, candidate);
      }
    }
  }

  return [...bySourceId.values()]
    .map((source) => mergeSourceMemoryHealth(source, freshestHealthBySourceId.get(source.sourceId)))
    .sort(compareSources);
}

/**
 * Delete stale, dead manifests from a registry directory: registrations pile
 * up over time from ephemeral/test runs and crashed processes, and nothing
 * else ever removes them. A manifest is removed only when BOTH hold: its
 * heartbeat (`updatedAt`) is older than `olderThanMs` (default
 * {@link DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS}), AND its `pid` is not
 * alive (a manifest with no recorded pid cannot be verified alive, so it is
 * treated as prunable once it is old enough). A live pid is never removed
 * regardless of age, and a fresh-but-dead manifest (a just-crashed process)
 * is kept so `status`/the picker still surface it as stopped/failed.
 *
 * Never throws: an unreadable registry directory, a per-file read/parse
 * failure, or a delete race (another writer already removed the file) are all
 * swallowed so this can always be called fire-and-forget.
 */
export async function pruneTraceSources(options: PruneTraceSourcesOptions): Promise<PruneTraceSourcesResult> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_PRUNE_TRACE_SOURCES_OLDER_THAN_MS;
  const isAlive = options.isAlive ?? defaultPidIsAlive;
  const now = options.clock?.() ?? Date.now();

  let registryDir: string;
  let entries;
  try {
    registryDir = resolve(options.registryDir);
    entries = await readdir(registryDir, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(MANIFEST_SUFFIX)) {
      continue;
    }
    try {
      const path = safeJoin(registryDir, entry.name);
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
      if (pid !== undefined && isAlive(pid)) {
        continue;
      }
      const updatedAtMs = typeof parsed.updatedAt === "string" ? Date.parse(parsed.updatedAt) : NaN;
      if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < olderThanMs) {
        continue;
      }
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // Malformed manifest or a concurrent-writer race: leave it for the next pass.
      continue;
    }
  }
  return { removed };
}

function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return isErrno(error, "EPERM");
  }
}

export async function listTraceRuns(options: TraceRunListOptions): Promise<TraceRunListResult> {
  const normalized = normalizeRunListOptions(options);
  const sourceResult = await listTraceSources(normalized);
  const warnings = [...sourceResult.warnings];
  const runs: TraceRunListItem[] = [];

  for (const source of sourceResult.sources) {
    if (!(await artifactDirExists(source.artifactDir))) {
      warnings.push(`Source ${source.sourceId} artifact directory is missing: ${source.artifactDir}.`);
      continue;
    }
    const result = await listRecordedRuns(readerOptionsForSource(source.artifactDir, normalized));
    warnings.push(...result.warnings.map((warning) => `Source ${source.sourceId}: ${warning}`));
    for (const run of result.runs) {
      runs.push({ ...run, traceSource: source });
    }
  }

  return {
    registryDir: normalized.registryDir,
    sources: sourceResult.sources,
    runs: runs
      .sort(compareTraceRuns)
      .slice(0, normalized.maxRuns),
    warnings,
  };
}

export async function readTraceRun(
  options: TraceRunListOptions,
  sourceId: string,
  runId: string,
): Promise<TraceRunDetail | undefined> {
  const normalized = normalizeRunListOptions(options);
  const normalizedSourceId = normalizeSourceId(sourceId);
  normalizeRunId(runId);
  const sourceResult = await listTraceSources(normalized);
  const source = sourceResult.sources.find((entry) => entry.sourceId === normalizedSourceId);
  if (source === undefined) {
    return undefined;
  }
  const run = await readRecordedRun(readerOptionsForSource(source.artifactDir, normalized), runId);
  return run === undefined ? undefined : { traceSource: source, run };
}

function buildManifest(input: {
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
}): TraceSourceManifest {
  const memoryHealth = normalizeMemoryHealth(input.memoryHealth);
  return {
    schema: "agent-runtime.trace-source.v1",
    sourceId: normalizeSourceId(input.sourceId),
    label: normalizeNonEmpty(input.label, "label"),
    artifactDir: resolvePath(input.artifactDir, "artifactDir"),
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    ...(input.transports === undefined ? {} : { transports: input.transports.map((transport) => transport.trim()).filter(Boolean) }),
    ...(input.configPath === undefined ? {} : { configPath: resolve(input.configPath) }),
    ...(input.metadata === undefined ? {} : { metadata: redactJsonValue(input.metadata) as Record<string, unknown> }),
    ...(memoryHealth === undefined ? {} : { memoryHealth }),
  };
}

async function readManifestFiles(normalized: NormalizedRegistryOptions): Promise<{
  readonly manifests: readonly TraceSourceManifest[];
  readonly warnings: readonly string[];
}> {
  let entries;
  try {
    entries = await readdir(normalized.registryDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { manifests: [], warnings: [] };
    }
    return { manifests: [], warnings: [`Unable to read trace registry: ${errorMessage(error)}.`] };
  }

  const manifests: TraceSourceManifest[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(MANIFEST_SUFFIX)) {
      continue;
    }
    const path = safeJoin(normalized.registryDir, entry.name);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const manifest = coerceManifest(parsed, entry.name, warnings);
      if (manifest !== undefined) {
        manifests.push(manifest);
      }
    } catch {
      // JSON.parse diagnostics can include excerpts of the hostile input on
      // current Node releases. Registry warnings are a content-free surface.
      warnings.push(`Skipping ${entry.name}: invalid JSON.`);
    }
  }
  return { manifests, warnings };
}

function coerceManifest(value: unknown, fileName: string, warnings: string[]): TraceSourceManifest | undefined {
  if (!isRecord(value)) {
    warnings.push(`Skipping ${fileName}: manifest is not an object.`);
    return undefined;
  }
  if (value.schema !== "agent-runtime.trace-source.v1") {
    warnings.push(`Skipping ${fileName}: manifest schema is not agent-runtime.trace-source.v1.`);
    return undefined;
  }
  const sourceId = stringField(value, "sourceId");
  const label = stringField(value, "label");
  const artifactDir = stringField(value, "artifactDir");
  const status = sourceStatus(value.status);
  const startedAt = stringField(value, "startedAt");
  const updatedAt = stringField(value, "updatedAt");
  if (
    sourceId === undefined ||
    label === undefined ||
    artifactDir === undefined ||
    status === undefined ||
    startedAt === undefined ||
    updatedAt === undefined
  ) {
    warnings.push(`Skipping ${fileName}: manifest is missing required source metadata.`);
    return undefined;
  }
  try {
    const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : undefined;
    const transports = Array.isArray(value.transports) ? value.transports.filter((item): item is string => typeof item === "string") : undefined;
    const configPath = stringField(value, "configPath");
    const metadata = isRecord(value.metadata) ? value.metadata : undefined;
    const memoryHealth = normalizeMemoryHealth(value.memoryHealth);
    return buildManifest({
      sourceId,
      label,
      artifactDir,
      status,
      startedAt,
      updatedAt,
      ...(pid === undefined ? {} : { pid }),
      ...(transports === undefined ? {} : { transports }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(memoryHealth === undefined ? {} : { memoryHealth }),
    });
  } catch (error) {
    warnings.push(`Skipping ${fileName}: ${errorMessage(error)}.`);
    return undefined;
  }
}

function toListItem(manifest: TraceSourceManifest, normalized: NormalizedRegistryOptions): TraceSourceListItem {
  const warnings: string[] = [];
  const updatedAtMs = Date.parse(manifest.updatedAt);
  const stale = manifest.status === "running" &&
    Number.isFinite(updatedAtMs) &&
    normalized.clock() - updatedAtMs > normalized.staleAfterMs;
  if (stale) {
    warnings.push(`Source ${manifest.sourceId} heartbeat is stale.`);
  }
  const health = manifest.status === "failed"
    ? "failed"
    : manifest.status === "stopped"
      ? "stopped"
      : stale
        ? "stale"
        : "running";
  return { ...manifest, health, warnings };
}

async function writeManifest(registryDir: string, manifest: TraceSourceManifest): Promise<void> {
  try {
    await mkdir(registryDir, { recursive: true });
    const path = manifestPath(registryDir, manifest.sourceId);
    await writeJsonAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    throw new TraceSourceRegistryError("manifest_write_failed", "Unable to write trace source manifest.", {
      cause: errorMessage(error),
    });
  }
}

function manifestPath(registryDir: string, sourceId: string): string {
  return safeJoin(registryDir, `${normalizeSourceId(sourceId)}${MANIFEST_SUFFIX}`);
}

interface NormalizedRegistryOptions {
  readonly registryDir: string;
  readonly staleAfterMs: number;
  readonly clock: () => number;
}

interface NormalizedRunListOptions extends NormalizedRegistryOptions {
  readonly scope: "agent" | "memory" | "all";
  readonly scopeProvided: boolean;
  readonly maxRuns: number;
  readonly maxEventsPerRun: number;
  readonly maxStringBytes: number;
}

function raiseRegistryOption(message: string, field: string): never {
  throw new TraceSourceRegistryError("invalid_registry_options", message, { field });
}

function normalizeRunListOptions(options: TraceRunListOptions): NormalizedRunListOptions {
  return {
    ...normalizeRegistryOptions(options),
    scope: normalizeRunArtifactScope(options.scope, raiseRegistryOption),
    scopeProvided: options.scope !== undefined,
    maxRuns: positiveInteger(options.maxRuns, DEFAULT_MAX_RUNS, "maxRuns", raiseRegistryOption),
    maxEventsPerRun: positiveInteger(options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN, "maxEventsPerRun", raiseRegistryOption),
    maxStringBytes: minInteger(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 64, "maxStringBytes", raiseRegistryOption),
  };
}

function normalizeRegistryOptions(options: TraceSourceRegistryOptions): NormalizedRegistryOptions {
  if (typeof options.registryDir !== "string" || options.registryDir.trim().length === 0) {
    throw new TraceSourceRegistryError("invalid_registry_options", "registryDir must be a non-empty path.");
  }
  return {
    registryDir: resolve(options.registryDir),
    staleAfterMs: positiveInteger(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, "staleAfterMs", raiseRegistryOption),
    clock: options.clock ?? (() => Date.now()),
  };
}

function readerOptionsForSource(artifactDir: string, options: NormalizedRunListOptions): JsonlRunReaderOptions {
  return {
    artifactDir,
    ...(options.scopeProvided ? { scope: options.scope } : {}),
    maxRuns: options.maxRuns,
    maxEventsPerRun: options.maxEventsPerRun,
    maxStringBytes: options.maxStringBytes,
  };
}

function normalizeSourceId(sourceId: string): string {
  const normalized = normalizeNonEmpty(sourceId, "sourceId");
  if (!SOURCE_ID_PATTERN.test(normalized) || normalized.includes("..")) {
    throw new TraceSourceRegistryError("invalid_source_id", "sourceId must contain only letters, numbers, dot, underscore, or hyphen and cannot contain '..'.");
  }
  return normalized;
}

function normalizeRunId(runId: string): string {
  return normalizeRunIdGuard(
    runId,
    (message) => {
      throw new TraceSourceRegistryError("invalid_run_id", message);
    },
    () => {
      throw new TraceSourceRegistryError("invalid_registry_options", "runId must be a non-empty string.", { field: "runId" });
    },
  );
}

function sourceIdFromLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "source";
}

function sourceStatus(value: unknown): TraceSourceStatus | undefined {
  return value === "running" || value === "stopped" || value === "failed" ? value : undefined;
}

function normalizeMemoryHealth(value: unknown): TraceSourceMemoryHealth | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const checkedAt = normalizeIsoInstant(value.checkedAt);
  if (checkedAt === undefined) {
    return undefined;
  }

  const backend = enumValue(value.backend, MEMORY_BACKENDS);
  if (backend === "none") {
    const status = enumValue(value.status, ["not_configured", "unknown"] as const);
    if (status !== undefined && value.mode === undefined && value.issues === undefined && value.counts === undefined) {
      return { backend, status, checkedAt };
    }
    return { backend, status: "unknown", checkedAt };
  }
  if (backend === "supermemory") {
    if (value.status === "unknown" && value.mode === undefined
      && value.issues === undefined && value.counts === undefined) {
      return { backend, status: "unknown", checkedAt };
    }
    return { backend, status: "unknown", checkedAt };
  }
  if (backend !== "bujo") {
    // A well-formed timestamp must supersede stale green data even when the
    // producer's backend discriminator is unknown or missing.
    return { backend: "none", status: "unknown", checkedAt };
  }

  const mode = enumValue(value.mode, MEMORY_MODES);
  if (mode === undefined) {
    return { backend: "none", status: "unknown", checkedAt };
  }
  const status = enumValue(value.status, ["healthy", "in_progress", "degraded", "unhealthy", "unknown"] as const);
  const issues = normalizeMemoryIssues(value.issues);
  if (status === undefined || issues === undefined || status !== statusForMemoryIssues(issues)) {
    return unknownBujoMemoryHealth(mode, checkedAt);
  }
  const counts = normalizeMemoryCounts(value.counts);
  if (counts === null || (counts !== undefined && !memoryCountsMatchIssues(mode, counts, issues))) {
    return unknownBujoMemoryHealth(mode, checkedAt);
  }
  return {
    backend,
    mode,
    status,
    checkedAt,
    issues,
    ...(counts === undefined ? {} : { counts }),
  };
}

function mergeSourceMemoryHealth(
  source: TraceSourceListItem,
  freshest: TraceSourceMemoryHealth | undefined,
): TraceSourceListItem {
  const winnerHealth = normalizeMemoryHealth(source.memoryHealth);
  const memoryHealth = freshestMemoryHealth(freshest, winnerHealth, "candidate");
  if (source.memoryHealth === undefined && memoryHealth === undefined) {
    return source;
  }
  const { memoryHealth: _untrustedMemoryHealth, ...sourceWithoutMemoryHealth } = source;
  return {
    ...sourceWithoutMemoryHealth,
    ...(memoryHealth === undefined ? {} : { memoryHealth }),
  };
}

function freshestMemoryHealth(
  current: TraceSourceMemoryHealth | undefined,
  candidate: TraceSourceMemoryHealth | undefined,
  tieWinner: "current" | "candidate",
): TraceSourceMemoryHealth | undefined {
  if (candidate === undefined) {
    return current;
  }
  if (current === undefined) {
    return candidate;
  }
  const delta = Date.parse(candidate.checkedAt) - Date.parse(current.checkedAt);
  return delta > 0 || (delta === 0 && tieWinner === "candidate") ? candidate : current;
}

function normalizeMemoryIssues(value: unknown): readonly TraceSourceMemoryIssue[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const issues: TraceSourceMemoryIssue[] = [];
  let previousIndex = -1;
  for (const issue of value) {
    if (typeof issue !== "string") {
      return undefined;
    }
    const index = MEMORY_ISSUE_INDEX.get(issue);
    if (index === undefined || index <= previousIndex) {
      return undefined;
    }
    issues.push(issue as TraceSourceMemoryIssue);
    previousIndex = index;
  }
  return issues;
}

function statusForMemoryIssues(
  issues: readonly TraceSourceMemoryIssue[],
): Exclude<TraceSourceMemoryStatus, "not_configured"> {
  if (issues.some((issue) => MEMORY_UNKNOWN_ISSUES.has(issue))) return "unknown";
  if (issues.some((issue) => MEMORY_UNHEALTHY_ISSUES.has(issue))) return "unhealthy";
  if (issues.some((issue) => MEMORY_DEGRADED_ISSUES.has(issue))) return "degraded";
  return issues.length === 0 ? "healthy" : "in_progress";
}

function unknownBujoMemoryHealth(
  mode: TraceSourceMemoryMode,
  checkedAt: string,
): TraceSourceMemoryHealth {
  return {
    backend: "bujo",
    mode,
    status: "unknown",
    checkedAt,
    issues: ["health_check_failed"],
  };
}

function memoryCountsMatchIssues(
  mode: TraceSourceMemoryMode,
  counts: TraceSourceMemoryCounts,
  issues: readonly TraceSourceMemoryIssue[],
): boolean {
  const present = new Set(issues);
  const hasIntakePending = present.has("intake_pending");
  const hasMutation = present.has("mutation_in_progress");
  const hasVectorMismatch = present.has("vector_mismatch");

  if (counts.pending !== undefined && hasIntakePending !== (counts.pending > 0)) return false;
  if (counts.due !== undefined) {
    if (counts.due > 0 && !hasIntakePending) return false;
    if (counts.pending !== undefined && counts.due > counts.pending) return false;
  }
  if (counts.dead !== undefined && present.has("dead_letters") !== (counts.dead > 0)) return false;
  if (counts.outbox !== undefined) {
    if (present.has("outbox_pending") !== (counts.outbox > 0)) return false;
    if (counts.outbox > 0 && !hasMutation) return false;
  }
  if (counts.temporary !== undefined
    && present.has("temporary_artifacts") !== (counts.temporary > 0)) return false;

  if (mode === "lite") {
    if (counts.missingVectors !== undefined && counts.missingVectors !== 0) return false;
    if (counts.vectors !== undefined && counts.vectors !== 0 && !hasVectorMismatch) return false;
  }
  if (mode === "journal" && counts.missingVectors !== undefined
    && counts.missingVectors > 0 && !hasMutation) return false;
  if (mode === "journal" && counts.memories !== undefined && counts.vectors !== undefined
    && counts.memories > counts.vectors && !hasMutation) return false;
  if (mode === "bujo") {
    if (counts.memories !== undefined && counts.vectors !== undefined
      && counts.vectors !== counts.memories && !hasVectorMismatch) return false;
    if (counts.missingVectors !== undefined && counts.missingVectors > 0 && !hasVectorMismatch) return false;
  }
  if (counts.memories !== undefined && counts.vectors !== undefined
    && counts.vectors > counts.memories && !hasVectorMismatch) return false;
  if (counts.memories !== undefined && counts.vectors !== undefined && counts.missingVectors !== undefined) {
    const expectedMissingVectors = mode === "lite" ? 0 : Math.max(0, counts.memories - counts.vectors);
    if (counts.missingVectors !== expectedMissingVectors) return false;
  }
  return true;
}

function normalizeMemoryCounts(value: unknown): TraceSourceMemoryCounts | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const counts: Partial<Record<keyof TraceSourceMemoryCounts, number>> = {};
  for (const key of MEMORY_COUNT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      return null;
    }
    counts[key] = count;
  }
  return Object.keys(counts).length === 0 ? undefined : counts;
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as Values[number]
    : undefined;
}

function normalizeIsoInstant(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return undefined;
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const hour = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "", 10);
  const second = Number.parseInt(match[6] ?? "", 10);
  const offsetHour = match[9] === undefined ? 0 : Number.parseInt(match[9], 10);
  const offsetMinute = match[10] === undefined ? 0 : Number.parseInt(match[10], 10);
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function compareSources(a: TraceSourceListItem, b: TraceSourceListItem): number {
  const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return byUpdated === 0 ? a.sourceId.localeCompare(b.sourceId) : byUpdated;
}

function runUpdatedAtMs(run: TraceRunListItem): number {
  const parsed = Date.parse(run.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTraceRuns(a: TraceRunListItem, b: TraceRunListItem): number {
  const byUpdated = runUpdatedAtMs(b) - runUpdatedAtMs(a);
  if (byUpdated !== 0) {
    return byUpdated;
  }
  const bySource = b.traceSource.sourceId.localeCompare(a.traceSource.sourceId);
  if (bySource !== 0) {
    return bySource;
  }
  return b.runId.localeCompare(a.runId);
}

async function artifactDirExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    return false;
  }
}

function resolvePath(path: string, field: string): string {
  return resolve(normalizeNonEmpty(path, field));
}

function normalizeNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TraceSourceRegistryError("invalid_registry_options", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new TraceSourceRegistryError("invalid_source_id", "Resolved manifest path escapes registryDir.");
  });
}

function isoNow(clock: () => number): string {
  return new Date(clock()).toISOString();
}
