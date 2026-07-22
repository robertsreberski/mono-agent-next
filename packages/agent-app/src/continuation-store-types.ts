import {
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES,
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES,
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";

import type {
  ContinuationDeliveryReceipt,
  ContinuationMode,
  ContinuationState,
} from "./continuations.js";

export const CONTINUATION_STORE_SCHEMA_VERSION = 1;
export const CONTINUATION_RECORD_STORE_SCHEMA_VERSION = 3;

export const RECORDS_DIRECTORY = "records-v3";
export const TRANSACTION_FILE = "continuation-transaction-v3.json";
export const MANIFEST_FILE = "continuation-store-v3.json";
export const LEGACY_RECORDS_DIRECTORY = "records-v2";
export const LEGACY_TRANSACTION_FILE = "continuation-transaction-v2.json";
export const V2_ROLLBACK_GUARD = "UPGRADED-TO-RECORDS-V3";
export const ORIGIN_CONTEXT_GROUPS_DIRECTORY = "origin-context-groups-v1";
export const OWNER_DATABASE_FILE = "continuations-owner.sqlite";
export const ORIGIN_CONTEXTS_DIRECTORY = "origin-context-v1";
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_GENERATION_BYTES = 256;
export const MAX_LEGACY_STORE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TERMINAL_MAX_RECORDS = 50_000;
export const DEFAULT_TERMINAL_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
export const DEFAULT_CAPTURED_TEXT_MAX_RECORDS = 1_000;
export const DEFAULT_CAPTURED_TEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES = 256 * 1024 * 1024;

export type ContinuationOriginContextState =
  | "pending"
  | "pinned"
  | "abandoned"
  | "detached_latest"
  | "legacy_missing"
  | "scrubbed";

export interface ContinuationOriginContextReference {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly bytes: number;
  readonly messageCount: number;
}

export interface ContinuationOriginContextPin {
  readonly reference: ContinuationOriginContextReference;
  release(): Promise<void>;
}

export interface ContinuationRetentionOptions {
  /** Metadata/idempotency tombstones retained after terminal compaction. Default 50,000. */
  readonly terminalMaxRecords?: number;
  /** Maximum terminal tombstone age. Default 365 days. */
  readonly terminalMaxAgeMs?: number;
  /** Captured synthesized text retained for operator retrieval. Default 1,000 records. */
  readonly capturedTextMaxRecords?: number;
  /** Captured text retention window. Default 30 days. */
  readonly capturedTextMaxAgeMs?: number;
}

export interface ContinuationStoreStats {
  readonly format: "per-record-v3";
  readonly records: number;
  readonly active: number;
  readonly unresolvedDelivery: number;
  readonly deadLettered: number;
  readonly terminalTombstones: number;
  readonly compacted: number;
  readonly capturedText: number;
  readonly historyDegraded: number;
  readonly limits: {
    readonly terminalMaxRecords: number;
    readonly terminalMaxAgeMs: number;
    readonly capturedTextMaxRecords: number;
    readonly capturedTextMaxAgeMs: number;
  };
}

export interface ContinuationLastError {
  readonly code: string;
  readonly reason: string;
  readonly at: string;
}

export interface DurableContinuationRecord {
  readonly continuationId: string;
  readonly serverName: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly replyToConversationId?: string;
  readonly historyBoundary?: string;
  originContextState: ContinuationOriginContextState;
  originContextRef?: ContinuationOriginContextReference;
  /** Retained after terminal snapshot scrubbing for audit/idempotency. */
  originContextDigest?: string;
  originContextMessageCount?: number;
  /** Domain-separated binding of the v1 claim fingerprint and pinned digest. */
  originContextFingerprint?: string;
  /** Store-only HMAC over the immutable claim, route, task, and snapshot binding. */
  originContextBindingMac?: string;
  completionKind?: "synthesized" | "origin_context_unavailable";
  readonly mode: ContinuationMode;
  readonly routeName?: string;
  readonly taskKey: string;
  readonly taskHash: string;
  readonly claimFingerprint: string;
  readonly resultTokenHash: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly deadline: string;
  state: ContinuationState;
  resultIdempotencyKey?: string;
  resultPayloadHash?: string;
  resultPayload?: unknown;
  synthesisAttempts: number;
  synthesisDeferrals: number;
  synthesisStartedAt?: string;
  synthesizedText?: string;
  actionable?: boolean;
  deliveryAttempts: number;
  deliveryStartedAt?: string;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: ContinuationLastError;
  receipt?: ContinuationDeliveryReceipt;
  /** Set once bulky terminal payload/text fields have been removed. */
  compactedAt?: string;
}

export interface ContinuationStoreFile {
  readonly schemaVersion: typeof CONTINUATION_STORE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly records: Record<string, DurableContinuationRecord>;
}

export interface ResolvedContinuationRetention {
  readonly terminalMaxRecords: number;
  readonly terminalMaxAgeMs: number;
  readonly capturedTextMaxRecords: number;
  readonly capturedTextMaxAgeMs: number;
}

export interface ContinuationRecordTransaction {
  readonly schemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION;
  readonly generation: string;
  readonly createdAt: string;
  readonly writes: readonly DurableContinuationRecord[];
  readonly deletes: readonly string[];
}

export interface ContinuationStoreManifest {
  readonly schemaVersion: typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION;
  readonly generation: string;
  readonly updatedAt: string;
  /** False only for a fresh evidence-free store. Absent means true for eager-guard manifests; true is monotonic. */
  readonly rollbackGuardRequired?: boolean;
  readonly stats: ContinuationStoreStats;
}

export interface ContinuationOriginContextGroupCommit {
  readonly schemaVersion: 1;
  readonly groupKey: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly historyBoundary: string;
  readonly snapshotDigest: string;
  readonly memberCount: number;
  readonly memberSetDigest: string;
  readonly activatedAt: string;
}

export interface ContinuationStore {
  readonly path: string;
  get(id: string): Promise<DurableContinuationRecord | undefined>;
  list(): Promise<readonly DurableContinuationRecord[]>;
  findClaim(input: {
    readonly serverName: string;
    readonly originRunId: string;
    readonly taskKey: string;
  }): Promise<DurableContinuationRecord | undefined>;
  stats(): Promise<ContinuationStoreStats>;
  stageOriginContext(snapshot: AgentContinuationOriginContext): Promise<ContinuationOriginContextPin>;
  loadOriginContext(reference: ContinuationOriginContextReference): Promise<AgentContinuationOriginContext | undefined>;
  activateOriginContextGroup(input: {
    readonly claimFingerprint: string;
    readonly activatedAt: string;
  }): Promise<void>;
  mutate<T>(operation: (records: Map<string, DurableContinuationRecord>) => T | Promise<T>): Promise<T>;
}

export interface ContinuationStoreLock {
  release(): Promise<void>;
}
