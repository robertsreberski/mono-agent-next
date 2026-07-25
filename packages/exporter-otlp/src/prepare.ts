// SPDX-License-Identifier: MIT
import type { JsonObject, JsonValue } from "@mono-agent/module-sdk";
import type { ExportRecord } from "@mono-agent/module-sdk/internal";

const MAX_RECORD_NODES = 10_000;

// Intentionally closed and high confidence. Every expression requires a
// credential-specific prefix, length, and alphabet; prefix mentions in prose
// do not match. Quantifiers are bounded to keep scanning time predictable.
const CONTENT_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{48}\b/gu,
  /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{47,511}[A-Za-z0-9]\b/gu,
  /\bghp_[A-Za-z0-9]{36}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{19,511}[A-Za-z0-9]\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
  /\bxapp-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
] as const;

export interface PreparedRecord {
  readonly record: ExportRecord;
  readonly bytes: number;
  readonly redactedValues: number;
}

export function prepareRecord(
  record: ExportRecord,
  includeSensitiveData: boolean,
  contentPatternRedaction: boolean,
  maxRecordBytes: number,
): PreparedRecord | undefined {
  if (
    typeof record !== "object"
    || record === null
    || typeof record.name !== "string"
    || record.name.trim().length === 0
    || record.name.length > 512
    || /[\u0000-\u001f\u007f]/u.test(record.name)
    || !isCanonicalTimestamp(record.timestamp)
    || !isPlainObject(record.attributes)
    || !Object.keys(record.attributes).every((key) =>
      key.length > 0
      && key.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(key))
  ) {
    return undefined;
  }
  try {
    const state: CloneState = {
      remainingNodes: MAX_RECORD_NODES,
      remainingBytes: maxRecordBytes,
      redactedValues: 0,
      contentPatternRedaction,
    };
    consumeBytes(state, Buffer.byteLength(record.name, "utf8"));
    const cloned: ExportRecord = {
      name: redactString(record.name, state),
      timestamp: record.timestamp,
      attributes: cloneJson(record.attributes, state, 0) as JsonObject,
      ...(includeSensitiveData && record.body !== undefined
        ? { body: cloneJson(record.body, state, 0) }
        : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
    return { record: cloned, bytes, redactedValues: state.redactedValues };
  } catch {
    return undefined;
  }
}

interface CloneState {
  remainingNodes: number;
  remainingBytes: number;
  redactedValues: number;
  readonly contentPatternRedaction: boolean;
}

function cloneJson(
  value: unknown,
  state: CloneState,
  depth: number,
): JsonValue {
  if (depth > 32) throw new Error("JSON nesting limit exceeded");
  if (state.remainingNodes <= 0) throw new Error("JSON node limit exceeded");
  state.remainingNodes -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    consumeBytes(state, Buffer.byteLength(value, "utf8"));
    return redactString(value, state);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((nested) => cloneJson(nested, state, depth + 1));
  }
  if (!isPlainObject(value)) throw new Error("JSON object must be plain");
  const output: Record<string, JsonValue> =
    Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    consumeBytes(state, Buffer.byteLength(key, "utf8"));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("JSON object must contain only data properties");
    }
    output[key] = cloneJson(descriptor.value, state, depth + 1);
  }
  return output;
}

function consumeBytes(state: CloneState, bytes: number): void {
  if (
    !Number.isSafeInteger(bytes)
    || bytes < 0
    || bytes > state.remainingBytes
  ) {
    throw new Error("JSON byte limit exceeded");
  }
  state.remainingBytes -= bytes;
}

function redactString(value: string, state: CloneState): string {
  if (!state.contentPatternRedaction) return value;
  let redacted = value;
  for (const pattern of CONTENT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      state.redactedValues += 1;
      return "[redacted]";
    });
  }
  return redacted;
}

function isPlainObject(value: unknown): value is JsonObject {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  const milliseconds = date.valueOf();
  return (
    Number.isFinite(milliseconds)
    && milliseconds >= 0
    && milliseconds <= 18_446_744_073_709
    && date.toISOString() === value
  );
}
