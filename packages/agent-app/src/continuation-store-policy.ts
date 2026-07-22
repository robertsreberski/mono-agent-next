import type { ContinuationState } from "./continuations.js";
import {
  canonicalContinuationJson,
  continuationDigest,
  isContinuationMode,
  isContinuationState,
} from "./continuations.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  CONTINUATION_STORE_SCHEMA_VERSION,
  DEFAULT_CAPTURED_TEXT_MAX_AGE_MS,
  DEFAULT_CAPTURED_TEXT_MAX_RECORDS,
  DEFAULT_TERMINAL_MAX_AGE_MS,
  DEFAULT_TERMINAL_MAX_RECORDS,
  MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES,
  MAX_GENERATION_BYTES,
  MAX_RECORD_BYTES,
  type ContinuationOriginContextGroupCommit,
  type ContinuationOriginContextReference,
  type ContinuationOriginContextState,
  type ContinuationRecordTransaction,
  type ContinuationRetentionOptions,
  type ContinuationStoreFile,
  type ContinuationStoreStats,
  type DurableContinuationRecord,
  type ResolvedContinuationRetention,
} from "./continuation-store-types.js";

export function resolveRetention(options: ContinuationRetentionOptions | undefined): ResolvedContinuationRetention {
  const policy: ResolvedContinuationRetention = {
    terminalMaxRecords: options?.terminalMaxRecords ?? DEFAULT_TERMINAL_MAX_RECORDS,
    terminalMaxAgeMs: options?.terminalMaxAgeMs ?? DEFAULT_TERMINAL_MAX_AGE_MS,
    capturedTextMaxRecords: options?.capturedTextMaxRecords ?? DEFAULT_CAPTURED_TEXT_MAX_RECORDS,
    capturedTextMaxAgeMs: options?.capturedTextMaxAgeMs ?? DEFAULT_CAPTURED_TEXT_MAX_AGE_MS,
  };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Continuation retention ${name} must be a non-negative safe integer.`);
    }
  }
  return policy;
}

const SETTLED_TERMINAL_STATES = new Set<ContinuationState>([
  "delivered",
  "expired",
  "cancelled",
  "dead_lettered",
]);

const ORIGIN_CONTEXT_SCRUB_STATES = new Set<ContinuationState>([
  "delivery_unknown",
  "delivered",
  "expired",
  "cancelled",
  "dead_lettered",
]);

export function applyRetention(
  records: Map<string, DurableContinuationRecord>,
  policy: ResolvedContinuationRetention,
  now: Date,
): void {
  const nowMs = now.getTime();
  const captures = [...records.values()]
    .filter((record) => SETTLED_TERMINAL_STATES.has(record.state)
      && record.mode === "capture"
      && record.synthesizedText !== undefined
      && nowMs - Date.parse(record.updatedAt) <= policy.capturedTextMaxAgeMs)
    .sort(newestFirst)
    .slice(0, policy.capturedTextMaxRecords);
  const retainedCaptureText = new Set(captures.map((record) => record.continuationId));

  for (const record of records.values()) {
    if (ORIGIN_CONTEXT_SCRUB_STATES.has(record.state) && record.originContextRef !== undefined) {
      record.originContextDigest ??= record.originContextRef.digest;
      record.originContextMessageCount ??= record.originContextRef.messageCount;
      delete record.originContextRef;
      record.originContextState = "scrubbed";
    }
    if (!SETTLED_TERMINAL_STATES.has(record.state)) continue;
    if (record.resultPayload !== undefined) delete record.resultPayload;
    if (record.synthesizedText !== undefined && !retainedCaptureText.has(record.continuationId)) {
      delete record.synthesizedText;
    }
    record.compactedAt ??= now.toISOString();
  }

  const retainedTerminalIds = new Set([...records.values()]
    .filter((record) => SETTLED_TERMINAL_STATES.has(record.state)
      && nowMs - Date.parse(record.updatedAt) <= policy.terminalMaxAgeMs)
    .sort(newestFirst)
    .slice(0, policy.terminalMaxRecords)
    .map((record) => record.continuationId));
  for (const [id, record] of records) {
    if (SETTLED_TERMINAL_STATES.has(record.state) && !retainedTerminalIds.has(id)) records.delete(id);
  }
  for (const record of records.values()) {
    assertRecordFitsV3(record, "Continuation retained record");
  }
}

function newestFirst(left: DurableContinuationRecord, right: DurableContinuationRecord): number {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  return byUpdatedAt === 0 ? right.continuationId.localeCompare(left.continuationId) : byUpdatedAt;
}

export function continuationStoreStats(
  records: Map<string, DurableContinuationRecord>,
  policy: ResolvedContinuationRetention,
): ContinuationStoreStats {
  const values = [...records.values()];
  return {
    format: "per-record-v3",
    records: values.length,
    active: values.filter(
      (record) => !SETTLED_TERMINAL_STATES.has(record.state) && record.state !== "delivery_unknown",
    ).length,
    unresolvedDelivery: values.filter((record) => record.state === "delivery_unknown").length,
    deadLettered: values.filter((record) => record.state === "dead_lettered").length,
    terminalTombstones: values.filter((record) => SETTLED_TERMINAL_STATES.has(record.state)).length,
    compacted: values.filter((record) => record.compactedAt !== undefined).length,
    capturedText: values.filter(
      (record) => record.mode === "capture" && record.synthesizedText !== undefined,
    ).length,
    historyDegraded: values.filter((record) => record.receipt?.historyRecorded === false).length,
    limits: { ...policy },
  };
}

export function cloneRecords(
  records: Map<string, DurableContinuationRecord>,
): Map<string, DurableContinuationRecord> {
  return new Map([...records].map(([id, record]) => [id, structuredClone(record)]));
}

export function replaceRecords(
  target: Map<string, DurableContinuationRecord>,
  source: Map<string, DurableContinuationRecord>,
): void {
  target.clear();
  for (const [id, record] of source) target.set(id, structuredClone(record));
}

export function isRecordTransaction(
  value: unknown,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): value is ContinuationRecordTransaction {
  if (!isObject(value)
    || value.schemaVersion !== expectedSchemaVersion
    || !isDurableGeneration(value.generation)
    || !requiredDate(value.createdAt)
    || !Array.isArray(value.writes)
    || !Array.isArray(value.deletes)) return false;
  const writesValid = value.writes.every((record) => isObject(record)
      && requiredString(record.continuationId)
      && isRecord(record, record.continuationId));
  if (!writesValid || !value.deletes.every(requiredString)) return false;
  const writeIds = value.writes.map((record) => (record as DurableContinuationRecord).continuationId);
  const deleteIds = value.deletes as string[];
  return new Set(writeIds).size === writeIds.length
    && new Set(deleteIds).size === deleteIds.length
    && !deleteIds.some((id) => writeIds.includes(id));
}

export function isStoreFile(value: unknown): value is ContinuationStoreFile {
  if (!isObject(value) || value.schemaVersion !== CONTINUATION_STORE_SCHEMA_VERSION || !isObject(value.records)) {
    return false;
  }
  return Object.entries(value.records).every(([id, record]) => id.length > 0 && isRecord(record, id));
}

export function normalizeLegacyContinuationRecords(records: Map<string, DurableContinuationRecord>): void {
  for (const record of records.values()) {
    if (record.originContextState === undefined) {
      record.originContextState = record.historyBoundary === undefined
        ? "detached_latest"
        : "legacy_missing";
    }
    if (record.synthesisDeferrals === undefined) record.synthesisDeferrals = 0;
    assertRecordFitsV3(record, "Continuation normalized record");
  }
}

export function assertRecordFitsV3(
  record: DurableContinuationRecord,
  label = "Continuation record",
): void {
  const bytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (bytes > MAX_RECORD_BYTES) {
    throw new Error(`${label} exceeds its ${String(MAX_RECORD_BYTES)} byte safety limit: ${record.continuationId}`);
  }
}

export function isRecord(value: unknown, id: string): value is DurableContinuationRecord {
  if (!isObject(value)) return false;
  return value.continuationId === id
    && requiredString(value.serverName)
    && requiredString(value.originRunId)
    && requiredString(value.originConversationId)
    && optionalString(value.replyToConversationId)
    && optionalString(value.historyBoundary)
    && (value.originContextState === undefined || isOriginContextState(value.originContextState))
    && (value.originContextRef === undefined || isOriginContextReference(value.originContextRef))
    && (value.originContextDigest === undefined || isSha256(value.originContextDigest))
    && (value.originContextMessageCount === undefined
      || (Number.isSafeInteger(value.originContextMessageCount)
        && Number(value.originContextMessageCount) >= 0
        && Number(value.originContextMessageCount) <= MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES))
    && (value.originContextFingerprint === undefined || isSha256(value.originContextFingerprint))
    && (value.originContextBindingMac === undefined || isSha256(value.originContextBindingMac))
    && (value.completionKind === undefined
      || value.completionKind === "synthesized"
      || value.completionKind === "origin_context_unavailable")
    && isContinuationMode(value.mode)
    && optionalString(value.routeName)
    && requiredString(value.taskKey)
    && requiredString(value.taskHash)
    && requiredString(value.claimFingerprint)
    && /^[a-f0-9]{64}$/u.test(String(value.resultTokenHash))
    && requiredDate(value.createdAt)
    && requiredDate(value.updatedAt)
    && requiredDate(value.deadline)
    && isContinuationState(value.state)
    && Number.isInteger(value.synthesisAttempts)
    && Number(value.synthesisAttempts) >= 0
    && (value.synthesisDeferrals === undefined
      || (Number.isSafeInteger(value.synthesisDeferrals) && Number(value.synthesisDeferrals) >= 0))
    && Number.isInteger(value.deliveryAttempts)
    && Number(value.deliveryAttempts) >= 0
    && optionalString(value.resultIdempotencyKey)
    && optionalString(value.resultPayloadHash)
    && optionalDate(value.synthesisStartedAt)
    && optionalString(value.synthesizedText)
    && (value.actionable === undefined || typeof value.actionable === "boolean")
    && optionalDate(value.deliveryStartedAt)
    && optionalDate(value.nextAttemptAt)
    && optionalString(value.leaseOwner)
    && optionalDate(value.leaseUntil)
    && optionalDate(value.compactedAt)
    && (value.lastError === undefined || isLastError(value.lastError))
    && (value.receipt === undefined || isReceipt(value.receipt));
}

export function isOriginContextState(value: unknown): value is ContinuationOriginContextState {
  return value === "pending"
    || value === "pinned"
    || value === "abandoned"
    || value === "detached_latest"
    || value === "legacy_missing"
    || value === "scrubbed";
}

export function isOriginContextReference(value: unknown): value is ContinuationOriginContextReference {
  return isObject(value)
    && value.schemaVersion === 1
    && isSha256(value.digest)
    && Number.isSafeInteger(value.bytes)
    && Number(value.bytes) > 0
    && Number(value.bytes) <= MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES
    && Number.isSafeInteger(value.messageCount)
    && Number(value.messageCount) >= 2
    && Number(value.messageCount) <= MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES;
}

export function isOriginContextGroupCommit(value: unknown): value is ContinuationOriginContextGroupCommit {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || !isSha256(value.groupKey)
    || !requiredString(value.originRunId)
    || !requiredString(value.originConversationId)
    || !requiredString(value.historyBoundary)
    || !isSha256(value.snapshotDigest)
    || !Number.isSafeInteger(value.memberCount)
    || Number(value.memberCount) < 1
    || !isSha256(value.memberSetDigest)
    || !requiredDate(value.activatedAt)) return false;
  const expectedKey = continuationDigest(
    `mono-agent-origin-context-group-v1\0${canonicalContinuationJson({
      originRunId: value.originRunId,
      originConversationId: value.originConversationId,
      historyBoundary: value.historyBoundary,
    })}`,
  );
  return value.groupKey === expectedKey;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isLastError(value: unknown): boolean {
  return isObject(value) && requiredString(value.code) && requiredString(value.reason) && requiredDate(value.at);
}

function isReceipt(value: unknown): boolean {
  if (!isObject(value)
    || (value.kind !== "delivered"
      && value.kind !== "suppressed"
      && value.kind !== "captured"
      && value.kind !== "silent")) {
    return false;
  }
  return requiredDate(value.deliveredAt)
    && optionalString(value.deliveryId)
    && optionalString(value.channelId)
    && (value.historyRecorded === undefined || typeof value.historyRecorded === "boolean")
    && (value.historyErrorCode === undefined
      || (typeof value.historyErrorCode === "string"
        && value.historyErrorCode.length > 0
        && value.historyErrorCode.length <= 128))
    && (value.historyErrorCode === undefined || value.historyRecorded === false)
    && (value.kind === "delivered" || (value.historyRecorded === undefined && value.historyErrorCode === undefined));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isDurableGeneration(value: unknown): value is string {
  return requiredString(value) && Buffer.byteLength(value, "utf8") <= MAX_GENERATION_BYTES;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function requiredDate(value: unknown): value is string {
  return requiredString(value) && Number.isFinite(Date.parse(value));
}

function optionalDate(value: unknown): boolean {
  return value === undefined || requiredDate(value);
}

export function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

export function cloneRecord(
  record: DurableContinuationRecord | undefined,
): DurableContinuationRecord | undefined {
  return record === undefined ? undefined : structuredClone(record);
}
