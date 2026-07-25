// SPDX-License-Identifier: MIT
import type { OperatorActivity } from "@mono-agent/operator";

export const WEB_API_VERSION = 1 as const;

export type TurnStatus =
  | "idle"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes?: number;
  readonly url?: string;
}

export interface Quote {
  readonly conversationId: string;
  readonly messageId: string;
  readonly text?: string;
}

/**
 * `{ runtime, id }` is the atomic route. The same model id reached through two
 * runtimes is two options, and the picker must never offer one half alone.
 */
export interface ModelOption {
  readonly runtime: string;
  readonly id: string;
  readonly label?: string;
  readonly efforts?: readonly string[];
  readonly contextWindow?: number;
}

export interface Agent {
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
  readonly models?: readonly ModelOption[];
}

export interface AskChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly choices?: readonly AskChoice[];
  readonly allowFreeText: boolean;
  readonly multiple: boolean;
}

export interface Ask {
  readonly interactionId: string;
  readonly questions: readonly AskQuestion[];
  readonly requestedAt: string;
}

export interface Thread {
  readonly id: string;
  readonly agentId: string;
  readonly operatorConversationId?: string;
  readonly proactive?: true;
  readonly trigger?: { readonly kind: "cron" | "webhook" };
  readonly title: string;
  readonly titleManual: boolean;
  readonly archivedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: TurnStatus;
  readonly activeTurnId?: string;
  readonly lastTurnId?: string;
  readonly pendingAsk?: Ask;
}

export interface Telemetry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextWindow?: number;
  readonly contextUsed?: number;
  readonly compacted: boolean;
  readonly sessionEvicted: boolean;
}

export interface Message {
  readonly id: string;
  readonly operatorMessageId?: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly quote?: Quote;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: Exclude<TurnStatus, "idle">;
  readonly error?: { readonly code: string; readonly message: string };
  readonly activities?: readonly OperatorActivity[];
  readonly telemetry?: Telemetry;
}

export interface ThreadDetail {
  readonly thread: Thread;
  readonly messages: readonly Message[];
}

export interface Bootstrap {
  readonly version: typeof WEB_API_VERSION;
  readonly revision: number;
  readonly agents: readonly Agent[];
  readonly threads: readonly Thread[];
  readonly newProactiveThreadIds: readonly string[];
}

export interface WebEvent {
  readonly id: string;
  readonly version: typeof WEB_API_VERSION;
  readonly revision: number;
  readonly type:
    | "ready"
    | "reset"
    | "agents.changed"
    | "threads.changed"
    | "thread.changed";
  readonly at: string;
  readonly threadId?: string;
}

export interface StartTurnInput {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly quote?: Quote;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface StreamFrame {
  readonly type: "state" | "done" | "error";
  readonly detail: ThreadDetail;
  readonly error?: { readonly code: string; readonly message: string };
}
