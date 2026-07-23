import { envEligibleSchema } from "@mono-agent/module-sdk";

export const DEFAULT_SLACK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_SLACK_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_SLACK_SHORTCUTS = 100;
export const MAX_SLACK_HOME_BUTTONS = 100;

export interface SlackConfiguredAction {
  readonly prompt: string;
  readonly channelId?: string;
  readonly ackText?: string;
  readonly threadReply: boolean;
}

export interface SlackShortcutConfig extends SlackConfiguredAction {
  readonly callbackId: string;
}

export interface SlackHomeButtonConfig extends SlackConfiguredAction {
  readonly actionId: string;
  readonly label: string;
}

export interface SlackHomeTabConfig {
  readonly enabled: boolean;
  readonly headerText?: string;
  readonly buttons: readonly SlackHomeButtonConfig[];
}

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
  readonly shortcuts: readonly SlackShortcutConfig[];
  readonly homeTab: SlackHomeTabConfig;
}

export class SlackConfigError extends Error {
  readonly code = "invalid_slack_config";
  constructor(message: string) { super(message); this.name = "SlackConfigError"; }
}

export function parseSlackConfig(value: unknown): SlackConfig {
  const input = record(value, "Slack channel config");
  exact(input, ["appToken", "botToken", "allowedTeamIds", "allowedChannelIds", "allowAllChannels", "defaultDestination", "maxAttachmentBytes", "shortcuts", "homeTab"], "Slack channel config");
  const appToken = token(input.appToken, "appToken", "xapp-");
  const botToken = token(input.botToken, "botToken", "xoxb-");
  const allowedTeamIds = identifiers(input.allowedTeamIds, "allowedTeamIds");
  if (allowedTeamIds.length === 0) fail("allowedTeamIds must contain at least one exact workspace id.");
  const allowAllChannels = bool(input.allowAllChannels, "allowAllChannels", false);
  const allowedChannelIds = input.allowedChannelIds === undefined
    ? []
    : identifiers(input.allowedChannelIds, "allowedChannelIds");
  if (!allowAllChannels && allowedChannelIds.length === 0) fail("allowedChannelIds must contain at least one exact channel id unless allowAllChannels is true.");
  const defaultDestination = input.defaultDestination === undefined ? undefined : id(input.defaultDestination, "defaultDestination");
  if (defaultDestination !== undefined && !allowAllChannels && !allowedChannelIds.includes(defaultDestination.split(":", 1)[0]!)) fail("defaultDestination channel must be authorized.");
  const shortcuts = parseShortcuts(input.shortcuts, allowedChannelIds, allowAllChannels);
  const homeTab = parseHomeTab(input.homeTab, allowedChannelIds, allowAllChannels);
  return Object.freeze({
    appToken,
    botToken,
    allowedTeamIds: Object.freeze(unique(allowedTeamIds, "allowedTeamIds")),
    allowedChannelIds: Object.freeze(unique(allowedChannelIds, "allowedChannelIds")),
    allowAllChannels,
    ...(defaultDestination === undefined ? {} : { defaultDestination }),
    maxAttachmentBytes: integer(input.maxAttachmentBytes, "maxAttachmentBytes", DEFAULT_SLACK_MAX_ATTACHMENT_BYTES, 1, MAX_SLACK_ATTACHMENT_BYTES),
    shortcuts,
    homeTab,
  });
}

const idSchema = envEligibleSchema({ type: "string", minLength: 1, maxLength: 128 });
export const slackConfigSchema = Object.freeze({
  jsonSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["appToken", "botToken", "allowedTeamIds"],
    properties: {
      appToken: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096, pattern: "^xapp-" }, { secret: true }),
      botToken: envEligibleSchema({ type: "string", minLength: 20, maxLength: 4_096, pattern: "^xoxb-" }, { secret: true }),
      allowedTeamIds: { type: "array", uniqueItems: true, items: idSchema },
      allowedChannelIds: { type: "array", uniqueItems: true, items: idSchema },
      allowAllChannels: { type: "boolean", default: false },
      defaultDestination: idSchema,
      maxAttachmentBytes: { type: "integer", minimum: 1, maximum: MAX_SLACK_ATTACHMENT_BYTES, default: DEFAULT_SLACK_MAX_ATTACHMENT_BYTES },
      shortcuts: {
        type: "array",
        maxItems: MAX_SLACK_SHORTCUTS,
        default: [],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["callbackId", "prompt"],
          properties: {
            callbackId: { type: "string", minLength: 1, maxLength: 128 },
            prompt: { type: "string", minLength: 1, maxLength: 16_384 },
            channelId: idSchema,
            ackText: { type: "string", minLength: 1, maxLength: 4_000 },
            threadReply: { type: "boolean", default: false },
          },
        },
      },
      homeTab: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: false },
          headerText: { type: "string", minLength: 1, maxLength: 3_000 },
          buttons: {
            type: "array",
            maxItems: MAX_SLACK_HOME_BUTTONS,
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              required: ["actionId", "label", "prompt"],
              properties: {
                actionId: { type: "string", minLength: 1, maxLength: 128 },
                label: { type: "string", minLength: 1, maxLength: 75 },
                prompt: { type: "string", minLength: 1, maxLength: 16_384 },
                channelId: idSchema,
                ackText: { type: "string", minLength: 1, maxLength: 4_000 },
                threadReply: { type: "boolean", default: false },
              },
            },
          },
        },
      },
    },
  }),
  parse: parseSlackConfig,
});

