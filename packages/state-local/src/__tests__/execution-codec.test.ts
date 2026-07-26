// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  assertConversationKeyAuthority,
  assertDeliveryKeyAuthority,
  parseAdmissionRecord,
  parseArtifactPublicationIntentRecord,
  parseConversationDeliveryEntryRecord,
  parseConversationRecord,
  parseDeliveryRecord,
  parseProviderSessionRecord,
  parseRunHistoryRecord,
  parseRunRetentionCheckpoint,
  parseStoredRunEvent,
  parseStoredRunRecord,
  uniqueArtifactRefs,
} from "../execution-codec.js";
import {
  conversationChunkStateKey,
  conversationStateKey,
  decodeExecutionRecord,
  ExecutionStore,
  runHistoryStateKey,
  type ExecutionRecordParser,
} from "../execution-store.js";
import { createStateLocalInternalAccessor } from "../internal-state-access.js";

const NOW = "2026-07-23T08:00:00.000Z";
const LATER = "2026-07-23T08:01:00.000Z";
const LATEST = "2026-07-23T08:02:00.000Z";
const FINGERPRINT = `sha256:${"a".repeat(64)}` as const;
const SECOND_FINGERPRINT = `sha256:${"b".repeat(64)}` as const;
const CHUNK_DIGEST = "c".repeat(64);
const TRANSCRIPT_DIGEST = "d".repeat(64);
const ROUTE = { runtimeInstanceId: "pi", model: "provider:model" };
const ARTIFACT = {
  id: `artifact:${FINGERPRINT}`,
  sha256: FINGERPRINT,
  sizeBytes: 1,
  mediaType: "text/plain",
  fileName: "result.txt",
} as const;
const PUBLICATION = {
  slot: "result",
  sha256: FINGERPRINT,
  sizeBytes: 1,
  mediaType: "text/plain",
  fileName: "result.txt",
} as const;
const RUNNING_SUMMARY = {
  runId: "run-1",
  requestId: "request-1",
  conversationId: "conversation-1",
  status: "running",
  startedAt: NOW,
  updatedAt: NOW,
  attempts: [],
};
const COMPLETED_ATTEMPT = {
  attempt: 1,
  route: ROUTE,
  status: "completed",
  startedAt: NOW,
  endedAt: LATER,
};
const INLINE_TRANSCRIPT = {
  schemaVersion: 1,
  kind: "mono-agent.canonical-transcript",
  conversationId: "conversation-1",
  revision: 1,
  entries: [],
};
const TRANSCRIPT_CHUNKS = {
  schemaVersion: 1,
  kind: "mono-agent.canonical-transcript-chunks",
  encoding: "utf8-json",
  digest: TRANSCRIPT_DIGEST,
  sizeBytes: 1,
  chunks: [transcriptChunk(0)],
};
const FAILED_ATTEMPT = {
  attempt: 1,
  route: ROUTE,
  status: "failed",
  startedAt: NOW,
  endedAt: LATER,
  code: "provider_failure",
  retryability: "retryable",
  sideEffects: "none",
};
interface DecoderCase {
  readonly name: string;
  readonly parser: ExecutionRecordParser<unknown>;
  readonly valid: Record<string, unknown>;
  readonly malformed: readonly {
    readonly name: string;
    readonly value: Record<string, unknown>;
  }[];
}

