import { defineRuntimeModule } from "@mono-agent/module-sdk";

import { openCodeAuthCommands } from "./auth-command.js";
import { parseRuntimeOpenCodeConfig, runtimeOpenCodeJsonSchema, type RuntimeOpenCodeConfig } from "./config.js";
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
    capabilities: [],
  },
  schema: { jsonSchema: runtimeOpenCodeJsonSchema, parse: parseRuntimeOpenCodeConfig },
  validateModel: validateRuntimeOpenCodeModel,
  create(context) {
    const runtime = createRuntimeOpenCode({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
    });
    return { ...runtime, commands: openCodeAuthCommands(context.config) };
  },
});

export default monoAgentModule;
