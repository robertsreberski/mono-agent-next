export type {
  AgentRequest,
  AgentResponder,
  AgentResponse,
  WhatsAppAdapterIgnoredReason,
  WhatsAppAdapterLogger,
  WhatsAppAdapterMessages,
  WhatsAppAdapterOptions,
  WhatsAppAdapterStreamOptions,
  WhatsAppGroupTriggerMode,
  WhatsAppMessageHandlingResult,
  WhatsAppRequestMetadata,
  WhatsAppTriggerKind,
  WhatsAppTriggerOptions,
} from "./adapter.js";
export { WhatsAppAdapter } from "./adapter.js";

export type {
  WhatsAppMessageIgnoredReason,
  WhatsAppMessageNormalizationResult,
} from "./message-normalizer.js";
export { isGroupJid, normalizeWhatsAppMessage } from "./message-normalizer.js";

export type { AgentMessageStream } from "@mono-agent/agent-contracts";
export type {
  WhatsAppMessageStreamLogger,
  WhatsAppMessageStreamOptions,
} from "./message-stream.js";
export { WhatsAppMessageStream } from "./message-stream.js";

export {
  loadWhatsAppAdapterConfig,
  redactWhatsAppAdapterConfig,
  WHATSAPP_CONFIG_FIELDS,
  WhatsAppAdapterConfigError,
} from "./config.js";
export type {
  LoadWhatsAppAdapterConfigInput,
  RedactedWhatsAppAdapterConfig,
  WhatsAppAdapterConfig,
  WhatsAppAdapterConfigErrorCode,
  WhatsAppAdapterConfigErrorDetails,
} from "./config.js";

export type {
  LongLike,
  WhatsAppChatKind,
  WhatsAppContextInfoLike,
  WhatsAppEventEmitterLike,
  WhatsAppJid,
  WhatsAppMessageContentLike,
  WhatsAppMessageKeyLike,
  WhatsAppRawMessage,
  WhatsAppSendMessageContent,
  WhatsAppSendMessageOptions,
  WhatsAppSentMessage,
  WhatsAppSocketLike,
  WhatsAppTextMessage,
} from "./types.js";

export type {
  BaileysWhatsAppSocket,
  BaileysWhatsAppSocketOptions,
} from "./baileys-socket.js";
export { createBaileysWhatsAppSocket } from "./baileys-socket.js";

export type {
  WhatsAppConnectionUpdate,
  WhatsAppEventRunnerLogger,
  WhatsAppEventRunnerOptions,
  WhatsAppEventRunnerStartOptions,
} from "./event-runner.js";
export { WhatsAppEventRunner } from "./event-runner.js";

export { startWhatsAppAdapter } from "./start.js";
export type {
  StartWhatsAppAdapterOptions,
  WhatsAppAdapterStartLogger,
  WhatsAppAdapterStartResult,
  WhatsAppSocketFactory,
} from "./start.js";

export {
  createChannelDriver,
  createWhatsAppChannelDriver,
} from "./channel-driver.js";
export type {
  WhatsAppChannelDriverConfig,
  WhatsAppChannelDriverOptions,
} from "./channel-driver.js";
