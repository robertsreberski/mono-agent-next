import type { RuntimeEventLike } from "@mono-agent/observability";

import type { ContextBlockInput, HistoryMessage } from "../context/index.js";
import { clampUtf8Bytes } from "../context/text.js";

function memoryBlockText(memory: ContextBlockInput | undefined): string | undefined {
  if (memory === undefined) {
    return undefined;
  }
  const content = typeof memory === "string"
    ? memory
    : (typeof memory === "object" && memory !== null && "content" in memory && typeof memory.content === "string"
      ? memory.content
      : undefined);
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  return content;
}

/**
 * Appends the recalled-memory block to the user message (after the user's text and
 * any attachment block applyAttachments already merged in), clearly delimited so
 * the model reads it as injected background context rather than the user's words.
 * Returns the message unchanged when there is no memory to inject.
 */
export function composeUserMessageWithMemory(userMessage: string, memory: ContextBlockInput | undefined): string {
  const text = memoryBlockText(memory);
  if (text === undefined) {
    return userMessage;
  }
  return `${userMessage}\n\n[Recalled long-term memory — background context for this turn, not the user's words:]\n${text}`;
}

// Per-entry display caps for the turn_context event. Content is clamped by BOTH a
// CHARACTER cap (below) and a BYTE cap so THIS clamp — not the downstream recorder
// redactor — decides every cut. The recorder truncates string values by UTF-8 byte
// length (redactJsonValue → truncateString at DEFAULT_MAX_STRING_BYTES, 4096); by
// clamping to that same byte budget here, `truncated` stays accurate and the
// redactor never re-truncates heavy multibyte content (2000 chars of 3-byte CJK is
// ~6000 bytes > 4096, and 2000 4-byte emoji is ~8000 bytes). For single-byte
// content the char cap still bites first, so those clamps are unchanged.
const TURN_CONTEXT_MESSAGE_MAX_CHARS = 2_000;
const TURN_CONTEXT_MEMORY_MAX_CHARS = 4_000;
// Mirrors @mono-agent/observability's DEFAULT_MAX_STRING_BYTES (the recorder's
// per-value UTF-8 truncation cap). Kept as a local constant rather than importing
// it, to avoid widening that package's public API for a single number.
const TURN_CONTEXT_MAX_BYTES = 4_096;

/**
 * Builds the synthetic `turn_context` event: what context THIS turn was driven
 * with. `historyCount` is the number of loaded prior messages (0 when omitted);
 * `historyOmitted` is true only when a confirmed live warm provider session
 * carries the transcript, so no host history was replayed. A cold durable reopen
 * reports the canonical history it loaded (including an authoritative empty
 * history) because its epoch-owned JSONL may be created on miss. The
 * `history`/`memory` keys are omitted entirely when empty. Each entry is clamped
 * for display, flagging `truncated`. The current user message is deliberately NOT
 * included (it is the run's userInput).
 */
export function buildTurnContextEvent(
  history: readonly HistoryMessage[],
  historyOmitted: boolean,
  memory: ContextBlockInput | undefined,
): RuntimeEventLike {
  const mappedHistory = history.map(clampTurnContextMessage);
  const mem = turnContextMemory(memory);
  return {
    type: "turn_context",
    historyCount: history.length,
    historyOmitted,
    ...(mappedHistory.length === 0 ? {} : { history: mappedHistory }),
    ...(mem === undefined ? {} : { memory: mem }),
    timestamp: new Date().toISOString(),
  };
}

function clampTurnContextMessage(message: HistoryMessage): Record<string, unknown> {
  const clamp = clampTurnContextText(message.content, TURN_CONTEXT_MESSAGE_MAX_CHARS);
  return {
    role: message.role,
    content: clamp.text,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(clamp.truncated ? { truncated: true } : {}),
  };
}

/**
 * Maps the recalled-memory ContextBlockInput (loadMemory returns `{kind, content,
 * source}`) to the event's `memory` field, clamped. Returns undefined when there
 * is nothing to show (no recall / empty content), so the caller omits the key.
 */
function turnContextMemory(
  memory: ContextBlockInput | undefined,
): { readonly content: string; readonly source?: string; readonly truncated?: true } | undefined {
  const text = memoryBlockText(memory);
  if (text === undefined) {
    return undefined;
  }
  const source =
    typeof memory === "object" && memory !== null && "source" in memory && typeof memory.source === "string"
      ? memory.source
      : undefined;
  const clamp = clampTurnContextText(text, TURN_CONTEXT_MEMORY_MAX_CHARS);
  return {
    content: clamp.text,
    ...(source === undefined ? {} : { source }),
    ...(clamp.truncated ? { truncated: true } : {}),
  };
}

function clampTurnContextText(value: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const byChars = value.length > maxChars ? value.slice(0, maxChars) : value;
  const truncatedByChars = byChars.length < value.length;
  const byBytes = clampUtf8Bytes(byChars, TURN_CONTEXT_MAX_BYTES);
  return { text: byBytes, truncated: truncatedByChars || byBytes !== byChars };
}
