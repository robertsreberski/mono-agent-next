import { classifyAssistantContent, compactString } from "./content.js";
import { isRecord, stringField } from "./guards.js";
import { DEFAULT_MAX_STRING_BYTES } from "./guards.js";
import { redactJsonValue } from "./redaction.js";
import type { RecordedRunEventCategory, RuntimeEventLike } from "./types.js";

/**
 * Node-free event classification + label/summary derivation shared by the
 * recorded-run reader and the export-mapping surface. {@link buildEventDescriptors}
 * is the single source of truth that bridges a RAW {@link RuntimeEventLike}
 * (what `onEvent` receives) to a {@link RecordedRunEventDescriptors} bundle; the
 * reader's `toRecordedEvent` and the export mapping both go through it so their
 * category/label/summary outputs always agree.
 */

export interface RecordedRunEventDescriptors {
  readonly category: RecordedRunEventCategory;
  readonly label: string;
  readonly summary: string;
}

export function classifyRecordedRunEvent(event: unknown): RecordedRunEventCategory {
  if (!isRecord(event)) {
    return "runtime";
  }
  const rawType = stringField(event, "type");
  const type = rawType?.toLowerCase() ?? "";
  if (isFileChangeType(rawType)) {
    return fileChangeFailed(event) ? "error" : "runtime";
  }
  if (
    type.includes("error") ||
    type.includes("failure") ||
    type.includes("failed") ||
    event.error !== undefined ||
    event.failureKind !== undefined
  ) {
    return "error";
  }
  if (
    type.includes("tool") ||
    stringField(event, "toolName") !== undefined ||
    stringField(event, "tool") !== undefined ||
    stringField(event, "tool_call_id") !== undefined ||
    stringField(event, "toolCallId") !== undefined ||
    // Real pi-runtime tool activity arrives as a nested `tool_use`/`tool_result`
    // content block on an otherwise plain assistant/user message event, not as a
    // top-level tool field. Mixed content (e.g. text + tool_use) still classifies
    // as tool: the tool call is the salient part of the event.
    firstToolUseBlock(event) !== undefined ||
    firstToolResultBlock(event) !== undefined
  ) {
    return "tool";
  }
  if (type.includes("thinking") || type.includes("reasoning") || type.includes("thought")) {
    return "thinking";
  }
  if (assistantMessageContentKind(event) === "thinking") {
    return "thinking";
  }
  // Runtime control events (e.g. `runtime_warning`) carry a human-readable
  // `message` string, so they must be classified by type BEFORE the generic
  // message-field heuristic below — otherwise they are mis-filed as "message".
  if (type === "runtime_warning") {
    return "runtime";
  }
  if (type === "assistant" || type === "user" || type.includes("message") || event.message !== undefined) {
    return "message";
  }
  return "runtime";
}

export function eventLabel(record: Record<string, unknown>, category: RecordedRunEventCategory, type: string | undefined): string {
  if (isFileChangeType(type)) {
    return category === "error" ? "file change failed" : "file change";
  }
  if (category === "tool") {
    const toolUseBlock = firstToolUseBlock(record);
    if (toolUseBlock !== undefined) {
      const name = stringField(toolUseBlock, "name");
      return name !== undefined ? `Tool: ${name}` : "Tool call";
    }
    const toolResultBlock = firstToolResultBlock(record);
    if (toolResultBlock !== undefined) {
      // tool_result blocks almost never carry the tool's own name (that lives on
      // the earlier tool_use block); appending it here is opportunistic, not an
      // id->name lookup.
      const name = stringField(toolResultBlock, "name");
      return name !== undefined ? `Tool result: ${name}` : "Tool result";
    }
    const toolName = stringField(record, "toolName") ?? stringField(record, "tool") ?? stringField(record, "name");
    if (toolName !== undefined) {
      return `Tool: ${toolName}`;
    }
  }
  const role = stringField(record, "role");
  if (category === "message" && role !== undefined) {
    return `Message: ${role}`;
  }
  if (category === "thinking") {
    return type ?? "Reasoning event";
  }
  if (category === "error") {
    return type ?? stringField(record, "failureKind") ?? "Error";
  }
  if (type === "turn_context") {
    return "Turn context";
  }
  return type ?? "Runtime event";
}

function isFileChangeType(type: string | undefined): boolean {
  return type?.replace(/[-_\s]/gu, "").toLowerCase() === "filechange";
}

function fileChangeFailed(record: Record<string, unknown>): boolean {
  if (record.is_error === true || record.error !== undefined) {
    return true;
  }
  const status = stringField(record, "status")?.toLowerCase();
  return status === "failed" || status === "failure" || status === "error" || status === "errored";
}

