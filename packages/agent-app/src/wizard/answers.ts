import {
  MAX_AGENT_NAME_LENGTH,
  type MonoAgentConfigJson,
  type RouteSafetyMode,
} from "@mono-agent/config";

import { monoAgentConfigWithSchema } from "../config-reference.js";
import {
  ADAPTER_SEND_TOOL_NAMES,
  APP_TOOL_NAMES,
  ALLOW_ALL_TOOLS,
  baseConfig,
  BUILTIN_TOOL_NAMES,
  type CapabilityModule,
  DEFAULT_MODEL,
  DEFAULT_SAFE_TOOLS,
  findModule,
  type GeneratedFile,
  type ModuleInputValues,
  type ModuleValidateExpectation,
  resolveModuleInputs,
} from "../modules/index.js";
import { managedProjectSkillFiles } from "../project-skills.js";

/**
 * The complete set of choices the wizard (or a preset) makes. This is the single
 * input to {@link composeWizardPlan}: everything the composer needs to emit a full
 * `mono-agent.config.json`, `.env.example`, and follow-up files is derived from it.
 */
export interface WizardFallback {
  readonly model: string;
  readonly effort?: string;
}

export interface WizardAnswers {
  /** Public display identity. Omitted only by legacy/programmatic callers. */
  readonly name?: string;
  /** Concise role statement used to generate the initial Identity. */
  readonly purpose?: string;
  readonly model: string;
  /** Optional primary-route effort; omitted means provider default. */
  readonly effort?: string;
  /** Canonical ordered fallback routes; omitted effort means provider default. */
  readonly fallbacks: readonly WizardFallback[];
  /**
   * Deprecated compatibility input. {@link defaultAnswers} converts these to
   * canonical routes, inheriting the legacy global effort when it is present.
   */
  readonly fallbackModels?: readonly string[];
  readonly routeSafety: RouteSafetyMode;
  /** Channel module ids, e.g. `["channel:webhook","channel:telegram"]`. */
  readonly channels: readonly string[];
  /** Memory module id, or `undefined` for no memory section. */
  readonly memory?: string;
  readonly sandbox: boolean;
  readonly observability: boolean;
  /** Final tool selection written into `tools.allowedTools`. */
  readonly allowedTools: readonly string[];
  /** Per module id → non-secret input overrides. Secret inputs are stripped by the composer. */
  readonly moduleInputs: Readonly<Record<string, ModuleInputValues>>;
}

/** Folder-derived context the base skeleton needs (not from wizard inputs). */
export interface ComposeContext {
  readonly dirBasename: string;
  readonly skillsRootExists: boolean;
}

/**
 * One secret the composed agent still needs. The CLI prints the checklist as
 * `- <label>: <description>` and points the operator at `<envVar>` in `.env`.
 */
export interface SecretChecklistItem {
  readonly moduleId: string;
  readonly label: string;
  readonly envVar: string;
  readonly description: string;
  readonly required: boolean;
}

/**
 * The single artifact of config generation: the JSON to write (with `$schema`),
 * the optional `.env.example`, follow-up files, the secret checklist, the selected
 * modules, the validate expectations, and any authoring warnings.
 */
export interface WizardPlan {
  readonly configJson: MonoAgentConfigJson;
  /** Joined module `envExampleLines` plus a trailing newline; `undefined` when none. */
  readonly envExample?: string;
  readonly files: readonly GeneratedFile[];
  readonly secrets: readonly SecretChecklistItem[];
  readonly selectedModules: readonly CapabilityModule[];
  readonly validateExpectations: readonly ModuleValidateExpectation[];
  readonly warnings: readonly string[];
}

/**
 * Every runtime/LLM reference that generic provider setup must account for.
 * Managed-memory embeddings deliberately stay out of this Pi-model-shaped
 * list: the guided wizard and readiness gate use the configured service root
 * and embedding-native discovery/probe contract instead.
 */
export function referencedSetupModelRefs(plan: WizardPlan): readonly string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !seen.has(value)) {
      seen.add(value);
      refs.push(value);
    }
  };

  add(plan.configJson.runtime?.model);
  for (const fallback of plan.configJson.runtime?.fallbacks ?? []) {
    add(fallback.model);
  }
  // A hand-authored legacy plan can still enter this helper; generated plans
  // always use the canonical structured form.
  for (const fallback of plan.configJson.runtime?.fallbackModels ?? []) {
    add(fallback);
  }

  const memory = plan.configJson.memory;
  if (memory?.llm?.provider === "agent-host") {
    add(memory.llm.model);
  } else if (memory?.llm?.provider === "ollama" || memory?.llm?.provider === "lmstudio") {
    add(localServiceModelRef(memory.llm.provider, memory.llm.model));
  }
  return refs;
}

