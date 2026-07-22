import { describe, expect, it } from "vitest";

import type {
  ObservabilityExporterConfig,
  PhoenixExporterConfig,
  RedactJsonValueOptions,
  RunExportContext,
  RunExportEventContext,
  RunExporter,
  RunSummary,
  RuntimeEventLike,
} from "../index.js";

describe("run-export contracts", () => {
  it("exports content-pattern redaction options from the package root", () => {
    const options: RedactJsonValueOptions = { contentPatternRedaction: true };
    expect(options.contentPatternRedaction).toBe(true);
  });

  it("constructs a RunExportContext with optional fields omitted", () => {
    const context: RunExportContext = {
      runId: "run-1",
      conversationId: "conv-1",
      includeSensitiveData: false,
    };
    expect(context.runId).toBe("run-1");
    expect(context.conversationId).toBe("conv-1");
    expect(context.includeSensitiveData).toBe(false);
    expect(context.sourceId).toBeUndefined();
  });

  it("constructs a RunExportContext with all optional fields", () => {
    const context: RunExportContext = {
      runId: "run-1",
      conversationId: "conv-1",
      sourceId: "source-1",
      sourceLabel: "Source One",
      configPath: "/tmp/config.json",
      artifactDir: "/tmp/artifacts",
      includeSensitiveData: true,
      contentPatternRedaction: true,
    };
    expect(context.sourceLabel).toBe("Source One");
    expect(context.contentPatternRedaction).toBe(true);
  });

  it("RunExportEventContext extends RunExportContext with eventIndex", () => {
    const eventContext: RunExportEventContext = {
      runId: "run-1",
      conversationId: "conv-1",
      includeSensitiveData: false,
      eventIndex: 3,
    };
    expect(eventContext.eventIndex).toBe(3);
  });

  it("supports a RunExporter implementation with all-optional async-capable hooks", async () => {
    const seen: string[] = [];
    const context: RunExportContext = {
      runId: "run-1",
      conversationId: "conv-1",
      includeSensitiveData: false,
    };
    const summary: RunSummary = {
      runId: "run-1",
      conversationId: "conv-1",
      status: "succeeded",
      durationMs: 1,
      eventCount: 1,
      artifactPaths: [],
    };
    const event: RuntimeEventLike = { type: "assistant_message" };

    const exporter: RunExporter = {
      start(ctx: RunExportContext) {
        seen.push(`start:${ctx.runId}`);
      },
      async onEvent(_event: RuntimeEventLike, ctx: RunExportEventContext) {
        seen.push(`event:${ctx.eventIndex}`);
      },
      async finish(s: RunSummary) {
        seen.push(`finish:${s.status}`);
      },
      async fail(s: RunSummary, _error: unknown) {
        seen.push(`fail:${s.status}`);
      },
      async flush() {
        seen.push("flush");
      },
      async close() {
        seen.push("close");
      },
    };

    await exporter.start?.(context);
    await exporter.onEvent?.(event, { ...context, eventIndex: 0 });
    await exporter.finish?.(summary, context);
    await exporter.fail?.(summary, new Error("boom"), context);
    await exporter.flush?.();
    await exporter.close?.();

    expect(seen).toEqual([
      "start:run-1",
      "event:0",
      "finish:succeeded",
      "fail:succeeded",
      "flush",
      "close",
    ]);
  });

  it("supports an empty RunExporter (all hooks optional)", () => {
    const exporter: RunExporter = {};
    expect(exporter.start).toBeUndefined();
    expect(exporter.finish).toBeUndefined();
  });

  it("constructs a PhoenixExporterConfig and the ObservabilityExporterConfig alias", () => {
    const phoenix: PhoenixExporterConfig = {
      type: "phoenix",
      endpoint: "http://127.0.0.1:6006/v1/traces",
      headers: { authorization: "secret" },
      includeSensitiveData: false,
      contentPatternRedaction: true,
      timeoutMs: 5000,
    };
    const config: ObservabilityExporterConfig = phoenix;
    expect(config.type).toBe("phoenix");
    expect(config.headers?.authorization).toBe("secret");
    expect(config.contentPatternRedaction).toBe(true);
  });

  it("constructs a minimal PhoenixExporterConfig (type only)", () => {
    const phoenix: PhoenixExporterConfig = { type: "phoenix" };
    expect(phoenix.type).toBe("phoenix");
    expect(phoenix.endpoint).toBeUndefined();
  });
});
