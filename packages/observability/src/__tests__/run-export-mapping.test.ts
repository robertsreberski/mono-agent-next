import { describe, expect, it } from "vitest";

import {
  buildEventSpans,
  buildEventSpanAttributes,
  buildRootSpanAttributes,
  composeFailureDetail,
  countRuntimeWarnings,
  normalizeFailoverHistory,
  renderFailoverHistory,
  spanKindHint,
  spanStatusFor,
} from "../run-export-mapping.js";
import type { RunExportContext, RunSummary, RuntimeEventLike } from "../types.js";

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    conversationId: "chat-1",
    status: "succeeded",
    durationMs: 10,
    eventCount: 3,
    artifactPaths: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<RunExportContext> = {}): RunExportContext {
  return {
    runId: "run-1",
    conversationId: "chat-1",
    includeSensitiveData: false,
    ...overrides,
  };
}

describe("buildRootSpanAttributes", () => {
  it("emits core identifiers and omits optional context when absent", () => {
    const attrs = buildRootSpanAttributes(makeSummary(), makeContext(), 2);
    expect(attrs).toMatchObject({
      "service.name": "mono-agent",
      "mono.agent.run_id": "run-1",
      "mono.agent.conversation_id": "chat-1",
      "mono.agent.status": "succeeded",
      "mono.agent.events.count": 3,
      "mono.agent.warnings.count": 2,
    });
    expect(attrs).not.toHaveProperty("mono.agent.source_id");
    expect(attrs).not.toHaveProperty("mono.agent.source_label");
    expect(attrs).not.toHaveProperty("mono.agent.config_path");
    expect(attrs).not.toHaveProperty("mono.agent.failure_kind");
    expect(attrs).not.toHaveProperty("mono.agent.provider_session_id");
    expect(attrs).not.toHaveProperty("mono.agent.artifact_dir");
  });

  it("includes optional context fields when present", () => {
    const attrs = buildRootSpanAttributes(
      makeSummary({ failureKind: "provider_error", status: "failed", providerSessionId: "sess-9" }),
      makeContext({ sourceId: "src-1", sourceLabel: "Telegram", configPath: "/etc/agent.json" }),
      0,
    );
    expect(attrs).toMatchObject({
      "mono.agent.source_id": "src-1",
      "mono.agent.source_label": "Telegram",
      "mono.agent.config_path": "/etc/agent.json",
      "mono.agent.status": "failed",
      "mono.agent.failure_kind": "provider_error",
      "mono.agent.provider_session_id": "sess-9",
    });
  });

  it("includes artifact_dir only when includeSensitiveData is true", () => {
    const without = buildRootSpanAttributes(makeSummary(), makeContext({ artifactDir: "/runs" }), 0);
    expect(without).not.toHaveProperty("mono.agent.artifact_dir");

    const withSensitive = buildRootSpanAttributes(
      makeSummary(),
      makeContext({ artifactDir: "/runs", includeSensitiveData: true }),
      0,
    );
    expect(withSensitive["mono.agent.artifact_dir"]).toBe("/runs");
  });

  it("emits run kind, memory operation, model, duration, tokens and cost when present", () => {
    const attrs = buildRootSpanAttributes(
      makeSummary({
        model: "pi:opencode-go:kimi-k2.6",
        durationMs: 1234,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 8, cache_creation_tokens: 4, cost_usd: 0.5 },
        cost: { cumulativeUsd: 0.75 },
      }),
      makeContext({ runKind: "memory", memoryOperation: "distill" }),
      0,
    );
    expect(attrs).toMatchObject({
      "mono.agent.run.kind": "memory",
      "mono.agent.memory.operation": "distill",
      "llm.model_name": "pi:opencode-go:kimi-k2.6",
      "mono.agent.model": "pi:opencode-go:kimi-k2.6",
      "mono.agent.duration_ms": 1234,
      "llm.token_count.prompt": 100,
      "llm.token_count.completion": 20,
      "llm.token_count.total": 120,
      "llm.token_count.prompt_details.cache_read": 8,
      "llm.token_count.prompt_details.cache_write": 4,
      // cost.cumulativeUsd is preferred over usage.cost_usd.
      "mono.agent.cost_usd": 0.75,
    });
  });

  it("falls back to usage.cost_usd and omits token/kind/model attrs when their sources are absent", () => {
    const attrs = buildRootSpanAttributes(makeSummary({ usage: { cost_usd: 0.25 } }), makeContext(), 0);
    expect(attrs["mono.agent.cost_usd"]).toBe(0.25);
    expect(attrs["mono.agent.duration_ms"]).toBe(10); // always emitted
    expect(attrs).not.toHaveProperty("mono.agent.run.kind");
    expect(attrs).not.toHaveProperty("mono.agent.memory.operation");
    expect(attrs).not.toHaveProperty("llm.model_name");
    expect(attrs).not.toHaveProperty("llm.token_count.prompt");
  });
});

