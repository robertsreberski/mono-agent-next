import {
  OPERATOR_LIMITS,
  OPERATOR_PROTOCOL,
  OPERATOR_REGISTRY_SCHEMA,
  type OperatorAsk,
  type OperatorAskAnswerRequest,
  type OperatorAskAnswerResponse,
  type OperatorAskSnapshot,
  type OperatorAttachment,
  type OperatorCancelRequest,
  type OperatorCancelResponse,
  type OperatorCapabilities,
  type OperatorCompaction,
  type OperatorConfigView,
  type OperatorConversationList,
  type OperatorConversationSummary,
  type OperatorFrame,
  type OperatorHealth,
  type OperatorInfo,
  type OperatorJsonValue,
  type OperatorLiveInputRequest,
  type OperatorLiveInputResponse,
  type OperatorMessage,
  type OperatorModel,
  type OperatorQuestion,
  type OperatorQuestionChoice,
  type OperatorQuote,
  type OperatorRegistryDescriptor,
  type OperatorReplayResponse,
  type OperatorTurnRequest,
  type OperatorToolCall,
  type OperatorToolResult,
  type OperatorToolResultPart,
  type OperatorUsage,
} from "./types.js";

export class OperatorProtocolError extends Error {
  readonly code: "INVALID_VALUE" | "FRAME_TOO_LARGE";

  constructor(code: OperatorProtocolError["code"], message: string) {
    super(message);
    this.name = "OperatorProtocolError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new OperatorProtocolError("INVALID_VALUE", `${path} ${message}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "must be a plain object");
  }
  return value as UnknownRecord;
}

function keys(value: UnknownRecord, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail(path, `contains unknown field ${JSON.stringify(unexpected[0])}`);
  }
}

function text(value: unknown, path: string, options: { allowEmpty?: boolean; max?: number } = {}): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (!options.allowEmpty && value.length === 0) fail(path, "must not be empty");
  if (value.length > (options.max ?? 32_768)) fail(path, `must be at most ${options.max ?? 32_768} characters`);
  return value;
}

function contractText(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0 || value.trim().length === 0) fail(path, "must not be empty");
  if (value.includes("\0")) fail(path, "must not contain NUL");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximumBytes) fail(path, `must be at most ${maximumBytes} UTF-8 bytes`);
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = text(value, path, { max: OPERATOR_LIMITS.identifierCharacters });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(parsed)) {
    fail(path, "contains unsupported characters");
  }
  return parsed;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const parsed = text(value, path, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(parsed).toISOString() !== parsed) {
    fail(path, "must be a canonical UTC timestamp");
  }
  return parsed;
}

function environmentName(value: unknown, path: string): string {
  const parsed = text(value, path, { max: 255 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed)) fail(path, "must be a valid environment variable name");
  return parsed;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function array<T>(value: unknown, path: string, parser: (item: unknown, path: string) => T, max = 1_000): T[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `must contain at most ${max} items`);
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function jsonValue(
  value: unknown,
  path: string,
  depth = 0,
  budget: { items: number } = { items: 0 },
): OperatorJsonValue {
  if (depth > 20) fail(path, "exceeds the maximum nesting depth");
  budget.items += 1;
  if (budget.items > OPERATOR_LIMITS.jsonItems) {
    fail(path, `exceeds the ${String(OPERATOR_LIMITS.jsonItems)}-item JSON boundary`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1, budget));
  }
  if (typeof value === "object") {
    const output: Record<string, OperatorJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") fail(path, `contains unsafe key ${key}`);
      output[key] = jsonValue(item, `${path}.${key}`, depth + 1, budget);
    }
    return output;
  }
  return fail(path, "must contain only JSON values");
}

function boundedJsonValue(value: unknown, path: string): OperatorJsonValue {
  const parsed = jsonValue(value, path);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > OPERATOR_LIMITS.toolPayloadBytes) {
    fail(path, `must encode to at most ${String(OPERATOR_LIMITS.toolPayloadBytes)} UTF-8 bytes`);
  }
  return parsed;
}

function boundedUtf8Text(value: unknown, path: string, maximumBytes: number): string {
  const parsed = text(value, path, { allowEmpty: true, max: maximumBytes });
  if (new TextEncoder().encode(parsed).byteLength > maximumBytes) {
    fail(path, `must be at most ${String(maximumBytes)} UTF-8 bytes`);
  }
  return parsed;
}

