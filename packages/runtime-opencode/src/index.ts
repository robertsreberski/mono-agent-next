// SPDX-License-Identifier: MIT
import { defineRuntimeModule } from "@mono-agent/module-sdk";
import {
  grantedSandboxExecutor,
  SANDBOX_EXECUTE_CAPABILITY,
} from "@mono-agent/module-sdk/internal";

import { openCodeAuthCommands } from "./auth-command.js";
import { parseRuntimeOpenCodeConfig, runtimeOpenCodeJsonSchema } from "./config.js";
import { validateRuntimeOpenCodeModel } from "./model.js";
import { createRuntimeOpenCode } from "./runtime.js";

export type { RuntimeOpenCodeConfig } from "./config.js";
export { RuntimeOpenCodeError } from "./runtime.js";

export const monoAgentModule = defineRuntimeModule({
  manifest: {
    packageName: "@mono-agent/runtime-opencode",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "runtime",
    responsibility: "Runs an authenticated loopback OpenCode server with fail-closed tool containment and bounded native sessions.",
    capabilities: [SANDBOX_EXECUTE_CAPABILITY],
  },
  schema: { jsonSchema: runtimeOpenCodeJsonSchema, parse: parseRuntimeOpenCodeConfig },
  validateModel: validateRuntimeOpenCodeModel,
  create(context) {
    const sandboxExecutor = grantedSandboxExecutor(context.host);
    const runtime = createRuntimeOpenCode({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
      dataDirectory: context.dataDirectory,
      ...(sandboxExecutor === undefined ? {} : { sandboxExecutor }),
    });
    return { ...runtime, commands: openCodeAuthCommands(context.config) };
  },
});

export default monoAgentModule;