describe("buildEventSpanAttributes", () => {
  it("classifies a tool event with label and TOOL kind hint", () => {
    const result = buildEventSpanAttributes(
      { type: "tool.call", toolName: "Read", status: "started" },
      0,
      makeContext({ sourceId: "src-1" }),
    );
    expect(result.attributes["mono.agent.event.index"]).toBe(0);
    expect(result.attributes["mono.agent.event.type"]).toBe("tool.call");
    expect(result.attributes["mono.agent.event.category"]).toBe("tool");
    expect(result.attributes["mono.agent.event.label"]).toBe("Tool: Read");
    expect(result.attributes["mono.agent.run_id"]).toBe("run-1");
    expect(result.attributes["mono.agent.source_id"]).toBe("src-1");
    expect(spanKindHint(result.category)).toBe("TOOL");
  });

  it("classifies a nested assistant tool_use block as tool with a TOOL span kind hint", () => {
    const result = buildEventSpanAttributes(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/etc/hosts" } }] },
      },
      5,
      makeContext(),
    );
    expect(result.category).toBe("tool");
    expect(result.attributes["mono.agent.event.label"]).toBe("Tool: Read");
    expect(spanKindHint(result.category)).toBe("TOOL");
  });

  it("classifies a nested user tool_result block as tool", () => {
    const result = buildEventSpanAttributes(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      },
      6,
      makeContext(),
    );
    expect(result.category).toBe("tool");
    expect(result.attributes["mono.agent.event.label"]).toBe("Tool result");
  });

  it("folds Write tool_use and tool_result into a real Write TOOL span", () => {
    const events: RuntimeEventLike[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: "notes.txt" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "write-1", content: "Successfully wrote notes.txt" }] },
      },
    ];

    const spans = buildEventSpans(events, makeContext({ includeSensitiveData: true }));

    expect(spans).toHaveLength(1);
    expect(spans[0]?.category).toBe("tool");
    expect(spans[0]?.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(spans[0]?.attributes["mono.agent.tool.name"]).toBe("Write");
    expect(spans[0]?.attributes["tool.name"]).toBe("Write");
    expect(spans[0]?.attributes["mono.agent.tool.use_id"]).toBe("write-1");
    expect(spans[0]?.attributes["mono.agent.tool.name"]).not.toBe("file_edit");
    expect(spans[0]?.attributes["mono.agent.tool.file_change.available"]).toBe(false);

    const withFileChange = buildEventSpans([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "write-2", name: "Write", input: { file_path: "notes.txt" } }] },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "write-2",
            content: "Successfully wrote notes.txt",
            file_change: {
              status: "completed",
              summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
              changes: [{ path: "notes.txt", kind: "update" }],
            },
          }],
        },
      },
    ], makeContext());

    expect(withFileChange).toHaveLength(1);
    expect(withFileChange[0]?.attributes["mono.agent.tool.name"]).toBe("Write");
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.available"]).toBe(true);
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.status"]).toBe("completed");
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.files"]).toBe(1);
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.added_lines"]).toBe(2);
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.removed_lines"]).toBe(1);
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.changed_lines"]).toBe(3);
    expect(withFileChange[0]?.attributes["mono.agent.tool.file_change.unavailable_count"]).toBe(0);
    expect(withFileChange[0]?.attributes).not.toHaveProperty("mono.agent.tool.file_change.paths");

    const sensitive = buildEventSpans([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "write-3", name: "Write", input: { file_path: "notes.txt" } }] },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "write-3",
            content: "Successfully wrote notes.txt",
            file_change: {
              status: "completed",
              summary: { files: 1 },
              changes: [{ path: "notes.txt", kind: "update" }],
            },
          }],
        },
      },
    ], makeContext({ includeSensitiveData: true }));
    expect(sensitive[0]?.attributes["mono.agent.tool.file_change.paths"]).toBe("notes.txt");
  });

  it("exports provider-native file changes as runtime spans with failed status preserved", () => {
    const completed = buildEventSpanAttributes(
      {
        type: "file_change",
        status: "completed",
        changes: [{ path: "notes.txt", kind: "update" }],
        summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
      },
      7,
      makeContext(),
    );
    expect(completed.category).toBe("runtime");
    expect(completed.name).toBe("file change");
    expect(completed.attributes["mono.agent.event.label"]).toBe("file change");
    expect(completed.attributes["mono.agent.file_change.status"]).toBe("completed");
    expect(completed.attributes["mono.agent.file_change.files"]).toBe(1);
    expect(completed.attributes["mono.agent.file_change.added_lines"]).toBe(2);
    expect(completed.attributes["mono.agent.file_change.removed_lines"]).toBe(1);
    expect(completed.attributes["mono.agent.file_change.changed_lines"]).toBe(3);
    expect(completed.attributes["mono.agent.file_change.unavailable_count"]).toBe(0);
    expect(completed.attributes).not.toHaveProperty("mono.agent.file_change.paths");
    expect(spanStatusFor("succeeded", completed.category)).toBe("UNSET");

    const events: RuntimeEventLike[] = [
      {
        type: "file_change",
        status: "failed",
        changes: [{ path: "notes.txt", kind: "update" }],
        summary: { files: 1, added_lines: 0, removed_lines: 0, changed_lines: 0, unavailable_count: 1 },
      },
    ];
    const spans = buildEventSpans(events, makeContext());

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("file change failed");
    expect(spans[0]?.category).toBe("error");
    expect(spans[0]?.attributes["openinference.span.kind"]).toBe("CHAIN");
    expect(spans[0]?.attributes["output.value"]).toBe("file change failed");
    expect(spans[0]?.attributes["mono.agent.file_change.status"]).toBe("failed");
    expect(spans[0]?.attributes["mono.agent.file_change.files"]).toBe(1);
    expect(spans[0]?.attributes["mono.agent.file_change.unavailable_count"]).toBe(1);
    expect(spans[0]?.attributes).not.toHaveProperty("mono.agent.file_change.paths");
    expect(spanStatusFor("succeeded", spans[0]?.category ?? "runtime")).toBe("ERROR");

    const sensitive = buildEventSpans(events, makeContext({ includeSensitiveData: true }));
    expect(sensitive[0]?.attributes["mono.agent.file_change.paths"]).toBe("notes.txt");
  });

  it("classifies an assistant text event as message", () => {
    const result = buildEventSpanAttributes(
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      1,
      makeContext(),
    );
    expect(result.category).toBe("message");
    expect(spanKindHint(result.category)).toBe("LLM");
  });

  it("classifies thinking blocks as thinking", () => {
    const result = buildEventSpanAttributes(
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
      2,
      makeContext(),
    );
    expect(result.category).toBe("thinking");
    expect(spanKindHint(result.category)).toBe("LLM");
  });

  it("classifies a real runtime_warning event (with a message field) as runtime, not message", () => {
    // Mirror the canonical harness shape: runtime_warning events carry a
    // `message` string. They must map to a runtime span, not an LLM/message span.
    const result = buildEventSpanAttributes(
      { type: "runtime_warning", warning_kind: "memory_degraded", message: "Memory recall failed; continuing without memory." },
      3,
      makeContext(),
    );
    expect(result.category).toBe("runtime");
    expect(spanStatusFor("succeeded", result.category)).not.toBe("ERROR");
  });

  it("treats provider latency events via the generic runtime span path", () => {
    const result = buildEventSpanAttributes(
      { type: "provider_bridge_latency", latencyMs: 1234 },
      4,
      makeContext(),
    );
    expect(result.category).toBe("runtime");
    expect(spanKindHint(result.category)).toBe("INTERNAL");
  });

  it("omits raw payload when includeSensitiveData is false (metadata-only)", () => {
    const result = buildEventSpanAttributes(
      { type: "tool.call", toolName: "Read", apiKey: "secret-value" },
      0,
      makeContext({ includeSensitiveData: false }),
    );
    expect(result.payload).toBeUndefined();
  });

  it("includes a redacted payload when includeSensitiveData is true", () => {
    const result = buildEventSpanAttributes(
      { type: "tool.call", toolName: "Read", apiKey: "secret-value" },
      0,
      makeContext({ includeSensitiveData: true }),
    );
    expect(result.payload).toBeDefined();
    expect(JSON.stringify(result.payload)).not.toContain("secret-value");
    expect(JSON.stringify(result.payload)).toContain("[redacted]");
  });

  it("redacts secret-shaped free text from event summaries and payloads only when opted in", () => {
    const fixture = ["ghp", "_", "A".repeat(36)].join("");
    const event = { type: "assistant_message", role: "assistant", text: `returned ${fixture}` };

    const optedIn = buildEventSpanAttributes(
      event,
      0,
      makeContext({ includeSensitiveData: true, contentPatternRedaction: true }),
    );
    expect(optedIn.attributes["mono.agent.event.summary"]).toContain("returned [redacted]");
    expect(JSON.stringify(optedIn.payload)).not.toContain(fixture);

    const defaultMode = buildEventSpanAttributes(
      event,
      0,
      makeContext({ includeSensitiveData: true }),
    );
    expect(defaultMode.attributes["mono.agent.event.summary"]).toContain(fixture);
  });

  it("omits the content-derived summary attribute in metadata-only mode but keeps the structural label", () => {
    const result = buildEventSpanAttributes(
      { type: "assistant_message", role: "assistant", text: "the secret answer is 42" },
      0,
      makeContext({ includeSensitiveData: false }),
    );
    expect(result.attributes["mono.agent.event.summary"]).toBeUndefined();
    // No attribute value carries the message content.
    expect(JSON.stringify(result.attributes)).not.toContain("the secret answer is 42");
    // The structural label is still present for navigation.
    expect(result.attributes["mono.agent.event.label"]).toBe("Message: assistant");
  });

  it("includes the summary attribute when includeSensitiveData is true", () => {
    const result = buildEventSpanAttributes(
      { type: "assistant_message", role: "assistant", text: "the secret answer is 42" },
      0,
      makeContext({ includeSensitiveData: true }),
    );
    expect(result.attributes["mono.agent.event.summary"]).toContain("the secret answer is 42");
  });

  it("redacts secret-shaped assistant and tool content across semantic spans", () => {
    const fixture = ["xox", "b-", "A".repeat(24)].join("");
    const spans = buildEventSpans(
      [
        { type: "assistant", message: { content: [{ type: "text", text: `reply ${fixture}` }] } },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: `input ${fixture}` }] },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: `output ${fixture}` }] },
        },
      ],
      makeContext({ includeSensitiveData: true, contentPatternRedaction: true }),
    );

    expect(JSON.stringify(spans)).not.toContain(fixture);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.attributes["output.value"]).toBe("reply [redacted]");
    expect(spans[0]?.attributes["mono.agent.event.summary"]).toBe("reply [redacted]");
    expect(spans[1]?.attributes["input.value"]).toBe("input [redacted]");
    expect(spans[1]?.attributes["output.value"]).toBe("output [redacted]");
  });
});