export function eventSummary(
  record: Record<string, unknown>,
  category: RecordedRunEventCategory,
  payload: unknown,
  maxStringBytes: number,
): string {
  const direct = stringField(record, "summary") ?? stringField(record, "text") ?? stringField(record, "delta") ?? stringField(record, "error");
  if (direct !== undefined) {
    return compactString(direct);
  }
  if (category === "tool") {
    const nestedSummary = nestedToolBlockSummary(record);
    if (nestedSummary !== undefined) {
      return nestedSummary;
    }
  }
  const messageText = textFromMessage(record.message);
  if (messageText !== undefined) {
    return compactString(messageText);
  }
  if (category === "tool") {
    const status = stringField(record, "status") ?? stringField(record, "state");
    const toolName = stringField(record, "toolName") ?? stringField(record, "tool") ?? stringField(record, "name");
    if (toolName !== undefined && status !== undefined) {
      return `${toolName} — ${status}`;
    }
    if (toolName !== undefined) {
      return toolName;
    }
  }
  if (category === "thinking") {
    return "Runtime emitted a reasoning/thinking process event.";
  }
  return compactString(JSON.stringify(redactJsonValue(payload, maxStringBytes)));
}

/**
 * A message's `content` array, filtered down to record-shaped blocks, or
 * undefined when `message`/`content` isn't record/array-shaped. Single
 * source of truth for the array walk shared by {@link findContentBlock} and
 * {@link countToolResultBlocks}.
 */
function contentBlocks(message: unknown): readonly Record<string, unknown>[] | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.filter((block): block is Record<string, unknown> => isRecord(block));
}

/** First content block of `blockType` on a message's `content` array, if any. */
function findContentBlock(message: unknown, blockType: string): Record<string, unknown> | undefined {
  return contentBlocks(message)?.find((block) => block.type === blockType);
}

/** First `tool_use` content block on an `assistant` event's message, if any. */
function firstToolUseBlock(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return stringField(event, "type") === "assistant" ? findContentBlock(event.message, "tool_use") : undefined;
}

/**
 * First `tool_result` content block on a `user` event's message, if any.
 * Exported so other modules (e.g. turn segmentation) can detect tool_result
 * boundaries without re-implementing this block walk.
 */
export function firstToolResultBlock(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return stringField(event, "type") === "user" ? findContentBlock(event.message, "tool_result") : undefined;
}

/**
 * Count of `tool_result` content blocks on a `user` event's message. A real
 * pi-runtime parallel tool batch delivers one `user` event per completed
 * call, but a single `user` event CAN carry more than one `tool_result`
 * block; turn-segmentation's `toolCalls` count sums this across a turn's
 * user-typed tool items rather than counting items 1-for-1. Falls back to 1
 * when the event's `type` isn't "user" or its message/content isn't
 * array-shaped (foreign/malformed payload) -- the item still represents one
 * completed call, just with a shape this helper can't decompose.
 */
export function countToolResultBlocks(event: Record<string, unknown>): number {
  if (stringField(event, "type") !== "user") {
    return 1;
  }
  const blocks = contentBlocks(event.message);
  if (blocks === undefined) {
    return 1;
  }
  return blocks.filter((block) => block.type === "tool_result").length;
}

/**
 * Compacted preview for a nested tool_use/tool_result block, or undefined when
 * the event carries neither (falls through to the existing summary paths).
 */
function nestedToolBlockSummary(record: Record<string, unknown>): string | undefined {
  const toolUseBlock = firstToolUseBlock(record);
  if (toolUseBlock !== undefined) {
    const input = toolUseBlock.input;
    return compactString(typeof input === "string" ? input : JSON.stringify(input ?? {}));
  }
  const toolResultBlock = firstToolResultBlock(record);
  if (toolResultBlock !== undefined) {
    const content = toolResultBlock.content;
    const preview = typeof content === "string"
      ? content
      : joinedTextIfAllTextBlocks(content) ?? JSON.stringify(content ?? "");
    return compactString(toolResultBlock.is_error === true ? `error: ${preview}` : preview);
  }
  return undefined;
}

/**
 * The real Pi-runtime `tool_result.content` shape for text-only results is
 * `[{type:"text",text:"..."}]` (possibly multiple blocks). Join their text when
 * EVERY entry is a text block; return undefined (falling back to the flat JSON
 * preview) when any entry isn't, since a partial join would silently drop
 * non-text content instead of surfacing it.
 */
function joinedTextIfAllTextBlocks(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return undefined;
    }
    texts.push(block.text);
  }
  return texts.join("");
}

export function textFromMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const content = value.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

export function assistantMessageContentKind(event: Record<string, unknown>): "thinking" | "text" | undefined {
  if (stringField(event, "type") !== "assistant") {
    return undefined;
  }
  return classifyAssistantContent(event.message)?.kind;
}

/**
 * Single source of truth bridging a RAW {@link RuntimeEventLike} to its
 * {category, label, summary} descriptors. Mirrors the recorded-run reader's
 * `toRecordedEvent` parse path: redact the raw event first, classify the
 * redacted payload, then derive the label/summary from the redacted record.
 */
export function buildEventDescriptors(
  event: RuntimeEventLike,
  maxStringBytes = DEFAULT_MAX_STRING_BYTES,
): RecordedRunEventDescriptors {
  const payload = redactJsonValue(event, maxStringBytes);
  const category = classifyRecordedRunEvent(payload);
  const record = isRecord(payload) ? payload : {};
  const type = stringField(record, "type");
  return {
    category,
    label: eventLabel(record, category, type),
    summary: eventSummary(record, category, payload, maxStringBytes),
  };
}
