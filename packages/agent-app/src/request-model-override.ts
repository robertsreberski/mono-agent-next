import { detectEffortKeyword, EFFORT_LEVELS, effortRank } from "@mono-agent/config";
import { parseMonoRuntimeModelReference, runtimeOptionsForLocalProvider } from "@mono-agent/runtime-adapter";
import type {
  LocalProviderDefinition,
  LocalProviderRuntimeOptions,
  RuntimeModelReference,
  SandboxPolicy,
} from "@mono-agent/runtime-adapter";

/**
 * Per-request runtime-options extension that applies a per-turn model/effort
 * override carried on webhook (`metadata.webhook`), cron (`metadata.cron`), or
 * web console (`metadata.web`), interactive TUI (`metadata.tui`), Telegram
 * (`metadata.telegram`), or Slack (`metadata.slack`) request metadata — an operator can pick model/effort
 * just as a trigger can pin one. The
 * adapters carry the override as raw strings; this is the
 * first place with both the model parser and the effort enum, so validation
 * lives here. An invalid value is WARNED and IGNORED (the turn falls back to the
 * harness default) rather than failing — a bad dynamic webhook `model` must not
 * 500 the request.
 *
 * The extension ALSO scans every turn's message text for effort trigger
 * phrases ("think"/"extra think"/"ultra think") and escalates the turn's
 * effort — see `applyEffortKeywordEscalation`. This lives here rather than in
 * a sibling extension because siblings compose later-wins in parallel: only
 * this extension knows the metadata effort the keyword must be compared
 * against (escalation-only), and it already owns the direct-OpenCode guard.
 * Effort-only writes keep the shared session (the harness isolates on MODEL
 * overrides only).
 *
 * Execution mode is NOT set here: the harness derives it from the effective model
 * plus the host's configured executionMode (keeping a compatible host mode, e.g.
 * claude in `cli`, and only falling back to the model default for an incompatible
 * one, e.g. a `codex:*` override under an `sdk` host).
 *
 * A model override OWNS the local-provider endpoint block. Whenever a VALID model
 * override is applied, this extension SETS the four endpoint fields
 * (`customProvider`/`customModel`/`modelCapabilities`/`isPrivateProvider`):
 *   - LOCAL override (`sdk === "pi"` with a configured provider id): recompute the
 *     block for the OVERRIDE model via `runtimeOptionsForLocalProvider`.
 *   - CLOUD/registry override, an UNCONFIGURED local provider id, or a
 *     misconfigured provider: set the four fields to `null` to explicitly CLEAR
 *     the host default's block.
 * This is required because the host default block is computed ONCE from
 * `config.runtime.model` at harness creation, and the pi runtime routes on
 * `customProvider` PRESENCE alone — so a cloud override under an all-LOCAL default
 * would otherwise inherit the default's local endpoint and send the cloud model to
 * localhost (same mis-route for an unconfigured local provider id). The harness
 * `mergeRuntimeOptions` applies the override AFTER the host default
 * (last-writer-wins) and reads `null` on these keys as "delete", so a set block
 * REPLACES the default and a null CLEARS it. An effort-only / no-model turn leaves
 * the block untouched (the default's block is correct for the default model).
 */
export interface RequestModelOverrideLogger {
  warn?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export interface RequestModelOverrideOptions {
  readonly logger?: RequestModelOverrideLogger;
  /** Host primary used to prevent unsafe direct-Codex ↔ non-Codex family changes. */
  readonly baseModel?: RuntimeModelReference;
  /** Host fallback chain retained behind a request-level primary override. */
  readonly fallbackModels?: readonly RuntimeModelReference[];
  /** Host effort inherited by model-only overrides unless the override supplies one. */
  readonly baseEffort?: string;
  /** Host hard turn cap inherited by request-level model overrides. */
  readonly baseMaxTurns?: number;
  /** Effective configured/auto-provisioned MCP sources inherited by the turn. */
  readonly mcpSources?: readonly string[];
  /** Whether progressive index disclosure would inject runtime skill metadata. */
  readonly indexSkillsActive?: boolean;
  /**
   * Host mono-agent sandbox policy. Claude and direct OpenCode provider-owned
   * tool loops do not consume this policy, so a request cannot dynamically
   * switch to either runtime while a non-off policy is active.
   */
  readonly sandboxPolicy?: Pick<SandboxPolicy, "mode">;
  /** Effective host tool policy used to reject direct OpenCode overrides it cannot enforce. */
  readonly toolPolicy?: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
  };
  /**
   * Configured local providers (`config.providers?.local`). When an override
   * names a model one of these serves, the extension recomputes the provider
   * endpoint block so the override reaches the right local endpoint instead of
   * inheriting the host default's block.
   */
  readonly localProviders?: readonly LocalProviderDefinition[];
}