describe("countRuntimeWarnings", () => {
  it("counts only events whose type is runtime_warning", () => {
    const count = countRuntimeWarnings([
      { type: "runtime_warning", summary: "a" },
      { type: "tool.call" },
      { type: "runtime_warning", summary: "b" },
      { type: "assistant" },
    ]);
    expect(count).toBe(2);
  });

  it("returns 0 when there are no warnings", () => {
    expect(countRuntimeWarnings([{ type: "tool.call" }])).toBe(0);
  });
});

describe("spanStatusFor", () => {
  it("maps failed/cancelled run status to ERROR", () => {
    expect(spanStatusFor("failed", "runtime")).toBe("ERROR");
    expect(spanStatusFor("cancelled", "runtime")).toBe("ERROR");
  });

  it("maps error event category to ERROR", () => {
    expect(spanStatusFor("succeeded", "error")).toBe("ERROR");
  });

  it("maps succeeded run with non-error category to UNSET", () => {
    expect(spanStatusFor("succeeded", "runtime")).toBe("UNSET");
  });
});

describe("normalizeFailoverHistory", () => {
  it("canonicalizes raw router entries (ModelRef + retryableSubkind) into FailoverAttempt[]", () => {
    const raw = [
      {
        model: { sdk: "pi", model: "gpt-5.5", provider: "openai-codex", reference: "pi:openai-codex:gpt-5.5" },
        failureKind: "provider_unavailable",
        requestId: null,
        retryableSubkind: "timeout",
      },
      {
        model: { reference: "pi:opencode-go:kimi-k2.6" },
        failureKind: "provider_unavailable",
        requestId: "abc123",
        retryableSubkind: "server_error",
      },
      { model: { reference: "pi:foo:bar" }, failureKind: "skipped_capability_mismatch" },
    ];
    expect(normalizeFailoverHistory(raw)).toEqual([
      { model: "pi:openai-codex:gpt-5.5", failureKind: "provider_unavailable", subkind: "timeout" },
      { model: "pi:opencode-go:kimi-k2.6", failureKind: "provider_unavailable", subkind: "server_error", requestId: "abc123" },
      { model: "pi:foo:bar", failureKind: "skipped_capability_mismatch" },
    ]);
  });

  it("is idempotent on already-normalized data and falls back to model.model", () => {
    expect(normalizeFailoverHistory([{ model: "pi:x:y", subkind: "overloaded" }])).toEqual([
      { model: "pi:x:y", subkind: "overloaded" },
    ]);
    expect(normalizeFailoverHistory([{ model: { model: "bare-model" }, failureKind: "spawn" }])).toEqual([
      { model: "bare-model", failureKind: "spawn" },
    ]);
  });

  it("returns undefined for non-arrays, empty arrays, and entries with no usable fields", () => {
    expect(normalizeFailoverHistory(undefined)).toBeUndefined();
    expect(normalizeFailoverHistory([])).toBeUndefined();
    expect(normalizeFailoverHistory("nope")).toBeUndefined();
    expect(normalizeFailoverHistory([{}, { model: null }])).toBeUndefined();
  });
});

