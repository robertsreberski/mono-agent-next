import type {
  OperatorAsk,
  OperatorAskAnswerResponse,
  OperatorAttachment,
  OperatorConfigView,
  OperatorHealth,
  OperatorLiveInputResponse,
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
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface WebThread {
  readonly id: string;
  readonly agentId: string;
  /** Exact agent-owned conversation id used by the shared operator client. */
  readonly operatorConversationId?: string;
  /** Present only for conversations opened by proactive operator delivery. */
  readonly proactive?: true;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Internal durable tombstone for a dismissed proactive conversation. */
  readonly deletedAt?: string;
  readonly status: WebTurnStatus;
  readonly activeTurnId?: string;
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
  /** Bounded numeric/event metadata only; never thoughts, activity, or provider payloads. */
  readonly telemetry?: WebTurnTelemetry;
}

export interface WebThreadDetail {
  readonly thread: WebThread;
  readonly messages: readonly WebMessage[];
}

export interface WebBootstrap {
  readonly version: typeof WEB_API_VERSION;
  readonly agents: readonly WebAgent[];
  readonly threads: readonly WebThread[];
  /** Newly persisted during this bootstrap, so renderers can notify once. */
  readonly newProactiveThreadIds: readonly string[];
}

export interface CreateWebThreadInput {
  readonly agentId: string;
  readonly title?: string;
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

export interface StoredWebState {
  readonly schemaVersion: 2;
  readonly threads: readonly WebThread[];
  readonly messages: readonly WebMessage[];
}
