import { isIP } from "node:net";

import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_MAX_QUEUE_RECORDS = 2_048;
export const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_BATCH_RECORDS = 128;
export const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
export const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 3;

const MAX_QUEUE_RECORDS = 100_000;
const MAX_QUEUE_BYTES = 256 * 1024 * 1024;
const MAX_BATCH_RECORDS = 1_000;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_INTERVAL_MS = 60_000;
const MAX_DEADLINE_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_HEADERS = 64;
const MAX_HEADER_BYTES = 32 * 1024;

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "x-project-name",
]);

export interface OtlpExporterConfig {
  readonly endpoint: string;
  readonly projectName: string;
  readonly includeSensitiveData: boolean;
  /** Resolved values. Public config accepts only SDK-owned {$env} wrappers. */
  readonly headers: Readonly<Record<string, string>>;
  readonly maxQueueRecords: number;
  readonly maxQueueBytes: number;
  readonly maxBatchRecords: number;
  readonly maxBatchBytes: number;
  readonly maxRecordBytes: number;
  readonly flushIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly flushTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly maxRedirects: number;
}

export class OtlpExporterConfigError extends Error {
  readonly code = "OTLP_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "OtlpExporterConfigError";
  }
}

const CONFIG_KEYS = new Set([
  "endpoint",
  "projectName",
  "includeSensitiveData",
  "headers",
  "maxQueueRecords",
  "maxQueueBytes",
  "maxBatchRecords",
  "maxBatchBytes",
  "maxRecordBytes",
  "flushIntervalMs",
  "requestTimeoutMs",
  "flushTimeoutMs",
  "stopTimeoutMs",
  "maxRedirects",
]);

export function parseOtlpExporterConfig(value: unknown): OtlpExporterConfig {
  const input = readRecord(value, "OTLP exporter config");
  rejectUnknownKeys(input, CONFIG_KEYS, "OTLP exporter config");
  const endpoint = parseEndpoint(input.endpoint).toString();
  const projectName = readAsciiString(input.projectName, "projectName", 256);
  const includeSensitiveData = readBoolean(input.includeSensitiveData, false, "includeSensitiveData");
  const headers = parseHeaders(input.headers);
  const maxQueueRecords = readInteger(
    input.maxQueueRecords,
    "maxQueueRecords",
    DEFAULT_MAX_QUEUE_RECORDS,
    1,
    MAX_QUEUE_RECORDS,
  );
  const maxQueueBytes = readInteger(
    input.maxQueueBytes,
    "maxQueueBytes",
    DEFAULT_MAX_QUEUE_BYTES,
    1,
    MAX_QUEUE_BYTES,
  );
  const maxBatchRecords = readInteger(
    input.maxBatchRecords,
    "maxBatchRecords",
    DEFAULT_MAX_BATCH_RECORDS,
    1,
    MAX_BATCH_RECORDS,
  );
  const maxBatchBytes = readInteger(
    input.maxBatchBytes,
    "maxBatchBytes",
    DEFAULT_MAX_BATCH_BYTES,
    1,
    MAX_BATCH_BYTES,
  );
  const maxRecordBytes = readInteger(
    input.maxRecordBytes,
    "maxRecordBytes",
    DEFAULT_MAX_RECORD_BYTES,
    1,
    MAX_RECORD_BYTES,
  );
  const flushIntervalMs = readInteger(
    input.flushIntervalMs,
    "flushIntervalMs",
    DEFAULT_FLUSH_INTERVAL_MS,
    10,
    MAX_INTERVAL_MS,
  );
  const requestTimeoutMs = readInteger(
    input.requestTimeoutMs,
    "requestTimeoutMs",
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    MAX_DEADLINE_MS,
  );
  const flushTimeoutMs = readInteger(
    input.flushTimeoutMs,
    "flushTimeoutMs",
    DEFAULT_FLUSH_TIMEOUT_MS,
    1,
    MAX_DEADLINE_MS,
  );
  const stopTimeoutMs = readInteger(
    input.stopTimeoutMs,
    "stopTimeoutMs",
    DEFAULT_STOP_TIMEOUT_MS,
    1,
    MAX_DEADLINE_MS,
  );
  const maxRedirects = readInteger(
    input.maxRedirects,
    "maxRedirects",
    DEFAULT_MAX_REDIRECTS,
    0,
    MAX_REDIRECTS,
  );

  if (maxBatchRecords > maxQueueRecords) {
    throw new OtlpExporterConfigError("maxBatchRecords must not exceed maxQueueRecords.");
  }
  if (maxRecordBytes > maxQueueBytes) {
    throw new OtlpExporterConfigError("maxRecordBytes must not exceed maxQueueBytes.");
  }
  if (maxRecordBytes > maxBatchBytes) {
    throw new OtlpExporterConfigError("maxRecordBytes must not exceed maxBatchBytes.");
  }
  if (maxBatchBytes > maxQueueBytes) {
    throw new OtlpExporterConfigError("maxBatchBytes must not exceed maxQueueBytes.");
  }

  return {
    endpoint,
    projectName,
    includeSensitiveData,
    headers,
    maxQueueRecords,
    maxQueueBytes,
    maxBatchRecords,
    maxBatchBytes,
    maxRecordBytes,
    flushIntervalMs,
    requestTimeoutMs,
    flushTimeoutMs,
    stopTimeoutMs,
    maxRedirects,
  };
}