describe("renderFailoverHistory", () => {
  it("renders a compact `model → reason (req id)` list", () => {
    const rendered = renderFailoverHistory([
      { model: "pi:openai-codex:gpt-5.5", failureKind: "provider_unavailable", subkind: "timeout" },
      { model: "pi:opencode-go:kimi-k2.6", failureKind: "provider_unavailable", subkind: "server_error", requestId: "abc123" },
    ]);
    expect(rendered).toBe("pi:openai-codex:gpt-5.5 → timeout, pi:opencode-go:kimi-k2.6 → server_error (req abc123)");
  });

  it("falls back to failureKind when no subkind, and to a placeholder model", () => {
    expect(renderFailoverHistory([{ failureKind: "skipped_capability_mismatch" }])).toBe(
      "(unknown model) → skipped_capability_mismatch",
    );
  });

  it("returns undefined for undefined/empty history", () => {
    expect(renderFailoverHistory(undefined)).toBeUndefined();
    expect(renderFailoverHistory([])).toBeUndefined();
  });
});

describe("composeFailureDetail", () => {
  it("combines failure kind, failover history, and the capped underlying error", () => {
    const detail = composeFailureDetail(
      makeSummary({
        status: "failed",
        failureKind: "provider_unavailable_exhausted",
        error: "503 Service Unavailable",
        failoverHistory: [
          { model: "pi:openai-codex:gpt-5.5", subkind: "timeout" },
          { model: "pi:opencode-go:kimi-k2.6", subkind: "server_error", requestId: "abc123" },
        ],
      }),
    );
    expect(detail).toBe(
      "provider_unavailable_exhausted: pi:openai-codex:gpt-5.5 → timeout, pi:opencode-go:kimi-k2.6 → server_error (req abc123); last error: 503 Service Unavailable",
    );
  });

  it("caps and single-lines a long error message", () => {
    const detail = composeFailureDetail(
      makeSummary({ status: "failed", failureKind: "runtime_error", error: `line one\nline two ${"x".repeat(500)}` }),
      { maxErrorChars: 20 },
    );
    expect(detail).toBe("runtime_error; last error: line one line two xx…");
  });

  it("returns just the kind when there is no error or failover", () => {
    expect(composeFailureDetail(makeSummary({ status: "failed", failureKind: "boom" }))).toBe("boom");
  });

  it("returns undefined for a clean (non-failed) run", () => {
    expect(composeFailureDetail(makeSummary())).toBeUndefined();
  });
});

