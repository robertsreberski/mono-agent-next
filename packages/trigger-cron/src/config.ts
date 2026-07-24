// SPDX-License-Identifier: GPL-3.0-only

export const DEFAULT_CRON_TIMEZONE = "UTC";

export interface TriggerCronConfig {
  readonly jobsDirectory: string;
  readonly timezone: string;
}

export class TriggerCronConfigError extends Error {
  readonly code = "invalid_trigger_cron_config";

  constructor(message: string) {
    super(message);
    this.name = "TriggerCronConfigError";
  }
}

const CONFIG_KEYS = new Set(["jobsDirectory", "timezone"]);
const MAX_JOBS_DIRECTORY_LENGTH = 1_024;
const MAX_TIMEZONE_LENGTH = 128;

export function parseTriggerCronConfig(value: unknown): TriggerCronConfig {
  const input = readRecord(value, "Trigger cron config");
  rejectUnknownKeys(input, CONFIG_KEYS, "Trigger cron config");
  const jobsDirectory = readRelativeDirectory(input.jobsDirectory, "jobsDirectory");
  const timezone = input.timezone === undefined
    ? DEFAULT_CRON_TIMEZONE
    : readString(input.timezone, "timezone", MAX_TIMEZONE_LENGTH);
  assertValidTimezone(timezone, "timezone");
  return Object.freeze({ jobsDirectory, timezone });
}

export const triggerCronConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      jobsDirectory: {
        type: "string",
        minLength: 1,
        maxLength: MAX_JOBS_DIRECTORY_LENGTH,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\u0000-\\u001f\\u007f]).+$",
      },
      timezone: {
        type: "string",
        minLength: 1,
        maxLength: MAX_TIMEZONE_LENGTH,
        default: DEFAULT_CRON_TIMEZONE,
      },
    },
    required: ["jobsDirectory"],
  }),
  parse: parseTriggerCronConfig,
});

export function assertValidTimezone(value: string, field = "timezone"): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new TriggerCronConfigError(`${field} must be a valid IANA timezone.`);
  }
}

export function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TriggerCronConfigError(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TriggerCronConfigError(`${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new TriggerCronConfigError(`${field} contains unknown field(s): ${unknown.join(", ")}.`);
  }
}

export function readString(value: unknown, field: string, maximumLength = 4_096): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || exceedsCodePointLimit(value, maximumLength)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TriggerCronConfigError(`${field} must be a non-empty bounded string without surrounding whitespace.`);
  }
  return value;
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return true;
  }
  return false;
}

function readRelativeDirectory(value: unknown, field: string): string {
  const path = readString(value, field, MAX_JOBS_DIRECTORY_LENGTH);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(path)) {
    throw new TriggerCronConfigError(`${field} must be relative to the agent config directory.`);
  }
  const segments = path.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new TriggerCronConfigError(`${field} must not escape the agent config directory.`);
  }
  return path;
}
