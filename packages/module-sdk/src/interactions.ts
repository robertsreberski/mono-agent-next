export type AttachmentKind = "image" | "audio" | "file";
/** A transport-neutral attachment whose size and bytes have already been bounded. */
export interface NormalizedAttachment {
  /** At most 512 UTF-8 bytes. */ readonly id: string; readonly kind: AttachmentKind;
  /** At most 255 UTF-8 bytes. */ readonly name: string;
  /** At most 255 UTF-8 bytes. */ readonly mediaType: string;
  readonly sizeBytes: number; readonly data: Uint8Array;
}
/** Shared interaction bounds used by every runtime, channel, and host codec. */
export const AGENT_INTERACTION_LIMITS = Object.freeze({
  identifierCharacters: 256, timestampCharacters: 24,
  askQuestions: 3, askChoicesPerQuestion: 20, askPromptBytes: 16_384,
  askChoiceValueBytes: 4_096, askChoiceLabelBytes: 1_024, askChoiceDescriptionBytes: 4_096,
  askAnswerValuesPerQuestion: 20, askAnswerBytes: 16_384,
  approvalDisplayNameBytes: 1_024, approvalSummaryBytes: 16_384, approvalReasonBytes: 4_096,
} as const);
export const ASK_USER_MAX_QUESTIONS = AGENT_INTERACTION_LIMITS.askQuestions;
export const ASK_USER_MAX_CHOICES_PER_QUESTION = AGENT_INTERACTION_LIMITS.askChoicesPerQuestion;
export const ASK_USER_MAX_ANSWER_BYTES = AGENT_INTERACTION_LIMITS.askAnswerBytes;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export interface AskUserChoice { readonly value: string; readonly label: string; readonly description?: string; }
export interface AskUserQuestion {
  readonly id: string; readonly prompt: string; readonly choices?: readonly AskUserChoice[];
  readonly allowFreeText: boolean; readonly multiple: boolean;
}
export interface AskUserRequest {
  readonly interactionId: string; readonly questions: readonly AskUserQuestion[]; readonly requestedAt: string;
}
export interface AskUserAnswer {
  readonly interactionId: string; readonly answers: Readonly<Record<string, readonly string[]>>;
  readonly answeredAt: string;
}
export type RuntimeNativeToolEffect = "read" | "write" | "execute" | "network";
export type RuntimeNativeToolApprovalEnforcement = "core-callback" | "runtime-enforced" | "unsupported";
export type RuntimeNativeToolSandboxEnforcement = "core-executor" | "runtime-enforced" | "unsupported";
/**
 * Provider-neutral authority metadata for one tool owned by a runtime.
 * An empty `effects` list represents a tool that has no external effect.
 */
export interface RuntimeNativeToolDescriptor {
  readonly id: string; readonly displayName: string; readonly effects: readonly RuntimeNativeToolEffect[];
  readonly approval: RuntimeNativeToolApprovalEnforcement; readonly sandbox: RuntimeNativeToolSandboxEnforcement;
}
export interface ApprovalRequest {
  readonly interactionId: string; readonly callId: string; readonly toolId: string;
  readonly displayName: string; readonly effects: readonly RuntimeNativeToolEffect[];
  readonly summary: string; readonly requestedAt: string;
}
export interface ApprovalDecision {
  readonly interactionId: string; readonly decision: "allow_once" | "deny";
  readonly decidedAt: string; readonly reason?: string;
}
export interface RouteIdentity { readonly runtimeInstanceId: string; readonly model: string; }
export interface InteractionContext {
  readonly conversationId: string; readonly turnId: string; readonly route: RouteIdentity;
  readonly signal: AbortSignal;
}
export interface AgentInteractionHandler {
  askUser(request: AskUserRequest, context: InteractionContext): Promise<AskUserAnswer>;
  requestApproval(request: ApprovalRequest, context: InteractionContext): Promise<ApprovalDecision>;
}
export interface ArtifactRef {
  readonly id: string; readonly sha256: `sha256:${string}`; readonly sizeBytes: number;
  readonly mediaType: string; readonly fileName?: string;
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
