import type { AgentMessageStream, AgentResponseMetadata, AgentStreamEvent } from "./index.js";
import { CodedError } from "./coded-error.js";

/**
 * Newline-delimited JSON frames that carry one AgentMessageStream callback each
 * across a process boundary. Channel-neutral by design: any transport that can
 * stream lines (chunked HTTP, unix socket, …) can replay a turn's callbacks on
 * the far side with full fidelity — including every AgentStreamEvent variant.
 *
 * Forward compatibility is deliberate in BOTH directions: unknown frame kinds
 * and unknown event types parse successfully (the payload is preserved as-is)
 * so a newer agent can talk to an older client and vice versa. Consumers
 * dispatch by `kind`/`event.type` and ignore what they do not understand.
 */
export type AgentStreamWireFrame =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "append"; readonly delta: string }
  | { readonly kind: "replace"; readonly text: string }
  | { readonly kind: "event"; readonly event: AgentStreamEvent }
  | {
      readonly kind: "finish";
      readonly finalText?: string;
      readonly metadata?: AgentResponseMetadata;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: string;
      readonly cancelled?: boolean;
    };

export function serializeAgentStreamFrame(frame: AgentStreamWireFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Parse one NDJSON line into a wire frame. Throws CodedError("invalid_frame")
 * only on lines that cannot possibly be a frame (bad JSON, no string `kind`,
 * missing the fields the known kind requires). Unknown kinds pass through so
 * version-skewed peers keep talking.
 */
export function parseAgentStreamFrame(line: string): AgentStreamWireFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CodedError("invalid_frame", "Wire frame is not valid JSON.");
  }
  if (!isRecord(parsed) || typeof parsed.kind !== "string" || parsed.kind.length === 0) {
    throw new CodedError("invalid_frame", "Wire frame has no string `kind`.");
  }
  const kind = parsed.kind;
  if (kind === "status" || kind === "replace") {
    if (typeof parsed.text !== "string") {
      throw new CodedError("invalid_frame", `A "${kind}" frame requires string \`text\`.`);
    }
  } else if (kind === "append") {
    if (typeof parsed.delta !== "string") {
      throw new CodedError("invalid_frame", 'An "append" frame requires string `delta`.');
    }
  } else if (kind === "event") {
    const event = parsed.event;
    if (!isRecord(event) || typeof event.type !== "string" || event.type.length === 0) {
      throw new CodedError("invalid_frame", 'An "event" frame requires `event` with a string `type`.');
    }
  } else if (kind === "error") {
    if (typeof parsed.message !== "string") {
      throw new CodedError("invalid_frame", 'An "error" frame requires string `message`.');
    }
  }
  // "finish" has no required fields; unknown kinds pass through untouched.
  return parsed as AgentStreamWireFrame;
}

/**
 * Client-side dispatcher: replays parsed frames onto a local AgentMessageStream.
 * "finish"/"error" frames are terminal transport concerns (return value /
 * thrown error) and are NOT dispatched here — callers handle them in their
 * read loop. Unknown frame kinds are ignored.
 */
export function frameFeedingMessageStream(
  stream: AgentMessageStream,
): (frame: AgentStreamWireFrame) => Promise<void> {
  return async (frame: AgentStreamWireFrame): Promise<void> => {
    switch (frame.kind) {
      case "status":
        await stream.status?.(frame.text);
        return;
      case "append":
        await stream.append(frame.delta);
        return;
      case "replace":
        await stream.replace?.(frame.text);
        return;
      case "event":
        await stream.event?.(frame.event);
        return;
      default:
        return;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