/** Convert a local memory service into the model-ref shape understood by setup. */
function localServiceModelRef(provider: "ollama" | "lmstudio", model: unknown): string | undefined {
  return typeof model === "string" && model.length > 0 ? `pi:${provider}:${model}` : undefined;
}

/** True when a referenced backend requires credentials rather than a local service. */
function modelRefNeedsCredentials(modelRef: string): boolean {
  return modelRef.startsWith("codex:")
    || modelRef.startsWith("claude:")
    || (modelRef.startsWith("pi:") && !/^pi:(?:ollama|lmstudio):/u.test(modelRef));
}

/** Tools ordered canonically: runtime built-ins, app-owned tools, then adapter send tools. */
const ORDERED_TOOL_NAMES: readonly string[] = [
  ...BUILTIN_TOOL_NAMES,
  ...APP_TOOL_NAMES,
  ...ADAPTER_SEND_TOOL_NAMES,
];

const ZERO_TOOLS_WARNING =
  "Zero tools selected — the agent will be chat-only: it cannot read files, run commands, or send proactive messages.";

/**
 * The module ids selected by these answers, in composer order: auto-derived
 * providers first (from a `pi:ollama:*`/`pi:lmstudio:*` model), then channels (in
 * answer order), then the memory tier, then sandbox, then observability.
 */
function selectedModuleIds(answers: WizardAnswers): readonly string[] {
  const ids: string[] = [];
  const modelRefs = [answers.model, ...effectiveFallbacks(answers).map((fallback) => fallback.model)];
  if (modelRefs.some((model) => /^pi:ollama:/u.test(model))) {
    ids.push("provider:ollama");
  }
  if (modelRefs.some((model) => /^pi:lmstudio:/u.test(model))) {
    ids.push("provider:lmstudio");
  }
  for (const channel of answers.channels) {
    ids.push(channel);
  }
  if (answers.memory !== undefined) {
    ids.push(answers.memory);
  }
  if (answers.sandbox) {
    ids.push("sandbox");
  }
  if (answers.observability) {
    ids.push("observability:phoenix");
  }
  return ids;
}

/** Resolve the selected module ids to modules, skipping unknown ids defensively. */
function selectedModules(answers: WizardAnswers): readonly CapabilityModule[] {
  const modules: CapabilityModule[] = [];
  for (const id of selectedModuleIds(answers)) {
    const module = findModule(id);
    if (module !== undefined) {
      modules.push(module);
    }
  }
  return modules;
}

/**
 * The recommended `allowedTools` for these answers: the read-only safe defaults
 * plus every selected module's `recommendedTools`, deduped and ordered by the
 * canonical BUILTIN∪ADAPTER position. Deterministic — no Set-iteration reliance.
 */
export function recommendedToolSelection(answers: WizardAnswers): readonly string[] {
  const union = new Set<string>(DEFAULT_SAFE_TOOLS);
  for (const module of selectedModules(answers)) {
    for (const tool of module.recommendedTools ?? []) {
      union.add(tool);
    }
  }
  return ORDERED_TOOL_NAMES.filter((name) => union.has(name));
}

/** The read-only recall tool auto-provisioned from `memory.recallTool.enabled`. */
const MEMORY_RECALL_TOOL = "MemoryRecall";

/**
 * True when the selected memory tier auto-provisions the read-only `MemoryRecall`
 * tool (its fragment sets `memory.recallTool.enabled`). Derived from the catalog so
 * it never drifts from the memory modules themselves — lite/journal/bujo/supermemory
 * all do (Lite is FTS-only).
 */
function memoryProvisionsRecall(memoryId: string | undefined): boolean {
  if (memoryId === undefined) {
    return false;
  }
  const module = findModule(memoryId);
  if (module?.kind !== "memory") {
    return false;
  }
  const fragment = module.configFragment({ model: DEFAULT_MODEL }) as {
    memory?: { recallTool?: { enabled?: boolean } };
  };
  return fragment.memory?.recallTool?.enabled === true;
}

/**
 * The tools this agent auto-provisions regardless of `tools.allowedTools` — the
 * "always on" set the wizard surfaces so the operator understands they are NOT gated
 * by the allow-list choice. Today that is `MemoryRecall` when the memory tier enables
 * recall (lite/journal/bujo/supermemory). `ReadSkill` (skills configured) and MCP-server
 * tools are also always-on when present, but the basic wizard authors neither, so they
 * never appear here.
 */
