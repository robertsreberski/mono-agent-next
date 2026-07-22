import {
  defineMemoryModule,
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
} from "@mono-agent/module-sdk";

import { memoryLocalJsonSchema, parseMemoryLocalConfig } from "./config.js";
import { openMemoryLocal } from "./store.js";

export {
  DEFAULT_MEMORY_MAX_METADATA_BYTES,
  DEFAULT_MEMORY_MAX_RECALL_RESULTS,
  DEFAULT_MEMORY_MAX_RECORDS,
  DEFAULT_MEMORY_MAX_TEXT_BYTES,
  DEFAULT_MEMORY_MAX_TOTAL_BYTES,
  DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS,
  DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS,
  memoryLocalJsonSchema,
  parseMemoryLocalConfig,
  type MemoryLocalCaptureConfig,
  type MemoryLocalConfig,
  type MemoryLocalLimitsConfig,
} from "./config.js";
export { MemoryLocalError, type MemoryLocalErrorCode } from "./errors.js";
export {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  MemoryLocal,
  openMemoryLocal,
  type OpenMemoryLocalOptions,
} from "./store.js";

export const monoAgentModule = defineMemoryModule({
  manifest: {
    packageName: "@mono-agent/memory-local",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "memory",
    responsibility: "Provides owner-private SQLite memory recall, capture, forgetting, and permanent first-run identity.",
    capabilities: [HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE],
  },
  schema: {
    jsonSchema: memoryLocalJsonSchema,
    parse: parseMemoryLocalConfig,
  },
  create(context) {
    return openMemoryLocal({
      config: context.config,
      configDirectory: context.configDirectory,
      dataDirectory: context.dataDirectory,
      host: context.host,
    });
  },
});

export default monoAgentModule;
