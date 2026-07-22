import {
  Bot,
  GrammyError,
  HttpError,
  InputFile,
  type Api,
  type ApiClientOptions,
} from "grammy";

import {
  TelegramApiError,
  type TelegramApiErrorDetails,
} from "./telegram-error.js";
import type {
  TelegramEditMessageTextParams,
  TelegramDeleteMessageParams,
  TelegramMessageSender,
  TelegramRequestOptions,
  TelegramSendChatActionParams,
  TelegramSendDocumentParams,
  TelegramSendMessageParams,
  TelegramSendPhotoParams,
  TelegramSentMessage,
  TelegramSetMessageReactionParams,
} from "./types.js";

type SendOther = NonNullable<Parameters<Api["sendMessage"]>[2]>;
type EditOther = NonNullable<Parameters<Api["editMessageText"]>[3]>;

// grammY's `Api` types its `signal` parameter with the `abort-controller` shim's
// AbortSignal rather than the global one; the runtime value is identical, so we
// cast through this helper at the call boundary.
function asGrammySignal(signal: AbortSignal | undefined): Parameters<Api["sendMessage"]>[3] {
  return signal as unknown as Parameters<Api["sendMessage"]>[3];
}

/**
 * Adapt a grammY {@link Api} to the {@link TelegramMessageSender} the streaming
 * delivery layer depends on.
 *
 * Two responsibilities: translate our params-object calls into grammY's
 * positional `(chat_id, text, other, signal)` form, and translate grammY's
 * thrown errors (`GrammyError`, `HttpError`) back into {@link TelegramApiError}
 * so the existing recovery policy (`classifyTelegramError`) keeps working
 * unchanged.
 */
export function createGrammyTelegramApi(api: Api): TelegramMessageSender {
  return {
    async sendMessage(
      params: TelegramSendMessageParams,
      options?: TelegramRequestOptions,
    ): Promise<TelegramSentMessage> {
      try {
        const message = await api.sendMessage(
          params.chat_id,
          params.text,
          buildSendOther(params),
          asGrammySignal(options?.signal),
        );
        return message as unknown as TelegramSentMessage;
      } catch (error) {
        throw toTelegramApiError("sendMessage", error, options?.signal);
      }
    },

    async editMessageText(
      params: TelegramEditMessageTextParams,
      options?: TelegramRequestOptions,
    ): Promise<TelegramSentMessage | true> {
      try {
        if (params.inline_message_id !== undefined) {
          const result = await api.editMessageTextInline(
            params.inline_message_id,
            params.text,
            buildEditOther(params),
            asGrammySignal(options?.signal),
          );
          return result === true ? true : (result as unknown as TelegramSentMessage);
        }
        if (params.chat_id !== undefined && params.message_id !== undefined) {
          const result = await api.editMessageText(
            params.chat_id,
            params.message_id,
            params.text,
            buildEditOther(params),
            asGrammySignal(options?.signal),
          );
          return result === true ? true : (result as unknown as TelegramSentMessage);
        }
      } catch (error) {
        throw toTelegramApiError("editMessageText", error, options?.signal);
      }
      throw new TelegramApiError(
        "grammY editMessageText requires inline_message_id, or chat_id and message_id.",
        { kind: "telegram", method: "editMessageText" },
      );
    },

    async deleteMessage(
      params: TelegramDeleteMessageParams,
      options?: TelegramRequestOptions,
    ): Promise<true> {
      try {
        await api.deleteMessage(
          params.chat_id,
          params.message_id,
          asGrammySignal(options?.signal),
        );
        return true;
      } catch (error) {
        throw toTelegramApiError("deleteMessage", error, options?.signal);
      }
    },

    async sendChatAction(
      params: TelegramSendChatActionParams,
      options?: TelegramRequestOptions,
    ): Promise<true> {
      try {
        await api.sendChatAction(
          params.chat_id,
          params.action as Parameters<Api["sendChatAction"]>[1],
          {},
          asGrammySignal(options?.signal),
        );
        return true;
      } catch (error) {
        throw toTelegramApiError("sendChatAction", error, options?.signal);
      }
    },

    async setMessageReaction(
      params: TelegramSetMessageReactionParams,
      options?: TelegramRequestOptions,
    ): Promise<true> {
      try {
        await api.setMessageReaction(
          params.chat_id,
          params.message_id,
          params.reaction as Parameters<Api["setMessageReaction"]>[2],
          {},
          asGrammySignal(options?.signal) as Parameters<Api["setMessageReaction"]>[4],
        );
        return true;
      } catch (error) {
        throw toTelegramApiError("setMessageReaction", error, options?.signal);
      }
    },

    async sendDocument(
      params: TelegramSendDocumentParams,
      options?: TelegramRequestOptions,
    ): Promise<TelegramSentMessage> {
      try {
        // A string document (file_id, URL, or a file:// URI against a --local
        // self-hosted server) is passed through untouched — grammY serializes it
        // into the JSON payload with no multipart upload or buffering.
        const document =
          typeof params.document === "string"
            ? params.document
            : new InputFile(params.document, params.filename);
        const message = await api.sendDocument(
          params.chat_id,
          document,
          params.caption === undefined ? {} : { caption: params.caption },
          asGrammySignal(options?.signal),
        );
        return message as unknown as TelegramSentMessage;
      } catch (error) {
        throw toTelegramApiError("sendDocument", error, options?.signal);
      }
    },

    async sendPhoto(
      params: TelegramSendPhotoParams,
      options?: TelegramRequestOptions,
    ): Promise<TelegramSentMessage> {
      try {
        const photo =
          params.filename === undefined
            ? new InputFile(params.photo)
            : new InputFile(params.photo, params.filename);
        const message = await api.sendPhoto(
          params.chat_id,
          photo,
          params.caption === undefined ? {} : { caption: params.caption },
          asGrammySignal(options?.signal),
        );
        return message as unknown as TelegramSentMessage;
      } catch (error) {
        throw toTelegramApiError("sendPhoto", error, options?.signal);
      }
    },
  };
}

