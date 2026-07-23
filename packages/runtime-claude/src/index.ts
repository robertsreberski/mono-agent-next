import { defineRuntimeModule } from "@mono-agent/module-sdk";

import { parseRuntimeClaudeConfig, runtimeClaudeJsonSchema, type RuntimeClaudeConfig } from "./config.js";
import { validateClaudeModel } from "./model.js";
import { createRuntimeClaude } from "./runtime.js";

export type { RuntimeClaudeAuth, RuntimeClaudeConfig, RuntimeClaudeMode } from "./config.js";
export { RuntimeClaudeError } from "./runtime.js";

export const monoAgentModule = defineRuntimeModule({
  manifest: {
    packageName: "@mono-agent/runtime-claude",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "runtime",
    responsibility: "Runs Claude-native turns through explicit SDK or CLI transports.",
    capabilities: [],
  },
  schema: { jsonSchema: runtimeClaudeJsonSchema, parse: parseRuntimeClaudeConfig },
  validateModel: validateClaudeModel,
  create(context) {
    return createRuntimeClaude({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
    });
  },
});

export default monoAgentModule;
