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
export type ModuleSlot = ModuleKind | "state" | "trigger" | "exporter" | "sandbox";
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
/** JSON Schema annotation naming a configured instance in another typed slot. */
export const MODULE_SCHEMA_SLOT_REFERENCE = "x-mono-agent-slot-reference" as const;
export interface EnvEligibleSchemaOptions { readonly secret?: boolean; }
export interface CrossSlotReference { readonly slot: ModuleSlot; readonly capability?: string; }
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
/**
 * Marks a string schema as an instance-id reference into another configured
 * slot. Core validates existence, slot kind, and the optional capability after
 * every selected module schema has been composed.
 */
export function crossSlotReferenceSchema(
  schema: JsonSchema,
  reference: CrossSlotReference,
): JsonSchema {
  if (schema.type !== "string") throw new TypeError("Cross-slot references must annotate a string schema");
  if (!isModuleSlot(reference.slot)) throw new TypeError(`Unknown module slot: ${reference.slot}`);
  if (reference.capability !== undefined && reference.capability.trim().length === 0) {
    throw new TypeError("Cross-slot capability must not be empty");
  }
  return Object.freeze({
    ...schema,
    [MODULE_SCHEMA_SLOT_REFERENCE]: Object.freeze({ ...reference }),
  });
}
export function readCrossSlotReference(schema: JsonSchema): CrossSlotReference | undefined {
  const value = schema[MODULE_SCHEMA_SLOT_REFERENCE];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const slot = Reflect.get(value, "slot");
  const capability = Reflect.get(value, "capability");
  if (!isModuleSlot(slot)) return undefined;
  if (capability !== undefined && (typeof capability !== "string" || capability.trim().length === 0)) {
    return undefined;
  }
  return Object.freeze({ slot, ...(capability === undefined ? {} : { capability }) });
}
export interface ModuleManifest<K extends ModuleKind = ModuleKind> {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly apiVersion: ModuleApiVersion;
  readonly kind: K;
  readonly responsibility: string;
  readonly capabilities: readonly ModuleCapability[];
}
/**
 * An executable schema. Parsing must be deterministic and side-effect-free,
 * and return an acyclic graph of plain objects, dense arrays, and primitive
 * config values. Core takes and freezes an exact own-data snapshot before
 * validation or module creation; accessors, proxies, symbols, and exotic
 * prototypes are rejected.
 */
