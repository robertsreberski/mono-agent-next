import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { emitKeypressEvents } from "node:readline";

import * as p from "@clack/prompts";
import type { EffortLevel, RouteSafetyMode } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import { findModule } from "../modules/catalog.js";
import { hasSensitivePersistedEnvironmentValue } from "../first-run-readiness.js";
import {
  DEFAULT_MEMORY_EMBEDDING_ENDPOINTS,
  discoverMemoryEmbeddingModels,
  memoryEmbeddingEndpointProblem,
  type ManagedMemoryEmbeddingProvider,
  probeMemoryEmbeddingSelection,
} from "../memory-embedding-service.js";
import { DEFAULT_MODEL } from "../modules/base.js";
import {
  ADAPTER_SEND_TOOL_NAMES,
  ALLOW_ALL_TOOLS,
  isAllowAllTools,
} from "../modules/known-tools.js";
import {
  hasDurableProviderEnvironmentCredential,
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
  providerSetupActionCommandLine,
  type ProviderCredentialState,
} from "../provider-setup.js";
import { isSupermemoryPluginInstalled } from "../supermemory-plugin.js";
import {
  alwaysOnTools,
  composeWizardPlan,
  defaultAnswers,
  effectiveFallbacks,
  humanizeAgentName,
  recommendedToolSelection,
  referencedSetupModelRefs,
  type WizardAnswers,
  type WizardPlan,
} from "./answers.js";
import { findPreset, presetAnswers } from "./presets.js";
import {
  assertConcreteWizardModelRef,
  channelSelectOptions,
  creationReviewOptions,
  CUSTOM_PI_MODEL_OPTION,
  effortSelectOptions,
  fallbackModelSelectOptions,
  formatRouteSafetyMatrix,
  isMixedRouteChain,
  memorySelectOptions,
  MODEL_AUTOCOMPLETE_MAX_ITEMS,
  modelSelectOptions,
  piModelSelectOptions,
  presetSelectOptions,
  ROUTE_SAFETY_OPTIONS,
  toolMultiselectOptions,
  validateWizardAgentName,
  validateWizardAgentPurpose,
  wizardCancelIntentForKey,
  WizardBack,
  WizardCancelled,
  WizardExitRequested,
} from "./prompts.js";
import {
  discoverWizardModelCandidates,
  formatModelDiscoveryStatus,
  guidedPiProviderProblem,
  type ModelDiscoveryResult,
  type WizardModelCandidate,
} from "./model-discovery.js";

/** The outcome of a wizard run: collected answers, or a clean cancellation. */
export type WizardOutcome =
  | {
      readonly status: "answers";
      readonly answers: WizardAnswers;
      readonly runProviderSetup: boolean;
      readonly providerSetupSecrets: Readonly<Record<string, string>>;
      readonly providerEnvironmentSecrets: Readonly<Record<string, string>>;
      readonly piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">>;
      readonly credentialStates: Readonly<Record<string, ProviderCredentialState>>;
      /** Required selected module secrets, kept in memory until secure init persists them. */
      readonly moduleSecrets: Readonly<Record<string, string>>;
    }
  | { readonly status: "cancelled" };

/** Context supplied by the CLI after it has resolved paths and parsed `.env`. */
export interface WizardRunContext {
  readonly cwd: string;
  readonly piAuthPath?: string;
  /** Values parsed from the destination `.env`; shell-only values must not be supplied here. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
}

/** Ephemeral setup state retained while the CLI repairs a pre-write plan. */
export interface SetupRepairRunContext extends WizardRunContext {
  /** Optional focused edit step; omitted starts at Creation review. */
  readonly initialStep?: number;
  readonly answers: WizardAnswers;
  readonly runProviderSetup: boolean;
  readonly providerSetupSecrets: Readonly<Record<string, string>>;
  readonly providerEnvironmentSecrets: Readonly<Record<string, string>>;
  readonly piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">>;
  readonly credentialStates: Readonly<Record<string, ProviderCredentialState>>;
  readonly moduleSecrets: Readonly<Record<string, string>>;
}

/**
 * A mutable working copy of {@link WizardAnswers} the flow builds up prompt by
 * prompt. `memory` stays `string | undefined` here (unlike the exact-optional
 * `WizardAnswers`); {@link toWizardAnswers} folds `undefined` into an absent key.
 */
interface DraftAnswers {
  name: string;
  purpose: string;
  model: string;
  fallbacks: Array<{ model: string; effort?: string }>;
  effort: string | undefined;
  routeSafety: RouteSafetyMode;
  credentialStates: Record<string, ProviderCredentialState>;
  channels: string[];
  memory: string | undefined;
  sandbox: boolean;
  observability: boolean;
  allowedTools: string[];
  moduleInputs: Record<string, Record<string, string>>;
}

const SANDBOXABLE_TOOLS = new Set(["Bash", "Write", "Edit", "NodeRepl"]);
const MANAGED_MEMORY_MODULE_IDS = new Set(["memory:journal", "memory:bujo"]);
const MANUAL_EMBEDDING_MODEL = "__manual_embedding_model__";

type PromptResult<T> = Promise<T | symbol>;

/**
 * Clack intentionally coalesces Escape and Ctrl-C into one cancel sentinel. The
 * wizard owns a scoped keypress observer so the state machine can interpret
 * Escape as Back and Ctrl-C as Exit without changing Clack globally.
 */
async function runPrompt<T>(invoke: () => PromptResult<T>): Promise<T> {
  let intent: "back" | "exit" | undefined;
  const input = process.stdin;
  const listener = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
    intent = wizardCancelIntentForKey(key) ?? intent;
  };
  if (input.isTTY) {
    emitKeypressEvents(input);
    input.on("keypress", listener);
  }
  try {
    const value = await invoke();
    if (!p.isCancel(value)) return value;
    if (intent === "back") throw new WizardBack();
    throw new WizardExitRequested();
  } finally {
    if (input.isTTY) input.off("keypress", listener);
  }
}

async function discoverModelsInterruptibly(
  options: Parameters<typeof discoverWizardModelCandidates>[0],
): Promise<ModelDiscoveryResult> {
  const controller = new AbortController();
  let intent: "back" | "exit" | undefined;
  const input = process.stdin as typeof process.stdin & {
    readonly isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  const interrupt = (nextIntent: "back" | "exit"): void => {
    intent ??= nextIntent;
    controller.abort();
  };
  const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
    const nextIntent = wizardCancelIntentForKey(key);
    if (nextIntent !== undefined) interrupt(nextIntent);
  };
  const onSigint = (): void => interrupt("exit");
  if (input.isTTY) {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    input.on("keypress", onKeypress);
  }
  process.on("SIGINT", onSigint);
  try {
    const result = await discoverWizardModelCandidates({
      ...options,
      abortSignal: controller.signal,
    });
    if (!controller.signal.aborted) return result;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", onSigint);
    if (input.isTTY) {
      input.off("keypress", onKeypress);
      input.setRawMode?.(wasRaw);
      if (wasFlowing !== true) input.pause();
    }
  }
  if (intent === "back") throw new WizardBack();
  throw new WizardExitRequested();
}

async function select<T>(options: Parameters<typeof p.select<T>>[0]): Promise<T> {
  return runPrompt(() => p.select(options));
}

async function autocomplete<T>(options: Parameters<typeof p.autocomplete<T>>[0]): Promise<T> {
  return runPrompt(() => p.autocomplete(options));
}

async function confirm(options: Parameters<typeof p.confirm>[0]): Promise<boolean> {
  return runPrompt(() => p.confirm(options));
}

async function multiselect<T>(options: Parameters<typeof p.multiselect<T>>[0]): Promise<T[]> {
  return runPrompt(() => p.multiselect(options));
}

async function textPrompt(options: Parameters<typeof p.text>[0]): Promise<string> {
  return runPrompt(() => p.text(options));
}

async function passwordPrompt(options: Parameters<typeof p.password>[0]): Promise<string> {
  return runPrompt(() => p.password(options));
}

interface ModelResolutionOptions {
  readonly candidates: readonly WizardModelCandidate[];
  readonly excludedModels?: readonly string[];
  readonly context: "primary" | "fallback";
}

interface CollectedAnswers {
  readonly answers: WizardAnswers;
  readonly runProviderSetup: boolean;
  readonly providerSetupSecrets: Readonly<Record<string, string>>;
  readonly providerEnvironmentSecrets: Readonly<Record<string, string>>;
  readonly piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">>;
  readonly credentialStates: Readonly<Record<string, ProviderCredentialState>>;
  readonly moduleSecrets: Readonly<Record<string, string>>;
}

