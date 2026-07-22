import { defineRuntimeModule } from "@mono-agent/module-sdk";

import { parseRuntimeOpenCodeConfig, runtimeOpenCodeJsonSchema, type RuntimeOpenCodeConfig } from "./config.js";
import { createRuntimeOpenCode } from "./runtime.js";

export type { RuntimeOpenCodeConfig } from "./config.js";
export { RuntimeOpenCodeError } from "./runtime.js";

export const monoAgentModule = defineRuntimeModule({
  manifest: {
    packageName: "@mono-agent/runtime-opencode",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "runtime",
    responsibility: "Runs OpenCode JSONL process attempts with version preflight and bounded native session handling.",
    capabilities: [],
  },
  schema: { jsonSchema: runtimeOpenCodeJsonSchema, parse: parseRuntimeOpenCodeConfig },
  create(context) {
    return createRuntimeOpenCode({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
    });
  },
});

export default monoAgentModule;
