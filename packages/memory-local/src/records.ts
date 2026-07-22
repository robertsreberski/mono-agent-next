import { createHash } from "node:crypto";

import type { JsonObject, JsonValue, MemoryRecord } from "@mono-agent/module-sdk";

import type { MemoryLocalLimitsConfig } from "./config.js";
import { MemoryLocalError } from "./errors.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface ValidatedMemoryRecord {
  readonly record: MemoryRecord;
  readonly metadataJson: string;
  readonly normalizedText: string;
  readonly contentHash: string;
  readonly byteSize: number;
}

export function validateMemoryRecord(
  input: MemoryRecord,
  limits: MemoryLocalLimitsConfig,
): ValidatedMemoryRecord {
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
  const metadataJson = canonicalJson(metadata ?? {});
  if (Buffer.byteLength(metadataJson, "utf8") > limits.maxMetadataBytes) {
    invalid(`record.metadata exceeds ${limits.maxMetadataBytes} bytes`);
  }
  const record: MemoryRecord = Object.freeze({
    id: input.id,
    text: input.text,
    createdAt: input.createdAt,
    ...(metadata === undefined ? {} : { metadata: Object.freeze(metadata) }),
  });
  const normalizedText = normalizeLexical(input.text);
  const canonical = canonicalJson(record as unknown as JsonValue);
  return Object.freeze({
    record,
    metadataJson,
    normalizedText,
    contentHash: createHash("sha256").update(canonical).digest("hex"),
    byteSize: Buffer.byteLength(canonical, "utf8"),
  });
}

export function normalizeLexical(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export function lexicalTerms(value: string): readonly string[] {
  const normalized = normalizeLexical(value);
  return Object.freeze([...new Set(normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [])]);
}

export function scoreLexical(
  normalizedText: string,
  query: string,
  terms: readonly string[],
  conversationMatches: boolean,
): number {
  let score = conversationMatches ? 25 : 0;
  if (normalizedText.includes(query)) score += 1_000;
  for (const term of terms) {
    let occurrences = 0;
    let offset = 0;
    while (occurrences < 20) {
      const found = normalizedText.indexOf(term, offset);
      if (found < 0) break;
      occurrences += 1;
      offset = found + Math.max(1, term.length);
    }
    score += occurrences * 10;
  }
  return score;
}

export function parseStoredMetadata(value: string): JsonObject | undefined {
  const parsed = JSON.parse(value) as unknown;
  const object = validateJsonObject(parsed, "stored metadata");
  return Object.keys(object).length === 0 ? undefined : object;
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

function invalid(message: string): never {
  throw new MemoryLocalError("invalid_record", message);
}