export interface ModuleSchema<TConfig> { readonly jsonSchema: JsonSchema; parse(input: unknown): TConfig; }
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
  readonly message?: string; readonly issues: readonly ConfigIssue[]; readonly cause?: unknown;
}
export class ModuleConfigError extends Error {
  readonly code = "MODULE_CONFIG_INVALID";
  readonly issues: readonly ConfigIssue[];
  constructor(options: ModuleConfigErrorOptions) {
    const issues = options.issues.map((issue) => freezeConfigIssue(issue));
    const message = options.message ?? issues[0]?.message ?? "Module configuration is invalid";
    if (options.cause === undefined) super(message);
    else super(message, { cause: options.cause });
    this.name = "ModuleConfigError";
    this.issues = Object.freeze(issues);
  }
}
export interface ParseModuleConfigOptions {
  readonly packageName?: string; readonly provenance?: ConfigProvenanceMap;
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
      issues: [configIssue("invalid_config", message, [], provenanceAt(options.provenance, []))],
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
export interface ModuleStartContext { readonly signal: AbortSignal; }
export interface ModuleDrainContext { readonly signal: AbortSignal; readonly deadline?: string; }
export type ModuleStopReason = "shutdown" | "restart" | "startup-failed" | "health-failed";
export interface ModuleStopContext { readonly signal: AbortSignal; readonly reason: ModuleStopReason; }
export type ModuleHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
export interface ModuleHealth {
  readonly status: ModuleHealthStatus;
  readonly checkedAt: string;
  readonly summary?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}
export interface ModuleHealthContext { readonly signal: AbortSignal; }
export type ModuleDiagnosticSeverity = "info" | "warning" | "error";
export interface ModuleDiagnostic {
  readonly code: string;
  readonly severity: ModuleDiagnosticSeverity;
  readonly message: string;
  readonly path?: ConfigPath;
  readonly hint?: string;
}
export interface ModuleDiagnosticsContext { readonly signal: AbortSignal; readonly verbose: boolean; }
export type ModuleCommandKind = "authentication" | "maintenance";
export interface ModuleCommandContext { readonly signal: AbortSignal; readonly logger: ModuleLogger; }
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
export type AttachmentKind = "image" | "audio" | "file";
/** A transport-neutral attachment whose size and bytes have already been bounded. */
export interface NormalizedAttachment {
  /** At most 512 UTF-8 bytes. */ readonly id: string;
  readonly kind: AttachmentKind;
  /** At most 255 UTF-8 bytes. */ readonly name: string;
  /** At most 255 UTF-8 bytes. */ readonly mediaType: string;
  readonly sizeBytes: number;
  readonly data: Uint8Array;
}
/** Shared interaction bounds used by every runtime, channel, and host codec. */
export const AGENT_INTERACTION_LIMITS = Object.freeze({
  identifierCharacters: 256,
  timestampCharacters: 24,
  askQuestions: 3,
  askChoicesPerQuestion: 20,
  askPromptBytes: 16_384,
  askChoiceValueBytes: 4_096,
  askChoiceLabelBytes: 1_024,
  askChoiceDescriptionBytes: 4_096,
  askAnswerValuesPerQuestion: 20,
  askAnswerBytes: 16_384,
  approvalDisplayNameBytes: 1_024,
  approvalSummaryBytes: 16_384,
  approvalReasonBytes: 4_096,
} as const);
export const ASK_USER_MAX_QUESTIONS = AGENT_INTERACTION_LIMITS.askQuestions;
export const ASK_USER_MAX_CHOICES_PER_QUESTION = AGENT_INTERACTION_LIMITS.askChoicesPerQuestion;
export const ASK_USER_MAX_ANSWER_BYTES = AGENT_INTERACTION_LIMITS.askAnswerBytes;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export interface AskUserChoice { readonly value: string; readonly label: string; readonly description?: string; }
export interface AskUserQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly choices?: readonly AskUserChoice[];
  readonly allowFreeText: boolean;
  readonly multiple: boolean;
}
export interface AskUserRequest {
  readonly interactionId: string; readonly questions: readonly AskUserQuestion[]; readonly requestedAt: string;
}
export interface AskUserAnswer {
  readonly interactionId: string; readonly answers: Readonly<Record<string, readonly string[]>>;
  readonly answeredAt: string;
}
export type RuntimeNativeToolEffect = "read" | "write" | "execute" | "network";
export type RuntimeNativeToolApprovalEnforcement =
  | "core-callback"
  | "runtime-enforced"
  | "unsupported";
export type RuntimeNativeToolSandboxEnforcement =
  | "core-executor"
  | "runtime-enforced"
  | "unsupported";
/**
 * Provider-neutral authority metadata for one tool owned by a runtime.
 * An empty `effects` list represents a tool that has no external effect.
 */
export interface RuntimeNativeToolDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly effects: readonly RuntimeNativeToolEffect[];
  readonly approval: RuntimeNativeToolApprovalEnforcement;
  readonly sandbox: RuntimeNativeToolSandboxEnforcement;
}
export interface ApprovalRequest {
  readonly interactionId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly displayName: string;
  readonly effects: readonly RuntimeNativeToolEffect[];
  readonly summary: string;
  readonly requestedAt: string;
}
export interface ApprovalDecision {
  readonly interactionId: string;
  readonly decision: "allow_once" | "deny";
  readonly decidedAt: string;
  readonly reason?: string;
}
export interface RouteIdentity { readonly runtimeInstanceId: string; readonly model: string; }
export interface InteractionContext {
  readonly conversationId: string;
  readonly turnId: string;
  readonly route: RouteIdentity;
  readonly signal: AbortSignal;
}
export interface AgentInteractionHandler {
  askUser(request: AskUserRequest, context: InteractionContext): Promise<AskUserAnswer>;
  requestApproval(request: ApprovalRequest, context: InteractionContext): Promise<ApprovalDecision>;
}
export interface ArtifactRef {
  readonly id: string;
  readonly sha256: `sha256:${string}`;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly fileName?: string;
}
export const RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES = 16_384;
/**
 * Parse and copy one transport-neutral AskUser request. Unknown fields,
 * non-canonical timestamps, duplicate ids, and values outside the shared
 * bounds fail closed.
 */
