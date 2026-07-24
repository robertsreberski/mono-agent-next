import type {
  ModuleDiagnostic,
  RuntimeModelDescriptor,
  RuntimeModelValidation,
  RuntimeModelValidationRequest,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { runtimePiCodingNativeTools } from "./coding-tool-descriptors.js";
import { parsePiModelReference, parseRuntimePiConfig } from "./config.js";
import type { RuntimePiConfig } from "./config.js";

export const runtimePiNodeReplTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "NodeRepl",
  displayName: "Node REPL",
  effects: Object.freeze(["read", "write", "execute", "network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiEditTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Edit",
  displayName: "Edit",
  effects: Object.freeze(["read", "write"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiWebSearchTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "WebSearch",
  displayName: "Web Search",
  effects: Object.freeze(["network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([
    runtimePiNodeReplTool,
    ...runtimePiCodingNativeTools.slice(0, 2),
    runtimePiEditTool,
    ...runtimePiCodingNativeTools.slice(2),
    runtimePiWebSearchTool,
  ]);

function diagnostic(message: string): ModuleDiagnostic {
  return {
    code: "runtime-pi.model",
    severity: "error",
    message,
  };
}

function publicThinkingLevels(
  levels: readonly string[],
): readonly string[] {
  return Object.freeze(levels.map((level) => level === "off" ? "none" : level));
}

function configuredLocalModelDescriptor(
  config: RuntimePiConfig,
  provider: string,
  modelId: string,
): RuntimeModelDescriptor | undefined {
  const model = config.localProviders
    .find((candidate) => candidate.id === provider)
    ?.models
    ?.find((candidate) => candidate.id === modelId);
  if (model === undefined) return undefined;
  return {
    id: `${provider}:${modelId}`,
    label: model.name ?? model.id,
    efforts: model.reasoning === true
      ? Object.freeze(["none", "minimal", "low", "medium", "high"])
      : Object.freeze(["none"]),
    contextWindow: model.contextWindow ?? 128_000,
  };
}

function staticModelDescriptor(
  config: RuntimePiConfig,
  reference: string,
): RuntimeModelDescriptor | undefined {
  const { provider, model } = parsePiModelReference(reference);
  const local = configuredLocalModelDescriptor(config, provider, model);
  if (local !== undefined) return local;
  if (config.localProviders.some((candidate) => candidate.id === provider)) {
    // A local provider with no authored catalog is discovered at runtime.
    return undefined;
  }
  const resolved = builtinModels().getModel(provider, model);
  if (resolved === undefined) return undefined;
  return {
    id: reference,
    label: resolved.name,
    efforts: publicThinkingLevels(getSupportedThinkingLevels(resolved)),
    contextWindow: resolved.contextWindow,
  };
}

/**
 * Validate only the deterministic Pi route and config syntax available before
 * a runtime instance exists. Exact catalog, discovery, and auth checks belong
 * to the created instance's preflight.
 */
export function validateRuntimePiModel(
  request: RuntimeModelValidationRequest,
): RuntimeModelValidation {
  const config = parseRuntimePiConfig(request.config);
  try {
    parsePiModelReference(request.model);
  } catch (error) {
    return {
      supported: false,
      diagnostics: [
        diagnostic(error instanceof Error ? error.message : String(error)),
      ],
    };
  }
  const model = staticModelDescriptor(config, request.model);
  return {
    supported: true,
    ...(model === undefined ? {} : { model }),
    nativeTools: runtimePiNativeTools,
  };
}
