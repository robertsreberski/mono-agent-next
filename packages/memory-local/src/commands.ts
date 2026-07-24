import type { JsonValue, ModuleCommand } from "@mono-agent/module-sdk";

import type {
  MemoryLocal,
  MemoryLocalAudit,
  MemoryLocalBackupResult,
  MemoryLocalRebuildResult,
} from "./store.js";
import type { MemoryLocalConsolidateResult } from "./consolidation.js";
import { MAX_MEMORY_LOCAL_INTAKE_RETRIES } from "./config.js";
import { MemoryLocalError } from "./errors.js";

const MAX_PATH_LENGTH = 4_096;

const EMPTY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

export const memoryLocalAuditCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    strict: { type: "boolean", default: false },
  },
});

export const memoryLocalBackupCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["destinationDirectory"],
  properties: {
    destinationDirectory: {
      type: "string",
      minLength: 1,
      maxLength: MAX_PATH_LENGTH,
    },
  },
});

export const memoryLocalRebuildCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["confirm"],
  properties: {
    confirm: { const: true },
  },
});

export const memoryLocalForgetCommandInputSchema = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["recordId"],
      properties: {
        recordId: { type: "string", minLength: 1, maxLength: 256 },
        dryRun: { const: true, default: true },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["recordId", "dryRun", "confirm"],
      properties: {
        recordId: { type: "string", minLength: 1, maxLength: 256 },
        dryRun: { const: false },
        confirm: { const: true },
      },
    },
  ],
});

export const memoryLocalConsolidateCommandInputSchema = EMPTY_INPUT_SCHEMA;

export const memoryLocalRetryCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_MEMORY_LOCAL_INTAKE_RETRIES,
      default: 32,
    },
  },
});

export function createMemoryLocalCommands(memory: MemoryLocal): readonly ModuleCommand[] {
  return Object.freeze([
    {
      name: "memory-local:audit",
      kind: "maintenance",
      description: "Inspect bounded BuJo identity, integrity, index coverage, and pending intake.",
      inputSchema: memoryLocalAuditCommandInputSchema,
      async run(input, context): Promise<JsonValue> {
        const parsed = ownInput(input, ["strict"], true, "Memory audit command input");
        const strict = optionalBoolean(parsed.strict, "strict") ?? false;
        return auditToJson(await memory.audit({ strict, signal: context.signal }));
      },
    },
    {
      name: "memory-local:backup",
      kind: "maintenance",
      description: "Create one verified backup in an explicitly selected empty directory.",
      inputSchema: memoryLocalBackupCommandInputSchema,
      async run(input, context): Promise<JsonValue> {
        const parsed = ownInput(
          input,
          ["destinationDirectory"],
          false,
          "Memory backup command input",
        );
        const destinationDirectory = requiredString(
          parsed.destinationDirectory,
          "destinationDirectory",
          MAX_PATH_LENGTH,
        );
        return backupToJson(await memory.backup({
          destinationDirectory,
          signal: context.signal,
        }));
      },
    },
    {
      name: "memory-local:rebuild",
      kind: "maintenance",
      description: "Rebuild FTS and configured vectors after explicit destructive confirmation.",
      inputSchema: memoryLocalRebuildCommandInputSchema,
      async run(input, context): Promise<JsonValue> {
        const parsed = ownInput(input, ["confirm"], false, "Memory rebuild command input");
        requireConfirmation(parsed.confirm, "rebuild");
        return rebuildToJson(await memory.rebuild({ signal: context.signal }));
      },
    },
    {
      name: "memory-local:forget",
      kind: "maintenance",
      description:
        "Preview one exact record by default, or forget it only with dryRun false and confirm true.",
      inputSchema: memoryLocalForgetCommandInputSchema,
      async run(input, context): Promise<JsonValue> {
        const parsed = ownInput(
          input,
          ["recordId", "dryRun", "confirm"],
          false,
          "Memory forget command input",
        );
        const recordId = requiredString(parsed.recordId, "recordId", 256);
        const dryRun = optionalBoolean(parsed.dryRun, "dryRun") ?? true;
        if (dryRun) {
          if (parsed.confirm !== undefined) {
            invalid("Memory forget preview does not accept confirm.");
          }
          const preview = await memory.previewForget(recordId, context.signal);
          return {
            operation: "preview",
            dryRun: true,
            recordId,
            found: preview.found,
            vectorPresent: preview.vectorPresent,
            ...(preview.record === undefined
              ? {}
              : {
                  record: {
                    id: preview.record.id,
                    text: preview.record.text,
                    createdAt: preview.record.createdAt,
                    ...(preview.record.metadata === undefined
                      ? {}
                      : { metadata: preview.record.metadata }),
                  },
                }),
          };
        }
        requireConfirmation(parsed.confirm, "forget");
        return {
          operation: "forget",
          dryRun: false,
          confirmed: true,
          recordId,
          forgotten: await memory.forget({ recordId, signal: context.signal }),
        };
      },
    },
    {
      name: "memory-local:consolidate",
      kind: "maintenance",
      description:
        "Refresh deterministic index and future-log projections without model or embedding calls.",
      inputSchema: memoryLocalConsolidateCommandInputSchema,
      async run(input, context): Promise<JsonValue> {
        ownInput(input, [], true, "Memory consolidation command input");
        return consolidateToJson(await memory.consolidate({ signal: context.signal }));
      },
    },
    {
      name: "memory-local:retry",
      kind: "maintenance",
      description:
        "Retry bounded durable capture or vector intake using this running host's providers.",
      inputSchema: memoryLocalRetryCommandInputSchema,
      async run(input, context): Promise<JsonValue> {
        const parsed = ownInput(input, ["limit"], true, "Memory intake retry command input");
        const limit = optionalBoundedInteger(
          parsed.limit,
          "limit",
          1,
          MAX_MEMORY_LOCAL_INTAKE_RETRIES,
        );
        return retryToJson(await memory.retryIntake({
          signal: context.signal,
          ...(limit === undefined ? {} : { limit }),
        }));
      },
    },
  ] satisfies readonly ModuleCommand[]);
}

