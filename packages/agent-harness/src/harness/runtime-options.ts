import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
  mergeSandboxPolicies,
  modelReferenceKey,
} from "@mono-agent/runtime-adapter";
import type {
  RuntimeExecutionMode,
  RuntimeModelReference,
  SandboxPolicy,
} from "@mono-agent/runtime-adapter";

import type { AgentHarnessRuntimeOptionsExtension } from "../types.js";
import { isRecord } from "./value-utils.js";

const ENDPOINT_CLEAR_KEYS: ReadonlySet<string> = new Set([
  "customProvider",
  "customModel",
  "modelCapabilities",
  "isPrivateProvider",
]);

const TOOL_POLICY_OPTION_KEYS: ReadonlySet<string> = new Set([
  "allowedTools",
  "disallowedTools",
  "mcpServers",
  "mcpConfigPath",
]);

export function withoutToolPolicyOptions(
  options: AgentHarnessRuntimeOptionsExtension["runtimeOptions"] | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !TOOL_POLICY_OPTION_KEYS.has(key)),
  );
}

export function mergeRuntimeOptions(
  ...optionsList: readonly (AgentHarnessRuntimeOptionsExtension["runtimeOptions"] | Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (value === null && ENDPOINT_CLEAR_KEYS.has(key)) {
        delete merged[key];
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      if (key === "sandboxPolicy") {
        merged[key] = mergeSandboxPolicies(asSandboxPolicy(merged[key]), asSandboxPolicy(value));
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function asSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  return isRecord(value) ? value as unknown as SandboxPolicy : undefined;
}

/** Narrow a merged-options value to a RuntimeModelReference (a per-request model override). */
export function isRuntimeModelReference(value: unknown): value is RuntimeModelReference {
  return isRecord(value) && typeof value.sdk === "string" && typeof value.model === "string";
}

export function sameRuntimeModel(a: RuntimeModelReference, b: RuntimeModelReference): boolean {
  return modelReferenceKey(a) === modelReferenceKey(b);
}

/**
 * Execution mode for an override model: keep the host's configured mode when the
 * override model supports it, otherwise the override model's default mode.
 */
export function executionModeForOverride(
  model: RuntimeModelReference,
  hostMode: string | undefined,
): RuntimeExecutionMode {
  if (hostMode !== undefined) {
    try {
      assertExecutionModeCompatible(model, hostMode);
      return hostMode as RuntimeExecutionMode;
    } catch {
      // Host mode is incompatible with the override model — use the model default.
    }
  }
  return defaultExecutionModeForModel(model);
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
