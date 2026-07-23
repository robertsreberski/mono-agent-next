import type {
  ArtifactRef,
  RouteIdentity,
  RuntimeNativeToolEffect,
  RuntimeRetryability,
  RuntimeSideEffectStatus,
} from "@mono-agent/module-sdk";

/**
 * Private durable-domain shapes for the state-local execution recorder.
 *
 * These intentionally do not cross the reserved StateStore boundary. Core
 * exchanges them as opaque input/output values through `StateStore.execution`.
 */
export type AgentTranscriptContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "artifact";
      readonly ref: ArtifactRef;
      readonly name?: string;
    };

export type AgentInteractionEvidence =
  | {
      readonly kind: "ask-user";
      readonly interactionId: string;
      readonly phase: "requested" | "answered" | "expired" | "cancelled";
      readonly requestedAt: string;
      readonly settledAt?: string;
      readonly questionCount: number;
      readonly answeredQuestionCount?: number;
    }
  | {
      readonly kind: "approval";
      readonly interactionId: string;
      readonly phase: "requested" | "answered" | "expired" | "cancelled";
      readonly requestedAt: string;
      readonly settledAt?: string;
      readonly toolId: string;
      readonly effects: readonly RuntimeNativeToolEffect[];
      readonly decision?: "allow_once" | "deny";
    }
  | {
      readonly kind: "live-input";
      readonly interactionId: string;
      readonly phase: "applied" | "requeued" | "discarded";
      readonly receivedAt: string;
      readonly settledAt: string;
    };

export interface AgentRunAttemptEvidence {
  readonly attempt: number;
  readonly route: RouteIdentity;
  readonly status: "started" | "ineligible" | "failed" | "completed";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly code?: string;
  readonly retryability?: RuntimeRetryability;
  readonly sideEffects?: RuntimeSideEffectStatus;
}

export type AgentTranscriptEntry =
  | {
      readonly kind: "message";
      readonly entryId: string;
      readonly runId: string;
      readonly requestId: string;
      readonly conversationId: string;
      readonly recordedAt: string;
      readonly role: "user" | "assistant";
      readonly content: readonly AgentTranscriptContentPart[];
      readonly route?: RouteIdentity;
    }
  | {
      readonly kind: "interaction";
      readonly entryId: string;
      readonly runId: string;
      readonly requestId: string;
      readonly conversationId: string;
      readonly recordedAt: string;
      readonly evidence: AgentInteractionEvidence;
      readonly content: readonly AgentTranscriptContentPart[];
    }
  | {
      readonly kind: "verbatim";
      readonly entryId: string;
      readonly runId: string;
      readonly requestId: string;
      readonly conversationId: string;
      readonly recordedAt: string;
      readonly role: "user" | "assistant";
      readonly text: string;
    };

export type AgentRunStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "max-turns"
  | "failed"
  | "uncertain";

export type AgentRunEvent =
  | {
      readonly type: "admitted";
      readonly runId: string;
      readonly sequence: number;
      readonly recordedAt: string;
    }
  | {
      readonly type: "attempt";
      readonly runId: string;
      readonly sequence: number;
      readonly recordedAt: string;
      readonly attempt: AgentRunAttemptEvidence;
    }
  | {
      readonly type: "interaction";
      readonly runId: string;
      readonly sequence: number;
      readonly recordedAt: string;
      readonly evidence: AgentInteractionEvidence;
    }
  | {
      readonly type: "settled";
      readonly runId: string;
      readonly sequence: number;
      readonly recordedAt: string;
      readonly status: Exclude<AgentRunStatus, "running">;
      readonly transcriptRevision?: string;
      readonly failureCode?: string;
    };

export interface AgentRunSummary {
  readonly runId: string;
  readonly requestId: string;
  readonly conversationId: string;
  readonly status: AgentRunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly attempts: readonly AgentRunAttemptEvidence[];
  readonly transcriptRevision?: string;
  readonly failureCode?: string;
}

export interface AgentRunHistoryPage {
  readonly runs: readonly AgentRunSummary[];
  readonly nextCursor?: string;
}

export interface AgentRunRecord {
  readonly summary: AgentRunSummary;
  readonly events: readonly AgentRunEvent[];
  readonly transcript: readonly AgentTranscriptEntry[];
}
