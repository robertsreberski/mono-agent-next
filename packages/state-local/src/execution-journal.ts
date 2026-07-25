import type {
  ArtifactRef,
  JsonObject,
  RuntimeSession,
  RouteIdentity,
} from "@mono-agent/module-sdk";

import { ExecutionStore } from "./execution-store.js";

import type {
  CanonicalTranscript,
  CanonicalTranscriptEntry,
} from "./execution-transcript.js";

import type {
  AgentInteractionEvidence,
  AgentRunAttemptEvidence,
  AgentRunHistoryPage,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSummary,
} from "./execution-types.js";

import {
  createExecutionJournalDependencies,
} from "./execution-journal-concern.js";
import type { ConversationView } from "./execution-journal-records.js";

import { ExecutionConversationJournal } from "./execution-journal-conversations.js";

import { ExecutionDeliveryJournal } from "./execution-journal-delivery.js";

import { ExecutionMaintenanceJournal } from "./execution-journal-maintenance.js";

import { ExecutionRunJournal } from "./execution-journal-runs.js";

export type DurableFingerprint = `sha256:${string}`;

export interface RunAdmissionInput {
  readonly requestId: string;
  readonly conversationId: string;
  readonly fingerprint: DurableFingerprint;
  readonly runId?: string;
  readonly signal: AbortSignal;
}

export type RunAdmissionResult =
  | { readonly status: "accepted"; readonly summary: AgentRunSummary }
  | { readonly status: "join"; readonly runId: string }
  | {
      readonly status: "cached";
      readonly summary: AgentRunSummary;
      readonly responseRef?: ArtifactRef;
    }
  | { readonly status: "conflict"; readonly runId: string }
  | { readonly status: "uncertain"; readonly runId: string };

export interface SettleRunInput {
  readonly runId: string;
  readonly requestId: string;
  readonly status: Exclude<AgentRunStatus, "running">;
  readonly transcript?: CanonicalTranscript;
  readonly responseBytes?: Uint8Array;
  readonly session?: {
    readonly value: RuntimeSession;
    readonly updatedAt: string;
  };
  readonly sessionEviction?: RouteIdentity;
  readonly failureCode?: string;
  readonly signal: AbortSignal;
}

export interface StageRunArtifactInput {
  readonly slot: string;
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly fileName?: string;
}

export interface StageRunArtifactsInput {
  readonly runId: string;
  readonly requestId: string;
  readonly artifacts: readonly StageRunArtifactInput[];
  readonly signal: AbortSignal;
}

export interface StagedRunArtifact {
  readonly slot: string;
  readonly ref: ArtifactRef;
}

export interface DeliveryIntentInput {
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly channelInstanceId: string;
  readonly runId?: string;
  readonly signal: AbortSignal;
}

export type DeliveryIntentResult =
  | { readonly status: "send"; readonly attempt: number; readonly token: string }
  | { readonly status: "join" }
  | { readonly status: "duplicate"; readonly messageId?: string }
  | { readonly status: "conflict" }
  | { readonly status: "unknown"; readonly code?: string };

export interface DeliverySettlementInput {
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly attempt: number;
  readonly token: string;
  readonly status: "delivered" | "failed" | "unknown";
  readonly messageId?: string;
  readonly code?: string;
  readonly signal: AbortSignal;
}

export interface DeliverySettlementWithHistoryInput {
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly attempt: number;
  readonly token: string;
  readonly messageId?: string;
  readonly conversationId: string;
  readonly entry: DeliveryTranscriptEntryInput;
  readonly entryFingerprint: DurableFingerprint;
  readonly signal: AbortSignal;
}

export type DeliveryTranscriptEntryInput =
  | Omit<
      Extract<CanonicalTranscriptEntry, { readonly kind: "message" }>,
      "recordedAt"
    >
  | Omit<
      Extract<CanonicalTranscriptEntry, { readonly kind: "verbatim" }>,
      "recordedAt"
    >;

export type DeliverySettlementWithHistoryResult =
  | {
      readonly status: "appended" | "duplicate";
      readonly conversationId: string;
      readonly entryId: string;
      readonly revision: number;
      readonly entryCount: number;
      readonly messageId?: string;
    }
  | {
      readonly status: "conflict";
      readonly conversationId: string;
      readonly entryId: string;
    };

