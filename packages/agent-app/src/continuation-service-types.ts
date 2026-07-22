import type { AgentContinuationOriginContext } from "@mono-agent/agent-contracts";

import type { ContinuationRetentionOptions } from "./continuation-store.js";
import type {
  ContinuationClaimCapability,
  ContinuationHealthSnapshot,
  ContinuationHistoryRecordInput,
  ContinuationHistoryRecordResult,
  ContinuationLimits,
  ContinuationMode,
  ContinuationNativeDeliveryInput,
  ContinuationNativeDeliveryResult,
  ContinuationStatusSnapshot,
  ContinuationSynthesisInput,
  ContinuationSynthesisResult,
  IssueContinuationCapabilityInput,
  NamedContinuationRoute,
} from "./continuations.js";

export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
export const DEFAULT_MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_LEASE_MS = 30 * 60 * 1_000;
export const DEFAULT_WORKER_INTERVAL_MS = 1_000;
export const DEFAULT_DELIVERY_ATTEMPTS = 20;
export const MAX_OPERATOR_PAGE_SIZE = 500;
export const MAX_CLAIM_BODY_BYTES = 16 * 1024;
export const MAX_TASK_KEY_CHARS = 256;
export const MAX_TEXT_CHARS = 200_000;
export const ORIGIN_CONTEXT_UNAVAILABLE_TEXT = "The background task finished, but I could not safely restore the original conversation context. Please ask me to check the result again.";

export interface ClaimBinding {
  readonly serverName: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly replyToConversationId?: string;
  readonly historyBoundary?: string;
  readonly mode: ContinuationMode;
  readonly fingerprint: string;
  closed: boolean;
  settled: boolean;
  inFlightOperations: number;
  drainPromise?: Promise<void>;
  resolveDrain?: () => void;
}

export interface ContinuationServiceLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface ContinuationServiceOptions {
  readonly stateDir?: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly port?: number;
  readonly namedRoutes?: Readonly<Record<string, NamedContinuationRoute>>;
  readonly detachedServices?: Readonly<Record<string, string>>;
  readonly retention?: ContinuationRetentionOptions;
  readonly synthesisPreflight?: (
    input: ContinuationSynthesisInput,
  ) => Promise<ContinuationSynthesisAvailability> | ContinuationSynthesisAvailability;
  readonly synthesize: (input: ContinuationSynthesisInput) => Promise<ContinuationSynthesisResult>;
  readonly deliver: (input: ContinuationNativeDeliveryInput) => Promise<ContinuationNativeDeliveryResult>;
  readonly recordHistory?: (input: ContinuationHistoryRecordInput) => Promise<ContinuationHistoryRecordResult>;
  readonly limits?: Partial<ContinuationLimits>;
  readonly maxResultBytes?: number;
  readonly maxDeadlineMs?: number;
  readonly leaseMs?: number;
  readonly workerIntervalMs?: number;
  readonly autoProcess?: boolean;
  readonly now?: () => Date;
  readonly logger?: ContinuationServiceLogger;
}

export type ContinuationSynthesisAvailability =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly code: string;
      readonly reason: string;
      readonly retryAfterMs?: number;
    };

export type ResolvedOriginContext =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid"; readonly code: string }
  | {
      readonly kind: "ready";
      readonly policy: "pinned";
      readonly snapshot: AgentContinuationOriginContext;
    }
  | { readonly kind: "ready"; readonly policy: "detached_latest" };

export interface ContinuationServiceHandle {
  readonly url: string;
  readonly operatorToken: string;
  issueContinuationClaimCapability(input: {
    readonly runId: string;
    readonly serverName: string;
    readonly conversationId: string;
    readonly replyTo?: { readonly conversationId: string };
    readonly historyBoundary?: string;
  }): ContinuationClaimCapability;
  issueRunClaimCapability(input: IssueContinuationCapabilityInput): ContinuationClaimCapability;
  status(id: string): Promise<ContinuationStatusSnapshot | undefined>;
  list(): Promise<readonly ContinuationStatusSnapshot[]>;
  health(): Promise<ContinuationHealthSnapshot>;
  processDue(limit?: number): Promise<number>;
  retry(id: string, options?: { readonly allowUnknown?: boolean }): Promise<ContinuationStatusSnapshot>;
  cancel(id: string): Promise<ContinuationStatusSnapshot>;
  resolveUnknown(
    id: string,
    outcome: { readonly kind: "delivered"; readonly deliveryId?: string }
      | { readonly kind: "not_delivered" }
      | { readonly kind: "dead_lettered" },
  ): Promise<ContinuationStatusSnapshot>;
  capturedText(id: string): Promise<string | undefined>;
  stop(): Promise<void>;
}
