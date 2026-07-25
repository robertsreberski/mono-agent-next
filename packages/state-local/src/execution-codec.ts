// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import {
  parseArtifactRef,
  parseRouteIdentity,
  type ArtifactRef,
  type JsonObject,
  type JsonValue,
  type RuntimeSession,
  type RouteIdentity,
} from "@mono-agent/module-sdk";

import {
  conversationChunkPrefix,
  conversationChunkStateKey,
  conversationStateKey,
  runHistoryStateKey,
  type ExecutionRecord,
} from "./execution-store.js";

import {
  MIN_STALE_AFTER_MS,
  MAX_STALE_AFTER_MS,
  RUN_MAX_EVENTS,
  RUN_MAX_ATTEMPTS,
  RUN_ARTIFACT_MAX_ITEMS,
  RUN_CONTENT_ARTIFACT_MAX_TOTAL_BYTES,
  FINGERPRINT_MAX_ITEMS,
  FINGERPRINT_MAX_BYTES,
  IDENTIFIER_MAX_BYTES,
  CONVERSATION_ID_MAX_BYTES,
  CODE_MAX_BYTES,
  SESSION_METADATA_MAX_ITEMS,
  SESSION_METADATA_MAX_BYTES,
  CONVERSATION_TITLE_MAX_BYTES,
  TRANSCRIPT_CHUNK_MAX_BYTES,
  TRANSCRIPT_CHUNK_MAX_ITEMS,
  TRANSCRIPT_MAX_BYTES,
  INTERNAL_ARTIFACT_SLOT_PREFIX,
  TRANSCRIPT_ARTIFACT_SLOT,
  RESPONSE_ARTIFACT_SLOT,
} from "./execution-journal-constants.js";

import {
  encodeCanonicalTranscript,
  parseCanonicalTranscript,
  parseInteractionEvidence,
  type CanonicalTranscript,
  type CanonicalTranscriptEntry,
} from "./execution-transcript.js";

import type {
  AgentRunAttemptEvidence,
  AgentRunEvent,
  AgentRunStatus,
  AgentRunSummary,
} from "./execution-types.js";

import type { DurableFingerprint } from "./execution-journal.js";

import type {
  AdmissionRecord,
  StoredRunRecord,
  StoredRunEvent,
  RunHistoryRecord,
  ConversationRecord,
  ConversationDeliveryEntryRecord,
  TranscriptChunkDescriptor,
  TranscriptChunkManifest,
  ChunkedCanonicalTranscript,
  ProviderSessionRecord,
  ArtifactPublicationDescriptor,
  ArtifactPublicationIntentRecord,
  DeliveryRecord,
  RunRetentionCheckpoint,
} from "./execution-journal-records.js";
import {
  boundedText,
  canonicalTimestamp,
  denseOwnDataArray,
  ownDataRecord,
} from "./validation.js";

export {
  boundedText,
  canonicalTimestamp,
  denseOwnDataArray,
  ownDataRecord,
} from "./validation.js";

/**
 * Compute a deterministic request or delivery fingerprint without retaining
 * source bytes. Callers pass a bounded own-data graph; byte arrays contribute
 * only their length and SHA-256 digest.
 */
export function createDurableFingerprint(value: unknown): DurableFingerprint {
  const state = { items: 0, bytes: 0, active: new Set<object>() };
  const canonical = canonicalFingerprintValue(value, "$", state);
  const encoded = JSON.stringify(canonical);
  if (Buffer.byteLength(encoded, "utf8") > FINGERPRINT_MAX_BYTES) {
    throw new RangeError("fingerprint material exceeds its byte limit");
  }
  return `sha256:${createHash("sha256")
    .update("mono-agent:durable-fingerprint:v1\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex")}`;
}

export function parseAdmissionRecord(value: unknown): AdmissionRecord {
  const input = ownDataRecord(
    value,
    "admission record",
    [
      "schemaVersion",
      "kind",
      "requestId",
      "conversationId",
      "fingerprint",
      "runId",
      "status",
      "startedAt",
      "updatedAt",
      "leaseExpiresAt",
      "settledStatus",
      "responseRef",
    ],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.admission") {
    throw new TypeError("admission record has an unsupported schema");
  }
  const status = stringEnum(
    input.status,
    ["running", "settled", "uncertain"] as const,
    "admission record.status",
  );
  const settledStatus = input.settledStatus === undefined
    ? undefined
    : terminalRunStatus(input.settledStatus, "admission record.settledStatus");
  if ((status === "running") === (settledStatus !== undefined)) {
    throw new TypeError("admission record settlement fields are inconsistent");
  }
  const responseRef = input.responseRef === undefined
    ? undefined
    : parseArtifactRef(input.responseRef);
  if (status === "running" && responseRef !== undefined) {
    throw new TypeError("running admission cannot carry a response");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.admission",
    requestId: boundedIdentifier(input.requestId, "admission record.requestId"),
    conversationId: boundedConversationId(
      input.conversationId,
      "admission record.conversationId",
    ),
    fingerprint: parseFingerprint(input.fingerprint, "admission record.fingerprint"),
    runId: boundedIdentifier(input.runId, "admission record.runId"),
    status,
    startedAt: canonicalTimestamp(input.startedAt, "admission record.startedAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "admission record.updatedAt"),
    leaseExpiresAt: canonicalTimestamp(
      input.leaseExpiresAt,
      "admission record.leaseExpiresAt",
    ),
    ...(settledStatus === undefined ? {} : { settledStatus }),
    ...(responseRef === undefined ? {} : { responseRef }),
  });
}

