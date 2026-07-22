import { AGENT_LIVE_INPUT_MAX_MESSAGES } from "@mono-agent/agent-contracts";

/** Version of the browser-facing JSON and SSE contract. */
export const WEB_API_VERSION = 1 as const;

export const WEB_MAX_FILES_PER_TURN = 10;
export const WEB_MAX_TURN_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const WEB_STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const WEB_MAX_STAGED_UPLOAD_BYTES = 256 * 1024 * 1024;
export const WEB_MAX_STAGED_UPLOADS = 100;
export const WEB_MAX_CONCURRENT_UPLOADS = 4;
export const WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES = 64 * 1024 * 1024;
export const WEB_MAX_QUEUED_ATTACHMENT_TURNS = 32;
export const WEB_MAX_TURN_TEXT_CHARACTERS = 200_000;
export const WEB_MAX_LIVE_INPUTS_PER_THREAD = AGENT_LIVE_INPUT_MAX_MESSAGES;

export type WebAgentStatus = "online" | "offline" | "degraded";
export type WebNotificationTriggerKind = "cron" | "webhook";

export interface WebThreadTrigger {
  readonly kind: WebNotificationTriggerKind;
}

export interface WebModelOption {
  readonly effortLevels?: readonly string[];
  readonly reasoning?: boolean;
  readonly reasoningMode?: string;
  readonly label?: string;
  readonly contextWindow?: number;
}

export interface WebAgentSummary {
  readonly sourceId: string;
  readonly label: string;
  readonly status: WebAgentStatus;
  readonly pinned?: boolean;
  readonly health?: string;
  readonly supportsAttachments: boolean;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly string[];
  readonly modelOptions?: Readonly<Record<string, WebModelOption>>;
  readonly updatedAt: string;
}

export type WebRunStatus =
  | "idle"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WebRunState {
  readonly id?: string;
  readonly status: WebRunStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly model?: string;
  readonly effort?: string;
}

export interface WebThread {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly trigger?: WebThreadTrigger;
  readonly lastMessagePreview?: string;
  readonly messageCount: number;
  readonly runState: WebRunState;
  readonly canSend: boolean;
  readonly canUpload: boolean;
}

export type WebMessageStatus = "running" | "complete" | "failed" | "cancelled" | "interrupted";

export type WebMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly status: "running" | "complete" | "failed";
    }
  | { readonly type: "telemetry"; readonly event: string; readonly data?: unknown }
  | { readonly type: "error"; readonly code?: string; readonly message: string };

export interface WebAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "document";
  readonly status: "staged" | "committed";
  readonly uploaded: boolean;
  readonly createdAt: string;
  readonly contentUrl?: string;
}

export interface WebMessage {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly quote?: WebQuote;
  readonly parts: readonly WebMessagePart[];
  readonly attachments: readonly WebAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: WebMessageStatus;
  readonly liveInputStatus?: "pending" | "applied" | "queued" | "cancelled";
}

export interface WebQuote {
  readonly text: string;
  readonly messageId: string;
}

export interface WebThreadDetail {
  readonly thread: WebThread;
  readonly messages: readonly WebMessage[];
}

export interface WebBootstrap {
  readonly version: typeof WEB_API_VERSION;
  readonly agents: readonly WebAgentSummary[];
  readonly threads: readonly WebThread[];
  readonly currentThreadId?: string;
  readonly limits: {
    readonly maxFileBytes: number;
    readonly maxFilesPerTurn: number;
    readonly maxTurnBytes: number;
    readonly accept: readonly string[];
  };
}

export type WebEventType =
  | "ready"
  | "agents.changed"
  | "threads.changed"
  | "thread.changed"
  | "message.changed"
  | "turn.changed"
  | "attachment.changed";

export interface WebEvent {
  readonly id: string;
  readonly version: typeof WEB_API_VERSION;
  readonly type: WebEventType;
  readonly at: string;
  readonly threadId?: string;
  readonly payload?: unknown;
}

export interface CreateWebThreadInput {
  readonly sourceId: string;
}

export interface PatchWebAgentInput {
  readonly pinned: boolean;
}

export interface PatchWebThreadInput {
  readonly title?: string;
  readonly archived?: boolean;
}

export interface StartWebTurnInput {
  readonly text?: string;
  readonly quote?: WebQuote;
  readonly attachmentIds?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
}

export interface StartWebLiveInputInput {
  readonly text: string;
}

export interface WebLiveInputReceipt {
  readonly message: WebMessage;
  readonly disposition: "pending" | "queued";
}

export interface CreateWebUploadInput {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes?: number;
}