interface InteractiveCollectionOptions {
  readonly initialStep?: number;
  readonly initialReturnToReviewStep?: number;
  readonly returnToCallerOnReviewBack?: boolean;
  readonly repairState?: SetupRepairRunContext;
}

/**
 * The interactive `init` wizard: a colourful, step-by-step flow that COLLECTS a
 * {@link WizardAnswers} and hands it back — it never writes anything. The caller
 * (`runInit`) does the scaffold/validate/print. Ctrl-C at any prompt unwinds
 * through {@link WizardCancelled} to a single clean `p.cancel`, so a cancelled
 * wizard leaves the folder untouched.
 */
export async function runInitWizard(ctx: WizardRunContext): Promise<WizardOutcome> {
  try {
    const result = await collectAnswers(ctx);
    return {
      status: "answers",
      answers: result.answers,
      runProviderSetup: result.runProviderSetup,
      providerSetupSecrets: result.providerSetupSecrets,
      providerEnvironmentSecrets: result.providerEnvironmentSecrets,
      piApiKeyPersistenceByProvider: result.piApiKeyPersistenceByProvider,
      credentialStates: result.credentialStates,
      moduleSecrets: result.moduleSecrets,
    };
  } catch (error) {
    if (error instanceof WizardCancelled) {
      p.cancel("Cancelled — nothing was written.");
      return { status: "cancelled" };
    }
    throw error;
  }
}

/**
 * Re-open an already reviewed setup at the Creation review. The caller keeps
 * ownership of the original state: Escape returns `cancelled`, and no mutable
 * credential or answer state is exposed unless the operator confirms a repair.
 */
export async function runSetupRepairWizard(ctx: SetupRepairRunContext): Promise<WizardOutcome> {
  try {
    p.log.step("Repair setup choices");
    const initialStep = ctx.initialStep ?? 8;
    const result = await collectInteractiveFromSeed(ctx, ctx.answers, {
      initialStep,
      ...(initialStep === 8 ? {} : { initialReturnToReviewStep: initialStep }),
      returnToCallerOnReviewBack: true,
      repairState: ctx,
    });
    return {
      status: "answers",
      answers: result.answers,
      runProviderSetup: result.runProviderSetup,
      providerSetupSecrets: result.providerSetupSecrets,
      providerEnvironmentSecrets: result.providerEnvironmentSecrets,
      piApiKeyPersistenceByProvider: result.piApiKeyPersistenceByProvider,
      credentialStates: result.credentialStates,
      moduleSecrets: result.moduleSecrets,
    };
  } catch (error) {
    if (error instanceof WizardBack || error instanceof WizardCancelled) {
      p.log.info("Returning to the preflight recovery menu; previous setup choices were kept.");
      return { status: "cancelled" };
    }
    throw error;
  }
}

/** Walk the flow (preset or custom), returning the fully collected answers. */
async function collectAnswers(ctx: WizardRunContext): Promise<CollectedAnswers> {
  p.intro("mono-agent init — let's build your agent");

  for (;;) {
    let choice: string;
    try {
      choice = await select({
        message: "Start from…",
        options: presetSelectOptions(),
        initialValue: "__custom__",
      });
    } catch (error) {
      if (error instanceof WizardBack || error instanceof WizardExitRequested) {
        if (await confirmExitSetup()) throw new WizardCancelled();
        continue;
      }
      throw error;
    }

    try {
      return choice === "__custom__"
        ? await collectCustom(ctx)
        : await collectFromPreset(ctx, choice);
    } catch (error) {
      // Escape from the first detail step returns to the preset chooser. Ctrl-C
      // is handled inside the detail state machine and should not normally leak.
      if (error instanceof WizardBack) continue;
      if (error instanceof WizardExitRequested) {
        if (await confirmExitSetup()) throw new WizardCancelled();
        continue;
      }
      throw error;
    }
  }
}

/**
 * The full custom flow: model → effort → channels → memory → per-module inputs
 * → tools → sandbox (only if code tools were chosen) → observability → summary.
 */
async function collectCustom(ctx: WizardRunContext): Promise<CollectedAnswers> {
  return await collectInteractiveFromSeed(ctx, defaultAnswers({
    name: humanizeAgentName(basename(ctx.cwd)),
  }));
}

async function resolveModelSelection(model: string, opts: ModelResolutionOptions): Promise<string> {
  if (model === "__pi_other__") {
    return await promptPiModelSelection(opts);
  }

  if (model === "__other__") {
    const resolved = (
      await textPrompt({
        message: opts.context === "primary" ? "Model reference" : "Fallback model reference",
        placeholder: "pi:ollama:llama3.1:8b",
        validate: validateFullModelReference,
      })
    ).trim();
    assertConcreteWizardModelRef(resolved);
    assertGuidedModelRef(resolved);
    return resolved;
  }

  assertConcreteWizardModelRef(model);
  assertGuidedModelRef(model);
  return model;
}

async function promptPiModelSelection(opts: ModelResolutionOptions): Promise<string> {
  const options = piModelSelectOptions(opts.candidates, opts.excludedModels ?? []);
  const choice = await autocomplete({
      message: opts.context === "primary" ? "Other Pi model" : "Other Pi fallback model",
      options,
      initialValue: options[0]?.value ?? CUSTOM_PI_MODEL_OPTION,
      placeholder: "Type to search Pi providers and models…",
      maxItems: MODEL_AUTOCOMPLETE_MAX_ITEMS,
    });

  if (choice !== CUSTOM_PI_MODEL_OPTION) {
    assertConcreteWizardModelRef(choice);
    return choice;
  }

  return await promptManualPiModelRef();
}

async function promptManualPiModelRef(): Promise<string> {
  const provider = (
    await textPrompt({
      message: "Pi provider id",
      placeholder: "openai-codex",
      validate: (v) => {
        const value = (v ?? "").trim();
        if (value.length === 0) {
          return "Enter a supported Pi provider id (anthropic, github-copilot, openai-codex, opencode-go, ollama, or lmstudio)";
        }
        if (value.includes(":")) return "Provider id cannot contain ':'.";
        return guidedPiProviderProblem(value);
      },
    })
  ).trim();
  const modelId = (
    await textPrompt({
      message: "Pi model id",
      placeholder: provider === "openai-codex" ? "gpt-5.6-terra" : "llama3.1:8b",
      validate: (v) =>
        (v ?? "").trim().length === 0
          ? "Enter the provider-specific model id (e.g. gpt-5.6-terra, gpt-5.6-sol, kimi-k2.6, llama3.1:8b)"
          : undefined,
    })
  ).trim();
  return `pi:${provider}:${modelId}`;
}

function validateFullModelReference(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    return "Enter a provider:model reference (e.g. pi:ollama:llama3.1:8b)";
  }
  if (trimmed.includes(",")) {
    return "Enter one model reference. Add more fallbacks one at a time.";
  }
  try {
    assertConcreteWizardModelRef(trimmed);
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a concrete model reference.";
  }
  return guidedModelRefProblem(trimmed);
}

