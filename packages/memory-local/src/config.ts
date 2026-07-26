// SPDX-License-Identifier: MIT
import { assertSafeHttpUrl } from "@mono-agent/module-sdk";

export const DEFAULT_MEMORY_MAX_BYTES = 96_000;
export const DEFAULT_MEMORY_MAX_RECALL_RESULTS = 50;
export const DEFAULT_MEMORY_MAX_RECORDS = 100_000;
export const DEFAULT_MEMORY_MAX_TEXT_BYTES = 64 * 1024;
export const DEFAULT_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS = 2_048;
export const DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS = 8;
export const DEFAULT_RUNTIME_CAPTURE_TIMEOUT_MS = 360_000;
export const DEFAULT_CAPTURE_RECEIPT_RETENTION_DAYS = 30;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
export const DEFAULT_EMBEDDING_BREAKER_FAILURES = 3;
export const DEFAULT_EMBEDDING_BREAKER_RESET_MS = 30_000;
export const MAX_MEMORY_LOCAL_INTAKE_RETRIES = 1_000;

export interface MemoryLocalModelRoute {
  readonly runtime: string;
  readonly model: string;
}

export interface MemoryLocalCaptureConfig {
  readonly enabled: boolean;
  readonly model?: MemoryLocalModelRoute;
  readonly timeoutMs: number;
  readonly receiptRetentionDays: number;
}

export interface MemoryLocalEmbeddingsConfig {
  readonly provider: "ollama";
  readonly endpoint: string;
  readonly model: string;
  readonly dimensions: number;
  readonly timeoutMs: number;
  readonly breakerFailures: number;
  readonly breakerResetMs: number;
}

export interface MemoryLocalRecallToolConfig {
  readonly enabled: boolean;
}

export interface MemoryLocalConfig {
  /** Omit to use Core's instance-specific data directory. Relative paths resolve from agent config. */
  readonly root?: string;
  /** Maximum UTF-8 text returned by one recall. */
  readonly maxBytes: number;
  readonly capture: MemoryLocalCaptureConfig;
  readonly embeddings?: MemoryLocalEmbeddingsConfig;
  readonly recallTool: MemoryLocalRecallToolConfig;
}

export const memoryLocalJsonSchema = Object.freeze({
  $id: "https://mono-agent.dev/schemas/memory-local/v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    root: { type: "string", minLength: 1 },
    maxBytes: {
      type: "integer",
      minimum: 1_024,
      maximum: 4_194_304,
      default: DEFAULT_MEMORY_MAX_BYTES,
    },
    capture: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        model: {
          type: "object",
          additionalProperties: false,
          required: ["runtime", "model"],
          properties: {
            runtime: { type: "string", minLength: 1, maxLength: 256 },
            model: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 3_600_000,
          default: DEFAULT_RUNTIME_CAPTURE_TIMEOUT_MS,
        },
        receiptRetentionDays: {
          type: "integer",
          minimum: 1,
          maximum: 3_650,
          default: DEFAULT_CAPTURE_RECEIPT_RETENTION_DAYS,
        },
      },
    },
    embeddings: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "endpoint", "model", "dimensions"],
      properties: {
        provider: { const: "ollama" },
        endpoint: { type: "string", minLength: 1, maxLength: 4_096 },
        model: { type: "string", minLength: 1, maxLength: 512 },
        dimensions: { type: "integer", minimum: 1, maximum: 16_384 },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 600_000,
          default: DEFAULT_EMBEDDING_TIMEOUT_MS,
        },
        breakerFailures: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: DEFAULT_EMBEDDING_BREAKER_FAILURES,
        },
        breakerResetMs: {
          type: "integer",
          minimum: 1,
          maximum: 3_600_000,
          default: DEFAULT_EMBEDDING_BREAKER_RESET_MS,
        },
      },
    },
    recallTool: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    },
  },
} as const);

