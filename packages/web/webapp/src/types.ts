export const API_VERSION = 1 as const;

export type AgentStatus = "online" | "offline" | "degraded";
export type NotificationTriggerKind = "cron" | "webhook";
export type RunStatus =
  | "idle"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ModelOption {
  readonly effortLevels?: readonly string[];
  readonly reasoning?: boolean;
  readonly reasoningMode?: string;
  readonly label?: string;
  readonly contextWindow?: number;
}

export interface AskOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface AskQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskOption[];
  readonly multiSelect: boolean;
}

export interface AskAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly customReply?: string;
}

export interface AskSnapshot {
  readonly interactionId: string;
  readonly message?: string;
  readonly questions: readonly AskQuestion[];
  readonly answers: readonly AskAnswer[];
  readonly activeQuestionIndex: number;
  readonly status: "pending" | "answered" | "expired" | "cancelled";
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AskSubmissionResult {
  readonly accepted: boolean;
  readonly code?: "not_found" | "stale" | "invalid_answer";
  readonly snapshot?: AskSnapshot;
}

export interface AgentSummary {
  readonly sourceId: string;
  readonly label: string;
  readonly status: AgentStatus;
  readonly pinned: boolean;
  readonly health?: string;
  readonly supportsAttachments: boolean;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly string[];
  readonly modelOptions?: Readonly<Record<string, ModelOption>>;
  readonly updatedAt: string;
}

export interface RunState {
  readonly id?: string;
  readonly status: RunStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly model?: string;
  readonly effort?: string;
}

export interface ThreadSummary {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly trigger?: { readonly kind: NotificationTriggerKind };
  readonly lastMessagePreview?: string;
  readonly messageCount: number;
  readonly runState: RunState;
  readonly canSend: boolean;
  readonly canUpload: boolean;
}

export type MessagePart =
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
  readonly parts: readonly MessagePart[];
  readonly attachments: readonly WebAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  readonly liveInputStatus?: "pending" | "applied" | "queued" | "cancelled";
}

export interface WebQuote {
  readonly text: string;
  readonly messageId: string;
}

export interface ThreadDetail {
  readonly thread: ThreadSummary;
  readonly messages: readonly WebMessage[];
}

export interface UploadLimits {
  readonly maxFileBytes: number;
  readonly maxFilesPerTurn: number;
  readonly maxTurnBytes: number;
  readonly accept: readonly string[];
}

export interface Bootstrap {
  readonly version: typeof API_VERSION;
  readonly agents: readonly AgentSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly currentThreadId?: string;
  readonly limits: UploadLimits;
}

export interface WebEvent {
  readonly id: string;
  readonly version: typeof API_VERSION;
  readonly type:
    | "ready"
    | "agents.changed"
    | "threads.changed"
    | "thread.changed"
    | "message.changed"
    | "turn.changed"
    | "attachment.changed";
  readonly at: string;
  readonly threadId?: string;
  readonly payload?: unknown;
}

export interface StartTurnInput {
  readonly text?: string;
  readonly quote?: WebQuote;
  readonly attachmentIds?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
}

export interface LiveInputReceipt {
  readonly message: WebMessage;
  readonly disposition: "pending" | "queued";
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerTurn: 10,
  maxTurnBytes: 64 * 1024 * 1024,
  accept: [],
};
