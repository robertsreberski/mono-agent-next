// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function boundedText(
  value: unknown,
  path: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${path} must be a bounded ${allowEmpty ? "" : "non-empty "}string`);
  }
  return value;
}

export function canonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length !== 24) {
    throw new TypeError(`${path} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${path} must be a canonical timestamp`);
  }
  return value;
}

export function ownDataRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

export function denseOwnDataArray(
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (!Number.isSafeInteger(value.length) || value.length > maximum) {
    throw new RangeError(`${path} exceeds its item limit`);
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
    output.push(descriptor.value);
  }
  return output;
}