const ROOT_KEYS = ["root", "maxBytes", "capture", "embeddings", "recallTool"] as const;
const CAPTURE_KEYS = ["enabled", "model", "timeoutMs", "receiptRetentionDays"] as const;
const MODEL_KEYS = ["runtime", "model"] as const;
const EMBEDDING_KEYS = [
  "provider",
  "endpoint",
  "model",
  "dimensions",
  "timeoutMs",
  "breakerFailures",
  "breakerResetMs",
] as const;
const RECALL_TOOL_KEYS = ["enabled"] as const;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function parseMemoryLocalConfig(input: unknown): MemoryLocalConfig {
  const root = input === undefined ? {} : plainObject(input, "$", ROOT_KEYS);
  const authoredRoot = optionalTrimmedString(root.root, "$.root", 4_096);
  const capture = root.capture === undefined ? {} : plainObject(root.capture, "$.capture", CAPTURE_KEYS);
  const enabled = boolean(capture.enabled, false, "$.capture.enabled");
  const model = capture.model === undefined ? undefined : parseModel(capture.model);
  if (enabled && model === undefined) {
    fail("$.capture.model", "is required when capture is enabled");
  }
  if (!enabled && model !== undefined) {
    fail("$.capture.model", "must be omitted when capture is disabled");
  }
  const embeddings = root.embeddings === undefined ? undefined : parseEmbeddings(root.embeddings);
  const recallTool = root.recallTool === undefined
    ? {}
    : plainObject(root.recallTool, "$.recallTool", RECALL_TOOL_KEYS);

  return Object.freeze({
    ...(authoredRoot === undefined ? {} : { root: authoredRoot }),
    maxBytes: boundedInteger(root.maxBytes, DEFAULT_MEMORY_MAX_BYTES, 1_024, 4_194_304, "$.maxBytes"),
    capture: Object.freeze({
      enabled,
      ...(model === undefined ? {} : { model }),
      timeoutMs: boundedInteger(
        capture.timeoutMs,
        DEFAULT_RUNTIME_CAPTURE_TIMEOUT_MS,
        1,
        3_600_000,
        "$.capture.timeoutMs",
      ),
      receiptRetentionDays: boundedInteger(
        capture.receiptRetentionDays,
        DEFAULT_CAPTURE_RECEIPT_RETENTION_DAYS,
        1,
        3_650,
        "$.capture.receiptRetentionDays",
      ),
    }),
    ...(embeddings === undefined ? {} : { embeddings }),
    recallTool: Object.freeze({
      enabled: boolean(recallTool.enabled, true, "$.recallTool.enabled"),
    }),
  });
}

function parseModel(input: unknown): MemoryLocalModelRoute {
  const value = plainObject(input, "$.capture.model", MODEL_KEYS);
  return Object.freeze({
    runtime: requiredTrimmedString(value.runtime, "$.capture.model.runtime", 256),
    model: requiredTrimmedString(value.model, "$.capture.model.model", 512),
  });
}

function parseEmbeddings(input: unknown): MemoryLocalEmbeddingsConfig {
  const value = plainObject(input, "$.embeddings", EMBEDDING_KEYS);
  if (value.provider !== "ollama") fail("$.embeddings.provider", "must be ollama");
  const rawEndpoint = requiredTrimmedString(value.endpoint, "$.embeddings.endpoint", 4_096);
  let endpoint: URL;
  try {
    endpoint = assertSafeHttpUrl(rawEndpoint);
  } catch {
    fail("$.embeddings.endpoint", "must use HTTPS or literal-loopback HTTP without credentials");
  }
  if (endpoint.search !== "" || endpoint.hash !== "") {
    fail("$.embeddings.endpoint", "must not contain a query or fragment");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
  return Object.freeze({
    provider: "ollama",
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    model: requiredTrimmedString(value.model, "$.embeddings.model", 512),
    dimensions: boundedInteger(value.dimensions, undefined, 1, 16_384, "$.embeddings.dimensions"),
    timeoutMs: boundedInteger(
      value.timeoutMs,
      DEFAULT_EMBEDDING_TIMEOUT_MS,
      1,
      600_000,
      "$.embeddings.timeoutMs",
    ),
    breakerFailures: boundedInteger(
      value.breakerFailures,
      DEFAULT_EMBEDDING_BREAKER_FAILURES,
      1,
      100,
      "$.embeddings.breakerFailures",
    ),
    breakerResetMs: boundedInteger(
      value.breakerResetMs,
      DEFAULT_EMBEDDING_BREAKER_RESET_MS,
      1,
      3_600_000,
      "$.embeddings.breakerResetMs",
    ),
  });
}

function plainObject(
  input: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(path, "must be an object");
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  const value = input as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
  if (unknown.length > 0) fail(path, `contains unknown field(s): ${unknown.join(", ")}`);
  return value;
}

function optionalTrimmedString(input: unknown, path: string, maximum: number): string | undefined {
  if (input === undefined) return undefined;
  return requiredTrimmedString(input, path, maximum);
}

function requiredTrimmedString(input: unknown, path: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum ||
    input !== input.trim() ||
    CONTROL.test(input)
  ) {
    fail(path, `must be a non-empty trimmed string of at most ${maximum} characters without control characters`);
  }
  return input;
}

function boolean(input: unknown, fallback: boolean, path: string): boolean {
  if (input === undefined) return fallback;
  if (typeof input !== "boolean") fail(path, "must be a boolean");
  return input;
}

function boundedInteger(
  input: unknown,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
  path: string,
): number {
  const value = input === undefined ? fallback : input;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function fail(path: string, message: string): never {
  throw new TypeError(`memory-local config ${path} ${message}`);
}
