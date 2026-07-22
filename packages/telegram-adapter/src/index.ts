export type {
  TelegramBotApi,
  TelegramChat,
  TelegramChatId,
  TelegramDeleteWebhookParams,
  TelegramDeleteMessageParams,
  TelegramDocument,
  TelegramEditMessageTextParams,
  TelegramAudio,
  TelegramFileReference,
  TelegramGetUpdatesParams,
  TelegramMessage,
  TelegramMessageSender,
  TelegramPhotoSize,
  TelegramRequestOptions,
  TelegramSendDocumentParams,
  TelegramSendMessageParams,
  TelegramSendPhotoParams,
  TelegramSentMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVideo,
  TelegramVideoNote,
  TelegramVoice,
} from "./types.js";

export { TelegramApiError } from "./telegram-error.js";
export type {
  TelegramApiErrorDetails,
  TelegramApiErrorKind,
} from "./telegram-error.js";

export {
  TelegramDeliveryError,
  TelegramMessageStream,
  classifyTelegramError,
} from "./message-stream.js";
export type {
  AgentMessageStream,
  TelegramMessageStreamLogger,
  TelegramMessageStreamOptions,
  TelegramSendOutcome,
} from "./message-stream.js";

export { renderTelegramMarkdown } from "./telegram-markdown.js";
export { createGrammyTelegramApi, createTelegramMessageSender } from "./grammy-client.js";

export {
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  agentAttachmentKindFromMimeType,
  decodeAgentAttachmentText,
} from "@mono-agent/agent-contracts";

export {
  TELEGRAM_REPLY_CALLBACK_PREFIX,
  TELEGRAM_REPLY_MAX_OPTIONS,
  isTelegramReplyCallbackData,
  telegramReplyCallbackData,
} from "./reply-options.js";

export {
  parseTelegramAskUserCallbackData,
  telegramAskUserCallbackData,
} from "./ask-user.js";
export type { TelegramAskUserAction, TelegramAskUserCallback } from "./ask-user.js";

export { createTelegramBot } from "./bot.js";
export type {
  CreateTelegramBotOptions,
  TelegramBotController,
} from "./bot.js";

export {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
  TELEGRAM_TRANSCRIPTION_UNAVAILABLE_NOTE,
  downloadTelegramAttachments,
} from "./adapter.js";
export type {
  AgentRequest,
  AgentResponder,
  AgentResponse,
  DownloadTelegramAttachmentsOptions,
  TelegramFileDownloader,
  TelegramAgentMessageInput,
  TelegramAttachment,
  TelegramAttachmentBase,
  TelegramAttachmentKind,
  TelegramAdapterErrorText,
  TelegramAdapterErrorTextInput,
  TelegramAudioAttachment,
  TelegramDocumentAttachment,
  TelegramAdapterLogger,
  TelegramAdapterMessages,
  TelegramAdapterStreamOptions,
  TelegramPhotoAttachment,
  TelegramPhotoAttachmentSize,
  TelegramRequestMetadata,
  TelegramVideoAttachment,
  TelegramVideoNoteAttachment,
  TelegramVoiceAttachment,
} from "./adapter.js";

export { createOpenAiTranscriber } from "./transcription.js";
export type {
  TelegramTranscriber,
  TelegramTranscriptionConfig,
} from "./transcription.js";

export { startTelegramAdapter } from "./start.js";
export type {
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
} from "./start.js";

export type {
  TelegramRuntimeControls,
  TelegramRuntimeEffortOption,
  TelegramRuntimeModelOption,
} from "./bot.js";

export {
  isWithinQuietHours,
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  TELEGRAM_CONFIG_FIELDS,
  TelegramAdapterConfigError,
} from "./config.js";
export type {
  LoadTelegramAdapterConfigInput,
  RedactedTelegramAdapterConfig,
  TelegramAdapterConfig,
  TelegramAdapterConfigErrorCode,
  TelegramAdapterConfigErrorDetails,
  TelegramAttachmentsConfig,
  TelegramCommandConfig,
  TelegramQuietHours,
  TelegramReactionsConfig,
  TelegramSendToolsConfig,
} from "./config.js";