const DECODER_CASES: readonly DecoderCase[] = [
  {
    name: "admission",
    parser: parseAdmissionRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.admission",
      requestId: "request-1",
      conversationId: "conversation-1",
      fingerprint: FINGERPRINT,
      runId: "run-1",
      status: "running",
      startedAt: NOW,
      updatedAt: NOW,
      leaseExpiresAt: LATER,
    },
    malformed: [
      {
        name: "running record with settlement",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.admission",
          requestId: "request-1",
          conversationId: "conversation-1",
          fingerprint: FINGERPRINT,
          runId: "run-1",
          status: "running",
          startedAt: NOW,
          updatedAt: NOW,
          leaseExpiresAt: LATER,
          settledStatus: "completed",
        },
      },
      {
        name: "settled record without settlement",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.admission",
          requestId: "request-1",
          conversationId: "conversation-1",
          fingerprint: FINGERPRINT,
          runId: "run-1",
          status: "settled",
          startedAt: NOW,
          updatedAt: NOW,
          leaseExpiresAt: LATER,
        },
      },
      {
        name: "running record with response authority",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.admission",
          requestId: "request-1",
          conversationId: "conversation-1",
          fingerprint: FINGERPRINT,
          runId: "run-1",
          status: "running",
          startedAt: NOW,
          updatedAt: NOW,
          leaseExpiresAt: LATER,
          responseRef: ARTIFACT,
        },
      },
      ...[
        { name: "non-string admission conversation identity", conversationId: 1 },
        { name: "whitespace admission conversation identity", conversationId: "   " },
        { name: "NUL-bearing admission conversation identity", conversationId: "conversation\0one" },
        { name: "oversized admission conversation identity", conversationId: "c".repeat(4_097) },
      ].map(({ name, conversationId }) => ({
        name,
        value: {
          schemaVersion: 1,
          kind: "mono-agent.admission",
          requestId: "request-1",
          conversationId,
          fingerprint: FINGERPRINT,
          runId: "run-1",
          status: "running",
          startedAt: NOW,
          updatedAt: NOW,
          leaseExpiresAt: LATER,
        },
      })),
    ],
  },
  {
    name: "stored run",
    parser: parseStoredRunRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.run",
      summary: RUNNING_SUMMARY,
      eventCount: 1,
    },
    malformed: [
      {
        name: "terminal summary without end timestamp",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run",
          summary: { ...RUNNING_SUMMARY, status: "completed" },
          eventCount: 1,
        },
      },
      {
        name: "transcript ref without transcript revision",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run",
          summary: RUNNING_SUMMARY,
          eventCount: 1,
          transcriptRef: ARTIFACT,
        },
      },
      {
        name: "noncontiguous attempt sequence",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run",
          summary: {
            ...RUNNING_SUMMARY,
            attempts: [{
              attempt: 2,
              route: ROUTE,
              status: "started",
              startedAt: NOW,
            }],
          },
          eventCount: 1,
        },
      },
      {
        name: "completed summary with failure code",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run",
          summary: {
            ...RUNNING_SUMMARY,
            status: "completed",
            updatedAt: LATER,
            endedAt: LATER,
            failureCode: "unexpected_failure",
          },
          eventCount: 1,
        },
      },
      {
        name: "failed summary without failure code",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run",
          summary: {
            ...RUNNING_SUMMARY,
            status: "failed",
            updatedAt: LATER,
            endedAt: LATER,
          },
          eventCount: 1,
        },
      },
      {
        name: "started attempt with terminal timestamp",
        value: storedRunWithAttempts([{
          attempt: 1,
          route: ROUTE,
          status: "started",
          startedAt: NOW,
          endedAt: LATER,
        }]),
      },
      {
        name: "completed attempt without terminal timestamp",
        value: storedRunWithAttempts([{
          attempt: 1,
          route: ROUTE,
          status: "completed",
          startedAt: NOW,
        }]),
      },
      {
        name: "completed attempt with failure code",
        value: storedRunWithAttempts([{
          ...COMPLETED_ATTEMPT,
          code: "unexpected_failure",
        }]),
      },
      {
        name: "ineligible attempt without failure code",
        value: storedRunWithAttempts([{
          attempt: 1,
          route: ROUTE,
          status: "ineligible",
          startedAt: NOW,
          endedAt: LATER,
        }]),
      },
      {
        name: "completed attempt with retry evidence",
        value: storedRunWithAttempts([{
          ...COMPLETED_ATTEMPT,
          retryability: "not-retryable",
          sideEffects: "none",
        }]),
      },
      {
        name: "completed attempt with only retryability",
        value: storedRunWithAttempts([{
          ...COMPLETED_ATTEMPT,
          retryability: "not-retryable",
        }]),
      },
      {
        name: "completed attempt with only side-effect evidence",
        value: storedRunWithAttempts([{
          ...COMPLETED_ATTEMPT,
          sideEffects: "none",
        }]),
      },
      {
        name: "failed attempt without retryability",
        value: storedRunWithAttempts([{
          ...FAILED_ATTEMPT,
          retryability: undefined,
        }]),
      },
      {
        name: "failed attempt without side-effect evidence",
        value: storedRunWithAttempts([{
          ...FAILED_ATTEMPT,
          sideEffects: undefined,
        }]),
      },
      {
        name: "failed attempt without failure code",
        value: storedRunWithAttempts([{
          ...FAILED_ATTEMPT,
          code: undefined,
        }]),
      },
      {
        name: "attempt with invalid effort keyword",
        value: storedRunWithAttempts([{
          ...COMPLETED_ATTEMPT,
          effortEscalation: {
            keyword: "guess",
            from: "medium",
            to: "high",
          },
        }]),
      },
      {
        name: "attempt with invalid effort code",
        value: storedRunWithAttempts([{
          ...COMPLETED_ATTEMPT,
          effortEscalation: {
            keyword: "think",
            from: "medium effort",
            to: "high",
          },
        }]),
      },
    ],
  },
  {
    name: "stored run event",
    parser: parseStoredRunEvent,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.run-event",
      event: {
        type: "admitted",
        runId: "run-1",
        sequence: 0,
        recordedAt: NOW,
      },
    },
    malformed: [
      {
        name: "unknown event type",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-event",
          event: {
            type: "invented",
            runId: "run-1",
            sequence: 0,
            recordedAt: NOW,
          },
        },
      },
      {
        name: "failed settlement without failure code",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-event",
          event: {
            type: "settled",
            runId: "run-1",
            sequence: 1,
            recordedAt: LATER,
            status: "failed",
          },
        },
      },
      {
        name: "completed settlement with failure code",
        value: settledEvent("completed", { failureCode: "unexpected_failure" }),
      },
      {
        name: "uncertain settlement without failure code",
        value: settledEvent("uncertain"),
      },
      {
        name: "admitted event with settled-only authority",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-event",
          event: {
            type: "admitted",
            runId: "run-1",
            sequence: 0,
            recordedAt: NOW,
            status: "failed",
            failureCode: "provider_failure",
          },
        },
      },
      {
        name: "event sequence at the exclusive upper bound",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-event",
          event: {
            type: "admitted",
            runId: "run-1",
            sequence: 10_000,
            recordedAt: NOW,
          },
        },
      },
    ],
  },
  {
    name: "run history",
    parser: parseRunHistoryRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.run-history",
      runId: "run-1",
      startedAt: NOW,
    },
    malformed: [
      {
        name: "noncanonical timestamp",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-history",
          runId: "run-1",
          startedAt: "2026-07-23T08:00:00Z",
        },
      },
      ...[
        { name: "non-string run identity", runId: 1 },
        { name: "whitespace run identity", runId: "   " },
        { name: "NUL-bearing run identity", runId: "run\0one" },
        { name: "oversized run identity", runId: "r".repeat(513) },
      ].map(({ name, runId }) => ({
        name,
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-history",
          runId,
          startedAt: NOW,
        },
      })),
    ],
  },
  {
    name: "conversation",
    parser: parseConversationRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.conversation",
      conversationId: "conversation-1",
      revision: 1,
      inlineTranscript: INLINE_TRANSCRIPT,
      entryCount: 0,
      createdAt: NOW,
      updatedAt: LATER,
    },
    malformed: [
      {
        name: "missing transcript representation",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 1,
          entryCount: 0,
          updatedAt: LATER,
        },
      },
      {
        name: "ambiguous transcript representations",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 1,
          inlineTranscript: INLINE_TRANSCRIPT,
          transcriptRef: ARTIFACT,
          entryCount: 0,
          updatedAt: LATER,
        },
      },
      {
        name: "foreign inline transcript",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 1,
          inlineTranscript: {
            ...INLINE_TRANSCRIPT,
            conversationId: "conversation-2",
          },
          entryCount: 0,
          updatedAt: LATER,
        },
      },
      {
        name: "mismatched transcript revision",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 2,
          inlineTranscript: INLINE_TRANSCRIPT,
          entryCount: 0,
          updatedAt: LATER,
        },
      },
      {
        name: "mismatched transcript entry count",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 1,
          inlineTranscript: INLINE_TRANSCRIPT,
          entryCount: 1,
          updatedAt: LATER,
        },
      },
      {
        name: "reversed timestamps",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 1,
          inlineTranscript: INLINE_TRANSCRIPT,
          entryCount: 0,
          createdAt: LATEST,
          updatedAt: LATER,
        },
      },
      {
        name: "chunk manifest with wrong schema",
        value: conversationWithChunks({ ...TRANSCRIPT_CHUNKS, schemaVersion: 2 }),
      },
      {
        name: "chunk manifest with wrong kind",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          kind: "mono-agent.other-transcript-chunks",
        }),
      },
      {
        name: "chunk manifest with wrong encoding",
        value: conversationWithChunks({ ...TRANSCRIPT_CHUNKS, encoding: "base64" }),
      },
      {
        name: "chunk manifest with invalid digest",
        value: conversationWithChunks({ ...TRANSCRIPT_CHUNKS, digest: "D".repeat(64) }),
      },
      {
        name: "chunk manifest with leading digest bytes",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          digest: `x${TRANSCRIPT_DIGEST}`,
        }),
      },
      {
        name: "chunk manifest with trailing digest bytes",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          digest: `${TRANSCRIPT_DIGEST}x`,
        }),
      },
      {
        name: "chunk manifest with array-valued digest",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          digest: [TRANSCRIPT_DIGEST],
        }),
      },
      {
        name: "chunk manifest with invalid per-chunk digest",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          chunks: [{
            ...transcriptChunk(0),
            digest: "C".repeat(64),
          }],
        }),
      },
      {
        name: "empty chunk manifest",
        value: conversationWithChunks({ ...TRANSCRIPT_CHUNKS, chunks: [] }),
      },
      {
        name: "foreign conversation chunk key",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          chunks: [transcriptChunk(0, 1, "conversation-2")],
        }),
      },
      {
        name: "wrong-index conversation chunk key",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          chunks: [transcriptChunk(1)],
        }),
      },
      {
        name: "chunk over the per-chunk byte bound",
        value: conversationWithChunks({
          ...TRANSCRIPT_CHUNKS,
          sizeBytes: 256 * 1024 + 1,
          chunks: [transcriptChunk(0, 256 * 1024 + 1)],
        }),
      },
      {
        name: "chunk manifest with mismatched declared size",
        value: conversationWithChunks({ ...TRANSCRIPT_CHUNKS, sizeBytes: 2 }),
      },
      {
        name: "scalar session metadata",
        value: conversationWithMetadata("metadata"),
      },
      {
        name: "null session metadata",
        value: conversationWithMetadata(null),
      },
      {
        name: "array session metadata",
        value: conversationWithMetadata([]),
      },
      {
        name: "session metadata with too many JSON items",
        value: conversationWithMetadata({
          items: Array.from({ length: 10_000 }, () => true),
        }),
      },
      {
        name: "session metadata string over the byte bound",
        value: conversationWithMetadata({ text: "x".repeat(64 * 1024 + 1) }),
      },
      {
        name: "session metadata whose encoded keys exceed the byte bound",
        value: conversationWithMetadata(oversizedMetadataKeys()),
      },
      {
        name: "zero conversation revision",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "conversation-1",
          revision: 0,
          inlineTranscript: INLINE_TRANSCRIPT,
          entryCount: 0,
          updatedAt: LATER,
        },
      },
      {
        name: "empty conversation identity",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId: "",
          revision: 1,
          inlineTranscript: INLINE_TRANSCRIPT,
          entryCount: 0,
          updatedAt: LATER,
        },
      },
      ...[
        { name: "non-string conversation identity", conversationId: 1 },
        { name: "whitespace conversation identity", conversationId: "   " },
        { name: "NUL-bearing conversation identity", conversationId: "conversation\0one" },
        { name: "oversized conversation identity", conversationId: "c".repeat(4_097) },
      ].map(({ name, conversationId }) => ({
        name,
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation",
          conversationId,
          revision: 1,
          inlineTranscript: {
            ...INLINE_TRANSCRIPT,
            conversationId,
          },
          entryCount: 0,
          updatedAt: LATER,
        },
      })),
    ],
  },
  {
    name: "conversation delivery binding",
    parser: parseConversationDeliveryEntryRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.conversation-delivery-entry",
      entryId: "entry-1",
      conversationId: "conversation-1",
      deliveryIdempotencyKey: "delivery-1",
      deliveryFingerprint: FINGERPRINT,
      fingerprint: SECOND_FINGERPRINT,
      entryDigest: FINGERPRINT,
      revision: 1,
      entryCount: 1,
      createdAt: NOW,
    },
    malformed: [
      {
        name: "invalid fingerprint authority",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation-delivery-entry",
          entryId: "entry-1",
          conversationId: "conversation-1",
          deliveryIdempotencyKey: "delivery-1",
          deliveryFingerprint: "sha256:UPPERCASE",
          fingerprint: SECOND_FINGERPRINT,
          entryDigest: FINGERPRINT,
          revision: 1,
          entryCount: 1,
          createdAt: NOW,
        },
      },
      ...[
        { name: "leading fingerprint bytes", deliveryFingerprint: `x${FINGERPRINT}` },
        { name: "trailing fingerprint bytes", deliveryFingerprint: `${FINGERPRINT}x` },
        { name: "array-valued fingerprint", deliveryFingerprint: [FINGERPRINT] },
      ].map(({ name, deliveryFingerprint }) => ({
        name,
        value: {
          schemaVersion: 1,
          kind: "mono-agent.conversation-delivery-entry",
          entryId: "entry-1",
          conversationId: "conversation-1",
          deliveryIdempotencyKey: "delivery-1",
          deliveryFingerprint,
          fingerprint: SECOND_FINGERPRINT,
          entryDigest: FINGERPRINT,
          revision: 1,
          entryCount: 1,
          createdAt: NOW,
        },
      })),
    ],
  },
  {
    name: "provider session",
    parser: parseProviderSessionRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.provider-session",
      conversationId: "conversation-1",
      route: ROUTE,
      session: {
        id: "session-1",
        conversationId: "conversation-1",
        route: ROUTE,
        createdAt: NOW,
        expiresAt: LATEST,
        metadata: { provider: "test" },
      },
      updatedAt: LATER,
    },
    malformed: [
      {
        name: "foreign session conversation",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.provider-session",
          conversationId: "conversation-1",
          route: ROUTE,
          session: {
            id: "session-1",
            conversationId: "conversation-2",
            route: ROUTE,
          },
          updatedAt: LATER,
        },
      },
      {
        name: "foreign session route",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.provider-session",
          conversationId: "conversation-1",
          route: ROUTE,
          session: {
            id: "session-1",
            conversationId: "conversation-1",
            route: { ...ROUTE, model: "provider:other" },
          },
          updatedAt: LATER,
        },
      },
      {
        name: "foreign session runtime",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.provider-session",
          conversationId: "conversation-1",
          route: ROUTE,
          session: {
            id: "session-1",
            conversationId: "conversation-1",
            route: { ...ROUTE, runtimeInstanceId: "other-runtime" },
          },
          updatedAt: LATER,
        },
      },
      {
        name: "non-forward session expiry",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.provider-session",
          conversationId: "conversation-1",
          route: ROUTE,
          session: {
            id: "session-1",
            conversationId: "conversation-1",
            route: ROUTE,
            createdAt: NOW,
            expiresAt: NOW,
          },
          updatedAt: LATER,
        },
      },
    ],
  },
  {
    name: "artifact publication intent",
    parser: parseArtifactPublicationIntentRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.artifact-publication-intent",
      runId: "run-1",
      requestId: "request-1",
      artifacts: [PUBLICATION],
      cleanupArtifacts: [],
      createdAt: NOW,
      updatedAt: LATER,
    },
    malformed: [
      {
        name: "empty authority",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.artifact-publication-intent",
          runId: "run-1",
          requestId: "request-1",
          artifacts: [],
          cleanupArtifacts: [],
          createdAt: NOW,
          updatedAt: LATER,
        },
      },
      {
        name: "duplicate slot authority",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.artifact-publication-intent",
          runId: "run-1",
          requestId: "request-1",
          artifacts: [PUBLICATION],
          cleanupArtifacts: [{ ...PUBLICATION, sha256: SECOND_FINGERPRINT }],
          createdAt: NOW,
          updatedAt: LATER,
        },
      },
      {
        name: "reversed timestamps",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.artifact-publication-intent",
          runId: "run-1",
          requestId: "request-1",
          artifacts: [PUBLICATION],
          cleanupArtifacts: [],
          createdAt: LATEST,
          updatedAt: LATER,
        },
      },
      {
        name: "aggregate artifact count over the bound",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.artifact-publication-intent",
          runId: "run-1",
          requestId: "request-1",
          artifacts: Array.from({ length: 256 }, (_value, index) => ({
            ...PUBLICATION,
            slot: `artifact-${String(index)}`,
          })),
          cleanupArtifacts: Array.from({ length: 257 }, (_value, index) => ({
            ...PUBLICATION,
            slot: `cleanup-${String(index)}`,
          })),
          createdAt: NOW,
          updatedAt: LATER,
        },
      },
      {
        name: "unknown internal artifact slot",
        value: artifactIntent([{ ...PUBLICATION, slot: "@core/unknown" }]),
      },
      {
        name: "content artifact bytes over the aggregate bound",
        value: artifactIntent([
          { ...PUBLICATION, slot: "first", sizeBytes: 33 * 1024 * 1024 },
          { ...PUBLICATION, slot: "second", sizeBytes: 33 * 1024 * 1024 },
        ]),
      },
      {
        name: "unsafe aggregate artifact byte sum",
        value: artifactIntent([
          { ...PUBLICATION, slot: "first", sizeBytes: Number.MAX_SAFE_INTEGER },
          { ...PUBLICATION, slot: "second", sizeBytes: Number.MAX_SAFE_INTEGER },
        ]),
      },
    ],
  },
  {
    name: "delivery",
    parser: parseDeliveryRecord,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.delivery",
      idempotencyKey: "delivery-1",
      fingerprint: FINGERPRINT,
      channelInstanceId: "telegram",
      runId: "run-1",
      status: "intent",
      attempts: 1,
      attemptToken: "attempt-1",
      createdAt: NOW,
      updatedAt: NOW,
      leaseExpiresAt: LATER,
    },
    malformed: [
      {
        name: "intent without lease",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: "delivery-1",
          fingerprint: FINGERPRINT,
          channelInstanceId: "telegram",
          status: "intent",
          attempts: 1,
          attemptToken: "attempt-1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      {
        name: "non-intent with lease",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: "delivery-1",
          fingerprint: FINGERPRINT,
          channelInstanceId: "telegram",
          status: "delivered",
          attempts: 1,
          attemptToken: "attempt-1",
          createdAt: NOW,
          updatedAt: LATER,
          leaseExpiresAt: LATEST,
        },
      },
      {
        name: "non-delivered state with receipt",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: "delivery-1",
          fingerprint: FINGERPRINT,
          channelInstanceId: "telegram",
          status: "failed",
          attempts: 1,
          attemptToken: "attempt-1",
          createdAt: NOW,
          updatedAt: LATER,
          code: "delivery_failed",
          messageId: "message-1",
        },
      },
      {
        name: "failed state without diagnostic code",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: "delivery-1",
          fingerprint: FINGERPRINT,
          channelInstanceId: "telegram",
          status: "failed",
          attempts: 1,
          attemptToken: "attempt-1",
          createdAt: NOW,
          updatedAt: LATER,
        },
      },
      {
        name: "partial destination-history authority",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: "delivery-1",
          fingerprint: FINGERPRINT,
          channelInstanceId: "telegram",
          status: "delivered",
          attempts: 1,
          attemptToken: "attempt-1",
          createdAt: NOW,
          updatedAt: LATER,
          historyEntryId: "entry-1",
        },
      },
      {
        name: "failed state with complete destination-history authority",
        value: deliveryRecord({
          status: "failed",
          code: "delivery_failed",
          updatedAt: LATER,
          historyEntryId: "entry-1",
          historyConversationId: "conversation-1",
          historyEntryFingerprint: FINGERPRINT,
          historyEntryDigest: SECOND_FINGERPRINT,
        }),
      },
      ...[
        { name: "unknown status value", status: "invented" },
        { name: "non-string status value", status: ["intent"] },
      ].map(({ name, status }) => ({
        name,
        value: deliveryRecord({ status }),
      })),
      ...[
        { name: "non-string diagnostic code", code: 1 },
        { name: "empty diagnostic code", code: "" },
        { name: "invalid diagnostic code character", code: "delivery failed" },
        { name: "oversized diagnostic code", code: `d${"x".repeat(512)}` },
      ].map(({ name, code }) => ({
        name,
        value: deliveryRecord({
          status: "failed",
          code,
          updatedAt: LATER,
        }),
      })),
      ...[
        { name: "fractional attempt count", attempts: 1.5 },
        { name: "attempt count below the bound", attempts: 0 },
        { name: "attempt count above the bound", attempts: 10_001 },
        { name: "non-number attempt count", attempts: [1] },
      ].map(({ name, attempts }) => ({
        name,
        value: deliveryRecord({ attempts }),
      })),
    ],
  },
  {
    name: "run retention checkpoint",
    parser: parseRunRetentionCheckpoint,
    valid: {
      schemaVersion: 1,
      kind: "mono-agent.run-retention-checkpoint",
      runId: "run-1",
      historyKey: runHistoryStateKey(NOW, "run-1"),
      requestId: "request-1",
      startedAt: NOW,
      endedAt: LATER,
      artifacts: [ARTIFACT],
      createdAt: LATEST,
    },
    malformed: [
      {
        name: "reversed run timestamps",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-retention-checkpoint",
          runId: "run-1",
          historyKey: runHistoryStateKey(LATER, "run-1"),
          requestId: "request-1",
          startedAt: LATER,
          endedAt: NOW,
          artifacts: [],
          createdAt: LATEST,
        },
      },
      {
        name: "foreign history key",
        value: {
          schemaVersion: 1,
          kind: "mono-agent.run-retention-checkpoint",
          runId: "run-1",
          historyKey: runHistoryStateKey(NOW, "run-2"),
          requestId: "request-1",
          startedAt: NOW,
          endedAt: LATER,
          artifacts: [],
          createdAt: LATEST,
        },
      },
      {
        name: "one artifact digest with conflicting size authority",
        value: retentionCheckpoint([
          ARTIFACT,
          { ...ARTIFACT, sizeBytes: 2 },
        ]),
      },
      {
        name: "one artifact digest with conflicting identity authority",
        value: retentionCheckpoint([
          ARTIFACT,
          { ...ARTIFACT, id: "artifact:other" },
        ]),
      },
    ],
  },
];

