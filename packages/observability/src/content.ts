import { isRecord } from "./guards.js";

/**
 * Shared content-shaping helpers for run-event summaries. Both the recorded-run
 * reader and the timeline combiner classify the same assistant message blocks
 * and compact the same way, so the kind-walk and the truncation live here once.
 */

export const SUMMARY_MAX_CHARS = 220;

export type AssistantContentKind = "thinking" | "text";

export interface AssistantContentWalk {
  readonly kind: AssistantContentKind;
  /** Concatenated block text, when any block carried text; otherwise undefined. */
  readonly text: string | undefined;
}

/** Collapse whitespace and bound a summary string to {@link SUMMARY_MAX_CHARS} characters. */
export function compactString(value: string, maxChars = SUMMARY_MAX_CHARS): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars)}…`;
}

/**
 * Walk an assistant `message` object's content blocks and report a single
 * content kind, or `undefined` when the content is empty, mixed
 * (thinking + text), or contains any non-text/thinking block. The walk also
 * collects block text so streaming callers can join adjacent chunks.
 */
export function classifyAssistantContent(message: unknown): AssistantContentWalk | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }

  let kind: AssistantContentKind | undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || (block.type !== "thinking" && block.type !== "text")) {
      return undefined;
    }
    if (kind === undefined) {
      kind = block.type;
    } else if (kind !== block.type) {
      return undefined;
    }
    const text = blockText(block, block.type);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  if (kind === undefined) {
    return undefined;
  }
  return {
    kind,
    text: texts.length > 0 ? texts.join("") : undefined,
  };
}

function blockText(block: Record<string, unknown>, kind: AssistantContentKind): string | undefined {
  const value = kind === "thinking"
    ? rawStringField(block, "thinking") ?? rawStringField(block, "text") ?? rawStringField(block, "content")
    : rawStringField(block, "text") ?? rawStringField(block, "content");
  return value;
}

/** String field accessor that preserves empty/whitespace strings (unlike the trimmed-non-empty variant). */
function rawStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
