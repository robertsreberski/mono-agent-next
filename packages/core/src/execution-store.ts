import { createHash } from "node:crypto";

import { parseArtifactRef, type ArtifactRef } from "@mono-agent/module-sdk";
import type {
  StateRecord,
  StateStore,
  StateTransactionConflict,
} from "@mono-agent/module-sdk/internal";

const EXECUTION_RECORD_MAX_BYTES = 1024 * 1024;
const EXECUTION_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const EXECUTION_TRANSACTION_MAX_MUTATIONS = 1_000;
const EXECUTION_SCAN_MAX_LIMIT = 1_000;
const EXECUTION_RECORD_MAX_ITEMS = 100_000;
const EXECUTION_RECORD_MAX_DEPTH = 64;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export const EXECUTION_STATE_PREFIXES = Object.freeze({
  conversations: "core/conversations/",
  sessions: "core/sessions/",
  admissions: "core/admissions/",
  artifactIntents: "core/artifact-intents/",
  runs: "core/runs/",
  runHistory: "core/runs/history/",
  runEvents: "core/runs/events/",
  deliveries: "core/deliveries/",
} as const);

export interface ExecutionArtifactDescriptor {
  readonly sha256: `sha256:${string}`;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly fileName?: string;
}

export interface ExecutionRecord<T> {
  readonly key: string;
  readonly value: T;
  readonly version: string;
  readonly updatedAt: string;
}

export interface ExecutionPut<T> {
  readonly key: string;
  readonly expectedVersion: string | null;
  readonly value: T;
}

export interface ExecutionDelete {
  readonly key: string;
  readonly expectedVersion: string | null;
}

export interface ExecutionTransaction {
  readonly checks?: readonly {
    readonly key: string;
    readonly expectedVersion: string | null;
  }[];
  readonly puts?: readonly ExecutionPut<unknown>[];
  readonly deletes?: readonly ExecutionDelete[];
  readonly signal: AbortSignal;
}

export type ExecutionTransactionResult =
  | {
      readonly status: "applied";
      readonly records: readonly StateRecord[];
      readonly deletedKeys: readonly string[];
    }
  | {
      readonly status: "conflict";
      readonly conflicts: readonly StateTransactionConflict[];
    };

export interface ExecutionScanResult<T> {
  readonly records: readonly ExecutionRecord<T>[];
  readonly cursor?: string;
}

export type ExecutionRecordParser<T> = (value: unknown) => T;

export class ExecutionStore {
  readonly #state: StateStore;

  constructor(state: StateStore) {
    this.#state = state;
  }

  async read<T>(
    key: string,
    parser: ExecutionRecordParser<T>,
    signal: AbortSignal,
  ): Promise<ExecutionRecord<T> | undefined> {
    const record = await this.#state.read({ key, signal });
    return record === undefined ? undefined : decodeRecord(record, parser);
  }

