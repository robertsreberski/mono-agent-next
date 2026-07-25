// SPDX-License-Identifier: MIT
import type { JsonObject, JsonValue } from "@mono-agent/module-sdk";
import {
  assertOwnKeys, denseOwnDataArray as boundedOwnDataArray,
  ownDataRecord as boundedOwnDataRecord,
} from "./bounded-value.js";
export function ownDataRecord(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  const output = boundedOwnDataRecord(value, path);
  assertOwnKeys(output, allowed, path);
  return output;
}
export function denseOwnDataArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  return boundedOwnDataArray(value, path, maximum);
}
export function toPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "";
  return `/${path.map((entry) => String(entry).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
export function toJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  const converted = toJsonValue(value);
  return isRecord(converted) ? (converted as JsonObject) : undefined;
}
export function toJsonValue(value: unknown, seen = new Set<object>(), depth = 0): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 32) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen, depth + 1));
  if (isRecord(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of Object.entries(value)) output[key] = toJsonValue(entry, seen, depth + 1);
    seen.delete(value);
    return output;
  }
  return String(value);
}
export function turnBinaryData(value: Uint8Array | string, label: string): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) {
    throw new TypeError(`${label} must contain canonical base64 data`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0
    || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  ) {
    throw new TypeError(`${label} must contain canonical base64 data`);
  }
  return new Uint8Array(decoded);
}
export function encodePersistedValue(value: unknown): Uint8Array {
  const source = JSON.stringify(value, (_key, entry: unknown) => entry instanceof Uint8Array
    ? { $monoAgentBytes: Buffer.from(entry).toString("base64") }
    : entry);
  return new TextEncoder().encode(source);
}
export function decodePersistedJson(value: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value), (_key, entry: unknown) => {
      if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.$monoAgentBytes === "string") {
        return new Uint8Array(Buffer.from(entry.$monoAgentBytes, "base64"));
      }
      return entry;
    }) as unknown;
  } catch (error) {
    throw new Error(`${label} is corrupt`, { cause: error });
  }
}
export function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
export function assertBoundedText(value: string, name: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw new RangeError(`${name} exceeds ${maxBytes} bytes`);
}
export function assertRouteText(value: string, name: string, maxBytes: number): void {
  assertBoundedText(value, name, maxBytes);
  if (value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty trimmed string without control characters`);
  }
}
export function routeText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be string`);
  assertRouteText(value, name, maxBytes);
  return value;
}
export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}
export function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 64 || typeof value !== "object" || value === null || value instanceof Uint8Array) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen, depth + 1))
    : Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
  seen.delete(value);
  return valid;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return expected.size === right.length
    && left.every((value) => expected.has(value));
}
export function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}
export function referencedEnvironmentValues(
  roots: readonly unknown[],
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const names = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    if (typeof value.$env === "string") names.add(value.$env);
    pending.push(...Object.values(value));
  }
  return Object.freeze(
    [...names]
      .map((name) => environment[name])
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort((left, right) => right.length - left.length || left.localeCompare(right)),
  );
}
