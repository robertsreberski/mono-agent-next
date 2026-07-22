/**
 * Public, Apache-2.0 extension contracts for mono-agent modules.
 *
 * This entrypoint deliberately exposes only the three open module slots:
 * runtime, channel, and memory. First-party reserved slots live at
 * `@mono-agent/module-sdk/internal` until they are promoted through the public
 * architecture process.
 */

export const MODULE_API_VERSION = 1 as const;

export const OPEN_MODULE_KINDS = ["runtime", "channel", "memory"] as const;

export type Awaitable<T> = T | PromiseLike<T>;
export type ModuleApiVersion = typeof MODULE_API_VERSION;
export type ModuleKind = (typeof OPEN_MODULE_KINDS)[number];
export type ModuleCapability = string;
export type ConfigPathSegment = string | number;
export type ConfigPath = readonly ConfigPathSegment[];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;
export type JsonSchema = Readonly<Record<string, unknown>>;

/** JSON Schema annotation consumed by core before a module parser runs. */
export const MODULE_SCHEMA_ENV_ELIGIBLE = "x-mono-agent-env-eligible" as const;

/** JSON Schema annotation that rejects inline literals and redacts explain output. */
export const MODULE_SCHEMA_SECRET = "x-mono-agent-secret" as const;

export interface EnvEligibleSchemaOptions {
  readonly secret?: boolean;
}

/**
 * Marks a scalar schema as eligible for core's `{$env: "NAME"}` directive.
 * Core validates and resolves the wrapper before calling the module parser.
 * Raw references remain only in core-owned provenance and explain data.
 */
export function envEligibleSchema(
  schema: JsonSchema,
  options: EnvEligibleSchemaOptions = {},
): JsonSchema {
  return Object.freeze({
    ...schema,
    [MODULE_SCHEMA_ENV_ELIGIBLE]: true,
    ...(options.secret === true ? { [MODULE_SCHEMA_SECRET]: true } : {}),
  });
}

export function isEnvEligibleSchema(schema: JsonSchema): boolean {
  return schema[MODULE_SCHEMA_ENV_ELIGIBLE] === true;
}

export function isSecretSchema(schema: JsonSchema): boolean {
  return schema[MODULE_SCHEMA_SECRET] === true;
}

export interface ModuleManifest<K extends ModuleKind = ModuleKind> {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly apiVersion: ModuleApiVersion;
  readonly kind: K;
  readonly responsibility: string;
  readonly capabilities: readonly ModuleCapability[];
}

/** An executable schema. Parsing must be deterministic and side-effect-free. */
export interface ModuleSchema<TConfig> {
  readonly jsonSchema: JsonSchema;
  parse(input: unknown): TConfig;
}

export type ModuleConfigSchema<TConfig> = ModuleSchema<TConfig>;

export type ConfigProvenanceSource =
  | "default"
  | "file"
  | "environment"
  | "argument"
  | "generated";

/**
 * Identifies where a value came from without retaining the value itself.
 * `environmentName` is safe to render; the referenced environment value is not.
 */
export interface ConfigProvenance {
  readonly source: ConfigProvenanceSource;
  readonly filePath?: string;
  readonly environmentName?: string;
  readonly description?: string;
}

/** JSON-pointer keys map to the provenance of the value at that path. */
export type ConfigProvenanceMap = Readonly<Record<string, ConfigProvenance>>;

export interface ConfigIssue {
  readonly code: string;
  readonly message: string;
  readonly path: ConfigPath;
  readonly provenance?: ConfigProvenance;
}

export interface ModuleConfigErrorOptions {
  readonly message?: string;
  readonly issues: readonly ConfigIssue[];
  readonly cause?: unknown;
}

export class ModuleConfigError extends Error {
  readonly code = "MODULE_CONFIG_INVALID";
  readonly issues: readonly ConfigIssue[];

  constructor(options: ModuleConfigErrorOptions) {
    const issues = options.issues.map((issue) => freezeConfigIssue(issue));
    const message = options.message ?? issues[0]?.message ?? "Module configuration is invalid";

    if (options.cause === undefined) {
      super(message);
    } else {
      super(message, { cause: options.cause });
    }

    this.name = "ModuleConfigError";
    this.issues = Object.freeze(issues);
  }
}

export interface ParseModuleConfigOptions {
  readonly packageName?: string;
  readonly provenance?: ConfigProvenanceMap;
}

export function isModuleConfigError(value: unknown): value is ModuleConfigError {
  return value instanceof ModuleConfigError;
}

export function defineModuleSchema<TConfig>(schema: ModuleSchema<TConfig>): ModuleSchema<TConfig> {
  return Object.freeze({
    jsonSchema: Object.freeze({ ...schema.jsonSchema }),
    parse: schema.parse,
  });
}

