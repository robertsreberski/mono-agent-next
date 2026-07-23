import { defineRuntimeModule } from "@mono-agent/module-sdk";

import { parseRuntimeCodexConfig, runtimeCodexJsonSchema, type RuntimeCodexConfig } from "./config.js";
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
    capabilities: [],
  },
  schema: { jsonSchema: runtimeCodexJsonSchema, parse: parseRuntimeCodexConfig },
  validateModel: validateRuntimeCodexModel,
  create(context) {
    return createRuntimeCodex({
      config: context.config,
      instanceId: context.instanceId,
      workspaceDirectory: context.workspaceDirectory,
    });
  },
});

export default monoAgentModule;
