// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
  type MemoryHost,
  type MemoryRecord,
  type MemoryRuntimeCaptureGrant,
} from "@mono-agent/module-sdk";

import { recordLimits } from "./bujo-db.js";
import {
  DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES,
  DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS,
  type MemoryLocalConfig,
} from "./config.js";
import {
  type MemoryEmbeddingProvider,
  OllamaMemoryEmbeddingProvider,
} from "./embeddings.js";
import { MemoryLocalError } from "./errors.js";
import { canonicalJson, validateMemoryRecord } from "./records.js";

export interface CaptureIntake {
  readonly version: 1;
  readonly source: MemoryRecord;
  readonly sourceHash: string;
  readonly attempts: number;
  readonly lastFailureAt?: string;
}

export function resolveRuntimeCapture(
  config: MemoryLocalConfig,
  host: MemoryHost | undefined,
): MemoryRuntimeCaptureGrant | undefined {
  if (!config.capture.enabled) return undefined;
  if (host?.grantedCapabilities.has(HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE) !== true) {
    throw runtimeCaptureUnavailable();
  }
  const grant = host.runtimeCapture;
  if (grant === undefined || typeof grant !== "object" || grant === null || typeof grant.complete !== "function") {
    throw runtimeCaptureUnavailable();
  }
  return grant;
}

export function resolveEmbeddings(
  config: MemoryLocalConfig,
  supplied: MemoryEmbeddingProvider | undefined,
): MemoryEmbeddingProvider | undefined {
  if (config.embeddings === undefined) {
    if (supplied !== undefined) {
      throw new MemoryLocalError("embedding_unavailable", "An embedding provider was supplied without embedding config.");
    }
    return undefined;
  }
  const provider = supplied ?? new OllamaMemoryEmbeddingProvider(config.embeddings);
  if (provider.id !== `ollama:${config.embeddings.model}`
    || provider.dimensions !== config.embeddings.dimensions
    || typeof provider.embed !== "function") {
    throw new MemoryLocalError("embedding_unavailable", "Memory embedding provider identity does not match config.");
  }
  return provider;
}

export function validateRuntimeCaptureResult(
  result: Awaited<ReturnType<MemoryRuntimeCaptureGrant["complete"]>>,
  source: MemoryRecord,
): readonly MemoryRecord[] {
  if (result === null || typeof result !== "object" || Array.isArray(result) || typeof result.text !== "string") {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid result object.");
  }
  if (Buffer.byteLength(result.text, "utf8") > DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture exceeded its output byte bound.");
  }
  let output: unknown = result.structuredOutput;
  if (output === undefined) {
    try {
      output = JSON.parse(result.text) as unknown;
    } catch {
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned invalid JSON.");
    }
  }
  if (!isPlainObject(output) || Object.keys(output).length !== 1 || !Array.isArray(output.records)) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid structured object.");
  }
  if (output.records.length === 0 || output.records.length > DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid record count.");
  }
  let serialized: string;
  try {
    serialized = canonicalJson(output as never);
  } catch {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned non-JSON records.");
  }
  if (Buffer.byteLength(serialized, "utf8") > DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture exceeded its output byte bound.");
  }
  return Object.freeze(output.records.map((entry): MemoryRecord => {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 1 || typeof entry.text !== "string") {
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid extracted record.");
    }
    const text = entry.text.trim();
    if (text.length === 0) {
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an empty extracted record.");
    }
    return Object.freeze({
      id: runtimeCaptureRecordId(source.id, text),
      text,
      createdAt: source.createdAt,
      ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
    });
  }));
}

function runtimeCaptureRecordId(sourceId: string, text: string): string {
  const digest = createHash("sha256")
    .update(sourceId)
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 48);
  return `runtime:${digest}`;
}

export function runtimeCaptureResponseSchema(maxRecords: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    required: ["records"],
    additionalProperties: false,
    properties: Object.freeze({
      records: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: maxRecords,
        items: Object.freeze({
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: Object.freeze({ text: Object.freeze({ type: "string", minLength: 1 }) }),
        }),
      }),
    }),
  });
}

export function parseCaptureIntake(
  value: string,
  config: MemoryLocalConfig,
): CaptureIntake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MemoryLocalError("corrupt_store", "Memory capture intake is malformed.");
  }
  if (!isPlainObject(parsed)
    || parsed.version !== 1
    || typeof parsed.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(parsed.sourceHash)
    || !Number.isSafeInteger(parsed.attempts)
    || (parsed.attempts as number) < 0
    || (parsed.attempts as number) > 1_000_000
    || !isPlainObject(parsed.source)
    || (parsed.lastFailureAt !== undefined && !isCanonicalTimestamp(parsed.lastFailureAt))) {
    throw new MemoryLocalError("corrupt_store", "Memory capture intake has invalid bounded fields.");
  }
  const source = validateMemoryRecord(parsed.source as unknown as MemoryRecord, recordLimits(config));
  if (source.contentHash !== parsed.sourceHash) {
    throw new MemoryLocalError("corrupt_store", "Memory capture intake content hash does not match.");
  }
  return Object.freeze({
    version: 1,
    source: source.record,
    sourceHash: source.contentHash,
    attempts: parsed.attempts as number,
    ...(parsed.lastFailureAt === undefined ? {} : { lastFailureAt: parsed.lastFailureAt as string }),
  });
}

export function parseVectorIntake(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MemoryLocalError("corrupt_store", "Memory vector intake is malformed.");
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.recordId !== "string") {
    throw new MemoryLocalError("corrupt_store", "Memory vector intake has invalid bounded fields.");
  }
  validateRecordId(parsed.recordId);
  return parsed.recordId;
}

export function vectorIdentityCompatible(
  database: DatabaseSync,
  provider: MemoryEmbeddingProvider | undefined,
  vectorDimensions: number,
): boolean {
  const count = Number((database.prepare("SELECT COUNT(*) AS count FROM memories_vec").get() as unknown as
    { count: number }).count);
  if (count === 0) return provider === undefined || provider.dimensions === vectorDimensions;
  if (provider === undefined || provider.dimensions !== vectorDimensions) return false;
  const mismatch = Number((database.prepare(`
    SELECT COUNT(*) AS count
    FROM memories m
    JOIN memories_vec v ON v.rowid = m.seq
    WHERE m.embedding_model IS NULL OR m.embedding_model != ? OR m.dim IS NULL OR m.dim != ?
  `).get(provider.id, provider.dimensions) as unknown as { count: number }).count);
  return mismatch === 0;
}

export function embeddingIdentity(
  provider: MemoryEmbeddingProvider | undefined,
): { readonly id: string; readonly dimensions: number } | undefined {
  return provider === undefined
    ? undefined
    : Object.freeze({ id: provider.id, dimensions: provider.dimensions });
}

export function validateRecordId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) {
    throw new MemoryLocalError("invalid_record", "recordId has an invalid identifier.");
  }
}

export function runtimeCaptureUnavailable(): MemoryLocalError {
  return new MemoryLocalError(
    "runtime_capture_unavailable",
    "Runtime-backed capture requires an explicit bounded host grant.",
  );
}

export function embeddingUnavailable(): MemoryLocalError {
  return new MemoryLocalError(
    "embedding_unavailable",
    "Memory embedding provider is unavailable; FTS recall remains available.",
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