  async scan<T>(
    prefix: string,
    cursor: string | undefined,
    limit: number,
    parser: ExecutionRecordParser<T>,
    signal: AbortSignal,
  ): Promise<ExecutionScanResult<T>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_SCAN_MAX_LIMIT) {
      throw new RangeError(`execution scan limit must be from 1 through ${String(EXECUTION_SCAN_MAX_LIMIT)}`);
    }
    const result = await this.#state.scan({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
      limit,
      signal,
    });
    return Object.freeze({
      records: Object.freeze(result.records.map((record) => decodeRecord(record, parser))),
      ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
    });
  }

  async transaction(
    request: ExecutionTransaction,
  ): Promise<ExecutionTransactionResult> {
    const checks = request.checks ?? [];
    const puts = request.puts ?? [];
    const deletes = request.deletes ?? [];
    if (checks.length + puts.length + deletes.length > EXECUTION_TRANSACTION_MAX_MUTATIONS) {
      throw new RangeError("execution transaction exceeds its mutation limit");
    }
    const result = await this.#state.transaction({
      checks: checks.map((check) => ({
        key: check.key,
        expectedVersion: check.expectedVersion,
      })),
      puts: puts.map((put) => ({
        key: put.key,
        expectedVersion: put.expectedVersion,
        value: encodeExecutionRecord(put.value),
      })),
      deletes: deletes.map((entry) => ({
        key: entry.key,
        expectedVersion: entry.expectedVersion,
      })),
      signal: request.signal,
    });
    if (result.status === "conflict") {
      return Object.freeze({
        status: "conflict",
        conflicts: Object.freeze(result.conflicts.map((conflict) =>
          Object.freeze({
            key: conflict.key,
            ...(conflict.currentVersion === undefined
              ? {}
              : { currentVersion: conflict.currentVersion }),
          }))),
      });
    }
    return Object.freeze({
      status: "applied",
      records: Object.freeze(result.records.map(copyStateRecord)),
      deletedKeys: Object.freeze([...result.deletedKeys]),
    });
  }

  async putArtifact(
    data: Uint8Array,
    mediaType: string,
    fileName: string | undefined,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    if (this.#state.putArtifact === undefined) {
      throw new Error("selected state module does not provide the artifact capability");
    }
    const expected = describeExecutionArtifact(data, mediaType, fileName);
    const ref = await this.#state.putArtifact({
      data: new Uint8Array(data),
      mediaType: expected.mediaType,
      ...(expected.fileName === undefined ? {} : { fileName: expected.fileName }),
      signal,
    });
    const parsed = parseArtifactRef(ref);
    if (
      parsed.sha256 !== expected.sha256
      || parsed.sizeBytes !== expected.sizeBytes
      || parsed.mediaType !== expected.mediaType
      || parsed.fileName !== expected.fileName
    ) {
      throw new Error("state artifact publication returned mismatched content authority");
    }
    return parsed;
  }

  async readArtifact(
    ref: ArtifactRef,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.#state.readArtifact === undefined) {
      throw new Error("selected state module does not provide the artifact capability");
    }
    const expected = parseArtifactRef(ref);
    if (expected.sizeBytes > EXECUTION_ARTIFACT_MAX_BYTES) {
      throw new RangeError("execution artifact exceeds its byte limit");
    }
    const data = await this.#state.readArtifact({
      ref: expected,
      maxBytes: EXECUTION_ARTIFACT_MAX_BYTES,
      signal,
    });
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("state artifact read did not return bytes");
    }
    const copy = new Uint8Array(data);
    const sha256 = `sha256:${createHash("sha256").update(copy).digest("hex")}`;
    if (copy.byteLength !== expected.sizeBytes || sha256 !== expected.sha256) {
      throw new Error("state artifact read returned mismatched content authority");
    }
    return copy;
  }

  /**
   * Request deletion through the selected state module without claiming more
   * than that module can prove. Content-addressed stores may return `false`
   * while references are shared or reference accounting is unavailable.
   */
  async deleteArtifact(
    ref: ArtifactRef,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.#state.deleteArtifact === undefined) return false;
    const deleted = await this.#state.deleteArtifact({
      ref: parseArtifactRef(ref),
      signal,
    });
    if (typeof deleted !== "boolean") {
      throw new TypeError("state artifact deletion did not return a boolean");
    }
    return deleted;
  }
}

export function conversationStateKey(conversationId: string): string {
  return `${EXECUTION_STATE_PREFIXES.conversations}${identityDigest(conversationId, "conversationId")}`;
}

export function admissionStateKey(requestId: string): string {
  return `${EXECUTION_STATE_PREFIXES.admissions}${identityDigest(requestId, "requestId")}`;
}

export function artifactIntentStateKey(runId: string): string {
  return `${EXECUTION_STATE_PREFIXES.artifactIntents}${identityDigest(runId, "runId")}`;
}

export function sessionStateKey(
  conversationId: string,
  runtimeInstanceId: string,
  model: string,
): string {
  const conversation = identityDigest(conversationId, "conversationId");
  const runtime = identityDigest(runtimeInstanceId, "runtimeInstanceId");
  const selectedModel = identityDigest(model, "model");
  const route = createHash("sha256")
    .update(runtime, "ascii")
    .update(selectedModel, "ascii")
    .digest("hex");
  return `${EXECUTION_STATE_PREFIXES.sessions}${conversation}/${route}`;
}

export function runStateKey(runId: string): string {
  return `${EXECUTION_STATE_PREFIXES.runs}records/${identityDigest(runId, "runId")}`;
}

export function runEventPrefix(runId: string): string {
  return `${EXECUTION_STATE_PREFIXES.runEvents}${identityDigest(runId, "runId")}/`;
}

export function runEventStateKey(runId: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999_999) {
    throw new RangeError("run event sequence is outside its bound");
  }
  return `${runEventPrefix(runId)}${String(sequence).padStart(9, "0")}`;
}

export function runHistoryStateKey(startedAt: string, runId: string): string {
  const milliseconds = canonicalTimestampMilliseconds(startedAt, "startedAt");
  const reverse = String(MAX_DATE_MILLISECONDS - milliseconds).padStart(16, "0");
  return `${EXECUTION_STATE_PREFIXES.runHistory}${reverse}/${identityDigest(runId, "runId")}`;
}

export function deliveryStateKey(idempotencyKey: string): string {
  return `${EXECUTION_STATE_PREFIXES.deliveries}${identityDigest(idempotencyKey, "idempotencyKey")}`;
}