interface RequestModelOverrideInput {
  readonly request: {
    readonly metadata?: Record<string, unknown>;
    readonly userMessage?: string;
  };
}

interface RequestModelOverrideResult {
  readonly runtimeOptions: {
    model?: RuntimeModelReference;
    effort?: string;
    // `null` is an explicit CLEAR sentinel the harness merge reads as "delete the
    // host default's value" (undefined would leave it untouched) — see the module
    // doc. Set for a local override, null for a non-local one.
    customProvider?: LocalProviderRuntimeOptions["customProvider"] | null;
    customModel?: LocalProviderRuntimeOptions["customModel"] | null;
    modelCapabilities?: LocalProviderRuntimeOptions["modelCapabilities"] | null;
    isPrivateProvider?: LocalProviderRuntimeOptions["isPrivateProvider"] | null;
  };
  readonly cleanup: () => Promise<void>;
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

export function createRequestModelOverrideRuntimeExtension(
  options?: RequestModelOverrideOptions,
): (input: RequestModelOverrideInput) => Promise<RequestModelOverrideResult> {
  const logger = options?.logger;
  const localProviders = options?.localProviders;
  const baseModel = options?.baseModel;
  const fallbackModels = options?.fallbackModels ?? [];
  return async (input) => {
    const { rawModel, rawEffort, model } = resolveAcceptedModelOverride(
      input.request.metadata,
      options,
      logger,
    );
    const runtimeOptions: RequestModelOverrideResult["runtimeOptions"] = {};
    const effectiveModelForEffort = model ?? baseModel;
    // Shared by the metadata effort override AND keyword escalation below: any
    // direct OpenCode model in the resulting chain means no run-level effort.
    const directOpenCodeModels = [effectiveModelForEffort, ...fallbackModels]
      .filter((entry): entry is RuntimeModelReference => entry?.sdk === "opencode");

    if (model !== undefined && rawModel !== undefined) {
      runtimeOptions.model = model;
      applyLocalProviderBlock(runtimeOptions, model, rawModel, localProviders, logger);
    }

    if (rawEffort !== undefined) {
      if (EFFORT_SET.has(rawEffort)) {
        if (directOpenCodeModels.length > 0) {
          logger?.warn?.("Ignoring per-request effort override for direct OpenCode anywhere in the resulting model chain.", {
            effort: rawEffort,
            reason: "The direct OpenCode SDK does not expose runtime effort control.",
            directOpenCodeModels: directOpenCodeModels.map(runtimeModelReferenceLabel),
          });
        } else {
          runtimeOptions.effort = rawEffort;
        }
      } else {
        logger?.warn?.("Ignoring invalid per-request effort override.", {
          effort: rawEffort,
          valid: [...EFFORT_SET],
        });
      }
    }

    applyEffortKeywordEscalation(
      runtimeOptions,
      input.request.userMessage,
      options?.baseEffort,
      directOpenCodeModels,
      logger,
    );

    return { runtimeOptions, cleanup: async () => {} };
  };
}

/**
 * Always-on background escalation: a trigger phrase in the turn's message text
 * ("think" → high, "extra think" → xhigh, "ultra think" → max) RAISES this
 * turn's effort, never lowers it. The baseline is the effort the turn would
 * otherwise run at — an accepted metadata override, else the host default — so
 * a webhook `effort:"max"` survives a bare "think" and an equal-or-lower
 * keyword writes nothing (no spurious `run_config.overridden`). Direct
 * OpenCode anywhere in the effective chain skips escalation (same reason as
 * the metadata effort guard above: the SDK has no runtime effort control), and
 * the warn fires only when the keyword would actually have escalated. The
 * message text itself is never mutated — trigger words reach the model.
 */
function applyEffortKeywordEscalation(
  runtimeOptions: RequestModelOverrideResult["runtimeOptions"],
  userMessage: string | undefined,
  baseEffort: string | undefined,
  directOpenCodeModels: readonly RuntimeModelReference[],
  logger: RequestModelOverrideLogger | undefined,
): void {
  if (typeof userMessage !== "string" || userMessage.length === 0) {
    return;
  }
  const match = detectEffortKeyword(userMessage);
  if (match === undefined) {
    return;
  }
  const resolvedEffort = runtimeOptions.effort ?? baseEffort;
  if (effortRank(match.effort) <= effortRank(resolvedEffort)) {
    return;
  }
  if (directOpenCodeModels.length > 0) {
    logger?.warn?.("Skipping keyword effort escalation for direct OpenCode anywhere in the resulting model chain.", {
      keyword: match.keyword,
      effort: match.effort,
      reason: "The direct OpenCode SDK does not expose runtime effort control.",
      directOpenCodeModels: directOpenCodeModels.map(runtimeModelReferenceLabel),
    });
    return;
  }
  runtimeOptions.effort = match.effort;
  logger?.info?.("Escalating per-turn effort from message keyword.", {
    keyword: match.keyword,
    from: resolvedEffort ?? null,
    to: match.effort,
  });
}

/**
 * Whether the request-level override will actually switch this turn to direct
 * OpenCode under the supplied host constraints. Adapter MCP injection uses the
 * same decision as the model extension: a merely parseable OpenCode string is
 * not enough, because a sandbox/tool/MCP/effort/turn-cap rejection must retain
 * both the Pi model and its interaction tools.
 */
export function requestModelOverrideTargetsDirectOpenCode(
  metadata: Record<string, unknown> | undefined,
  options?: RequestModelOverrideOptions,
): boolean {
  return resolveAcceptedModelOverride(metadata, options, undefined).model?.sdk === "opencode";
}

interface ModelOverrideResolution {
  readonly rawModel?: string;
  readonly rawEffort?: string;
  readonly model?: RuntimeModelReference;
}

function resolveAcceptedModelOverride(
  metadata: Record<string, unknown> | undefined,
  options: RequestModelOverrideOptions | undefined,
  logger: RequestModelOverrideLogger | undefined,
): ModelOverrideResolution {
  const { model: rawModel, effort: rawEffort } = readOverride(metadata);
  if (rawModel === undefined) {
    return { ...(rawEffort === undefined ? {} : { rawEffort }) };
  }

  let parsed: RuntimeModelReference;
  try {
    parsed = parseMonoRuntimeModelReference(rawModel);
  } catch (error) {
    logger?.warn?.("Ignoring invalid per-request model override.", {
      model: rawModel,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { rawModel, ...(rawEffort === undefined ? {} : { rawEffort }) };
  }

  const baseModel = options?.baseModel;
  const baseEffort = options?.baseEffort;
  const baseMaxTurns = options?.baseMaxTurns;
  const mcpSources = options?.mcpSources ?? [];
  const sandboxPolicy = options?.sandboxPolicy;
  const toolPolicy = options?.toolPolicy;
  const sandboxBypassRuntime = monoSandboxBypassRuntime(parsed);
  const directOpenCodeWouldReceiveEffort = parsed.sdk === "opencode"
    && (baseEffort !== undefined || (rawEffort !== undefined && EFFORT_SET.has(rawEffort)));
  const directOpenCodeWouldReceiveTurnCap = parsed.sdk === "opencode"
    && Number.isFinite(Number(baseMaxTurns))
    && Number(baseMaxTurns) > 0;
  const directOpenCodeWouldReceiveMcp = parsed.sdk === "opencode" && mcpSources.length > 0;
  const directOpenCodeWouldReceiveIndexSkills = parsed.sdk === "opencode" && options?.indexSkillsActive === true;

  if (baseModel !== undefined && isDirectCodex(parsed) !== isDirectCodex(baseModel)) {
    logger?.warn?.("Ignoring per-request model override across the direct-Codex runtime boundary.", {
      model: rawModel,
      baseModel: baseModel.reference ?? `${baseModel.sdk}:${baseModel.model}`,
      reason: "Direct Codex and non-Codex runtimes use different tool and sandbox contracts.",
    });
  } else if (sandboxBypassRuntime !== undefined && sandboxPolicy?.mode !== undefined && sandboxPolicy.mode !== "off") {
    logger?.warn?.(`Ignoring per-request ${sandboxBypassRuntime} model override while the mono-agent sandbox is active.`, {
      model: rawModel,
      sandboxMode: sandboxPolicy.mode,
      reason: `${sandboxBypassRuntime}'s provider-owned tool loop does not consume the mono-agent sandbox policy.`,
    });
  } else if (parsed.sdk === "opencode" && toolPolicy !== undefined && !isExactAllowAllToolPolicy(toolPolicy)) {
    logger?.warn?.("Ignoring per-request direct OpenCode model override under a restrictive tool policy.", {
      model: rawModel,
      reason: "Direct OpenCode does not consume mono-agent allowedTools/disallowedTools.",
    });
  } else if (directOpenCodeWouldReceiveMcp) {
    logger?.warn?.("Ignoring per-request direct OpenCode model override because MCP runtime options are unsupported.", {
      model: rawModel,
      mcpSources,
      reason: "Direct OpenCode cannot safely receive configured or auto-provisioned MCP servers.",
    });
  } else if (directOpenCodeWouldReceiveIndexSkills) {
    logger?.warn?.("Ignoring per-request direct OpenCode model override because index skill disclosure is unsupported.", {
      model: rawModel,
      reason: "Direct OpenCode disables runtime/external skills; use full disclosure or a Pi runtime.",
    });
  } else if (directOpenCodeWouldReceiveEffort) {
    logger?.warn?.("Ignoring per-request direct OpenCode model override because runtime effort is unsupported.", {
      model: rawModel,
      ...(baseEffort === undefined ? {} : { baseEffort }),
      ...(rawEffort === undefined || !EFFORT_SET.has(rawEffort) ? {} : { requestedEffort: rawEffort }),
    });
  } else if (directOpenCodeWouldReceiveTurnCap) {
    logger?.warn?.("Ignoring per-request direct OpenCode model override because runtime.maxTurns is unsupported.", {
      model: rawModel,
      baseMaxTurns,
      reason: "Direct OpenCode does not expose an enforceable hard turn cap.",
    });
  } else {
    return {
      rawModel,
      ...(rawEffort === undefined ? {} : { rawEffort }),
      model: parsed,
    };
  }

  return { rawModel, ...(rawEffort === undefined ? {} : { rawEffort }) };
}

function isDirectCodex(model: RuntimeModelReference): boolean {
  return model.sdk === "codex";
}

function runtimeModelReferenceLabel(model: RuntimeModelReference): string {
  return model.reference ?? `${model.sdk}:${model.provider === undefined ? "" : `${model.provider}:`}${model.model}`;
}

function monoSandboxBypassRuntime(model: RuntimeModelReference): "Claude" | "direct OpenCode" | undefined {
  if (model.sdk === "claude") return "Claude";
  if (model.sdk === "opencode") return "direct OpenCode";
  return undefined;
}

function isExactAllowAllToolPolicy(policy: NonNullable<RequestModelOverrideOptions["toolPolicy"]>): boolean {
  return policy.allowedTools.length === 1
    && policy.allowedTools[0] === "*"
    && policy.disallowedTools.length === 0;
}

/**
 * OWN the endpoint block for a valid model override. For a model served by a
 * configured LOCAL provider, `runtimeOptionsForLocalProvider` yields the block and
 * we SET all four fields. For a cloud/registry model or an unconfigured provider
 * id it returns `{}`, so `x ?? null` sets each field to `null` — the harness merge
 * reads that as an explicit CLEAR of the host default's local block (undefined
 * would silently inherit it and mis-route the run to localhost). A genuinely
 * MISCONFIGURED provider (e.g. an untrusted public HTTP baseUrl) throws; that is
 * warned-and-ignored and treated as non-local (block cleared) so a bad override
 * never fails the turn — the model ref still applies.
 */
function applyLocalProviderBlock(
  runtimeOptions: RequestModelOverrideResult["runtimeOptions"],
  model: RuntimeModelReference,
  rawModel: string,
  localProviders: readonly LocalProviderDefinition[] | undefined,
  logger: RequestModelOverrideLogger | undefined,
): void {
  let local: LocalProviderRuntimeOptions;
  try {
    local = runtimeOptionsForLocalProvider(model, localProviders);
  } catch (error) {
    logger?.warn?.("Ignoring local-provider endpoint for per-request model override.", {
      model: rawModel,
      reason: error instanceof Error ? error.message : String(error),
    });
    local = {};
  }
  runtimeOptions.customProvider = local.customProvider ?? null;
  runtimeOptions.customModel = local.customModel ?? null;
  runtimeOptions.modelCapabilities = local.modelCapabilities ?? null;
  runtimeOptions.isPrivateProvider = local.isPrivateProvider ?? null;
}

/**
 * Read model/effort from webhook, cron, web-console, TUI, Telegram, or Slack request metadata.
 * Webhook takes precedence, then cron, then the web block, then its optional TUI
 * compatibility mirror, then Telegram, then Slack. A turn carrying none of these blocks
 * returns `{}`, leaving only the keyword escalation scan.
 */
function readOverride(metadata: Record<string, unknown> | undefined): {
  readonly model?: string;
  readonly effort?: string;
} {
  if (!isRecord(metadata)) {
    return {};
  }
  const source = isRecord(metadata.webhook)
    ? metadata.webhook
    : isRecord(metadata.cron)
      ? metadata.cron
      : isRecord(metadata.web)
        ? metadata.web
        : isRecord(metadata.tui)
          ? metadata.tui
          : isRecord(metadata.telegram)
            ? metadata.telegram
            : isRecord(metadata.slack)
              ? metadata.slack
              : undefined;
  if (source === undefined) {
    return {};
  }
  return {
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    ...(typeof source.effort === "string" ? { effort: source.effort } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