function assertGuidedModelRef(model: string): void {
  const problem = guidedModelRefProblem(model);
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

export function guidedModelRefProblem(model: string): string | undefined {
  let parsed;
  try {
    parsed = parseMonoRuntimeModelReference(model);
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a concrete model reference.";
  }
  if (parsed.sdk === "opencode") {
    return "Direct OpenCode is scaffold/config-only. Choose pi:opencode-go:* for guided readiness.";
  }
  if (parsed.sdk === "pi" && parsed.provider !== undefined) {
    return guidedPiProviderProblem(parsed.provider);
  }
  return parsed.sdk === "claude" || parsed.sdk === "codex"
    ? undefined
    : "Guided init supports Claude, Codex, supported Pi providers, and local Pi routes.";
}

/**
 * Build an ordered fallback chain one model at a time. Each step reuses the same
 * discovered model labels as the primary picker while hiding the selected primary
 * and any fallback already chosen. `Other…` is the explicit path for custom refs.
 */
async function promptFallbackModels(
  draft: DraftAnswers,
  candidates: readonly WizardModelCandidate[],
): Promise<void> {
  const byValue = new Map(candidates.map((candidate) => [candidate.value, candidate]));
  for (;;) {
    const selectedModels = draft.fallbacks.map((fallback) => fallback.model);
    let choice: string;
    try {
      choice = await autocomplete({
          message: `Fallback model #${draft.fallbacks.length + 1}`,
          options: fallbackModelSelectOptions(candidates, draft.model, selectedModels),
          initialValue: "__done__",
          placeholder: "Type to search all supported models…",
          maxItems: MODEL_AUTOCOMPLETE_MAX_ITEMS,
        });
    } catch (error) {
      if (!(error instanceof WizardBack) || draft.fallbacks.length === 0) throw error;
      draft.fallbacks.pop();
      continue;
    }
    if (choice === "__done__") {
      return;
    }
    const resolved = await resolveModelSelection(choice, {
      candidates,
      excludedModels: [draft.model, ...selectedModels],
      context: "fallback",
    });
    if (resolved !== draft.model && !selectedModels.includes(resolved)) {
      let effort: EffortLevel | undefined;
      try {
        effort = await promptEffortForModel(resolved, byValue.get(resolved));
      } catch (error) {
        if (error instanceof WizardBack) continue;
        throw error;
      }
      draft.fallbacks.push({ model: resolved, ...(effort === undefined ? {} : { effort }) });
    }
  }
}

/**
 * Presets seed every choice, but do not silently freeze them. A first run must
 * still choose its model, channels, tool policy, and sandbox safety posture.
 */
async function collectFromPreset(ctx: WizardRunContext, presetId: string): Promise<CollectedAnswers> {
  const preset = findPreset(presetId);
  // presetSelectOptions only offers known ids; guard defensively regardless.
  if (preset === undefined) {
    throw new WizardCancelled();
  }
  p.log.step(`Preset: ${preset.title}`);

  return await collectInteractiveFromSeed(ctx, defaultAnswers({
    ...presetAnswers(preset),
    name: humanizeAgentName(basename(ctx.cwd)),
  }));
}

/**
 * Whether a logical wizard step will actually ask the operator anything for
 * the current draft. Some runtime families make Tools and Safety informative
 * only; treating those as back-navigation destinations traps Escape in a
 * silent forward loop.
 */
function wizardStepHasInteractivePrompt(step: number, draft: DraftAnswers): boolean {
  switch (step) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 7:
    case 8:
      return true;
    case 4:
      return [...draft.channels, ...(draft.memory === undefined ? [] : [draft.memory])]
        .some((id) => !MANAGED_MEMORY_MODULE_IDS.has(id)
          && findModule(id)?.inputs.some((input) => input.secret !== true) === true);
    case 5:
      return !selectedRuntimeModels(draft).every(hasFixedAllowAllToolPolicyRef);
    case 6:
      return safetyPolicyHasInteractivePrompt(draft);
    default:
      return false;
  }
}

function safetyPolicyHasInteractivePrompt(draft: DraftAnswers): boolean {
  const models = selectedRuntimeModels(draft);
  const mixed = isMixedRouteChain(models);
  if (mixed) return true;

  const hasSandboxableTools = isAllowAllTools(draft.allowedTools)
    || draft.allowedTools.some((tool) => SANDBOXABLE_TOOLS.has(tool));
  const hasPiRoute = models.some((model) => model.startsWith("pi:"));
  const providerNative = models.some((model) => !model.startsWith("pi:"));
  if (hasSandboxableTools && hasPiRoute) return true;
  if (draft.routeSafety === "per-route-native" && providerNative) return true;
  return hasSandboxableTools
    && providerNative
    && !models.every(isDirectCodexRef)
    && isAllowAllTools(draft.allowedTools);
}

function previousInteractiveWizardStep(step: number, draft: DraftAnswers): number | undefined {
  for (let candidate = step - 1; candidate >= 0; candidate -= 1) {
    if (wizardStepHasInteractivePrompt(candidate, draft)) return candidate;
  }
  return undefined;
}

/** Shared custom/preset first-run chooser; seed answers only set sensible defaults. */
async function collectInteractiveFromSeed(
  ctx: WizardRunContext,
  seed: WizardAnswers,
  options: InteractiveCollectionOptions = {},
): Promise<CollectedAnswers> {
  const draft = draftFrom(seed);
  if (options.repairState !== undefined) {
    draft.credentialStates = { ...options.repairState.credentialStates };
  }
  const modelDiscoveryCache: { result?: ModelDiscoveryResult } = {};
  let step = options.initialStep ?? 0;
  let returnToReviewAfterStep = options.initialReturnToReviewStep;
  const finalStep = 8;
  const advanceAfter = (completedStep: number): void => {
    if (returnToReviewAfterStep === completedStep) {
      returnToReviewAfterStep = undefined;
      step = finalStep;
    } else {
      step = completedStep + 1;
    }
  };
  for (;;) {
    const snapshot = cloneDraft(draft);
    let finalizing = false;
    try {
      switch (step) {
        case 0:
          draft.name = (await textPrompt({
            message: "What should this agent be called?",
            // Keep the current answer visible and editable when Escape returns
            // here from model selection. `defaultValue` only substitutes an
            // empty submission, so Clack would otherwise render the folder-name
            // placeholder and make a preserved custom name look lost.
            initialValue: draft.name,
            placeholder: humanizeAgentName(basename(ctx.cwd)),
            validate: validateWizardAgentName,
          })).trim();
          draft.purpose = (await textPrompt({
            message: "What Role should be saved to IDENTITY.md → ## Role?",
            initialValue: draft.purpose,
            placeholder: "Help with work in this folder",
            validate: validateWizardAgentPurpose,
          })).trim();
          advanceAfter(0);
          break;
        case 1: {
          const previousFamilies = selectedRuntimeModels(draft).map(runtimeFamily).join(",");
          await promptModelSettings(draft, ctx, modelDiscoveryCache);
          const nextFamilies = selectedRuntimeModels(draft).map(runtimeFamily).join(",");
          if (
            returnToReviewAfterStep === 1
            && (
              previousFamilies !== nextFamilies
              || !hasExactAllowAllTools(draft)
              || hasInvalidUniformManagedSrtChain(draft)
            )
          ) {
            p.log.info("The runtime route changed, so tool and sandbox safety choices must be confirmed again.");
            await promptTools(draft);
            await promptSafetyPolicy(draft);
          }
          advanceAfter(1);
          break;
        }
        case 2: {
          const previousChannels = new Set(draft.channels);
          draft.channels = [...await multiselect({
            message: "How will you talk to this agent?",
            options: channelSelectOptions({ readyOnly: true }),
            initialValues: draft.channels,
            required: false,
          })];
          if (returnToReviewAfterStep === 2) {
            await promptModuleInputs(
              draft,
              draft.channels.filter((channel) => !previousChannels.has(channel)),
            );
            await promptTools(draft);
            await promptSafetyPolicy(draft);
          }
          advanceAfter(2);
          break;
        }
        case 3: {
          const previousMemory = draft.memory;
          const memory = await select({
            message: "Should the agent remember across conversations?",
            options: memorySelectOptions({
              includeOptionalPlugins:
                draft.memory === "memory:supermemory"
                || isSupermemoryPluginInstalled({ cwd: ctx.cwd }),
            }),
            initialValue: draft.memory ?? "",
          });
          draft.memory = memory === "" ? undefined : memory;
          if (previousMemory !== draft.memory && previousMemory !== undefined) {
            delete draft.moduleInputs[previousMemory];
          }
          if (draft.memory !== undefined && MANAGED_MEMORY_MODULE_IDS.has(draft.memory)) {
            await promptManagedMemoryEmbeddingInputs(draft, ctx);
          } else if (
            returnToReviewAfterStep === 3
            && draft.memory !== undefined
            && draft.memory !== previousMemory
          ) {
            await promptModuleInputs(draft, [draft.memory]);
          }
          advanceAfter(3);
          break;
        }
        case 4:
          if (
            returnToReviewAfterStep === 4
            && draft.memory !== undefined
            && MANAGED_MEMORY_MODULE_IDS.has(draft.memory)
          ) {
            await promptManagedMemoryEmbeddingInputs(draft, ctx);
          }
          await promptModuleInputs(draft);
          advanceAfter(4);
          break;
        case 5:
          await promptTools(draft);
          if (returnToReviewAfterStep === 5) {
            await promptSafetyPolicy(draft);
          }
          advanceAfter(5);
          break;
        case 6:
          await promptSafetyPolicy(draft);
          advanceAfter(6);
          break;
        case 7:
          draft.observability = await confirm({
            message: "Export traces to Phoenix (best-effort OTLP, sensitive data excluded)?",
            initialValue: draft.observability,
          });
          advanceAfter(7);
          break;
        case 8: {
          const reviewed = await confirmSummary(
            draft,
            ctx,
            options.repairState === undefined
              ? undefined
              : {
                  existing: options.repairState,
                },
          );
          if (reviewed.status === "edit") {
            step = reviewed.step;
            returnToReviewAfterStep = reviewed.step === finalStep ? undefined : reviewed.step;
            break;
          }
          finalizing = true;
          const answers = toWizardAnswers(draft);
          const moduleSecrets = await promptRequiredModuleSecrets(
            answers,
            ctx.persistedEnv,
            options.repairState?.moduleSecrets,
          );
          return {
            answers,
            ...reviewed.providerSetup,
            moduleSecrets,
            credentialStates: { ...draft.credentialStates },
          };
        }
        default:
          throw new Error(`Unknown wizard step ${step}.`);
      }
    } catch (error) {
      restoreDraft(draft, snapshot);
      if (error instanceof WizardBack) {
        if (options.returnToCallerOnReviewBack === true) throw error;
        if (returnToReviewAfterStep === step) {
          returnToReviewAfterStep = undefined;
          step = finalStep;
          continue;
        }
        const previous = previousInteractiveWizardStep(step, draft);
        if (previous === undefined) throw error;
        // Secret/auth collection happens after the review choice. Escape there
        // returns to the review rather than discarding unrelated answers.
        step = step === finalStep && finalizing ? finalStep : previous;
        continue;
      }
      if (error instanceof WizardExitRequested) {
        if (await confirmExitSetup()) throw new WizardCancelled();
        continue;
      }
      throw error;
    }
  }
}

