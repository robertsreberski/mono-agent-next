import { classifyAssistantContent, compactString } from "./content.js";
import { isRecord } from "./guards.js";
import type { AssistantContentWalk } from "./content.js";
import type {
  RecordedRunEvent,
  RecordedRunTimelineItem,
} from "./types.js";

type AssistantStreamChunk = AssistantContentWalk;

export function combineRecordedRunEvents(events: readonly RecordedRunEvent[]): readonly RecordedRunTimelineItem[] {
  const timeline: RecordedRunTimelineItem[] = [];
  let index = 0;
  while (index < events.length) {
    const current = events[index];
    if (current === undefined) {
      break;
    }
    const currentChunk = assistantStreamChunk(current);
    if (currentChunk === undefined) {
      timeline.push(singleEventItem(current));
      index += 1;
      continue;
    }

    const group = [current];
    const chunks = [currentChunk];
    let nextIndex = index + 1;
    while (nextIndex < events.length) {
      const next = events[nextIndex];
      const nextChunk = next === undefined ? undefined : assistantStreamChunk(next);
      if (next === undefined || nextChunk === undefined || nextChunk.kind !== currentChunk.kind) {
        break;
      }
      group.push(next);
      chunks.push(nextChunk);
      nextIndex += 1;
    }

    timeline.push(group.length === 1 ? singleEventItem(current) : combinedEventItem(group, chunks));
    index = nextIndex;
  }
  return timeline;
}

function singleEventItem(event: RecordedRunEvent): RecordedRunTimelineItem {
  return {
    ...event,
    sourceEventCount: 1,
    sourceEventStartIndex: event.index,
    sourceEventEndIndex: event.index,
    // A single-event item has no group to span, so it reuses its own timestamp
    // as endTimestamp (undefined stays undefined — nothing to reuse).
    ...(event.timestamp === undefined ? {} : { endTimestamp: event.timestamp }),
  };
}

function combinedEventItem(
  events: readonly RecordedRunEvent[],
  chunks: readonly AssistantStreamChunk[],
): RecordedRunTimelineItem {
  const first = events[0];
  const firstChunk = chunks[0];
  if (first === undefined || firstChunk === undefined) {
    throw new Error("combinedEventItem requires at least one source event");
  }
  const last = events[events.length - 1] ?? first;
  const kind = firstChunk.kind;
  const joinedText = chunks.map((chunk) => chunk.text ?? "").join("");
  const summary = compactString(joinedText || events.map((event) => event.summary).join(" "));
  return {
    index: first.index,
    ...(first.type === undefined ? {} : { type: first.type }),
    category: kind === "thinking" ? "thinking" : "message",
    ...(first.timestamp === undefined ? {} : { timestamp: first.timestamp }),
    ...(last.timestamp === undefined ? {} : { endTimestamp: last.timestamp }),
    label: kind === "thinking" ? "Assistant thoughts" : "Assistant message",
    summary,
    // Captured BEFORE `compactString` truncates to SUMMARY_MAX_CHARS, so callers
    // needing the real coalesced content volume (e.g. turn thinking stats)
    // aren't bounded by the display-oriented summary cap.
    contentChars: joinedText.length,
    payload: {
      type: "assistant.timeline.combined",
      contentKind: kind,
      sourceEventCount: events.length,
      sourceEventStartIndex: first.index,
      sourceEventEndIndex: last.index,
      preview: summary,
    },
    sourceEventCount: events.length,
    sourceEventStartIndex: first.index,
    sourceEventEndIndex: last.index,
  };
}

function assistantStreamChunk(event: RecordedRunEvent): AssistantStreamChunk | undefined {
  if (event.type !== "assistant" || !isRecord(event.payload)) {
    return undefined;
  }
  return classifyAssistantContent(event.payload.message);
}
