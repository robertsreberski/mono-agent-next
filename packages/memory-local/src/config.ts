export const DEFAULT_MEMORY_MAX_RECORDS = 10_000;
export const DEFAULT_MEMORY_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MEMORY_MAX_TEXT_BYTES = 64 * 1024;
export const DEFAULT_MEMORY_MAX_METADATA_BYTES = 64 * 1024;
export const DEFAULT_MEMORY_MAX_RECALL_RESULTS = 50;
export const DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS = 8;
export const DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS = 2_048;

export interface MemoryLocalLimitsConfig {
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  readonly maxTextBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxRecallResults: number;
}

export interface MemoryLocalCaptureConfig {
  readonly mode: "direct" | "runtime";
  readonly maxRecords: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
}

export interface MemoryLocalConfig {
  /** Omit to use Core's instance-specific data directory. Relative paths resolve from agent config. */
  readonly directory?: string;
  readonly limits: MemoryLocalLimitsConfig;
  readonly capture: MemoryLocalCaptureConfig;
}

export const memoryLocalJsonSchema = Object.freeze({
  $id: "https://mono-agent.dev/schemas/memory-local/v1.json",
  type: "object",
  additionalProperties: false,
  properties: {
    directory: { type: "string", minLength: 1 },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxRecords: { type: "integer", minimum: 1, maximum: 100_000, default: DEFAULT_MEMORY_MAX_RECORDS },
        maxTotalBytes: { type: "integer", minimum: 1_024, maximum: 1_073_741_824, default: DEFAULT_MEMORY_MAX_TOTAL_BYTES },
        maxTextBytes: { type: "integer", minimum: 1, maximum: 1_048_576, default: DEFAULT_MEMORY_MAX_TEXT_BYTES },
        maxMetadataBytes: { type: "integer", minimum: 2, maximum: 262_144, default: DEFAULT_MEMORY_MAX_METADATA_BYTES },
        maxRecallResults: { type: "integer", minimum: 1, maximum: 100, default: DEFAULT_MEMORY_MAX_RECALL_RESULTS },
      },
    },
    capture: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["direct", "runtime"], default: "direct" },
        maxRecords: { type: "integer", minimum: 1, maximum: 32, default: DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS },
        maxOutputBytes: { type: "integer", minimum: 2, maximum: 4_194_304, default: DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES },
        maxOutputTokens: { type: "integer", minimum: 1, maximum: 16_384, default: DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS },
      },
    },
  },
} as const);

const ROOT_KEYS = ["directory", "limits", "capture"] as const;
const LIMIT_KEYS = ["maxRecords", "maxTotalBytes", "maxTextBytes", "maxMetadataBytes", "maxRecallResults"] as const;
const CAPTURE_KEYS = ["mode", "maxRecords", "maxOutputBytes", "maxOutputTokens"] as const;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function parseMemoryLocalConfig(input: unknown): MemoryLocalConfig {
  const root = input === undefined ? {} : plainObject(input, "$", ROOT_KEYS);
  const directory = optionalTrimmedString(root.directory, "$.directory");
  const limits = root.limits === undefined ? {} : plainObject(root.limits, "$.limits", LIMIT_KEYS);
  const capture = root.capture === undefined ? {} : plainObject(root.capture, "$.capture", CAPTURE_KEYS);
  const mode = capture.mode ?? "direct";
  if (mode !== "direct" && mode !== "runtime") fail("$.capture.mode", "must be direct or runtime");

  return Object.freeze({
    ...(directory === undefined ? {} : { directory }),
    limits: Object.freeze({
      maxRecords: boundedInteger(limits.maxRecords, DEFAULT_MEMORY_MAX_RECORDS, 1, 100_000, "$.limits.maxRecords"),
      maxTotalBytes: boundedInteger(limits.maxTotalBytes, DEFAULT_MEMORY_MAX_TOTAL_BYTES, 1_024, 1_073_741_824, "$.limits.maxTotalBytes"),
      maxTextBytes: boundedInteger(limits.maxTextBytes, DEFAULT_MEMORY_MAX_TEXT_BYTES, 1, 1_048_576, "$.limits.maxTextBytes"),
      maxMetadataBytes: boundedInteger(limits.maxMetadataBytes, DEFAULT_MEMORY_MAX_METADATA_BYTES, 2, 262_144, "$.limits.maxMetadataBytes"),
      maxRecallResults: boundedInteger(limits.maxRecallResults, DEFAULT_MEMORY_MAX_RECALL_RESULTS, 1, 100, "$.limits.maxRecallResults"),
    }),
    capture: Object.freeze({
      mode,
      maxRecords: boundedInteger(capture.maxRecords, DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS, 1, 32, "$.capture.maxRecords"),
      maxOutputBytes: boundedInteger(capture.maxOutputBytes, DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES, 2, 4_194_304, "$.capture.maxOutputBytes"),
      maxOutputTokens: boundedInteger(capture.maxOutputTokens, DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS, 1, 16_384, "$.capture.maxOutputTokens"),
    }),
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

function optionalTrimmedString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || CONTROL.test(input)) {
    fail(path, "must be a non-empty trimmed string without control characters");
  }
  return input;
}

function boundedInteger(input: unknown, fallback: number, minimum: number, maximum: number, path: string): number {
  if (input === undefined) return fallback;
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return input as number;
}

function fail(path: string, message: string): never {
  throw new TypeError(`memory-local config ${path} ${message}`);
}