async function promptSafetyPolicy(draft: DraftAnswers): Promise<void> {
  const models = selectedRuntimeModels(draft);
  const mixed = isMixedRouteChain(models);
  if (mixed) {
    draft.routeSafety = await select({
      message: "How should safety apply across this mixed fallback chain?",
      options: [...ROUTE_SAFETY_OPTIONS],
      initialValue: draft.routeSafety,
    }) as RouteSafetyMode;
  } else {
    draft.routeSafety = "uniform";
  }

  const hasSandboxableTools = isAllowAllTools(draft.allowedTools)
    || draft.allowedTools.some((tool) => SANDBOXABLE_TOOLS.has(tool));
  const hasPiRoute = models.some((model) => model.startsWith("pi:"));
  const providerNative = models.some((model) => !model.startsWith("pi:"));
  const mixedPiProviderNativeChain = mixed && hasPiRoute && providerNative;
  if (hasSandboxableTools && hasPiRoute) {
    draft.sandbox = await confirm({
      message: "Install and use managed SRT for Pi shell/file/Node REPL tools? (localhost-only network; setup verifies fail-closed enforcement)",
      initialValue: true,
    });
  } else {
    draft.sandbox = false;
  }

  if (mixedPiProviderNativeChain && draft.routeSafety === "uniform" && draft.sandbox) {
    p.note(
      "Managed SRT applies to Pi routes only. A mixed Pi/provider-native chain therefore cannot promise one uniform managed-SRT contract.",
      "Safety choice required",
    );
    const resolution = await select({
      message: "How should this mixed chain resolve the managed-SRT mismatch?",
      options: [
        {
          value: "per-route-native",
          label: "Use per-route native safety",
          hint: "keep managed SRT for Pi and show every provider's native contract",
        },
        {
          value: "disable-managed-srt",
          label: "Disable managed SRT",
          hint: "keep the uniform contract without claiming SRT on provider-native routes",
        },
      ],
      initialValue: "per-route-native",
    });
    if (resolution === "per-route-native") draft.routeSafety = "per-route-native";
    else draft.sandbox = false;
  }

  if (draft.routeSafety === "per-route-native" && (mixed || providerNative)) {
    p.note(
      formatRouteSafetyMatrix(
        { model: draft.model, ...(draft.effort === undefined ? {} : { effort: draft.effort }) },
        draft.fallbacks,
        draft.sandbox,
      ),
      "Per-route safety contract",
    );
    const accepted = await confirm({
      message: "Use these per-route safety contracts? Provider-native routes cannot enforce every mono-agent capability.",
      initialValue: false,
    });
    if (!accepted) {
      draft.routeSafety = "uniform";
      if (mixedPiProviderNativeChain && draft.sandbox) {
        draft.sandbox = false;
        p.log.info("Managed SRT disabled because this mixed chain kept the uniform compatibility contract.");
      }
      p.log.info("Per-route native safety was not accepted; restored the uniform compatibility contract.");
    } else {
      return;
    }
  }

  if (hasSandboxableTools && hasPiRoute && isAllowAllTools(draft.allowedTools) && !draft.sandbox) {
    const accepted = await confirmHighRiskUnsandboxedAccess();
    if (!accepted) {
      draft.sandbox = true;
      if (mixedPiProviderNativeChain && draft.routeSafety === "uniform") {
        draft.routeSafety = "per-route-native";
        p.note(
          formatRouteSafetyMatrix(
            { model: draft.model, ...(draft.effort === undefined ? {} : { effort: draft.effort }) },
            draft.fallbacks,
            draft.sandbox,
          ),
          "Per-route safety contract",
        );
        if (!await confirm({
          message: "Use these per-route safety contracts? Provider-native routes cannot enforce every mono-agent capability.",
          initialValue: false,
        })) {
          throw new WizardBack();
        }
      } else {
        p.log.info("Managed SRT enabled because unsandboxed Pi allow-all access was not confirmed.");
      }
    }
  } else if (
    hasSandboxableTools
    && providerNative
    && !models.every(isDirectCodexRef)
    && isAllowAllTools(draft.allowedTools)
    && !await confirmHighRiskUnsandboxedAccess()
  ) {
    throw new WizardBack();
  }
}

async function confirmHighRiskUnsandboxedAccess(): Promise<boolean> {
  return confirm({
    message: "Proceed with high-risk unsandboxed access? The model may run shell commands or JavaScript, change files, access the web, and send through enabled channels.",
    initialValue: false,
  });
}

/** Select primary, fallbacks, and effort without touching any other answer. */
async function promptModelSettings(
  draft: DraftAnswers,
  ctx: {
    readonly piAuthPath?: string;
    readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  },
  cache: { result?: ModelDiscoveryResult } = {},
): Promise<void> {
  if (cache.result === undefined) p.log.step("Discovering supported model catalogs…");
  const discovery = cache.result ??= await discoverModelsInterruptibly({
      ...(ctx.piAuthPath === undefined ? {} : { piAuthPath: ctx.piAuthPath }),
      ...(ctx.persistedEnv === undefined ? {} : { persistedEnv: ctx.persistedEnv }),
    });
  const discoveredByValue = new Map(discovery.candidates.map((candidate) => [candidate.value, candidate]));
  p.note(formatModelDiscoveryStatus(discovery.statuses), "Model discovery");
  const previousModel = draft.model;
  const previousEffort = draft.effort;
  const providerDefault = discovery.candidates.find((candidate) => candidate.providerDefault === true);
  const initialModel = draft.model === DEFAULT_MODEL ? providerDefault?.value ?? draft.model : draft.model;
  let substep = 0;
  for (;;) {
    try {
      if (substep === 0) {
        const model = await autocomplete({
          message: "Which model?",
          options: modelSelectOptions(discovery.candidates, draft.model),
          initialValue: draft.model === DEFAULT_MODEL ? initialModel : draft.model,
          placeholder: "Type to search Pi, Codex, Claude, and local models…",
          maxItems: MODEL_AUTOCOMPLETE_MAX_ITEMS,
        });
        draft.model = await resolveModelSelection(model, { candidates: discovery.candidates, context: "primary" });
        substep = 1;
        continue;
      }
      if (substep === 1) {
        draft.effort = await promptEffortForModel(
          draft.model,
          discoveredByValue.get(draft.model),
          draft.model === previousModel ? previousEffort : undefined,
        );
        substep = 2;
        continue;
      }
      if (substep === 2) {
        draft.fallbacks = [];
        if (!await confirm({ message: "Add fallback models?", initialValue: false })) break;
        substep = 3;
        continue;
      }
      await promptFallbackModels(draft, discovery.candidates);
      break;
    } catch (error) {
      if (!(error instanceof WizardBack) || substep === 0) throw error;
      substep -= 1;
    }
  }
  draft.credentialStates = selectedCredentialStates(draft, discoveredByValue, ctx.persistedEnv);
}

function selectedCredentialStates(
  draft: Pick<DraftAnswers, "model" | "fallbacks">,
  candidates: ReadonlyMap<string, WizardModelCandidate>,
  persistedEnv: Readonly<Record<string, string | undefined>> = {},
): Record<string, ProviderCredentialState> {
  const states: Record<string, ProviderCredentialState> = {};
  for (const model of selectedRuntimeModels(draft)) {
    const key = providerCredentialKey(model);
    if (key === undefined) continue;
    const authState = candidates.get(model)?.authState;
    states[key] = authState === "verified"
      ? "verified"
      : hasDurableProviderEnvironmentCredential(model, persistedEnv)
        ? "credential_detected"
        : authState === "credential_detected"
          ? "credential_detected"
          : "auth_required";
  }
  return states;
}

