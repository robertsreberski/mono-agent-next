export const OPERATOR_PROTOCOL = "mono-agent.operator.v1" as const;
export const OPERATOR_REGISTRY_SCHEMA = "mono-agent.operator-registry.v1" as const;

export const OPERATOR_ROUTES = Object.freeze({
  info: "/v1/info",
  turns: "/v1/turns",
  config: "/v1/config",
  health: "/v1/health",
  conversations: "/v1/conversations",
  ask: (conversationId: string) => `/v1/conversations/${encodeURIComponent(conversationId)}/ask`,
  cancel: (conversationId: string) => `/v1/conversations/${encodeURIComponent(conversationId)}/cancel`,
  liveInput: (conversationId: string) => `/v1/conversations/${encodeURIComponent(conversationId)}/live-input`,
  replay: (conversationId: string) => `/v1/conversations/${encodeURIComponent(conversationId)}/replay`,
});

export const OPERATOR_LIMITS = Object.freeze({
  requestBytes: 1_048_576,
  jsonResponseBytes: 1_048_576,
  frameBytes: 262_144,
  streamBytes: 8_388_608,
  liveInputCharacters: 8_000,
  identifierCharacters: 256,
});

export interface OperatorAttachment {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes?: number;
  url?: string;
}

export interface OperatorQuote {
  conversationId: string;
  messageId: string;
  text?: string;
}

export interface OperatorCapabilities {
  attachments: boolean;
  liveInput: boolean;
  askUser: boolean;
  cancellation: boolean;
  quotes: boolean;
  runtimeOverrides: boolean;
  proactive: boolean;
  configView: boolean;
  replay: boolean;
  health: boolean;
}

export interface OperatorModel {
  id: string;
  label?: string;
  efforts?: readonly string[];
  contextWindow?: number;
}

export interface OperatorInfo {
  protocol: typeof OPERATOR_PROTOCOL;
  agent: {
    id: string;
    label: string;
  };
  process: {
    pid: number;
    startedAt: string;
  };
  capabilities: OperatorCapabilities;
  defaults?: {
    runtime?: string;
    model?: string;
    effort?: string;
  };
  models?: readonly OperatorModel[];
}

export interface OperatorTurnRequest {
  conversationId: string;
  input: {
    text?: string;
    attachments?: readonly OperatorAttachment[];
    quote?: OperatorQuote;
  };
  runtime?: string;
  model?: string;
  effort?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface OperatorQuestionChoice {
  value: string;
  label: string;
  description?: string;
}

export interface OperatorQuestion {
  id: string;
  prompt: string;
  choices?: readonly OperatorQuestionChoice[];
  allowFreeText: boolean;
  multiple: boolean;
}

export interface OperatorAsk {
  interactionId: string;
  questions: readonly OperatorQuestion[];
  requestedAt: string;
}

export interface OperatorUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindow?: number;
  contextUsed?: number;
  compacted: boolean;
  sessionEvicted: boolean;
}

export interface OperatorAcceptedFrame {
  type: "accepted";
  turnId: string;
  conversationId: string;
  startedAt: string;
}

export interface OperatorDeltaFrame {
  type: "delta";
  turnId: string;
  target: "assistant" | "thought";
  text: string;
  mode?: "append" | "replace";
}

export interface OperatorActivityFrame {
  type: "activity";
  turnId: string;
  text: string;
}

export interface OperatorAskUserFrame {
  type: "ask_user";
  turnId: string;
  ask: OperatorAsk;
}

export interface OperatorCapabilitiesFrame {
  type: "capabilities";
  turnId: string;
  capabilities: OperatorCapabilities;
}

export interface OperatorUsageFrame {
  type: "usage";
  turnId: string;
  usage: OperatorUsage;
}

export interface OperatorMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  attachments?: readonly OperatorAttachment[];
  createdAt?: string;
}

export interface OperatorCompletedFrame {
  type: "completed";
  turnId: string;
  finalMessage: OperatorMessage & { role: "assistant" };
  finishedAt: string;
  stopReason: "completed" | "length" | "tool";
}

export interface OperatorWireError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface OperatorErrorFrame {
  type: "error";
  turnId?: string;
  error: OperatorWireError;
  cancelled: boolean;
  finishedAt: string;
}

export type OperatorFrame =
  | OperatorAcceptedFrame
  | OperatorDeltaFrame
  | OperatorActivityFrame
  | OperatorAskUserFrame
  | OperatorCapabilitiesFrame
  | OperatorUsageFrame
  | OperatorCompletedFrame
  | OperatorErrorFrame;

export type OperatorTerminalFrame = OperatorCompletedFrame | OperatorErrorFrame;

export interface OperatorCancelRequest {
  reason?: string;
}

export interface OperatorCancelResponse {
  status: "accepted" | "idle" | "unsupported";
}

export interface OperatorLiveInputRequest {
  id: string;
  text: string;
  receivedAt: string;
}

export interface OperatorLiveInputResponse {
  status: "applied" | "requeue" | "discarded" | "unavailable";
}

export interface OperatorAskSnapshot {
  ask: OperatorAsk | null;
}

export interface OperatorAskAnswerRequest {
  interactionId: string;
  answers: Readonly<Record<string, readonly string[]>>;
}

export interface OperatorAskAnswerResponse {
  status: "accepted" | "expired" | "mismatch";
}

export interface OperatorConversationSummary {
  id: string;
  title?: string;
  updatedAt: string;
  activeTurnId?: string;
}

export interface OperatorConversationList {
  conversations: readonly OperatorConversationSummary[];
}

export interface OperatorReplayResponse {
  conversationId: string;
  messages: readonly OperatorMessage[];
  activeTurnId?: string;
}

export interface OperatorConfigView {
  revision: string;
  generatedAt: string;
  value: Readonly<Record<string, unknown>>;
  redacted: true;
}

export interface OperatorHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: string;
  details: readonly {
    id: string;
    status: "healthy" | "degraded" | "unhealthy";
    message?: string;
  }[];
}

export interface OperatorRegistryDescriptor {
  schema: typeof OPERATOR_REGISTRY_SCHEMA;
  agent: {
    id: string;
    label: string;
  };
  operator: {
    endpoint: string;
    tokenEnvironment?: string;
  };
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  capabilities?: OperatorCapabilities;
}

export interface DiscoveredOperator {
  id: string;
  label: string;
  endpoint: string;
  tokenEnvironment?: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  stale: boolean;
  sourcePath: string;
  capabilities?: OperatorCapabilities;
}