export interface DurableRunJournalOptions {
  readonly clock?: () => Date;
  readonly staleAfterMs?: number;
  readonly createRunId?: () => string;
  readonly createDeliveryToken?: () => string;
  readonly releaseArtifact?: (
    ref: ArtifactRef,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export interface ExecutionMaintenanceInput {
  readonly cutoffAt: string;
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly signal: AbortSignal;
}

export interface ExecutionMaintenanceResult {
  readonly terminalRunCandidates: number;
  readonly terminalRunsRemoved: number;
  readonly runEventsRemoved: number;
  readonly terminalAdmissionsRemoved: number;
  readonly terminalDeliveryCandidates: number;
  readonly terminalDeliveriesRemoved: number;
  readonly staleSessionCandidates: number;
  readonly staleSessionsRemoved: number;
  readonly publishedArtifactsReleased: number;
  readonly pendingCheckpoints: number;
  readonly truncated: boolean;
}

export interface ReconcileArtifactPublicationsInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal: AbortSignal;
}

export interface ArtifactPublicationReconciliation {
  readonly examined: number;
  readonly deletedArtifacts: number;
  readonly pendingArtifacts: number;
  readonly skippedActive: number;
  readonly nextCursor?: string;
}


export class DurableRunJournal {
  readonly #runs: ExecutionRunJournal;
  readonly #conversations: ExecutionConversationJournal;
  readonly #delivery: ExecutionDeliveryJournal;
  readonly #maintenance: ExecutionMaintenanceJournal;

  constructor(store: ExecutionStore, options: DurableRunJournalOptions = {}) {
    const dependencies = createExecutionJournalDependencies(store, options);
    this.#runs = new ExecutionRunJournal(dependencies);
    this.#conversations = new ExecutionConversationJournal(dependencies);
    this.#delivery = new ExecutionDeliveryJournal(dependencies);
    this.#maintenance = new ExecutionMaintenanceJournal(dependencies);
  }

  async admit(input: RunAdmissionInput): Promise<RunAdmissionResult> {
    return this.#runs.admit(input);
  }

  async renewAdmission(
    requestId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.#runs.renewAdmission(requestId, runId, signal);
  }

  async recordAttempt(
    runId: string,
    attempt: AgentRunAttemptEvidence,
    signal: AbortSignal,
  ): Promise<AgentRunSummary> {
    return this.#runs.recordAttempt(runId, attempt, signal);
  }

  async recordInteraction(
    runId: string,
    evidence: AgentInteractionEvidence,
    signal: AbortSignal,
  ): Promise<AgentRunSummary> {
    return this.#runs.recordInteraction(runId, evidence, signal);
  }

  async stageRunArtifacts(
    input: StageRunArtifactsInput,
  ): Promise<readonly StagedRunArtifact[]> {
    return this.#runs.stageRunArtifacts(input);
  }

  async settle(input: SettleRunInput): Promise<AgentRunSummary> {
    return this.#runs.settle(input);
  }

  async readCachedResponse(
    ref: ArtifactRef,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#runs.readCachedResponse(ref, signal);
  }

  async loadTranscript(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<CanonicalTranscript | undefined> {
    return this.#conversations.loadTranscript(conversationId, signal);
  }

  async openConversation(
    input: {
      readonly title?: string;
      readonly initialText?: string;
      readonly metadata?: JsonObject;
    },
    signal: AbortSignal,
  ): Promise<ConversationView> {
    return this.#conversations.openConversation(input, signal);
  }

  async settleDeliveryWithHistory(
    input: DeliverySettlementWithHistoryInput,
  ): Promise<DeliverySettlementWithHistoryResult> {
    return this.#delivery.settleDeliveryWithHistory(input);
  }

  async loadConversation(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ConversationView | undefined> {
    return this.#conversations.loadConversation(conversationId, signal);
  }

  async listConversations(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    readonly conversations: readonly Omit<ConversationView, "transcript">[];
    readonly nextCursor?: string;
  }> {
    return this.#conversations.listConversations(cursor, signal);
  }

  async loadSession(
    conversationId: string,
    route: RouteIdentity,
    signal: AbortSignal,
  ): Promise<{ readonly value: RuntimeSession; readonly updatedAt: string } | undefined> {
    return this.#conversations.loadSession(conversationId, route, signal);
  }

  async evictSession(
    conversationId: string,
    route: RouteIdentity,
    expected: {
      readonly sessionId: string;
      readonly updatedAt: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.#conversations.evictSession(
      conversationId,
      route,
      expected,
      signal,
    );
  }

  async readRun(
    runId: string,
    signal: AbortSignal,
  ): Promise<AgentRunRecord | undefined> {
    return this.#runs.readRun(runId, signal);
  }

  async listRuns(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<AgentRunHistoryPage> {
    return this.#runs.listRuns(cursor, signal);
  }

  async prepareDelivery(input: DeliveryIntentInput): Promise<DeliveryIntentResult> {
    return this.#delivery.prepareDelivery(input);
  }

  async settleDelivery(input: DeliverySettlementInput): Promise<DeliveryIntentResult> {
    return this.#delivery.settleDelivery(input);
  }

  async reconcileArtifactPublications(
    input: ReconcileArtifactPublicationsInput,
  ): Promise<ArtifactPublicationReconciliation> {
    return this.#maintenance.reconcileArtifactPublications(input);
  }

  async maintainExecution(
    input: ExecutionMaintenanceInput,
  ): Promise<ExecutionMaintenanceResult> {
    return this.#maintenance.maintainExecution(input);
  }
}

export { createDurableFingerprint } from "./execution-codec.js";