function providerCredentialKey(model: string): string | undefined {
  if (model.startsWith("codex:")) return "codex";
  if (model.startsWith("claude:")) return "claude";
  if (!model.startsWith("pi:")) return undefined;
  const provider = model.split(":")[1];
  return provider === undefined || provider === "ollama" || provider === "lmstudio" ? undefined : `pi:${provider}`;
}

async function promptEffortForModel(
  model: string,
  candidate?: WizardModelCandidate,
  initial?: string,
): Promise<EffortLevel | undefined> {
  const supported = candidate?.supportedEfforts ?? [];
  const options = effortSelectOptions(supported, candidate?.defaultEffort);
  const initialValue = initial !== undefined && supported.includes(initial as EffortLevel) ? initial : "";
  const effort = await select({
    message: `Reasoning effort for ${model}`,
    options,
    initialValue,
  });
  return effort === "" ? undefined : effort as EffortLevel;
}

/**
 * Prompt every non-secret input of the selected channel + memory modules and store
 * the answers into `draft.moduleInputs`. Required secrets are collected only after
 * the write confirmation so they can never appear in the plan summary.
 */
async function promptModuleInputs(
  draft: DraftAnswers,
  requestedModuleIds?: readonly string[],
): Promise<void> {
  const moduleIds = requestedModuleIds
    ?? [...draft.channels, ...(draft.memory === undefined ? [] : [draft.memory])];
  for (const id of moduleIds) {
    if (MANAGED_MEMORY_MODULE_IDS.has(id)) {
      continue;
    }
    const module = findModule(id);
    if (module === undefined) {
      continue;
    }
    for (const input of module.inputs) {
      if (input.secret === true) {
        continue;
      }
      const currentValue = draft.moduleInputs[module.id]?.[input.id];
      const answer = await textPrompt({
          message: `${module.title}: ${input.label}`,
          placeholder: input.description,
          ...(input.default === undefined ? {} : { defaultValue: input.default }),
          ...(currentValue === undefined ? {} : { initialValue: currentValue }),
          ...(input.validate === undefined ? {} : { validate: input.validate }),
        });
      const trimmed = answer.trim();
      if (trimmed.length > 0) {
        (draft.moduleInputs[module.id] ??= {})[input.id] = trimmed;
      } else {
        delete draft.moduleInputs[module.id]?.[input.id];
      }
    }
  }
}

/**
 * Collect one complete, provider-specific embedding selection for Journal or
 * BuJo. The finished bag replaces the prior provider bag as a unit so switching
 * providers cannot retain a stale endpoint, model, dimension, or auth-env name.
 */
