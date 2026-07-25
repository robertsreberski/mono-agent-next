// SPDX-License-Identifier: MIT
import {
  defineMemoryModule,
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
} from "@mono-agent/module-sdk";

import { memoryLocalJsonSchema, parseMemoryLocalConfig } from "./config.js";
import { openMemoryLocal } from "./store.js";

export {
  DEFAULT_EMBEDDING_BREAKER_FAILURES,
  DEFAULT_EMBEDDING_BREAKER_RESET_MS,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_MEMORY_MAX_BYTES,
  DEFAULT_MEMORY_MAX_RECALL_RESULTS,
  DEFAULT_MEMORY_MAX_RECORDS,
  DEFAULT_MEMORY_MAX_TEXT_BYTES,
  DEFAULT_MEMORY_MAX_TOTAL_BYTES,
  DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS,
  DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS,
  DEFAULT_RUNTIME_CAPTURE_TIMEOUT_MS,
  memoryLocalJsonSchema,
  parseMemoryLocalConfig,
  type MemoryLocalCaptureConfig,
  type MemoryLocalConfig,
  type MemoryLocalEmbeddingsConfig,
  type MemoryLocalModelRoute,
  type MemoryLocalRecallToolConfig,
} from "./config.js";
export {
  OllamaMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
} from "./embeddings.js";
export { MemoryLocalError, type MemoryLocalErrorCode } from "./errors.js";
export {
  MEMORY_LOCAL_V0_ADOPTION_SCHEMA,
  MEMORY_LOCAL_V0_SNAPSHOT_SCHEMA,
  adoptV0MemoryLocalCopy,
  snapshotV0MemoryLocalRoot,
  type AdoptV0MemoryLocalCopyOptions,
  type MemoryLocalV0AdoptionResult,
  type MemoryLocalV0DatabaseEvidence,
  type MemoryLocalV0SnapshotResult,
  type SnapshotV0MemoryLocalRootOptions,
} from "./migration.js";
export {
  runMemoryLocalCli,
  type MemoryLocalCliOptions,
} from "./cli.js";
export {
  MEMORY_LOCAL_FUTURE_LOG_FILENAME,
  MEMORY_LOCAL_INDEX_FILENAME,
  type MemoryLocalConsolidateResult,
  type MemoryLocalProjectionAudit,
  type MemoryLocalProjectionStatus,
} from "./consolidation.js";
export {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  MemoryLocal,
  openMemoryLocal,
  type MemoryLocalAudit,
  type MemoryLocalAuditRequest,
  type MemoryLocalBackupRequest,
  type MemoryLocalBackupResult,
  type MemoryLocalConsolidateRequest,
  type MemoryLocalForgetPreview,
  type MemoryLocalRebuildRequest,
  type MemoryLocalRebuildResult,
  type MemoryLocalRetryRequest,
  type MemoryLocalRetryResult,
  type OpenMemoryLocalOptions,
} from "./store.js";
export { MEMORY_LOCAL_WRITER_LEASE_FILENAME } from "./writer-lease.js";

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
