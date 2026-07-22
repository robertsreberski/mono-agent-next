import { EFFORT_LEVELS } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  modelReferenceKey,
  resolveModelEffortLevels,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

import {
  configuredRuntimeFallbackModels,
  configuredRuntimeModels,
} from "./runtime-routes.js";

export interface ChannelRuntimeEffortOption {
  readonly value: string;
  readonly label: string;
}

export interface ChannelRuntimeModelOption {
  readonly value: string;
  readonly label: string;
  readonly efforts: readonly ChannelRuntimeEffortOption[];
}

export interface ChannelRuntimeControls {
  readonly defaultModel: string;
  readonly defaultEffort?: string;
  readonly models: readonly ChannelRuntimeModelOption[];
}

/**
 * Build the display-ready runtime catalog shared by native channel controls.
 * Adapters still own their interaction/state behavior; the host owns which
 * configured routes are safe to expose and which effort values each route can
 * actually accept.
 */
export function buildChannelRuntimeControls(coreConfig: MonoAgentConfig): ChannelRuntimeControls {
  const refs: RuntimeModelReference[] = [];
  const seen = new Set<string>();
  for (const ref of configuredRuntimeModels(coreConfig.runtime)) {
    const value = modelReferenceKey(ref);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    refs.push(ref);
  }
  const directOpenCodeInFallbacks = configuredRuntimeFallbackModels(coreConfig.runtime)
    .some((ref) => ref.sdk === "opencode");
  return {
    defaultModel: modelReferenceKey(coreConfig.runtime.model),
    ...(coreConfig.runtime.effort === undefined ? {} : { defaultEffort: coreConfig.runtime.effort }),
    models: refs.map((ref) => {
      const value = modelReferenceKey(ref);
      return {
        value,
        label: value,
        efforts: channelEffortOptions(
          ref,
          coreConfig.providers?.local,
          ref.sdk === "opencode" || directOpenCodeInFallbacks,
        ),
      };
    }),
  };
}

function channelEffortOptions(
  ref: RuntimeModelReference,
  localProviders: Parameters<typeof resolveModelEffortLevels>[1],
  directOpenCodeInResultingChain: boolean,
): readonly ChannelRuntimeEffortOption[] {
  if (directOpenCodeInResultingChain) {
    return [];
  }
  const resolved = resolveModelEffortLevels(ref, localProviders);
  if (!resolved.reasoning || resolved.reasoningMode === "none") {
    return [];
  }
  if (resolved.reasoningMode === "toggle") {
    return [
      { value: "high", label: "Thinking on" },
      { value: "none", label: "Thinking off" },
    ];
  }
  const allowed = new Set<string>(EFFORT_LEVELS);
  const values = resolved.effortLevels ?? EFFORT_LEVELS;
  return [...new Set(values)]
    .filter((value) => allowed.has(value))
    .map((value) => ({ value, label: channelEffortLabel(value) }));
}

function channelEffortLabel(value: string): string {
  if (value === "xhigh") return "Extra high";
  if (value === "max") return "Maximum";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