function toolCall(value: unknown, path: string): OperatorToolCall {
  const input = record(value, path);
  keys(input, ["id", "name", "input", "inputOmitted"], path);
  const inputOmitted = bool(input.inputOmitted, `${path}.inputOmitted`);
  const hasInput = Object.hasOwn(input, "input");
  if (hasInput === inputOmitted) {
    fail(path, inputOmitted ? "must omit input when inputOmitted is true" : "must include input when inputOmitted is false");
  }
  return {
    id: contractText(input.id, `${path}.id`, OPERATOR_LIMITS.toolIdentifierBytes),
    name: contractText(input.name, `${path}.name`, OPERATOR_LIMITS.toolIdentifierBytes),
    ...(hasInput ? { input: boundedJsonValue(input.input, `${path}.input`) } : {}),
    inputOmitted,
  };
}

function toolResultPart(value: unknown, path: string): OperatorToolResultPart {
  const input = record(value, path);
  if (input.type === "text") {
    keys(input, ["type", "text"], path);
    return {
      type: "text",
      text: boundedUtf8Text(input.text, `${path}.text`, OPERATOR_LIMITS.toolPayloadBytes),
    };
  }
  if (input.type === "json") {
    keys(input, ["type", "value"], path);
    if (!Object.hasOwn(input, "value")) fail(`${path}.value`, "is required");
    return { type: "json", value: boundedJsonValue(input.value, `${path}.value`) };
  }
  return fail(`${path}.type`, "must be text or json");
}

function toolResult(value: unknown, path: string): OperatorToolResult {
  const input = record(value, path);
  keys(input, ["callId", "content", "contentOmitted", "isError"], path);
  const contentOmitted = bool(input.contentOmitted, `${path}.contentOmitted`);
  const hasContent = Object.hasOwn(input, "content");
  if (hasContent === contentOmitted) {
    fail(path, contentOmitted ? "must omit content when contentOmitted is true" : "must include content when contentOmitted is false");
  }
  const output = {
    callId: contractText(input.callId, `${path}.callId`, OPERATOR_LIMITS.toolIdentifierBytes),
    ...(hasContent ? {
      content: array(
        input.content,
        `${path}.content`,
        toolResultPart,
        OPERATOR_LIMITS.toolResultParts,
      ),
    } : {}),
    contentOmitted,
    ...(input.isError === undefined ? {} : { isError: bool(input.isError, `${path}.isError`) }),
  };
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > OPERATOR_LIMITS.toolPayloadBytes) {
    fail(path, `must encode to at most ${String(OPERATOR_LIMITS.toolPayloadBytes)} UTF-8 bytes`);
  }
  return output;
}

function compaction(value: unknown, path: string): OperatorCompaction {
  const input = record(value, path);
  keys(input, ["compacted", "tokensBefore", "tokensAfter", "summaryTokens", "firstRetainedMessageId"], path);
  return {
    compacted: bool(input.compacted, `${path}.compacted`),
    ...(input.tokensBefore === undefined ? {} : { tokensBefore: integer(input.tokensBefore, `${path}.tokensBefore`) }),
    ...(input.tokensAfter === undefined ? {} : { tokensAfter: integer(input.tokensAfter, `${path}.tokensAfter`) }),
    ...(input.summaryTokens === undefined ? {} : { summaryTokens: integer(input.summaryTokens, `${path}.summaryTokens`) }),
    ...(input.firstRetainedMessageId === undefined ? {} : {
      firstRetainedMessageId: contractText(
        input.firstRetainedMessageId,
        `${path}.firstRetainedMessageId`,
        OPERATOR_LIMITS.toolIdentifierBytes,
      ),
    }),
  };
}

function attachment(value: unknown, path: string): OperatorAttachment {
  const input = record(value, path);
  keys(input, ["id", "name", "mediaType", "sizeBytes", "url"], path);
  return {
    id: identifier(input.id, `${path}.id`),
    name: text(input.name, `${path}.name`, { max: 1_024 }),
    mediaType: text(input.mediaType, `${path}.mediaType`, { max: 255 }),
    ...(input.sizeBytes === undefined ? {} : { sizeBytes: integer(input.sizeBytes, `${path}.sizeBytes`) }),
    ...(input.url === undefined ? {} : {
      url: text(input.url, `${path}.url`, { max: OPERATOR_LIMITS.attachmentUrlCharacters }),
    }),
  };
}

