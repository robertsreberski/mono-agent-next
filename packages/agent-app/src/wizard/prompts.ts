import * as p from "@clack/prompts";
import { MAX_AGENT_NAME_LENGTH } from "@mono-agent/config";

import type { EffortLevel } from "@mono-agent/config";

import { findModule, modulesByKind } from "../modules/catalog.js";
import {
  ADAPTER_SEND_TOOL_NAMES,
  APP_TOOL_NAMES,
  BUILTIN_TOOL_NAMES,
} from "../modules/known-tools.js";
import { STATIC_MODEL_CANDIDATES, type WizardModelCandidate } from "./model-discovery.js";
import { PRESET_CATALOG } from "./presets.js";

/**
 * One `@clack/prompts` `select`/`multiselect` option. `value` is the machine key
 * the wizard maps back onto {@link WizardAnswers}; `label`/`hint` are display-only.
 */
export interface WizardSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/** Keep large catalogs navigable without hiding any searchable row. */
export const MODEL_AUTOCOMPLETE_MAX_ITEMS = 10;

export const CUSTOM_PI_MODEL_OPTION = "__pi_manual__";

const WIZARD_MODEL_SENTINELS = new Set([
  "__pi_other__",
  "__other__",
  "__done__",
  CUSTOM_PI_MODEL_OPTION,
]);

/**
 * Thrown when a clack prompt returns its cancel symbol (Ctrl-C / Esc). The wizard
 * catches it once at the top and turns it into a clean `p.cancel` — nothing is
 * ever written, because {@link runInitWizard} only collects answers.
 */
export class WizardCancelled extends Error {
  constructor() {
    super("Wizard cancelled.");
    this.name = "WizardCancelled";
  }
}

/** Escape requests one logical step back; Ctrl-C requests an exit confirmation. */
export class WizardBack extends Error {
  constructor() {
    super("Go back one wizard step.");
    this.name = "WizardBack";
  }
}

export class WizardExitRequested extends Error {
  constructor() {
    super("Confirm wizard exit.");
    this.name = "WizardExitRequested";
  }
}

export interface WizardKey {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/** Pure key classifier used by the scoped production observer and tests. */
export function wizardCancelIntentForKey(key: WizardKey): "back" | "exit" | undefined {
  if (key.name === "escape") return "back";
  if (key.ctrl === true && key.name === "c") return "exit";
  return undefined;
}

/** Pure back transition: `undefined` means the user is already at the first step. */
export function previousWizardStep(step: number): number | undefined {
  return step > 0 ? step - 1 : undefined;
}

/**
 * Unwrap a clack prompt result: return the value, or throw {@link WizardCancelled}
 * when the user cancelled (clack signals cancel with a sentinel symbol). Every
 * prompt result must pass through here so a single top-level catch handles cancel.
 */
export function guard<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    throw new WizardCancelled();
  }
  return value;
}

/** Folder/public-name validation mirrors the config loader's 80-code-point contract. */
export function validateWizardAgentName(value: string | undefined): string | undefined {
  const name = (value ?? "").trim();
  const length = Array.from(name).length;
  if (length === 0 || length > MAX_AGENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    return `Enter a single-line name between 1 and ${MAX_AGENT_NAME_LENGTH} characters.`;
  }
  return undefined;
}

export const MAX_AGENT_PURPOSE_LENGTH = 240;

/** One short, printable role statement for the generated Identity. */
export function validateWizardAgentPurpose(value: string | undefined): string | undefined {
  const purpose = (value ?? "").trim();
  const length = Array.from(purpose).length;
  if (
    length === 0
    || length > MAX_AGENT_PURPOSE_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(purpose)
  ) {
    return `Enter one line between 1 and ${MAX_AGENT_PURPOSE_LENGTH} characters.`;
  }
  return undefined;
}

/** Human hints for the built-in tools, shown beside each tool in the multiselect. */
const BUILTIN_TOOL_HINTS: Readonly<Record<string, string>> = {
  Read: "read files",
  Write: "create/overwrite files",
  Edit: "edit files",
  Glob: "find files by pattern",
  Grep: "search file contents",
  Bash: "run shell commands (pair with the sandbox)",
  NodeRepl: "execute JavaScript in a run-scoped Node REPL",
  WebFetch: "fetch a URL",
  WebSearch: "search the web",
};

const APP_TOOL_HINTS: Readonly<Record<string, string>> = {
  RunHistory: "inspect safe evidence from prior runs in this conversation",
};

const ADAPTER_SEND_TOOL_SET: ReadonlySet<string> = new Set(ADAPTER_SEND_TOOL_NAMES);

/**
 * The action each adapter send tool performs; the owning channel's title is appended
 * so the hint reads e.g. `proactive send (Telegram)`. Keyed by PascalCase tool name.
 */
const ADAPTER_SEND_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  SlackSendMessage: "proactive send",
  TelegramSendMessage: "proactive send",
  TelegramSendFile: "send a document or photo",
};

