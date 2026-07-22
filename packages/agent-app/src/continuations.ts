import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentContinuationOriginContext } from "@mono-agent/agent-contracts";

/** Delivery behavior bound by the host before an asynchronous task is delegated. */
export type ContinuationMode = "reply" | "notify_if_actionable" | "silent" | "capture";

/** Durable continuation lifecycle. Original agent-run status is intentionally separate. */
export type ContinuationState =
  | "claimed"
  | "result_received"
  | "synthesizing"
  | "ready_to_deliver"
  | "delivery_retry"
  | "delivery_unknown"
  | "delivered"
  | "expired"
  | "cancelled"
  | "dead_lettered";

export type ContinuationTerminalState =
  | "delivery_unknown"
  | "delivered"
  | "expired"
  | "cancelled"
  | "dead_lettered";

export interface ContinuationDeliveryReceipt {
  readonly kind: "delivered" | "suppressed" | "captured" | "silent";
  readonly deliveredAt: string;
  readonly deliveryId?: string;
  readonly channelId?: string;
  readonly historyRecorded?: boolean;
  readonly historyErrorCode?: string;
}

/** Structured native-channel outcome. Ambiguous outcomes must use `unknown`, never `retryable`. */
export type ContinuationNativeDeliveryResult =
  | {
      readonly kind: "delivered";
      readonly code: "delivered";
      readonly deliveryId?: string;
      readonly channelId?: string;
      readonly historyRecorded?: boolean;
      readonly historyErrorCode?: string;
    }
  | {
      readonly kind: "retryable";
      readonly code: string;
      readonly reason: string;
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: "permanent";
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly kind: "unknown";
      readonly code: string;
      readonly reason: string;
    };

export interface ContinuationSynthesisResult {
  readonly text: string;
  /** Used only by `notify_if_actionable`; omitted means actionable. */
  readonly actionable?: boolean;
}

interface ContinuationSynthesisInputBase {
  readonly continuationId: string;
  /** Exact history identity, including a rollover bucket when one exists. */
  readonly originConversationId: string;
  readonly originRunId: string;
  /** Bound destination/synthesis conversation when the mode has one. */
  readonly replyToConversationId?: string;
  readonly mode: ContinuationMode;
  /** Untrusted external result. Callers must frame it as data, never instructions. */
  readonly payload: unknown;
}

export type ContinuationSynthesisInput = ContinuationSynthesisInputBase & (
  | {
      readonly historyBoundary: string;
      readonly originContextPolicy: "pinned";
      readonly originContext: AgentContinuationOriginContext;
    }
  | {
      readonly historyBoundary?: never;
      readonly originContextPolicy: "detached_latest";
      readonly originContext?: never;
    }
);

export interface ContinuationNativeDeliveryInput {
  readonly continuationId: string;
  /** Physical channel/thread identity captured by the host, never supplied by the task. */
  readonly conversationId: string;
  readonly text: string;
  /** Stable identity for adapters that support idempotent sends. */
  readonly deliveryKey: string;
}

/** History-only commit used after an operator confirms an ambiguous native send. */
export interface ContinuationHistoryRecordInput extends ContinuationNativeDeliveryInput {}

export type ContinuationHistoryRecordResult =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly code: string };

/** Finite service limits. These defaults apply even when no host block exists. */
export interface ContinuationLimits {
  readonly maxActiveRecords: number;
  readonly maxActivePerOrigin: number;
  readonly maxConcurrent: number;
  readonly synthesisTimeoutMs: number;
  readonly deliveryTimeoutMs: number;
  readonly operatorPageSize: number;
}

export const DEFAULT_CONTINUATION_LIMITS: ContinuationLimits = {
  maxActiveRecords: 10_000,
  maxActivePerOrigin: 500,
  maxConcurrent: 16,
  synthesisTimeoutMs: 10 * 60 * 1_000,
  deliveryTimeoutMs: 2 * 60 * 1_000,
  operatorPageSize: 100,
};

export interface NamedContinuationRoute {
  readonly mode: Exclude<ContinuationMode, "reply">;
  /** Required for notify_if_actionable; optional synthesis context for capture; forbidden for silent. */
  readonly conversationId?: string;
}