export function parseStoredRunRecord(value: unknown): StoredRunRecord {
  const input = ownDataRecord(
    value,
    "run record",
    ["schemaVersion", "kind", "summary", "eventCount", "transcriptRef"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.run") {
    throw new TypeError("run record has an unsupported schema");
  }
  const summary = parseRunSummary(input.summary);
  const eventCount = boundedInteger(input.eventCount, "run record.eventCount", 1, RUN_MAX_EVENTS);
  const transcriptRef = input.transcriptRef === undefined
    ? undefined
    : parseArtifactRef(input.transcriptRef);
  if ((summary.transcriptRevision !== undefined) !== (transcriptRef !== undefined)) {
    throw new TypeError("run transcript fields are inconsistent");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run",
    summary,
    eventCount,
    ...(transcriptRef === undefined ? {} : { transcriptRef }),
  });
}

export function parseStoredRunEvent(value: unknown): StoredRunEvent {
  const input = ownDataRecord(
    value,
    "run event record",
    ["schemaVersion", "kind", "event"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.run-event") {
    throw new TypeError("run event record has an unsupported schema");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-event",
    event: parseRunEvent(input.event),
  });
}

export function parseRunHistoryRecord(value: unknown): RunHistoryRecord {
  const input = ownDataRecord(
    value,
    "run history record",
    ["schemaVersion", "kind", "runId", "startedAt"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.run-history") {
    throw new TypeError("run history record has an unsupported schema");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-history",
    runId: boundedIdentifier(input.runId, "run history record.runId"),
    startedAt: canonicalTimestamp(input.startedAt, "run history record.startedAt"),
  });
}

