import { createHash, randomBytes } from "node:crypto";

import type { SlackChannelId, SlackMessageTs } from "./types.js";

export interface SlackRuntimeEffortOption {
  readonly value: string;
  readonly label: string;
}

export interface SlackRuntimeModelOption {
  readonly value: string;
  readonly label: string;
  readonly efforts: readonly SlackRuntimeEffortOption[];
}

/** Display-ready configured runtime choices supplied by the host. */
export interface SlackRuntimeControls {
  readonly defaultModel: string;
  readonly defaultEffort?: string;
  readonly models: readonly SlackRuntimeModelOption[];
}

/** Exact workspace-registered slash command names routed to native runtime controls. */
export interface SlackRuntimeSlashCommands {
  readonly model: string;
  readonly effort: string;
}

export interface SlackRuntimeControlCatalog {
  readonly controls: SlackRuntimeControls;
  readonly modelByValue: ReadonlyMap<string, SlackRuntimeModelOption>;
  readonly modelByToken: ReadonlyMap<string, SlackRuntimeModelOption>;
  readonly modelTokenByValue: ReadonlyMap<string, string>;
  readonly effortByModelToken: ReadonlyMap<string, ReadonlyMap<string, SlackRuntimeEffortOption>>;
}

export interface SlackRuntimeScope {
  readonly key: string;
  readonly description: "this DM" | "this thread" | "this channel";
  /** Shared-channel thread scopes inherit a channel-wide slash-command choice. */
  readonly inheritedKey?: string;
}

export interface SlackRuntimeCommandTarget {
  readonly channelId: SlackChannelId;
  readonly threadTs?: SlackMessageTs;
  readonly scope: SlackRuntimeScope;
  readonly resetCommand: string;
}

export interface SlackRuntimeMenuContext {
  readonly control: "model" | "effort";
  readonly scope: SlackRuntimeScope;
  readonly channelId: SlackChannelId;
  readonly messageTs: SlackMessageTs;
  readonly resetCommand: string;
  readonly expectedModel?: string;
}

export const SLACK_STATIC_SELECT_MAX_OPTIONS = 100;
export const SLACK_OPTION_TEXT_MAX_CODE_POINTS = 75;
export const MODEL_SELECT_ACTION_ID = "mono_agent_runtime_model";
export const MODEL_CANCEL_ACTION_ID = "mono_agent_runtime_model_cancel";
export const EFFORT_SELECT_ACTION_ID = "mono_agent_runtime_effort";
export const EFFORT_CANCEL_ACTION_ID = "mono_agent_runtime_effort_cancel";
const RUNTIME_CALLBACK_TOKEN_LENGTH = 16;

export function buildSlackRuntimeControlCatalog(
  input: SlackRuntimeControls | undefined,
): SlackRuntimeControlCatalog | undefined {
  if (input === undefined) return undefined;
  const defaultModel = input.defaultModel.trim();
  if (defaultModel.length === 0) {
    throw new TypeError("Slack runtimeControls.defaultModel must be a non-empty string.");
  }
  const models: SlackRuntimeModelOption[] = [];
  const modelByValue = new Map<string, SlackRuntimeModelOption>();
  for (const rawModel of input.models) {
    const value = rawModel.value.trim();
    const label = rawModel.label.trim();
    if (value.length === 0 || label.length === 0) {
      throw new TypeError("Slack runtimeControls models require non-empty value and label strings.");
    }
    if (modelByValue.has(value)) {
      throw new TypeError(`Slack runtimeControls contains duplicate model ${value}.`);
    }
    const effortValues = new Set<string>();
    const efforts = rawModel.efforts.map((rawEffort) => {
      const effortValue = rawEffort.value.trim();
      const effortLabel = rawEffort.label.trim();
      if (effortValue.length === 0 || effortLabel.length === 0) {
        throw new TypeError("Slack runtimeControls efforts require non-empty value and label strings.");
      }
      if (effortValues.has(effortValue)) {
        throw new TypeError(`Slack runtimeControls contains duplicate effort ${effortValue} for ${value}.`);
      }
      effortValues.add(effortValue);
      return { value: effortValue, label: effortLabel };
    });
    const model = { value, label, efforts };
    models.push(model);
    modelByValue.set(value, model);
  }
  if (!modelByValue.has(defaultModel)) {
    throw new TypeError("Slack runtimeControls.defaultModel must appear in runtimeControls.models.");
  }
  const defaultEffort = input.defaultEffort?.trim();
  if (input.defaultEffort !== undefined && defaultEffort?.length === 0) {
    throw new TypeError("Slack runtimeControls.defaultEffort must be non-empty when provided.");
  }
  const controls: SlackRuntimeControls = {
    defaultModel,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    models,
  };
  const modelByToken = new Map<string, SlackRuntimeModelOption>();
  const modelTokenByValue = new Map<string, string>();
  const effortByModelToken = new Map<string, ReadonlyMap<string, SlackRuntimeEffortOption>>();
  const callbackSalt = randomBytes(16);
  for (const model of models) {
    const modelToken = slackRuntimeCallbackToken(callbackSalt, `model:${model.value}`);
    if (modelByToken.has(modelToken)) {
      throw new TypeError("Slack runtimeControls model callback token collision.");
    }
    modelByToken.set(modelToken, model);
    modelTokenByValue.set(model.value, modelToken);
    const efforts = new Map<string, SlackRuntimeEffortOption>();
    for (const effort of model.efforts) {
      const effortToken = slackRuntimeCallbackToken(callbackSalt, `effort:${model.value}:${effort.value}`);
      if (efforts.has(effortToken)) {
        throw new TypeError("Slack runtimeControls effort callback token collision.");
      }
      efforts.set(effortToken, effort);
    }
    effortByModelToken.set(modelToken, efforts);
  }
  return { controls, modelByValue, modelByToken, modelTokenByValue, effortByModelToken };
}

