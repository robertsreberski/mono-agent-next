import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

type RuntimeConfig = MonoAgentConfig["runtime"];

/** Return the one effective fallback list while keeping legacy configs loadable. */
export function configuredRuntimeFallbackModels(
  runtime: Pick<RuntimeConfig, "fallbacks" | "fallbackModels">,
): readonly RuntimeModelReference[] {
  return (runtime.fallbacks?.length ?? 0) > 0
    ? runtime.fallbacks?.map((entry) => entry.model) ?? []
    : runtime.fallbackModels ?? [];
}

export function configuredRuntimeModels(
  runtime: Pick<RuntimeConfig, "model" | "fallbacks" | "fallbackModels">,
): readonly RuntimeModelReference[] {
  return [runtime.model, ...configuredRuntimeFallbackModels(runtime)];
}

export function hasConfiguredRuntimeFallbacks(
  runtime: Pick<RuntimeConfig, "fallbacks" | "fallbackModels">,
): boolean {
  return configuredRuntimeFallbackModels(runtime).length > 0;
}
