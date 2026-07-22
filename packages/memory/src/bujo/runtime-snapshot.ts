import type { BujoQueueSnapshot } from "./store.js";
import type { BujoTier } from "./types.js";
import { readCanonicalFileSnapshot, writeCanonicalFileAtomic } from "./path-safety.js";

export const BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1;
export const BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS = 90_000;

const RUNTIME_FILE = "runtime.json";
const MAX_RUNTIME_SNAPSHOT_BYTES = 256 * 1024;

export interface BujoRuntimeCounters {
  readonly embeddingCalls: number;
  readonly embeddingTexts: number;
  readonly llmCalls: number;
  readonly llmInputChars: number;
}

/** Metadata-only operational state. It deliberately contains no prompts, memory text, entity names, or queue keys. */
export interface BujoRuntimeSnapshot {
  readonly schemaVersion: typeof BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION;
  readonly pid: number;
  readonly tier: BujoTier;
  readonly state: "running" | "closed";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly queues: BujoQueueSnapshot;
  readonly counters: BujoRuntimeCounters;
}

export interface BujoRuntimeSnapshotObservation {
  readonly available: boolean;
  readonly stale: boolean;
  readonly reason?: "missing" | "invalid";
  readonly ageMs?: number;
  readonly processAlive?: boolean;
  readonly snapshot?: BujoRuntimeSnapshot;
}

/** Atomically publish one metadata-only runtime snapshot under the managed index directory. */
export function writeBujoRuntimeSnapshot(root: string, snapshot: BujoRuntimeSnapshot): void {
  validateSnapshot(snapshot);
  writeCanonicalFileAtomic(root, `.index/${RUNTIME_FILE}`, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Read and validate the last operational snapshot without exposing memory content. */
export function readBujoRuntimeSnapshot(
  root: string,
  now = new Date(),
): BujoRuntimeSnapshotObservation {
  let file: ReturnType<typeof readCanonicalFileSnapshot>;
  try {
    file = readCanonicalFileSnapshot(root, `.index/${RUNTIME_FILE}`, {
      allowMissing: true,
      maxBytes: MAX_RUNTIME_SNAPSHOT_BYTES,
    });
  } catch {
    return { available: false, stale: true, reason: "invalid" };
  }
  if (file === undefined) return { available: false, stale: true, reason: "missing" };
  try {
    if ((file.identity.mode & 0o077) !== 0) throw new Error("runtime snapshot must not be group/world accessible");
    const parsed = JSON.parse(file.content) as unknown;
    validateSnapshot(parsed);
    const updatedMs = Date.parse(parsed.updatedAt);
    const ageMs = Math.max(0, now.getTime() - updatedMs);
    const processAlive = parsed.state === "running" && processIsAlive(parsed.pid);
    return {
      available: true,
      stale: parsed.state !== "running" || !processAlive || ageMs > BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS,
      ageMs,
      processAlive,
      snapshot: parsed,
    };
  } catch {
    return { available: false, stale: true, reason: "invalid" };
  }
}

function validateSnapshot(value: unknown): asserts value is BujoRuntimeSnapshot {
  if (!isRecord(value)
    || value.schemaVersion !== BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION
    || !Number.isInteger(value.pid) || Number(value.pid) <= 0
    || (value.tier !== "lite" && value.tier !== "journal" && value.tier !== "bujo")
    || (value.state !== "running" && value.state !== "closed")
    || !validDate(value.startedAt)
    || !validDate(value.updatedAt)
    || !validQueues(value.queues)
    || !validCounters(value.counters)) {
    throw new Error("memory-bujo: runtime snapshot is malformed.");
  }
}

function validQueues(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["index", "capture", "intake", "shutdown"]) || !validShutdown(value.shutdown)) {
    return false;
  }
  if (value.capture !== undefined && !validBackgroundQueue(value.capture, [])) return false;
  if (value.intake !== undefined && !validIntake(value.intake)) return false;
  return value.index === undefined || validBackgroundQueue(value.index, [
    "remainingBacklog",
    "recoveryFilesRemaining",
    "recoveryPaused",
    "retryDelayMs",
    "nextRetryDelayMs",
    "recoveryRowsScanned",
    "recoveryRefillQueries",
    "nextRetryAt",
  ]) && isRecord(value.index)
    && nonNegativeInteger(value.index.remainingBacklog)
    && nonNegativeInteger(value.index.recoveryFilesRemaining)
    && typeof value.index.recoveryPaused === "boolean"
    && nonNegativeInteger(value.index.retryDelayMs)
    && nonNegativeInteger(value.index.nextRetryDelayMs)
    && nonNegativeInteger(value.index.recoveryRowsScanned)
    && nonNegativeInteger(value.index.recoveryRefillQueries)
    && (value.index.nextRetryAt === undefined || validDate(value.index.nextRetryAt));
}

function validIntake(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["pending", "dead", "resolved", "due", "transitioning", "retrying", "accepting", "shutdown"])
    && nonNegativeInteger(value.pending)
    && nonNegativeInteger(value.dead)
    && nonNegativeInteger(value.resolved)
    && nonNegativeInteger(value.due)
    && nonNegativeInteger(value.transitioning)
    && nonNegativeInteger(value.retrying)
    && typeof value.accepting === "boolean"
    && (value.shutdown === "running" || value.shutdown === "drained"
      || value.shutdown === "pending" || value.shutdown === "timed_out");
}

const BACKGROUND_QUEUE_KEYS = [
  "capacity",
  "queued",
  "queuedBytes",
  "inFlight",
  "inFlightBytes",
  "highWaterItems",
  "highWaterBytes",
  "enqueued",
  "completed",
  "failed",
  "dropped",
  "discarded",
  "coalesced",
  "draining",
  "accepting",
] as const;

function validBackgroundQueue(value: unknown, extraKeys: readonly string[]): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [...BACKGROUND_QUEUE_KEYS, ...extraKeys])) return false;
  if (!isRecord(value.capacity)
    || !hasOnlyKeys(value.capacity, ["items", "bytes", "batchSize"])
    || !positiveInteger(value.capacity.items)
    || !positiveInteger(value.capacity.bytes)
    || !positiveInteger(value.capacity.batchSize)
    || typeof value.draining !== "boolean"
    || typeof value.accepting !== "boolean") return false;
  return [
    value.queued,
    value.queuedBytes,
    value.inFlight,
    value.inFlightBytes,
    value.highWaterItems,
    value.highWaterBytes,
    value.enqueued,
    value.completed,
    value.failed,
    value.dropped,
    value.discarded,
    value.coalesced,
  ].every(nonNegativeInteger);
}

function validShutdown(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["drainTimeoutMs", "discarded", "timedOut"])
    && positiveInteger(value.drainTimeoutMs)
    && nonNegativeInteger(value.discarded)
    && typeof value.timedOut === "boolean";
}

function validCounters(value: unknown): value is BujoRuntimeCounters {
  return isRecord(value)
    && nonNegativeInteger(value.embeddingCalls)
    && nonNegativeInteger(value.embeddingTexts)
    && nonNegativeInteger(value.llmCalls)
    && nonNegativeInteger(value.llmInputChars);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
