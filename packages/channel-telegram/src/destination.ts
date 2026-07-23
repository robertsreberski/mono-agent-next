export function parseTelegramChatId(
  value: unknown,
  label: string,
  allowInteger = false,
): string {
  if (allowInteger && typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${label} must be a safe integer or string.`);
    }
    value = String(value);
  }
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || /[\s:\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be one bounded Telegram chat identifier.`);
  }
  return value;
}

export function resolveTelegramChatId(
  conversationId: string,
  fallback: string | undefined,
): string | undefined {
  const value = conversationId.startsWith("telegram:")
    ? conversationId.slice("telegram:".length)
    : conversationId.length === 0
      ? fallback
      : undefined;
  if (value === undefined) return undefined;
  try {
    return parseTelegramChatId(value, "Telegram destination");
  } catch {
    return undefined;
  }
}

export function telegramConversationId(chatId: string): string {
  return `telegram:${parseTelegramChatId(chatId, "Telegram chat id")}`;
}
