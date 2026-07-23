import type {
  OperatorAsk,
  OperatorAskAnswerResponse,
  OperatorAttachment,
  OperatorConfigView,
  OperatorHealth,
  OperatorLiveInputResponse,
  OperatorModel,
  OperatorActivity,
  OperatorQuote,
  OperatorReplayResponse,
} from "@mono-agent/operator";

/** Browser API version. It is independent from the agent operator wire version. */
export const WEB_API_VERSION = 1 as const;

export type WebTurnStatus = "idle" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

/**
 * Content-free, per-turn operator telemetry. Event flags are sticky for the
 * lifetime of the turn so later usage snapshots cannot erase an occurrence.
 */
export interface WebTurnTelemetry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextWindow?: number;
  readonly contextUsed?: number;
  readonly compacted: boolean;
  readonly sessionEvicted: boolean;
}

export interface WebAgent {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly online: boolean;
  readonly pinned: boolean;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly defaults?: {
    readonly runtime?: string;
    readonly model?: string;
    readonly effort?: string;
  };
  readonly models?: readonly OperatorModel[];
}

export type WebNotificationTriggerKind = "cron" | "webhook";

export interface WebThread {
  readonly id: string;
  readonly agentId: string;
  /** Exact agent-owned conversation id used by the shared operator client. */
  readonly operatorConversationId?: string;
  /** Present only for conversations opened by proactive operator delivery. */
  readonly proactive?: true;
  /** Whitelisted trigger provenance; arbitrary conversation metadata is never exposed. */
  readonly trigger?: { readonly kind: WebNotificationTriggerKind };
  readonly title: string;
  /** Internal ownership marker preventing an automatic title from replacing an operator title. */
  readonly titleManual: boolean;
  readonly archivedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Internal durable tombstone for a dismissed proactive conversation. */
  readonly deletedAt?: string;
  readonly status: WebTurnStatus;
  readonly activeTurnId?: string;
  /** Stable completion identity used for response-notification deduplication. */
  readonly lastTurnId?: string;
  readonly pendingAsk?: OperatorAsk;
}

export interface WebMessage {
  readonly id: string;
  /** Agent transcript id, when the operator replay/terminal frame supplies one. */
  readonly operatorMessageId?: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: readonly OperatorAttachment[];
  readonly quote?: OperatorQuote;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: Exclude<WebTurnStatus, "idle">;
  readonly error?: { readonly code: string; readonly message: string };
  /** Bounded, redacted operator activity. Transient thought deltas are never stored. */
  readonly activities?: readonly OperatorActivity[];
  /** Bounded numeric/event metadata only; never thoughts or provider payloads. */
  readonly telemetry?: WebTurnTelemetry;
}

export interface WebThreadDetail {
  readonly thread: WebThread;
  readonly messages: readonly WebMessage[];
}

export interface WebBootstrap {
  readonly version: typeof WEB_API_VERSION;
  /** Durable monotonic state revision used to resume invalidation streams. */
  readonly revision: number;
  readonly agents: readonly WebAgent[];
  readonly threads: readonly WebThread[];
  /** Newly persisted during this bootstrap, so renderers can notify once. */
  readonly newProactiveThreadIds: readonly string[];
}

export interface CreateWebThreadInput {
  readonly agentId: string;
  readonly title?: string;
}

export interface PatchWebAgentInput {
  readonly pinned: boolean;
}

export interface PatchWebThreadInput {
  readonly title?: string;
  readonly archived?: boolean;
}

export interface StartWebTurnInput {
  readonly text: string;
  readonly attachments?: readonly OperatorAttachment[];
  readonly quote?: OperatorQuote;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface AnswerWebAskInput {
  readonly interactionId: string;
  readonly answers: Readonly<Record<string, readonly string[]>>;
}

export interface OfferWebLiveInput {
  readonly text: string;
}

export type WebAskAnswerResult = OperatorAskAnswerResponse;
export type WebLiveInputResult = OperatorLiveInputResponse;
export type WebReplayView = OperatorReplayResponse;
export type WebConfigView = OperatorConfigView;
export type WebHealthView = OperatorHealth;

export type WebEventType =
  | "ready"
  | "reset"
  | "agents.changed"
  | "threads.changed"
  | "thread.changed";

export interface WebEvent {
  readonly id: string;
  readonly version: typeof WEB_API_VERSION;
  readonly revision: number;
  readonly type: WebEventType;
  readonly at: string;
  readonly threadId?: string;
}

export interface StoredWebState {
  readonly schemaVersion: 3;
  readonly revision: number;
  readonly pinnedAgentIds: readonly string[];
  readonly threads: readonly WebThread[];
  readonly messages: readonly WebMessage[];
}
