import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { resolveSupermemoryContainer } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { MemorySearchError } from "@mono-agent/memory/search";
import type { MemorySearchErrorCode } from "@mono-agent/memory/search";
import type { EntityRecord, IndexMetadata, MemoryDb, MemoryRecord, MemoryStoreAudit, MemoryStoreStats } from "@mono-agent/memory/store";
import { listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";
import type {
  BujoMemoryHealthReport,
  CompletedTurnIntakeInspection,
  LegacyReplayAdoptionResult,
} from "@mono-agent/memory/bujo";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  resolveAppTraceRegistryDir,
  resolveGlobalTraceRegistryDir,
} from "./app-config.js";
import { resolveMemoryRecallSettings } from "./memory-recall-settings.js";
import type {
  MemoryRecallBujoSettings,
  MemoryRecallSettings,
} from "./memory-recall-settings.js";
import * as ui from "./ui.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_ENTITY_LIMIT = 8;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const INTAKE_ID_RE = /^[a-f0-9]{64}$/u;
const INTAKE_REASON_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MEMORY_HEALTH_SCHEMA_VERSION = 1;
const REPLAY_ADOPTION_SCHEMA_VERSION = 1;
const MEMORY_FORGET_SCHEMA_VERSION = 1;
const MAX_FORGET_IDS = 32;
const MAX_FORGET_PLAN_BYTES = 1024 * 1024;
const MEMORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const FTS_FALLBACK_MEMORY_SEARCH_CODES = new Set<MemorySearchErrorCode>([
  "embedding_circuit_open",
  "embedding_request_failed",
  "embedding_response_invalid",
  "invalid_embedding_options",
]);
const FTS_FALLBACK_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const MAX_FTS_FALLBACK_CAUSE_CANDIDATES = 16;
const INTRINSIC_ERROR = Error;
const INTRINSIC_TYPE_ERROR = TypeError;
const INTRINSIC_AGGREGATE_ERROR = AggregateError;
const INTRINSIC_DOM_EXCEPTION = typeof DOMException === "undefined" ? undefined : DOMException;
const DOM_EXCEPTION_NAME_GETTER = INTRINSIC_DOM_EXCEPTION === undefined
  ? undefined
  : Object.getOwnPropertyDescriptor(INTRINSIC_DOM_EXCEPTION.prototype, "name")?.get;
const EMPTY_HEALTH_COUNTS = Object.freeze({
  pending: 0,
  due: 0,
  dead: 0,
  outbox: 0,
  temporary: 0,
  memories: 0,
  vectors: 0,
  missingVectors: 0,
});

export interface RunMemoryCommandInput {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPath?: string;
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly strict: boolean;
  readonly limit?: number;
  readonly idsFile?: string;
  readonly reason?: string;
  readonly planPath?: string;
  readonly backupPath?: string;
}

interface MemoryForgetPlanPayload {
  readonly schemaVersion: typeof MEMORY_FORGET_SCHEMA_VERSION;
  readonly operation: "forget";
  readonly rootFingerprint: string;
  readonly sourceFingerprint: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly memoryIds: readonly string[];
}

interface MemoryForgetPlan extends MemoryForgetPlanPayload {
  readonly planDigest: string;
}

interface MemoryCommandContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPath: string;
  readonly config: MonoAgentConfig;
}

interface PreviewRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly source?: { readonly file?: string; readonly line?: number; readonly session?: string };
    readonly salience?: number;
    readonly createdAt?: string;
  };
}

export async function runMemoryCommand(input: RunMemoryCommandInput): Promise<number> {
  const usageError = memoryCommandUsageError(input);
  if (usageError !== undefined) {
    if (input.positionals[0] === "adopt-replay") {
      writeReplayAdoptionCliFailure(input.json, "replay_adoption_usage");
      return 2;
    }
    if (input.positionals[0] === "forget") {
      writeMemoryForgetFailure(input.json, input.positionals[1] ?? "unknown", "forget_usage");
      return 2;
    }
    process.stderr.write(ui.errorLine(usageError));
    return 2;
  }
  const context = await loadMemoryCommandContext(input);
  if ("code" in context) {
    return context.code;
  }

  const [rawSubcommand, ...rest] = input.positionals;
  const subcommand = rawSubcommand ?? "stats";
  if (context.config.memory === undefined) {
    if (subcommand === "audit" && input.strict) {
      const result = notConfiguredHealthReport();
      write(input.json, result, () => renderStrictAudit(result));
      return strictHealthExitCode(result.status);
    }
    if (subcommand === "adopt-replay") {
      writeReplayAdoptionCliFailure(input.json, "replay_adoption_requires_bujo");
      return 1;
    }
    if (subcommand === "forget") {
      writeMemoryForgetFailure(input.json, rest[0] ?? "unknown", "forget_requires_bujo");
      return 1;
    }
    writeNoMemory(context.configPath, input.json);
    return 0;
  }

  switch (subcommand) {
    case "stats":
      return await runStats(context, input);
    case "today":
      return await runShow(context, todayKey(), input.json);
    case "show": {
      const date = rest[0];
      if (date === undefined || !DATE_RE.test(date)) {
        process.stderr.write(ui.errorLine("Usage: mono-agent memory show <YYYY-MM-DD>."));
        return 2;
      }
      return await runShow(context, date, input.json);
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (query.length === 0) {
        process.stderr.write(ui.errorLine("Usage: mono-agent memory search <query>."));
        return 2;
      }
      return await runSearch(context, query, input);
    }
    case "top":
      return await runTop(context, input);
    case "audit":
      return input.strict
        ? await runStrictAudit(context, input.json)
        : await runAudit(context, input.json);
    case "inspect":
      return await runIntakeInspect(context, rest[0], input.json);
    case "retry":
      return await runIntakeMutation(context, "retry", rest[0], undefined, input.json);
    case "resolve":
      return await runIntakeMutation(context, "resolve", rest[0], rest[1], input.json);
    case "rebuild":
      return await runIndexTransition(context, "rebuild", input.json);
    case "rollback":
      return await runIndexTransition(context, "rollback", input.json);
    case "adopt-replay":
      return await runReplayAdoption(context, input.json);
    case "forget":
      return await runMemoryForget(context, rest, input);
    default:
      process.stderr.write(ui.errorLine(`Unknown memory subcommand \`${subcommand}\`.`));
      process.stderr.write(ui.hint("Expected stats, today, show <date>, search <query>, top, audit, inspect [id], retry [id], resolve <id> <reason>, rebuild, rollback, adopt-replay, or forget prepare|apply|restore."));
      return 2;
  }
}

function memoryCommandUsageError(input: RunMemoryCommandInput): string | undefined {
  const [rawSubcommand, ...rest] = input.positionals;
  const subcommand = rawSubcommand ?? "stats";
  if (input.strict && subcommand !== "audit") {
    return "--strict is only supported for `mono-agent memory audit`.";
  }
  if (input.limit !== undefined && subcommand !== "stats" && subcommand !== "search" && subcommand !== "top") {
    return "--limit is only supported for memory stats, search, and top.";
  }
  switch (subcommand) {
    case "stats":
    case "today":
    case "top":
    case "audit":
    case "rebuild":
    case "rollback":
    case "adopt-replay":
      return rest.length === 0 ? undefined : `Usage: mono-agent memory ${subcommand}.`;
    case "show":
      return rest.length === 1 && DATE_RE.test(rest[0] ?? "")
        ? undefined
        : "Usage: mono-agent memory show <YYYY-MM-DD>.";
    case "search":
      return rest.join(" ").trim().length > 0
        ? undefined
        : "Usage: mono-agent memory search <query>.";
    case "inspect":
      return rest.length <= 1 && (rest[0] === undefined || INTAKE_ID_RE.test(rest[0]))
        ? undefined
        : "Usage: mono-agent memory inspect [<64-character-id>].";
    case "retry":
      return rest.length <= 1 && (rest[0] === undefined || INTAKE_ID_RE.test(rest[0]))
        ? undefined
        : "Usage: mono-agent memory retry [<64-character-id>].";
    case "resolve":
      if (rest.length !== 2 || !INTAKE_ID_RE.test(rest[0] ?? "")) {
        return "Usage: mono-agent memory resolve <64-character-id> <reason-slug>.";
      }
      return INTAKE_REASON_RE.test(rest[1] ?? "")
        ? undefined
        : "memory resolve reason must be a 1-64 character lowercase slug.";
    case "forget": {
      const operation = rest[0];
      if (rest.length !== 1 || (operation !== "prepare" && operation !== "apply" && operation !== "restore")) {
        return "Usage: mono-agent memory forget prepare|apply|restore with the required operation flags.";
      }
      if (operation === "prepare") {
        return input.idsFile !== undefined && input.reason !== undefined && input.planPath !== undefined
          && input.backupPath === undefined && INTAKE_REASON_RE.test(input.reason)
          ? undefined
          : "Usage: mono-agent memory forget prepare --ids-file <file> --reason <lowercase-slug> --plan <file>.";
      }
      if (operation === "apply") {
        return input.planPath !== undefined && input.idsFile === undefined && input.reason === undefined
          && input.backupPath === undefined
          ? undefined
          : "Usage: mono-agent memory forget apply --plan <file>.";
      }
      return input.backupPath !== undefined && input.idsFile === undefined && input.reason === undefined
        && input.planPath === undefined
        ? undefined
        : "Usage: mono-agent memory forget restore --backup <dir>.";
    }
    default:
      return undefined;
  }
}