export function parseAskUserRequest(value: unknown): AskUserRequest {
  const input = contractRecord(value, "AskUser request", ["interactionId", "questions", "requestedAt"]);
  const interactionId = contractIdentifier(input.interactionId, "AskUser request.interactionId");
  const requestedAt = contractTimestamp(input.requestedAt, "AskUser request.requestedAt");
  const questionsInput = contractArray(
    input.questions, "AskUser request.questions", 1, AGENT_INTERACTION_LIMITS.askQuestions,
  );
  const questionIds = new Set<string>();
  const questions = questionsInput.map((questionValue, questionIndex): AskUserQuestion => {
    const path = `AskUser request.questions[${String(questionIndex)}]`;
    const question = contractRecord(questionValue, path, [
      "id", "prompt", "choices", "allowFreeText", "multiple",
    ]);
    const id = contractIdentifier(question.id, `${path}.id`);
    if (questionIds.has(id)) contractFail(`${path}.id`, "must be unique");
    questionIds.add(id);
    const prompt = contractText(question.prompt, `${path}.prompt`, AGENT_INTERACTION_LIMITS.askPromptBytes);
    const allowFreeText = contractBoolean(question.allowFreeText, `${path}.allowFreeText`);
    const multiple = contractBoolean(question.multiple, `${path}.multiple`);
    const choicesInput = question.choices === undefined ? [] : contractArray(
      question.choices, `${path}.choices`, 0, AGENT_INTERACTION_LIMITS.askChoicesPerQuestion,
    );
    if (choicesInput.length === 0 && !allowFreeText) {
      contractFail(`${path}.choices`, "must contain a choice when free text is disabled");
    }
    const choiceValues = new Set<string>();
    const choices = choicesInput.map((choiceValue, choiceIndex): AskUserChoice => {
      const choicePath = `${path}.choices[${String(choiceIndex)}]`;
      const choice = contractRecord(choiceValue, choicePath, ["value", "label", "description"]);
      const parsedValue = contractText(
        choice.value, `${choicePath}.value`, AGENT_INTERACTION_LIMITS.askChoiceValueBytes,
      );
      if (choiceValues.has(parsedValue)) contractFail(`${choicePath}.value`, "must be unique");
      choiceValues.add(parsedValue);
      const label = contractText(
        choice.label, `${choicePath}.label`, AGENT_INTERACTION_LIMITS.askChoiceLabelBytes,
      );
      const description = choice.description === undefined ? undefined : contractText(
        choice.description, `${choicePath}.description`,
        AGENT_INTERACTION_LIMITS.askChoiceDescriptionBytes,
      );
      return Object.freeze({
        value: parsedValue,
        label,
        ...(description === undefined ? {} : { description }),
      });
    });
    return Object.freeze({
      id,
      prompt,
      ...(question.choices === undefined ? {} : { choices: Object.freeze(choices) }),
      allowFreeText,
      multiple,
    });
  });
  return Object.freeze({ interactionId, questions: Object.freeze(questions), requestedAt });
}
export function assertAskUserRequest(value: unknown): asserts value is AskUserRequest { parseAskUserRequest(value); }
/**
 * Parse an AskUser answer and, when the originating request is supplied,
 * require an exact question set and enforce choice/free-text semantics.
 */