export function defineConfigProvenance(provenance: ConfigProvenance): ConfigProvenance {
  return Object.freeze({ ...provenance });
}

export function configPathToPointer(path: ConfigPath): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => escapeJsonPointerSegment(String(segment))).join("/")}`;
}

export function provenanceAt(
  provenance: ConfigProvenanceMap | undefined,
  path: ConfigPath,
): ConfigProvenance | undefined {
  if (provenance === undefined) return undefined;

  for (let length = path.length; length >= 0; length -= 1) {
    const found = provenance[configPathToPointer(path.slice(0, length))];
    if (found !== undefined) return found;
  }

  return undefined;
}

export function configIssue(
  code: string,
  message: string,
  path: ConfigPath = [],
  provenance?: ConfigProvenance,
): ConfigIssue {
  return freezeConfigIssue({
    code,
    message,
    path,
    ...(provenance === undefined ? {} : { provenance }),
  });
}

export function parseModuleConfig<TConfig>(
  schema: ModuleSchema<TConfig>,
  input: unknown,
  options: ParseModuleConfigOptions = {},
): TConfig {
  try {
    return schema.parse(input);
  } catch (error) {
    if (isModuleConfigError(error)) throw error;

    const prefix = options.packageName === undefined ? "Module" : options.packageName;
    const message = error instanceof Error ? error.message : "Configuration parser rejected the input";
    throw new ModuleConfigError({
      message: `${prefix} configuration is invalid: ${message}`,
      issues: [
        configIssue("invalid_config", message, [], provenanceAt(options.provenance, [])),
      ],
      cause: error,
    });
  }
}

export type ModuleLogFields = Readonly<Record<string, unknown>>;

export interface ModuleLogger {
  debug(message: string, fields?: ModuleLogFields): void;
  info(message: string, fields?: ModuleLogFields): void;
  warn(message: string, fields?: ModuleLogFields): void;
  error(message: string, fields?: ModuleLogFields): void;
}

/** Host grants are bounded to names declared in the module manifest. */
export interface ModuleHost {
  readonly grantedCapabilities: ReadonlySet<ModuleCapability>;
  getCapability<T = unknown>(name: ModuleCapability): T | undefined;
}

export interface ModuleCreateContext<TConfig, THost extends ModuleHost = ModuleHost> {
  readonly instanceId: string;
  readonly config: TConfig;
  readonly provenance: ConfigProvenanceMap;
  /** Absolute directory containing the loaded agent configuration. */
  readonly configDirectory: string;
  readonly workspaceDirectory: string;
  readonly dataDirectory: string;
  readonly logger: ModuleLogger;
  readonly host: THost;
  readonly signal: AbortSignal;
}

export interface ModuleStartContext {
  readonly signal: AbortSignal;
}

export interface ModuleDrainContext {
  readonly signal: AbortSignal;
  readonly deadline?: string;
}

export type ModuleStopReason = "shutdown" | "restart" | "startup-failed" | "health-failed";

export interface ModuleStopContext {
  readonly signal: AbortSignal;
  readonly reason: ModuleStopReason;
}

export type ModuleHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ModuleHealth {
  readonly status: ModuleHealthStatus;
  readonly checkedAt: string;
  readonly summary?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface ModuleHealthContext {
  readonly signal: AbortSignal;
}

export type ModuleDiagnosticSeverity = "info" | "warning" | "error";

export interface ModuleDiagnostic {
  readonly code: string;
  readonly severity: ModuleDiagnosticSeverity;
  readonly message: string;
  readonly path?: ConfigPath;
  readonly hint?: string;
}

export interface ModuleDiagnosticsContext {
  readonly signal: AbortSignal;
  readonly verbose: boolean;
}

export type ModuleCommandKind = "authentication" | "maintenance";

export interface ModuleCommandContext {
  readonly signal: AbortSignal;
  readonly logger: ModuleLogger;
}

export interface ModuleCommand {
  /** A stable, package-namespaced command such as `pi:auth`. */
  readonly name: string;
  readonly kind: ModuleCommandKind;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  run(input: unknown, context: ModuleCommandContext): Awaitable<JsonValue | undefined>;
}

export interface ModuleInstance {
  readonly commands?: readonly ModuleCommand[];
  start?(context: ModuleStartContext): Awaitable<void>;
  drain?(context: ModuleDrainContext): Awaitable<void>;
  stop?(context: ModuleStopContext): Awaitable<void>;
  health?(context: ModuleHealthContext): Awaitable<ModuleHealth>;
  diagnostics?(context: ModuleDiagnosticsContext): Awaitable<readonly ModuleDiagnostic[]>;
}

export interface TurnTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface TurnImagePart {
  readonly type: "image";
  readonly mediaType: string;
  readonly data: Uint8Array | string;
  readonly name?: string;
}

export interface TurnFilePart {
  readonly type: "file";
  readonly mediaType: string;
  readonly data: Uint8Array | string;
  readonly name: string;
}

export interface RuntimeToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

export interface RuntimeToolResultTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface RuntimeToolResultJsonPart {
  readonly type: "json";
  readonly value: JsonValue;
}

export interface RuntimeToolResultFilePart {
  readonly type: "file";
  readonly mediaType: string;
  readonly data: Uint8Array | string;
  readonly name?: string;
}

export type RuntimeToolResultPart =
  | RuntimeToolResultTextPart
  | RuntimeToolResultJsonPart
  | RuntimeToolResultFilePart;

export interface RuntimeToolResult {
  readonly callId: string;
  readonly content: readonly RuntimeToolResultPart[];
  readonly isError?: boolean;
}

export interface TurnToolCallPart {
  readonly type: "tool-call";
  readonly call: RuntimeToolCall;
}

export interface TurnToolResultPart {
  readonly type: "tool-result";
  readonly result: RuntimeToolResult;
}

export type TurnContentPart =
  | TurnTextPart
  | TurnImagePart
  | TurnFilePart
  | TurnToolCallPart
  | TurnToolResultPart;

export type TurnRole = "system" | "user" | "assistant" | "tool";

export interface TurnMessage {
  readonly id?: string;
  readonly role: TurnRole;
  readonly content: readonly TurnContentPart[];
  readonly name?: string;
  readonly createdAt?: string;
}

export interface RuntimeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface RuntimeSession {
  /** Runtime-owned opaque identifier. Core must not interpret it. */
  readonly id: string;
  readonly metadata?: JsonObject;
}

export interface RuntimeTurnOptions {
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly responseSchema?: JsonSchema;
}

export interface RuntimeTurnRequest {
  readonly turnId: string;
  readonly conversationId: string;
  readonly model: string;
  readonly messages: readonly TurnMessage[];
  readonly tools: readonly RuntimeToolDefinition[];
  readonly signal: AbortSignal;
  readonly session?: RuntimeSession;
  readonly options?: RuntimeTurnOptions;
  readonly metadata?: JsonObject;
}

export interface RuntimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface RuntimeTextDeltaEvent {
  readonly type: "text-delta";
  readonly delta: string;
}

export interface RuntimeThinkingDeltaEvent {
  readonly type: "thinking-delta";
  readonly delta: string;
}

export interface RuntimeToolCallEvent {
  readonly type: "tool-call";
  readonly call: RuntimeToolCall;
}

export interface RuntimeToolResultEvent {
  readonly type: "tool-result";
  readonly result: RuntimeToolResult;
}

export interface RuntimeUsageEvent {
  readonly type: "usage";
  readonly usage: RuntimeUsage;
}

export interface RuntimeDiagnosticEvent {
  readonly type: "diagnostic";
  readonly diagnostic: ModuleDiagnostic;
}

export interface RuntimeSessionEvent {
  readonly type: "session";
  readonly session: RuntimeSession;
}

export type RuntimeTurnEvent =
  | RuntimeTextDeltaEvent
  | RuntimeThinkingDeltaEvent
  | RuntimeToolCallEvent
  | RuntimeToolResultEvent
  | RuntimeUsageEvent
  | RuntimeDiagnosticEvent
  | RuntimeSessionEvent;

export interface RuntimeTurnContext {
  emit(event: RuntimeTurnEvent): Awaitable<void>;
  executeTool(call: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolResult>;
}

export interface RuntimeCompletedTurnResult {
  readonly status: "completed";
  readonly message: TurnMessage;
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

export interface RuntimeModelValidation {
  readonly supported: boolean;
  /** Effective capabilities for this exact model route. */
  readonly capabilities?: RuntimeCapabilities;
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
}

export interface Runtime extends ModuleInstance {
  readonly capabilities: RuntimeCapabilities;
  validateModel?(model: string, signal: AbortSignal): Awaitable<RuntimeModelValidation>;
  runTurn(request: RuntimeTurnRequest, context: RuntimeTurnContext): Promise<RuntimeTurnResult>;
}

export type RuntimeHost = ModuleHost;
export type RuntimeModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, RuntimeHost>;

export interface RuntimeModuleDefinition<TConfig = unknown, TInstance extends Runtime = Runtime> {
  readonly manifest: ModuleManifest<"runtime">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: RuntimeModuleCreateContext<TConfig>): Awaitable<TInstance>;
}

export interface ChannelAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array | string;
}

export interface ChannelActor {
  readonly id: string;
  readonly displayName?: string;
}

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
  readonly signal: AbortSignal;
  readonly metadata?: JsonObject;
}

export interface ChannelReplyTextDeltaEvent {
  readonly type: "text-delta";
  readonly delta: string;
}

export interface ChannelReplyTextReplaceEvent {
  readonly type: "text-replace";
  readonly text: string;
}

export interface ChannelReplyActivityEvent {
  readonly type: "activity";
  readonly text: string;
}

export interface ChannelReplyAttachmentEvent {
  readonly type: "attachment";
  readonly attachment: ChannelAttachment;
}

export type ChannelReplyEvent =
  | ChannelReplyTextDeltaEvent
  | ChannelReplyTextReplaceEvent
  | ChannelReplyActivityEvent
  | ChannelReplyAttachmentEvent;

export interface ChannelReplySink {
  emit(event: ChannelReplyEvent): Awaitable<void>;
}

export interface ChannelTurnResult {
  readonly status: "completed" | "cancelled" | "rejected";
  readonly text?: string;
  readonly diagnostics?: readonly ModuleDiagnostic[];
}

export interface ChannelHost extends ModuleHost {
  dispatch(request: ChannelInboundRequest, reply: ChannelReplySink): Promise<ChannelTurnResult>;
}

export interface ChannelOutboundMessage {
  readonly conversationId: string;
  readonly text: string;
  readonly attachments?: readonly ChannelAttachment[];
  readonly replyToMessageId?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

export interface ChannelDeliveryResult {
  readonly status: "delivered" | "unknown" | "failed";
  readonly messageId?: string;
  readonly diagnostic?: ModuleDiagnostic;
}

export interface ChannelCapabilities {
  readonly attachments: boolean;
  readonly liveInput: boolean;
  readonly askUser: boolean;
  readonly proactive: boolean;
  readonly runtimeControl: boolean;
  readonly verbatim: boolean;
}

export interface Channel extends ModuleInstance {
  readonly capabilities: ChannelCapabilities;
  deliver?(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult>;
}

export type ChannelModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, ChannelHost>;

export interface ChannelModuleDefinition<TConfig = unknown, TInstance extends Channel = Channel> {
  readonly manifest: ModuleManifest<"channel">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: ChannelModuleCreateContext<TConfig>): Awaitable<TInstance>;
}

export interface MemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly metadata?: JsonObject;
}

export interface MemoryRecallRequest {
  readonly query: string;
  readonly limit: number;
  readonly signal: AbortSignal;
  readonly conversationId?: string;
}

export interface MemoryRecallResult {
  readonly records: readonly MemoryRecord[];
}

export interface MemoryCaptureRequest {
  readonly record: MemoryRecord;
  readonly signal: AbortSignal;
}

export interface MemoryForgetRequest {
  readonly recordId: string;
  readonly signal: AbortSignal;
}

export interface MemoryCapabilities {
  readonly capture: boolean;
  readonly forget: boolean;
}

export interface Memory extends ModuleInstance {
  readonly capabilities: MemoryCapabilities;
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  capture?(request: MemoryCaptureRequest): Promise<void>;
  forget?(request: MemoryForgetRequest): Promise<boolean>;
}

export type MemoryHost = ModuleHost;
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
): RuntimeModuleDefinition<TConfig, TInstance> {
  return freezeDefinition(definition);
}

export function defineChannelModule<TConfig, TInstance extends Channel>(
  definition: ChannelModuleDefinition<TConfig, TInstance>,
): ChannelModuleDefinition<TConfig, TInstance> {
  return freezeDefinition(definition);
}

export function defineMemoryModule<TConfig, TInstance extends Memory>(
  definition: MemoryModuleDefinition<TConfig, TInstance>,
): MemoryModuleDefinition<TConfig, TInstance> {
  return freezeDefinition(definition);
}

function freezeDefinition<T extends { readonly manifest: ModuleManifest; readonly schema: ModuleSchema<unknown> }>(
  definition: T,
): T {
  const manifest = Object.freeze({
    ...definition.manifest,
    capabilities: Object.freeze([...definition.manifest.capabilities]),
  });
  return Object.freeze({ ...definition, manifest }) as T;
}

function freezeConfigIssue(issue: ConfigIssue): ConfigIssue {
  return Object.freeze({
    ...issue,
    path: Object.freeze([...issue.path]),
    ...(issue.provenance === undefined
      ? {}
      : { provenance: defineConfigProvenance(issue.provenance) }),
  });
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
