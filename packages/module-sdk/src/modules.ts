// SPDX-License-Identifier: MIT
import type { Awaitable, ConfigPath, ConfigProvenanceMap, JsonObject, JsonSchema, JsonValue, ModuleCapability, ModuleManifest, ModuleSchema } from "./config.js";
import type { ApprovalDecision, ApprovalRequest, ArtifactRef, AskUserAnswer, AskUserRequest, NormalizedAttachment, RouteIdentity, RuntimeNativeToolDescriptor, RuntimeNativeToolEffect } from "./interactions.js";
export type ModuleLogFields = Readonly<Record<string, unknown>>;
export interface ModuleLogger {
  debug(message: string, fields?: ModuleLogFields): void; info(message: string, fields?: ModuleLogFields): void;
  warn(message: string, fields?: ModuleLogFields): void; error(message: string, fields?: ModuleLogFields): void;
}
/** Host grants are bounded to names declared in the module manifest. */
export interface ModuleHost {
  readonly grantedCapabilities: ReadonlySet<ModuleCapability>;
  getCapability<T = unknown>(name: ModuleCapability): T | undefined;
}
export interface ModuleCreateContext<TConfig, THost extends ModuleHost = ModuleHost> {
  readonly instanceId: string; readonly config: TConfig; readonly provenance: ConfigProvenanceMap;
  /** Absolute directory containing the loaded agent configuration. */
  readonly configDirectory: string;
  readonly workspaceDirectory: string; readonly dataDirectory: string; readonly logger: ModuleLogger;
  readonly host: THost; readonly signal: AbortSignal;
}
export interface ModuleStartContext { readonly signal: AbortSignal; }
export interface ModuleDrainContext { readonly signal: AbortSignal; readonly deadline?: string; }
export type ModuleStopReason = "shutdown" | "restart" | "startup-failed" | "health-failed";
export interface ModuleStopContext { readonly signal: AbortSignal; readonly reason: ModuleStopReason; }
export type ModuleHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
export interface ModuleHealth {
  readonly status: ModuleHealthStatus; readonly checkedAt: string; readonly summary?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}
export interface ModuleHealthContext { readonly signal: AbortSignal; }
export type ModuleDiagnosticSeverity = "info" | "warning" | "error";
export interface ModuleDiagnostic {
  readonly code: string; readonly severity: ModuleDiagnosticSeverity; readonly message: string;
  readonly path?: ConfigPath; readonly hint?: string;
}
export interface ModuleDiagnosticsContext { readonly signal: AbortSignal; readonly verbose: boolean; }
export type ModuleCommandKind = "authentication" | "maintenance";
export interface ModuleCommandContext { readonly signal: AbortSignal; readonly logger: ModuleLogger; }
export interface ModuleCommand {
  /** A stable, package-namespaced command such as `pi:auth`. */
  readonly name: string; readonly kind: ModuleCommandKind; readonly description: string;
  readonly inputSchema?: JsonSchema;
  run(input: unknown, context: ModuleCommandContext): Awaitable<JsonValue | undefined>;
}
export interface ModuleInstance {
  readonly commands?: readonly ModuleCommand[];
  /** Static model-tool descriptors owned by this exact selected instance; Core snapshots, names, governs, and binds them before exposing a turn. */
  readonly toolContributions?: readonly ModuleToolContribution[];
  start?(context: ModuleStartContext): Awaitable<void>; drain?(context: ModuleDrainContext): Awaitable<void>;
  stop?(context: ModuleStopContext): Awaitable<void>;
  health?(context: ModuleHealthContext): Awaitable<ModuleHealth>;
  diagnostics?(context: ModuleDiagnosticsContext): Awaitable<readonly ModuleDiagnostic[]>;
}
export interface TurnTextPart { readonly type: "text"; readonly text: string; }
export interface TurnImagePart {
  readonly type: "image"; readonly mediaType: string; readonly data: Uint8Array | string; readonly name?: string;
}
export interface TurnFilePart {
  readonly type: "file"; readonly mediaType: string; readonly data: Uint8Array | string; readonly name: string;
}
export interface TurnAttachmentPart { readonly type: "attachment"; readonly attachment: NormalizedAttachment; }
export interface RuntimeToolCall { readonly id: string; readonly name: string; readonly input: JsonValue; }
export interface RuntimeToolResultTextPart { readonly type: "text"; readonly text: string; }
export interface RuntimeToolResultJsonPart { readonly type: "json"; readonly value: JsonValue; }
export interface RuntimeToolResultFilePart {
  readonly type: "file"; readonly mediaType: string; readonly data: Uint8Array | string; readonly name?: string;
}
export interface RuntimeToolResultArtifactPart {
  readonly type: "artifact"; readonly ref: ArtifactRef; readonly preview?: string;
}
export type RuntimeToolResultPart =
  | RuntimeToolResultTextPart | RuntimeToolResultJsonPart
  | RuntimeToolResultFilePart | RuntimeToolResultArtifactPart;