describe("execution durable record decoder", () => {
  it.each(DECODER_CASES)("accepts canonical $name bytes through ExecutionStore", async ({
    parser,
    valid,
  }) => {
    const parsed = await readExecutionRecord(jsonBytes(valid), parser);
    expect(durableShape(parsed)).toStrictEqual(durableShape(valid));
  });

  it.each([
    {
      name: "settled admission with response and exact conversation-id bytes",
      parser: parseAdmissionRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.admission",
        requestId: "request-1",
        conversationId: "c".repeat(4_096),
        fingerprint: FINGERPRINT,
        runId: "run-1",
        status: "settled",
        startedAt: NOW,
        updatedAt: LATER,
        leaseExpiresAt: LATEST,
        settledStatus: "completed",
        responseRef: ARTIFACT,
      },
    },
    {
      name: "run history with exact identifier bytes",
      parser: parseRunHistoryRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run-history",
        runId: "r".repeat(512),
        startedAt: NOW,
      },
    },
    {
      name: "stored run with a terminal attempt",
      parser: parseStoredRunRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run",
        summary: {
          ...RUNNING_SUMMARY,
          status: "completed",
          updatedAt: LATER,
          endedAt: LATER,
          attempts: [COMPLETED_ATTEMPT],
        },
        eventCount: 2,
      },
    },
    {
      name: "failed stored run with failure authority",
      parser: parseStoredRunRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run",
        summary: {
          ...RUNNING_SUMMARY,
          status: "failed",
          updatedAt: LATER,
          endedAt: LATER,
          attempts: [FAILED_ATTEMPT],
          failureCode: "provider_failure",
        },
        eventCount: 2,
      },
    },
    {
      name: "uncertain stored run with failure authority",
      parser: parseStoredRunRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run",
        summary: {
          ...RUNNING_SUMMARY,
          status: "uncertain",
          updatedAt: LATER,
          endedAt: LATER,
          failureCode: "outcome_unknown",
        },
        eventCount: 1,
      },
    },
    {
      name: "attempt event",
      parser: parseStoredRunEvent,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run-event",
        event: {
          type: "attempt",
          runId: "run-1",
          sequence: 1,
          recordedAt: LATER,
          attempt: COMPLETED_ATTEMPT,
        },
      },
    },
    {
      name: "interaction event",
      parser: parseStoredRunEvent,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run-event",
        event: {
          type: "interaction",
          runId: "run-1",
          sequence: 1,
          recordedAt: LATER,
          evidence: {
            kind: "live-input",
            interactionId: "interaction-1",
            phase: "applied",
            receivedAt: NOW,
            settledAt: LATER,
          },
        },
      },
    },
    {
      name: "settled event",
      parser: parseStoredRunEvent,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run-event",
        event: {
          type: "settled",
          runId: "run-1",
          sequence: 1,
          recordedAt: LATER,
          status: "completed",
        },
      },
    },
    {
      name: "stored run with transcript authority",
      parser: parseStoredRunRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run",
        summary: {
          ...RUNNING_SUMMARY,
          transcriptRevision: "revision:1",
        },
        eventCount: 1,
        transcriptRef: ARTIFACT,
      },
    },
    {
      name: "started attempt",
      parser: parseStoredRunEvent,
      value: attemptEvent({
        attempt: 1,
        route: ROUTE,
        status: "started",
        startedAt: NOW,
      }),
    },
    {
      name: "ineligible attempt",
      parser: parseStoredRunEvent,
      value: attemptEvent({
        attempt: 1,
        route: ROUTE,
        status: "ineligible",
        startedAt: NOW,
        endedAt: LATER,
        code: "ineligible",
      }),
    },
    {
      name: "failed attempt",
      parser: parseStoredRunEvent,
      value: attemptEvent({
        ...FAILED_ATTEMPT,
        effortEscalation: {
          keyword: "think",
          from: "medium",
          to: "high",
        },
      }),
    },
    {
      name: "failed attempt with effort escalation without a previous level",
      parser: parseStoredRunEvent,
      value: attemptEvent({
        ...FAILED_ATTEMPT,
        effortEscalation: {
          keyword: "think",
          to: "high",
        },
      }),
    },
    {
      name: "run event at the exact sequence bound",
      parser: parseStoredRunEvent,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.run-event",
        event: {
          type: "admitted",
          runId: "run-1",
          sequence: 9_999,
          recordedAt: NOW,
        },
      },
    },
    {
      name: "settled event with transcript revision",
      parser: parseStoredRunEvent,
      value: settledEvent("completed", { transcriptRevision: "revision:1" }),
    },
    {
      name: "failed settled event with failure code",
      parser: parseStoredRunEvent,
      value: settledEvent("failed", { failureCode: "provider_failure" }),
    },
    {
      name: "chunked conversation",
      parser: parseConversationRecord,
      value: conversationWithChunks(TRANSCRIPT_CHUNKS),
    },
    {
      name: "chunked conversation at exact aggregate bounds",
      parser: parseConversationRecord,
      value: conversationWithChunks({
        ...TRANSCRIPT_CHUNKS,
        sizeBytes: 64 * 1024 * 1024,
        chunks: Array.from({ length: 256 }, (_value, index) =>
          transcriptChunk(index, 256 * 1024)),
      }),
    },
    {
      name: "artifact-backed conversation",
      parser: parseConversationRecord,
      value: {
        schemaVersion: 1,
        kind: "mono-agent.conversation",
        conversationId: "conversation-1",
        revision: 1,
        transcriptRef: ARTIFACT,
        entryCount: 0,
        updatedAt: LATER,
      },
    },
    {
      name: "conversation with equal timestamps and nested metadata",
      parser: parseConversationRecord,
      value: {
        ...conversationWithMetadata({
          provider: "test",
          nested: { values: [null, true, 1, "value"] },
        }),
        createdAt: LATER,
        updatedAt: LATER,
      },
    },
    {
      name: "conversation with an intentionally empty title",
      parser: parseConversationRecord,
      value: {
        ...conversationWithMetadata({}),
        title: "",
      },
    },
    {
      name: "conversation metadata at the exact item bound",
      parser: parseConversationRecord,
      value: conversationWithMetadata({
        items: Array.from({ length: 9_998 }, () => true),
      }),
    },
    {
      name: "conversation metadata at the exact encoded-byte bound",
      parser: parseConversationRecord,
      value: conversationWithMetadata({
        ["k".repeat(65_527)]: null,
      }),
    },
    {
      name: "provider session without expiry timestamps",
      parser: parseProviderSessionRecord,
      value: providerSession({}),
    },
    {
      name: "provider session with only a creation timestamp",
      parser: parseProviderSessionRecord,
      value: providerSession({ createdAt: NOW }),
    },
    {
      name: "provider session with only an expiry timestamp",
      parser: parseProviderSessionRecord,
      value: providerSession({ expiresAt: LATEST }),
    },
    {
      name: "artifact intent with exactly 512 slots",
      parser: parseArtifactPublicationIntentRecord,
      value: artifactIntent(
        Array.from({ length: 512 }, (_value, index) => ({
          ...PUBLICATION,
          slot: `artifact-${String(index)}`,
        })),
      ),
    },
    {
      name: "artifact intent at exact aggregate content bytes",
      parser: parseArtifactPublicationIntentRecord,
      value: artifactIntent([
        { ...PUBLICATION, slot: "first", sizeBytes: 32 * 1024 * 1024 },
        { ...PUBLICATION, slot: "second", sizeBytes: 32 * 1024 * 1024 },
      ]),
    },
    {
      name: "artifact intent with internal bytes excluded from content aggregate",
      parser: parseArtifactPublicationIntentRecord,
      value: artifactIntent([
        {
          ...PUBLICATION,
          slot: "@core/transcript",
          sizeBytes: Number.MAX_SAFE_INTEGER,
        },
        {
          ...PUBLICATION,
          slot: "@core/response",
          sizeBytes: Number.MAX_SAFE_INTEGER,
        },
      ]),
    },
    {
      name: "artifact intent with equal timestamps",
      parser: parseArtifactPublicationIntentRecord,
      value: artifactIntent([PUBLICATION], [], { createdAt: NOW, updatedAt: NOW }),
    },
    {
      name: "artifact intent with cleanup-only authority",
      parser: parseArtifactPublicationIntentRecord,
      value: artifactIntent([], [{ ...PUBLICATION, slot: "cleanup" }]),
    },
    {
      name: "artifact intent with publication and cleanup authority",
      parser: parseArtifactPublicationIntentRecord,
      value: artifactIntent(
        [{ ...PUBLICATION, slot: "publication" }],
        [{ ...PUBLICATION, slot: "cleanup" }],
      ),
    },
    {
      name: "delivered record with complete destination-history authority",
      parser: parseDeliveryRecord,
      value: deliveryRecord({
        status: "delivered",
        updatedAt: LATER,
        messageId: "message-1",
        historyEntryId: "entry-1",
        historyConversationId: "conversation-1",
        historyEntryFingerprint: FINGERPRINT,
        historyEntryDigest: SECOND_FINGERPRINT,
      }),
    },
    {
      name: "failed delivery record",
      parser: parseDeliveryRecord,
      value: deliveryRecord({
        status: "failed",
        attempts: 10_000,
        updatedAt: LATER,
        code: `d${"x".repeat(511)}`,
      }),
    },
    {
      name: "unknown delivery record",
      parser: parseDeliveryRecord,
      value: deliveryRecord({
        status: "unknown",
        updatedAt: LATER,
        code: "delivery_unknown",
      }),
    },
    {
      name: "retention checkpoint with equal run timestamps",
      parser: parseRunRetentionCheckpoint,
      value: retentionCheckpoint([], { startedAt: NOW, endedAt: NOW }),
    },
  ])("accepts canonical $name bytes", async ({ parser, value }) => {
    const parsed = await readExecutionRecord(jsonBytes(value), parser);
    expect(durableShape(parsed)).toStrictEqual(durableShape(value));
  });

  it("deduplicates identical retention artifact authority", async () => {
    const parsed = await readExecutionRecord(
      jsonBytes(retentionCheckpoint([ARTIFACT, ARTIFACT])),
      parseRunRetentionCheckpoint,
    ) as { readonly artifacts: readonly unknown[] };

    expect(parsed.artifacts).toStrictEqual([ARTIFACT]);
  });

  it("canonicalizes session metadata keys in lexical order", async () => {
    const parsed = await readExecutionRecord(
      jsonBytes(conversationWithMetadata({ zeta: true, alpha: false })),
      parseConversationRecord,
    ) as { readonly metadata: Readonly<Record<string, unknown>> };

    expect(Object.keys(parsed.metadata)).toStrictEqual(["alpha", "zeta"]);
  });

  it("ignores absent optional artifact references before deduplication", () => {
    expect(uniqueArtifactRefs([undefined, ARTIFACT])).toStrictEqual([ARTIFACT]);
  });

  it("rejects an empty transcript chunk manifest at the non-empty guard", async () => {
    await expect(readExecutionRecord(
      jsonBytes(conversationWithChunks({ ...TRANSCRIPT_CHUNKS, chunks: [] })),
      parseConversationRecord,
    )).rejects.toThrow(/conversation transcript chunks must not be empty/u);
  });

  it("rejects an unknown run-event type at the final discriminant guard", async () => {
    await expect(readExecutionRecord(
      jsonBytes({
        schemaVersion: 1,
        kind: "mono-agent.run-event",
        event: {
          type: "invented",
          runId: "run-1",
          sequence: 0,
          recordedAt: NOW,
        },
      }),
      parseStoredRunEvent,
    )).rejects.toThrow(/run event.type is invalid/u);
  });

  it("rejects a non-finite number produced directly by hostile JSON bytes", async () => {
    const encoded = JSON.stringify(conversationWithMetadata({
      value: "__FINITE_OVERFLOW__",
    })).replace('"__FINITE_OVERFLOW__"', "1e400");
    const boundary = executionBoundary(Buffer.from(encoded, "utf8"));

    await expect(
      boundary.store.read("core/test", parseConversationRecord, boundary.signal),
    ).rejects.toThrow(/must contain finite numbers/u);
    expect(boundary.transactions).toBe(0);
  });

  it("rejects conversation key and requested-identity authority mismatches", () => {
    const value = parseConversationRecord(DECODER_CASES[4]!.valid);
    const record = {
      key: conversationStateKey(value.conversationId),
      value,
      version: "v1",
      updatedAt: NOW,
    };

    expect(() => assertConversationKeyAuthority(record, value.conversationId)).not.toThrow();
    expect(() => assertConversationKeyAuthority(record)).not.toThrow();
    expect(() => assertConversationKeyAuthority({
      ...record,
      key: conversationStateKey("conversation-2"),
    })).toThrow(/conversation record key does not match/u);
    expect(() => assertConversationKeyAuthority(record, "conversation-2")).toThrow(
      /conversation record key does not match/u,
    );
  });

  it("rejects delivery requested-identity authority mismatches", () => {
    const value = parseDeliveryRecord(deliveryRecord());

    expect(() => assertDeliveryKeyAuthority(value, value.idempotencyKey)).not.toThrow();
    expect(() => assertDeliveryKeyAuthority(value, "delivery-2")).toThrow(
      /delivery record key does not match/u,
    );
  });

  const malformedRecords = DECODER_CASES.flatMap((entry) => [
    {
      name: `${entry.name}: wrong schema`,
      parser: entry.parser,
      value: { ...entry.valid, schemaVersion: 2 },
    },
    {
      name: `${entry.name}: wrong kind`,
      parser: entry.parser,
      value: { ...entry.valid, kind: `${String(entry.valid.kind)}.hostile` },
    },
    {
      name: `${entry.name}: unknown field`,
      parser: entry.parser,
      value: { ...entry.valid, untrusted: "must-not-be-accepted" },
    },
    ...entry.malformed.map((candidate) => ({
      name: `${entry.name}: ${candidate.name}`,
      parser: entry.parser,
      value: candidate.value,
    })),
  ]);

  it.each(malformedRecords)("rejects $name bytes without repair", async ({ parser, value }) => {
    const boundary = executionBoundary(jsonBytes(value));
    await expect(boundary.store.read("core/test", parser, boundary.signal)).rejects.toThrow();
    expect(boundary.transactions).toBe(0);
  });

  it.each([
    {
      name: "empty JSON",
      value: new Uint8Array(),
      error: /execution record is not valid UTF-8 JSON/u,
    },
    {
      name: "truncated JSON",
      value: Buffer.from("{", "utf8"),
      error: /execution record is not valid UTF-8 JSON/u,
    },
    {
      name: "invalid UTF-8",
      value: Uint8Array.of(0x22, 0xc3, 0x28, 0x22),
      error: /execution record is not valid UTF-8 JSON/u,
    },
    {
      name: "oversized bytes",
      value: new Uint8Array(1024 * 1024 + 1),
      error: /execution record exceeds 1048576 bytes/u,
    },
    {
      name: "invalid JSON at the exact byte ceiling",
      value: new Uint8Array(1024 * 1024).fill(0x20),
      error: /execution record is not valid UTF-8 JSON/u,
    },
  ])("rejects $name before a durable parser can accept it", async ({ value, error }) => {
    const boundary = executionBoundary(value);
    await expect(
      boundary.store.read("core/test", parseAdmissionRecord, boundary.signal),
    ).rejects.toThrow(error);
    expect(boundary.transactions).toBe(0);
  });

  it("rejects a non-byte value at the private decoder seam", () => {
    expect(() => decodeExecutionRecord("not bytes" as never)).toThrow(
      /execution record must be bytes/u,
    );
  });

  it("retains the low-level decoder cause without exposing the hostile bytes", () => {
    let failure: unknown;
    try {
      decodeExecutionRecord(Buffer.from("{", "utf8"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "execution record is not valid UTF-8 JSON",
      cause: expect.any(SyntaxError),
    });
  });
});

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function durableShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => durableShape(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, durableShape((value as Record<string, unknown>)[key])]),
  );
}