export function parseConversationRecord(value: unknown): ConversationRecord {
  const input = ownDataRecord(
    value,
    "conversation record",
    [
      "schemaVersion",
      "kind",
      "conversationId",
      "revision",
      "inlineTranscript",
      "transcriptChunks",
      "transcriptRef",
      "entryCount",
      "createdAt",
      "updatedAt",
      "title",
      "metadata",
    ],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.conversation") {
    throw new TypeError("conversation record has an unsupported schema");
  }
  const conversationId = boundedConversationId(
    input.conversationId,
    "conversation record.conversationId",
  );
  const inlineTranscript = input.inlineTranscript === undefined
    ? undefined
    : parseCanonicalTranscript(input.inlineTranscript);
  const transcriptChunks = input.transcriptChunks === undefined
    ? undefined
    : parseTranscriptChunkManifest(
        input.transcriptChunks,
        conversationId,
      );
  const transcriptRef = input.transcriptRef === undefined
    ? undefined
    : parseArtifactRef(input.transcriptRef);
  if (
    Number(inlineTranscript !== undefined)
      + Number(transcriptChunks !== undefined)
      + Number(transcriptRef !== undefined)
    !== 1
  ) {
    throw new TypeError(
      "conversation record must carry exactly one transcript representation",
    );
  }
  if (
    inlineTranscript !== undefined
    && inlineTranscript.conversationId !== conversationId
  ) {
    throw new TypeError("inline transcript conversation identity does not match");
  }
  const revision = boundedInteger(
    input.revision,
    "conversation record.revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const entryCount = boundedInteger(
    input.entryCount,
    "conversation record.entryCount",
    0,
    50_000,
  );
  if (
    inlineTranscript !== undefined
    && (
      inlineTranscript.revision !== revision
      || inlineTranscript.entries.length !== entryCount
    )
  ) {
    throw new TypeError("inline transcript does not match its conversation record");
  }
  const title = input.title === undefined
    ? undefined
    : boundedText(
      input.title,
      "conversation record.title",
      CONVERSATION_TITLE_MAX_BYTES,
      true,
    );
  const metadata = input.metadata === undefined
    ? undefined
    : parseSessionMetadata(input.metadata, "conversation record.metadata");
  const createdAt = input.createdAt === undefined
    ? undefined
    : canonicalTimestamp(input.createdAt, "conversation record.createdAt");
  const updatedAt = canonicalTimestamp(
    input.updatedAt,
    "conversation record.updatedAt",
  );
  if (createdAt !== undefined && createdAt > updatedAt) {
    throw new TypeError("conversation record timestamps are non-monotonic");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.conversation",
    conversationId,
    revision,
    ...(inlineTranscript === undefined ? {} : { inlineTranscript }),
    ...(transcriptChunks === undefined ? {} : { transcriptChunks }),
    ...(transcriptRef === undefined ? {} : { transcriptRef }),
    entryCount,
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt,
    ...(title === undefined ? {} : { title }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function assertConversationKeyAuthority(
  record: ExecutionRecord<ConversationRecord>,
  requestedConversationId?: string,
): void {
  if (
    record.key !== conversationStateKey(record.value.conversationId)
    || (
      requestedConversationId !== undefined
      && record.value.conversationId !== requestedConversationId
    )
  ) {
    throw new Error(
      "conversation record key does not match its conversation identity",
    );
  }
}

export function parseConversationDeliveryEntryRecord(
  value: unknown,
): ConversationDeliveryEntryRecord {
  const input = ownDataRecord(
    value,
    "conversation delivery entry record",
    [
      "schemaVersion",
      "kind",
      "entryId",
      "conversationId",
      "deliveryIdempotencyKey",
      "deliveryFingerprint",
      "fingerprint",
      "entryDigest",
      "revision",
      "entryCount",
      "createdAt",
    ],
  );
  if (
    input.schemaVersion !== 1
    || input.kind !== "mono-agent.conversation-delivery-entry"
  ) {
    throw new TypeError(
      "conversation delivery entry record has an unsupported schema",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.conversation-delivery-entry",
    entryId: boundedIdentifier(
      input.entryId,
      "conversation delivery entry record.entryId",
    ),
    conversationId: boundedConversationId(
      input.conversationId,
      "conversation delivery entry record.conversationId",
    ),
    deliveryIdempotencyKey: boundedIdentifier(
      input.deliveryIdempotencyKey,
      "conversation delivery entry record.deliveryIdempotencyKey",
    ),
    deliveryFingerprint: parseFingerprint(
      input.deliveryFingerprint,
      "conversation delivery entry record.deliveryFingerprint",
    ),
    fingerprint: parseFingerprint(
      input.fingerprint,
      "conversation delivery entry record.fingerprint",
    ),
    entryDigest: parseFingerprint(
      input.entryDigest,
      "conversation delivery entry record.entryDigest",
    ),
    revision: boundedInteger(
      input.revision,
      "conversation delivery entry record.revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    entryCount: boundedInteger(
      input.entryCount,
      "conversation delivery entry record.entryCount",
      1,
      50_000,
    ),
    createdAt: canonicalTimestamp(
      input.createdAt,
      "conversation delivery entry record.createdAt",
    ),
  });
}

export function parseDeliveryTranscriptEntry(
  value: unknown,
  conversationId: string,
  recordedAt: string,
): CanonicalTranscriptEntry {
  const kind = ownDataField(value, "kind");
  const input = ownDataRecord(
    value,
    "conversation delivery entry",
    kind === "message"
      ? [
          "kind",
          "entryId",
          "runId",
          "requestId",
          "conversationId",
          "role",
          "content",
          "route",
        ]
      : kind === "verbatim"
        ? [
            "kind",
            "entryId",
            "runId",
            "requestId",
            "conversationId",
            "role",
            "text",
          ]
        : ["kind"],
  );
  const transcript = parseCanonicalTranscript({
    schemaVersion: 1,
    kind: "mono-agent.canonical-transcript",
    conversationId,
    revision: 1,
    entries: [{ ...input, recordedAt }],
  });
  const entry = transcript.entries[0]!;
  if (entry.kind === "interaction" || entry.role !== "assistant") {
    throw new TypeError(
      "conversation delivery entry must be an assistant message or verbatim entry",
    );
  }
  return entry;
}

export function deliveryEntryAuthorityDigest(
  entry: CanonicalTranscriptEntry,
): DurableFingerprint {
  if (entry.kind === "interaction" || entry.role !== "assistant") {
    throw new TypeError(
      "conversation delivery entry must be an assistant message or verbatim entry",
    );
  }
  const authority = entry.kind === "message"
    ? {
        kind: entry.kind,
        entryId: entry.entryId,
        runId: entry.runId,
        requestId: entry.requestId,
        conversationId: entry.conversationId,
        role: entry.role,
        content: entry.content,
        ...(entry.route === undefined ? {} : { route: entry.route }),
      }
    : {
        kind: entry.kind,
        entryId: entry.entryId,
        runId: entry.runId,
        requestId: entry.requestId,
        conversationId: entry.conversationId,
        role: entry.role,
        text: entry.text,
      };
  const encoded = JSON.stringify(authority);
  if (Buffer.byteLength(encoded, "utf8") > TRANSCRIPT_MAX_BYTES) {
    throw new RangeError("conversation delivery entry exceeds its byte bound");
  }
  return `sha256:${createHash("sha256")
    .update("mono-agent:conversation-delivery-entry:v1\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex")}`;
}

function ownDataField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

export function chunkCanonicalTranscript(
  transcript: CanonicalTranscript,
): ChunkedCanonicalTranscript {
  const parsed = parseCanonicalTranscript(transcript);
  const encoded = encodeCanonicalTranscript(parsed);
  if (encoded.byteLength < 1 || encoded.byteLength > TRANSCRIPT_MAX_BYTES) {
    throw new RangeError("canonical transcript is outside its chunked byte bound");
  }
  const chunks: {
    readonly descriptor: TranscriptChunkDescriptor;
    readonly bytes: Uint8Array;
  }[] = [];
  for (
    let offset = 0;
    offset < encoded.byteLength;
    offset += TRANSCRIPT_CHUNK_MAX_BYTES
  ) {
    if (chunks.length >= TRANSCRIPT_CHUNK_MAX_ITEMS) {
      throw new RangeError("canonical transcript exceeds its chunk count");
    }
    const bytes = encoded.slice(
      offset,
      Math.min(offset + TRANSCRIPT_CHUNK_MAX_BYTES, encoded.byteLength),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    const descriptor = Object.freeze({
      key: conversationChunkStateKey(
        parsed.conversationId,
        chunks.length,
        digest,
      ),
      digest,
      sizeBytes: bytes.byteLength,
    });
    chunks.push(Object.freeze({ descriptor, bytes }));
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.canonical-transcript-chunks",
    encoding: "utf8-json",
    digest: createHash("sha256").update(encoded).digest("hex"),
    sizeBytes: encoded.byteLength,
    chunks: Object.freeze(chunks.map((chunk) => chunk.descriptor)),
  } as const satisfies TranscriptChunkManifest);
  return Object.freeze({
    manifest,
    chunks: Object.freeze(chunks),
  });
}

function parseTranscriptChunkManifest(
  value: unknown,
  conversationId: string,
): TranscriptChunkManifest {
  const input = ownDataRecord(
    value,
    "conversation transcript chunks",
    ["schemaVersion", "kind", "encoding", "digest", "sizeBytes", "chunks"],
  );
  if (
    input.schemaVersion !== 1
    || input.kind !== "mono-agent.canonical-transcript-chunks"
    || input.encoding !== "utf8-json"
  ) {
    throw new TypeError("conversation transcript chunks have an unsupported schema");
  }
  const digest = transcriptChunkDigest(
    input.digest,
    "conversation transcript chunks.digest",
  );
  const sizeBytes = boundedInteger(
    input.sizeBytes,
    "conversation transcript chunks.sizeBytes",
    1,
    TRANSCRIPT_MAX_BYTES,
  );
  const rawChunks = denseOwnDataArray(
    input.chunks,
    "conversation transcript chunks.chunks",
    TRANSCRIPT_CHUNK_MAX_ITEMS,
  );
  if (rawChunks.length === 0) {
    throw new TypeError("conversation transcript chunks must not be empty");
  }
  let describedBytes = 0;
  const prefix = conversationChunkPrefix(conversationId);
  const chunks = rawChunks.map((value, index): TranscriptChunkDescriptor => {
    const path = `conversation transcript chunks.chunks.${String(index)}`;
    const chunk = ownDataRecord(value, path, ["key", "digest", "sizeBytes"]);
    const chunkDigest = transcriptChunkDigest(chunk.digest, `${path}.digest`);
    const key = boundedText(chunk.key, `${path}.key`, 4_096, false);
    if (
      !key.startsWith(prefix)
      || key !== conversationChunkStateKey(conversationId, index, chunkDigest)
    ) {
      throw new TypeError(`${path}.key does not match its conversation authority`);
    }
    const chunkBytes = boundedInteger(
      chunk.sizeBytes,
      `${path}.sizeBytes`,
      1,
      TRANSCRIPT_CHUNK_MAX_BYTES,
    );
    describedBytes += chunkBytes;
    if (!Number.isSafeInteger(describedBytes) || describedBytes > TRANSCRIPT_MAX_BYTES) {
      throw new RangeError("conversation transcript chunks exceed their byte bound");
    }
    return Object.freeze({
      key,
      digest: chunkDigest,
      sizeBytes: chunkBytes,
    });
  });
  if (describedBytes !== sizeBytes) {
    throw new TypeError("conversation transcript chunks do not match their declared size");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.canonical-transcript-chunks",
    encoding: "utf8-json",
    digest,
    sizeBytes,
    chunks: Object.freeze(chunks),
  });
}

function transcriptChunkDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function parseProviderSessionRecord(value: unknown): ProviderSessionRecord {
  const input = ownDataRecord(
    value,
    "provider session record",
    ["schemaVersion", "kind", "conversationId", "route", "session", "updatedAt"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.provider-session") {
    throw new TypeError("provider session record has an unsupported schema");
  }
  const conversationId = boundedConversationId(
    input.conversationId,
    "provider session record.conversationId",
  );
  const route = parseRouteIdentity(input.route);
  const session = parseRuntimeSession(input.session, "provider session record.session");
  if (
    session.conversationId !== conversationId
    || !sameRoute(session.route, route)
  ) {
    throw new TypeError("provider session record authority is inconsistent");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.provider-session",
    conversationId,
    route,
    session,
    updatedAt: canonicalTimestamp(
      input.updatedAt,
      "provider session record.updatedAt",
    ),
  });
}

export function parseArtifactPublicationIntentRecord(
  value: unknown,
): ArtifactPublicationIntentRecord {
  const input = ownDataRecord(
    value,
    "artifact publication intent",
    [
      "schemaVersion",
      "kind",
      "runId",
      "requestId",
      "artifacts",
      "cleanupArtifacts",
      "createdAt",
      "updatedAt",
    ],
  );
  if (
    input.schemaVersion !== 1
    || input.kind !== "mono-agent.artifact-publication-intent"
  ) {
    throw new TypeError("artifact publication intent has an unsupported schema");
  }
  const rawArtifacts = denseOwnDataArray(
    input.artifacts,
    "artifact publication intent.artifacts",
    RUN_ARTIFACT_MAX_ITEMS,
  );
  const rawCleanupArtifacts = denseOwnDataArray(
    input.cleanupArtifacts,
    "artifact publication intent.cleanupArtifacts",
    RUN_ARTIFACT_MAX_ITEMS,
  );
  if (rawArtifacts.length + rawCleanupArtifacts.length === 0) {
    throw new TypeError("artifact publication intent must name at least one artifact");
  }
  if (rawArtifacts.length + rawCleanupArtifacts.length > RUN_ARTIFACT_MAX_ITEMS) {
    throw new RangeError("artifact publication intent exceeds its item limit");
  }
  const seenSlots = new Set<string>();
  const parseUnique = (
    artifact: unknown,
    path: string,
  ): ArtifactPublicationDescriptor => {
    const parsed = parseArtifactPublicationDescriptor(
      artifact,
      path,
    );
    if (seenSlots.has(parsed.slot)) {
      throw new TypeError("artifact publication intent contains a duplicate slot");
    }
    seenSlots.add(parsed.slot);
    return parsed;
  };
  const artifacts = rawArtifacts.map((artifact, index) =>
    parseUnique(
      artifact,
      `artifact publication intent.artifacts.${String(index)}`,
    ));
  const cleanupArtifacts = rawCleanupArtifacts.map((artifact, index) =>
    parseUnique(
      artifact,
      `artifact publication intent.cleanupArtifacts.${String(index)}`,
    ));
  assertArtifactPublicationBounds([...artifacts, ...cleanupArtifacts]);
  const createdAt = canonicalTimestamp(
    input.createdAt,
    "artifact publication intent.createdAt",
  );
  const updatedAt = canonicalTimestamp(
    input.updatedAt,
    "artifact publication intent.updatedAt",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError("artifact publication intent timestamps are non-monotonic");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.artifact-publication-intent",
    runId: boundedIdentifier(input.runId, "artifact publication intent.runId"),
    requestId: boundedIdentifier(
      input.requestId,
      "artifact publication intent.requestId",
    ),
    artifacts: Object.freeze(artifacts),
    cleanupArtifacts: Object.freeze(cleanupArtifacts),
    createdAt,
    updatedAt,
  });
}

export function parseArtifactPublicationDescriptor(
  value: unknown,
  path: string,
): ArtifactPublicationDescriptor {
  const input = ownDataRecord(
    value,
    path,
    ["slot", "sha256", "sizeBytes", "mediaType", "fileName"],
  );
  const ref = parseArtifactRef({
    id: `artifact:${String(input.sha256)}`,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    mediaType: input.mediaType,
    ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
  });
  return Object.freeze({
    slot: artifactSlot(input.slot, `${path}.slot`, true),
    sha256: ref.sha256,
    sizeBytes: ref.sizeBytes,
    mediaType: ref.mediaType,
    ...(ref.fileName === undefined ? {} : { fileName: ref.fileName }),
  });
}

export function parseRuntimeSession(value: unknown, path: string): RuntimeSession {
  const input = ownDataRecord(
    value,
    path,
    ["id", "conversationId", "route", "createdAt", "expiresAt", "metadata"],
  );
  const createdAt = input.createdAt === undefined
    ? undefined
    : canonicalTimestamp(input.createdAt, `${path}.createdAt`);
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : canonicalTimestamp(input.expiresAt, `${path}.expiresAt`);
  if (
    createdAt !== undefined
    && expiresAt !== undefined
    && Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    throw new TypeError(`${path}.expiresAt must be later than createdAt`);
  }
  const metadata = input.metadata === undefined
    ? undefined
    : parseSessionMetadata(input.metadata, `${path}.metadata`);
  return Object.freeze({
    id: boundedIdentifier(input.id, `${path}.id`),
    conversationId: boundedConversationId(
      input.conversationId,
      `${path}.conversationId`,
    ),
    route: parseRouteIdentity(input.route),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function parseSessionMetadata(value: unknown, path: string): JsonObject {
  const state = { items: 0, bytes: 0, active: new Set<object>() };
  const parsed = parseSessionJsonValue(value, path, state);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must be a JSON object`);
  }
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > SESSION_METADATA_MAX_BYTES) {
    throw new RangeError(`${path} exceeds its byte limit`);
  }
  return parsed as JsonObject;
}

function parseSessionJsonValue(
  value: unknown,
  path: string,
  state: { items: number; bytes: number; readonly active: Set<object> },
): JsonValue {
  state.items += 1;
  if (state.items > SESSION_METADATA_MAX_ITEMS) {
    throw new RangeError(`${path} has too many JSON items`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > SESSION_METADATA_MAX_BYTES) {
      throw new RangeError(`${path} exceeds its byte limit`);
    }
    return value;
  }
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) {
    throw new TypeError(`${path} must contain only JSON values`);
  }
  if (state.active.has(value)) throw new TypeError(`${path} must not contain cycles`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const raw = denseOwnDataArray(value, path, SESSION_METADATA_MAX_ITEMS);
      return Object.freeze(raw.map((entry, index) =>
        parseSessionJsonValue(entry, `${path}.${String(index)}`, state)));
    }
    const keys = ownStringKeys(value).sort();
    const input = ownDataRecord(value, path, keys);
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) {
      output[key] = parseSessionJsonValue(input[key], `${path}.${key}`, state);
    }
    return Object.freeze(output);
  } finally {
    state.active.delete(value);
  }
}

export function parseDeliveryRecord(value: unknown): DeliveryRecord {
  const input = ownDataRecord(
    value,
    "delivery record",
    [
      "schemaVersion",
      "kind",
      "idempotencyKey",
      "fingerprint",
      "channelInstanceId",
      "runId",
      "status",
      "attempts",
      "attemptToken",
      "createdAt",
      "updatedAt",
      "leaseExpiresAt",
      "messageId",
      "code",
      "historyEntryId",
      "historyConversationId",
      "historyEntryFingerprint",
      "historyEntryDigest",
    ],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.delivery") {
    throw new TypeError("delivery record has an unsupported schema");
  }
  const status = stringEnum(
    input.status,
    ["intent", "delivered", "failed", "unknown"] as const,
    "delivery record.status",
  );
  const leaseExpiresAt = input.leaseExpiresAt === undefined
    ? undefined
    : canonicalTimestamp(input.leaseExpiresAt, "delivery record.leaseExpiresAt");
  const messageId = input.messageId === undefined
    ? undefined
    : boundedIdentifier(input.messageId, "delivery record.messageId");
  const code = input.code === undefined
    ? undefined
    : boundedCode(input.code, "delivery record.code");
  const historyEntryId = input.historyEntryId === undefined
    ? undefined
    : boundedIdentifier(input.historyEntryId, "delivery record.historyEntryId");
  const historyConversationId = input.historyConversationId === undefined
    ? undefined
    : boundedConversationId(
        input.historyConversationId,
        "delivery record.historyConversationId",
      );
  const historyEntryFingerprint = input.historyEntryFingerprint === undefined
    ? undefined
    : parseFingerprint(
        input.historyEntryFingerprint,
        "delivery record.historyEntryFingerprint",
      );
  const historyEntryDigest = input.historyEntryDigest === undefined
    ? undefined
    : parseFingerprint(
        input.historyEntryDigest,
        "delivery record.historyEntryDigest",
      );
  const historyAuthorityCount = [
    historyEntryId,
    historyConversationId,
    historyEntryFingerprint,
    historyEntryDigest,
  ].filter((part) => part !== undefined).length;
  if ((status === "intent") !== (leaseExpiresAt !== undefined)) {
    throw new TypeError("delivery intent lease fields are inconsistent");
  }
  if (status !== "delivered" && messageId !== undefined) {
    throw new TypeError("non-delivered state cannot carry a message receipt");
  }
  if ((status === "failed" || status === "unknown") !== (code !== undefined)) {
    throw new TypeError("delivery diagnostic fields are inconsistent");
  }
  if (
    historyAuthorityCount !== 0
    && (historyAuthorityCount !== 4 || status !== "delivered")
  ) {
    throw new TypeError(
      "delivery destination-history authority fields are inconsistent",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.delivery",
    idempotencyKey: boundedIdentifier(
      input.idempotencyKey,
      "delivery record.idempotencyKey",
    ),
    fingerprint: parseFingerprint(input.fingerprint, "delivery record.fingerprint"),
    channelInstanceId: boundedIdentifier(
      input.channelInstanceId,
      "delivery record.channelInstanceId",
    ),
    ...(input.runId === undefined
      ? {}
      : { runId: boundedIdentifier(input.runId, "delivery record.runId") }),
    status,
    attempts: boundedInteger(input.attempts, "delivery record.attempts", 1, 10_000),
    attemptToken: boundedIdentifier(
      input.attemptToken,
      "delivery record.attemptToken",
    ),
    createdAt: canonicalTimestamp(input.createdAt, "delivery record.createdAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "delivery record.updatedAt"),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(code === undefined ? {} : { code }),
    ...(historyEntryId === undefined ? {} : {
      historyEntryId,
      historyConversationId: historyConversationId!,
      historyEntryFingerprint: historyEntryFingerprint!,
      historyEntryDigest: historyEntryDigest!,
    }),
  });
}

export function assertDeliveryKeyAuthority(
  record: DeliveryRecord,
  requestedIdempotencyKey: string,
): void {
  if (record.idempotencyKey !== requestedIdempotencyKey) {
    throw new Error(
      "delivery record key does not match its idempotency identity",
    );
  }
}

export function parseRunRetentionCheckpoint(value: unknown): RunRetentionCheckpoint {
  const input = ownDataRecord(
    value,
    "run retention checkpoint",
    [
      "schemaVersion",
      "kind",
      "runId",
      "historyKey",
      "requestId",
      "startedAt",
      "endedAt",
      "artifacts",
      "createdAt",
    ],
  );
  if (
    input.schemaVersion !== 1
    || input.kind !== "mono-agent.run-retention-checkpoint"
  ) {
    throw new TypeError("run retention checkpoint has an unsupported schema");
  }
  const runId = boundedIdentifier(input.runId, "run retention checkpoint.runId");
  const requestId = boundedIdentifier(
    input.requestId,
    "run retention checkpoint.requestId",
  );
  const startedAt = canonicalTimestamp(
    input.startedAt,
    "run retention checkpoint.startedAt",
  );
  const endedAt = canonicalTimestamp(
    input.endedAt,
    "run retention checkpoint.endedAt",
  );
  if (endedAt < startedAt) {
    throw new TypeError("run retention checkpoint timestamps are non-monotonic");
  }
  const historyKey = boundedIdentifier(
    input.historyKey,
    "run retention checkpoint.historyKey",
  );
  if (historyKey !== runHistoryStateKey(startedAt, runId)) {
    throw new TypeError("run retention checkpoint history key is mismatched");
  }
  const artifacts = uniqueArtifactRefs(
    denseOwnDataArray(
      input.artifacts,
      "run retention checkpoint.artifacts",
      RUN_ARTIFACT_MAX_ITEMS,
    ).map((artifact) => parseArtifactRef(artifact)),
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-retention-checkpoint",
    runId,
    historyKey,
    requestId,
    startedAt,
    endedAt,
    artifacts,
    createdAt: canonicalTimestamp(
      input.createdAt,
      "run retention checkpoint.createdAt",
    ),
  });
}

function parseRunSummary(value: unknown): AgentRunSummary {
  const input = ownDataRecord(
    value,
    "run summary",
    [
      "runId",
      "requestId",
      "conversationId",
      "status",
      "startedAt",
      "updatedAt",
      "endedAt",
      "attempts",
      "transcriptRevision",
      "failureCode",
    ],
  );
  const status = runStatus(input.status, "run summary.status");
  const endedAt = input.endedAt === undefined
    ? undefined
    : canonicalTimestamp(input.endedAt, "run summary.endedAt");
  const rawAttempts = denseOwnDataArray(
    input.attempts,
    "run summary.attempts",
    RUN_MAX_ATTEMPTS,
  );
  const attempts = rawAttempts.map((attempt, index) => {
    const parsed = parseRunAttemptEvidence(attempt, `run summary.attempts.${String(index)}`);
    if (parsed.attempt !== index + 1) {
      throw new TypeError("run summary attempts must be contiguous and ordered");
    }
    return parsed;
  });
  const transcriptRevision = input.transcriptRevision === undefined
    ? undefined
    : boundedCode(input.transcriptRevision, "run summary.transcriptRevision");
  const failureCode = input.failureCode === undefined
    ? undefined
    : boundedCode(input.failureCode, "run summary.failureCode");
  if ((status === "running") === (endedAt !== undefined)) {
    throw new TypeError("run summary terminal timestamps are inconsistent");
  }
  if ((status === "failed" || status === "uncertain") !== (failureCode !== undefined)) {
    throw new TypeError("run summary failure fields are inconsistent");
  }
  return Object.freeze({
    runId: boundedIdentifier(input.runId, "run summary.runId"),
    requestId: boundedIdentifier(input.requestId, "run summary.requestId"),
    conversationId: boundedConversationId(
      input.conversationId,
      "run summary.conversationId",
    ),
    status,
    startedAt: canonicalTimestamp(input.startedAt, "run summary.startedAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "run summary.updatedAt"),
    ...(endedAt === undefined ? {} : { endedAt }),
    attempts: Object.freeze(attempts),
    ...(transcriptRevision === undefined ? {} : { transcriptRevision }),
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

export function freezeSummary(value: AgentRunSummary): AgentRunSummary {
  return parseRunSummary(value);
}

export function parseRunAttemptEvidence(
  value: unknown,
  path: string,
): AgentRunAttemptEvidence {
  const input = ownDataRecord(
    value,
    path,
    [
      "attempt",
      "route",
      "status",
      "startedAt",
      "endedAt",
      "code",
      "retryability",
      "sideEffects",
    ],
  );
  const status = stringEnum(
    input.status,
    ["started", "ineligible", "failed", "completed"] as const,
    `${path}.status`,
  );
  const endedAt = input.endedAt === undefined
    ? undefined
    : canonicalTimestamp(input.endedAt, `${path}.endedAt`);
  const code = input.code === undefined ? undefined : boundedCode(input.code, `${path}.code`);
  const retryability = input.retryability === undefined
    ? undefined
    : stringEnum(
      input.retryability,
      ["retryable", "not-retryable", "unknown"] as const,
      `${path}.retryability`,
    );
  const sideEffects = input.sideEffects === undefined
    ? undefined
    : stringEnum(
      input.sideEffects,
      ["none", "committed", "unknown"] as const,
      `${path}.sideEffects`,
    );
  if ((status === "started") === (endedAt !== undefined)) {
    throw new TypeError(`${path} terminal timestamp is inconsistent`);
  }
  if (
    (status === "ineligible" || status === "failed")
    !== (code !== undefined)
  ) {
    throw new TypeError(`${path} failure code is inconsistent`);
  }
  if (status !== "failed" && (retryability !== undefined || sideEffects !== undefined)) {
    throw new TypeError(`${path} retry evidence is valid only for failed attempts`);
  }
  if (status === "failed" && (retryability === undefined || sideEffects === undefined)) {
    throw new TypeError(`${path} failed attempts require explicit retry and side-effect evidence`);
  }
  return Object.freeze({
    attempt: boundedInteger(input.attempt, `${path}.attempt`, 1, RUN_MAX_ATTEMPTS),
    route: parseRouteIdentity(input.route),
    status,
    startedAt: canonicalTimestamp(input.startedAt, `${path}.startedAt`),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(code === undefined ? {} : { code }),
    ...(retryability === undefined ? {} : { retryability }),
    ...(sideEffects === undefined ? {} : { sideEffects }),
  });
}

function parseRunEvent(value: unknown): AgentRunEvent {
  const type = valueType(value);
  const input = ownDataRecord(
    value,
    "run event",
    type === "attempt"
      ? ["type", "runId", "sequence", "recordedAt", "attempt"]
      : type === "interaction"
        ? ["type", "runId", "sequence", "recordedAt", "evidence"]
        : type === "settled"
          ? [
              "type",
              "runId",
              "sequence",
              "recordedAt",
              "status",
              "transcriptRevision",
              "failureCode",
            ]
          : ["type", "runId", "sequence", "recordedAt"],
  );
  const runId = boundedIdentifier(input.runId, "run event.runId");
  const sequence = boundedInteger(input.sequence, "run event.sequence", 0, RUN_MAX_EVENTS - 1);
  const recordedAt = canonicalTimestamp(input.recordedAt, "run event.recordedAt");
  if (input.type === "admitted") {
    return Object.freeze({ type: "admitted", runId, sequence, recordedAt });
  }
  if (input.type === "attempt") {
    return Object.freeze({
      type: "attempt",
      runId,
      sequence,
      recordedAt,
      attempt: parseRunAttemptEvidence(input.attempt, "run event.attempt"),
    });
  }
  if (input.type === "interaction") {
    return Object.freeze({
      type: "interaction",
      runId,
      sequence,
      recordedAt,
      evidence: parseInteractionEvidence(input.evidence, "run event.evidence"),
    });
  }
  if (input.type === "settled") {
    const status = terminalRunStatus(input.status, "run event.status");
    const transcriptRevision = input.transcriptRevision === undefined
      ? undefined
      : boundedCode(input.transcriptRevision, "run event.transcriptRevision");
    const failureCode = input.failureCode === undefined
      ? undefined
      : boundedCode(input.failureCode, "run event.failureCode");
    if ((status === "failed" || status === "uncertain") !== (failureCode !== undefined)) {
      throw new TypeError("run event failure fields are inconsistent");
    }
    return Object.freeze({
      type: "settled",
      runId,
      sequence,
      recordedAt,
      status,
      ...(transcriptRevision === undefined ? {} : { transcriptRevision }),
      ...(failureCode === undefined ? {} : { failureCode }),
    });
  }
  throw new TypeError("run event.type is invalid");
}

export function eventRecord(event: AgentRunEvent): StoredRunEvent {
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-event",
    event: parseRunEvent(event),
  });
}

function canonicalFingerprintValue(
  value: unknown,
  path: string,
  state: { items: number; bytes: number; readonly active: Set<object> },
): unknown {
  state.items += 1;
  if (state.items > FINGERPRINT_MAX_ITEMS) throw new RangeError("fingerprint material has too many items");
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > FINGERPRINT_MAX_BYTES) throw new RangeError("fingerprint material exceeds its byte limit");
    return ["string", value];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return ["number", Object.is(value, -0) ? "-0" : value];
  }
  if (value instanceof Uint8Array) {
    state.bytes += value.byteLength;
    if (state.bytes > FINGERPRINT_MAX_BYTES) throw new RangeError("fingerprint material exceeds its byte limit");
    return [
      "bytes",
      value.byteLength,
      createHash("sha256").update(value).digest("hex"),
    ];
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${path} must contain only JSON values or bytes`);
  }
  if (state.active.has(value)) throw new TypeError(`${path} must not contain cycles`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const raw = denseOwnDataArray(value, path, FINGERPRINT_MAX_ITEMS);
      return [
        "array",
        raw.map((entry, index) =>
          canonicalFingerprintValue(entry, `${path}.${String(index)}`, state)),
      ];
    }
    const input = ownDataRecord(value, path, ownStringKeys(value).sort());
    return [
      "object",
      Object.keys(input).sort().map((key) => [
        key,
        canonicalFingerprintValue(input[key], `${path}.${key}`, state),
      ]),
    ];
  } finally {
    state.active.delete(value);
  }
}

function ownStringKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("fingerprint material cannot contain symbols");
    keys.push(key);
  }
  return keys;
}

