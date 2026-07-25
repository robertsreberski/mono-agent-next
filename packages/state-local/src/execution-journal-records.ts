import type {
  ArtifactRef,
  JsonObject,
  RuntimeSession,
  RouteIdentity,
} from "@mono-agent/module-sdk";

import type {
  ExecutionArtifactDescriptor,
  ExecutionRecord,
} from "./execution-store.js";
import type { CanonicalTranscript } from "./execution-transcript.js";
import type {
  AgentRunEvent,
  AgentRunStatus,
  AgentRunSummary,
} from "./execution-types.js";
import type { DurableFingerprint } from "./execution-journal.js";

export interface AdmissionRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.admission";
  readonly requestId: string;
  readonly conversationId: string;
  readonly fingerprint: DurableFingerprint;
  readonly runId: string;
  readonly status: "running" | "settled" | "uncertain";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt: string;
  readonly settledStatus?: Exclude<AgentRunStatus, "running">;
  readonly responseRef?: ArtifactRef;
}

export interface StoredRunRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run";
  readonly summary: AgentRunSummary;
  readonly eventCount: number;
  readonly transcriptRef?: ArtifactRef;
}

export interface StoredRunEvent {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run-event";
  readonly event: AgentRunEvent;
}

export interface RunHistoryRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run-history";
  readonly runId: string;
  readonly startedAt: string;
}

export interface ConversationRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.conversation";
  readonly conversationId: string;
  readonly revision: number;
  readonly inlineTranscript?: CanonicalTranscript;
  readonly transcriptChunks?: TranscriptChunkManifest;
  readonly transcriptRef?: ArtifactRef;
  readonly entryCount: number;
  readonly createdAt?: string;
  readonly updatedAt: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export interface ConversationDeliveryEntryRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.conversation-delivery-entry";
  readonly entryId: string;
  readonly conversationId: string;
  readonly deliveryIdempotencyKey: string;
  readonly deliveryFingerprint: DurableFingerprint;
  readonly fingerprint: DurableFingerprint;
  readonly entryDigest: DurableFingerprint;
  readonly revision: number;
  readonly entryCount: number;
  readonly createdAt: string;
}

export interface TranscriptChunkDescriptor {
  readonly key: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface TranscriptChunkManifest {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.canonical-transcript-chunks";
  readonly encoding: "utf8-json";
  readonly digest: string;
  readonly sizeBytes: number;
  readonly chunks: readonly TranscriptChunkDescriptor[];
}

export interface LoadedConversationTranscript {
  readonly transcript: CanonicalTranscript;
  readonly chunks: readonly ExecutionRecord<Uint8Array>[];
}

export interface ChunkedCanonicalTranscript {
  readonly manifest: TranscriptChunkManifest;
  readonly chunks: readonly {
    readonly descriptor: TranscriptChunkDescriptor;
    readonly bytes: Uint8Array;
  }[];
}

export interface ConversationView {
  readonly conversationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transcript: CanonicalTranscript;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export interface ProviderSessionRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.provider-session";
  readonly conversationId: string;
  readonly route: RouteIdentity;
  readonly session: RuntimeSession;
  readonly updatedAt: string;
}

export interface ArtifactPublicationDescriptor extends ExecutionArtifactDescriptor {
  readonly slot: string;
}

export interface ArtifactPublicationIntentRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.artifact-publication-intent";
  readonly runId: string;
  readonly requestId: string;
  /** Descriptors that may still be promoted by a successful run settlement. */
  readonly artifacts: readonly ArtifactPublicationDescriptor[];
  /** Descriptors whose physical deletion has not yet been proven. */
  readonly cleanupArtifacts: readonly ArtifactPublicationDescriptor[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnsuredArtifactIntent {
  readonly record: ExecutionRecord<ArtifactPublicationIntentRecord>;
  /** Slots newly added or restored from cleanup by this publication attempt. */
  readonly activatedSlots: ReadonlySet<string>;
}

type DeliveryStatus = "intent" | "delivered" | "failed" | "unknown";

export interface DeliveryRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.delivery";
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly channelInstanceId: string;
  readonly runId?: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly attemptToken: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt?: string;
  readonly messageId?: string;
  readonly code?: string;
  readonly historyEntryId?: string;
  readonly historyConversationId?: string;
  readonly historyEntryFingerprint?: DurableFingerprint;
  readonly historyEntryDigest?: DurableFingerprint;
}

export interface RunRetentionCheckpoint {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run-retention-checkpoint";
  readonly runId: string;
  readonly historyKey: string;
  readonly requestId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly createdAt: string;
}