describe("buildRootSpanAttributes failure detail", () => {
  it("emits the error message and failover attributes when present", () => {
    const attrs = buildRootSpanAttributes(
      makeSummary({
        status: "failed",
        failureKind: "provider_unavailable_exhausted",
        error: "503 Service Unavailable",
        failoverHistory: [
          { model: "pi:openai-codex:gpt-5.5", subkind: "timeout" },
          { model: "pi:opencode-go:kimi-k2.6", subkind: "server_error", requestId: "abc123" },
        ],
      }),
      makeContext(),
      0,
    );
    expect(attrs["mono.agent.error.message"]).toBe("503 Service Unavailable");
    expect(attrs["mono.agent.failover.count"]).toBe(2);
    expect(attrs["mono.agent.failover.detail"]).toBe(
      "pi:openai-codex:gpt-5.5 → timeout, pi:opencode-go:kimi-k2.6 → server_error (req abc123)",
    );
  });

  it("omits failure-detail attributes for a clean run", () => {
    const attrs = buildRootSpanAttributes(makeSummary(), makeContext(), 0);
    expect(attrs).not.toHaveProperty("mono.agent.error.message");
    expect(attrs).not.toHaveProperty("mono.agent.failover.count");
    expect(attrs).not.toHaveProperty("mono.agent.failover.detail");
  });
});
