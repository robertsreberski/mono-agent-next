// SPDX-License-Identifier: MIT

export class TelegramBotApiError extends Error {
  readonly code = "telegram_bot_api_error";

  constructor(
    readonly method: string,
    readonly statusCode: number,
  ) {
    super(`Telegram API ${method} failed with HTTP ${String(statusCode)}.`);
    this.name = "TelegramBotApiError";
  }
}

export interface FatalTelegramPollingFailure {
  readonly statusCode: 401 | 403 | 409;
  readonly summary: string;
}

export function fatalTelegramPollingFailure(error: unknown): FatalTelegramPollingFailure | undefined {
  if (!(error instanceof TelegramBotApiError) || error.method !== "getUpdates") return undefined;
  switch (error.statusCode) {
    case 401:
      return {
        statusCode: 401,
        summary: "Telegram polling stopped: Bot API authentication failed (HTTP 401). Check the configured bot token.",
      };
    case 403:
      return {
        statusCode: 403,
        summary: "Telegram polling stopped: Bot API access is forbidden (HTTP 403). Check the bot authorization and chat access.",
      };
    case 409:
      return {
        statusCode: 409,
        summary: "Telegram polling stopped: another poller or webhook owns this bot (HTTP 409). "
          + "Stop the conflicting consumer before restarting.",
      };
    default:
      return undefined;
  }
}
