import { ensureLoadedAgentConfig, environmentFor } from "./config.js";
import { loadProjectMcpConfig } from "./mcp.js";
import type { AgentInspection, AgentLoadOptions, LoadedAgentConfig } from "./types.js";

export async function inspectAgent(
  config: string | LoadedAgentConfig,
  options: AgentLoadOptions = {},
): Promise<AgentInspection> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  const mcp = await loadProjectMcpConfig(loaded.paths.mcpConfig, environmentFor(loaded));
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
    mcpServers: Object.keys(mcp.mcpServers).sort(),
  };
}
