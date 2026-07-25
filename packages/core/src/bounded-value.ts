// SPDX-License-Identifier: MIT
import { isProxy } from "node:util/types";

import { cloneIntrinsicUint8Array } from "./binary.js";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface BoundedSnapshotOptions {
  readonly path: string;
  readonly label?: string;
  readonly byteLabel?: string;
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxDepth: number;
  readonly allowUndefined?: boolean;
  readonly cloneBytes?: boolean;
  readonly freeze?: boolean;
  readonly allowCycles?: boolean;
  readonly preserveAliases?: boolean;
  readonly requireEnumerable?: boolean;
  readonly requireOrdinaryArrays?: boolean;
  readonly preserveObjectPrototype?: boolean;
  readonly countRoot?: boolean;
}

export interface BoundedSnapshot<T = unknown> {
  readonly value: T;
  readonly bytes: number;
  readonly items: number;
}

export function ownDataRecord(
  value: unknown,
  path: string,
  requireEnumerable = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path} contains an unknown symbol key`);
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`${path} contains unsafe key ${JSON.stringify(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || (requireEnumerable && !descriptor.enumerable)
    ) {
      const qualifier = requireEnumerable ? "an enumerable data" : "a data";
      throw new TypeError(`${path}.${key} must be ${qualifier} property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

export function denseOwnDataArray(
  value: unknown,
  path: string,
  maxItems: number,
  requireEnumerable = false,
  requireOrdinaryPrototype = false,
): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value)) throw new TypeError(`${path} must be an array`);
  if (requireOrdinaryPrototype && Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} must use the ordinary Array prototype`);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${path}.length must be a non-negative safe integer data property`);
  }
  if (length > maxItems) throw new TypeError(`${path} exceeds the ${String(maxItems)}-item boundary`);
  const allowed = new Set(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains a non-index array property`);
    }
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) throw new TypeError(`${path}.${key} is required`);
    if (!("value" in descriptor) || (requireEnumerable && !descriptor.enumerable)) {
      const qualifier = requireEnumerable ? "an enumerable data" : "a data";
      throw new TypeError(`${path}.${key} must be ${qualifier} property`);
    }
    output.push(descriptor.value);
  }
  return output;
}

export function assertOwnKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const expected = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path} contains an unknown symbol key`);
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`${path} contains unsafe key ${JSON.stringify(key)}`);
    if (!expected.has(key)) throw new TypeError(`${path} contains unknown key ${JSON.stringify(key)}`);
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function snapshotBoundedValue<T = unknown>(
  value: unknown,
  options: BoundedSnapshotOptions,
): BoundedSnapshot<T> {
  const label = options.label ?? "value";
  let bytes = 0;
  let items = 0;
  const charge = (amount: number, path: string): void => {
    bytes += amount;
    const suffix = options.byteLabel === undefined ? "" : ` ${options.byteLabel}`;
    if (bytes > options.maxBytes) {
      throw new TypeError(`${path} exceeds the ${String(options.maxBytes)}-byte${suffix} boundary`);
    }
  };
  const addItems = (count: number, path: string): void => {
    items += count;
    if (items > options.maxItems) {
      throw new TypeError(`${path} exceeds the ${String(options.maxItems)}-item ${label} boundary`);
    }
  };
  const active = new Set<object>();
  const copies = new WeakMap<object, object>();
  const visit = (input: unknown, path: string, depth: number): unknown => {
    if (depth === 0 && options.countRoot !== false) addItems(1, path);
    if (input === undefined && options.allowUndefined === true) {
      charge(8, path);
      return input;
    }
    if (input === null || typeof input === "boolean") {
      charge(8, path);
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError(`${path} must contain only finite numbers`);
      charge(16, path);
      return input;
    }
    if (typeof input === "string") {
      charge(utf8Bytes(input), path);
      return input;
    }
    if (typeof input !== "object" || input === null) {
      const values = options.label === "JSON" ? "JSON values" : `plain ${label} values`;
      throw new TypeError(`${path} must contain only ${values}`);
    }
    if (isProxy(input)) {
      const message = options.cloneBytes === true
        ? "must be stable Uint8Array byte data"
        : "must not contain a Proxy";
      throw new TypeError(`${path} ${message}`);
    }
    if (input instanceof Uint8Array) {
      if (options.cloneBytes !== true) {
        const values = options.label === "JSON" ? "JSON values" : `plain ${label} values`;
        throw new TypeError(`${path} must contain only ${values}`);
      }
      const copy = cloneIntrinsicUint8Array(input, path, options.maxBytes - bytes);
      charge(copy.byteLength, path);
      return copy;
    }
    if (depth >= options.maxDepth) {
      const label = options.label === undefined ? "" : `${options.label} `;
      throw new TypeError(`${path} exceeds the ${label}depth boundary of ${String(options.maxDepth)}`);
    }
    const prior = copies.get(input);
    if (active.has(input)) {
      if (options.allowCycles === true && prior !== undefined) return prior;
      throw new TypeError(`${path} must not contain cycles`);
    }
    if (options.preserveAliases === true && prior !== undefined) return prior;
    const source = Array.isArray(input)
      ? denseOwnDataArray(
        input,
        path,
        options.maxItems,
        options.requireEnumerable,
        options.requireOrdinaryArrays,
      )
      : ownDataRecord(input, path, options.requireEnumerable);
    const entries = Object.entries(source);
    addItems(entries.length, path);
    const output: unknown[] | Record<string, unknown> = Array.isArray(input)
      ? []
      : Object.create(
        options.preserveObjectPrototype === true ? Object.getPrototypeOf(input) : null,
      ) as Record<string, unknown>;
    if (options.preserveAliases === true || options.allowCycles === true) {
      copies.set(input, output);
    }
    active.add(input);
    try {
      for (const [key, child] of entries) {
        if (!Array.isArray(input)) charge(utf8Bytes(key), path);
        const childPath = Array.isArray(input) ? `${path}[${key}]` : `${path}.${key}`;
        const snapshot = visit(child, childPath, depth + 1);
        if (Array.isArray(output)) output.push(snapshot);
        else Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: snapshot,
          writable: true,
        });
      }
    } finally {
      active.delete(input);
    }
    return options.freeze === true ? Object.freeze(output) : output;
  };
  return { value: visit(value, options.path, 0) as T, bytes, items };
}