export interface RuntimeToolResult {
  readonly callId: string; readonly content: readonly RuntimeToolResultPart[]; readonly isError?: boolean;
}
export interface TurnToolCallPart { readonly type: "tool-call"; readonly call: RuntimeToolCall; }
export interface TurnToolResultPart { readonly type: "tool-result"; readonly result: RuntimeToolResult; }
export type TurnContentPart =
  | TurnTextPart | TurnImagePart | TurnFilePart
  | TurnAttachmentPart | TurnToolCallPart | TurnToolResultPart;
export type TurnRole = "system" | "user" | "assistant" | "tool";
export interface TurnMessage {
  readonly id?: string; readonly role: TurnRole; readonly content: readonly TurnContentPart[];
  readonly name?: string; readonly createdAt?: string;
}
export interface RuntimeToolDefinition {
  readonly name: string; readonly description: string; readonly inputSchema: JsonSchema;
}
/** Shared hard bounds for one selected instance's static tool descriptors. */
export const MODULE_TOOL_LIMITS = Object.freeze({
  perInstance: 64, total: 256, nameCharacters: 64,
  descriptionBytes: 16 * 1_024, inputSchemaBytes: 64 * 1_024,
  inputSchemaDepth: 32, inputSchemaItems: 10_000,
} as const);
export interface ModuleToolTurnContext {
  readonly conversationId: string; readonly runId: string; readonly requestId?: string;
  /** Revoked when the logical turn settles, even if a runtime retained the binding. */
  readonly signal: AbortSignal;
}
export interface ModuleToolCallContext {
  readonly callId: string;
  /** Composes the turn, runtime-call, cancellation, and Core deadline signals. */
  readonly signal: AbortSignal;
}
export interface ModuleToolBinding { execute(input: JsonValue, context: ModuleToolCallContext): Awaitable<unknown>; }
/** A selected module's governed model tool, synchronously bound to one turn. */
export interface ModuleToolContribution extends RuntimeToolDefinition {
  readonly effects: readonly RuntimeNativeToolEffect[]; bind(context: ModuleToolTurnContext): ModuleToolBinding;
}
export interface RuntimeSession {
  /** Runtime-owned opaque identifier of at most 512 UTF-8 bytes. */ readonly id: string;
  /** Canonical conversation whose provider-native continuation this is. */
  readonly conversationId: string;
  /** Exact runtime instance and model route that created this private session. */
  readonly route: RouteIdentity;
  readonly createdAt?: string; readonly expiresAt?: string; readonly metadata?: JsonObject;
}
export interface RuntimeTurnOptions {
  readonly effort?: string; readonly maxTurns?: number; readonly maxOutputTokens?: number;
  readonly responseSchema?: JsonSchema;
}
export interface RuntimeTurnRequest {
  readonly turnId: string; readonly conversationId: string; readonly model: string;
  readonly messages: readonly TurnMessage[]; readonly tools: readonly RuntimeToolDefinition[];
  readonly signal: AbortSignal; readonly session?: RuntimeSession; readonly options?: RuntimeTurnOptions;
  readonly metadata?: JsonObject;
}
export interface RuntimeUsage {
  readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number;
  readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly reasoningTokens?: number;
  readonly contextWindow?: number; readonly contextUsed?: number; readonly cost?: RuntimeUsageCost;
  readonly compaction?: RuntimeCompaction; readonly sessionEvicted?: boolean;
}
export interface RuntimeUsageCost {
  readonly currency: "USD"; readonly input?: number; readonly output?: number;
  readonly cacheRead?: number; readonly cacheWrite?: number; readonly total: number;
}
export interface RuntimeCompaction {
  readonly compacted: boolean; readonly tokensBefore?: number; readonly tokensAfter?: number;
  readonly summaryTokens?: number; readonly firstRetainedMessageId?: string;
}
export interface RuntimeTextDeltaEvent { readonly type: "text-delta"; readonly delta: string; }
export interface RuntimeThinkingDeltaEvent { readonly type: "thinking-delta"; readonly delta: string; }
/** Bounded transient progress that is not assistant-authored conversation text. */
export interface RuntimeActivityEvent { readonly type: "activity"; readonly text: string; }
export interface RuntimeToolCallEvent { readonly type: "tool-call"; readonly call: RuntimeToolCall; }
export interface RuntimeToolResultEvent { readonly type: "tool-result"; readonly result: RuntimeToolResult; }
export interface RuntimeUsageEvent { readonly type: "usage"; readonly usage: RuntimeUsage; }
export interface RuntimeDiagnosticEvent { readonly type: "diagnostic"; readonly diagnostic: ModuleDiagnostic; }
export interface RuntimeSessionEvent { readonly type: "session"; readonly session: RuntimeSession; }
export interface RuntimeCompactionEvent { readonly type: "compaction"; readonly compaction: RuntimeCompaction; }
export type RuntimeTurnEvent =
  | RuntimeTextDeltaEvent
  | RuntimeThinkingDeltaEvent
  | RuntimeActivityEvent
  | RuntimeToolCallEvent
  | RuntimeToolResultEvent
  | RuntimeUsageEvent
  | RuntimeDiagnosticEvent
  | RuntimeSessionEvent
  | RuntimeCompactionEvent;