function quote(value: unknown, path: string): OperatorQuote {
  const input = record(value, path);
  keys(input, ["conversationId", "messageId", "text"], path);
  return {
    conversationId: identifier(input.conversationId, `${path}.conversationId`),
    messageId: identifier(input.messageId, `${path}.messageId`),
    ...(input.text === undefined ? {} : {
      text: text(input.text, `${path}.text`, {
        allowEmpty: true,
        max: OPERATOR_LIMITS.quoteCharacters,
      }),
    }),
  };
}

function questionChoice(value: unknown, path: string): OperatorQuestionChoice {
  const input = record(value, path);
  keys(input, ["value", "label", "description"], path);
  return {
    value: contractText(input.value, `${path}.value`, OPERATOR_LIMITS.askChoiceValueBytes),
    label: contractText(input.label, `${path}.label`, OPERATOR_LIMITS.askChoiceLabelBytes),
    ...(input.description === undefined ? {} : {
      description: contractText(
        input.description,
        `${path}.description`,
        OPERATOR_LIMITS.askChoiceDescriptionBytes,
      ),
    }),
  };
}

function question(value: unknown, path: string): OperatorQuestion {
  const input = record(value, path);
  keys(input, ["id", "prompt", "choices", "allowFreeText", "multiple"], path);
  const allowFreeText = bool(input.allowFreeText, `${path}.allowFreeText`);
  const choices = input.choices === undefined
    ? undefined
    : array(
      input.choices,
      `${path}.choices`,
      questionChoice,
      OPERATOR_LIMITS.askChoicesPerQuestion,
    );
  if ((choices?.length ?? 0) === 0 && !allowFreeText) {
    fail(`${path}.choices`, "must contain a choice when free text is disabled");
  }
  const choiceValues = new Set<string>();
  for (const [index, choice] of (choices ?? []).entries()) {
    if (choiceValues.has(choice.value)) fail(`${path}.choices[${index}].value`, "must be unique");
    choiceValues.add(choice.value);
  }
  return {
    id: identifier(input.id, `${path}.id`),
    prompt: contractText(input.prompt, `${path}.prompt`, OPERATOR_LIMITS.askPromptBytes),
    ...(choices === undefined ? {} : { choices }),
    allowFreeText,
    multiple: bool(input.multiple, `${path}.multiple`),
  };
}

function ask(value: unknown, path: string): OperatorAsk {
  const input = record(value, path);
  keys(input, ["interactionId", "questions", "requestedAt"], path);
  const questions = array(
    input.questions,
    `${path}.questions`,
    question,
    OPERATOR_LIMITS.askQuestions,
  );
  if (questions.length === 0) fail(`${path}.questions`, "must contain at least one question");
  const questionIds = new Set<string>();
  for (const [index, item] of questions.entries()) {
    if (questionIds.has(item.id)) fail(`${path}.questions[${index}].id`, "must be unique");
    questionIds.add(item.id);
  }
  return {
    interactionId: identifier(input.interactionId, `${path}.interactionId`),
    questions,
    requestedAt: timestamp(input.requestedAt, `${path}.requestedAt`),
  };
}

export function parseOperatorCapabilities(value: unknown, path = "capabilities"): OperatorCapabilities {
  const input = record(value, path);
  const fields = ["attachments", "liveInput", "askUser", "cancellation", "quotes", "runtimeOverrides", "proactive", "configView", "replay", "health"] as const;
  keys(input, fields, path);
  return {
    attachments: bool(input.attachments, `${path}.attachments`),
    liveInput: bool(input.liveInput, `${path}.liveInput`),
    askUser: bool(input.askUser, `${path}.askUser`),
    cancellation: bool(input.cancellation, `${path}.cancellation`),
    quotes: bool(input.quotes, `${path}.quotes`),
    runtimeOverrides: bool(input.runtimeOverrides, `${path}.runtimeOverrides`),
    proactive: bool(input.proactive, `${path}.proactive`),
    configView: bool(input.configView, `${path}.configView`),
    replay: bool(input.replay, `${path}.replay`),
    health: bool(input.health, `${path}.health`),
  };
}