export function parseAskUserAnswer(value: unknown, request?: AskUserRequest): AskUserAnswer {
  const parsedRequest = request === undefined ? undefined : parseAskUserRequest(request);
  const input = contractRecord(value, "AskUser answer", ["interactionId", "answers", "answeredAt"]);
  const interactionId = contractIdentifier(input.interactionId, "AskUser answer.interactionId");
  if (parsedRequest !== undefined && interactionId !== parsedRequest.interactionId) {
    contractFail("AskUser answer.interactionId", "does not match the request");
  }
  const answeredAt = contractTimestamp(input.answeredAt, "AskUser answer.answeredAt");
  const answersInput = contractRecord(input.answers, "AskUser answer.answers", undefined, true);
  const answerEntries = Object.entries(answersInput);
  if (answerEntries.length < 1 || answerEntries.length > AGENT_INTERACTION_LIMITS.askQuestions) {
    contractFail(
      "AskUser answer.answers",
      `must contain between 1 and ${String(AGENT_INTERACTION_LIMITS.askQuestions)} questions`,
    );
  }
  const questions = parsedRequest === undefined ? undefined
    : new Map(parsedRequest.questions.map((question) => [question.id, question]));
  if (questions !== undefined && answerEntries.length !== questions.size) {
    contractFail("AskUser answer.answers", "must answer every request question exactly once");
  }
  const answers = Object.create(null) as Record<string, readonly string[]>;
  for (const [rawQuestionId, answerValue] of answerEntries) {
    const questionId = contractIdentifier(rawQuestionId, "AskUser answer.answers key");
    const question = questions?.get(questionId);
    if (questions !== undefined && question === undefined) {
      contractFail(`AskUser answer.answers.${questionId}`, "does not match a request question");
    }
    const valuesInput = contractArray(
      answerValue, `AskUser answer.answers.${questionId}`,
      1, AGENT_INTERACTION_LIMITS.askAnswerValuesPerQuestion,
    );
    if (question !== undefined && !question.multiple && valuesInput.length !== 1) {
      contractFail(
        `AskUser answer.answers.${questionId}`,
        "must contain exactly one value for a single-select question",
      );
    }
    const allowedChoices = question === undefined ? undefined
      : new Set((question.choices ?? []).map((choice) => choice.value));
    const seen = new Set<string>();
    const values = valuesInput.map((answer, answerIndex) => {
      const answerPath = `AskUser answer.answers.${questionId}[${String(answerIndex)}]`;
      const parsed = contractText(answer, answerPath, AGENT_INTERACTION_LIMITS.askAnswerBytes);
      if (seen.has(parsed)) contractFail(answerPath, "must be unique");
      seen.add(parsed);
      if (question !== undefined && !question.allowFreeText && !allowedChoices?.has(parsed)) {
        contractFail(answerPath, "must match one of the request choices");
      }
      return parsed;
    });
    answers[questionId] = Object.freeze(values);
  }
  return Object.freeze({ interactionId, answers: Object.freeze(answers), answeredAt });
}
export function assertAskUserAnswer(value: unknown, request?: AskUserRequest): asserts value is AskUserAnswer {
  parseAskUserAnswer(value, request);
}
export function parseApprovalRequest(value: unknown): ApprovalRequest {
  const input = contractRecord(value, "approval request", [
    "interactionId", "callId", "toolId", "displayName", "effects", "summary", "requestedAt",
  ]);
  return Object.freeze({
    interactionId: contractIdentifier(input.interactionId, "approval request.interactionId"),
    callId: contractIdentifier(input.callId, "approval request.callId"),
    toolId: contractIdentifier(input.toolId, "approval request.toolId"),
    displayName: contractText(
      input.displayName, "approval request.displayName",
      AGENT_INTERACTION_LIMITS.approvalDisplayNameBytes,
    ),
    effects: parseRuntimeNativeToolEffects(input.effects, "approval request.effects"),
    summary: contractText(
      input.summary, "approval request.summary", AGENT_INTERACTION_LIMITS.approvalSummaryBytes,
    ),
    requestedAt: contractTimestamp(input.requestedAt, "approval request.requestedAt"),
  });
}
export function assertApprovalRequest(value: unknown): asserts value is ApprovalRequest { parseApprovalRequest(value); }
export function parseApprovalDecision(value: unknown, request?: ApprovalRequest): ApprovalDecision {
  const parsedRequest = request === undefined ? undefined : parseApprovalRequest(request);
  const input = contractRecord(
    value, "approval decision", ["interactionId", "decision", "decidedAt", "reason"],
  );
  const interactionId = contractIdentifier(input.interactionId, "approval decision.interactionId");
  if (parsedRequest !== undefined && interactionId !== parsedRequest.interactionId) {
    contractFail("approval decision.interactionId", "does not match the request");
  }
  const decision = contractEnum(
    input.decision, ["allow_once", "deny"] as const, "approval decision.decision",
  );
  const reason = input.reason === undefined ? undefined : contractText(
    input.reason, "approval decision.reason", AGENT_INTERACTION_LIMITS.approvalReasonBytes,
  );
  return Object.freeze({
    interactionId,
    decision,
    decidedAt: contractTimestamp(input.decidedAt, "approval decision.decidedAt"),
    ...(reason === undefined ? {} : { reason }),
  });
}
export function assertApprovalDecision(value: unknown, request?: ApprovalRequest): asserts value is ApprovalDecision {
  parseApprovalDecision(value, request);
}
export function parseRouteIdentity(value: unknown): RouteIdentity {
  const input = contractRecord(value, "route identity", ["runtimeInstanceId", "model"]);
  return Object.freeze({
    runtimeInstanceId: contractIdentifier(input.runtimeInstanceId, "route identity.runtimeInstanceId"),
    model: contractText(input.model, "route identity.model", 4_096),
  });
}
export function assertRouteIdentity(value: unknown): asserts value is RouteIdentity { parseRouteIdentity(value); }
export function parseArtifactRef(value: unknown): ArtifactRef {
  const input = contractRecord(
    value, "artifact reference", ["id", "sha256", "sizeBytes", "mediaType", "fileName"],
  );
  const sha256 = contractText(input.sha256, "artifact reference.sha256", 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(sha256)) {
    contractFail("artifact reference.sha256", "must be a lowercase SHA-256 digest");
  }
  const mediaType = contractText(input.mediaType, "artifact reference.mediaType", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mediaType)) {
    contractFail("artifact reference.mediaType", "must be an IANA media type");
  }
  const sizeBytes = contractNonNegativeInteger(input.sizeBytes, "artifact reference.sizeBytes");
  const fileName = input.fileName === undefined
    ? undefined
    : contractText(input.fileName, "artifact reference.fileName", 255);
  if (fileName !== undefined && (
    fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")
    || fileName === "." || fileName === ".."
  )) {
    contractFail("artifact reference.fileName", "must be a base name");
  }
  return Object.freeze({
    id: contractIdentifier(input.id, "artifact reference.id"),
    sha256: sha256 as `sha256:${string}`,
    sizeBytes,
    mediaType,
    ...(fileName === undefined ? {} : { fileName }),
  });
}
export function assertArtifactRef(value: unknown): asserts value is ArtifactRef { parseArtifactRef(value); }
export function parseRuntimeNativeToolDescriptor(value: unknown): RuntimeNativeToolDescriptor {
  const input = contractRecord(
    value,
    "runtime native tool descriptor",
    ["id", "displayName", "effects", "approval", "sandbox"],
  );
  return Object.freeze({
    id: contractIdentifier(input.id, "runtime native tool descriptor.id"),
    displayName: contractText(
      input.displayName, "runtime native tool descriptor.displayName",
      AGENT_INTERACTION_LIMITS.approvalDisplayNameBytes,
    ),
    effects: parseRuntimeNativeToolEffects(input.effects, "runtime native tool descriptor.effects"),
    approval: contractEnum(
      input.approval, ["core-callback", "runtime-enforced", "unsupported"] as const,
      "runtime native tool descriptor.approval",
    ),
    sandbox: contractEnum(
      input.sandbox, ["core-executor", "runtime-enforced", "unsupported"] as const,
      "runtime native tool descriptor.sandbox",
    ),
  });
}
export function assertRuntimeNativeToolDescriptor(value: unknown): asserts value is RuntimeNativeToolDescriptor {
  parseRuntimeNativeToolDescriptor(value);
}
export interface TurnTextPart { readonly type: "text"; readonly text: string; }
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
export interface TurnAttachmentPart { readonly type: "attachment"; readonly attachment: NormalizedAttachment; }
export interface RuntimeToolCall { readonly id: string; readonly name: string; readonly input: JsonValue; }
export interface RuntimeToolResultTextPart { readonly type: "text"; readonly text: string; }
export interface RuntimeToolResultJsonPart { readonly type: "json"; readonly value: JsonValue; }
export interface RuntimeToolResultFilePart {
  readonly type: "file";
  readonly mediaType: string;
  readonly data: Uint8Array | string;
  readonly name?: string;
}
export interface RuntimeToolResultArtifactPart {
  readonly type: "artifact"; readonly ref: ArtifactRef; readonly preview?: string;
}
export type RuntimeToolResultPart =
  | RuntimeToolResultTextPart
  | RuntimeToolResultJsonPart
  | RuntimeToolResultFilePart
  | RuntimeToolResultArtifactPart;