export interface RuntimeLiveInput { readonly id: string; readonly text: string; readonly receivedAt: string; }
export type RuntimeLiveInputDisposition = "applied" | "requeue" | "discarded";
export type RuntimeLiveInputHandler = (
  input: RuntimeLiveInput, signal: AbortSignal,
) => Awaitable<RuntimeLiveInputDisposition>;
export interface RuntimeTurnContext {
  emit(event: RuntimeTurnEvent): Awaitable<void>;
  executeTool(call: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolResult>;
  /** Bind steering to this exact active attempt; unregister before it settles. */
  registerLiveInput?(handler: RuntimeLiveInputHandler): () => void;
  /** Run one provider-neutral blocking human interaction through Core. */
  askUser?(request: AskUserRequest, signal: AbortSignal): Promise<AskUserAnswer>;
  /**
   * Authorize one provider/native invocation through Core. A
   * `core-callback` runtime must call this before every advertised native-tool
   * effect; Core may answer immediately from policy or block on an interaction.
   * This callback is absent unless the exact route advertises at least one
   * `core-callback` descriptor, and every request must match one exactly.
   */
  requestApproval?(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}
export interface RuntimeCompletedTurnResult {
  readonly status: "completed";
  readonly message: TurnMessage;
  readonly structuredOutput?: JsonValue;
  readonly usage?: RuntimeUsage;
  readonly session?: RuntimeSession;
  readonly metadata?: JsonObject;
}
export interface RuntimeIncompleteTurnResult {
  readonly status: "cancelled" | "max-turns";
  readonly message?: TurnMessage;
  readonly usage?: RuntimeUsage;
  readonly session?: RuntimeSession;
  readonly metadata?: JsonObject;
}
export type RuntimeTurnResult = RuntimeCompletedTurnResult | RuntimeIncompleteTurnResult;
export type RuntimeRetryability = "retryable" | "not-retryable" | "unknown";
export type RuntimeSideEffectStatus = "none" | "committed" | "unknown";
/** Exact typed failure code requesting one sessionless retry on the same route. */
export const RUNTIME_SESSION_UNAVAILABLE_CODE = "runtime_session_unavailable";
const RUNTIME_TURN_ERROR_CODE_MAX_CHARS = 256;
const RUNTIME_TURN_ERROR_MESSAGE_MAX_CHARS = 65_536;
export interface RuntimeTurnErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly retryability: RuntimeRetryability;
  readonly sideEffects: RuntimeSideEffectStatus;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}
/** Immutable own-data failure classification used for host settlement decisions. */
export interface RuntimeTurnErrorSnapshot {
  readonly code: string;
  readonly message: string;
  readonly retryability: RuntimeRetryability;
  readonly sideEffects: RuntimeSideEffectStatus;
  readonly retryAfterMs?: number;
}
/** A runtime failure whose fallback safety can be decided without string matching. */
export class RuntimeTurnError extends Error {
  readonly code: string;
  readonly retryability: RuntimeRetryability;
  readonly sideEffects: RuntimeSideEffectStatus;
  readonly retryAfterMs?: number;
  constructor(options: RuntimeTurnErrorOptions) {
    if (options.code.trim().length === 0) throw new TypeError("Runtime turn error code must not be empty");
    if (!isRuntimeErrorCode(options.code)) {
      throw new RangeError("Runtime turn error code exceeds its character limit");
    }
    if (options.message.length > RUNTIME_TURN_ERROR_MESSAGE_MAX_CHARS) {
      throw new RangeError("Runtime turn error message exceeds its character limit");
    }
    if (!isRuntimeRetryability(options.retryability)) {
      throw new TypeError("Runtime turn error retryability is invalid");
    }
    if (!isRuntimeSideEffectStatus(options.sideEffects)) {
      throw new TypeError("Runtime turn error side-effects status is invalid");
    }
    if (!isRuntimeRetryAfterMs(options.retryAfterMs)) {
      throw new RangeError("Runtime turn error retryAfterMs must be a non-negative safe integer");
    }
    if (options.cause === undefined) super(options.message);
    else super(options.message, { cause: options.cause });
    this.name = "RuntimeTurnError";
    this.code = options.code;
    this.retryability = options.retryability;
    this.sideEffects = options.sideEffects;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}
function ownDescriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}
/** Capture a frozen compatible failure from own data only; accessors and inherited claims fail closed. */
export function snapshotRuntimeTurnError(
  value: unknown,
): RuntimeTurnErrorSnapshot | undefined {
  try {
    if (!(value instanceof Error)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const code = ownDescriptorValue(descriptors.code);
    const message = ownDescriptorValue(descriptors.message);
    const retryability = ownDescriptorValue(descriptors.retryability);
    const sideEffects = ownDescriptorValue(descriptors.sideEffects);
    const retryAfterDescriptor = descriptors.retryAfterMs;
    if (retryAfterDescriptor !== undefined && !("value" in retryAfterDescriptor)) {
      return undefined;
    }
    const retryAfterMs = retryAfterDescriptor?.value;
    if (!isRuntimeErrorCode(code) || typeof message !== "string"
      || !isRuntimeRetryability(retryability) || !isRuntimeSideEffectStatus(sideEffects)
      || !isRuntimeRetryAfterMs(retryAfterMs)) {
      return undefined;
    }
    return Object.freeze({
      code,
      message: message.slice(0, RUNTIME_TURN_ERROR_MESSAGE_MAX_CHARS),
      retryability,
      sideEffects,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  } catch {
    return undefined;
  }
}
export function isRuntimeTurnError(value: unknown): value is RuntimeTurnError {
  return snapshotRuntimeTurnError(value) !== undefined;
}
export interface RuntimeModelValidationRequest {
  readonly model: string;
  /** Parsed module config supplied without granting host capabilities. */
  readonly config: unknown;
}
/** Exact runtime-verified route metadata; absent fields are not advertised. */
export interface RuntimeModelDescriptor {
  /** Human-facing name. Absent means renderers show the raw model id. */
  readonly label?: string;
  /**
   * The exact effort levels this model accepts, in presentation order. Absent
   * means effort is not selectable on this route; empty is not permitted.
   */
  readonly efforts?: readonly string[];
  /** Advertised context window in tokens. */
  readonly contextWindow?: number;
}
export interface RuntimeModelValidation {
  readonly supported: boolean;
  /** Effective capabilities for this exact model route. */
  readonly capabilities?: RuntimeCapabilities;
  /** Native tools available on this exact model route. */
  readonly nativeTools?: readonly RuntimeNativeToolDescriptor[];
  /** Catalog metadata for this exact model route. */
  readonly model?: RuntimeModelDescriptor;
  readonly diagnostics?: readonly ModuleDiagnostic[];
}
export interface RuntimeModelPreflightRequest { readonly model: string; readonly signal: AbortSignal; }
export interface RuntimeModelPreflightResult {
  readonly supported: boolean;
  readonly capabilities?: RuntimeCapabilities;
  readonly nativeTools?: readonly RuntimeNativeToolDescriptor[];
  readonly model?: RuntimeModelDescriptor;
  readonly diagnostics?: readonly ModuleDiagnostic[];
}
export interface RuntimeCapabilities {
  readonly tools: boolean;
  readonly mcp: boolean;
  readonly attachments: boolean;
  readonly approvals: boolean;
  readonly structuredOutput: boolean;
  readonly sandbox: boolean;
  readonly sessions: boolean;
  /** Absent means the runtime cannot honestly enforce a per-run turn ceiling. */
  readonly maxTurns?: boolean;
  /** Absent means the runtime cannot honestly enforce a per-request output-token ceiling. */
  readonly maxOutputTokens?: boolean;
  /** Absent means artifact-backed tool results are unsupported by an API-version-1 runtime. */
  readonly artifactResults?: boolean;
  /** Absent means unsupported for API-version-1 source compatibility. */
  readonly liveInput?: boolean;
}
export interface Runtime extends ModuleInstance {
  readonly capabilities: RuntimeCapabilities;
  /**
   * @deprecated Define the pure validator on `RuntimeModuleDefinition` and use
   * `preflightModel` for created-instance auth or liveness checks.
   */
  validateModel?(model: string, signal: AbortSignal): Awaitable<RuntimeModelValidation>;
  preflightModel?(request: RuntimeModelPreflightRequest): Awaitable<RuntimeModelPreflightResult>;
  runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult>;
}
export type RuntimeHost = ModuleHost;
export type RuntimeModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, RuntimeHost>;
export interface RuntimeModuleDefinition<TConfig = unknown, TInstance extends Runtime = Runtime> {
  readonly manifest: ModuleManifest<"runtime">;
  readonly schema: ModuleSchema<TConfig>;
  /**
   * Pure, synchronous route validation. It must not inspect credentials, read
   * files, access the network, or spawn a process.
   */
  validateModel?(request: RuntimeModelValidationRequest): RuntimeModelValidation;
  create(context: RuntimeModuleCreateContext<TConfig>): Awaitable<TInstance>;
}
export interface ChannelAttachment extends NormalizedAttachment {}
export interface ChannelActor { readonly id: string; readonly displayName?: string; }
export interface ChannelCompletionDelivery { readonly channel: string; readonly destination?: string; }
export interface ChannelInboundRequest {
  readonly requestId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly sender: ChannelActor;
  readonly text: string;
  readonly attachments: readonly ChannelAttachment[];
  readonly receivedAt: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly completionDelivery?: ChannelCompletionDelivery;
  readonly signal: AbortSignal;
  readonly metadata?: JsonObject;
}
export interface ChannelReplyTextDeltaEvent { readonly type: "text-delta"; readonly delta: string; }
export interface ChannelReplyThinkingDeltaEvent { readonly type: "thinking-delta"; readonly delta: string; }
export interface ChannelReplyTextReplaceEvent { readonly type: "text-replace"; readonly text: string; }
export interface ChannelReplyActivityEvent { readonly type: "activity"; readonly text: string; }
export interface ChannelReplyAttachmentEvent { readonly type: "attachment"; readonly attachment: ChannelAttachment; }
export interface ChannelReplyAskUserEvent { readonly type: "ask-user"; readonly ask: AskUserRequest; }
export interface ChannelReplyApprovalEvent { readonly type: "approval"; readonly approval: ApprovalRequest; }
export interface ChannelReplyUsageEvent { readonly type: "usage"; readonly usage: RuntimeUsage; }
export interface ChannelReplyToolCallEvent { readonly type: "tool-call"; readonly call: RuntimeToolCall; }
export interface ChannelReplyToolResultEvent { readonly type: "tool-result"; readonly result: RuntimeToolResult; }
export interface ChannelReplyCompactionEvent { readonly type: "compaction"; readonly compaction: RuntimeCompaction; }
export interface ChannelReplySessionEvictedEvent { readonly type: "session-evicted"; }
export type ChannelReplyEvent =
  | ChannelReplyTextDeltaEvent | ChannelReplyThinkingDeltaEvent
  | ChannelReplyTextReplaceEvent
  | ChannelReplyActivityEvent
  | ChannelReplyAttachmentEvent
  | ChannelReplyAskUserEvent
  | ChannelReplyApprovalEvent
  | ChannelReplyUsageEvent
  | ChannelReplyToolCallEvent
  | ChannelReplyToolResultEvent
  | ChannelReplyCompactionEvent
  | ChannelReplySessionEvictedEvent;
export interface ChannelReplySink { emit(event: ChannelReplyEvent): Awaitable<void>; }
export interface ChannelTurnResult {
  readonly status: "completed" | "cancelled" | "rejected"; readonly text?: string; /** Non-empty, NUL-free, at most 522 UTF-8 bytes. */ readonly messageId?: string;
  readonly diagnostics?: readonly ModuleDiagnostic[];
}
export interface ChannelCancelRequest {
  readonly conversationId: string; readonly reason?: string; readonly signal: AbortSignal;
}
export interface ChannelCancelResult { readonly status: "accepted" | "idle" | "unsupported"; }
export interface ChannelLiveInput extends RuntimeLiveInput {
  readonly conversationId: string; readonly signal: AbortSignal;
}
export interface ChannelLiveInputResult { readonly status: RuntimeLiveInputDisposition | "unavailable"; }
export interface ChannelAskAnswerResult { readonly status: "accepted" | "expired" | "mismatch" | "unsupported"; }
export interface ChannelApprovalAnswerResult { readonly status: "accepted" | "expired" | "mismatch" | "unsupported"; }
export interface ChannelConversationSummary {
  readonly conversationId: string; readonly title?: string; readonly updatedAt: string;
  readonly metadata?: JsonObject;
}
export interface ChannelConversationListRequest {
  readonly cursor?: string; readonly limit: number; readonly signal: AbortSignal;
}
export interface ChannelConversationListResult {
  readonly conversations: readonly ChannelConversationSummary[]; readonly cursor?: string;
}
export interface ChannelReplayRequest {
  readonly conversationId: string; readonly cursor?: string; readonly limit: number;
  readonly signal: AbortSignal;
}
export interface ChannelReplayEntry {
  readonly turnId: string; readonly message: TurnMessage; readonly createdAt: string;
}
export interface ChannelReplayResult {
  readonly entries: readonly ChannelReplayEntry[]; readonly cursor?: string;
}
export interface ChannelOpenConversationRequest {
  readonly title?: string; readonly initialText?: string; readonly metadata?: JsonObject;
  readonly signal: AbortSignal;
}
export interface ChannelOpenConversationResult { readonly conversationId: string; readonly createdAt: string; }
export interface ChannelHost extends ModuleHost {
  dispatch(request: ChannelInboundRequest, reply: ChannelReplySink): Promise<ChannelTurnResult>;
  cancel?(request: ChannelCancelRequest): Promise<ChannelCancelResult>;
  offerLiveInput?(input: ChannelLiveInput): Promise<ChannelLiveInputResult>;
  answerAsk?(
    conversationId: string, answer: AskUserAnswer, signal: AbortSignal,
  ): Promise<ChannelAskAnswerResult>;
  answerApproval?(
    conversationId: string, decision: ApprovalDecision, signal: AbortSignal,
  ): Promise<ChannelApprovalAnswerResult>;
  listConversations?(request: ChannelConversationListRequest): Promise<ChannelConversationListResult>;
  readReplay?(request: ChannelReplayRequest): Promise<ChannelReplayResult>;
  readConfig?(signal: AbortSignal): Promise<JsonValue>;
  readHealth?(signal: AbortSignal): Promise<ModuleHealth>;
  openConversation?(request: ChannelOpenConversationRequest): Promise<ChannelOpenConversationResult>;
}
export interface ChannelOutboundMessage {
  /** A normalized destination of at most 4,096 UTF-8 bytes. Core passes adapters a non-empty value. */
  readonly conversationId: string;
  readonly text: string;
  readonly attachments?: readonly ChannelAttachment[];
  readonly replyToMessageId?: string;
  readonly idempotencyKey: string;
  readonly metadata?: JsonObject;
}
export interface ChannelDeliveryResult {
  readonly status: "delivered" | "duplicate" | "unknown" | "failed";
  readonly idempotencyKey: string;
  /** Transport-owned identifier of at most 512 UTF-8 bytes. */ readonly messageId?: string;
  readonly diagnostic?: ModuleDiagnostic;
}
export interface ChannelCurrentRunOutputRequest {
  /** One safe basename inside the current run's host-owned output directory. */
  readonly name: string;
  /** Adapter-selected byte ceiling. Core applies its own hard ceiling too. */
  readonly maxBytes: number;
}
export interface ChannelSendToolContext {
  readonly requestId: string; readonly conversationId: string; readonly callId: string; readonly signal: AbortSignal;
  /**
   * Read one current-run output as detached attachment bytes. The host retains
   * filesystem authority; adapters and model input never receive a path.
   */
  readonly readCurrentRunOutput?: (
    request: ChannelCurrentRunOutputRequest,
  ) => Promise<ChannelAttachment>;
}
export interface ChannelSendTool extends RuntimeToolDefinition {
  prepare(input: JsonValue, context: ChannelSendToolContext): Awaitable<Omit<ChannelOutboundMessage, "idempotencyKey">>;
}
export interface ChannelCapabilities {
  readonly attachments: boolean;
  readonly liveInput: boolean;
  readonly askUser: boolean;
  /** Absent means unsupported for API-version-1 source compatibility. */
  readonly approvals?: boolean;
  readonly proactive: boolean;
  readonly runtimeControl: boolean;
  readonly verbatim: boolean;
  readonly cancellation: boolean;
}
export interface Channel extends ModuleInstance {
  readonly capabilities: ChannelCapabilities;
  /** Model-visible delivery contributions, bound by Core to this exact selected instance. */
  readonly sendTools?: readonly ChannelSendTool[];
  /** Canonicalize an explicitly requested adapter-owned default before durable delivery admission. */
  resolveDefaultDeliveryConversationId?(): string | undefined;
  /** Resolve the canonical history projection after confirmed delivery. */
  resolveDeliveryHistory?(message: ChannelOutboundMessage, result: ChannelDeliveryResult): {
    /** Canonical destination conversation of at most 4,096 UTF-8 bytes. */ readonly conversationId: string;
  };
  /**
   * Returns a bounded JSON discovery fragment after start. Core combines
   * fragments by top-level key and publishes them through an optional state
   * store; channel modules retain ownership of their protocol-specific shape.
   * Secret values must never be included.
   */
  readHostPresence?(): JsonObject | undefined;
  deliver?(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult>;
}
export type ChannelModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, ChannelHost>;
export interface ChannelModuleDefinition<TConfig = unknown, TInstance extends Channel = Channel> {
  readonly manifest: ModuleManifest<"channel">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: ChannelModuleCreateContext<TConfig>): Awaitable<TInstance>;
}
export interface MemoryRecord {
  readonly id: string; readonly text: string; readonly createdAt: string; readonly metadata?: JsonObject;
}
export interface MemoryRecallRequest {
  readonly query: string; readonly limit: number; readonly signal: AbortSignal;
  readonly conversationId?: string;
}
export interface MemoryRecallResult { readonly records: readonly MemoryRecord[]; }
export interface MemoryCaptureRequest { readonly record: MemoryRecord; readonly signal: AbortSignal; }
export interface MemoryForgetRequest { readonly recordId: string; readonly signal: AbortSignal; }
export interface MemoryCapabilities { readonly capture: boolean; readonly forget: boolean; readonly recallTool?: boolean; }
export const HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE = "memory.runtime-capture" as const;
/** Tool-free, session-free completion surface granted only to selected memory. */
export interface MemoryRuntimeCaptureRequest {
  readonly instructions: string;
  readonly input: string;
  readonly responseSchema?: JsonSchema;
  readonly maxOutputTokens: number;
  /** Exact selected runtime instance; Core never silently substitutes the primary route. */
  readonly runtime: string;
  /** Exact runtime-owned model identifier. */
  readonly model: string;
  /** Independent upper bound enforced by both the memory module and Core. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}
export interface MemoryRuntimeCaptureResult {
  readonly text: string; readonly structuredOutput?: JsonValue; readonly usage?: RuntimeUsage;
}
export interface MemoryRuntimeCaptureGrant {
  complete(request: MemoryRuntimeCaptureRequest): Promise<MemoryRuntimeCaptureResult>;
}
export interface Memory extends ModuleInstance {
  readonly capabilities: MemoryCapabilities;
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  capture?(request: MemoryCaptureRequest): Promise<void>;
  forget?(request: MemoryForgetRequest): Promise<boolean>;
}
export interface MemoryHost extends ModuleHost {
  /** Present only when declared by the module and bound to a validated route. */
  readonly runtimeCapture?: MemoryRuntimeCaptureGrant;
}
export type MemoryModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, MemoryHost>;
export interface MemoryModuleDefinition<TConfig = unknown, TInstance extends Memory = Memory> {
  readonly manifest: ModuleManifest<"memory">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: MemoryModuleCreateContext<TConfig>): Awaitable<TInstance>;
}
export type OpenModuleDefinition =
  | RuntimeModuleDefinition
  | ChannelModuleDefinition
  | MemoryModuleDefinition;
/** The type of a package's public `monoAgentModule` export. */
export type MonoAgentModule = OpenModuleDefinition;
export function defineRuntimeModule<TConfig, TInstance extends Runtime>(
  definition: RuntimeModuleDefinition<TConfig, TInstance>,
): RuntimeModuleDefinition<TConfig, TInstance> { return freezeDefinition(definition); }
export function defineChannelModule<TConfig, TInstance extends Channel>(
  definition: ChannelModuleDefinition<TConfig, TInstance>,
): ChannelModuleDefinition<TConfig, TInstance> { return freezeDefinition(definition); }
export function defineMemoryModule<TConfig, TInstance extends Memory>(
  definition: MemoryModuleDefinition<TConfig, TInstance>,
): MemoryModuleDefinition<TConfig, TInstance> { return freezeDefinition(definition); }
function freezeDefinition<T extends { readonly manifest: ModuleManifest; readonly schema: ModuleSchema<unknown> }>(
  definition: T,
): T {
  const manifest = Object.freeze({
    ...definition.manifest,
    capabilities: Object.freeze([...definition.manifest.capabilities]),
  });
  return Object.freeze({ ...definition, manifest }) as T;
}
function isRuntimeRetryability(value: unknown): value is RuntimeRetryability {
  return value === "retryable" || value === "not-retryable" || value === "unknown";
}
function isRuntimeSideEffectStatus(value: unknown): value is RuntimeSideEffectStatus {
  return value === "none" || value === "committed" || value === "unknown";
}
function isRuntimeErrorCode(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= RUNTIME_TURN_ERROR_CODE_MAX_CHARS;
}
function isRuntimeRetryAfterMs(value: unknown): value is number | undefined {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
