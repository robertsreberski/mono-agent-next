// pi 0.80 moved the static catalog reads off the pi-ai root: `getModel` is now
// deprecated/compat-only. `getBuiltinModel(provider, id)` from `providers/all`
// is the non-deprecated replacement — same 2-arg signature, and it returns
// `undefined` on an unknown provider/model exactly like the old `getModel`.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModel as getPiModel } from "@earendil-works/pi-ai/providers/all";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";

export const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function rootUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
}

function openAiCompatBaseUrl(provider) {
  const baseUrl = String(provider?.base_url || "").replace(/\/+$/, "");
  if (provider?.provider_type === "ollama") return `${rootUrl(baseUrl)}/v1`;
  return /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function customProviderName(provider, brand) {
  return `${(brand ?? readRuntimeBrand()).providerModelPrefix}-${provider.id}`;
}

function customProviderKey(provider, isPrivate) {
  if (provider?.api_key) return provider.api_key;
  return isPrivate ? "ollama" : "";
}

function customCompat(capabilities, isPrivate) {
  return {
    supportsStore: false,
    supportsDeveloperRole: !isPrivate,
    supportsReasoningEffort: capabilities?.reasoning_mode === "effort",
    maxTokensField: "max_tokens",
  };
}

/**
 * Translate Pi's model-native thinking levels to mono-agent's public effort
 * spelling. Pi calls the disabled level `off`; mono-agent calls it `none`.
 * Keeping this derived from the model lets new native levels (such as `max`)
 * flow through without maintaining a second hard-coded catalog.
 * @param {any} model
 * @returns {string[]}
 */
export function reasoningLevelsForPiModel(model) {
  return getSupportedThinkingLevels(model).map((level) => level === "off" ? "none" : level);
}

// Build the pi-runtime view of a custom provider/model from
// pre-resolved primitives. The caller (core/ai.js#generateResponse) reads
// the provider/model rows and computes the capabilities + isPrivate flag
// before invoking the provider, so this function never reaches into the
// domain layer.
function resolveCustomPiModel(resolved, options) {
  const provider = options.customProvider;
  if (!provider) {
    throw new Error(
      `pi custom provider context missing for ${resolved.provider}: caller must pass options.customProvider`,
    );
  }
  if (!provider.enabled) throw new Error(`provider disabled: ${resolved.provider}`);
  const modelRow = options.customModel || null;
  if (modelRow && modelRow.enabled === false) {
    throw new Error(`model disabled: ${resolved.model}`);
  }
  const capabilities = options.modelCapabilities;
  if (!capabilities || typeof capabilities !== "object") {
    throw new Error(
      `pi custom model capabilities missing for ${resolved.model}: caller must pass options.modelCapabilities`,
    );
  }
  const isPrivate = typeof options.isPrivateProvider === "boolean"
    ? options.isPrivateProvider
    : false;
  const providerName = customProviderName(provider, options.toolContext?.runtimeBrand);
  const pricing = modelRow?.pricing || {};
  return {
    model: {
      id: resolved.model,
      name: modelRow?.display_name || resolved.model,
      api: "openai-completions",
      provider: providerName,
      baseUrl: openAiCompatBaseUrl(provider),
      reasoning: !!capabilities.reasoning,
      input: capabilities.vision === false ? ["text"] : ["text", "image"],
      cost: {
        input: Number(pricing.input_per_million) || 0,
        output: Number(pricing.output_per_million) || 0,
        cacheRead: Number(pricing.cached_input_per_million) || 0,
        cacheWrite: Number(pricing.cache_write_per_million) || 0,
      },
      contextWindow: Number(capabilities.context_window || capabilities.num_ctx) || 128000,
      maxTokens: Number(capabilities.max_tokens) || 16384,
      compat: customCompat(capabilities, isPrivate),
    },
    capabilities,
    apiKeys: new Map([[providerName, customProviderKey(provider, isPrivate)]]),
  };
}

// `options.customProvider`, when present, takes UNCONDITIONAL precedence for
// ANY pi model ref resolved in this run — it is not scoped to the specific
// model reference passed in. A fallback-router chain that mixes a custom-pi
// entry with a builtin-pi entry therefore routes ALL pi entries in that chain
// through the same custom provider once options.customProvider is set for the
// run (the router does not re-derive customProvider per chain entry).
export function resolvePiRuntimeModel(resolved, options) {
  if (options.customProvider) return resolveCustomPiModel(resolved, options);
  if (resolved.sdk !== "pi") throw new Error(`unsupported pi sdk: ${resolved.sdk}`);
  const provider = resolved.provider;
  const model = getPiModel(provider, resolved.model);
  if (!model) {
    // Phrasing matters: this must match ai/failure.js's NON_RETRYABLE_PROVIDER_RE
    // `model[_ ]not[_ ]found` alternation so the router classifies a catalog miss
    // as non-retryable and bails cleanly instead of retrying/misclassifying it as
    // a transient provider_unavailable failure.
    throw new Error(`pi model not found: ${provider}:${resolved.model}`);
  }
  return {
    model,
    capabilities: {
      tool_use: true,
      reasoning: !!model.reasoning,
      reasoning_mode: model.reasoning ? "effort" : "none",
      reasoning_levels: model.reasoning ? reasoningLevelsForPiModel(model) : undefined,
      reasoning_disable_supported: true,
      vision: Array.isArray(model.input) ? model.input.includes("image") : false,
      json_mode: true,
    },
    apiKeys: new Map(),
  };
}