function transcriptChunk(
  index: number,
  sizeBytes = 1,
  conversationId = "conversation-1",
  digest = CHUNK_DIGEST,
): Record<string, unknown> {
  return {
    key: conversationChunkStateKey(conversationId, index, digest),
    digest,
    sizeBytes,
  };
}

function conversationWithChunks(
  transcriptChunks: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.conversation",
    conversationId: "conversation-1",
    revision: 1,
    transcriptChunks,
    entryCount: 0,
    createdAt: NOW,
    updatedAt: LATER,
  };
}

function conversationWithMetadata(metadata: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.conversation",
    conversationId: "conversation-1",
    revision: 1,
    inlineTranscript: INLINE_TRANSCRIPT,
    entryCount: 0,
    createdAt: NOW,
    updatedAt: LATER,
    metadata,
  };
}

function oversizedMetadataKeys(): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: 2_000 }, (_value, index) => [
      `encoded-key-${String(index).padStart(4, "0")}-${"x".repeat(24)}`,
      "",
    ]),
  );
}

function storedRunWithAttempts(
  attempts: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.run",
    summary: {
      ...RUNNING_SUMMARY,
      attempts,
    },
    eventCount: 1,
  };
}

function attemptEvent(attempt: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.run-event",
    event: {
      type: "attempt",
      runId: "run-1",
      sequence: 1,
      recordedAt: LATER,
      attempt,
    },
  };
}