function model(value: unknown, path: string): OperatorModel {
  const input = record(value, path);
  keys(input, ["id", "label", "efforts", "contextWindow"], path);
  return {
    id: identifier(input.id, `${path}.id`),
    ...(input.label === undefined ? {} : { label: text(input.label, `${path}.label`, { max: 1_024 }) }),
    ...(input.efforts === undefined ? {} : { efforts: array(input.efforts, `${path}.efforts`, (item, itemPath) => identifier(item, itemPath), 50) }),
    ...(input.contextWindow === undefined ? {} : { contextWindow: integer(input.contextWindow, `${path}.contextWindow`, 1) }),
  };
}

export function parseOperatorInfo(value: unknown): OperatorInfo {
  const input = record(value, "info");
  keys(input, ["protocol", "agent", "process", "capabilities", "defaults", "models"], "info");
  if (input.protocol !== OPERATOR_PROTOCOL) fail("info.protocol", `must equal ${OPERATOR_PROTOCOL}`);
  const agent = record(input.agent, "info.agent");
  keys(agent, ["id", "label"], "info.agent");
  const process = record(input.process, "info.process");
  keys(process, ["pid", "startedAt"], "info.process");
  let defaults: OperatorInfo["defaults"];
  if (input.defaults !== undefined) {
    const parsed = record(input.defaults, "info.defaults");
    keys(parsed, ["runtime", "model", "effort"], "info.defaults");
    defaults = {
      ...(parsed.runtime === undefined ? {} : { runtime: identifier(parsed.runtime, "info.defaults.runtime") }),
      ...(parsed.model === undefined ? {} : { model: identifier(parsed.model, "info.defaults.model") }),
      ...(parsed.effort === undefined ? {} : { effort: identifier(parsed.effort, "info.defaults.effort") }),
    };
  }
  return {
    protocol: OPERATOR_PROTOCOL,
    agent: { id: identifier(agent.id, "info.agent.id"), label: text(agent.label, "info.agent.label", { max: 1_024 }) },
    process: { pid: integer(process.pid, "info.process.pid", 1), startedAt: timestamp(process.startedAt, "info.process.startedAt") },
    capabilities: parseOperatorCapabilities(input.capabilities, "info.capabilities"),
    ...(defaults === undefined ? {} : { defaults }),
    ...(input.models === undefined ? {} : { models: array(input.models, "info.models", model, 1_000) }),
  };
}

