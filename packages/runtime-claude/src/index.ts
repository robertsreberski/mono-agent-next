// SPDX-License-Identifier: MIT
import { defineRuntimeModule } from "@mono-agent/module-sdk";
import {
  grantedSandboxExecutor,
  SANDBOX_EXECUTE_CAPABILITY,
} from "@mono-agent/module-sdk/internal";

import { claudeAuthCommands } from "./auth-command.js";
import { parseRuntimeClaudeConfig, runtimeClaudeJsonSchema } from "./config.js";
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
    capabilities: [SANDBOX_EXECUTE_CAPABILITY],
  },
  schema: { jsonSchema: runtimeClaudeJsonSchema, parse: parseRuntimeClaudeConfig },
  validateModel: validateClaudeModel,
  create(context) {
    const sandboxExecutor = grantedSandboxExecutor(context.host);
    const runtime = createRuntimeClaude({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
      dataDirectory: context.dataDirectory,
      ...(sandboxExecutor === undefined ? {} : { sandboxExecutor }),
    });
    return { ...runtime, commands: claudeAuthCommands(context.config) };
  },
});

export default monoAgentModule;
