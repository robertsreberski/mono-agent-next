// SPDX-License-Identifier: MIT
import { ensureLoadedAgentConfig } from "./config.js";
import type { AgentInspection, AgentLoadOptions, LoadedAgentConfig } from "./types.js";

export async function inspectAgent(
  config: string | LoadedAgentConfig,
  options: AgentLoadOptions = {},
): Promise<AgentInspection> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  return {
    agent: loaded.raw.agent,
    configPath: loaded.configPath,
    projectRoot: loaded.projectRoot,
    paths: loaded.paths,
    modules: loaded.modules.map((module) => ({
      slot: module.slot,
      instanceId: module.instanceId,
      packageName: module.packageName,
      packageVersion: module.packageVersion,
      apiVersion: module.definition.manifest.apiVersion,
      kind: module.definition.manifest.kind,
    })),
    routing: loaded.raw.routing,
    mcpServers: Object.keys(loaded.mcp.mcpServers).sort(),
  };
}
