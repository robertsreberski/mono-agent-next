import type {
  StatePresenceRecord,
  StateRecord,
} from "@mono-agent/module-sdk/internal";

import type { ResolvedStateLocalConfig } from "./config.js";
import { StateLocalError } from "./errors.js";

const SNAPSHOT_SCHEMA = "mono-agent.state-local.v1";
export const INTERNAL_STATE_PREFIX = "@mono-agent/internal/";
export const INTERNAL_PRESENCE_PREFIX = `${INTERNAL_STATE_PREFIX}presence/`;

export interface StoredRecord {
  readonly key: string;
  readonly value: Buffer;
  readonly version: string;
  readonly updatedAt: string;
}

export interface StateSnapshot {
  readonly generation: number;
  readonly listGeneration: number;
  readonly records: ReadonlyMap<string, StoredRecord>;
  readonly totalBytes: number;
}

interface DiskRecord {
  readonly key: string;
  readonly valueBase64: string;
  readonly version: string;
  readonly updatedAt: string;
}

interface DiskSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly generation: number;
  readonly listGeneration: number;
  readonly records: readonly DiskRecord[];
}

export function emptySnapshot(): StateSnapshot {
  return { generation: 0, listGeneration: 0, records: new Map(), totalBytes: 0 };
}

export function parseSnapshot(bytes: Uint8Array, limits: ResolvedStateLocalConfig): StateSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Local state is not valid JSON; refusing to overwrite it.",
      error,
    );
  }

  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["schema", "generation", "listGeneration", "records"])) {
    throw corrupt("Local state has an invalid top-level shape.");
  }
  if (value.schema !== SNAPSHOT_SCHEMA) {
    throw corrupt("Local state has an unsupported schema.");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw corrupt("Local state has an invalid generation.");
  }
  if (
    !Number.isSafeInteger(value.listGeneration) ||
    (value.listGeneration as number) < 0 ||
    (value.listGeneration as number) > (value.generation as number)
  ) {
    throw corrupt("Local state has an invalid list generation.");
  }
  if (!Array.isArray(value.records) || value.records.length > limits.maxRecords) {
    throw corrupt("Local state has an invalid or oversized record collection.");
  }

  const records = new Map<string, StoredRecord>();
  const versions = new Set<string>();
  let previousKey: string | undefined;
  let totalBytes = 0;
  for (const candidate of value.records) {
    if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, ["key", "valueBase64", "version", "updatedAt"])) {
      throw corrupt("Local state contains a malformed record.");
    }
    let key: string;
    try {
      key = validateStoredStateKey(candidate.key);
    } catch (error) {
      throw new StateLocalError("STATE_CORRUPT", "Local state contains an invalid record key.", error);
    }
    if (previousKey !== undefined && key <= previousKey) {
      throw corrupt("Local state records must be unique and sorted by key.");
    }
    previousKey = key;
    if (typeof candidate.valueBase64 !== "string") {
      throw corrupt(`Local state record ${key} has an invalid value.`);
    }
    const recordValue = Buffer.from(candidate.valueBase64, "base64");
    if (recordValue.toString("base64") !== candidate.valueBase64) {
      throw corrupt(`Local state record ${key} has non-canonical base64 data.`);
    }
    if (recordValue.byteLength > limits.maxRecordBytes) {
      throw corrupt(`Local state record ${key} exceeds maxRecordBytes.`);
    }
    totalBytes += recordValue.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw corrupt("Local state exceeds maxTotalBytes.");
    }
    const version = validateStoredVersion(candidate.version, value.generation as number);
    if (versions.has(version)) {
      throw corrupt("Local state contains duplicate record versions.");
    }
    versions.add(version);
    const updatedAt = validateCanonicalTimestamp(candidate.updatedAt, key);
    if (key.startsWith(INTERNAL_PRESENCE_PREFIX)) {
      decodePresenceRecord(recordValue, key);
    }
    records.set(key, { key, value: recordValue, version, updatedAt });
  }

  return {
    generation: value.generation as number,
    listGeneration: value.listGeneration as number,
    records,
    totalBytes,
  };
}

export function serializeSnapshot(snapshot: StateSnapshot): Buffer {
  const records: DiskRecord[] = [...snapshot.records.values()]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((record) => ({
      key: record.key,
      valueBase64: record.value.toString("base64"),
      version: record.version,
      updatedAt: record.updatedAt,
    }));
  const disk: DiskSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    generation: snapshot.generation,
    listGeneration: snapshot.listGeneration,
    records,
  };
  return Buffer.from(`${JSON.stringify(disk)}\n`, "utf8");
}

export function toStateRecord(record: StoredRecord): StateRecord {
  return {
    key: record.key,
    value: Uint8Array.from(record.value),
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

export function validateStateKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f\\]/u.test(value)
  ) {
    throw new StateLocalError("STATE_INVALID_KEY", "State keys must be bounded relative names.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new StateLocalError("STATE_INVALID_KEY", "State keys must not contain dot segments.");
  }
  if (value.startsWith(INTERNAL_STATE_PREFIX)) {
    throw new StateLocalError("STATE_INVALID_KEY", "State keys must not use the reserved internal namespace.");
  }
  return value;
}

export function validateStatePrefix(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f\\]/u.test(value)
  ) {
    throw new StateLocalError("STATE_INVALID_KEY", "State prefixes must be bounded relative names.");
  }
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new StateLocalError("STATE_INVALID_KEY", "State prefixes must not contain dot segments.");
  }
  return value;
}

export function validateExpectedVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^v[1-9][0-9]*$/u.test(value)) {
    throw new StateLocalError("STATE_VERSION_MISMATCH", "expectedVersion is not a valid state version.");
  }
  return value;
}