export function sameAttempt(
  left: AgentRunAttemptEvidence,
  right: AgentRunAttemptEvidence,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function uniqueArtifactRefs(
  values: readonly (ArtifactRef | undefined)[],
): readonly ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const value of values) {
    if (value === undefined) continue;
    const ref = parseArtifactRef(value);
    const existing = unique.get(ref.sha256);
    if (
      existing !== undefined
      && (
        existing.sizeBytes !== ref.sizeBytes
        || existing.id !== ref.id
      )
    ) {
      throw new Error("one artifact digest has inconsistent durable authority");
    }
    unique.set(ref.sha256, ref);
  }
  return Object.freeze([...unique.values()]);
}

export function sameArtifactRef(
  left: ArtifactRef | undefined,
  right: ArtifactRef,
): boolean {
  return left !== undefined
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes;
}

export function sameArtifactPublicationDescriptor(
  left: ArtifactPublicationDescriptor,
  right: ArtifactPublicationDescriptor,
): boolean {
  return left.slot === right.slot
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.mediaType === right.mediaType
    && left.fileName === right.fileName;
}

export function artifactReference(
  artifact: ArtifactPublicationDescriptor,
): ArtifactRef {
  return parseArtifactRef({
    id: `artifact:${artifact.sha256}`,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType,
    ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName }),
  });
}

