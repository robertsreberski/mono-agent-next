import { createHash } from "node:crypto";

import type { JsonObject, JsonValue, MemoryRecord } from "@mono-agent/module-sdk";

import { MemoryLocalError } from "./errors.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LEGACY_STORED_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;

export interface ValidatedMemoryRecord {
  readonly record: MemoryRecord;
  readonly metadataJson: string;
  readonly normalizedText: string;
  readonly contentHash: string;
  readonly byteSize: number;
}

export interface MemoryRecordLimits {
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly maxTextBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxRecallResults: number;
}

export function validateMemoryRecord(
  input: MemoryRecord,
  limits: MemoryRecordLimits,
): ValidatedMemoryRecord {
  const record = reconstructMemoryRecord(input, limits);
  const metadataJson = canonicalJson(record.metadata ?? {});
  const normalizedText = normalizeLexical(record.text);
  const canonical = canonicalJson(record as unknown as JsonValue);
  return Object.freeze({
    record,
    metadataJson,
    normalizedText,
    contentHash: createHash("sha256").update(canonical).digest("hex"),
    byteSize: Buffer.byteLength(canonical, "utf8"),
  });
}

export function reconstructMemoryRecord(
  input: MemoryRecord,
  limits: MemoryRecordLimits,
): MemoryRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid("record must be an object");
  if (typeof input.id !== "string" || !IDENTIFIER.test(input.id)) invalid("record.id has an invalid identifier");
  if (typeof input.text !== "string" || input.text.length === 0) invalid("record.text must not be empty");
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (textBytes > limits.maxTextBytes) invalid(`record.text exceeds ${limits.maxTextBytes} bytes`);
  if (typeof input.createdAt !== "string"
    || !CANONICAL_TIMESTAMP.test(input.createdAt)
    || !Number.isFinite(Date.parse(input.createdAt))
    || new Date(input.createdAt).toISOString() !== input.createdAt) {
    invalid("record.createdAt must be a canonical UTC timestamp");
  }
  const metadata = input.metadata === undefined ? undefined : validateJsonObject(input.metadata, "record.metadata");
  if (jsonByteSize(metadata ?? {}) > limits.maxMetadataBytes) {
    invalid(`record.metadata exceeds ${limits.maxMetadataBytes} bytes`);
  }
  return Object.freeze({
    id: input.id,
    text: input.text,
    createdAt: input.createdAt,
    ...(metadata === undefined ? {} : { metadata: Object.freeze(metadata) }),
  });
}

export function normalizeLexical(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export function canonicalStoredMemoryTimestamp(value: string): string {
  // v0-final admitted timezone-bearing ISO timestamps that were not always in
  // toISOString() form. Adoption keeps those bytes unchanged and normalizes
  // only the public v1 projection.
  const match = LEGACY_STORED_TIMESTAMP.exec(value);
  if (match === null) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return value;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, JsonValue>>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, sortJson(object[key]!)]),
    ) as JsonObject;
  }
  return value;
}

function validateJsonObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object`);
  return validateJsonValue(value, path, 0) as JsonObject;
}

function validateJsonValue(value: unknown, path: string, depth: number): JsonValue {
  if (depth > 20) invalid(`${path} exceeds 20 levels`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => validateJsonValue(item, `${path}[${index}]`, depth + 1));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must contain only plain JSON objects`);
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") invalid(`${path} contains unsafe key ${key}`);
      output[key] = validateJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    }
    return output;
  }
  invalid(`${path} contains a non-JSON value`);
}

function jsonByteSize(value: JsonValue): number {
  if (Array.isArray(value)) {
    return 2 + Math.max(0, value.length - 1)
      + value.reduce((total, item) => total + jsonByteSize(item), 0);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return 2 + Math.max(0, entries.length - 1) + entries.reduce(
      (total, [key, item]) =>
        total + Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + jsonByteSize(item),
      0,
    );
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function invalid(message: string): never {
  throw new MemoryLocalError("invalid_record", message);
}
