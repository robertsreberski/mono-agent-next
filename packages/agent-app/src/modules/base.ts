import type { MonoAgentConfigJson, MonoAgentRuntimeFallbackJson, RouteSafetyMode } from "@mono-agent/config";

import type { ModuleInput } from "./types.js";

export const DEFAULT_MODEL = "codex:gpt-5.6-terra";
export const DEFAULT_PI_MEMORY_MODEL = "pi:openai-codex:gpt-5.6-terra";

/** The model input every composed agent shares; overridable from the wizard/CLI. */
export const MODEL_INPUT: ModuleInput = {
  id: "model",
  label: "Model",
  description: "Primary runtime model reference, e.g. codex:gpt-5.6-terra, codex:gpt-5.6-sol, pi:openai-codex:gpt-5.6-sol, pi:opencode-go:kimi-k2.6, claude:claude-sonnet-4-6.",
  default: DEFAULT_MODEL,
};

/** Context the base skeleton needs that is derived from the target folder, not from inputs. */
export interface BaseConfigContext {
  /** Basename of the agent folder. It is retained for path-derived defaults only. */
  readonly dirBasename: string;
  /** Retained for callers that inspect the target before composition. */
  readonly skillsRootExists: boolean;
}

/**
 * The adapter-neutral skeleton the composer builds on: runtime model, identity,
 * empty tool policy, local artifacts, and the trace registry. Returned WITHOUT
 * `$schema` (the composer adds it once at the end). Mirrors `init.ts`'s
 * `configTemplate` exactly for the fields it owns, so a composed default config
 * is field-equivalent to today's scaffold EXCEPT `tools.allowedTools` (the composer
 * fills that from the wizard's tools selection). Modules add the
 * memory / channel / sandbox / observability blocks.
 */
export function baseConfig(
  ctx: BaseConfigContext,
  agentName: string,
  model: string,
  fallbacks: readonly MonoAgentRuntimeFallbackJson[],
  routeSafety: RouteSafetyMode,
  effort?: string,
): MonoAgentConfigJson {
  return {
    agent: { name: agentName },
    runtime: {
      model,
      ...(fallbacks.length === 0 ? {} : { fallbacks }),
      routeSafety,
      ...(effort === undefined ? {} : { effort }),
      workspace: ".",
    },
    context: {
      identityPath: "./IDENTITY.md",
      skillsRoot: "./skills",
      selectedSkills: ["mono-agent-configure", "mono-agent-memory"],
      skillDisclosure: "index",
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "./.mono-agent/artifacts",
      retention: {
        maxAgeDays: 365,
        maxCount: 50000,
        dryRun: false,
      },
    },
    traceability: {
      registryDir: "./.mono-agent/trace-sources",
      sourceLabel: agentName,
    },
  };
}

/** A `memory` block for the given tier, rooted at the standard memory path. */
export function memoryBlock(
  mode: "lite" | "journal" | "bujo",
): NonNullable<MonoAgentConfigJson["memory"]> {
  return {
    mode,
    path: "./.mono-agent/memory",
    writeMode: mode === "bujo" ? "capture" : "append-host-summary",
  };
}
