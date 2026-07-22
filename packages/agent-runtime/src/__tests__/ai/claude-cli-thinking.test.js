import { describe, expect, it } from "vitest";
import {
  buildCliCommand,
  createThinkingBuffer,
  normalizeCliEvent,
} from "../../ai/providers/claude-cli.js";

function streamEvent(event) {
  return { type: "stream_event", event };
}

function thinkingBlockStart(index) {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
}

function thinkingDelta(index, text) {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking: text },
  });
}

function signatureDelta(index, signature) {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature },
  });
}

function messageStart(id) {
  return streamEvent({
    type: "message_start",
    message: { id, type: "message", role: "assistant", content: [] },
  });
}

function finalisedThinkingAssistant(id, signature) {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature }],
    },
  };
}

function drive(rawEvents) {
  const buffer = createThinkingBuffer();
  const context = { thinkingBuffer: buffer };
  const forwarded = [];
  for (const raw of rawEvents) {
    const ev = normalizeCliEvent(raw, context);
    if (ev) forwarded.push(ev);
  }
  return { buffer, forwarded };
}

describe("claude-cli — thinking rehydration", () => {
  it("splices buffered thinking deltas into the finalised assistant event", () => {
    const { forwarded } = drive([
      messageStart("msg_A"),
      thinkingBlockStart(0),
      thinkingDelta(0, "Let me think..."),
      thinkingDelta(0, " about the answer."),
      signatureDelta(0, "SIG_ABC"),
      streamEvent({ type: "content_block_stop", index: 0 }),
      finalisedThinkingAssistant("msg_A", "SIG_ABC"),
    ]);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      type: "assistant",
      message: {
        id: "msg_A",
        content: [
          { type: "thinking", thinking: "Let me think... about the answer.", signature: "SIG_ABC" },
        ],
      },
    });
  });

  it("suppresses every stream_event chunk so the host log stays uncluttered", () => {
    const { forwarded } = drive([
      messageStart("msg_A"),
      thinkingBlockStart(0),
      thinkingDelta(0, "anything"),
      streamEvent({ type: "content_block_stop", index: 0 }),
      streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      streamEvent({ type: "message_stop" }),
    ]);

    expect(forwarded).toHaveLength(0);
  });

  it("leaves text-only assistant events untouched (no spurious thinking)", () => {
    const text = "Hi.";
    const { forwarded } = drive([
      messageStart("msg_T"),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        message: {
          id: "msg_T",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
        },
      },
    ]);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].message.content).toEqual([{ type: "text", text }]);
  });

  it("does not bleed deltas across messages with the same block index", () => {
    const { forwarded } = drive([
      messageStart("msg_A"),
      thinkingBlockStart(0),
      thinkingDelta(0, "Message A thoughts"),
      streamEvent({ type: "content_block_stop", index: 0 }),
      finalisedThinkingAssistant("msg_A", "SIG_A"),
      messageStart("msg_B"),
      thinkingBlockStart(0),
      thinkingDelta(0, "Message B thoughts"),
      streamEvent({ type: "content_block_stop", index: 0 }),
      finalisedThinkingAssistant("msg_B", "SIG_B"),
    ]);

    expect(forwarded.map((event) => event.message.content[0].thinking)).toEqual([
      "Message A thoughts",
      "Message B thoughts",
    ]);
  });

  it("preserves the finalised event when no deltas were buffered", () => {
    const final = finalisedThinkingAssistant("msg_X", "SIG_X");
    const { forwarded } = drive([final]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toBe(final);
  });

  it("falls back gracefully when normalizeCliEvent receives no buffer", () => {
    const ev = normalizeCliEvent(streamEvent({ type: "message_start", message: { id: "x" } }));
    // Without a buffer the stream event falls through to the cli_event fallback.
    expect(ev).toEqual({ type: "cli_event", raw: { type: "stream_event", event: { type: "message_start", message: { id: "x" } } } });
  });
});

describe("claude-cli — buildCliCommand flags", () => {
  it("passes --include-partial-messages to the claude-code CLI", () => {
    const spec = buildCliCommand({
      sdk: "claude-code",
      model: "claude-opus-4-7",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    expect(spec.command).toBe("claude");
    expect(spec.args).toContain("--include-partial-messages");
    const flagIndex = spec.args.indexOf("--include-partial-messages");
    const formatIndex = spec.args.indexOf("--output-format");
    expect(formatIndex).toBeGreaterThanOrEqual(0);
    expect(flagIndex).toBeGreaterThan(formatIndex);
  });

  it("does not pass --include-partial-messages to the codex CLI", () => {
    const spec = buildCliCommand({
      sdk: "codex",
      model: "gpt-5-codex",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    expect(spec.command).toBe("codex");
    expect(spec.args).not.toContain("--include-partial-messages");
  });

  it("clamps effort max to xhigh for the codex CLI (codex has no max tier)", () => {
    const spec = buildCliCommand({
      sdk: "codex",
      model: "gpt-5-codex",
      effort: "max",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    expect(spec.args).toContain("model_reasoning_effort=xhigh");
    expect(spec.args).not.toContain("model_reasoning_effort=max");
    expect(spec.args.join(" ")).toContain("model_reasoning_summary");
  });

  it("passes effort xhigh through unchanged to the codex CLI", () => {
    const spec = buildCliCommand({
      sdk: "codex",
      model: "gpt-5-codex",
      effort: "xhigh",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    expect(spec.args).toContain("model_reasoning_effort=xhigh");
  });

  it("forwards effort ultra unchanged to the codex CLI config sink", () => {
    const spec = buildCliCommand({
      sdk: "codex",
      model: "gpt-5-codex",
      effort: "ultra",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    expect(spec.args.filter((arg) => arg.startsWith("model_reasoning_effort="))).toEqual([
      "model_reasoning_effort=ultra",
    ]);
  });

  it("keeps native --effort max for the claude-code CLI", () => {
    const spec = buildCliCommand({
      sdk: "claude-code",
      model: "claude-opus-4-8",
      effort: "max",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    const effortIndex = spec.args.indexOf("--effort");
    expect(effortIndex).toBeGreaterThanOrEqual(0);
    expect(spec.args[effortIndex + 1]).toBe("max");
  });

  it("forwards effort ultra unchanged to the Claude CLI native effort sink", () => {
    const spec = buildCliCommand({
      sdk: "claude-code",
      model: "claude-opus-4-8",
      effort: "ultra",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    const effortIndex = spec.args.indexOf("--effort");
    expect(effortIndex).toBeGreaterThanOrEqual(0);
    expect(spec.args.filter((arg) => arg === "--effort")).toHaveLength(1);
    expect(spec.args[effortIndex + 1]).toBe("ultra");
  });

  it("passes the 1M context suffix for Opus 4.8 when contextWindow requests it", () => {
    const spec = buildCliCommand({
      sdk: "claude-code",
      model: "claude-opus-4-8",
      contextWindow: "1m",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    const modelIndex = spec.args.indexOf("--model");
    expect(spec.args[modelIndex + 1]).toBe("claude-opus-4-8[1m]");
  });

  it("preserves an explicitly authored 1M model reference without a separate contextWindow", () => {
    const spec = buildCliCommand({
      sdk: "claude-code",
      model: "claude-opus-4-8[1m]",
      systemPrompt: "sys",
      prompt: "hi",
      cwd: "/tmp",
    });
    const modelIndex = spec.args.indexOf("--model");
    expect(spec.args[modelIndex + 1]).toBe("claude-opus-4-8[1m]");
  });
});