export function mergeArtifactPublicationDescriptors(
  first: readonly ArtifactPublicationDescriptor[],
  second: readonly ArtifactPublicationDescriptor[],
): readonly ArtifactPublicationDescriptor[] {
  const merged = [...first];
  const bySlot = new Map(merged.map((artifact) => [artifact.slot, artifact]));
  for (const artifact of second) {
    const existing = bySlot.get(artifact.slot);
    if (existing !== undefined) {
      if (!sameArtifactPublicationDescriptor(existing, artifact)) {
        throw new Error(`artifact publication slot ${artifact.slot} cannot be rewritten`);
      }
      continue;
    }
    merged.push(artifact);
    bySlot.set(artifact.slot, artifact);
  }
  if (merged.length > RUN_ARTIFACT_MAX_ITEMS) {
    throw new RangeError("artifact publication intent exceeds its item limit");
  }
  assertArtifactPublicationBounds(merged);
  return Object.freeze(merged);
}

export function assertArtifactPublicationBounds(
  artifacts: readonly ArtifactPublicationDescriptor[],
): void {
  const contentBytes = artifacts.reduce(
    (total, artifact) => artifact.slot.startsWith(INTERNAL_ARTIFACT_SLOT_PREFIX)
      ? total
      : total + artifact.sizeBytes,
    0,
  );
  if (
    !Number.isSafeInteger(contentBytes)
    || contentBytes > RUN_CONTENT_ARTIFACT_MAX_TOTAL_BYTES
  ) {
    throw new RangeError("staged run content exceeds its aggregate artifact byte limit");
  }
}