async function runReplayAdoption(
  context: MemoryCommandContext,
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined || (memory.backend ?? "bujo") === "supermemory"
    || memory.mode !== "bujo" || memory.embeddings === undefined) {
    writeReplayAdoptionCliFailure(json, "replay_adoption_requires_bujo");
    return 1;
  }

  try {
    const registryDirs = await memoryRegistryDirs(context);
    if (await hasLiveConfiguredAgent(context.configPath, registryDirs)) {
      writeReplayAdoptionCliFailure(json, "replay_adoption_agent_running");
      return 1;
    }
    const { adoptLegacyReplayProjection } = await loadBujoModule();
    // Re-check after the lazy module load so a configured process cannot race
    // the SSH-only stopped-store precondition during setup. The package also
    // takes the memory-root writer lease and SQLite writer fence.
    if (await hasLiveConfiguredAgent(context.configPath, registryDirs)) {
      writeReplayAdoptionCliFailure(json, "replay_adoption_agent_running");
      return 1;
    }
    const adopted = await adoptLegacyReplayProjection({
      root: memory.path,
      mode: "bujo",
      embeddingModel: `${memory.embeddings.provider}:${memory.embeddings.model}`,
      dimension: memory.embeddings.dim ?? 768,
    });
    const result = publicReplayAdoptionResult(adopted);
    write(json, result, () => renderReplayAdoption(result));
    return 0;
  } catch {
    // Adoption is a privacy boundary. Do not classify or interpolate the
    // package/native error: it may contain paths, record ids, marker bytes, or
    // model-owned text. Operators get a stable remediation contract instead.
    writeReplayAdoptionCliFailure(json, "replay_adoption_failed");
    return 1;
  }
}

type ReplayAdoptionFailureCode =
  | "replay_adoption_usage"
  | "replay_adoption_config_invalid"
  | "replay_adoption_requires_bujo"
  | "replay_adoption_agent_running"
  | "replay_adoption_failed";

const REPLAY_ADOPTION_FAILURE_MESSAGES: Readonly<Record<ReplayAdoptionFailureCode, string>> = Object.freeze({
  replay_adoption_usage: "Usage: mono-agent memory adopt-replay [--json] [--config <path>] [--env-file <path>].",
  replay_adoption_config_invalid: "Replay adoption requires a valid mono-agent configuration.",
  replay_adoption_requires_bujo: "Replay adoption requires a configured built-in BuJo memory store with embeddings.",
  replay_adoption_agent_running: "Replay adoption requires the configured agent to be stopped. Stop it and retry.",
  replay_adoption_failed: "Replay adoption failed. Keep the agent stopped, inspect strict memory health, resolve the reported condition, and retry.",
});

export function writeReplayAdoptionCliFailure(json: boolean, code: ReplayAdoptionFailureCode): void {
  const result = {
    schemaVersion: REPLAY_ADOPTION_SCHEMA_VERSION,
    operation: "adopt-replay" as const,
    status: "failed" as const,
    code,
    message: REPLAY_ADOPTION_FAILURE_MESSAGES[code],
  };
  if (json) {
    write(true, result, () => "");
    return;
  }
  process.stderr.write(ui.errorLine(`[${result.code}] ${result.message}`));
}

function publicReplayAdoptionResult(result: LegacyReplayAdoptionResult): LegacyReplayAdoptionResult {
  const counts = result.counts;
  if (result.backend !== "bujo" || result.mode !== "bujo" || result.status !== "adopted"
    || result.rebuildRequired !== true || !/^[a-f0-9]{64}$/u.test(result.authorityDigest)
    || !isSafeAggregateCount(counts.terminals)
    || !isSafeAggregateCount(counts.supersedes)
    || !isSafeAggregateCount(counts.threads)) {
    throw new Error("invalid private adoption result");
  }
  return {
    backend: "bujo",
    mode: "bujo",
    status: "adopted",
    counts: {
      terminals: counts.terminals,
      supersedes: counts.supersedes,
      threads: counts.threads,
    },
    authorityDigest: result.authorityDigest,
    rebuildRequired: true,
  };
}

function isSafeAggregateCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

class MemoryForgetOperationError extends Error {
  constructor(
    readonly code: MemoryForgetFailureCode,
    readonly recovered = false,
    readonly backupPath?: string,
  ) {
    super(code);
  }
}

export type MemoryForgetFailureCode =
  | "forget_requires_bujo"
  | "forget_usage"
  | "forget_config_invalid"
  | "forget_prepare_failed"
  | "forget_apply_failed"
  | "forget_apply_failed_recovered"
  | "forget_apply_recovery_failed"
  | "forget_restore_failed";

const MEMORY_FORGET_FAILURE_MESSAGES: Readonly<Record<MemoryForgetFailureCode, string>> = Object.freeze({
  forget_requires_bujo: "Memory forget requires a configured built-in BuJo store with embeddings.",
  forget_usage: "Memory forget arguments are invalid.",
  forget_config_invalid: "Memory forget requires a valid private configuration.",
  forget_prepare_failed: "Forget-plan preparation failed without changing the memory store.",
  forget_apply_failed: "Forget-plan application failed before a recoverable backup was available.",
  forget_apply_failed_recovered: "Forget-plan application failed and the complete pre-apply backup was restored.",
  forget_apply_recovery_failed: "Forget-plan application failed and automatic recovery could not be verified; keep the agent stopped and restore the reported backup manually.",
  forget_restore_failed: "Backup restore was refused or failed; the current memory store was not intentionally overwritten.",
});

async function runMemoryForget(
  context: MemoryCommandContext,
  rest: readonly string[],
  input: RunMemoryCommandInput,
): Promise<number> {
  const operation = rest[0] as "prepare" | "apply" | "restore";
  const memory = context.config.memory;
  if (memory === undefined || (memory.backend ?? "bujo") === "supermemory"
    || memory.mode !== "bujo" || memory.embeddings === undefined) {
    writeMemoryForgetFailure(input.json, operation, "forget_requires_bujo");
    return 1;
  }

  try {
    const bujo = await loadBujoModule();
    const root = bujo.resolveExplicitMemoryForgetRoot(resolve(context.cwd, memory.path));
    if (operation === "prepare") {
      const result = await prepareMemoryForgetPlan(context, root, input);
      write(input.json, result, () => renderMemoryForgetResult(result));
      return 0;
    }
    if (operation === "apply") {
      const result = await applyMemoryForgetPlan(context, root, input.planPath!);
      write(input.json, result, () => renderMemoryForgetResult(result));
      return 0;
    }
    const result = await restoreMemoryForgetBackup(context, root, input.backupPath!);
    write(input.json, result, () => renderMemoryForgetResult(result));
    return 0;
  } catch (error) {
    const failure = error instanceof MemoryForgetOperationError
      ? error
      : new MemoryForgetOperationError(
          operation === "prepare"
            ? "forget_prepare_failed"
            : operation === "restore"
              ? "forget_restore_failed"
              : "forget_apply_failed",
        );
    writeMemoryForgetFailure(input.json, operation, failure.code, failure.recovered, failure.backupPath);
    return 1;
  }
}

async function prepareMemoryForgetPlan(
  context: MemoryCommandContext,
  root: string,
  input: RunMemoryCommandInput,
) {
  const idsFile = resolve(context.cwd, input.idsFile!);
  const planPath = await canonicalProspectivePath(resolve(context.cwd, input.planPath!));
  if (isSameOrUnderDirectory(root, planPath)) {
    throw new MemoryForgetOperationError("forget_prepare_failed");
  }
  const memoryIds = await readMemoryIds(idsFile);
  const bujo = await loadBujoModule();
  bujo.previewCanonicalExplicitForgetMemories(root, memoryIds);

  const payload: MemoryForgetPlanPayload = {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: "forget",
    rootFingerprint: memoryRootFingerprint(root),
    sourceFingerprint: bujo.readBujoCanonicalSourceFingerprint(root),
    reason: input.reason!,
    createdAt: new Date().toISOString(),
    memoryIds,
  };
  const plan: MemoryForgetPlan = { ...payload, planDigest: memoryForgetPlanDigest(payload) };
  await writePrivateJsonExclusive(planPath, plan);
  return {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: "forget-prepare" as const,
    status: "prepared" as const,
    count: memoryIds.length,
    planPath,
    planDigest: plan.planDigest,
  };
}

