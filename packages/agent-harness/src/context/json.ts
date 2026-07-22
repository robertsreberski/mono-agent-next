import { ContextValidationError } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export function normalizeJsonValue(value: unknown): JsonValue {
  return normalizeJsonValueAtPath(value, '$', new WeakSet<object>());
}

function normalizeJsonValueAtPath(
  value: unknown,
  path: string,
  stack: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new ContextValidationError('invalid_json', 'JSON values must use finite numbers.', {
          path,
          value,
        });
      }
      return value;
    case 'object':
      return normalizeJsonObjectOrArray(value, path, stack);
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new ContextValidationError('invalid_json', `Unsupported JSON value at ${path}.`, {
        path,
        valueType: typeof value,
      });
  }

  throw new ContextValidationError('invalid_json', `Unsupported JSON value at ${path}.`, {
    path,
    valueType: typeof value,
  });
}

function normalizeJsonObjectOrArray(
  value: object,
  path: string,
  stack: WeakSet<object>,
): JsonValue {
  if (stack.has(value)) {
    throw new ContextValidationError('invalid_json', 'Circular JSON values are not supported.', {
      path,
    });
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const normalizedItems: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new ContextValidationError('invalid_json', 'Sparse arrays are not valid JSON values.', {
            path: `${path}[${index}]`,
          });
        }

        normalizedItems.push(normalizeJsonValueAtPath(value[index], `${path}[${index}]`, stack));
      }

      return normalizedItems;
    }

    if (!isPlainObject(value)) {
      throw new ContextValidationError('invalid_json', 'JSON objects must be plain objects.', {
        path,
        objectType: Object.prototype.toString.call(value),
      });
    }

    const normalized: Record<string, JsonValue> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const propertyValue = (value as Record<string, unknown>)[key];
      normalized[key] = normalizeJsonValueAtPath(propertyValue, `${path}.${key}`, stack);
    }

    return normalized;
  } finally {
    stack.delete(value);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