function settledEvent(
  status: string,
  authority: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.run-event",
    event: {
      type: "settled",
      runId: "run-1",
      sequence: 1,
      recordedAt: LATER,
      status,
      ...authority,
    },
  };
}

function providerSession(
  timestamps: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.provider-session",
    conversationId: "conversation-1",
    route: ROUTE,
    session: {
      id: "session-1",
      conversationId: "conversation-1",
      route: ROUTE,
      ...timestamps,
    },
    updatedAt: LATER,
  };
}

function artifactIntent(
  artifacts: readonly Record<string, unknown>[],
  cleanupArtifacts: readonly Record<string, unknown>[] = [],
  timestamps: { readonly createdAt: string; readonly updatedAt: string } = {
    createdAt: NOW,
    updatedAt: LATER,
  },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.artifact-publication-intent",
    runId: "run-1",
    requestId: "request-1",
    artifacts,
    cleanupArtifacts,
    ...timestamps,
  };
}

function deliveryRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const status = overrides.status ?? "intent";
  return {
    schemaVersion: 1,
    kind: "mono-agent.delivery",
    idempotencyKey: "delivery-1",
    fingerprint: FINGERPRINT,
    channelInstanceId: "telegram",
    runId: "run-1",
    status,
    attempts: 1,
    attemptToken: "attempt-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === "intent" ? { leaseExpiresAt: LATER } : {}),
    ...overrides,
  };
}

