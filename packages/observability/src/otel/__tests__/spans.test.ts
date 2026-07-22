import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_STRING_BYTES } from "../../guards.js";
import type { RunExportContext, RunSummary, RuntimeEventLike } from "../../types.js";

import { createDeterministicIdFactory } from "../ids.js";
import { serializeTraceSpans } from "../serialize.js";
import { buildRunReadableSpans } from "../spans.js";

const summary: RunSummary = {
  runId: "run-x",
  conversationId: "conv-x",
  status: "succeeded",
  durationMs: 100,
  eventCount: 2,
  artifactPaths: [],
  startedAt: "2026-06-18T00:00:00.000Z",
  endedAt: "2026-06-18T00:00:01.000Z",
};

const events: RuntimeEventLike[] = [
  { type: "tool_call", name: "Read" },
  { type: "assistant", text: "hello" },
];

const ctx: RunExportContext = {
  runId: "run-x",
  conversationId: "conv-x",
  sourceId: "src-1",
  includeSensitiveData: false,
};

function build(overrides: Partial<{ summary: RunSummary; events: RuntimeEventLike[]; ctx: RunExportContext }> = {}) {
  return buildRunReadableSpans({
    summary: overrides.summary ?? summary,
    events: overrides.events ?? events,
    context: overrides.ctx ?? ctx,
    projectName: "local-agent-alpha",
    startTimeUnixNanos: 1_000_000_000n,
    endTimeUnixNanos: 2_000_000_000n,
    idFactory: createDeterministicIdFactory((overrides.summary ?? summary).runId),
  });
}

