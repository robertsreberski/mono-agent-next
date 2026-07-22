import { describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  ChannelUserCancelReason,
  assertAgentContinuationOriginContext,
  createChannelUserCancelReason,
  isAgentResponseCancelledError,
  isChannelUserCancelReason,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentStreamEvent,
} from "../index.js";

describe("shared agent contracts", () => {
  it("accepts only an exact, canonical continuation origin snapshot", () => {
    const capturedAt = "2026-07-14T12:00:00.000Z";
    const snapshot = {
      schemaVersion: 1,
      conversationId: "slack:D1:1.1#2026-07-14",
      originRunId: "run-1",
      historyBoundary: "run-1",
      capturedAt,
      messages: [
        { role: "user", content: "delegate", timestamp: capturedAt, runId: "run-1" },
        { role: "assistant", content: "I will return.", timestamp: capturedAt, runId: "run-1" },
      ],
    };
    expect(() => assertAgentContinuationOriginContext(snapshot)).not.toThrow();
    expect(() => assertAgentContinuationOriginContext({ ...snapshot, unexpected: true })).toThrow(/invalid envelope/u);
    expect(() => assertAgentContinuationOriginContext({
      ...snapshot,
      capturedAt: "2026-07-14 12:00:00Z",
    })).toThrow(/invalid envelope/u);
    expect(() => assertAgentContinuationOriginContext({
      ...snapshot,
      messages: [
        { ...snapshot.messages[0], unexpected: true },
        snapshot.messages[1],
      ],
    })).toThrow(/invalid message/u);
  });

  it("defines a structural responder and message stream contract", async () => {
    const chunks: string[] = [];
    const stream: AgentMessageStream = {
      async append(delta) {
        chunks.push(delta);
      },
    };
    const responder: AgentResponder = {
      async respond(request: AgentRequestBase, output) {
        await output.append(`echo:${request.text}`);
        return { text: request.text, metadata: { ok: true } };
      },
    };

    const response = await responder.respond({
      conversationId: "local:1",
      text: "hello",
      abortSignal: new AbortController().signal,
    }, stream);

    expect(chunks).toEqual(["echo:hello"]);
    expect(response).toEqual({ text: "hello", metadata: { ok: true } });
  });

  it("recognizes cancellation via instanceof, subclass, and cross-realm brand", () => {
    const reason = { code: "cancelled" };
    const error = new AgentResponseCancelledError("stop", { reason });
    expect(error.name).toBe("AgentResponseCancelledError");
    expect(error.reason).toBe(reason);
    expect(isAgentResponseCancelledError(error)).toBe(true);

    // Real subclasses (e.g. tui's TuiAgentCancelledError) extend the base, so
    // instanceof + the inherited brand recognizes them without naming them.
    class TuiAgentCancelledError extends AgentResponseCancelledError {
      constructor() {
        super("legacy");
        this.name = "TuiAgentCancelledError";
      }
    }
    expect(isAgentResponseCancelledError(new TuiAgentCancelledError())).toBe(true);

    // A duplicate class identity is still recognized via the stable brand.
    const crossRealm = { name: "AgentResponseCancelledError", agentResponseCancelled: true };
    expect(isAgentResponseCancelledError(crossRealm)).toBe(true);

    // Arbitrary errors that merely share a name are no longer matched.
    const nameOnly = new Error("legacy");
    nameOnly.name = "AgentResponderCancelledError";
    expect(isAgentResponseCancelledError(nameOnly)).toBe(false);
    expect(isAgentResponseCancelledError(new Error("boom"))).toBe(false);
  });

  it("rejects non-Error inputs without a cancellation brand", () => {
    expect(isAgentResponseCancelledError(undefined)).toBe(false);
    expect(isAgentResponseCancelledError(null)).toBe(false);
    expect(isAgentResponseCancelledError("cancelled")).toBe(false);
    expect(isAgentResponseCancelledError(42)).toBe(false);
    // Plain objects only match when the brand is exactly `true`.
    expect(isAgentResponseCancelledError({ agentResponseCancelled: false })).toBe(false);
    expect(isAgentResponseCancelledError({ agentResponseCancelled: "yes" })).toBe(false);
    expect(isAgentResponseCancelledError({})).toBe(false);
  });

  it("brands explicit channel-user cancellation reasons across package identities", () => {
    const reason = createChannelUserCancelReason("chat");
    expect(reason).toBeInstanceOf(ChannelUserCancelReason);
    expect(reason.name).toBe("ChannelUserCancelReason");
    expect(reason.message).toBe("Cancelled by chat user.");
    expect(reason.channel).toBe("chat");
    expect(isChannelUserCancelReason(reason)).toBe(true);
    expect(isChannelUserCancelReason({ channelUserCancel: true, channel: "web" })).toBe(true);
    expect(isChannelUserCancelReason({ channelUserCancel: false })).toBe(false);
    expect(isChannelUserCancelReason(new Error("Cancelled by user."))).toBe(false);
    expect(() => createChannelUserCancelReason("   ")).toThrow(/channel name/);
  });

  it("covers every AgentStreamEvent variant (compile-time exhaustiveness)", () => {
    // A switch with a `never`-typed default fails to compile if a new variant is
    // added to AgentStreamEvent.type without being handled here.
    function describeEvent(event: AgentStreamEvent): string {
      switch (event.type) {
        case "assistant_thought":
          return event.text;
        case "tool_call_started":
          return `${event.id}:${event.name}`;
        case "tool_call_progress":
          return `${event.id}:${String(event.partialResult ?? "")}`;
        case "tool_call_completed":
          return `${event.id}${event.executionMs === undefined ? "" : `:${event.executionMs}ms`}`;
        case "usage_update":
          return `${event.tokens?.input ?? 0}/${event.tokens?.output ?? 0}`;
        case "provider_status":
          return event.kind;
        case "memory_recalled":
          return `${event.bytes ?? 0}b`;
        case "runtime_telemetry":
          return event.kind;
        case "runtime_warning":
          return event.message;
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    }

    expect(describeEvent({ type: "assistant_thought", text: "thinking" })).toBe("thinking");
    expect(describeEvent({ type: "tool_call_started", id: "t1", name: "search" })).toBe("t1:search");
    expect(describeEvent({ type: "tool_call_progress", id: "t1", partialResult: "p" })).toBe("t1:p");
    expect(describeEvent({ type: "tool_call_completed", id: "t1", executionMs: 5 })).toBe("t1:5ms");
    expect(describeEvent({ type: "usage_update", tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } })).toBe("1/2");
    expect(describeEvent({ type: "provider_status", kind: "request_started" })).toBe("request_started");
    expect(describeEvent({ type: "memory_recalled", bytes: 9 })).toBe("9b");
    expect(describeEvent({ type: "runtime_telemetry", kind: "cache_hit" })).toBe("cache_hit");
    expect(describeEvent({ type: "runtime_warning", message: "warned" })).toBe("warned");
  });
});