function retentionCheckpoint(
  artifacts: readonly Record<string, unknown>[],
  timestamps: { readonly startedAt: string; readonly endedAt: string } = {
    startedAt: NOW,
    endedAt: LATER,
  },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.run-retention-checkpoint",
    runId: "run-1",
    historyKey: runHistoryStateKey(timestamps.startedAt, "run-1"),
    requestId: "request-1",
    ...timestamps,
    artifacts,
    createdAt: LATEST,
  };
}

async function readExecutionRecord(
  value: Uint8Array,
  parser: ExecutionRecordParser<unknown>,
): Promise<unknown> {
  const boundary = executionBoundary(value);
  const record = await boundary.store.read("core/test", parser, boundary.signal);
  if (record === undefined) throw new Error("Expected the hostile-byte test record.");
  return record.value;
}

function executionBoundary(value: Uint8Array): {
  readonly store: ExecutionStore;
  readonly signal: AbortSignal;
  readonly transactions: number;
} {
  let transactions = 0;
  const signal = new AbortController().signal;
  const accessor = createStateLocalInternalAccessor({
    async read(request) {
      return {
        key: request.key,
        value: new Uint8Array(value),
        version: "v1",
        updatedAt: NOW,
      };
    },
    async scan() {
      return { records: [] };
    },
    async transaction() {
      transactions += 1;
      return { status: "applied", records: [], deletedKeys: [] };
    },
  });
  return {
    store: new ExecutionStore(accessor),
    signal,
    get transactions() {
      return transactions;
    },
  };
}