export function alwaysOnTools(answers: WizardAnswers): readonly string[] {
  const tools: string[] = ["ReadSkill"];
  if (memoryProvisionsRecall(answers.memory)) {
    tools.push(MEMORY_RECALL_TOOL);
  }
  return tools;
}

const BASE_ANSWERS: WizardAnswers = {
  model: DEFAULT_MODEL,
  fallbacks: [],
  routeSafety: "uniform",
  channels: ["channel:webhook"],
  // `memory` is intentionally omitted (no memory section) — with
  // exactOptionalPropertyTypes an optional key must be absent, not `undefined`.
  sandbox: false,
  observability: false,
  allowedTools: [ALLOW_ALL_TOOLS],
  moduleInputs: {},
};

/**
 * The wizard's starting answers with `overrides` shallow-merged on top. Unless an
 * explicit `allowedTools` override is supplied, `allowedTools` defaults to allow-all
 * (`["*"]`) — the single choke point that flips the silent scaffold, every preset, and
 * every non-interactive `--flag` path to allow-all. An explicit override is preserved
 * verbatim: `["*"]`, a specific list, or `[]` (the chat-only case).
 */
export function defaultAnswers(overrides?: Partial<WizardAnswers>): WizardAnswers {
  const {
    fallbacks: canonicalFallbacks,
    fallbackModels: legacyFallbackModels,
    ...otherOverrides
  } = overrides ?? {};
  const merged = { ...BASE_ANSWERS, ...otherOverrides };
  const fallbacks = canonicalFallbacks !== undefined
    ? canonicalFallbacks.map((fallback) => ({ ...fallback }))
    : (legacyFallbackModels ?? []).map((model) => ({
        model,
        ...(merged.effort === undefined ? {} : { effort: merged.effort }),
      }));
  const allowedTools = overrides?.allowedTools ?? [ALLOW_ALL_TOOLS];
  return {
    ...merged,
    fallbacks,
    // Keep a legacy input visible only when that compatibility surface was
    // actually used. New wizard/canonical callers carry structured routes only.
    ...(legacyFallbackModels === undefined
      ? {}
      : { fallbackModels: [...legacyFallbackModels] }),
    allowedTools,
  };
}

/** Canonicalize old answer objects at the single composition boundary. */
export function effectiveFallbacks(answers: WizardAnswers): readonly WizardFallback[] {
  const canonical = answers.fallbacks ?? [];
  if (canonical.length > 0 || (answers.fallbackModels?.length ?? 0) === 0) {
    return canonical;
  }
  return (answers.fallbackModels ?? []).map((model) => ({
    model,
    ...(answers.effort === undefined ? {} : { effort: answers.effort }),
  }));
}

/** Folder basenames become readable public identities without affecting paths. */
export function humanizeAgentName(dirBasename: string): string {
  const words = dirBasename
    .trim()
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const name = words
    .map((word) => {
      const [first = "", ...rest] = Array.from(word);
      return `${first.toLocaleUpperCase()}${rest.join("")}`;
    })
    .join(" ");
  const fallback = name.length > 0 ? name : "Mono Agent";
  return Array.from(fallback).slice(0, MAX_AGENT_NAME_LENGTH).join("").trimEnd();
}

/** Overrides for one module: the shared model plus its non-secret input values. */
export function moduleOverrides(module: CapabilityModule, answers: WizardAnswers): Record<string, string | undefined> {
  const overrides: Record<string, string | undefined> = {
    model: answers.model,
    ...(answers.moduleInputs[module.id] ?? {}),
  };
  // Defense in depth: a secret-declared value must never reach a fragment or the JSON.
  for (const input of module.inputs) {
    if (input.secret === true) {
      delete overrides[input.id];
    }
  }
  return overrides;
}

/** Merge a module fragment onto the working config, concatenating `channels.plugins`. */
function applyFragment(config: Record<string, unknown>, fragment: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "channels") {
      const existing = (config.channels as Record<string, unknown> | undefined) ?? {};
      const incoming = (value as Record<string, unknown> | undefined) ?? {};
      const existingPlugins = Array.isArray(existing.plugins) ? existing.plugins : [];
      const incomingPlugins = Array.isArray(incoming.plugins) ? incoming.plugins : [];
      const plugins = [...existingPlugins, ...incomingPlugins];
      config.channels = {
        ...existing,
        ...incoming,
        ...(plugins.length > 0 ? { plugins } : {}),
      };
      continue;
    }
    if (key === "providers") {
      const existing = (config.providers as Record<string, unknown> | undefined) ?? {};
      const incoming = (value as Record<string, unknown> | undefined) ?? {};
      const existingLocal = Array.isArray(existing.local) ? existing.local : [];
      const incomingLocal = Array.isArray(incoming.local) ? incoming.local : [];
      config.providers = {
        ...existing,
        ...incoming,
        ...(existingLocal.length > 0 || incomingLocal.length > 0 ? { local: [...existingLocal, ...incomingLocal] } : {}),
      };
      continue;
    }
    config[key] = value;
  }
}

