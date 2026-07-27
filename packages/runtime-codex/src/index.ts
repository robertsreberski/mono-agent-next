// SPDX-License-Identifier: MIT
import { defineRuntimeModule } from "@mono-agent/module-sdk";
import {
  grantedSandboxExecutor,
  SANDBOX_EXECUTE_CAPABILITY,
} from "@mono-agent/module-sdk/internal";

import { codexAuthCommands } from "./auth-command.js";
import { parseRuntimeCodexConfig, runtimeCodexJsonSchema } from "./config.js";
import { validateRuntimeCodexModel } from "./model.js";
import { createRuntimeCodex } from "./runtime.js";

export type { RuntimeCodexConfig } from "./config.js";
export { RuntimeCodexError } from "./runtime.js";

export const monoAgentModule = defineRuntimeModule({
  manifest: {
    packageName: "@mono-agent/runtime-codex",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "runtime",
    responsibility: "Runs isolated turns through the Codex app-server JSONL protocol.",
    capabilities: [SANDBOX_EXECUTE_CAPABILITY],
  },
  schema: { jsonSchema: runtimeCodexJsonSchema, parse: parseRuntimeCodexConfig },
  validateModel: validateRuntimeCodexModel,
  create(context) {
    const sandboxExecutor = grantedSandboxExecutor(context.host);
    const runtime = createRuntimeCodex({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
      dataDirectory: context.dataDirectory,
      ...(sandboxExecutor === undefined ? {} : { sandboxExecutor }),
    });
    return { ...runtime, commands: codexAuthCommands(context.config) };
  },
});

export default monoAgentModule;