export function nextVersion(snapshot: StateSnapshot): { readonly generation: number; readonly version: string } {
  if (snapshot.generation >= Number.MAX_SAFE_INTEGER) {
    throw new StateLocalError("STATE_LIMIT_EXCEEDED", "The local state version counter is exhausted.");
  }
  const generation = snapshot.generation + 1;
  return { generation, version: `v${generation}` };
}

export function nextListGeneration(snapshot: StateSnapshot): number {
  if (snapshot.listGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new StateLocalError("STATE_LIMIT_EXCEEDED", "The local state list counter is exhausted.");
  }
  return snapshot.listGeneration + 1;
}

export function isInternalStateKey(key: string): boolean {
  return key.startsWith(INTERNAL_STATE_PREFIX);
}

export function presenceStorageKey(presenceId: string): string {
  const normalized = validatePresenceString(presenceId, "presenceId", 256);
  return `${INTERNAL_PRESENCE_PREFIX}${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

export function encodePresenceRecord(input: StatePresenceRecord): Buffer {
  const presence = normalizePresenceRecord(input);
  return Buffer.from(`${JSON.stringify(presence)}\n`, "utf8");
}

export function decodePresenceRecord(value: Uint8Array, key?: string): StatePresenceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError("STATE_CORRUPT", "Local state contains invalid presence JSON.", error);
  }
  let normalized: StatePresenceRecord;
  try {
    normalized = normalizePresenceRecord(parsed);
  } catch (error) {
    throw new StateLocalError("STATE_CORRUPT", "Local state contains an invalid presence record.", error);
  }
  if (key !== undefined && presenceStorageKey(normalized.presenceId) !== key) {
    throw corrupt("Local state presence key does not match its presenceId.");
  }
  return normalized;
}

export function normalizePresenceRecord(input: unknown): StatePresenceRecord {
  if (!isPlainRecord(input)) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence must be a plain object.");
  }
  const allowed = input.metadata === undefined
    ? ["agentId", "expiresAt", "instanceId", "presenceId", "updatedAt"]
    : ["agentId", "expiresAt", "instanceId", "metadata", "presenceId", "updatedAt"];
  if (!hasOnlyKeys(input, allowed)) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence contains unknown or missing fields.");
  }
  const presenceId = validatePresenceString(input.presenceId, "presenceId", 256);
  const agentId = validatePresenceString(input.agentId, "agentId", 256);
  const instanceId = validatePresenceString(input.instanceId, "instanceId", 256);
  const updatedAt = validatePresenceTimestamp(input.updatedAt, "updatedAt");
  const expiresAt = validatePresenceTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(updatedAt)) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence expiresAt must be later than updatedAt.");
  }
  const metadata = input.metadata;
  if (metadata !== undefined) {
    if (!isPlainRecord(metadata)) {
      throw new StateLocalError("STATE_INVALID_CONFIG", "Presence metadata must be a plain JSON object.");
    }
    validatePresenceJson(metadata, 0);
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
    if (metadataBytes > 64 * 1024) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Presence metadata exceeds 64 KiB.");
    }
  }
  const clonedMetadata = metadata === undefined
    ? undefined
    : JSON.parse(JSON.stringify(metadata)) as StatePresenceRecord["metadata"];
  return {
    presenceId,
    agentId,
    instanceId,
    updatedAt,
    expiresAt,
    ...(clonedMetadata === undefined ? {} : { metadata: clonedMetadata }),
  };
}

function validateStoredVersion(value: unknown, generation: number): string {
  if (typeof value !== "string" || !/^v[1-9][0-9]*$/u.test(value)) {
    throw corrupt("Local state contains an invalid record version.");
  }
  const numeric = Number(value.slice(1));
  if (!Number.isSafeInteger(numeric) || numeric > generation) {
    throw corrupt("Local state contains a record version beyond its generation.");
  }
  return value;
}

function validateStoredStateKey(value: unknown): string {
  if (typeof value === "string" && value.startsWith(INTERNAL_PRESENCE_PREFIX)) {
    const suffix = value.slice(INTERNAL_PRESENCE_PREFIX.length);
    if (suffix.length === 0 || suffix.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(suffix)) {
      throw new StateLocalError("STATE_INVALID_KEY", "Internal presence key is invalid.");
    }
    return value;
  }
  if (typeof value === "string" && value.startsWith(INTERNAL_STATE_PREFIX)) {
    throw new StateLocalError("STATE_INVALID_KEY", "Internal state namespace is invalid.");
  }
  return validateStateKey(value);
}

function validatePresenceString(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `Presence ${field} must be a bounded printable string.`);
  }
  return value;
}

function validatePresenceTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new StateLocalError("STATE_INVALID_CONFIG", `Presence ${field} must be a canonical timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `Presence ${field} must be a canonical timestamp.`);
  }
  return value;
}

function validatePresenceJson(value: unknown, depth: number): void {
  if (depth > 16) {
    throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Presence metadata exceeds the nesting limit.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StateLocalError("STATE_INVALID_CONFIG", "Presence metadata must use finite numbers.");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const nested of value) validatePresenceJson(nested, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence metadata must contain only JSON values.");
  }
  for (const nested of Object.values(value)) validatePresenceJson(nested, depth + 1);
}

function validateCanonicalTimestamp(value: unknown, key: string): string {
  if (typeof value !== "string") {
    throw corrupt(`Local state record ${key} has an invalid timestamp.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw corrupt(`Local state record ${key} has a non-canonical timestamp.`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function corrupt(message: string): StateLocalError {
  return new StateLocalError("STATE_CORRUPT", message);
}