/**
 * The single config-generation path: turn wizard answers into a complete
 * `WizardPlan`. Fragments are composed onto the adapter-neutral base skeleton;
 * secret inputs are stripped before any fragment runs, so a secret value can never
 * reach the JSON. The composed default config is byte-equal to today's `init.ts`
 * scaffold except `tools.allowedTools` (filled from the wizard's tools selection).
 */
export function composeWizardPlan(answers: WizardAnswers, ctx: ComposeContext): WizardPlan {
  const modules = selectedModules(answers);
  const agentName = answers.name?.trim() || humanizeAgentName(ctx.dirBasename);
  const fallbacks = effectiveFallbacks(answers);
  const config: Record<string, unknown> = {
    ...baseConfig(ctx, agentName, answers.model, fallbacks, answers.routeSafety, answers.effort),
  };

  const files: GeneratedFile[] = [...managedProjectSkillFiles()];
  const secrets: SecretChecklistItem[] = [];
  const envLines: string[] = [];
  const validateExpectations: ModuleValidateExpectation[] = [{ sectionId: "runtime", mustBe: "ok" }];

  for (const module of modules) {
    const values = resolveModuleInputs(module, moduleOverrides(module, answers));
    applyFragment(config, module.configFragment(values));

    for (const line of module.envExampleLines?.(values) ?? []) {
      envLines.push(line);
    }
    for (const file of module.files?.(values) ?? []) {
      files.push(file);
    }
    for (const input of module.inputs) {
      if (input.secret === true) {
        secrets.push({
          moduleId: module.id,
          label: input.label,
          envVar: input.envVar,
          description: input.description,
          required: input.required === true,
        });
      }
    }
    for (const expectation of module.validateExpectations) {
      validateExpectations.push(expectation);
    }
  }

  config.tools = {
    ...((config.tools as Record<string, unknown> | undefined) ?? {}),
    allowedTools: [...answers.allowedTools],
    disallowedTools: [],
  };

  applyDefaultA2AAgentName(config, agentName);

  const configJson = monoAgentConfigWithSchema(config as unknown as MonoAgentConfigJson);
  const envExample = envLines.length > 0 ? `${envLines.join("\n")}\n` : undefined;
  const warnings = answers.allowedTools.length === 0 ? [ZERO_TOOLS_WARNING] : [];

  const planWithoutExpectations: WizardPlan = {
    configJson,
    ...(envExample === undefined ? {} : { envExample }),
    files,
    secrets,
    selectedModules: modules,
    validateExpectations: [],
    warnings,
  };
  if (referencedSetupModelRefs(planWithoutExpectations).some(modelRefNeedsCredentials)) {
    validateExpectations.push({
      sectionId: "credentials",
      mustBe: "ok",
      note: "Authenticate every configured cloud model before describing the agent as ready.",
    });
  }

  return {
    ...planWithoutExpectations,
    validateExpectations: dedupeExpectations(validateExpectations),
  };
}

/** Use the public identity for generated A2A metadata without changing explicit user config. */
function applyDefaultA2AAgentName(config: Record<string, unknown>, agentName: string): void {
  const channels = config.channels as { plugins?: unknown[] } | undefined;
  for (const plugin of channels?.plugins ?? []) {
    if (typeof plugin !== "object" || plugin === null) continue;
    const entry = plugin as { package?: unknown; config?: unknown };
    if (entry.package !== "@mono-agent/a2a-adapter" || typeof entry.config !== "object" || entry.config === null) continue;
    const pluginConfig = entry.config as Record<string, unknown>;
    const agent = typeof pluginConfig.agent === "object" && pluginConfig.agent !== null
      ? pluginConfig.agent as Record<string, unknown>
      : {};
    pluginConfig.agent = { ...agent, name: agentName };
  }
}

/** Dedupe validate expectations by `sectionId`, keeping the first occurrence. */
function dedupeExpectations(
  expectations: readonly ModuleValidateExpectation[],
): readonly ModuleValidateExpectation[] {
  const seen = new Set<string>();
  const out: ModuleValidateExpectation[] = [];
  for (const expectation of expectations) {
    if (seen.has(expectation.sectionId)) {
      continue;
    }
    seen.add(expectation.sectionId);
    out.push(expectation);
  }
  return out;
}