export interface ContinuationClaimCapability {
  readonly url: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly mode: ContinuationMode;
  /** Reserved headers for trusted HTTP MCP request-context injection. */
  headers(): Readonly<Record<string, string>>;
  /** Reserved environment for trusted stdio MCP request-context injection. */
  env(): Readonly<Record<string, string>>;
  /** True only when a drained capability owns an active interactive claim. */
  requiresOriginContext(): Promise<boolean>;
  /** Valid after release(): durably bind the completed origin turn to all claims. */
  finalizeOriginContext(snapshot: AgentContinuationOriginContext): Promise<void>;
  /** Make the prepared snapshot eligible for synthesis after origin commit. */
  activateOriginContext(): Promise<void>;
  /** Valid after release(): permanently mark claims whose origin run did not commit. */
  abandonOriginContext(): Promise<void>;
  release(): Promise<void>;
}

export interface IssueContinuationCapabilityInput {
  readonly serverName: string;
  readonly runId: string;
  readonly originConversationId: string;
  /** Normalized physical channel/thread route; defaults to originConversationId without a rollover suffix. */
  readonly replyToConversationId?: string;
  readonly historyBoundary?: string;
  readonly mode?: ContinuationMode;
}

export interface ContinuationStatusSnapshot {
  readonly continuationId: string;
  readonly state: ContinuationState;
  readonly mode: ContinuationMode;
  readonly taskKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadline: string;
  readonly attempts: {
    readonly synthesis: number;
    readonly delivery: number;
  };
  readonly synthesisDeferrals: number;
  readonly originContext: {
    readonly state: "pending" | "pinned" | "abandoned" | "detached_latest" | "legacy_missing" | "scrubbed";
    readonly digest?: string;
    readonly messageCount?: number;
  };
  readonly completionKind?: "synthesized" | "origin_context_unavailable";
  readonly nextAttemptAt?: string;
  readonly lastError?: {
    readonly code: string;
    readonly reason: string;
    readonly at: string;
  };
  readonly receipt?: ContinuationDeliveryReceipt;
}

export interface ContinuationHealthSnapshot {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly checkedAt: string;
  readonly counts: Readonly<Record<ContinuationState, number>>;
  readonly pending: number;
  readonly due: number;
  readonly oldestPendingAt?: string;
  readonly storage: {
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
  };
}

export const CONTINUATION_CLAIM_URL_HEADER = "x-mono-agent-continuation-claim-url";
export const CONTINUATION_CLAIM_TOKEN_HEADER = "x-mono-agent-continuation-claim-token";
export const CONTINUATION_FINGERPRINT_HEADER = "x-mono-agent-continuation-claim-fingerprint";
export const CONTINUATION_MODE_HEADER = "x-mono-agent-continuation-claim-mode";

export const CONTINUATION_CLAIM_URL_ENV = "MONO_AGENT_CONTINUATION_CLAIM_URL";
export const CONTINUATION_CLAIM_TOKEN_ENV = "MONO_AGENT_CONTINUATION_CLAIM_TOKEN";
export const CONTINUATION_FINGERPRINT_ENV = "MONO_AGENT_CONTINUATION_CLAIM_FINGERPRINT";
export const CONTINUATION_MODE_ENV = "MONO_AGENT_CONTINUATION_CLAIM_MODE";

export const CONTINUATION_STATES: readonly ContinuationState[] = [
  "claimed",
  "result_received",
  "synthesizing",
  "ready_to_deliver",
  "delivery_retry",
  "delivery_unknown",
  "delivered",
  "expired",
  "cancelled",
  "dead_lettered",
];

export const TERMINAL_CONTINUATION_STATES: ReadonlySet<ContinuationState> = new Set([
  "delivery_unknown",
  "delivered",
  "expired",
  "cancelled",
  "dead_lettered",
]);

export function normalizeContinuationReplyTarget(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

export function continuationDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON for idempotency: object keys sorted recursively, array order retained. */
export function canonicalContinuationJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalJsonValue(object[key])]));
  }
  return null;
}

export function continuationTokenMatches(token: string, expectedDigest: string): boolean {
  const actual = Buffer.from(continuationDigest(token), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isContinuationMode(value: unknown): value is ContinuationMode {
  return value === "reply" || value === "notify_if_actionable" || value === "silent" || value === "capture";
}

export function isContinuationState(value: unknown): value is ContinuationState {
  return typeof value === "string" && CONTINUATION_STATES.includes(value as ContinuationState);
}