function slackRuntimeCallbackToken(salt: Uint8Array, value: string): string {
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, RUNTIME_CALLBACK_TOKEN_LENGTH);
}

export function buildSlackRuntimeSlashCommandMap(
  input: SlackRuntimeSlashCommands | undefined,
): ReadonlyMap<string, "model" | "effort"> {
  const commands = new Map<string, "model" | "effort">();
  if (input === undefined) return commands;
  for (const control of ["model", "effort"] as const) {
    const command = normalizeSlackSlashCommand(input[control]);
    if (command === undefined) {
      throw new TypeError(
        `Slack runtimeSlashCommands.${control} must be a slash-prefixed command up to 32 characters.`,
      );
    }
    if (commands.has(command)) {
      throw new TypeError("Slack runtimeSlashCommands model and effort commands must be distinct.");
    }
    commands.set(command, control);
  }
  return commands;
}

export function normalizeSlackSlashCommand(value: string): string | undefined {
  const command = value.trim().toLowerCase();
  return /^\/[a-z0-9][a-z0-9_-]{0,30}$/u.test(command) ? command : undefined;
}

export function isSlackDirectMessageChannel(channelId: SlackChannelId): boolean {
  return channelId.trim().toUpperCase().startsWith("D");
}

export function slackRuntimeModelPresentation(model: SlackRuntimeModelOption): {
  readonly label: string;
  readonly description?: string;
} {
  if (model.label !== model.value) return { label: model.label, description: model.value };
  const segments = model.value.split(":");
  const label = segments.at(-1) ?? model.value;
  return segments.length > 1 ? { label, description: model.value } : { label };
}

export interface SlackSelectOption {
  readonly text: { readonly type: "plain_text"; readonly text: string; readonly emoji: false };
  readonly value: string;
  readonly description?: {
    readonly type: "plain_text";
    readonly text: string;
    readonly emoji: false;
  };
}

export function slackSelectOption(label: string, value: string, description?: string): SlackSelectOption {
  return {
    text: {
      type: "plain_text",
      text: slackTruncateCodePoints(label, SLACK_OPTION_TEXT_MAX_CODE_POINTS),
      emoji: false,
    },
    value,
    ...(description === undefined
      ? {}
      : {
          description: {
            type: "plain_text" as const,
            text: slackTruncateCodePoints(description, SLACK_OPTION_TEXT_MAX_CODE_POINTS),
            emoji: false as const,
          },
        }),
  };
}

export function runtimeMenuBlocks(input: {
  readonly text: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly cancelActionId: string;
  readonly placeholder: string;
  readonly options: readonly SlackSelectOption[];
  readonly initialOption: SlackSelectOption | undefined;
}): readonly unknown[] {
  const select = {
    type: "static_select",
    action_id: input.actionId,
    placeholder: { type: "plain_text", text: input.placeholder, emoji: false },
    options: input.options,
    ...(input.initialOption === undefined ? {} : { initial_option: input.initialOption }),
  };
  return [
    {
      type: "section",
      text: {
        type: "plain_text",
        text: slackTruncateCodePoints(input.text, 3_000),
        emoji: false,
      },
    },
    {
      type: "actions",
      block_id: input.blockId,
      elements: [
        select,
        {
          type: "button",
          action_id: input.cancelActionId,
          text: { type: "plain_text", text: "Cancel", emoji: false },
          value: "cancel",
        },
      ],
    },
  ];
}

export function slackTruncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function runtimeControlForActionId(actionId: string): "model" | "effort" | undefined {
  if (actionId === MODEL_SELECT_ACTION_ID || actionId === MODEL_CANCEL_ACTION_ID) return "model";
  if (actionId === EFFORT_SELECT_ACTION_ID || actionId === EFFORT_CANCEL_ACTION_ID) return "effort";
  return undefined;
}

export function slackRuntimeMenuKey(channelId: SlackChannelId, messageTs: SlackMessageTs): string {
  return `${channelId.trim().toLowerCase()}:${messageTs}`;
}

export function slackActiveRuntimeMenuKey(
  scope: SlackRuntimeScope,
  control: "model" | "effort",
): string {
  return `${scope.key}:${control}`;
}