/**
 * The channel-agnostic interaction tool. Always offered (even for a restricted
 * agent), but its built-in presentation sinks are web, Slack, and Telegram.
 */
const ASK_USER_OPTION: WizardSelectOption = {
  value: "AskUser",
  label: "AskUser",
  hint: "ask structured questions and wait (web, Slack, or Telegram)",
};

/**
 * Channel options for the "how will you talk to this agent?" multiselect: every
 * channel module in catalog order (webhook first), value = module id.
 */
export function channelSelectOptions(options: { readonly readyOnly?: boolean } = {}): WizardSelectOption[] {
  return modulesByKind("channel").filter((module) => options.readyOnly !== true || module.wizardSelectable !== false).map((module) => ({
    value: module.id,
    label: module.title,
    hint: module.summary,
  }));
}

/**
 * Memory options: a leading "None (stateless)" whose empty-string value maps to
 * `memory: undefined`, then every memory module in catalog order.
 */
export function memorySelectOptions(
  options: { readonly includeOptionalPlugins?: boolean } = {},
): WizardSelectOption[] {
  return [
    { value: "", label: "None (stateless)", hint: "no cross-conversation memory" },
    ...modulesByKind("memory").filter((module) =>
      module.wizardSelectable !== false
      || (options.includeOptionalPlugins === true && module.id === "memory:supermemory")
    ).map((module) => ({
      value: module.id,
      label: module.title,
      hint: module.summary,
    })),
  ];
}

/**
 * A discovered/ranked model menu plus explicit escape hatches for Pi provider
 * refs and generic full model refs.
 */
export function modelSelectOptions(
  candidates: readonly WizardModelCandidate[] = STATIC_MODEL_CANDIDATES,
  authoredModel?: string,
): WizardSelectOption[] {
  const authored = authoredModel !== undefined
    && !WIZARD_MODEL_SENTINELS.has(authoredModel)
    && !candidates.some((candidate) => candidate.value === authoredModel)
      ? [{ value: authoredModel, label: authoredModel, hint: "current authored model; provider-default effort" }]
      : [];
  return [
    ...authored,
    ...candidates.map((candidate) => ({
      value: candidate.value,
      label: candidate.label,
      ...(candidate.hint === undefined ? {} : { hint: candidate.hint }),
    })),
    { value: "__pi_other__", label: "Other Pi model…", hint: "choose provider and model id" },
    { value: "__other__", label: "Other model ref…", hint: "type a full sdk:model reference" },
  ];
}

/**
 * The Pi-specific "Other Pi model" submenu. Discovered Pi candidates are offered
 * first when available; the final option is the explicit manual provider/model
 * escape hatch.
 */
export function piModelSelectOptions(
  candidates: readonly WizardModelCandidate[] = STATIC_MODEL_CANDIDATES,
  excludedModels: readonly string[] = [],
): WizardSelectOption[] {
  const excluded = new Set(excludedModels);
  return [
    ...candidates
      .filter((candidate) => candidate.value.startsWith("pi:") && !excluded.has(candidate.value))
      .map((candidate) => ({
        value: candidate.value,
        label: candidate.label,
        ...(candidate.hint === undefined ? {} : { hint: candidate.hint }),
      })),
    {
      value: CUSTOM_PI_MODEL_OPTION,
      label: "Supported Pi provider/model id…",
      hint: "Anthropic, GitHub Copilot, OpenAI Codex, OpenCode-Go, Ollama, or LM Studio",
    },
  ];
}

export function assertConcreteWizardModelRef(value: string): void {
  if (WIZARD_MODEL_SENTINELS.has(value)) {
    throw new Error(`Wizard model sentinel cannot be used as a model reference: ${value}`);
  }
}

/**
 * Fallback model choices use the same labels/hints as the primary model picker,
 * but hide the chosen primary and fallbacks already added to the chain. The Pi
 * and generic custom-reference escape hatches remain available; `Done` finishes
 * the ordered fallback chain.
 */
export function fallbackModelSelectOptions(
  candidates: readonly WizardModelCandidate[] = STATIC_MODEL_CANDIDATES,
  primaryModel: string,
  selectedFallbacks: readonly string[] = [],
): WizardSelectOption[] {
  const excluded = new Set([primaryModel, ...selectedFallbacks]);
  return [
    ...modelSelectOptions(candidates).filter((option) => option.value === "__other__" || !excluded.has(option.value)),
    { value: "__done__", label: "Done", hint: "finish fallback chain" },
  ];
}

/** Reasoning-effort choices. Empty value means no `runtime.effort` is written. */
export function effortSelectOptions(
  supportedEfforts: readonly EffortLevel[] = [],
  defaultEffort?: EffortLevel,
): WizardSelectOption[] {
  return [
    {
      value: "",
      label: "Provider default",
      hint: defaultEffort === undefined
        ? "omit effort for this route"
        : `currently ${defaultEffort}; omit effort for this route`,
    },
    ...supportedEfforts.map((level) => ({ value: level, label: level })),
  ];
}