export function parseTurnRequest(value: unknown): OperatorTurnRequest {
  const input = record(value, "turn");
  keys(input, ["conversationId", "input", "runtime", "model", "effort", "metadata"], "turn");
  const turnInput = record(input.input, "turn.input");
  keys(turnInput, ["text", "attachments", "quote"], "turn.input");
  const parsedText = turnInput.text === undefined ? undefined : text(turnInput.text, "turn.input.text", { allowEmpty: true, max: 262_144 });
  const attachments = turnInput.attachments === undefined ? undefined : array(turnInput.attachments, "turn.input.attachments", attachment, 32);
  if ((parsedText === undefined || parsedText.length === 0) && (!attachments || attachments.length === 0)) {
    fail("turn.input", "must include non-empty text or at least one attachment");
  }
  const metadata = input.metadata === undefined ? undefined : record(jsonValue(input.metadata, "turn.metadata"), "turn.metadata");
  return {
    conversationId: identifier(input.conversationId, "turn.conversationId"),
    input: {
      ...(parsedText === undefined ? {} : { text: parsedText }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(turnInput.quote === undefined ? {} : { quote: quote(turnInput.quote, "turn.input.quote") }),
    },
    ...(input.runtime === undefined ? {} : { runtime: identifier(input.runtime, "turn.runtime") }),
    ...(input.model === undefined ? {} : { model: identifier(input.model, "turn.model") }),
    ...(input.effort === undefined ? {} : { effort: identifier(input.effort, "turn.effort") }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function usage(value: unknown, path: string): OperatorUsage {
  const input = record(value, path);
  keys(input, ["inputTokens", "outputTokens", "contextWindow", "contextUsed", "compacted", "sessionEvicted"], path);
  return {
    inputTokens: integer(input.inputTokens, `${path}.inputTokens`),
    outputTokens: integer(input.outputTokens, `${path}.outputTokens`),
    ...(input.contextWindow === undefined ? {} : { contextWindow: integer(input.contextWindow, `${path}.contextWindow`, 1) }),
    ...(input.contextUsed === undefined ? {} : { contextUsed: integer(input.contextUsed, `${path}.contextUsed`) }),
    compacted: bool(input.compacted, `${path}.compacted`),
    sessionEvicted: bool(input.sessionEvicted, `${path}.sessionEvicted`),
  };
}

function message(value: unknown, path: string): OperatorMessage {
  const input = record(value, path);
  keys(input, ["id", "role", "text", "attachments", "createdAt"], path);
  return {
    ...(input.id === undefined ? {} : { id: identifier(input.id, `${path}.id`) }),
    role: oneOf(input.role, ["user", "assistant"] as const, `${path}.role`),
    text: text(input.text, `${path}.text`, { allowEmpty: true, max: 1_048_576 }),
    ...(input.attachments === undefined ? {} : { attachments: array(input.attachments, `${path}.attachments`, attachment, 32) }),
    ...(input.createdAt === undefined ? {} : { createdAt: timestamp(input.createdAt, `${path}.createdAt`) }),
  };
}

export function parseOperatorFrame(value: unknown): OperatorFrame {
  const input = record(value, "frame");
  const type = text(input.type, "frame.type", { max: 64 });
  switch (type) {
    case "accepted":
      keys(input, ["type", "turnId", "conversationId", "startedAt"], "frame");
      return { type, turnId: identifier(input.turnId, "frame.turnId"), conversationId: identifier(input.conversationId, "frame.conversationId"), startedAt: timestamp(input.startedAt, "frame.startedAt") };
    case "delta":
      keys(input, ["type", "turnId", "target", "text", "mode"], "frame");
      return {
        type,
        turnId: identifier(input.turnId, "frame.turnId"),
        target: oneOf(input.target, ["assistant", "thought"] as const, "frame.target"),
        text: text(input.text, "frame.text", { allowEmpty: true, max: OPERATOR_LIMITS.frameBytes }),
        ...(input.mode === undefined ? {} : { mode: oneOf(input.mode, ["append", "replace"] as const, "frame.mode") }),
      };
    case "activity":
      keys(input, ["type", "turnId", "text"], "frame");
      return {
        type,
        turnId: identifier(input.turnId, "frame.turnId"),
        text: text(input.text, "frame.text", { max: OPERATOR_LIMITS.activityCharacters }),
      };
    case "tool_call":
      keys(input, ["type", "turnId", "call"], "frame");
      return {
        type,
        turnId: identifier(input.turnId, "frame.turnId"),
        call: toolCall(input.call, "frame.call"),
      };
    case "tool_result":
      keys(input, ["type", "turnId", "result"], "frame");
      return {
        type,
        turnId: identifier(input.turnId, "frame.turnId"),
        result: toolResult(input.result, "frame.result"),
      };
    case "compaction":
      keys(input, ["type", "turnId", "compaction"], "frame");
      return {
        type,
        turnId: identifier(input.turnId, "frame.turnId"),
        compaction: compaction(input.compaction, "frame.compaction"),
      };
    case "ask_user":
      keys(input, ["type", "turnId", "ask"], "frame");
      return { type, turnId: identifier(input.turnId, "frame.turnId"), ask: ask(input.ask, "frame.ask") };
    case "capabilities":
      keys(input, ["type", "turnId", "capabilities"], "frame");
      return { type, turnId: identifier(input.turnId, "frame.turnId"), capabilities: parseOperatorCapabilities(input.capabilities, "frame.capabilities") };
    case "usage":
      keys(input, ["type", "turnId", "usage"], "frame");
      return { type, turnId: identifier(input.turnId, "frame.turnId"), usage: usage(input.usage, "frame.usage") };
    case "completed": {
      keys(input, ["type", "turnId", "finalMessage", "finishedAt", "stopReason"], "frame");
      const finalMessage = message(input.finalMessage, "frame.finalMessage");
      if (finalMessage.role !== "assistant") fail("frame.finalMessage.role", "must equal assistant");
      return { type, turnId: identifier(input.turnId, "frame.turnId"), finalMessage: { ...finalMessage, role: "assistant" }, finishedAt: timestamp(input.finishedAt, "frame.finishedAt"), stopReason: oneOf(input.stopReason, ["completed", "length", "tool"] as const, "frame.stopReason") };
    }
    case "error": {
      keys(input, ["type", "turnId", "error", "cancelled", "finishedAt"], "frame");
      const error = record(input.error, "frame.error");
      keys(error, ["code", "message", "retryable"], "frame.error");
      return {
        type,
        ...(input.turnId === undefined ? {} : { turnId: identifier(input.turnId, "frame.turnId") }),
        error: { code: identifier(error.code, "frame.error.code"), message: text(error.message, "frame.error.message", { max: 16_384 }), retryable: bool(error.retryable, "frame.error.retryable") },
        cancelled: bool(input.cancelled, "frame.cancelled"),
        finishedAt: timestamp(input.finishedAt, "frame.finishedAt"),
      };
    }
    default:
      return fail("frame.type", `has unsupported value ${JSON.stringify(type)}`);
  }
}

export function serializeOperatorFrame(value: OperatorFrame): string {
  const line = `${JSON.stringify(parseOperatorFrame(value))}\n`;
  const bytes = new TextEncoder().encode(line).byteLength;
  if (bytes > OPERATOR_LIMITS.frameBytes) {
    throw new OperatorProtocolError("FRAME_TOO_LARGE", `operator frame is ${bytes} bytes; limit is ${OPERATOR_LIMITS.frameBytes}`);
  }
  return line;
}

export function parseCancelRequest(value: unknown): OperatorCancelRequest {
  const input = record(value, "cancel");
  keys(input, ["reason"], "cancel");
  return input.reason === undefined ? {} : { reason: text(input.reason, "cancel.reason", { max: 4_096 }) };
}

export function parseCancelResponse(value: unknown): OperatorCancelResponse {
  const input = record(value, "cancelResponse");
  keys(input, ["status"], "cancelResponse");
  return { status: oneOf(input.status, ["accepted", "idle", "unsupported"] as const, "cancelResponse.status") };
}

export function parseLiveInputRequest(value: unknown): OperatorLiveInputRequest {
  const input = record(value, "liveInput");
  keys(input, ["id", "text", "receivedAt"], "liveInput");
  return { id: identifier(input.id, "liveInput.id"), text: text(input.text, "liveInput.text", { max: OPERATOR_LIMITS.liveInputCharacters }), receivedAt: timestamp(input.receivedAt, "liveInput.receivedAt") };
}

export function parseLiveInputResponse(value: unknown): OperatorLiveInputResponse {
  const input = record(value, "liveInputResponse");
  keys(input, ["status"], "liveInputResponse");
  return { status: oneOf(input.status, ["applied", "requeue", "discarded", "unavailable"] as const, "liveInputResponse.status") };
}

export function parseAskSnapshot(value: unknown): OperatorAskSnapshot {
  const input = record(value, "askSnapshot");
  keys(input, ["ask"], "askSnapshot");
  return { ask: input.ask === null ? null : ask(input.ask, "askSnapshot.ask") };
}

export function parseAskAnswerRequest(value: unknown): OperatorAskAnswerRequest {
  const input = record(value, "askAnswer");
  keys(input, ["interactionId", "answers"], "askAnswer");
  const answerInput = record(input.answers, "askAnswer.answers");
  const entries = Object.entries(answerInput);
  if (entries.length < 1 || entries.length > OPERATOR_LIMITS.askQuestions) {
    fail(
      "askAnswer.answers",
      `must contain between 1 and ${OPERATOR_LIMITS.askQuestions} questions`,
    );
  }
  const answerEntries: Array<[string, readonly string[]]> = [];
  for (const [questionId, values] of entries) {
    const parsedId = identifier(questionId, "askAnswer.answers key");
    const parsedValues = array(
      values,
      `askAnswer.answers.${questionId}`,
      (item, itemPath) => contractText(item, itemPath, OPERATOR_LIMITS.askAnswerBytes),
      OPERATOR_LIMITS.askAnswerValuesPerQuestion,
    );
    if (parsedValues.length === 0) {
      fail(`askAnswer.answers.${questionId}`, "must contain at least one answer");
    }
    const unique = new Set(parsedValues);
    if (unique.size !== parsedValues.length) {
      fail(`askAnswer.answers.${questionId}`, "must contain unique answers");
    }
    answerEntries.push([parsedId, parsedValues]);
  }
  const answers = Object.fromEntries(answerEntries) as Record<string, readonly string[]>;
  return { interactionId: identifier(input.interactionId, "askAnswer.interactionId"), answers };
}

export function parseAskAnswerResponse(value: unknown): OperatorAskAnswerResponse {
  const input = record(value, "askAnswerResponse");
  keys(input, ["status"], "askAnswerResponse");
  return { status: oneOf(input.status, ["accepted", "expired", "mismatch"] as const, "askAnswerResponse.status") };
}

function conversationSummary(value: unknown, path: string): OperatorConversationSummary {
  const input = record(value, path);
  keys(input, ["id", "title", "updatedAt", "activeTurnId"], path);
  return {
    id: identifier(input.id, `${path}.id`),
    ...(input.title === undefined ? {} : { title: text(input.title, `${path}.title`, { max: 4_096 }) }),
    updatedAt: timestamp(input.updatedAt, `${path}.updatedAt`),
    ...(input.activeTurnId === undefined ? {} : { activeTurnId: identifier(input.activeTurnId, `${path}.activeTurnId`) }),
  };
}

export function parseConversationList(value: unknown): OperatorConversationList {
  const input = record(value, "conversationList");
  keys(input, ["conversations"], "conversationList");
  return { conversations: array(input.conversations, "conversationList.conversations", conversationSummary, 10_000) };
}

export function parseReplayResponse(value: unknown): OperatorReplayResponse {
  const input = record(value, "replay");
  keys(input, ["conversationId", "messages", "activeTurnId"], "replay");
  return {
    conversationId: identifier(input.conversationId, "replay.conversationId"),
    messages: array(input.messages, "replay.messages", message, 100_000),
    ...(input.activeTurnId === undefined ? {} : { activeTurnId: identifier(input.activeTurnId, "replay.activeTurnId") }),
  };
}

export function parseConfigView(value: unknown): OperatorConfigView {
  const input = record(value, "config");
  keys(input, ["revision", "generatedAt", "value", "redacted"], "config");
  if (input.redacted !== true) fail("config.redacted", "must equal true");
  return { revision: identifier(input.revision, "config.revision"), generatedAt: timestamp(input.generatedAt, "config.generatedAt"), value: record(jsonValue(input.value, "config.value"), "config.value"), redacted: true };
}

export function parseHealth(value: unknown): OperatorHealth {
  const input = record(value, "health");
  keys(input, ["status", "checkedAt", "details"], "health");
  return {
    status: oneOf(input.status, ["healthy", "degraded", "unhealthy"] as const, "health.status"),
    checkedAt: timestamp(input.checkedAt, "health.checkedAt"),
    details: array(input.details, "health.details", (value, path) => {
      const detail = record(value, path);
      keys(detail, ["id", "status", "message"], path);
      return {
        id: identifier(detail.id, `${path}.id`),
        status: oneOf(detail.status, ["healthy", "degraded", "unhealthy"] as const, `${path}.status`),
        ...(detail.message === undefined ? {} : { message: text(detail.message, `${path}.message`, { max: 8_192 }) }),
      };
    }, 1_000),
  };
}

/** Explicit public alias used by protocol servers. */
export const parseOperatorHealth = parseHealth;

export function parseRegistryDescriptor(value: unknown): OperatorRegistryDescriptor {
  const input = record(value, "registry");
  keys(input, ["schema", "agent", "operator", "pid", "startedAt", "heartbeatAt", "capabilities"], "registry");
  if (input.schema !== OPERATOR_REGISTRY_SCHEMA) fail("registry.schema", `must equal ${OPERATOR_REGISTRY_SCHEMA}`);
  const agent = record(input.agent, "registry.agent");
  keys(agent, ["id", "label"], "registry.agent");
  const operator = record(input.operator, "registry.operator");
  keys(operator, ["endpoint", "tokenEnvironment"], "registry.operator");
  return {
    schema: OPERATOR_REGISTRY_SCHEMA,
    agent: { id: identifier(agent.id, "registry.agent.id"), label: text(agent.label, "registry.agent.label", { max: 1_024 }) },
    operator: {
      endpoint: text(operator.endpoint, "registry.operator.endpoint", { max: 8_192 }),
      ...(operator.tokenEnvironment === undefined ? {} : { tokenEnvironment: environmentName(operator.tokenEnvironment, "registry.operator.tokenEnvironment") }),
    },
    pid: integer(input.pid, "registry.pid", 1),
    startedAt: timestamp(input.startedAt, "registry.startedAt"),
    heartbeatAt: timestamp(input.heartbeatAt, "registry.heartbeatAt"),
    ...(input.capabilities === undefined ? {} : { capabilities: parseOperatorCapabilities(input.capabilities, "registry.capabilities") }),
  };
}