describe("buildRunReadableSpans", () => {
  it("produces one root span plus one child per event", () => {
    const spans = build();
    expect(spans).toHaveLength(1 + events.length);
  });

  it("coalesces consecutive streamed assistant deltas into one message span", () => {
    const delta = (text: string): RuntimeEventLike => ({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    });
    const streamed: RuntimeEventLike[] = [delta("4"), delta(". "), delta("Two"), delta(" plus two")];
    const ctxSensitive: RunExportContext = { ...ctx, includeSensitiveData: true };
    const spans = buildRunReadableSpans({
      summary: { ...summary, eventCount: streamed.length },
      events: streamed,
      context: ctxSensitive,
      projectName: "local-agent-alpha",
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: createDeterministicIdFactory(summary.runId),
    });
    // root + exactly one coalesced assistant message span (not 4 one-token spans).
    expect(spans).toHaveLength(2);
    const msg = spans[1]!;
    expect(msg.name).toBe("Assistant message");
    expect(msg.attributes["openinference.span.kind"]).toBe("LLM");
    expect(msg.attributes["output.value"]).toBe("4. Two plus two");
    expect(msg.attributes["mono.agent.event.source_count"]).toBe(4);
  });

  it("merges a tool lifecycle (tool_use + tool_timing + tool_result) into one TOOL span", () => {
    const agentic: RuntimeEventLike[] = [
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "Let me check the files." }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } },
      { type: "tool_timing", tool_use_id: "tu1", name: "Bash", execution_ms: 42, is_error: false },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file1\nfile2" }] } },
    ];
    const spans = buildRunReadableSpans({
      summary: { ...summary, eventCount: agentic.length },
      events: agentic,
      context: { ...ctx, includeSensitiveData: true },
      projectName: "local-agent-alpha",
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: createDeterministicIdFactory(summary.runId),
    });
    // root + reasoning + tool = 3 (NOT 5: tool_use/tool_timing/tool_result collapse).
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.name)).toEqual([
      `mono-agent run ${summary.runId}`,
      "Assistant thoughts",
      "Tool: Bash",
    ]);
    // No standalone "user" span — the tool result folded into the tool span.
    expect(spans.some((s) => s.name === "user")).toBe(false);
    const thoughts = spans[1]!;
    expect(thoughts.attributes["openinference.span.kind"]).toBe("LLM");
    expect(thoughts.attributes["output.value"]).toBe("Let me check the files.");
    const tool = spans[2]!;
    expect(tool.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(tool.attributes["tool.name"]).toBe("Bash");
    expect(tool.attributes["mono.agent.tool.execution_ms"]).toBe(42);
    expect(String(tool.attributes["input.value"])).toContain("ls");
    expect(String(tool.attributes["output.value"])).toContain("file1");
  });

  it("puts the user prompt and final reply on the root span (input/output)", () => {
    const convo: RuntimeEventLike[] = [
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "thinking..." }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "The capital of France is Paris." }] } },
    ];
    const spans = buildRunReadableSpans({
      summary: { ...summary, eventCount: convo.length },
      events: convo,
      context: { ...ctx, includeSensitiveData: true, userInput: "What is the capital of France?" },
      projectName: "local-agent-alpha",
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: createDeterministicIdFactory(summary.runId),
    });
    const root = spans[0]!;
    expect(root.attributes["openinference.span.kind"]).toBe("AGENT");
    expect(root.attributes["input.value"]).toBe("What is the capital of France?");
    expect(root.attributes["output.value"]).toBe("The capital of France is Paris.");
  });

  it("redacts secret-shaped root input, output, and system prompt when opted in", () => {
    const fixture = ["sk", "-", "A".repeat(48)].join("");
    const root = build({
      summary: { ...summary, systemPrompt: `system ${fixture}`, eventCount: 1 },
      events: [
        { type: "assistant", message: { content: [{ type: "text", text: `reply ${fixture}` }] } },
      ],
      ctx: {
        ...ctx,
        includeSensitiveData: true,
        contentPatternRedaction: true,
        userInput: `prompt ${fixture}`,
      },
    })[0]!;

    expect(root.attributes["input.value"]).toBe("prompt [redacted]");
    expect(root.attributes["output.value"]).toBe("reply [redacted]");
    expect(root.attributes["mono.agent.system_prompt"]).toBe("system [redacted]");
    expect(JSON.stringify(root.attributes)).not.toContain(fixture);
  });

  it("bounds a 100k root prompt at the UTF-8 export boundary without mutating source data", () => {
    const userInput = "x".repeat(100_000);
    const exportContext: RunExportContext = { ...ctx, includeSensitiveData: true, userInput };
    const persistedSummary: RunSummary = { ...summary, userInput };
    const root = build({ summary: persistedSummary, ctx: exportContext })[0]!;

    expect(root.attributes["input.value"]).toBe(
      `${"x".repeat(DEFAULT_MAX_STRING_BYTES)}…[truncated ${String(100_000 - DEFAULT_MAX_STRING_BYTES)} bytes]`,
    );
    expect(exportContext.userInput).toBe(userInput);
    expect(persistedSummary.userInput).toBe(userInput);
  });

  it("caps multibyte root prompts on whole UTF-8 code points", () => {
    const userInput = "観".repeat(100_000);
    const encoder = new TextEncoder();
    const root = build({
      ctx: { ...ctx, includeSensitiveData: true, userInput },
    })[0]!;
    const exported = String(root.attributes["input.value"]);
    const head = exported.split("…[truncated")[0]!;

    expect(encoder.encode(userInput)).toHaveLength(300_000);
    expect(encoder.encode(head).length).toBeLessThanOrEqual(DEFAULT_MAX_STRING_BYTES);
    expect(head).toBe("観".repeat(1_365));
    expect(exported).toBe(`${head}…[truncated 295905 bytes]`);
  });

  it("falls back to ids/status on the root when no prompt/sensitive data is available", () => {
    const spans = build(); // ctx.includeSensitiveData = false, no userInput
    const root = spans[0]!;
    expect(root.attributes["input.value"]).toBe(`run ${summary.runId} · ${summary.conversationId}`);
    expect(root.attributes["output.value"]).toBe(summary.status);
  });

  it("routes to a named project via the openinference.project.name resource attr", () => {
    const spans = build();
    const resourceAttrs = spans[0]!.resource.attributes as Record<string, unknown>;
    expect(resourceAttrs["openinference.project.name"]).toBe("local-agent-alpha");
    expect(resourceAttrs["service.name"]).toBe("mono-agent");
    // The resource object must be shared by identity across spans.
    expect(spans[1]!.resource).toBe(spans[0]!.resource);
  });

  it("tags the root as an AGENT span and children with OpenInference kinds", () => {
    const spans = build();
    expect(spans[0]!.attributes["openinference.span.kind"]).toBe("AGENT");
    expect(spans[1]!.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(spans[2]!.attributes["openinference.span.kind"]).toBe("LLM");
    // OTel transport kinds: INTERNAL(0) root, CLIENT(2) for tool/llm.
    expect(spans[0]!.kind).toBe(0);
    expect(spans[1]!.kind).toBe(2);
  });

  it("renders the root as a 'memory' kind when context.runKind is memory", () => {
    const spans = build({ ctx: { ...ctx, runKind: "memory" } });
    expect(spans[0]!.attributes["openinference.span.kind"]).toBe("memory");
    // Channel runs keep the standard AGENT kind.
    expect(build({ ctx: { ...ctx, runKind: "channel" } })[0]!.attributes["openinference.span.kind"]).toBe("AGENT");
  });

  it("attaches the system prompt as input message 0 only when sensitive export is on", () => {
    const withPrompt = build({
      summary: { ...summary, systemPrompt: "You are the private memory maintenance LLM." },
      ctx: { ...ctx, includeSensitiveData: true },
    })[0]!;
    expect(withPrompt.attributes["llm.input_messages.0.message.role"]).toBe("system");
    expect(withPrompt.attributes["llm.input_messages.0.message.content"]).toBe(
      "You are the private memory maintenance LLM.",
    );
    expect(withPrompt.attributes["mono.agent.system_prompt"]).toBe("You are the private memory maintenance LLM.");

    // Same summary, but sensitive export off → no system prompt leaks.
    const gated = build({
      summary: { ...summary, systemPrompt: "You are the private memory maintenance LLM." },
      ctx: { ...ctx, includeSensitiveData: false },
    })[0]!;
    expect(gated).not.toHaveProperty("llm.input_messages.0.message.role");
    expect(gated).not.toHaveProperty("mono.agent.system_prompt");
  });

  it("sets string input/output values and mime types on every span", () => {
    for (const span of build()) {
      expect(typeof span.attributes["input.value"]).toBe("string");
      expect(typeof span.attributes["output.value"]).toBe("string");
      expect(span.attributes["input.mime_type"]).toBe("text/plain");
    }
  });

  it("parents children to the root within one trace", () => {
    const spans = build();
    const traceId = spans[0]!.spanContext().traceId;
    const rootSpanId = spans[0]!.spanContext().spanId;
    expect(spans[0]!.parentSpanContext).toBeUndefined();
    for (const child of spans.slice(1)) {
      expect(child.spanContext().traceId).toBe(traceId);
      expect(child.parentSpanContext?.spanId).toBe(rootSpanId);
    }
  });

  it("maps a failed run's root span to ERROR status with the failure kind", () => {
    const failed: RunSummary = { ...summary, status: "failed", failureKind: "boom" };
    const spans = build({ summary: failed });
    expect(spans[0]!.status.code).toBe(2);
    expect(spans[0]!.status.message).toBe("boom");
  });

  it("surfaces the underlying error and failover history on the failed root span", () => {
    const failed: RunSummary = {
      ...summary,
      status: "failed",
      failureKind: "provider_unavailable_exhausted",
      error: "503 Service Unavailable",
      failoverHistory: [
        { model: "pi:openai-codex:gpt-5.5", subkind: "timeout" },
        { model: "pi:opencode-go:kimi-k2.6", subkind: "server_error", requestId: "abc123" },
      ],
    };
    const root = build({ summary: failed })[0]!;
    expect(root.status.code).toBe(2);
    expect(root.status.message).toContain("provider_unavailable_exhausted");
    expect(root.status.message).toContain("pi:openai-codex:gpt-5.5 → timeout");
    expect(root.status.message).toContain("last error: 503 Service Unavailable");
    // The non-sensitive root output mirrors the rich detail (no reply was produced).
    expect(String(root.attributes["output.value"])).toContain("server_error (req abc123)");
    // Structured, queryable mirrors of the same operational metadata.
    expect(root.attributes["mono.agent.failover.count"]).toBe(2);
    expect(root.attributes["mono.agent.error.message"]).toBe("503 Service Unavailable");
  });

  it("redacts secret-shaped failure details in metadata-only mode when opted in", () => {
    const fixture = ["AK", "IA", "A".repeat(16)].join("");
    const root = build({
      summary: {
        ...summary,
        status: "failed",
        failureKind: "provider_unavailable_exhausted",
        error: `provider returned ${fixture}`,
        failoverHistory: [
          { model: "pi:test:model", subkind: "server_error", requestId: `request-${fixture}` },
        ],
      },
      ctx: { ...ctx, includeSensitiveData: false, contentPatternRedaction: true },
    })[0]!;

    expect(JSON.stringify(root.attributes)).not.toContain(fixture);
    expect(root.status.message).not.toContain(fixture);
    expect(root.attributes["mono.agent.error.message"]).toBe("provider returned [redacted]");
    expect(root.attributes["mono.agent.failover.detail"]).toContain("request-[redacted]");
    expect(root.attributes["output.value"]).toContain("last error: provider returned [redacted]");
  });

  it("is metadata-only by default: no raw payload attribute", () => {
    const spans = build();
    for (const span of spans) {
      expect(span.attributes["mono.agent.event.payload"]).toBeUndefined();
    }
  });

  it("serializes to a non-empty protobuf body", () => {
    const bytes = serializeTraceSpans(build());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