export interface RuntimeToolResult {
  readonly callId: string; readonly content: readonly RuntimeToolResultPart[]; readonly isError?: boolean;
}
export interface TurnToolCallPart { readonly type: "tool-call"; readonly call: RuntimeToolCall; }
export interface TurnToolResultPart { readonly type: "tool-result"; readonly result: RuntimeToolResult; }
export type TurnContentPart =
  | TurnTextPart
  | TurnImagePart
  | TurnFilePart
  | TurnAttachmentPart
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
  readonly name: string; readonly description: string; readonly inputSchema: JsonSchema;
}
export interface RuntimeSession {
  /** Runtime-owned opaque identifier of at most 512 UTF-8 bytes. */ readonly id: string;
  /** Canonical conversation whose provider-native continuation this is. */
  readonly conversationId: string;
  /** Exact runtime instance and model route that created this private session. */
  readonly route: RouteIdentity;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly metadata?: JsonObject;
}
export interface RuntimeTurnOptions {
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly maxOutputTokens?: number;
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
  readonly reasoningTokens?: number;
  readonly contextWindow?: number;
  readonly contextUsed?: number;
  readonly cost?: RuntimeUsageCost;
  readonly compaction?: RuntimeCompaction;
  readonly sessionEvicted?: boolean;
}
export interface RuntimeUsageCost {
  readonly currency: "USD";
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly total: number;
}
export interface RuntimeCompaction {
  readonly compacted: boolean;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly summaryTokens?: number;
  readonly firstRetainedMessageId?: string;
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
/**
 * An immutable, accessor-free classification captured from one runtime
 * failure. Hosts must use this snapshot, rather than re-reading the thrown
 * object, for fallback and settlement decisions.
 */
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
/**
 * Capture a compatible runtime failure from own data properties only.
 *
 * Accessor-backed or inherited classification claims fail closed. The
 * returned object is frozen so one captured classification can safely drive
 * all host decisions for the failure.
 */
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
/** Provider-neutral metadata a runtime can enforce for one exact model. */
export interface RuntimeModelDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly efforts?: readonly string[];
  readonly contextWindow?: number;
}
export interface RuntimeModelValidation {
  readonly supported: boolean;
  readonly model?: RuntimeModelDescriptor;
  /** Effective capabilities for this exact model route. */
  readonly capabilities?: RuntimeCapabilities;
  /** Native tools available on this exact model route. */
  readonly nativeTools?: readonly RuntimeNativeToolDescriptor[];
  readonly diagnostics?: readonly ModuleDiagnostic[];
}
export interface RuntimeModelPreflightRequest { readonly model: string; readonly signal: AbortSignal; }
export interface RuntimeModelPreflightResult {
  readonly supported: boolean;
  readonly model?: RuntimeModelDescriptor;
  readonly capabilities?: RuntimeCapabilities;
  readonly nativeTools?: readonly RuntimeNativeToolDescriptor[];
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
function freezeConfigIssue(issue: ConfigIssue): ConfigIssue {
  return Object.freeze({
    ...issue,
    path: Object.freeze([...issue.path]),
    ...(issue.provenance === undefined ? {} : { provenance: defineConfigProvenance(issue.provenance) }),
  });
}
function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
function isModuleSlot(value: unknown): value is ModuleSlot {
  return value === "runtime" || value === "channel" || value === "memory" || value === "state"
    || value === "trigger" || value === "exporter" || value === "sandbox";
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
type ContractRecord = Record<string, unknown>;
function contractFail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}
function contractRecord(
  value: unknown, path: string, allowed?: readonly string[], identifierKeys = false,
): ContractRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return contractFail(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return contractFail(path, "must be a plain object");
  }
  const detached: ContractRecord = Object.create(null) as ContractRecord;
  const allowedSet = allowed === undefined ? undefined : new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") contractFail(path, "contains an unknown symbol field");
    if (key === "__proto__" || (!identifierKeys && (key === "constructor" || key === "prototype"))) {
      contractFail(path, `contains unsafe field ${JSON.stringify(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      contractFail(`${path}.${key}`, "must be a data property");
    }
    detached[key] = descriptor.value;
  }
  if (allowedSet !== undefined) {
    for (const key of Reflect.ownKeys(detached)) {
      if (typeof key !== "string") contractFail(path, "contains an unknown symbol field");
      if (!allowedSet.has(key)) contractFail(path, `contains unknown field ${JSON.stringify(key)}`);
    }
  }
  return detached;
}
function contractArray(
  value: unknown, path: string, minimum: number, maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) contractFail(path, "must be an array");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    contractFail(`${path}.length`, "must be a data property");
  }
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number" || !Number.isSafeInteger(length)
    || length < minimum || length > maximum
  ) {
    contractFail(path, `must contain between ${String(minimum)} and ${String(maximum)} items`);
  }
  const allowed = new Set(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) contractFail(path, "contains an unknown array field");
  }
  const detached: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) contractFail(`${path}.${String(index)}`, "is required");
    if (!("value" in descriptor)) contractFail(`${path}.${String(index)}`, "must be a data property");
    detached.push(descriptor.value);
  }
  return detached;
}
function contractText(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== "string") contractFail(path, "must be a string");
  if (value.length === 0 || value.trim().length === 0) contractFail(path, "must not be empty");
  if (value.includes("\0")) contractFail(path, "must not contain NUL");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximumBytes) contractFail(path, `must be at most ${String(maximumBytes)} UTF-8 bytes`);
  return value;
}
function contractIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string") contractFail(path, "must be a string");
  if (value.length === 0 || value.length > AGENT_INTERACTION_LIMITS.identifierCharacters) {
    contractFail(path, `must contain between 1 and ${String(AGENT_INTERACTION_LIMITS.identifierCharacters)} characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) {
    contractFail(path, "contains unsupported characters");
  }
  return value;
}
function contractTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length !== AGENT_INTERACTION_LIMITS.timestampCharacters
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    contractFail(path, "must be a canonical UTC timestamp");
  }
  return value;
}
function contractBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") contractFail(path, "must be a boolean"); return value;
}
function contractNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    contractFail(path, "must be a non-negative safe integer");
  }
  return value;
}
function contractEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    contractFail(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}
function parseRuntimeNativeToolEffects(value: unknown, path: string): readonly RuntimeNativeToolEffect[] {
  const values = contractArray(value, path, 0, 4);
  const effects = values.map((effect, index) => contractEnum(
    effect, ["read", "write", "execute", "network"] as const, `${path}[${String(index)}]`,
  ));
  if (new Set(effects).size !== effects.length) contractFail(path, "must not contain duplicate effects");
  return Object.freeze(effects);
}
export * from "./http.js";
export * from "./secure-fs.js";
