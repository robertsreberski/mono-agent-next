import type {
  AgentInteractionHandler,
  ApprovalDecision,
  ArtifactRef,
  ChannelAttachment,
  ChannelDeliveryResult,
  ChannelModuleDefinition,
  ChannelOutboundMessage,
  JsonSchema,
  JsonObject,
  JsonValue,
  MemoryModuleDefinition,
  ModuleDiagnostic,
  RouteIdentity,
  RuntimeNativeToolEffect,
  RuntimeModuleDefinition,
  RuntimeRetryability,
  RuntimeSideEffectStatus,
  TurnMessage,
} from "@mono-agent/module-sdk";

import type { AgentConfigIssue } from "./errors.js";
import type { ProjectMcpConfig } from "./mcp.js";

export type ModuleKind = "runtime" | "channel" | "memory" | "state" | "trigger" | "exporter" | "sandbox";

export interface EnvReference {
  readonly $env: string;
}

export interface SelectedModuleConfig {
  readonly $use: string;
  readonly [key: string]: unknown;
}

export interface AgentIdentityConfig {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly workspace: string;
}

export interface RuntimeRoute {
  readonly runtime: string;
  readonly model: string;
}

export interface AgentPolicyConfig {
  readonly tools: {
    readonly default: "allow" | "deny";
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly approvals: {
    readonly default: "allow" | "ask" | "deny";
    readonly timeoutMs?: number;
  };
  readonly sandbox: { readonly mode: "off" } | SelectedModuleConfig;
}

export interface AgentConfig {
  readonly $schema?: string;
  readonly configVersion: 1;
  readonly agent: AgentIdentityConfig;
  readonly runtimes: Readonly<Record<string, SelectedModuleConfig>>;
  readonly routing: {
    readonly primary: RuntimeRoute;
    readonly fallbacks: readonly RuntimeRoute[];
    readonly effort?: string;
  };
  readonly session?: {
    readonly mode: "continuous" | "per-message";
    readonly idleTimeoutMs?: number;
    readonly rollover?: "none" | "daily";
    readonly timezone?: string;
    readonly isolateProactiveRuns?: boolean;
  };
  readonly context?: {
    readonly skills?: {
      readonly roots: readonly string[];
      readonly load?: "all";
      readonly disclosure?: "full" | "index";
      readonly maxBytes?: number;
    };
    readonly mcp?: {
      readonly configPath: string;
    };
  };
  readonly channels?: Readonly<Record<string, SelectedModuleConfig>>;
  readonly memory?: SelectedModuleConfig;
  readonly state?: SelectedModuleConfig;
  readonly triggers?: Readonly<Record<string, SelectedModuleConfig>>;
  readonly observability?: {
    readonly exporters?: Readonly<Record<string, SelectedModuleConfig>>;
  };
  readonly policy: AgentPolicyConfig;
}

export interface ResolvedAgentPaths {
  readonly schema?: string;
  readonly instructions: string;
  readonly workspace: string;
  readonly skillRoots: readonly string[];
  readonly mcpConfig?: string;
}

export interface LoadedAuthoritySource {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly device: string;
  readonly inode: string;
  readonly modifiedAtNs: string;
}

export type SupportedModuleDefinition = RuntimeModuleDefinition | ChannelModuleDefinition | MemoryModuleDefinition;

export interface LoadedAgentModule {
  readonly slot: ModuleKind;
  readonly instanceId: string;
  readonly configPath: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly packageEntry: string;
  readonly definition: SupportedModuleDefinition | GenericModuleDefinition;
}

export interface GenericModuleDefinition {
  readonly manifest: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly apiVersion: 1;
    readonly kind: ModuleKind;
    readonly responsibility: string;
    readonly capabilities: readonly string[];
  };
  readonly schema: {
    readonly jsonSchema: Readonly<Record<string, unknown>>;
    parse(input: unknown): unknown;
  };
  create(context: unknown): unknown | Promise<unknown>;
}

export interface LoadedAgentConfig {
  readonly configPath: string;
  readonly configDirectory: string;
  readonly projectRoot: string;
  readonly raw: AgentConfig;
  readonly paths: ResolvedAgentPaths;
  readonly sources: {
    readonly config: LoadedAuthoritySource;
    readonly mcp?: LoadedAuthoritySource;
  };
  readonly mcp: ProjectMcpConfig;
  readonly modules: readonly LoadedAgentModule[];
}