export function publishedContentReferences(
  intent: ArtifactPublicationIntentRecord,
  transcript: CanonicalTranscript,
): readonly ArtifactRef[] {
  const referenced = transcript.entries.flatMap((entry) =>
    entry.kind === "verbatim"
      ? []
      : entry.content.flatMap((part) =>
          part.type === "artifact" ? [part.ref] : []));
  const staged: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const artifact of intent.artifacts) {
    if (artifact.slot.startsWith(INTERNAL_ARTIFACT_SLOT_PREFIX)) continue;
    const ref = referenced.find((candidate) =>
      candidate.sha256 === artifact.sha256
      && candidate.sizeBytes === artifact.sizeBytes
      && candidate.mediaType === artifact.mediaType
      && candidate.fileName === artifact.fileName);
    if (ref === undefined) {
      throw new Error(
        `staged artifact slot ${artifact.slot} is not referenced by the settled transcript`,
      );
    }
    const identity = JSON.stringify([
      ref.id,
      ref.sha256,
      ref.sizeBytes,
      ref.mediaType,
      ref.fileName,
    ]);
    if (!seen.has(identity)) {
      seen.add(identity);
      staged.push(ref);
    }
  }
  return Object.freeze(staged);
}

export function artifactSlot(value: unknown, path: string, allowInternal: boolean): string {
  const slot = boundedIdentifier(value, path);
  if (slot.startsWith(INTERNAL_ARTIFACT_SLOT_PREFIX)) {
    if (!allowInternal) {
      throw new TypeError(`${path} uses a reserved internal prefix`);
    }
    if (slot !== TRANSCRIPT_ARTIFACT_SLOT && slot !== RESPONSE_ARTIFACT_SLOT) {
      throw new TypeError(`${path} uses an unknown internal slot`);
    }
  }
  return slot;
}