export function describeExecutionArtifact(
  data: Uint8Array,
  mediaType: string,
  fileName?: string,
): ExecutionArtifactDescriptor {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("execution artifact must be bytes");
  }
  if (data.byteLength > EXECUTION_ARTIFACT_MAX_BYTES) {
    throw new RangeError("execution artifact exceeds its byte limit");
  }
  const sha256 = `sha256:${createHash("sha256").update(data).digest("hex")}` as const;
  const parsed = parseArtifactRef({
    id: `artifact:${sha256}`,
    sha256,
    sizeBytes: data.byteLength,
    mediaType,
    ...(fileName === undefined ? {} : { fileName }),
  });
  return Object.freeze({
    sha256: parsed.sha256,
    sizeBytes: parsed.sizeBytes,
    mediaType: parsed.mediaType,
    ...(parsed.fileName === undefined ? {} : { fileName: parsed.fileName }),
  });
}

export function encodeExecutionRecord(value: unknown): Uint8Array {
  const snapshot = snapshotExecutionJson(
    value,
    "$",
    { active: new Set<object>(), items: 0 },
    0,
  );
  const encoded = JSON.stringify(snapshot);
  if (encoded === undefined) throw new TypeError("execution record is not JSON serializable");
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.byteLength > EXECUTION_RECORD_MAX_BYTES) {
    throw new RangeError(`execution record exceeds ${String(EXECUTION_RECORD_MAX_BYTES)} bytes`);
  }
  return new Uint8Array(bytes);
}

function snapshotExecutionJson(
  value: unknown,
  path: string,
  state: { readonly active: Set<object>; items: number },
  depth: number,
): unknown {
  state.items += 1;
  if (state.items > EXECUTION_RECORD_MAX_ITEMS) {
    throw new RangeError("execution record exceeds its item limit");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (
    depth >= EXECUTION_RECORD_MAX_DEPTH
    || typeof value !== "object"
    || value === null
    || value instanceof Uint8Array
  ) {
    throw new TypeError(`${path} must contain only bounded JSON values`);
  }
  if (state.active.has(value)) throw new TypeError(`${path} must not contain cycles`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (!Number.isSafeInteger(value.length) || value.length > EXECUTION_RECORD_MAX_ITEMS) {
        throw new RangeError(`${path} exceeds its array limit`);
      }
      const allowed = new Set(["length"]);
      for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.has(key)) {
          throw new TypeError(`${path} contains an unknown array field`);
        }
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError(`${path}.${String(index)} must be an own data property`);
        }
        output.push(snapshotExecutionJson(
          descriptor.value,
          `${path}.${String(index)}`,
          state,
          depth + 1,
        ));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > EXECUTION_RECORD_MAX_ITEMS) {
      throw new RangeError(`${path} exceeds its property limit`);
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of [...keys].sort((left, right) => String(left).localeCompare(String(right)))) {
      if (typeof key !== "string") throw new TypeError(`${path} must not contain symbols`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an own data property`);
      }
      output[key] = snapshotExecutionJson(
        descriptor.value,
        `${path}.${key}`,
        state,
        depth + 1,
      );
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

export function decodeExecutionRecord(value: Uint8Array): unknown {
  if (!(value instanceof Uint8Array)) throw new TypeError("execution record must be bytes");
  if (value.byteLength > EXECUTION_RECORD_MAX_BYTES) {
    throw new RangeError(`execution record exceeds ${String(EXECUTION_RECORD_MAX_BYTES)} bytes`);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as unknown;
  } catch (error) {
    throw new TypeError("execution record is not valid UTF-8 JSON", { cause: error });
  }
}

function decodeRecord<T>(
  record: StateRecord,
  parser: ExecutionRecordParser<T>,
): ExecutionRecord<T> {
  // Parsing happens after a read-only state operation. Unsupported or corrupt
  // schemas therefore fail closed without rewriting or deleting operator data.
  const value = parser(decodeExecutionRecord(record.value));
  return Object.freeze({
    key: record.key,
    value,
    version: record.version,
    updatedAt: record.updatedAt,
  });
}

function copyStateRecord(record: StateRecord): StateRecord {
  return Object.freeze({
    key: record.key,
    value: new Uint8Array(record.value),
    version: record.version,
    updatedAt: record.updatedAt,
  });
}

function identityDigest(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalTimestampMilliseconds(value: string, label: string): number {
  if (typeof value !== "string" || value.length !== 24) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || milliseconds < -MAX_DATE_MILLISECONDS
    || milliseconds > MAX_DATE_MILLISECONDS
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return milliseconds;
}