function parseShortcuts(
  value: unknown,
  allowedChannelIds: readonly string[],
  allowAllChannels: boolean,
): readonly SlackShortcutConfig[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SLACK_SHORTCUTS) {
    fail(`shortcuts must be an array with at most ${MAX_SLACK_SHORTCUTS} entries.`);
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((candidate, index) => {
    const input = record(candidate, `shortcuts[${index}]`);
    exact(input, ["callbackId", "prompt", "channelId", "ackText", "threadReply"], `shortcuts[${index}]`);
    const callbackId = actionId(input.callbackId, `shortcuts[${index}].callbackId`);
    const folded = callbackId.toLowerCase();
    if (seen.has(folded)) fail("shortcuts callbackId values must be unique case-insensitively.");
    seen.add(folded);
    return Object.freeze({
      callbackId,
      ...parseConfiguredAction(input, `shortcuts[${index}]`, allowedChannelIds, allowAllChannels),
    });
  }));
}

function parseHomeTab(
  value: unknown,
  allowedChannelIds: readonly string[],
  allowAllChannels: boolean,
): SlackHomeTabConfig {
  const input = value === undefined ? {} : record(value, "homeTab");
  exact(input, ["enabled", "headerText", "buttons"], "homeTab");
  const enabled = bool(input.enabled, "homeTab.enabled", false);
  const headerText = input.headerText === undefined
    ? undefined
    : boundedText(input.headerText, "homeTab.headerText", 3_000);
  const rawButtons = input.buttons === undefined ? [] : input.buttons;
  if (!Array.isArray(rawButtons) || rawButtons.length > MAX_SLACK_HOME_BUTTONS) {
    fail(`homeTab.buttons must be an array with at most ${MAX_SLACK_HOME_BUTTONS} entries.`);
  }
  const seen = new Set<string>();
  const buttons = rawButtons.map((candidate, index): SlackHomeButtonConfig => {
    const button = record(candidate, `homeTab.buttons[${index}]`);
    exact(button, ["actionId", "label", "prompt", "channelId", "ackText", "threadReply"], `homeTab.buttons[${index}]`);
    const configuredActionId = actionId(button.actionId, `homeTab.buttons[${index}].actionId`);
    const folded = configuredActionId.toLowerCase();
    if (seen.has(folded)) fail("homeTab button actionId values must be unique case-insensitively.");
    seen.add(folded);
    return Object.freeze({
      actionId: configuredActionId,
      label: boundedText(button.label, `homeTab.buttons[${index}].label`, 75),
      ...parseConfiguredAction(button, `homeTab.buttons[${index}]`, allowedChannelIds, allowAllChannels),
    });
  });
  if (enabled && headerText === undefined && buttons.length === 0) {
    fail("An enabled homeTab requires headerText or at least one button.");
  }
  return Object.freeze({
    enabled,
    ...(headerText === undefined ? {} : { headerText }),
    buttons: Object.freeze(buttons),
  });
}

function parseConfiguredAction(
  input: Record<string, unknown>,
  label: string,
  allowedChannelIds: readonly string[],
  allowAllChannels: boolean,
): SlackConfiguredAction {
  const prompt = boundedText(input.prompt, `${label}.prompt`, 16_384);
  const channelId = input.channelId === undefined ? undefined : id(input.channelId, `${label}.channelId`);
  if (channelId !== undefined && !allowAllChannels && !allowedChannelIds.includes(channelId)) {
    fail(`${label}.channelId must be authorized by allowedChannelIds.`);
  }
  const ackText = input.ackText === undefined ? undefined : boundedText(input.ackText, `${label}.ackText`, 4_000);
  const threadReply = bool(input.threadReply, `${label}.threadReply`, false);
  if (threadReply && ackText === undefined) fail(`${label}.threadReply requires ackText.`);
  return Object.freeze({
    prompt,
    ...(channelId === undefined ? {} : { channelId }),
    ...(ackText === undefined ? {} : { ackText }),
    threadReply,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void { const allowed = new Set(fields); const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(); if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(", ")}.`); }
function token(value: unknown, label: string, prefix: string): string { if (typeof value !== "string" || value.length < 20 || value.length > 4_096 || !value.startsWith(prefix) || /\s/u.test(value)) fail(`${label} must be a resolved ${prefix} env-only secret.`); return value; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 128 || /\s/u.test(value)) fail(`${label} must be a non-empty identifier.`); return value; }
function actionId(value: unknown, label: string): string {
  const result = id(value, label);
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) fail(`${label} must contain only letters, numbers, underscores, and hyphens.`);
  return result;
}
function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be non-empty text of at most ${max} characters.`);
  }
  return value;
}
function identifiers(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length > 1_000) fail(`${label} must be an array with at most 1000 entries.`); return value.map((entry, index) => id(entry, `${label}[${index}]`)); }
function unique(values: string[], label: string): string[] { const result = [...new Set(values)]; if (result.length !== values.length) fail(`${label} must not contain duplicates.`); return result; }
function bool(value: unknown, label: string, fallback: boolean): boolean { if (value === undefined) return fallback; if (typeof value !== "boolean") fail(`${label} must be a boolean.`); return value; }
function integer(value: unknown, label: string, fallback: number, min: number, max: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} must be an integer from ${min} through ${max}.`); return value as number; }
function fail(message: string): never { throw new SlackConfigError(message); }