export const ROUTE_SAFETY_OPTIONS: readonly WizardSelectOption[] = [
  {
    value: "uniform",
    label: "Uniform safety contract",
    hint: "compatibility default; every route must satisfy one common policy",
  },
  {
    value: "per-route-native",
    label: "Per-route native safety",
    hint: "each provider keeps its explicit native tool and sandbox contract",
  },
];

/** Exact per-route contract shown before accepting a mixed/provider-native chain. */
export function routeSafetyContract(model: string, managedSrt: boolean): string {
  if (model.startsWith("pi:")) {
    return managedSrt
      ? "Pi: mono-agent managed SRT + mono-agent tool policy"
      : "Pi: mono-agent tool policy; managed SRT disabled";
  }
  if (model.startsWith("claude:")) {
    return "Claude: provider-native sandbox; representable tool restrictions only; mono-agent SRT is not applied";
  }
  if (model.startsWith("codex:")) {
    return "Codex: Codex-native sandbox + exact allow-all; mono-agent SRT/tool allowlist is not applied";
  }
  if (model.startsWith("opencode:")) {
    return "OpenCode: provider-native sandbox + exact allow-all; unsupported capabilities skip this route";
  }
  return "Custom runtime: provider-native policy; unsupported capabilities skip this route";
}

export function formatRouteSafetyMatrix(
  primary: { readonly model: string; readonly effort?: string },
  fallbacks: readonly { readonly model: string; readonly effort?: string }[],
  managedSrt: boolean,
): string {
  return [primary, ...fallbacks].map((route, index) =>
    `${index === 0 ? "Primary" : `Fallback ${index}`}: ${route.model} [${route.effort ?? "provider default"}]\n  ${routeSafetyContract(route.model, managedSrt)}`,
  ).join("\n");
}

export function routeFamilies(models: readonly string[]): readonly string[] {
  return [...new Set(models.map((model) =>
    model.startsWith("pi:") ? "pi"
      : model.startsWith("claude:") ? "claude"
        : model.startsWith("codex:") ? "codex"
          : model.startsWith("opencode:") ? "opencode"
            : "custom",
  ))];
}

export function isMixedRouteChain(models: readonly string[]): boolean {
  return routeFamilies(models).length > 1;
}

export function creationReviewOptions(options: { readonly setupRequired: boolean }): WizardSelectOption[] {
  return [
    {
      value: "create",
      label: options.setupRequired
        ? "Run setup and readiness checks, then create agent"
        : "Run readiness checks, then create agent",
    },
    { value: "edit", label: "Edit choices" },
    { value: "cancel", label: "Cancel without writing" },
  ];
}

/**
 * The "choose specific" tools multiselect: runtime built-ins first, then app-owned
 * policy-gated tools, adapter send tools contributed by the selected channels
 * (deduped, in channel order), and finally the channel-agnostic `AskUser`.
 */
export function toolMultiselectOptions(selectedChannelIds: readonly string[]): WizardSelectOption[] {
  const options: WizardSelectOption[] = BUILTIN_TOOL_NAMES.map((name) => ({
    value: name,
    label: name,
    ...(BUILTIN_TOOL_HINTS[name] === undefined ? {} : { hint: BUILTIN_TOOL_HINTS[name] }),
  }));

  options.push(...APP_TOOL_NAMES.map((name) => ({
    value: name,
    label: name,
    ...(APP_TOOL_HINTS[name] === undefined ? {} : { hint: APP_TOOL_HINTS[name] }),
  })));

  const seen = new Set<string>([...BUILTIN_TOOL_NAMES, ...APP_TOOL_NAMES]);
  for (const channelId of selectedChannelIds) {
    const module = findModule(channelId);
    if (module === undefined) {
      continue;
    }
    for (const tool of module.recommendedTools ?? []) {
      // `AskUser` is channel-agnostic and appended once at the end, not per channel.
      if (!ADAPTER_SEND_TOOL_SET.has(tool) || seen.has(tool) || tool === "AskUser") {
        continue;
      }
      seen.add(tool);
      const action = ADAPTER_SEND_TOOL_ACTIONS[tool] ?? "channel action";
      options.push({ value: tool, label: tool, hint: `${action} (${module.title})` });
    }
  }

  options.push(ASK_USER_OPTION);
  return options;
}

/**
 * The "start from…" menu: every preset (labelled with its risk + description),
 * ending with a "Custom" escape hatch that walks the full step-by-step flow.
 */
export function presetSelectOptions(): WizardSelectOption[] {
  return [
    ...PRESET_CATALOG.map((preset) => ({
      value: preset.id,
      label: preset.title,
      hint: `${preset.riskLevel} · ${preset.description}`,
    })),
    { value: "__custom__", label: "Custom — pick capabilities yourself" },
  ];
}