export interface AgentLoadOptions {
  readonly projectRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface AgentValidationResult {
  readonly ok: boolean;
  readonly issues: readonly AgentConfigIssue[];
  readonly loaded?: LoadedAgentConfig;
}

export interface ConfigExplanationEntry {
  readonly path: string;
  readonly owner: string;
  readonly schemaPointer: string;
  readonly source: "config" | "environment" | "default";
  readonly value?: JsonValue;
  readonly env?: string;
  readonly redacted: boolean;
  readonly remediation: string;
}

export interface AgentConfigExplanation {
  readonly configPath: string;
  readonly entries: readonly ConfigExplanationEntry[];
}

export interface AgentInspection {
  readonly agent: AgentIdentityConfig;
  readonly configPath: string;
  readonly projectRoot: string;
  readonly paths: ResolvedAgentPaths;
  readonly modules: readonly {
    readonly slot: ModuleKind;
    readonly instanceId: string;
    readonly packageName: string;
    readonly packageVersion: string;
    readonly apiVersion: 1;
    readonly kind: ModuleKind;
  }[];
  readonly routing: AgentConfig["routing"];
  readonly mcpServers: readonly string[];
}

export interface AgentSubmitInput {
  /** Stable idempotency identity; Core generates a unique identity when omitted. */
  readonly requestId?: string;
  readonly conversationId: string;
  readonly text: string;
  readonly attachments?: readonly ChannelAttachment[];
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly maxOutputTokens?: number;
  readonly responseSchema?: JsonSchema;
  readonly interactionHandler?: AgentInteractionHandler;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly requiredCapabilities?: readonly string[];
  readonly toolPolicy?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

export interface AgentResponse {
  readonly requestId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly runtime: string;
  readonly model: string;
  readonly status: "completed" | "cancelled" | "max-turns";
  readonly text: string;
  /**
   * Detached public assistant projection. Binary parts, tool internals, and
   * provider-private session state are available only through their owning
   * durable boundaries; `text` remains the compatibility projection.
   */
  readonly message?: AgentResponseMessage;
  /** Safe provider-neutral result projection; it never includes a session. */
  readonly output: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Text-only, detached assistant message safe to cache and expose publicly. */
export interface AgentResponseMessage {
  readonly id?: string;
  readonly role: "assistant";
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
  readonly name?: string;
  readonly createdAt?: string;
}

/**
 * The only durable message content exposed by Core's canonical transcript.
 * Attachment and generated-file bytes are represented by immutable state
 * artifacts, never copied into run or transcript records.
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

/**
 * Compact interaction evidence. It intentionally excludes question prompts,
 * answers, approval summaries/reasons, and live-input text.
 */
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

/**
 * Provider-neutral evidence for one route attempt. Failure evidence is a
 * bounded code and safety classification, never a raw provider error or stack.
 */
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

/**
 * One canonical, settled transcript entry. Runtime tool arguments/results and
 * provider-private session metadata belong to run-private state, not replay.
 */
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
      /**
       * Bounded user-visible question/answer text retained for neutral replay.
       * The compact run event projection exposes only `evidence`.
       */
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

/** A safe, chronological event projection for programmatic run inspection. */
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

/** A fixed-size newest-first page. `nextCursor` is opaque to callers. */
export interface AgentRunHistoryPage {
  readonly runs: readonly AgentRunSummary[];
  readonly nextCursor?: string;
}

export interface AgentRunRecord {
  readonly summary: AgentRunSummary;
  readonly events: readonly AgentRunEvent[];
  /** Canonical entries owned by this run, not the whole conversation. */
  readonly transcript: readonly AgentTranscriptEntry[];
}

export interface AgentConversationSummary {
  readonly id: string;
  readonly updatedAt: string;
  readonly active: boolean;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export interface AgentConversationReplay {
  readonly conversationId: string;
  readonly messages: readonly TurnMessage[];
  readonly activeTurnId?: string;
}

export interface AgentLiveInput {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
}

export type AgentLiveInputStatus = "applied" | "requeue" | "discarded" | "unavailable";

export interface AgentAskAnswer {
  readonly interactionId: string;
  readonly answers: Readonly<Record<string, readonly string[]>>;
}

export type AgentAskAnswerStatus = "accepted" | "expired" | "mismatch";

export type AgentApprovalAnswer = ApprovalDecision;

export type AgentApprovalAnswerStatus = "accepted" | "expired" | "mismatch";

export interface AgentConfigView {
  readonly revision: string;
  readonly generatedAt: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly redacted: true;
}

export interface AgentModuleCommandResult {
  readonly module: string;
  readonly command: string;
  readonly value?: JsonValue;
}

export interface AgentModuleDiagnostics {
  readonly kind: ModuleKind;
  readonly instanceId: string;
  readonly diagnostics: readonly ModuleDiagnostic[];
}

export interface AgentHealth {
  readonly status: "healthy" | "degraded" | "stopping" | "stopped";
  readonly accepting: boolean;
  readonly pending: number;
  readonly active: number;
  readonly modules: readonly {
    readonly kind: ModuleKind;
    readonly instanceId: string;
    readonly status: string;
    readonly detail?: JsonValue;
  }[];
}

export interface AgentHostStartInfo {
  readonly agentId: string;
  readonly configPath: string;
  readonly projectRoot: string;
  readonly channels: readonly {
    readonly instanceId: string;
    readonly kind: "channel";
    readonly endpoint?: string;
  }[];
}

export interface AgentHost {
  readonly config: LoadedAgentConfig;
  readonly startInfo: AgentHostStartInfo;
  start(): Promise<void>;
  submit(input: AgentSubmitInput): Promise<AgentResponse>;
  cancel(conversationId: string, reason?: string): Promise<boolean>;
  offerLiveInput(conversationId: string, input: AgentLiveInput): Promise<AgentLiveInputStatus>;
  answerAsk(conversationId: string, answer: AgentAskAnswer): Promise<AgentAskAnswerStatus>;
  answerApproval(
    conversationId: string,
    decision: AgentApprovalAnswer,
  ): Promise<AgentApprovalAnswerStatus>;
  conversations(): Promise<readonly AgentConversationSummary[]>;
  replay(conversationId: string): Promise<AgentConversationReplay>;
  listRuns(cursor?: string): Promise<AgentRunHistoryPage>;
  readRun(runId: string): Promise<AgentRunRecord | undefined>;
  configView(): Promise<AgentConfigView>;
  deliver(channelInstanceId: string, message: ChannelOutboundMessage): Promise<ChannelDeliveryResult>;
  runModuleCommand(moduleInstanceId: string, commandName: string, input?: unknown): Promise<AgentModuleCommandResult>;
  diagnostics(verbose?: boolean): Promise<readonly AgentModuleDiagnostics[]>;
  health(): Promise<AgentHealth>;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentHostOptions extends AgentLoadOptions {
  readonly maxConcurrentTurns?: number;
  readonly maxPendingTurns?: number;
  readonly drainTimeoutMs?: number;
  readonly lifecycleTimeoutMs?: number;
}
