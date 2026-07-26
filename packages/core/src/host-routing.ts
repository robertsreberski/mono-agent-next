// SPDX-License-Identifier: MIT
import type {
  Runtime,
  RuntimeRouteValidationGrant,
  RuntimeRouteValidationResult,
} from "@mono-agent/module-sdk";
import { AgentConfigError } from "./errors.js";
import { toolEffects } from "./host-tool-catalog.js";
import type { CoreRuntimeTool } from "./mcp.js";
import type { AgentSubmitInput, LoadedAgentConfig, RuntimeRoute } from "./types.js";
export function routeCandidates(config: LoadedAgentConfig, input: AgentSubmitInput): readonly RuntimeRoute[] {
  const primary =
    input.runtime === undefined && input.model === undefined
      ? config.raw.routing.primary
      : {
          runtime: input.runtime ?? config.raw.routing.primary.runtime,
          model: input.model ?? config.raw.routing.primary.model,
        };
  const routes = [primary, ...config.raw.routing.fallbacks];
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.runtime}\0${route.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function runtimeEligibility(
  capabilities: Runtime["capabilities"],
  tools: readonly CoreRuntimeTool[],
  required: readonly string[],
  config: LoadedAgentConfig,
  sandboxExecutorGranted: boolean,
  hasInteractionHandler: boolean,
): string | undefined {
  if (tools.length > 0 && !capabilities.tools) return "tools unsupported";
  if (tools.some((tool) => tool.source.kind === "mcp") && !capabilities.mcp) return "MCP tools unsupported";
  if (config.raw.policy.approvals.default === "ask"
    && tools.some((tool) => toolEffects(tool).length > 0)
    && !hasInteractionHandler) {
    return "approval interaction handler unavailable";
  }
  const sandboxActive =
    !("mode" in config.raw.policy.sandbox && config.raw.policy.sandbox.mode === "off");
  if (sandboxActive
    && tools.some((tool) => tool.source.kind === "module" && toolEffects(tool).length > 0)) {
    return "effectful selected-module tools cannot execute under the active sandbox";
  }
  if (sandboxActive && (!sandboxExecutorGranted || !capabilities.sandbox)) {
    return "sandbox unsupported";
  }
  for (const capability of required) {
    if (!Object.hasOwn(capabilities, capability)) return `unknown required capability ${capability}`;
    if (!(capabilities as unknown as Record<string, boolean>)[capability]) return `${capability} unsupported`;
  }
  return undefined;
}
export function runtimeSessionRouteKey(route: RuntimeRoute): string {
  return Buffer.from(JSON.stringify([route.runtime, route.model]), "utf8").toString("base64url");
}
export function runtimeSessionMapKey(route: RuntimeRoute, conversationId: string): string {
  const suffix = Buffer.from(conversationId, "utf8").toString("base64url");
  return `${runtimeSessionRouteKey(route)}:${suffix}`;
}
export function createRuntimeRouteValidationGrant(
  config: LoadedAgentConfig,
): RuntimeRouteValidationGrant {
  return Object.freeze({
    validate(runtime?: string, model?: string): RuntimeRouteValidationResult {
      const selectedRuntime = runtime ?? config.raw.routing.primary.runtime;
      const selectedModel = model ?? config.raw.routing.primary.model;
      const configured = [config.raw.routing.primary, ...config.raw.routing.fallbacks]
        .some((route) => route.runtime === selectedRuntime && route.model === selectedModel);
      return Object.freeze({
        configured,
        runtime: selectedRuntime,
        model: selectedModel,
      });
    },
  });
}
/**
 * Reject a per-turn route selection that is not one of the configured routes.
 *
 * `routeCandidates` builds `[requested, ...fallbacks]`, so an unconfigured
 * selection used to be silently absorbed by the fallback chain: the turn was
 * answered by a different model and reported as a success. Core advertises model
 * choices only from strictly validated configured routes, so a selection outside
 * that set is a configuration error, not a routing hint.
 */
export function assertConfiguredRoute(config: LoadedAgentConfig, input: AgentSubmitInput): void {
  if (input.runtime === undefined && input.model === undefined) return;
  const validation = createRuntimeRouteValidationGrant(config)
    .validate(input.runtime, input.model);
  if (validation.configured) return;
  throw new AgentConfigError("Requested route is not a configured route", [{
    path: input.model === undefined ? "runtime" : "model",
    message: `${validation.runtime}:${validation.model} is not declared in routing.primary or routing.fallbacks`,
    code: "unconfigured_route",
  }]);
}
