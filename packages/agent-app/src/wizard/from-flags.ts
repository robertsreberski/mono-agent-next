import type { EffortLevel, RouteSafetyMode } from "@mono-agent/config";

import { defaultAnswers, type WizardAnswers, type WizardFallback } from "./answers.js";
import { findPreset } from "./presets.js";
import { assertConcreteWizardModelRef, validateWizardAgentName } from "./prompts.js";

/** Channels `mono-agent init --with <csv>` can switch on, by their short flag name. */
export const WITH_CHANNELS = ["telegram", "slack", "webhook", "openaiApi", "cron"] as const;
export type WithChannel = (typeof WITH_CHANNELS)[number];

/** True when `value` is a `--with` channel flag name. */
export function isWithChannel(value: string): value is WithChannel {
  return (WITH_CHANNELS as readonly string[]).includes(value);
}

/** `--with <channel>` flag → the capability-module id that enables it. */
const WITH_CHANNEL_MODULE_ID: Record<WithChannel, string> = {
  telegram: "channel:telegram",
  slack: "channel:slack",
  webhook: "channel:webhook",
  openaiApi: "channel:openai-api",
  cron: "channel:cron",
};

/** The non-interactive `init`/preset flags, before they are mapped onto answers. */
export interface AnswersFromCliArgs {
  readonly name?: string;
  readonly model?: string;
  readonly fallbacks?: readonly { readonly model: string; readonly effort?: EffortLevel }[];
  readonly routeSafety?: RouteSafetyMode;
  readonly effort?: string;
  readonly memory?: "lite" | "journal" | "bujo";
  /** Validated `--with` channel flag names (see {@link WithChannel}). */
  readonly withChannels?: readonly string[];
  /** Preset id whose answers seed the base selection (already validated by the caller). */
  readonly presetId?: string;
}

/**
 * Map the non-interactive `init` flags (and an optional preset) onto full wizard
 * answers, running once through the single {@link defaultAnswers} path so
 * `allowedTools` is recomputed from the final capability selection. A preset seeds
 * the base answers (its partial, so it never pins tools); each explicit flag
 * overrides that; `--with` channels are unioned onto the preset/default channels.
 * The caller resolves an unknown `presetId` and errors before calling this.
 */
export function answersFromCli(args: AnswersFromCliArgs): WizardAnswers {
  const basePartial: Partial<WizardAnswers> = args.presetId === undefined
    ? {}
    : findPreset(args.presetId)?.answers ?? {};
  const model = args.model === undefined ? undefined : concreteCliModelRef(args.model);
  const fallbacks: readonly WizardFallback[] | undefined = args.fallbacks?.map((fallback) => ({
    model: concreteCliModelRef(fallback.model),
    ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
  }));
  const name = args.name?.trim();
  if (args.name !== undefined) {
    const problem = validateWizardAgentName(args.name);
    if (problem !== undefined) throw new Error(problem);
  }

  const primaryModel = model ?? basePartial.model ?? defaultAnswers().model;
  const selectedFallbacks = fallbacks ?? [];
  const seen = new Set([primaryModel]);
  for (const fallback of selectedFallbacks) {
    if (seen.has(fallback.model)) {
      throw new Error(`Duplicate model route in init flags: ${fallback.model}`);
    }
    seen.add(fallback.model);
  }

  const channels = new Set<string>(basePartial.channels ?? defaultAnswers().channels);
  for (const channel of args.withChannels ?? []) {
    if (isWithChannel(channel)) {
      channels.add(WITH_CHANNEL_MODULE_ID[channel]);
    }
  }

  const memory = args.memory === undefined ? basePartial.memory : `memory:${args.memory}`;

  return defaultAnswers({
    ...basePartial,
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { model }),
    ...(fallbacks === undefined ? {} : { fallbacks }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.routeSafety === undefined ? {} : { routeSafety: args.routeSafety }),
    channels: [...channels],
    ...(memory === undefined ? {} : { memory }),
  });
}

function concreteCliModelRef(value: string): string {
  assertConcreteWizardModelRef(value);
  return value;
}
