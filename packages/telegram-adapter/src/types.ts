export type TelegramChatId = number | string;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  /** Set on each message of a multi-photo/video album; shared across the group. */
  media_group_id?: string;
  animation?: unknown;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  audio?: TelegramAudio;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  voice?: TelegramVoice;
  [key: string]: unknown;
}

export interface TelegramFileReference {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

export interface TelegramPhotoSize extends TelegramFileReference {
  width: number;
  height: number;
}

export interface TelegramDocument extends TelegramFileReference {
  file_name?: string;
  mime_type?: string;
}

export interface TelegramAudio extends TelegramFileReference {
  duration: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVideo extends TelegramFileReference {
  duration: number;
  width: number;
  height: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVoice extends TelegramFileReference {
  duration: number;
  mime_type?: string;
}

/**
 * A round video message. The Bot API `VideoNote` object carries no `mime_type`
 * or `file_name` (unlike `Video`); `length` is the width/height of the square
 * video in pixels and `duration` is its length in seconds.
 */
export interface TelegramVideoNote extends TelegramFileReference {
  duration: number;
  length: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  [key: string]: unknown;
}

export type TelegramSentMessage = TelegramMessage;

export interface TelegramRequestOptions {
  signal?: AbortSignal;
}

/** A single inline-keyboard button. Only the subset of fields we emit. */
export interface TelegramInlineKeyboardButton {
  text: string;
  /** Opaque payload (<= 64 bytes) echoed back on tap as a `callback_query`. */
  callback_data?: string;
  url?: string;
}

/** Inline keyboard attached to a message via `reply_markup`. */
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramSendMessageParams {
  chat_id: TelegramChatId;
  text: string;
  parse_mode?: string;
  reply_to_message_id?: number;
  /** Deliver even if the referenced reply parent was deleted before this send. */
  allow_sending_without_reply?: boolean;
  disable_web_page_preview?: boolean;
  /** Send silently — message arrives without a push notification sound. */
  disable_notification?: boolean;
  /** Inline keyboard to attach below the message. */
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSendChatActionParams {
  chat_id: TelegramChatId;
  /** Telegram chat action, e.g. "typing". */
  action: string;
}

export interface TelegramSendDocumentParams {
  chat_id: TelegramChatId;
  /**
   * Raw file bytes to upload, OR a string passed through to the server
   * untouched: a file_id, an HTTP URL, or a `file://` URI (accepted by a
   * `--local` self-hosted Bot API server — no multipart upload, no buffering).
   */
  document: Uint8Array | string;
  /** Filename shown to the recipient. Ignored for string documents (the server derives it). */
  filename?: string;
  caption?: string;
}

export interface TelegramSendPhotoParams {
  chat_id: TelegramChatId;
  /** Raw image bytes to upload. */
  photo: Uint8Array;
  filename?: string;
  caption?: string;
}

/** An emoji reaction. `emoji` must be one of Telegram's allowed reaction emojis. */
export interface TelegramReaction {
  type: "emoji";
  emoji: string;
}

export interface TelegramSetMessageReactionParams {
  chat_id: TelegramChatId;
  message_id: number;
  /** The reaction to set; an empty array clears the bot's reaction. */
  reaction: TelegramReaction[];
}

export interface TelegramEditMessageTextParams {
  chat_id?: TelegramChatId;
  message_id?: number;
  inline_message_id?: string;
  text: string;
  parse_mode?: string;
  disable_web_page_preview?: boolean;
  /**
   * Inline keyboard to keep (or replace) on the edited message. Telegram drops an
   * existing keyboard on `editMessageText` unless it is re-sent here.
   */
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramDeleteMessageParams {
  chat_id: TelegramChatId;
  message_id: number;
}

export interface TelegramGetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface TelegramDeleteWebhookParams {
  drop_pending_updates?: boolean;
}

/**
 * The minimal Telegram surface the streaming delivery layer needs: sending a
 * message and editing it in place. Update polling lives in the grammY runner, so
 * the delivery layer depends only on these two calls.
 */
export interface TelegramMessageSender {
  sendMessage(
    params: TelegramSendMessageParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage>;
  editMessageText(
    params: TelegramEditMessageTextParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage | true>;
  /** Optional for custom clients; built-in clients use it to clear transient status. */
  deleteMessage?(
    params: TelegramDeleteMessageParams,
    options?: TelegramRequestOptions,
  ): Promise<true>;
  /** Optional: surface a transient chat action such as "typing". Best-effort. */
  sendChatAction?(
    params: TelegramSendChatActionParams,
    options?: TelegramRequestOptions,
  ): Promise<true>;
  /** Optional: set (or clear) the bot's emoji reaction on a message. Best-effort. */
  setMessageReaction?(
    params: TelegramSetMessageReactionParams,
    options?: TelegramRequestOptions,
  ): Promise<true>;
  /** Optional: upload and send a document (any file) to a chat. */
  sendDocument?(
    params: TelegramSendDocumentParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage>;
  /** Optional: upload and send a photo (shown inline) to a chat. */
  sendPhoto?(
    params: TelegramSendPhotoParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage>;
}

export interface TelegramBotApi extends TelegramMessageSender {
  getUpdates(
    params: TelegramGetUpdatesParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramUpdate[]>;
  deleteWebhook?(
    params?: TelegramDeleteWebhookParams,
    options?: TelegramRequestOptions,
  ): Promise<true>;
}