async function applyMemoryForgetPlan(
  context: MemoryCommandContext,
  root: string,
  rawPlanPath: string,
) {
  const planPath = resolve(context.cwd, rawPlanPath);
  const canonicalPlanPath = await canonicalProspectivePath(planPath);
  if (isSameOrUnderDirectory(root, canonicalPlanPath)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  const plan = await readMemoryForgetPlan(planPath);
  const bujo = await loadBujoModule();
  if (plan.rootFingerprint !== memoryRootFingerprint(root)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  // Preserve the user-facing same-config diagnostic; the package transaction
  // independently enforces the authoritative shared-root writer lease.
  await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
  const settings = previewRecallSettings(context.config);
  if (settings === undefined || "supermemory" in settings || settings.embeddings === undefined) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  const { createMemoryEmbeddingProvider } = await loadMemoryRecallModule();
  const embeddings = await createMemoryEmbeddingProvider(settings.embeddings);
  try {
    const result = await bujo.applyExplicitMemoryForget({
      root,
      ids: plan.memoryIds,
      expectedRootFingerprint: plan.rootFingerprint,
      expectedSourceFingerprint: plan.sourceFingerprint,
      planDigest: plan.planDigest,
      embeddings,
      dimension: settings.embeddings.dim ?? 768,
    });
    return {
      schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
      operation: "forget-apply" as const,
      status: "applied" as const,
      count: result.forgotten,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: result.backupPath,
      planDigest: plan.planDigest,
    };
  } catch (error) {
    if (error instanceof bujo.ExplicitMemoryForgetError) {
      if (error.code === "apply_failed_recovered") {
        throw new MemoryForgetOperationError("forget_apply_failed_recovered", true, error.backupPath);
      }
      if (error.code === "apply_recovery_failed") {
        throw new MemoryForgetOperationError("forget_apply_recovery_failed", false, error.backupPath);
      }
    }
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
}

async function restoreMemoryForgetBackup(
  context: MemoryCommandContext,
  root: string,
  rawBackupPath: string,
) {
  const bujo = await loadBujoModule();
  try {
    const result = await bujo.restoreExplicitMemoryForget({
      root,
      backupPath: resolve(context.cwd, rawBackupPath),
      expectedRootFingerprint: memoryRootFingerprint(root),
    });
    return {
      schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
      operation: "forget-restore" as const,
      status: "restored" as const,
      backupPath: result.backupPath,
      sourceFingerprint: result.sourceFingerprint,
      planDigest: result.planDigest,
    };
  } catch {
    throw new MemoryForgetOperationError("forget_restore_failed");
  }
}

async function readMemoryIds(path: string): Promise<readonly string[]> {
  const raw = await readPinnedFile(path, MAX_FORGET_PLAN_BYTES, false);
  const ids = raw.split(/\r?\n/gu).map((id) => id.trim()).filter((id) => id.length > 0).sort();
  if (ids.length === 0 || ids.length > MAX_FORGET_IDS || new Set(ids).size !== ids.length
    || ids.some((id) => !MEMORY_ID_RE.test(id))) {
    throw new MemoryForgetOperationError("forget_prepare_failed");
  }
  return ids;
}

function memoryForgetPlanDigest(payload: MemoryForgetPlanPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function memoryRootFingerprint(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

async function readMemoryForgetPlan(path: string): Promise<MemoryForgetPlan> {
  const value = await readPrivateJson(path, MAX_FORGET_PLAN_BYTES);
  if (!isObject(value)
    || !hasExactKeys(value, [
      "createdAt",
      "memoryIds",
      "operation",
      "planDigest",
      "reason",
      "rootFingerprint",
      "schemaVersion",
      "sourceFingerprint",
    ])
    || value.schemaVersion !== MEMORY_FORGET_SCHEMA_VERSION
    || value.operation !== "forget"
    || !isSha256(value.rootFingerprint)
    || !isSha256(value.sourceFingerprint)
    || typeof value.reason !== "string" || !INTAKE_REASON_RE.test(value.reason)
    || typeof value.createdAt !== "string" || !isCanonicalIso(value.createdAt)
    || !Array.isArray(value.memoryIds) || value.memoryIds.length === 0
    || value.memoryIds.length > MAX_FORGET_IDS
    || value.memoryIds.some((id) => typeof id !== "string" || !MEMORY_ID_RE.test(id))
    || new Set(value.memoryIds).size !== value.memoryIds.length
    || typeof value.planDigest !== "string" || !isSha256(value.planDigest)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  const payload: MemoryForgetPlanPayload = {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: "forget",
    rootFingerprint: value.rootFingerprint,
    sourceFingerprint: value.sourceFingerprint,
    reason: value.reason,
    createdAt: value.createdAt,
    memoryIds: value.memoryIds as string[],
  };
  if (value.planDigest !== memoryForgetPlanDigest(payload)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  return { ...payload, planDigest: value.planDigest };
}

async function writePrivateJsonExclusive(path: string, value: unknown): Promise<void> {
  const handle = await openFile(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const opened = await handle.stat();
    const current = await lstat(path);
    assertPinnedFile(opened, current, path, true, MAX_FORGET_PLAN_BYTES);
  } finally {
    await handle.close();
  }
  await fsyncParentDirectory(path);
}

async function readPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readPinnedFile(path, maxBytes, true)) as unknown;
}

async function readPinnedFile(path: string, maxBytes: number, ownerPrivate: boolean): Promise<string> {
  const before = await lstat(path);
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertPinnedFile(before, opened, path, ownerPrivate, maxBytes);
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    const current = await lstat(path);
    assertPinnedFile(opened, after, path, ownerPrivate, maxBytes);
    assertPinnedFile(opened, current, path, ownerPrivate, maxBytes);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error("private artifact changed while it was read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function assertPinnedFile(
  expected: Stats,
  actual: Stats,
  path: string,
  ownerPrivate: boolean,
  maxBytes: number,
): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.size > maxBytes
    || expected.dev !== actual.dev || expected.ino !== actual.ino
    || (ownerPrivate && (actual.mode & 0o077) !== 0)
    || (uid !== undefined && actual.uid !== uid)) {
    throw new Error(`private artifact is unsafe: ${path}`);
  }
}

async function fsyncParentDirectory(path: string): Promise<void> {
  const handle = await openFile(dirname(path), constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function canonicalProspectivePath(path: string): Promise<string> {
  const parent = await realpath(dirname(path));
  return join(parent, basename(path));
}

function isSameOrUnderDirectory(parent: string, child: string): boolean {
  return parent === child || isUnderDirectory(parent, child);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function writeMemoryForgetFailure(
  json: boolean,
  operation: string,
  code: MemoryForgetFailureCode,
  recovered = false,
  backupPath?: string,
): void {
  const safeOperation = operation === "prepare" || operation === "apply" || operation === "restore"
    ? operation
    : "unknown";
  const result = {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: `forget-${safeOperation}`,
    status: "failed" as const,
    code,
    message: MEMORY_FORGET_FAILURE_MESSAGES[code],
    ...(recovered ? { recovered: true } : {}),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
  if (json) {
    write(true, result, () => "");
    return;
  }
  process.stderr.write(ui.errorLine(`[${code}] ${result.message}`));
}

function renderMemoryForgetResult(result: {
  readonly operation: string;
  readonly status: string;
  readonly count?: number;
  readonly planPath?: string;
  readonly backupPath?: string;
  readonly sourceFingerprint?: string;
}): string {
  return `${ui.banner("mono-agent memory", result.operation)}\n${ui.keyValue([
    ["status", result.status],
    ...(result.count === undefined ? [] : [["count", String(result.count)] as const]),
    ...(result.planPath === undefined ? [] : [["plan", result.planPath] as const]),
    ...(result.backupPath === undefined ? [] : [["backup", result.backupPath] as const]),
    ...(result.sourceFingerprint === undefined ? [] : [["source fingerprint", result.sourceFingerprint] as const]),
  ])}\n`;
}

type PublishedMemoryHealthStatus = BujoMemoryHealthReport["status"] | "not_configured";
type StrictMemoryHealthReport =
  | BujoMemoryHealthReport
  | {
      readonly schemaVersion: typeof MEMORY_HEALTH_SCHEMA_VERSION;
      readonly backend: "bujo";
      readonly mode: NonNullable<MonoAgentConfig["memory"]>["mode"];
      readonly status: "unknown";
      readonly checkedAt: string;
      readonly issues: readonly ("native_module_unavailable" | "health_check_failed")[];
      readonly counts: typeof EMPTY_HEALTH_COUNTS;
    }
  | {
      readonly schemaVersion: typeof MEMORY_HEALTH_SCHEMA_VERSION;
      readonly backend: "none" | "supermemory";
      readonly status: "not_configured" | "unknown";
      readonly checkedAt: string;
      readonly issues: readonly [];
      readonly counts: typeof EMPTY_HEALTH_COUNTS;
    };

function notConfiguredHealthReport(now = new Date()): StrictMemoryHealthReport {
  return {
    schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
    backend: "none",
    status: "not_configured",
    checkedAt: now.toISOString(),
    issues: [],
    counts: EMPTY_HEALTH_COUNTS,
  };
}

async function runStrictAudit(context: MemoryCommandContext, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    const result = notConfiguredHealthReport();
    write(json, result, () => renderStrictAudit(result));
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result: StrictMemoryHealthReport = {
      schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
      backend: "supermemory",
      status: "unknown",
      checkedAt: new Date().toISOString(),
      issues: [],
      counts: EMPTY_HEALTH_COUNTS,
    };
    write(json, result, () => renderStrictAudit(result));
    return 1;
  }

  let result: StrictMemoryHealthReport;
  try {
    const { auditBujoMemoryHealth } = await loadBujoModule();
    result = auditBujoMemoryHealth({
      root: memory.path,
      mode: memory.mode,
      ...(memory.embeddings === undefined
        ? {}
        : {
            configuredEmbeddingModel: `${memory.embeddings.provider}:${memory.embeddings.model}`,
            configuredDimension: memory.embeddings.dim ?? 768,
          }),
    });
  } catch (error) {
    result = {
      schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
      backend: "bujo",
      mode: memory.mode,
      status: "unknown",
      checkedAt: new Date().toISOString(),
      issues: isNativeModuleFailure(error) ? ["native_module_unavailable"] : ["health_check_failed"],
      counts: EMPTY_HEALTH_COUNTS,
    };
  }
  write(json, result, () => renderStrictAudit(result));
  return strictHealthExitCode(result.status);
}

function strictHealthExitCode(status: PublishedMemoryHealthStatus): 0 | 1 {
  switch (status) {
    case "healthy":
    case "in_progress":
    case "not_configured":
      return 0;
    case "degraded":
    case "unhealthy":
    case "unknown":
      return 1;
  }
}

async function runIntakeInspect(
  context: MemoryCommandContext,
  id: string | undefined,
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    process.stderr.write(ui.errorLine("memory inspect is available only for the built-in memory intake."));
    return 1;
  }
  try {
    const { inspectCompletedTurnIntake } = await loadBujoModule();
    const inspection = inspectCompletedTurnIntake(memory.path);
    const result = intakeInspectionResult(inspection, id);
    write(json, result, () => renderIntakeInspection(result));
    return 0;
  } catch {
    process.stderr.write(ui.errorLine("memory inspect failed; the intake metadata is unavailable or invalid."));
    return 1;
  }
}

async function runIntakeMutation(
  context: MemoryCommandContext,
  operation: "retry" | "resolve",
  id: string | undefined,
  reason: string | undefined,
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    process.stderr.write(ui.errorLine(`memory ${operation} is available only for the built-in memory intake.`));
    return 1;
  }
  try {
    await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
    const bujo = await loadBujoModule();
    if (operation === "retry") {
      const mutation = bujo.retryCompletedTurnIntake(memory.path, id === undefined ? {} : { id });
      const result = {
        schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
        operation,
        changed: mutation.retried > 0,
        retried: mutation.retried,
      };
      write(json, result, () => renderIntakeMutation(result));
      return 0;
    }
    const mutation = bujo.resolveCompletedTurnIntake(memory.path, id!, reason!);
    const result = {
      schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
      operation,
      changed: mutation.resolved,
      resolved: mutation.resolved,
    };
    write(json, result, () => renderIntakeMutation(result));
    return 0;
  } catch (error) {
    const retainedPlan = /retained semantic-plan recovery/iu.test(reasonOf(error));
    process.stderr.write(ui.errorLine(retainedPlan
      ? "memory resolve refused: retained semantic-plan recovery must complete first."
      : `memory ${operation} failed: ${reasonOf(error)}`));
    return 1;
  }
}

function intakeInspectionResult(inspection: CompletedTurnIntakeInspection, id: string | undefined) {
  const items = id === undefined ? inspection.items : inspection.items.filter((item) => item.id === id);
  return {
    schemaVersion: inspection.schemaVersion,
    operation: "inspect" as const,
    matched: items.length,
    temporary: inspection.temporary,
    snapshot: inspection.snapshot,
    items,
  };
}

async function memoryRegistryDirs(context: MemoryCommandContext): Promise<readonly string[]> {
  return await dedupeRegistryDirs([
    await resolveAppTraceRegistryDir({
      env: context.env,
      cwd: context.cwd,
      configPath: context.configPath,
    }),
    resolveGlobalTraceRegistryDir(context.env),
  ]);
}

async function runIndexTransition(
  context: MemoryCommandContext,
  operation: "rebuild" | "rollback",
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    process.stderr.write(ui.errorLine(
      `mono-agent memory ${operation} is available only for the built-in Lite, Journal, and BuJo stores; Supermemory manages its remote index.`,
    ));
    return 1;
  }

  const settings = previewRecallSettings(context.config);
  if (settings === undefined || "supermemory" in settings) {
    process.stderr.write(ui.errorLine(`Unable to resolve the configured built-in memory store for ${operation}.`));
    return 1;
  }

  try {
    const registryDirs = await memoryRegistryDirs(context);
    await assertNoLiveConfiguredAgent(context.configPath, registryDirs);
    const {
      resolveActiveMemoryDbPath,
      rollbackMemoryIndex,
      safeRebuildMemoryIndex,
    } = await loadBujoModule();
    const { createMemoryEmbeddingProvider } = await loadMemoryRecallModule();
    const embeddings = settings.embeddings === undefined
      ? undefined
      : await createMemoryEmbeddingProvider(settings.embeddings);
    const options = {
      root: memory.path,
      tier: memory.mode,
      ...(embeddings === undefined ? {} : { embeddings, dim: settings.embeddings?.dim ?? 768 }),
    };
    // Re-check after provider construction so a legacy writer that started
    // during setup cannot be raced by the destructive transition.
    await assertNoLiveConfiguredAgent(context.configPath, registryDirs);
    const details = operation === "rebuild"
      ? await safeRebuildMemoryIndex(options)
      : await rollbackMemoryIndex(options);
    const activeDatabase = await resolveActiveMemoryDbPath(memory.path);
    const result = {
      configured: true,
      backend: "bujo",
      operation,
      activeDatabase,
      details,
    };
    write(json, result, () => renderIndexTransition(result));
    return 0;
  } catch (error) {
    process.stderr.write(ui.errorLine(`memory ${operation} failed: ${reasonOf(error)}`));
    return 1;
  }
}

async function runAudit(context: MemoryCommandContext, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result = {
      configured: true,
      backend: "supermemory",
      metadataOnly: true,
      counts: null,
      bytes: null,
      duplicates: null,
      vectorCoverage: null,
      accessConcentration: null,
      backlog: { known: false, captureQueue: null, vectorIndex: null },
      latency: { known: false, searchP50Ms: null, searchP95Ms: null, indexingMs: null },
      cost: { known: false, totalUsd: null, embeddingCalls: null, llmCalls: null, tokens: null },
      notes: ["Remote backend health metadata is not exposed by the configured client."],
    };
    write(json, result, () => renderAudit(result));
    return 0;
  }

  const root = memory.path;
  const { readBujoRuntimeSnapshot, resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  const runtime = readBujoRuntimeSnapshot(root);
  const dbPath = await resolveActiveMemoryDbPath(root);
  const rootExists = await exists(root);
  const size = rootExists ? await collectStoreSize(root) : emptySize();
  let audit: MemoryStoreAudit | undefined;
  let generation: IndexMetadata | undefined;
  let metadataQueryMs: number | null = null;
  if (await exists(dbPath)) {
    const db = openMemoryDb({ path: dbPath, readOnly: true });
    try {
      const started = performance.now();
      audit = db.audit();
      generation = db.indexMetadata();
      metadataQueryMs = performance.now() - started;
    } finally {
      db.close();
    }
  }
  const live = audit?.counts.live ?? 0;
  const liveIndexed = audit?.vectors.liveIndexed ?? 0;
  const semanticExpected = memory.embeddings !== undefined;
  const runtimeQueues = runtime.snapshot?.queues;
  const captureQueue = runtime.stale ? undefined : runtimeQueues?.capture;
  const runtimeVectorBacklog = runtime.stale ? undefined : runtimeQueues?.index?.remainingBacklog;
  const result = {
    configured: true,
    backend: "bujo",
    mode: memory.mode,
    ...(generation === undefined ? {} : { generation }),
    metadataOnly: true,
    counts: audit?.counts ?? { total: 0, live: 0, entities: 0, entityRelations: 0 },
    bytes: size,
    duplicates: audit?.duplicates ?? { groups: 0, redundantRecords: 0, ratio: 0 },
    vectorCoverage: audit?.vectors ?? { indexed: 0, liveIndexed: 0, liveCoverage: live === 0 ? 1 : 0 },
    accessConcentration: audit?.access ?? { totalCount: 0, accessedMemories: 0, topOnePercentShare: 0 },
    backlog: {
      known: true,
      captureQueue: captureQueue === undefined ? null : captureQueue.queued + captureQueue.inFlight,
      vectorIndex: runtimeVectorBacklog ?? (semanticExpected ? Math.max(0, live - liveIndexed) : 0),
    },
    runtime: {
      available: runtime.available,
      stale: runtime.stale,
      ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
      ...(runtime.ageMs === undefined ? {} : { ageMs: runtime.ageMs }),
      ...(runtime.processAlive === undefined ? {} : { processAlive: runtime.processAlive }),
      ...(runtime.snapshot === undefined ? {} : {
        pid: runtime.snapshot.pid,
        tier: runtime.snapshot.tier,
        state: runtime.snapshot.state,
        startedAt: runtime.snapshot.startedAt,
        updatedAt: runtime.snapshot.updatedAt,
        queues: runtime.snapshot.queues,
      }),
    },
    latency: {
      known: metadataQueryMs !== null,
      metadataQueryMs,
      searchP50Ms: null,
      searchP95Ms: null,
      indexingMs: null,
    },
    cost: {
      known: runtime.snapshot !== undefined,
      totalUsd: null,
      embeddingCalls: runtime.snapshot?.counters.embeddingCalls ?? null,
      embeddingTexts: runtime.snapshot?.counters.embeddingTexts ?? null,
      llmCalls: runtime.snapshot?.counters.llmCalls ?? null,
      llmInputChars: runtime.snapshot?.counters.llmInputChars ?? null,
      tokens: null,
    },
    notes: [
      ...(audit === undefined ? [`No SQLite index found at ${dbPath}.`] : []),
      ...(generation === undefined ? [] : [
        `Generation ${generation.generation}: skipped raw summaries ${generation.skippedRawRecords ?? 0}, `
        + `unstructured source lines ${generation.skippedUnstructuredRecords ?? 0}, `
        + `missing-identity source lines ${generation.skippedMissingIdentityRecords ?? 0} `
        + `(${generation.missingIdentityLocations?.join(", ") || "none"}), `
        + `legacy-source lines ${generation.skippedLegacySourceRecords ?? 0} `
        + `(${generation.legacySourceLocations?.join(", ") || "none"}), `
        + `Journal duplicate lines ${generation.skippedJournalDuplicateRecords ?? 0}, `
        + `parsed source items ${generation.parsedSourceItems ?? 0}, `
        + `derived legacy associations ${generation.derivedLegacyAssociations ?? 0}.`,
      ]),
      "Search latency and model cost require benchmark/run telemetry and are not inferred from memory content.",
      ...(!runtime.available ? [
        `Runtime queue/call telemetry is ${runtime.reason === "invalid" ? "invalid" : "not available until the configured store starts"}.`,
      ] : runtime.stale ? [
        `Runtime queue/call telemetry is stale (${runtime.snapshot?.state ?? "unknown"} snapshot; last update ${runtime.snapshot?.updatedAt ?? "unknown"}).`,
      ] : []),
    ],
  };
  write(json, result, () => renderAudit(result));
  return 0;
}

async function loadMemoryCommandContext(
  input: RunMemoryCommandInput,
): Promise<MemoryCommandContext | { readonly code: number }> {
  const cwd = input.cwd;
  const configPath = resolve(cwd, input.configPath ?? "mono-agent.config.json");
  try {
    return {
      cwd,
      env: input.env,
      configPath,
      config: await loadAppCoreConfig({ env: input.env, cwd, configPath }),
    };
  } catch (error) {
    if (input.positionals[0] === "adopt-replay") {
      // Config/native failures can contain the config path or invalid private
      // values. Adoption always exposes the same closed error contract.
      writeReplayAdoptionCliFailure(input.json, "replay_adoption_config_invalid");
      return { code: 1 };
    }
    if (input.positionals[0] === "forget") {
      writeMemoryForgetFailure(input.json, input.positionals[1] ?? "unknown", "forget_config_invalid");
      return { code: 1 };
    }
    if (isAppCoreConfigError(error)) {
      process.stderr.write(ui.errorLine(error.message));
      process.stderr.write(ui.hint(`Fix ${configPath}, then re-run \`mono-agent memory\`.`));
      return { code: 1 };
    }
    throw error;
  }
}

async function assertNoLiveConfiguredAgent(configPath: string, registryDirs: readonly string[]): Promise<void> {
  const live = await findLiveConfiguredAgent(configPath, registryDirs);
  if (live === undefined) return;
  const canonicalConfig = await canonicalPath(configPath);
  throw new Error(
    `agent process ${live.pid} (${live.sourceId}) is still alive for this config (trace health: ${live.health}); ` +
    `stop it first with: mono-agent stop --config ${canonicalConfig}`,
  );
}

async function hasLiveConfiguredAgent(configPath: string, registryDirs: readonly string[]): Promise<boolean> {
  return await findLiveConfiguredAgent(configPath, registryDirs) !== undefined;
}

async function findLiveConfiguredAgent(
  configPath: string,
  registryDirs: readonly string[],
): Promise<TraceSourceListItem | undefined> {
  const canonicalConfig = await canonicalPath(configPath);
  const listings = await Promise.all(registryDirs.map(async (registryDir) => await listTraceSources({ registryDir })));
  const sources = dedupeTraceSources(listings.flatMap((listing) => listing.sources));
  let live: (typeof sources)[number] | undefined;
  for (const source of sources) {
    if (source.configPath === undefined || source.pid === undefined || !pidIsAlive(source.pid)) continue;
    if (await canonicalPath(source.configPath) === canonicalConfig) {
      live = source;
      break;
    }
  }
  return live;
}

async function dedupeRegistryDirs(registryDirs: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const registryDir of registryDirs) {
    const canonical = await canonicalPath(registryDir);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push(registryDir);
  }
  return deduped;
}

function dedupeTraceSources(sources: readonly TraceSourceListItem[]): TraceSourceListItem[] {
  const seen = new Set<string>();
  const deduped: TraceSourceListItem[] = [];
  for (const source of sources) {
    // Primary and global registries mirror the same source/PID pair. Preserve
    // a reused source ID with a different PID so either live process blocks.
    const key = `${source.sourceId}\0${source.pid ?? "unknown"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runStats(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const supermemory = supermemoryStats(context.config);
    write(input.json, supermemory, () => renderSupermemoryStats(supermemory));
    return 0;
  }

  const root = memory.path;
  const { resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  const dbPath = await resolveActiveMemoryDbPath(root);
  const rootExists = await exists(root);
  const dbExists = await exists(dbPath);
  const size = rootExists ? await collectStoreSize(root) : emptySize();
  const lastConsolidation = await mtimeIso(join(root, "index.md"));
  const lastDailyWrite = rootExists ? await latestDailyMtime(root) : undefined;
  let stats: MemoryStoreStats | undefined;
  let entityCount = 0;
  let topMemories: readonly MemoryRecord[] = [];
  if (dbExists) {
    const db = openMemoryDb({ path: dbPath, readOnly: true });
    try {
      stats = readLocalStats(db, input.limit ?? DEFAULT_ENTITY_LIMIT);
      entityCount = db.countEntities();
      topMemories = db.topSalient(input.limit ?? DEFAULT_TOP_LIMIT);
    } finally {
      db.close();
    }
  }

  const lastCapture = stats?.latestCreatedMemory?.createdAt ?? lastDailyWrite;
  const lastAccess = stats?.latestAccessedMemory?.lastAccessedAt;
  const result = {
    configured: true,
    backend: "bujo",
    mode: memory.mode,
    effectiveTier: effectiveLocalTier(memory),
    writeMode: memory.writeMode,
    recallToolEnabled: memory.recallTool?.enabled === true,
    root,
    ...(dbExists ? { database: dbPath } : {}),
    counts: stats === undefined
      ? { total: 0, live: 0, byStatus: {}, byType: {}, entities: 0 }
      : {
          total: stats.totalMemories,
          live: stats.liveMemories,
          byStatus: stats.countsByStatus,
          byType: stats.countsByType,
          entities: entityCount,
        },
    size,
    ...(lastCapture === undefined ? {} : { lastCapture }),
    ...(lastAccess === undefined ? {} : { lastAccess }),
    ...(lastConsolidation === undefined ? {} : { lastConsolidation }),
    topEntities: stats?.topEntities ?? [],
    topMemories,
    notes: [
      ...(rootExists ? [] : [`Memory root does not exist yet: ${root}`]),
      ...(dbExists ? [] : [`No SQLite index found at ${dbPath}; search/top need an indexed store.`]),
    ],
  };

  write(input.json, result, () => renderLocalStats(result));
  return 0;
}

async function runShow(context: MemoryCommandContext, date: string, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result = {
      configured: true,
      backend: "supermemory",
      available: false,
      message: "Supermemory stores memories remotely; local daily logs are not available.",
    };
    write(json, result, () => `${ui.banner("mono-agent memory", "daily log")}\n${result.message}\n`);
    return 0;
  }

  const found = await findDailyFile(memory.path, date);
  if (found === undefined) {
    const result = {
      configured: true,
      backend: "bujo",
      date,
      found: false,
      checked: [join(memory.path, "daily", `${date}.md`), join(memory.path, `${date}.md`)],
    };
    write(json, result, () => `${ui.banner("mono-agent memory", date)}\nNo daily log found for ${date}.\n`);
    return 0;
  }
  const content = await readFile(found, "utf8");
  const { parseDailyFile } = await loadBujoModule();
  const parsed = parseDailyFile(content);
  const result = {
    configured: true,
    backend: "bujo",
    date,
    found: true,
    path: found,
    bullets: parsed.bullets.map((bullet) => ({
      id: bullet.id,
      type: bullet.type,
      status: bullet.status,
      text: bullet.text,
      salience: bullet.salience,
      createdAt: bullet.createdAt,
    })),
    content,
  };
  write(json, result, () => renderDaily(result));
  return 0;
}

async function runSearch(
  context: MemoryCommandContext,
  query: string,
  input: RunMemoryCommandInput,
): Promise<number> {
  let settings = previewRecallSettings(context.config);
  if (settings === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  if (!("supermemory" in settings)) {
    const { resolveActiveMemoryDbPath } = await loadBujoModule();
    const dbPath = await resolveActiveMemoryDbPath(settings.root);
    settings = { ...settings, dbPath };
  }
  if (!("supermemory" in settings) && !(await exists(settings.dbPath ?? join(settings.root, "memory.db")))) {
    const dbPath = settings.dbPath ?? join(settings.root, "memory.db");
    const result = {
      configured: true,
      backend: "bujo",
      query,
      hits: [],
      notes: [`No SQLite index found at ${dbPath}; run mono-agent memory rebuild or wait for capture.`],
    };
    write(input.json, result, () => renderSearch(result));
    return 0;
  }

  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  let degraded: string | undefined;
  const hits = await recallWithFtsFallback(settings, query, limit)
    .then((result) => {
      degraded = result.degraded;
      return result.hits;
    })
    .catch((error) => {
      process.stderr.write(ui.errorLine(`memory search failed: ${reasonOf(error)}`));
      return undefined;
    });
  if (hits === undefined) {
    return 1;
  }
  const result = {
    configured: true,
    backend: "supermemory" in settings ? "supermemory" : "bujo",
    query,
    ...(degraded === undefined ? {} : { degraded }),
    hits: hits.map((hit) => ({
      id: hit.record.id,
      score: hit.score,
      text: hit.record.text,
      source: sourceOf(hit),
      ...(hit.record.salience === undefined ? {} : { salience: hit.record.salience }),
      ...(hit.record.createdAt === undefined ? {} : { createdAt: hit.record.createdAt }),
    })),
  };
  write(input.json, result, () => renderSearch(result));
  return 0;
}

async function runTop(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result = {
      configured: true,
      backend: "supermemory",
      available: false,
      message: "Supermemory does not expose a local salience ranking; use memory search instead.",
    };
    write(input.json, result, () => `${ui.banner("mono-agent memory", "top")}\n${result.message}\n`);
    return 0;
  }
  const { resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  const dbPath = await resolveActiveMemoryDbPath(memory.path);
  if (!(await exists(dbPath))) {
    const result = {
      configured: true,
      backend: "bujo",
      hits: [],
      notes: [`No SQLite index found at ${dbPath}; run mono-agent memory rebuild or wait for capture.`],
    };
    write(input.json, result, () => renderTop(result));
    return 0;
  }
  const db = openMemoryDb({ path: dbPath, readOnly: true });
  try {
    const hits = db.topSalient(input.limit ?? DEFAULT_TOP_LIMIT).map((record) => ({
      id: record.id,
      text: record.text,
      salience: record.salience,
      status: record.status,
      type: record.type,
      source: sourceOfRecord(record),
      createdAt: record.createdAt,
    }));
    const result = { configured: true, backend: "bujo", hits, notes: [] };
    write(input.json, result, () => renderTop(result));
  } finally {
    db.close();
  }
  return 0;
}

function previewRecallSettings(config: MonoAgentConfig): MemoryRecallSettings | undefined {
  return resolveMemoryRecallSettings(config, { ignoreRecallToolGate: true });
}

async function recallWithFtsFallback(
  settings: MemoryRecallSettings,
  query: string,
  limit: number,
): Promise<{ readonly hits: readonly PreviewRecallHit[]; readonly degraded?: string }> {
  const { createRecallStore } = await loadMemoryRecallModule();
  const store = await createRecallStore(settings);
  try {
    return { hits: await store.recall(query, { topK: limit, trackAccess: false }) as readonly PreviewRecallHit[] };
  } catch (error) {
    if (!isFtsFallbackEligible(settings, error)) {
      throw error;
    }
    await store.close().catch(() => undefined);
    const fallback: MemoryRecallBujoSettings = {
      root: settings.root,
      ...(settings.tier === undefined ? {} : { tier: settings.tier }),
      ...(settings.dbPath === undefined ? {} : { dbPath: settings.dbPath }),
      ftsOnlyFallback: true,
    };
    const ftsStore = await createRecallStore(fallback);
    try {
      return {
        hits: await ftsStore.recall(query, { topK: limit, trackAccess: false }) as readonly PreviewRecallHit[],
        degraded: `Semantic embeddings unavailable (${reasonOf(error)}); showing FTS-only results.`,
      };
    } finally {
      await ftsStore.close();
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function isFtsFallbackEligible(
  settings: MemoryRecallSettings,
  error: unknown,
): settings is MemoryRecallBujoSettings {
  if ("supermemory" in settings || settings.embeddings === undefined) {
    return false;
  }
  if (isIntrinsicMemorySearchError(error)) {
    const code = readErrorProperty(error, "code");
    return code.ok
      && typeof code.value === "string"
      && FTS_FALLBACK_MEMORY_SEARCH_CODES.has(code.value as MemorySearchErrorCode);
  }
  if (isNativeAbortError(error)) {
    return true;
  }
  if (!isIntrinsicTypeError(error) && !isIntrinsicAggregateError(error)) {
    return false;
  }
  return hasNetworkFailureCause(error);
}

function hasNetworkFailureCause(error: Error): boolean {
  const pending: Error[] = [];
  const seen = new Set<Error>();
  let candidateCount = 0;

  const enqueue = (candidate: unknown): void => {
    if (candidateCount >= MAX_FTS_FALLBACK_CAUSE_CANDIDATES) {
      return;
    }
    candidateCount += 1;
    if (!isIntrinsicError(candidate) || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    pending.push(candidate);
  };

  const enqueueAggregateErrors = (aggregate: AggregateError): void => {
    const errorsRead = readErrorProperty(aggregate, "errors");
    if (!errorsRead.ok || !isArrayWithoutThrowing(errorsRead.value)) {
      return;
    }
    const errors = errorsRead.value;
    const lengthRead = readErrorProperty(errors, "length");
    if (
      !lengthRead.ok
      || typeof lengthRead.value !== "number"
      || !Number.isSafeInteger(lengthRead.value)
      || lengthRead.value < 0
    ) {
      return;
    }
    const readable = Math.min(
      lengthRead.value,
      MAX_FTS_FALLBACK_CAUSE_CANDIDATES - candidateCount,
    );
    for (let index = 0; index < readable; index += 1) {
      const entry = readErrorProperty(errors, String(index));
      // A hostile array slot still consumes its bounded candidate position.
      enqueue(entry.ok ? entry.value : undefined);
    }
  };

  const enqueueChildren = (current: Error): void => {
    const cause = readErrorProperty(current, "cause");
    if (cause.ok && cause.value !== undefined) {
      enqueue(cause.value);
    }
    if (isIntrinsicAggregateError(current)) {
      enqueueAggregateErrors(current);
    }
  };

  enqueueChildren(error);
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) {
      continue;
    }
    const code = readErrorProperty(current, "code");
    if (
      code.ok
      && typeof code.value === "string"
      && FTS_FALLBACK_NETWORK_CODES.has(code.value.toUpperCase())
    ) {
      return true;
    }
    enqueueChildren(current);
  }
  return false;
}

type ErrorPropertyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

function readErrorProperty(value: object, key: PropertyKey): ErrorPropertyRead {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch {
    return { ok: false };
  }
}

function isArrayWithoutThrowing(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isIntrinsicError(value: unknown): value is Error {
  try {
    return value instanceof INTRINSIC_ERROR;
  } catch {
    return false;
  }
}

function isIntrinsicTypeError(value: unknown): value is TypeError {
  try {
    return value instanceof INTRINSIC_TYPE_ERROR;
  } catch {
    return false;
  }
}

function isIntrinsicAggregateError(value: unknown): value is AggregateError {
  try {
    return value instanceof INTRINSIC_AGGREGATE_ERROR;
  } catch {
    return false;
  }
}

function isIntrinsicMemorySearchError(value: unknown): value is MemorySearchError {
  try {
    return value instanceof MemorySearchError;
  } catch {
    return false;
  }
}

function isNativeAbortError(value: unknown): boolean {
  if (INTRINSIC_DOM_EXCEPTION === undefined || DOM_EXCEPTION_NAME_GETTER === undefined) {
    return false;
  }
  try {
    return value instanceof INTRINSIC_DOM_EXCEPTION
      && Reflect.apply(DOM_EXCEPTION_NAME_GETTER, value, []) === "AbortError";
  } catch {
    return false;
  }
}

function readLocalStats(db: MemoryDb, topEntitiesLimit: number): MemoryStoreStats {
  return db.stats({ topEntitiesLimit });
}

function effectiveLocalTier(memory: NonNullable<MonoAgentConfig["memory"]>): string {
  return memory.mode;
}

function supermemoryStats(config: MonoAgentConfig): {
  readonly configured: true;
  readonly backend: "supermemory";
  readonly baseUrl: string | undefined;
  readonly container: string | undefined;
  readonly known: readonly string[];
  readonly unavailable: readonly string[];
} {
  return {
    configured: true,
    backend: "supermemory",
    baseUrl: config.memory?.supermemory?.baseUrl,
    container: config.memory === undefined ? undefined : resolveSupermemoryContainer(config),
    known: ["backend", "baseUrl", "container"],
    unavailable: [
      "local counts",
      "local size",
      "last capture",
      "last consolidation",
      "top entities",
      "highest-salience memories",
      "daily markdown logs",
    ],
  };
}

async function findDailyFile(root: string, date: string): Promise<string | undefined> {
  const candidates = [join(root, "daily", `${date}.md`), join(root, `${date}.md`)];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function latestDailyMtime(root: string): Promise<string | undefined> {
  const files = await dailyMarkdownFiles(root);
  const mtimes = await Promise.all(files.map((file) => mtimeIso(file)));
  return newest(mtimes.flatMap((mtime) => mtime === undefined ? [] : [mtime]));
}

async function dailyMarkdownFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const dir of [root, join(root, "daily")]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && DATE_RE.test(basename(entry.name, ".md")) && entry.name.endsWith(".md")) {
        files.push(join(dir, entry.name));
      }
    }
  }
  return files;
}

async function collectStoreSize(root: string): Promise<{
  readonly rootBytes: number;
  readonly dailyBytes: number;
  readonly databaseBytes: number;
  readonly fileCount: number;
}> {
  let rootBytes = 0;
  let dailyBytes = 0;
  let databaseBytes = 0;
  let fileCount = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const s = await stat(filePath).catch(() => undefined);
      if (s === undefined) {
        continue;
      }
      fileCount += 1;
      rootBytes += s.size;
      if ((entry.name.endsWith(".md") && DATE_RE.test(basename(entry.name, ".md"))) || isUnderDirectory(join(root, "daily"), filePath)) {
        dailyBytes += s.size;
      }
      if (entry.name === "memory.db" || entry.name.startsWith("memory.db-")) {
        databaseBytes += s.size;
      }
    }
  }
  await walk(root);
  return { rootBytes, dailyBytes, databaseBytes, fileCount };
}

function isUnderDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function emptySize(): { readonly rootBytes: 0; readonly dailyBytes: 0; readonly databaseBytes: 0; readonly fileCount: 0 } {
  return { rootBytes: 0, dailyBytes: 0, databaseBytes: 0, fileCount: 0 };
}

async function mtimeIso(path: string): Promise<string | undefined> {
  const s = await stat(path).catch(() => undefined);
  return s === undefined ? undefined : s.mtime.toISOString();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function newest(values: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function sourceOf(hit: PreviewRecallHit): string {
  const source = hit.record.source;
  if (source?.file !== undefined) {
    return source.line === undefined ? source.file : `${source.file}:${source.line}`;
  }
  if (source?.session !== undefined) {
    return `session:${source.session}`;
  }
  return hit.record.id;
}

function sourceOfRecord(record: MemoryRecord): string {
  if (record.source.file !== undefined) {
    return record.source.line === undefined ? record.source.file : `${record.source.file}:${record.source.line}`;
  }
  if (record.source.session !== undefined) {
    return `session:${record.source.session}`;
  }
  return record.id;
}

function writeNoMemory(configPath: string, json: boolean): void {
  const result = {
    configured: false,
    message: `No memory configured in ${configPath}.`,
  };
  write(json, result, () => `${ui.banner("mono-agent memory", "not configured")}\n${result.message}\n`);
}

function write<T>(json: boolean, value: T, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human());
}

function renderSupermemoryStats(stats: ReturnType<typeof supermemoryStats>): string {
  return [
    ui.banner("mono-agent memory", "stats"),
    ui.keyValue([
      ["backend", "supermemory"],
      ["base URL", stats.baseUrl ?? "unknown"],
      ["container", stats.container ?? "unknown"],
    ], 2),
    "Remote-only fields not known locally:\n",
    ...stats.unavailable.map((item) => `  - ${item}\n`),
  ].join("");
}

function renderAudit(result: {
  readonly backend: string;
  readonly counts: { readonly total: number; readonly live: number; readonly entities: number; readonly entityRelations: number } | null;
  readonly bytes: { readonly rootBytes: number; readonly dailyBytes: number; readonly databaseBytes: number; readonly fileCount: number } | null;
  readonly duplicates: { readonly groups: number; readonly redundantRecords: number; readonly ratio: number } | null;
  readonly vectorCoverage: { readonly indexed: number; readonly liveIndexed: number; readonly liveCoverage: number } | null;
  readonly accessConcentration: { readonly totalCount: number; readonly accessedMemories: number; readonly topOnePercentShare: number } | null;
  readonly backlog: { readonly captureQueue: number | null; readonly vectorIndex: number | null };
  readonly runtime?: { readonly available: boolean; readonly stale: boolean; readonly state?: string };
  readonly latency: { readonly metadataQueryMs?: number | null; readonly searchP50Ms: number | null; readonly searchP95Ms: number | null; readonly indexingMs: number | null };
  readonly cost: { readonly totalUsd: number | null; readonly embeddingCalls: number | null; readonly llmCalls: number | null; readonly tokens: number | null };
  readonly notes: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "metadata audit") + "\n";
  out += ui.keyValue([
    ["backend", result.backend],
    ["memories", result.counts === null ? "unknown" : `${result.counts.total} total, ${result.counts.live} live`],
    ["bytes", result.bytes === null ? "unknown" : formatBytes(result.bytes.rootBytes)],
    ["duplicate ratio", result.duplicates === null ? "unknown" : formatRatio(result.duplicates.ratio)],
    ["vector coverage", result.vectorCoverage === null ? "unknown" : formatRatio(result.vectorCoverage.liveCoverage)],
    ["top 1% access share", result.accessConcentration === null ? "unknown" : formatRatio(result.accessConcentration.topOnePercentShare)],
    ["vector backlog", result.backlog.vectorIndex === null ? "unknown" : String(result.backlog.vectorIndex)],
    ["capture queue", result.backlog.captureQueue === null ? "not live/available" : String(result.backlog.captureQueue)],
    ["runtime telemetry", result.runtime === undefined || !result.runtime.available
      ? "unavailable"
      : `${result.runtime.state ?? "unknown"}${result.runtime.stale ? " (stale)" : " (live)"}`],
    ["metadata query", result.latency.metadataQueryMs == null ? "unknown" : `${result.latency.metadataQueryMs.toFixed(3)} ms`],
    ["embedding calls", result.cost.embeddingCalls === null ? "unknown" : String(result.cost.embeddingCalls)],
    ["memory LLM calls", result.cost.llmCalls === null ? "unknown" : String(result.cost.llmCalls)],
    ["recorded cost", result.cost.totalUsd === null ? "unknown" : `$${result.cost.totalUsd.toFixed(6)}`],
  ], 2);
  for (const note of result.notes) out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  return out;
}

function renderStrictAudit(result: StrictMemoryHealthReport): string {
  return [
    ui.banner("mono-agent memory", "strict health"),
    "\n",
    ui.keyValue([
      ["schema", String(result.schemaVersion)],
      ["backend", result.backend],
      ["mode", "mode" in result ? result.mode : "none"],
      ["status", result.status],
      ["checked", result.checkedAt],
      ["issues", result.issues.length === 0 ? "none" : result.issues.join(", ")],
      ["pending", String(result.counts.pending)],
      ["due", String(result.counts.due)],
      ["dead", String(result.counts.dead)],
      ["outbox", String(result.counts.outbox)],
      ["temporary", String(result.counts.temporary)],
      ["memories", String(result.counts.memories)],
      ["vectors", String(result.counts.vectors)],
      ["missing vectors", String(result.counts.missingVectors)],
    ], 2),
  ].join("");
}

function renderIntakeInspection(result: ReturnType<typeof intakeInspectionResult>): string {
  let out = ui.banner("mono-agent memory", "intake inspection") + "\n";
  out += ui.keyValue([
    ["matched", String(result.matched)],
    ["pending", String(result.snapshot.pending)],
    ["due", String(result.snapshot.due)],
    ["dead", String(result.snapshot.dead)],
    ["resolved", String(result.snapshot.resolved)],
    ["transitioning", String(result.snapshot.transitioning)],
    ["temporary", String(result.temporary)],
  ], 2);
  for (const item of result.items) {
    out += `  ${item.id}  state=${item.state} attempt=${item.attempt} revision=${item.revision} due=${item.due ? "yes" : "no"}`;
    if (item.lastError !== undefined) out += ` lastError=${item.lastError}`;
    out += "\n";
  }
  return out;
}

function renderIntakeMutation(result: {
  readonly operation: "retry" | "resolve";
  readonly changed: boolean;
  readonly retried?: number;
  readonly resolved?: boolean;
}): string {
  return [
    ui.banner("mono-agent memory", `intake ${result.operation}`),
    "\n",
    ui.keyValue([
      ["changed", result.changed ? "yes" : "no"],
      ...(result.retried === undefined ? [] : [["retried", String(result.retried)] as const]),
      ...(result.resolved === undefined ? [] : [["resolved", result.resolved ? "yes" : "no"] as const]),
    ], 2),
  ].join("");
}

function renderLocalStats(stats: {
  readonly mode: string;
  readonly effectiveTier: string;
  readonly writeMode: string;
  readonly recallToolEnabled: boolean;
  readonly root: string;
  readonly database?: string;
  readonly counts: {
    readonly total: number;
    readonly live: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byType: Readonly<Record<string, number>>;
    readonly entities: number;
  };
  readonly size: { readonly rootBytes: number; readonly dailyBytes: number; readonly databaseBytes: number; readonly fileCount: number };
  readonly lastCapture?: string;
  readonly lastAccess?: string;
  readonly lastConsolidation?: string;
  readonly topEntities: readonly EntityRecord[];
  readonly notes: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "stats") + "\n";
  out += ui.keyValue([
    ["backend", "bujo"],
    ["configured tier", stats.mode],
    ["effective tier", stats.effectiveTier],
    ["write mode", stats.writeMode],
    ["recall tool", stats.recallToolEnabled ? "enabled" : "disabled"],
    ["root", stats.root],
    ["database", stats.database ?? "missing"],
    ["memories", `${stats.counts.total} total, ${stats.counts.live} live`],
    ["entities", String(stats.counts.entities)],
    ["size", `${formatBytes(stats.size.rootBytes)} (${stats.size.fileCount} files)`],
    ["daily logs", formatBytes(stats.size.dailyBytes)],
    ["database files", formatBytes(stats.size.databaseBytes)],
    ["last capture", stats.lastCapture ?? "unknown"],
    ["last access", stats.lastAccess ?? "unknown"],
    ["last consolidation", stats.lastConsolidation ?? "unknown"],
  ], 2);
  out += renderCounts("Status counts", stats.counts.byStatus);
  out += renderCounts("Type counts", stats.counts.byType);
  if (stats.topEntities.length > 0) {
    out += "\n" + ui.heading("Top Entities");
    for (const entity of stats.topEntities) {
      out += `  - ${entity.name}${entity.type === undefined ? "" : ` (${entity.type})`}`;
      if (entity.summary !== undefined) {
        out += `: ${entity.summary}`;
      }
      out += "\n";
    }
  }
  for (const note of stats.notes) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  return out;
}

function renderDaily(result: { readonly date: string; readonly path: string; readonly content: string }): string {
  return [
    ui.banner("mono-agent memory", result.date),
    ui.keyValue([["source", result.path]], 2),
    "\n",
    result.content.endsWith("\n") ? result.content : `${result.content}\n`,
  ].join("");
}

function renderIndexTransition(result: {
  readonly operation: "rebuild" | "rollback";
  readonly activeDatabase: string;
  readonly details: {
    readonly indexed: number;
    readonly generation: string;
    readonly skippedRawRecords: number;
    readonly skippedUnstructuredRecords: number;
    readonly skippedMissingIdentityRecords: number;
    readonly missingIdentityLocations: readonly string[];
    readonly skippedLegacySourceRecords: number;
    readonly legacySourceLocations: readonly string[];
    readonly skippedJournalDuplicateRecords: number;
    readonly parsedSourceItems: number;
    readonly derivedLegacyAssociations: number;
  };
}): string {
  return [
    ui.banner("mono-agent memory", result.operation),
    "\n",
    ui.keyValue([
      ["status", "complete"],
      ["active database", result.activeDatabase],
      ["generation", result.details.generation],
      ["indexed memories", String(result.details.indexed)],
      ["skipped raw summaries", String(result.details.skippedRawRecords)],
      ["skipped unstructured lines", String(result.details.skippedUnstructuredRecords)],
      ["skipped missing-identity lines", String(result.details.skippedMissingIdentityRecords)],
      ["missing-identity locations", result.details.missingIdentityLocations.join(", ") || "none"],
      ["skipped legacy-source lines", String(result.details.skippedLegacySourceRecords)],
      ["legacy-source locations", result.details.legacySourceLocations.join(", ") || "none"],
      ["skipped Journal duplicates", String(result.details.skippedJournalDuplicateRecords)],
      ["parsed source items", String(result.details.parsedSourceItems)],
      ["derived legacy associations", String(result.details.derivedLegacyAssociations)],
    ], 2),
  ].join("");
}

function renderReplayAdoption(result: {
  readonly status: "adopted";
  readonly counts: {
    readonly terminals: number;
    readonly supersedes: number;
    readonly threads: number;
  };
  readonly authorityDigest: string;
  readonly rebuildRequired: true;
}): string {
  return [
    ui.banner("mono-agent memory", "adopt replay"),
    "\n",
    ui.keyValue([
      ["status", result.status],
      ["terminal lifecycles", String(result.counts.terminals)],
      ["supersedes", String(result.counts.supersedes)],
      ["threads", String(result.counts.threads)],
      ["authority digest", result.authorityDigest],
      ["rebuild required", result.rebuildRequired ? "yes" : "no"],
    ], 2),
  ].join("");
}

function renderSearch(result: {
  readonly query: string;
  readonly degraded?: string;
  readonly hits: readonly { readonly score: number; readonly text: string; readonly source?: string }[];
  readonly notes?: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", `search: ${result.query}`) + "\n";
  if (result.degraded !== undefined) {
    out += ui.style.yellow(`[WARN] ${result.degraded}`) + "\n";
  }
  for (const note of result.notes ?? []) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  if (result.hits.length === 0) {
    return out + "No memories matched.\n";
  }
  for (const hit of result.hits) {
    out += `${hit.score.toFixed(3)}  ${hit.text}\n`;
    if (hit.source !== undefined) {
      out += `       source: ${hit.source}\n`;
    }
  }
  return out;
}

function renderTop(result: {
  readonly hits: readonly {
    readonly salience: number;
    readonly text: string;
    readonly source?: string;
    readonly status?: string;
    readonly type?: string;
  }[];
  readonly notes?: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "top") + "\n";
  for (const note of result.notes ?? []) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  if (result.hits.length === 0) {
    return out + "No memories indexed.\n";
  }
  for (const hit of result.hits) {
    const meta = [
      `salience ${hit.salience.toFixed(3)}`,
      ...(hit.type === undefined ? [] : [hit.type]),
      ...(hit.status === undefined ? [] : [hit.status]),
      ...(hit.source === undefined ? [] : [`source ${hit.source}`]),
    ].join("; ");
    out += `${hit.text}\n`;
    out += `       ${meta}\n`;
  }
  return out;
}

function renderCounts(label: string, counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }
  return "\n" + ui.heading(label) + entries.map(([key, value]) => `  ${key}: ${value}\n`).join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i] ?? unit;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadBujoModule(): Promise<typeof import("@mono-agent/memory/bujo")> {
  return await import("@mono-agent/memory/bujo");
}

async function loadMemoryStoreModule(): Promise<typeof import("@mono-agent/memory/store")> {
  return await import("@mono-agent/memory/store");
}

async function loadMemoryRecallModule(): Promise<typeof import("./memory-recall.js")> {
  return await import("./memory-recall.js");
}

function isNativeModuleFailure(error: unknown): boolean {
  try {
    const message = error instanceof Error ? error.message : "";
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
    return /better[-_ ]?sqlite|sqlite[-_ ]?vec|node_module_version|native module|dlopen|\.node\b/iu.test(`${code} ${message}`);
  } catch {
    return false;
  }
}