export function sameRoute(left: RouteIdentity, right: RouteIdentity): boolean {
  return left.runtimeInstanceId === right.runtimeInstanceId
    && left.model === right.model;
}

export function nextEventCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= RUN_MAX_EVENTS) {
    throw new RangeError("run exceeds its event limit");
  }
  return value + 1;
}

export function parseFingerprint(value: unknown, path: string): DurableFingerprint {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 fingerprint`);
  }
  return value as DurableFingerprint;
}

export function boundedIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > IDENTIFIER_MAX_BYTES
  ) {
    throw new TypeError(`${path} must be a bounded non-empty string`);
  }
  return value;
}

export function boundedConversationId(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > CONVERSATION_ID_MAX_BYTES
  ) {
    throw new TypeError(`${path} must be a bounded non-empty string`);
  }
  return value;
}

export function boundedCode(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > CODE_MAX_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    throw new TypeError(`${path} must be a bounded machine-readable code`);
  }
  return value;
}

export function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new TypeError(`${path} is outside its integer bound`);
  }
  return value as number;
}

export function boundedDuration(value: number, path: string): number {
  return boundedInteger(value, path, MIN_STALE_AFTER_MS, MAX_STALE_AFTER_MS);
}

function runStatus(value: unknown, path: string): AgentRunStatus {
  return stringEnum(
    value,
    ["running", "completed", "cancelled", "max-turns", "failed", "uncertain"] as const,
    path,
  );
}

export function terminalRunStatus(
  value: unknown,
  path: string,
): Exclude<AgentRunStatus, "running"> {
  return stringEnum(
    value,
    ["completed", "cancelled", "max-turns", "failed", "uncertain"] as const,
    path,
  );
}

export function canonicalNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("journal clock returned an invalid Date");
  }
  return value.toISOString();
}

export function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(
    canonicalTimestampMilliseconds(timestamp, "timestamp") + milliseconds,
  ).toISOString();
}

export function isExpired(value: string | undefined, clock: () => Date): boolean {
  if (value === undefined) return true;
  const expires = canonicalTimestampMilliseconds(value, "leaseExpiresAt");
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("journal clock returned an invalid Date");
  }
  return now.getTime() >= expires;
}

function canonicalTimestampMilliseconds(value: string, path: string): number {
  return Date.parse(canonicalTimestamp(value, path));
}

function stringEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value as T[number];
}

function valueType(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}
