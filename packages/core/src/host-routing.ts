// SPDX-License-Identifier: MIT
import type { Runtime } from "@mono-agent/module-sdk";
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
  if (sandboxActive && !capabilities.sandbox) {
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
