import {
  OPERATOR_IDENTIFIER_PATTERN,
  OPERATOR_LIMITS,
  type OperatorJsonValue,
} from "./types.js";

export type UnknownRecord = Record<string, unknown>;

/**
 * Raise the caller's own error type. Each consumer owns a distinct error
 * class, so the shared primitives take the constructor rather than importing
 * one and forcing every caller to re-wrap.
 */
export type ValidationFail = (path: string, message: string) => never;

/**
 * The single definition of every protocol primitive. `protocol.ts` and
 * `directory.ts` previously kept parallel copies that drifted: the directory
 * variants accepted `__proto__`, `constructor`, and `prototype` keys that the
 * protocol variants rejected.
 */
export function createOperatorValidators(fail: ValidationFail) {
  function record(value: unknown, path: string): UnknownRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(path, "must be an object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(path, "must be a plain object");
    }
    return value as UnknownRecord;
  }

  function keys(value: UnknownRecord, allowed: readonly string[], path: string): void {
    const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unexpected.length > 0) {
      fail(path, `contains unknown field ${JSON.stringify(unexpected[0])}`);
    }
  }

  function text(value: unknown, path: string, options: { allowEmpty?: boolean; max?: number } = {}): string {
    if (typeof value !== "string") fail(path, "must be a string");
    if (!options.allowEmpty && value.length === 0) fail(path, "must not be empty");
    if (value.length > (options.max ?? 32_768)) fail(path, `must be at most ${options.max ?? 32_768} characters`);
    return value;
  }

  function contractText(value: unknown, path: string, maximumBytes: number): string {
    if (typeof value !== "string") fail(path, "must be a string");
    if (value.length === 0 || value.trim().length === 0) fail(path, "must not be empty");
    if (value.includes("\0")) fail(path, "must not contain NUL");
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > maximumBytes) fail(path, `must be at most ${maximumBytes} UTF-8 bytes`);
    return value;
  }

  function identifier(value: unknown, path: string): string {
    const parsed = text(value, path, { max: OPERATOR_LIMITS.identifierCharacters });
    if (!OPERATOR_IDENTIFIER_PATTERN.test(parsed)) {
      fail(path, "contains unsupported characters");
    }
    return parsed;
  }

  function messageIdentifier(value: unknown, path: string): string {
    const parsed = text(value, path, { max: OPERATOR_LIMITS.messageIdentifierCharacters });
    const legacy = parsed.length <= OPERATOR_LIMITS.identifierCharacters
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(parsed);
    if (!legacy && !/^message~u16:[A-Za-z0-9_-]+$/.test(parsed)) {
      fail(path, "contains unsupported characters");
    }
    return parsed;
  }

  function bool(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") fail(path, "must be a boolean");
    return value;
  }

  function integer(value: unknown, path: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      fail(path, `must be a safe integer >= ${minimum}`);
    }
    return value as number;
  }

  function timestamp(value: unknown, path: string): string {
    const parsed = text(value, path, { max: 64 });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
      || !Number.isFinite(Date.parse(parsed))
      || new Date(parsed).toISOString() !== parsed) {
      fail(path, "must be a canonical UTC timestamp");
    }
    return parsed;
  }

  function environmentName(value: unknown, path: string): string {
    const parsed = text(value, path, { max: 255 });
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed)) fail(path, "must be a valid environment variable name");
    return parsed;
  }

  function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
    if (typeof value !== "string" || !allowed.includes(value)) {
      fail(path, `must be one of ${allowed.join(", ")}`);
    }
    return value as T[number];
  }

  function array<T>(value: unknown, path: string, parser: (item: unknown, path: string) => T, max = 1_000): T[] {
    if (!Array.isArray(value)) fail(path, "must be an array");
    if (value.length > max) fail(path, `must contain at most ${max} items`);
    return value.map((item, index) => parser(item, `${path}[${index}]`));
  }

  function jsonValue(
    value: unknown,
    path: string,
    depth = 0,
    budget: { items: number } = { items: 0 },
  ): OperatorJsonValue {
    if (depth > 20) fail(path, "exceeds the maximum nesting depth");
    budget.items += 1;
    if (budget.items > OPERATOR_LIMITS.jsonItems) {
      fail(path, `exceeds the ${String(OPERATOR_LIMITS.jsonItems)}-item JSON boundary`);
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1, budget));
    }
    if (typeof value === "object") {
      const output: Record<string, OperatorJsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") fail(path, `contains unsafe key ${key}`);
        output[key] = jsonValue(item, `${path}.${key}`, depth + 1, budget);
      }
      return output;
    }
    return fail(path, "must contain only JSON values");
  }

  function boundedJsonValue(value: unknown, path: string): OperatorJsonValue {
    const parsed = jsonValue(value, path);
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > OPERATOR_LIMITS.toolPayloadBytes) {
      fail(path, `must encode to at most ${String(OPERATOR_LIMITS.toolPayloadBytes)} UTF-8 bytes`);
    }
    return parsed;
  }

  function boundedUtf8Text(value: unknown, path: string, maximumBytes: number): string {
    const parsed = text(value, path, { allowEmpty: true, max: maximumBytes });
    if (new TextEncoder().encode(parsed).byteLength > maximumBytes) {
      fail(path, `must be at most ${String(maximumBytes)} UTF-8 bytes`);
    }
    return parsed;
  }

  return {
    record,
    keys,
    text,
    contractText,
    identifier,
    messageIdentifier,
    bool,
    integer,
    timestamp,
    environmentName,
    oneOf,
    array,
    jsonValue,
    boundedJsonValue,
    boundedUtf8Text,
  } as const;
}
