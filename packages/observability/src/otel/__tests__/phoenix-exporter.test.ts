import { describe, expect, it, vi } from "vitest";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExportEventContext,
  RunSummary,
} from "../../types.js";

import { DEFAULT_MAX_EVENTS_PER_RUN } from "../../guards.js";
import { createPhoenixRunExporter } from "../phoenix-exporter.js";

const summary: RunSummary = {
  runId: "run-1",
  conversationId: "conv-1",
  status: "succeeded",
  durationMs: 100,
  eventCount: 1,
  artifactPaths: [],
};

const baseCtx: RunExportContext = {
  runId: "run-1",
  conversationId: "conv-1",
  sourceId: "src-1",
  includeSensitiveData: false,
};

function eventCtx(index: number, ctx: RunExportContext = baseCtx): RunExportEventContext {
  return { ...ctx, eventIndex: index };
}

function capturingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 200 });
  });
  return {
    fetch: impl as unknown as typeof fetch,
    count: () => impl.mock.calls.length,
    url: () => calls.at(-1)?.url,
    headers: (i = 0) => calls[i]!.init.headers as Record<string, string>,
    bodyBytes: (i = 0) => calls[i]!.init.body as Uint8Array,
    bodyText: (i = 0) => Buffer.from(calls[i]!.init.body as Uint8Array).toString("utf8"),
  };
}

describe("createPhoenixRunExporter", () => {
  it("finish posts exactly one protobuf request to the configured endpoint", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter(
      { type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" },
      { fetch: cap.fetch, now: () => 1000 },
    );

    await exporter.start?.(baseCtx);
    await exporter.onEvent?.({ type: "tool_call", name: "Read" }, eventCtx(0));
    await exporter.finish?.(summary, baseCtx);

    expect(cap.count()).toBe(1);
    expect(cap.url()).toBe("http://127.0.0.1:6006/v1/traces");
    expect(cap.headers()["content-type"]).toBe("application/x-protobuf");
    expect(cap.bodyBytes()).toBeInstanceOf(Uint8Array);
    expect(cap.bodyBytes().length).toBeGreaterThan(0);
  });

  it("uses the default Phoenix endpoint when none is configured", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter({ type: "phoenix" }, { fetch: cap.fetch, now: () => 1 });
    await exporter.finish?.(summary, baseCtx);
    expect(cap.url()).toBe("http://127.0.0.1:6006/v1/traces");
  });

  it("routes via x-project-name: config.projectName wins, else source label/id", async () => {
    const withProject = capturingFetch();
    const a = createPhoenixRunExporter(
      { type: "phoenix", projectName: "explicit-project" },
      { fetch: withProject.fetch, now: () => 1 },
    );
    await a.finish?.(summary, baseCtx);
    expect(withProject.headers()["x-project-name"]).toBe("explicit-project");

    const fromSource = capturingFetch();
    const b = createPhoenixRunExporter({ type: "phoenix" }, { fetch: fromSource.fetch, now: () => 1 });
    await b.finish?.(summary, { ...baseCtx, sourceLabel: "Local Agent Alpha" });
    expect(fromSource.headers()["x-project-name"]).toBe("Local Agent Alpha");
  });

  it("is metadata-only by default: no raw secret in the posted bytes", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter({ type: "phoenix" }, { fetch: cap.fetch, now: () => 1 });
    await exporter.onEvent?.(
      { type: "tool_call", name: "Read", input: { apiKey: "sk-supersecret-value" } },
      eventCtx(0),
    );
    await exporter.finish?.(summary, baseCtx);
    expect(cap.bodyText()).not.toContain("sk-supersecret-value");
  });

  it("includeSensitiveData=true exports a redacted payload (apiKey -> [redacted])", async () => {
    const cap = capturingFetch();
    const ctx: RunExportContext = { ...baseCtx, includeSensitiveData: true };
    const exporter = createPhoenixRunExporter(
      { type: "phoenix", includeSensitiveData: true },
      { fetch: cap.fetch, now: () => 1 },
    );
    await exporter.onEvent?.(
      { type: "tool_call", name: "Read", input: { apiKey: "sk-supersecret-value" } },
      eventCtx(0, ctx),
    );
    await exporter.finish?.(summary, ctx);
    expect(cap.bodyText()).not.toContain("sk-supersecret-value");
    expect(cap.bodyText()).toContain("[redacted]");
  });

  it("applies config-level content pattern redaction to free text", async () => {
    const fixture = ["AK", "IA", "A".repeat(16)].join("");
    const cap = capturingFetch();
    const ctx: RunExportContext = { ...baseCtx, includeSensitiveData: true };
    const exporter = createPhoenixRunExporter(
      { type: "phoenix", includeSensitiveData: true, contentPatternRedaction: true },
      { fetch: cap.fetch, now: () => 1 },
    );
    await exporter.onEvent?.(
      { type: "assistant_message", role: "assistant", text: `returned ${fixture}` },
      eventCtx(0, ctx),
    );
    await exporter.finish?.({ ...summary, eventCount: 1 }, ctx);

    expect(cap.bodyText()).not.toContain(fixture);
    expect(cap.bodyText()).toContain("[redacted]");
  });

  it("caps events when used directly", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter({ type: "phoenix" }, { fetch: cap.fetch, now: () => 1 });
    const totalEvents = DEFAULT_MAX_EVENTS_PER_RUN + 1;

    await exporter.start?.(baseCtx);
    for (let index = 0; index < totalEvents; index += 1) {
      const name =
        index === DEFAULT_MAX_EVENTS_PER_RUN - 1
          ? "last-kept-marker"
          : index === DEFAULT_MAX_EVENTS_PER_RUN
            ? "overflow-marker"
            : "Read";
      await exporter.onEvent?.({ type: "tool_call", name }, eventCtx(index));
    }
    await exporter.finish?.({ ...summary, eventCount: totalEvents }, baseCtx);

    expect(cap.bodyText()).toContain("last-kept-marker");
    expect(cap.bodyText()).not.toContain("overflow-marker");
  });

  it("uses deterministic ids: re-exporting the same run yields byte-identical bodies", async () => {
    const config: PhoenixExporterConfig = { type: "phoenix" };
    const first = capturingFetch();
    const second = capturingFetch();
    const a = createPhoenixRunExporter(config, { fetch: first.fetch, now: () => 1000 });
    const b = createPhoenixRunExporter(config, { fetch: second.fetch, now: () => 1000 });
    await a.finish?.(summary, baseCtx);
    await b.finish?.(summary, baseCtx);
    expect(Buffer.from(first.bodyBytes()).equals(Buffer.from(second.bodyBytes()))).toBe(true);
  });

  it("rejects when fetch rejects so the COMPOSITE can swallow the error", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: failing as unknown as typeof fetch, now: () => 1 },
    );
    await expect(exporter.finish?.(summary, baseCtx)).rejects.toThrow(/network down/u);
  });

  it("rejects when the collector returns a non-2xx status", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 415 }));
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: bad as unknown as typeof fetch, now: () => 1 },
    );
    await expect(exporter.finish?.(summary, baseCtx)).rejects.toThrow(/415/u);
  });

  it("fail posts exactly one request", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter({ type: "phoenix" }, { fetch: cap.fetch, now: () => 1 });
    const failed: RunSummary = { ...summary, status: "failed", failureKind: "boom" };
    await exporter.fail?.(failed, new Error("boom"), baseCtx);
    expect(cap.count()).toBe(1);
  });
});