export function createTelegramMessageSender(
  botToken: string,
  options?: {
    readonly apiRoot?: string;
    readonly fetchImpl?: ApiClientOptions["fetch"];
  },
): TelegramMessageSender {
  const token = botToken.trim();
  if (token.length === 0) {
    throw new TypeError("Telegram bot token is required.");
  }
  // apiRoot and fetchImpl must reach the same Bot client construction — this
  // sender feeds the send tools, which may use a self-hosted API root and/or an
  // app-owned transport seam. With neither option, preserve grammY's untouched
  // default client (including its default node-fetch implementation).
  const hasClientOptions = options?.apiRoot !== undefined || options?.fetchImpl !== undefined;
  const client: ApiClientOptions = {
    ...(options?.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
    ...(options?.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
  };
  const bot = hasClientOptions ? new Bot(token, { client }) : new Bot(token);
  return createGrammyTelegramApi(bot.api);
}

function buildSendOther(params: TelegramSendMessageParams): SendOther {
  const other: SendOther = {};
  if (params.parse_mode !== undefined) {
    other.parse_mode = params.parse_mode as NonNullable<SendOther["parse_mode"]>;
  }
  if (params.reply_to_message_id !== undefined) {
    other.reply_parameters = {
      message_id: params.reply_to_message_id,
      ...(params.allow_sending_without_reply === undefined
        ? {}
        : { allow_sending_without_reply: params.allow_sending_without_reply }),
    };
  }
  if (params.disable_web_page_preview !== undefined) {
    other.link_preview_options = { is_disabled: params.disable_web_page_preview };
  }
  if (params.disable_notification !== undefined) {
    other.disable_notification = params.disable_notification;
  }
  if (params.reply_markup !== undefined) {
    other.reply_markup = params.reply_markup as NonNullable<SendOther["reply_markup"]>;
  }
  return other;
}

function buildEditOther(params: TelegramEditMessageTextParams): EditOther {
  const other: EditOther = {};
  if (params.parse_mode !== undefined) {
    other.parse_mode = params.parse_mode as NonNullable<EditOther["parse_mode"]>;
  }
  if (params.disable_web_page_preview !== undefined) {
    other.link_preview_options = { is_disabled: params.disable_web_page_preview };
  }
  if (params.reply_markup !== undefined) {
    other.reply_markup = params.reply_markup as NonNullable<EditOther["reply_markup"]>;
  }
  return other;
}

function toTelegramApiError(
  method: string,
  error: unknown,
  signal: AbortSignal | undefined,
): TelegramApiError {
  if (error instanceof TelegramApiError) {
    return error;
  }
  if (signal?.aborted === true || isAbortError(error)) {
    return new TelegramApiError(`Telegram API ${method} request was aborted.`, {
      kind: "aborted",
      method,
    });
  }
  if (error instanceof GrammyError) {
    const details: TelegramApiErrorDetails = {
      kind: "telegram",
      method,
      errorCode: error.error_code,
      telegramDescription: error.description,
    };
    const retryAfter = error.parameters.retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      details.retryAfterMs = Math.max(0, retryAfter) * 1000;
    }
    return new TelegramApiError(`Telegram API ${method} rejected the request.`, details);
  }
  if (error instanceof HttpError) {
    return new TelegramApiError(
      `Network failure while calling Telegram API ${method}.`,
      { kind: "network", method, cause: error },
    );
  }
  return new TelegramApiError(
    `Unexpected failure while calling Telegram API ${method}.`,
    { kind: "network", method, cause: error },
  );
}

function isAbortError(value: unknown): boolean {
  return (
    (value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}
