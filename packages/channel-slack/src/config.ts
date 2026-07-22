import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_SLACK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_SLACK_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface SlackConfig {
  /** Resolved env-only Slack app-level token. */
  readonly appToken: string;
  /** Resolved env-only Slack bot token. */
  readonly botToken: string;
  readonly allowedTeamIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
  readonly defaultDestination?: string;
  readonly maxAttachmentBytes: number;
}

export class SlackConfigError extends Error {
  readonly code = "invalid_slack_config";
  constructor(message: string) { super(message); this.name = "SlackConfigError"; }
}

export function parseSlackConfig(value: unknown): SlackConfig {
  const input = record(value, "Slack channel config");
  exact(input, ["appToken", "botToken", "allowedTeamIds", "allowedChannelIds", "allowAllChannels", "defaultDestination", "maxAttachmentBytes"], "Slack channel config");
  const appToken = token(input.appToken, "appToken", "xapp-");
  const botToken = token(input.botToken, "botToken", "xoxb-");
  const allowedTeamIds = identifiers(input.allowedTeamIds, "allowedTeamIds");
  if (allowedTeamIds.length === 0) fail("allowedTeamIds must contain at least one exact workspace id.");
  const allowAllChannels = bool(input.allowAllChannels, "allowAllChannels", false);
  const allowedChannelIds = identifiers(input.allowedChannelIds, "allowedChannelIds");
  if (!allowAllChannels && allowedChannelIds.length === 0) fail("allowedChannelIds must contain at least one exact channel id unless allowAllChannels is true.");
  const defaultDestination = input.defaultDestination === undefined ? undefined : id(input.defaultDestination, "defaultDestination");
  if (defaultDestination !== undefined && !allowAllChannels && !allowedChannelIds.includes(defaultDestination.split(":", 1)[0]!)) fail("defaultDestination channel must be authorized.");
  return Object.freeze({
    appToken,
    botToken,
    allowedTeamIds: Object.freeze(unique(allowedTeamIds, "allowedTeamIds")),
    allowedChannelIds: Object.freeze(unique(allowedChannelIds, "allowedChannelIds")),
    allowAllChannels,
    ...(defaultDestination === undefined ? {} : { defaultDestination }),
    maxAttachmentBytes: integer(input.maxAttachmentBytes, "maxAttachmentBytes", DEFAULT_SLACK_MAX_ATTACHMENT_BYTES, 1, MAX_SLACK_ATTACHMENT_BYTES),
  });
}

const idSchema = envEligibleSchema({ type: "string", minLength: 1, maxLength: 128 });
export const slackConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["appToken", "botToken", "allowedTeamIds", "allowedChannelIds"],
    properties: {
      appToken: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096, pattern: "^xapp-" }, { secret: true }),
      botToken: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096, pattern: "^xoxb-" }, { secret: true }),
      allowedTeamIds: { type: "array", uniqueItems: true, items: idSchema },
      allowedChannelIds: { type: "array", uniqueItems: true, items: idSchema },
      allowAllChannels: { type: "boolean", default: false },
      defaultDestination: idSchema,
      maxAttachmentBytes: { type: "integer", minimum: 1, maximum: MAX_SLACK_ATTACHMENT_BYTES, default: DEFAULT_SLACK_MAX_ATTACHMENT_BYTES },
    },
  }),
  parse: parseSlackConfig,
});

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void { const allowed = new Set(fields); const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(); if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(", ")}.`); }
function token(value: unknown, label: string, prefix: string): string { if (typeof value !== "string" || value.length < 20 || value.length > 4_096 || !value.startsWith(prefix) || /\s/u.test(value)) fail(`${label} must be a resolved ${prefix} env-only secret.`); return value; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 128 || /\s/u.test(value)) fail(`${label} must be a non-empty identifier.`); return value; }
function identifiers(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length > 1_000) fail(`${label} must be an array with at most 1000 entries.`); return value.map((entry, index) => id(entry, `${label}[${index}]`)); }
function unique(values: string[], label: string): string[] { const result = [...new Set(values)]; if (result.length !== values.length) fail(`${label} must not contain duplicates.`); return result; }
function bool(value: unknown, label: string, fallback: boolean): boolean { if (value === undefined) return fallback; if (typeof value !== "boolean") fail(`${label} must be a boolean.`); return value; }
function integer(value: unknown, label: string, fallback: number, min: number, max: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} must be an integer from ${min} through ${max}.`); return value as number; }
function fail(message: string): never { throw new SlackConfigError(message); }