function ownInput(
  value: unknown,
  allowed: readonly string[],
  allowUndefined: boolean,
  label: string,
): Record<string, unknown> {
  const input = value === undefined && allowUndefined ? {} : value;
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || (
      Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null
    )
  ) {
    invalid(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    invalid(`${label} contains an unknown field.`);
  }
  const parsed: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      invalid(`${label}.${key} must be an own data property.`);
    }
    parsed[key] = descriptor.value;
  }
  return parsed;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(`${field} must be a non-empty bounded string without control characters.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid(`${field} must be a boolean.`);
  return value;
}

function optionalBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function requireConfirmation(value: unknown, operation: string): void {
  if (value !== true) {
    invalid(`Memory ${operation} requires explicit confirm: true.`);
  }
}

function invalid(message: string): never {
  throw new MemoryLocalError("maintenance_failed", message);
}

function auditToJson(result: MemoryLocalAudit): JsonValue {
  return {
    status: result.status,
    schema: result.schema,
    storeId: result.storeId,
    database: {
      device: result.database.device,
      inode: result.database.inode,
      mode: result.database.mode,
      links: result.database.links,
    },
    marker: {
      device: result.marker.device,
      inode: result.marker.inode,
      mode: result.marker.mode,
      links: result.marker.links,
    },
    records: result.records,
    recordBytes: result.recordBytes,
    fts: {
      indexed: result.fts.indexed,
      missing: result.fts.missing,
      orphaned: result.fts.orphaned,
    },
    vectors: {
      indexed: result.vectors.indexed,
      missing: result.vectors.missing,
      dimensions: result.vectors.dimensions,
      configured: result.vectors.configured,
      compatible: result.vectors.compatible,
    },
    intake: {
      captures: result.intake.captures,
      vectors: result.intake.vectors,
    },
    projections: {
      index: result.projections.index,
      futureLog: result.projections.futureLog,
      complete: result.projections.complete,
      coherent: result.projections.coherent,
    },
  };
}

function backupToJson(result: MemoryLocalBackupResult): JsonValue {
  return {
    directory: result.directory,
    databaseSha256: result.databaseSha256,
    markerSha256: result.markerSha256,
    recordCount: result.recordCount,
  };
}

function rebuildToJson(result: MemoryLocalRebuildResult): JsonValue {
  return {
    records: result.records,
    ftsIndexed: result.ftsIndexed,
    vectorsIndexed: result.vectorsIndexed,
    vectorDimensions: result.vectorDimensions,
  };
}

function consolidateToJson(result: MemoryLocalConsolidateResult): JsonValue {
  return {
    duplicateGroups: result.duplicateGroups,
    records: result.records,
    entities: result.entities,
    indexBytes: result.indexBytes,
    futureLogBytes: result.futureLogBytes,
  };
}

function retryToJson(result: Awaited<ReturnType<MemoryLocal["retryIntake"]>>): JsonValue {
  return {
    capturesRetried: result.capturesRetried,
    vectorsRetried: result.vectorsRetried,
    failed: result.failed,
    remainingCaptures: result.remainingCaptures,
    remainingVectors: result.remainingVectors,
  };
}
