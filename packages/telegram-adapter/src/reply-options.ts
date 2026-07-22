/** Callback protocol for non-blocking `TelegramSendMessage.reply_options`. */
export const TELEGRAM_REPLY_CALLBACK_PREFIX = "reply:v1:";

export const TELEGRAM_REPLY_MAX_OPTIONS = 8;

export function telegramReplyCallbackData(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= TELEGRAM_REPLY_MAX_OPTIONS) {
    throw new RangeError(`Telegram reply option index must be between 0 and ${String(TELEGRAM_REPLY_MAX_OPTIONS - 1)}.`);
  }
  return `${TELEGRAM_REPLY_CALLBACK_PREFIX}${String(index)}`;
}

export function isTelegramReplyCallbackData(data: string): boolean {
  const rawIndex = data.startsWith(TELEGRAM_REPLY_CALLBACK_PREFIX)
    ? data.slice(TELEGRAM_REPLY_CALLBACK_PREFIX.length)
    : "";
  return /^[0-7]$/u.test(rawIndex);
}
