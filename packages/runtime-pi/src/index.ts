import { defineRuntimeModule } from "@mono-agent/module-sdk";

import {
  parseRuntimePiConfig,
  runtimePiJsonSchema,
  type RuntimePiConfig,
} from "./config.js";
import { createRuntimePi } from "./runtime.js";

export type {
  RuntimePiConfig,
  RuntimePiLocalProviderConfig,
  RuntimePiModelConfig,
} from "./config.js";
export { RuntimePiError } from "./runtime.js";

export const monoAgentModule = defineRuntimeModule({
  manifest: {
    packageName: "@mono-agent/runtime-pi",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "runtime",
    responsibility: "Runs Pi-native turns with atomic session forks and live steering.",
    capabilities: [],
  },
  schema: {
    jsonSchema: runtimePiJsonSchema,
    parse: parseRuntimePiConfig,
  },
  create(context) {
    return createRuntimePi({
      config: context.config,
      instanceId: context.instanceId,
      configDirectory: context.configDirectory,
      workspaceDirectory: context.workspaceDirectory,
    });
  },
});

export default monoAgentModule;
