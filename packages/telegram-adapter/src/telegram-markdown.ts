import telegramify from "telegramify-markdown";

/**
 * Render a Markdown string into the MarkdownV2 dialect Telegram accepts with
 * `parse_mode: "MarkdownV2"`.
 *
 * Delegates to `telegramify-markdown`, which parses Markdown with remark and
 * re-serializes it as MarkdownV2 with every reserved character escaped. Unlike a
 * regex converter it cannot emit overlapping or unbalanced entities that
 * Telegram's parser rejects, so the stream's plain-text fallback is reserved for
 * genuinely exceptional input rather than ordinary formatting.
 *
 * The `"escape"` strategy keeps constructs Telegram cannot render (e.g. tables)
 * as escaped literal text instead of dropping them. telegramify appends a
 * trailing newline; it is stripped so callers receive the trimmed shape the rest
 * of the delivery pipeline expects.
 */
export function renderTelegramMarkdown(markdown: string): string {
  return telegramify(markdown, "escape").replace(/\n+$/u, "");
}