async function promptManagedMemoryEmbeddingInputs(
  draft: DraftAnswers,
  ctx: WizardRunContext,
): Promise<void> {
  const moduleId = draft.memory;
  if (moduleId === undefined || !MANAGED_MEMORY_MODULE_IDS.has(moduleId)) return;
  const previous = draft.moduleInputs[moduleId] ?? {};
  const previousProvider = isManagedMemoryEmbeddingProvider(previous.embeddingProvider)
    ? previous.embeddingProvider
    : "ollama";
  const provider = await select<ManagedMemoryEmbeddingProvider>({
    message: `${findModule(moduleId)?.title ?? "Managed memory"}: embedding service`,
    options: [
      { value: "ollama", label: "Ollama", hint: "local /api embedding service" },
      { value: "lmstudio", label: "LM Studio", hint: "local typed model catalog + /v1/embeddings" },
    ],
    initialValue: previousProvider,
  });
  const sameProvider = provider === previousProvider;
  const endpoint = (await textPrompt({
    message: `${providerLabel(provider)} service root`,
    initialValue: sameProvider
      ? previous.embeddingEndpoint ?? DEFAULT_MEMORY_EMBEDDING_ENDPOINTS[provider]
      : DEFAULT_MEMORY_EMBEDDING_ENDPOINTS[provider],
    placeholder: DEFAULT_MEMORY_EMBEDDING_ENDPOINTS[provider],
    validate: memoryEmbeddingEndpointProblem,
  })).trim().replace(/\/+$/u, "");
  const apiKeyEnv = (await textPrompt({
    message: `${providerLabel(provider)} API-key environment variable (optional)`,
    ...(sameProvider && previous.embeddingApiKeyEnv !== undefined
      ? { initialValue: previous.embeddingApiKeyEnv }
      : {}),
    placeholder: "Leave blank for a keyless local service",
    validate: validateOptionalEmbeddingApiKeyEnv,
  })).trim();
  const apiKey = apiKeyEnv.length === 0 ? undefined : ctx.persistedEnv?.[apiKeyEnv];

  let discoveredModels: readonly string[] = [];
  try {
    discoveredModels = await discoverMemoryEmbeddingModels({
      provider,
      endpoint,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    if (discoveredModels.length === 0) {
      p.log.warn(`${providerLabel(provider)} did not report any models explicitly typed as embedding-capable.`);
    }
  } catch (error) {
    p.log.warn(`${providerLabel(provider)} embedding discovery was unavailable: ${safeErrorMessage(error)}`);
  }

  let model: string;
  if (discoveredModels.length > 0) {
    const initialModel = sameProvider && previous.embeddingModel !== undefined
      && discoveredModels.includes(previous.embeddingModel)
      ? previous.embeddingModel
      : discoveredModels[0]!;
    const selectedModel = await autocomplete<string>({
      message: `${providerLabel(provider)} embedding model`,
      options: [
        ...discoveredModels.map((value) => ({ value, label: value, hint: "typed embedding model" })),
        { value: MANUAL_EMBEDDING_MODEL, label: "Enter another model id…", hint: "manual readiness fallback" },
      ],
      initialValue: initialModel,
      placeholder: "Type to search embedding models…",
      maxItems: MODEL_AUTOCOMPLETE_MAX_ITEMS,
    });
    model = selectedModel === MANUAL_EMBEDDING_MODEL
      ? await promptManualEmbeddingModel(sameProvider ? previous.embeddingModel : undefined)
      : selectedModel;
  } else {
    model = await promptManualEmbeddingModel(sameProvider ? previous.embeddingModel : undefined);
  }

  let dimension: number | undefined;
  try {
    const result = await probeMemoryEmbeddingSelection({
      provider,
      endpoint,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    dimension = result.dimension;
    p.log.info(`${providerLabel(provider)} proved ${model} with embedding dimension ${dimension}.`);
  } catch (error) {
    p.log.warn(`${providerLabel(provider)} could not prove ${model} yet: ${safeErrorMessage(error)}`);
  }
  if (dimension === undefined) {
    const enteredDimension = await textPrompt({
      message: `${providerLabel(provider)} embedding dimension`,
      initialValue: sameProvider ? previous.embeddingDimension ?? "768" : "768",
      placeholder: "Positive integer; live readiness will verify it",
      validate: validateEmbeddingDimension,
    });
    dimension = Number(enteredDimension.trim());
  }

  draft.moduleInputs[moduleId] = {
    embeddingProvider: provider,
    embeddingEndpoint: endpoint,
    embeddingModel: model,
    embeddingDimension: String(dimension),
    ...(apiKeyEnv.length === 0 ? {} : { embeddingApiKeyEnv: apiKeyEnv }),
  };
}

async function promptManualEmbeddingModel(initialValue?: string): Promise<string> {
  return (await textPrompt({
    message: "Embedding model id",
    ...(initialValue === undefined ? {} : { initialValue }),
    placeholder: "Exact model id from the local service",
    validate: (value) => (value ?? "").trim().length > 0 ? undefined : "Enter an embedding model id.",
  })).trim();
}

function isManagedMemoryEmbeddingProvider(value: string | undefined): value is ManagedMemoryEmbeddingProvider {
  return value === "ollama" || value === "lmstudio";
}

function providerLabel(provider: ManagedMemoryEmbeddingProvider): string {
  return provider === "ollama" ? "Ollama" : "LM Studio";
}

function validateOptionalEmbeddingApiKeyEnv(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)
    ? undefined
    : "Use an environment-variable name such as LM_STUDIO_API_KEY.";
}

function validateEmbeddingDimension(value: string | undefined): string | undefined {
  const parsed = Number((value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "Enter a positive integer dimension.";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown service error";
}

/** Collect only typed required secrets, masked and retained solely for this run. */
async function promptRequiredModuleSecrets(
  answers: WizardAnswers,
  persistedEnv: Readonly<Record<string, string | undefined>> = {},
  existing: Readonly<Record<string, string>> = {},
): Promise<Readonly<Record<string, string>>> {
  const plan = composeWizardPlan(answers, { dirBasename: "agent", skillsRootExists: false });
  const secrets: Record<string, string> = {};
  for (const secret of plan.secrets) {
    if (!secret.required || hasNonEmptyValue(persistedEnv[secret.envVar])) continue;
    if (hasNonEmptyValue(existing[secret.envVar])) {
      secrets[secret.envVar] = existing[secret.envVar]!;
      continue;
    }
    secrets[secret.envVar] = await passwordPrompt({
      message: `${secret.label} (${secret.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "This secret is required for the selected capability." : undefined,
      clearOnError: true,
    });
  }
  return secrets;
}

function hasNonEmptyValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Short reasons annotating each always-on tool in the framing note. */
const ALWAYS_ON_TOOL_REASONS: Readonly<Record<string, string>> = {
  MemoryRecall: "memory recall is on",
  ReadSkill: "configuration skills load on demand",
};

/** The always-on tool names annotated with their reason, e.g. `MemoryRecall (memory recall is on)`. */
function alwaysOnDisplay(alwaysOn: readonly string[]): string[] {
  return alwaysOn.map((tool) => {
    const reason = ALWAYS_ON_TOOL_REASONS[tool];
    return reason === undefined ? tool : `${tool} (${reason})`;
  });
}

/**
 * The channel-contributed send/ask tools for the enabled channels (PascalCase),
 * minus the channel-agnostic `AskUser` (surfaced on its own line). Reuses the
 * multiselect option builder so the framing note can never drift from the picker.
 */
function channelSendTools(channels: readonly string[]): string[] {
  const channelTools = new Set<string>(ADAPTER_SEND_TOOL_NAMES);
  return toolMultiselectOptions(channels)
    .map((option) => option.value)
    .filter((value) => value !== "AskUser" && channelTools.has(value));
}

/**
 * The three tool families, explained before the allow-all decision so the operator
 * knows what "Allow all" turns on and what is unaffected by the choice:
 *   1. Always on — auto-provisioned, NOT gated by this choice (e.g. MemoryRecall).
 *   2. Built-ins — file/shell/web tools.
 *   3. App tools — safe host capabilities such as bounded run inspection.
 *   4. Channel tools — the send/ask tools that came with the channels you enabled,
 *      plus AskUser (structured questions in web, Slack, or Telegram).
 */
function toolSituationFraming(draft: DraftAnswers, alwaysOn: readonly string[]): string {
  const sends = channelSendTools(draft.channels);
  const channelLine = sends.length > 0
    ? `Channel tools (from the channels you enabled): ${sends.join(", ")}, plus AskUser (structured questions in web, Slack, or Telegram).`
    : "Channel tools: AskUser (structured questions in web, Slack, or Telegram).";
  return [
    alwaysOn.length > 0
      ? `Always on (auto-provisioned, not affected by this choice): ${alwaysOnDisplay(alwaysOn).join(", ")}.`
      : "Always on (auto-provisioned): none for this setup.",
    "Built-ins: files (Read/Write/Edit/Glob/Grep), shell (Bash), JavaScript (NodeRepl), web (WebFetch/WebSearch).",
    "App tools: RunHistory (read-only evidence from completed prior runs in this conversation).",
    channelLine,
    '"Allow all" lets the model run shell commands or JavaScript, read/change files, access the web, and send through enabled channels. These actions can modify data or contact people; you can turn specific tools off later via tools.disallowedTools.',
  ].join("\n");
}

/**
 * The tools step: frame the three tool families, then a single "Allow all tools?"
 * confirm (default yes → `["*"]`). Choosing "No" drops into the specific-tool
 * multiselect. Always-on tools (MemoryRecall/ReadSkill/MCP) are auto-provisioned and
 * are surfaced only for clarity — never gated by this choice.
 */
async function promptTools(draft: DraftAnswers): Promise<void> {
  const alwaysOn = alwaysOnTools(toWizardAnswers(draft));
  p.note(toolSituationFraming(draft, alwaysOn), "Tools");

  if (selectedRuntimeModels(draft).every(hasFixedAllowAllToolPolicyRef)) {
    draft.allowedTools = [ALLOW_ALL_TOOLS];
    p.log.info(
      "Direct Codex uses its native app-server tool set and cannot enforce mono-agent per-tool allowlists. Tool policy is fixed to allow-all; use Pi or Claude for a restrictive tool list.",
    );
    return;
  }
  const allowAll = await confirm({
      message: "Allow all tools? (shell/JavaScript execution, file changes, web access, and enabled-channel sends)",
      initialValue: true,
    });
  if (allowAll) {
    draft.allowedTools = [ALLOW_ALL_TOOLS];
    return;
  }

  await pickSpecificTools(draft);
}

/**
 * The "choose specific tools" multiselect, pre-checking the recommended selection for
 * the current capabilities. An empty selection loops back unless the operator confirms
 * the chat-only warning. The final list is ordered by the option order so
 * `tools.allowedTools` is deterministic regardless of toggle order.
 */
async function pickSpecificTools(draft: DraftAnswers): Promise<void> {
  const options = toolMultiselectOptions(draft.channels);
  const optionOrder = new Map(options.map((option, index) => [option.value, index]));
  const recommended = recommendedToolSelection(toWizardAnswers(draft));

  for (;;) {
    const tools = await multiselect({
        message: "Which tools may the model call?",
        options,
        initialValues: [...recommended],
        required: false,
      });

    if (tools.length === 0) {
      const proceed = await confirm({
          message:
            "⚠ Zero tools selected — the agent will be chat-only (cannot read files, run commands, or send proactively). Continue?",
          initialValue: false,
        });
      if (!proceed) {
        continue;
      }
    }

    draft.allowedTools = [...tools].sort(
      (a, b) => (optionOrder.get(a) ?? 0) - (optionOrder.get(b) ?? 0),
    );
    return;
  }
}

/**
 * Render the compact plan summary and ask for the single write-time confirmation.
 * Provider modules are implementation detail (auto-added for local models), so
 * they are excluded from the user-facing capabilities line. A "no" cancels.
 */
type CreationReviewResult =
  | {
      readonly status: "create";
      readonly providerSetup: {
        readonly runProviderSetup: boolean;
        readonly providerSetupSecrets: Readonly<Record<string, string>>;
        readonly providerEnvironmentSecrets: Readonly<Record<string, string>>;
        readonly piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">>;
      };
    }
  | { readonly status: "edit"; readonly step: number };

interface CreationReviewOptions {
  readonly existing: SetupRepairRunContext;
}

async function confirmSummary(
  draft: DraftAnswers,
  ctx: WizardRunContext,
  options?: CreationReviewOptions,
): Promise<CreationReviewResult> {
  const answers = toWizardAnswers(draft);
  const plan = await composePlanForCwd(answers, ctx.cwd);
  const setupModelRefs = referencedSetupModelRefs(plan);
  const existingSetupModelRefs = options === undefined
    ? undefined
    : referencedSetupModelRefs(await composePlanForCwd(options.existing.answers, ctx.cwd));
  const preserveProviderSetup = options !== undefined
    && existingSetupModelRefs !== undefined
    && sameOrderedValues(setupModelRefs, existingSetupModelRefs);
  const preliminarySetupPlan = providerSetupPlan(plan, ctx, draft.credentialStates);
  // Resolve destinations before the final review; collect masked values only
  // after the operator chooses Create.
  const piApiKeyPersistenceByProvider = preserveProviderSetup
    ? { ...options.existing.piApiKeyPersistenceByProvider }
    : await selectPiApiKeyPersistence(
        preliminarySetupPlan,
        options?.existing.piApiKeyPersistenceByProvider,
      );
  const setupPlan = providerSetupPlan(
    plan,
    ctx,
    draft.credentialStates,
    piApiKeyPersistenceByProvider,
  );

  if (setupModelRefs.some((model) => /^pi:(?:ollama|lmstudio):/u.test(model))) {
    p.note(
      "Local runtime or memory services are checked before readiness. The first load may take longer while models start.",
      "Local dependencies",
    );
  }

  const capabilities = plan.selectedModules
    .filter((module) => module.kind !== "provider")
    .map((module) => module.title);
  const identityAlreadyExists = await pathExists(join(ctx.cwd, "IDENTITY.md"));

  const creates = ["mono-agent.config.json", "IDENTITY.md", ".mono-agent/artifacts/", ".mono-agent/workspace/"];
  if (plan.envExample !== undefined) {
    creates.push(".env.example (placeholders only)");
  }
  for (const file of plan.files) {
    creates.push(file.path);
  }

  const providerEnvironmentNames = setupPlan.actions
    .filter(isProviderSetupPiApiKeyAction)
    .filter((action) => action.persistence === "environment")
    .map((action) => action.envVar);
  const moduleSecretsToCollect = plan.secrets
    .filter((secret) => secret.required && !hasNonEmptyValue(ctx.persistedEnv?.[secret.envVar]))
    .map((secret) => secret.envVar);
  const secrets = [...new Set([
    ...moduleSecretsToCollect,
    ...providerEnvironmentNames,
  ])];
  const hardenExistingDotenv = hasSensitivePersistedEnvironmentValue(ctx.persistedEnv ?? {});
  const mutableSecretFiles: string[] = [];
  if (secrets.length > 0 || hardenExistingDotenv) {
    mutableSecretFiles.push(
      secrets.length > 0 ? ".env (owner-only secret merge)" : ".env (owner-only permission hardening)",
      ".gitignore (ensure /.env is ignored)",
    );
  }
  const toolsLine = isAllowAllTools(draft.allowedTools)
    ? "all tools"
    : draft.allowedTools.length > 0
      ? draft.allowedTools.join(", ")
      : "none (chat-only)";
  const alwaysOn = alwaysOnTools(answers);
  const runtimeRoutes = [
    { model: draft.model, effort: draft.effort },
    ...draft.fallbacks,
  ];
  const potentiallyBilledCalls = runtimeRoutes.filter((route) => modelRefMayBill(route.model)).length;
  const providerActions = [
    ...setupPlan.detectedModelRefs.map((modelRef) =>
      `${modelRef}: credential/sign-in detected; skip initial auth and verify with the live readiness call`,
    ),
    ...setupPlan.actions.map((action) => {
      if (isProviderSetupPiApiKeyAction(action)) {
        return action.persistence === "environment"
          ? `${action.label}: read ${action.envVar} from owner-only .env; do not write Pi auth.json`
          : `${action.label}: save credential to owner-only ${action.piAuthPath}; do not copy it to .env`;
      }
      return `${action.label}: check the current credential/service state first; if needed run ${providerSetupActionCommandLine(action)} (cwd: ${action.cwd})`;
    }),
    ...(draft.sandbox
      ? ["Managed SRT: install the pinned tool in the private user cache and run the functional fail-closed preflight"]
      : []),
  ];
  const lines = [
    `Agent:        ${draft.name}`,
    "Role target:  IDENTITY.md → ## Role",
    `Role text:    ${draft.purpose}`,
    `Role write:   ${identityAlreadyExists
      ? "Preserve the existing IDENTITY.md unchanged; the entered Role text will not be written."
      : "Create IDENTITY.md with the entered text as its ## Role body."}`,
    "Routes:",
    ...runtimeRoutes.map((route, index) =>
      `  ${index === 0 ? "Primary" : `Fallback ${index}`}: ${route.model} [${route.effort ?? "provider default"}]`,
    ),
    `Capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "none"}`,
    `Tools:        ${toolsLine}`,
    `Route safety: ${draft.routeSafety}`,
    ...(draft.routeSafety === "per-route-native" || !isMixedRouteChain(runtimeRoutes.map((route) => route.model))
      ? [formatRouteSafetyMatrix(
          { model: draft.model, ...(draft.effort === undefined ? {} : { effort: draft.effort }) },
          draft.fallbacks,
          draft.sandbox,
        )]
      : [
          "Uniform contract: every route must satisfy the same mono-agent tool/sandbox capabilities; an incompatible route is rejected or skipped, never silently weakened.",
        ]),
    ...(alwaysOn.length > 0 ? [`Always on:    ${alwaysOnDisplay(alwaysOn).join(", ")}`] : []),
    `Readiness:    ${runtimeRoutes.length} real model call(s), one per selected route; ${potentiallyBilledCalls} potentially billed`,
    `Verify refs:  ${setupModelRefs.join(", ")}`,
    `Provider actions: ${providerActions.length > 0 ? providerActions.join("\n  ") : "none"}`,
    `Creates if missing (preserves existing scaffold paths): ${creates.join(", ")}`,
    ...(mutableSecretFiles.length > 0
      ? [`May create or update: ${mutableSecretFiles.join(", ")}`]
      : []),
    `Secret persistence: ${secrets.length > 0
      ? `${secrets.join(", ")} -> owner-only .env merge (values hidden)`
      : hardenExistingDotenv
        ? "existing sensitive .env -> owner-only permission/ignore hardening (values unchanged)"
        : "none"}`,
    ...(Object.values(piApiKeyPersistenceByProvider).some((value) => value === "secure-store")
      ? ["Pi credential persistence: selected keys -> owner-only Pi auth.json (values hidden; not copied to .env)"]
      : []),
    ...(secrets.length > 0 || hardenExistingDotenv
      ? [`Secret files: .env (${secrets.length > 0 ? "owner-only merge" : "owner-only hardening"}), .gitignore (ensure /.env is ignored)`]
      : []),
  ];
  p.note(lines.join("\n"), "Creation review");

  const choice = await select({
    message: `Create “${draft.name}”?`,
    options: creationReviewOptions({
      setupRequired:
        (preserveProviderSetup
          ? options.existing.runProviderSetup
          : setupPlan.actions.length > 0) || draft.sandbox,
    }),
    initialValue: "create",
  });
  if (choice === "cancel") {
    throw new WizardCancelled();
  }
  if (choice === "edit") {
    try {
      const step = await select({
        message: "What would you like to edit?",
        options: [
          { value: "0", label: "Agent name and Role" },
          { value: "1", label: "Models and efforts" },
          { value: "2", label: "Channels" },
          { value: "3", label: "Memory" },
          { value: "4", label: "Capability details" },
          { value: "5", label: "Tools" },
          { value: "6", label: "Route safety and sandbox" },
          { value: "7", label: "Observability" },
          { value: "8", label: "Return to review" },
        ],
        initialValue: "1",
      });
      return { status: "edit", step: Number(step) };
    } catch (error) {
      if (error instanceof WizardBack) {
        if (options !== undefined) throw error;
        return { status: "edit", step: 8 };
      }
      throw error;
    }
  }
  if (preserveProviderSetup) {
    return {
      status: "create",
      providerSetup: {
        runProviderSetup: options.existing.runProviderSetup,
        providerSetupSecrets: { ...options.existing.providerSetupSecrets },
        providerEnvironmentSecrets: { ...options.existing.providerEnvironmentSecrets },
        piApiKeyPersistenceByProvider: { ...options.existing.piApiKeyPersistenceByProvider },
      },
    };
  }
  let providerSetup;
  try {
    providerSetup = await collectProviderSetup(
      setupPlan,
      setupPlan.actions.length > 0,
      piApiKeyPersistenceByProvider,
      options?.existing.providerSetupSecrets,
      options?.existing.providerEnvironmentSecrets,
    );
  } catch (error) {
    if (error instanceof WizardBack) {
      if (options !== undefined) throw error;
      return { status: "edit", step: 8 };
    }
    throw error;
  }
  return {
    status: "create",
    providerSetup,
  };
}

function selectedRuntimeModels(draft: Pick<DraftAnswers, "model" | "fallbacks">): string[] {
  return [draft.model, ...draft.fallbacks.map((fallback) => fallback.model)];
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasFixedAllowAllToolPolicyRef(model: string): boolean {
  return isDirectCodexRef(model) || isDirectOpenCodeRef(model);
}

function hasExactAllowAllTools(draft: Pick<DraftAnswers, "allowedTools">): boolean {
  return draft.allowedTools.length === 1 && draft.allowedTools[0] === ALLOW_ALL_TOOLS;
}

function hasInvalidUniformManagedSrtChain(
  draft: Pick<DraftAnswers, "model" | "fallbacks" | "routeSafety" | "sandbox">,
): boolean {
  if (draft.routeSafety !== "uniform" || !draft.sandbox) return false;
  const models = selectedRuntimeModels(draft);
  return isMixedRouteChain(models)
    && models.some((model) => model.startsWith("pi:"))
    && models.some((model) => !model.startsWith("pi:"));
}

function isDirectCodexRef(model: string): boolean {
  return model.startsWith("codex:");
}

function isDirectOpenCodeRef(model: string): boolean {
  return model.startsWith("opencode:");
}

function runtimeFamily(model: string): string {
  return model.split(":", 1)[0] ?? model;
}

function modelRefMayBill(model: string): boolean {
  return !/^pi:(?:ollama|lmstudio):/u.test(model);
}

/** Build a plan using the destination-derived context for honest review/setup. */
async function composePlanForCwd(answers: WizardAnswers, cwd: string): Promise<WizardPlan> {
  return composeWizardPlan(answers, {
    dirBasename: basename(cwd),
    skillsRootExists: await pathExists(join(cwd, "skills")),
  });
}

/** Offer auth/preflight for every runtime and hidden memory model dependency. */
async function promptProviderSetup(
  plan: WizardPlan,
  ctx: { readonly cwd: string; readonly piAuthPath?: string },
  credentialStates: Readonly<Record<string, ProviderCredentialState>> = {},
): Promise<{
  readonly runProviderSetup: boolean;
  readonly providerSetupSecrets: Readonly<Record<string, string>>;
  readonly providerEnvironmentSecrets: Readonly<Record<string, string>>;
  readonly piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">>;
}> {
  const modelRefs = referencedSetupModelRefs(plan);
  p.note(modelRefs.join("\n"), "Models and services to verify");
  const preliminarySetupPlan = providerSetupPlan(plan, ctx, credentialStates);
  if (preliminarySetupPlan.actions.length === 0) {
    return { runProviderSetup: false, providerSetupSecrets: {}, providerEnvironmentSecrets: {}, piApiKeyPersistenceByProvider: {} };
  }
  const piApiKeyPersistenceByProvider = await selectPiApiKeyPersistence(preliminarySetupPlan);
  const setupPlan = providerSetupPlan(plan, ctx, credentialStates, piApiKeyPersistenceByProvider);
  p.note(
    setupPlan.actions
      .map(providerSetupActionReviewLine)
      .join("\n"),
    "Provider setup",
  );
  const runProviderSetup = await confirm({
    message: setupPlan.actions.some((action) => action.id.startsWith("pi-login:"))
      ? "Run provider auth/preflight now? (detected credentials are reused and verified by live readiness; Pi OAuth may update the auth store)"
      : "Run provider auth/preflight now? (detected credentials are reused and verified by live readiness)",
    initialValue: false,
  });
  return collectProviderSetup(setupPlan, runProviderSetup, piApiKeyPersistenceByProvider);
}

type PlannedProviderSetup = ReturnType<typeof planProviderSetup>;

function providerSetupPlan(
  plan: WizardPlan,
  ctx: { readonly cwd: string; readonly piAuthPath?: string },
  credentialStates: Readonly<Record<string, ProviderCredentialState>> = {},
  piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">> = {},
): PlannedProviderSetup {
  const modelRefs = referencedSetupModelRefs(plan);
  const configuredPiAuthPath = typeof plan.configJson.providers?.piAuthPath === "string"
    ? plan.configJson.providers.piAuthPath
    : undefined;
  const piAuthPath = ctx.piAuthPath ?? configuredPiAuthPath;
  return planProviderSetup({
    modelRefs,
    cwd: ctx.cwd,
    credentialStates,
    piApiKeyPersistenceByProvider,
    ...(piAuthPath === undefined ? {} : { piAuthPath }),
  });
}

async function collectProviderSetup(
  setupPlan: PlannedProviderSetup,
  runProviderSetup: boolean,
  selectedPersistence?: Readonly<Record<string, "secure-store" | "environment">>,
  existingSetupSecrets: Readonly<Record<string, string>> = {},
  existingEnvironmentSecrets: Readonly<Record<string, string>> = {},
): Promise<{
  readonly runProviderSetup: boolean;
  readonly providerSetupSecrets: Readonly<Record<string, string>>;
  readonly providerEnvironmentSecrets: Readonly<Record<string, string>>;
  readonly piApiKeyPersistenceByProvider: Readonly<Record<string, "secure-store" | "environment">>;
}> {
  const providerSetupSecrets: Record<string, string> = {};
  const providerEnvironmentSecrets: Record<string, string> = {};
  if (!runProviderSetup) {
    return {
      runProviderSetup: false,
      providerSetupSecrets,
      providerEnvironmentSecrets,
      piApiKeyPersistenceByProvider: { ...(selectedPersistence ?? {}) },
    };
  }
  const piApiKeyPersistenceByProvider = { ...(selectedPersistence ?? {}) };
  for (const action of setupPlan.actions) {
    if (!isProviderSetupPiApiKeyAction(action)) continue;
    if (action.persistence === "environment") {
      if (hasNonEmptyValue(existingEnvironmentSecrets[action.envVar])) {
        providerEnvironmentSecrets[action.envVar] = existingEnvironmentSecrets[action.envVar]!;
        continue;
      }
      providerEnvironmentSecrets[action.envVar] = await passwordPrompt({
        message: `${action.label} (${action.envVar}, saved to owner-only .env)`,
        validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
        clearOnError: true,
      });
      continue;
    }
    if (hasNonEmptyValue(existingSetupSecrets[action.id])) {
      providerSetupSecrets[action.id] = existingSetupSecrets[action.id]!;
      continue;
    }
    providerSetupSecrets[action.id] = await passwordPrompt({
      message: `${action.label} (${action.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
      clearOnError: true,
    });
  }
  return { runProviderSetup, providerSetupSecrets, providerEnvironmentSecrets, piApiKeyPersistenceByProvider };
}

async function selectPiApiKeyPersistence(
  setupPlan: PlannedProviderSetup,
  existing: Readonly<Record<string, "secure-store" | "environment">> = {},
): Promise<Record<string, "secure-store" | "environment">> {
  const selected: Record<string, "secure-store" | "environment"> = {};
  for (const action of setupPlan.actions) {
    if (!isProviderSetupPiApiKeyAction(action)) continue;
    const label = action.label.replace(/ \((?:secure store|environment)\)$/u, "");
    const existingSelection = existing[action.provider];
    selected[action.provider] = existingSelection ?? await select({
      message: `Where should ${label} store ${action.envVar}?`,
      options: [
        { value: "secure-store", label: "Store securely in Pi auth.json", hint: "owner-only Pi credential store" },
        { value: "environment", label: "Use environment variable", hint: `owner-only .env (${action.envVar})` },
      ],
      initialValue: "secure-store",
    });
  }
  return selected;
}

function providerSetupActionReviewLine(action: PlannedProviderSetup["actions"][number]): string {
  if (isProviderSetupPiApiKeyAction(action) && action.persistence === "environment") {
    return `${action.label}: read ${action.envVar} from the durable agent environment; Pi auth.json remains unchanged (cwd: ${action.cwd})`;
  }
  return `${action.label}: ${providerSetupActionCommandLine(action)} (cwd: ${action.cwd})`;
}

/** Seed a mutable draft from immutable answers (defaults or a preset). */
function draftFrom(answers: WizardAnswers): DraftAnswers {
  const moduleInputs: Record<string, Record<string, string>> = {};
  for (const [moduleId, values] of Object.entries(answers.moduleInputs)) {
    const bag: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        bag[key] = value;
      }
    }
    moduleInputs[moduleId] = bag;
  }
  return {
    name: answers.name?.trim() || "Mono Agent",
    purpose: answers.purpose?.trim() || "Help the operator work effectively in this folder.",
    model: answers.model,
    fallbacks: effectiveFallbacks(answers).map((fallback) => ({ ...fallback })),
    effort: answers.effort,
    routeSafety: answers.routeSafety,
    credentialStates: {},
    channels: [...answers.channels],
    memory: answers.memory,
    sandbox: answers.sandbox,
    observability: answers.observability,
    allowedTools: [...answers.allowedTools],
    moduleInputs,
  };
}

/**
 * Freeze a draft back into {@link WizardAnswers}. `memory` is omitted entirely when
 * undefined (exactOptionalPropertyTypes: an optional key must be absent, not
 * `undefined`).
 */
function toWizardAnswers(draft: DraftAnswers): WizardAnswers {
  for (const modelRef of selectedRuntimeModels(draft)) {
    assertConcreteWizardModelRef(modelRef);
  }
  return {
    name: draft.name,
    purpose: draft.purpose,
    model: draft.model,
    fallbacks: draft.fallbacks.map((fallback) => ({ ...fallback })),
    ...(draft.effort === undefined ? {} : { effort: draft.effort }),
    routeSafety: draft.routeSafety,
    channels: [...draft.channels],
    ...(draft.memory === undefined ? {} : { memory: draft.memory }),
    sandbox: draft.sandbox,
    observability: draft.observability,
    allowedTools: [...draft.allowedTools],
    moduleInputs: draft.moduleInputs,
  };
}

function cloneDraft(draft: DraftAnswers): DraftAnswers {
  return {
    ...draft,
    fallbacks: draft.fallbacks.map((fallback) => ({ ...fallback })),
    channels: [...draft.channels],
    allowedTools: [...draft.allowedTools],
    moduleInputs: Object.fromEntries(
      Object.entries(draft.moduleInputs).map(([id, values]) => [id, { ...values }]),
    ),
  };
}

function restoreDraft(target: DraftAnswers, source: DraftAnswers): void {
  Object.assign(target, cloneDraft(source));
}

/** A second Esc/Ctrl-C while this default-No prompt is open exits cleanly. */
async function confirmExitSetup(): Promise<boolean> {
  const answer = await p.confirm({ message: "Exit setup?", initialValue: false });
  return p.isCancel(answer) ? true : answer;
}

/** True when `path` exists (a local mirror of the CLI's private helper). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