export const otlpExporterConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      endpoint: { type: "string", minLength: 1, maxLength: 4_096 },
      projectName: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "^[ -~]+$",
      },
      includeSensitiveData: { type: "boolean", default: false },
      headers: {
        type: "object",
        maxProperties: MAX_HEADERS,
        additionalProperties: envEligibleSchema(
          { type: "string", minLength: 1, maxLength: 8_192 },
          { secret: true },
        ),
      },
      maxQueueRecords: {
        type: "integer",
        minimum: 1,
        maximum: MAX_QUEUE_RECORDS,
        default: DEFAULT_MAX_QUEUE_RECORDS,
      },
      maxQueueBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_QUEUE_BYTES,
        default: DEFAULT_MAX_QUEUE_BYTES,
      },
      maxBatchRecords: {
        type: "integer",
        minimum: 1,
        maximum: MAX_BATCH_RECORDS,
        default: DEFAULT_MAX_BATCH_RECORDS,
      },
      maxBatchBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_BATCH_BYTES,
        default: DEFAULT_MAX_BATCH_BYTES,
      },
      maxRecordBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RECORD_BYTES,
        default: DEFAULT_MAX_RECORD_BYTES,
      },
      flushIntervalMs: {
        type: "integer",
        minimum: 10,
        maximum: MAX_INTERVAL_MS,
        default: DEFAULT_FLUSH_INTERVAL_MS,
      },
      requestTimeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DEADLINE_MS,
        default: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      flushTimeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DEADLINE_MS,
        default: DEFAULT_FLUSH_TIMEOUT_MS,
      },
      stopTimeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DEADLINE_MS,
        default: DEFAULT_STOP_TIMEOUT_MS,
      },
      maxRedirects: {
        type: "integer",
        minimum: 0,
        maximum: MAX_REDIRECTS,
        default: DEFAULT_MAX_REDIRECTS,
      },
    },
    required: ["endpoint", "projectName"],
  }),
  parse: parseOtlpExporterConfig,
});

export function parseEndpoint(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new OtlpExporterConfigError("endpoint must be a bounded absolute URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OtlpExporterConfigError(
      `endpoint must be a valid absolute URL${error instanceof Error ? "." : "."}`,
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new OtlpExporterConfigError(
      "endpoint must not contain credentials, a query, or a fragment.",
    );
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLiteralLoopback(url.hostname)) return url;
  throw new OtlpExporterConfigError(
    "endpoint must use HTTPS, except literal-loopback HTTP is allowed for local collectors.",
  );
}

export function isLiteralLoopback(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isLiteralLoopback(normalized.slice("::ffff:".length));
  if (isIP(normalized) !== 4) return false;
  return Number.parseInt(normalized.split(".", 1)[0] ?? "", 10) === 127;
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const input = readRecord(value, "headers");
  const entries = Object.entries(input);
  if (entries.length > MAX_HEADERS) {
    throw new OtlpExporterConfigError(`headers must contain at most ${MAX_HEADERS} entries.`);
  }
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (
      rawName.length > 256 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) ||
      FORBIDDEN_HEADERS.has(name)
    ) {
      throw new OtlpExporterConfigError(`headers contains forbidden or invalid header name ${rawName}.`);
    }
    if (Object.hasOwn(output, name)) {
      throw new OtlpExporterConfigError(`headers contains duplicate case-insensitive header ${rawName}.`);
    }
    if (
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      rawValue.length > 8_192 ||
      /[\u0000-\u001f\u007f]/u.test(rawValue)
    ) {
      throw new OtlpExporterConfigError(`headers.${rawName} must be a resolved printable {$env} value.`);
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue);
    if (totalBytes > MAX_HEADER_BYTES) {
      throw new OtlpExporterConfigError(`headers exceeds ${MAX_HEADER_BYTES} bytes.`);
    }
    output[name] = rawValue;
  }
  return Object.freeze(output);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OtlpExporterConfigError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OtlpExporterConfigError(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new OtlpExporterConfigError(`${field} contains unknown field(s): ${unknown.join(", ")}.`);
  }
}

function readString(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OtlpExporterConfigError(`${field} must be a non-empty printable string.`);
  }
  return value;
}

function readAsciiString(value: unknown, field: string, maximum: number): string {
  const result = readString(value, field, maximum);
  if (!/^[\x20-\x7e]+$/u.test(result)) {
    throw new OtlpExporterConfigError(`${field} must contain printable ASCII characters.`);
  }
  return result;
}

function readBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new OtlpExporterConfigError(`${field} must be a boolean.`);
  return value;
}

function readInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) {
    throw new OtlpExporterConfigError(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return result as number;
}
