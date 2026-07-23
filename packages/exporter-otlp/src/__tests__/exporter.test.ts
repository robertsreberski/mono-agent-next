import type { ExportRecord } from "@mono-agent/module-sdk/internal";
import { describe, expect, it } from "vitest";

import { parseOtlpExporterConfig } from "../config.js";
import { OtlpExporter } from "../exporter.js";
import { mapRecordAttributes } from "../otlp.js";
import type {
  OtlpTransport,
  OtlpTransportRequest,
  OtlpTransportResponse,
} from "../transport.js";

const signal = new AbortController().signal;

describe("OtlpExporter", () => {
  it("bounds the queue and byte/count batches while omitting sensitive bodies by default", async () => {
    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const exporter = createExporter(transport, {
      maxQueueRecords: 2,
      maxBatchRecords: 1,
    });
    const result = await exporter.export({ records: [record("one"), record("two"), record("three")], signal });
    expect(result).toEqual({ accepted: 2, rejected: 1 });

    exporter.start({ signal });
    await exporter.flush(signal);
    expect(transport.requests).toHaveLength(2);
    for (const request of transport.requests) {
      const body = Buffer.from(request.body);
      expect(body.includes(Buffer.from("sensitive-body"))).toBe(false);
      expect(body.includes(Buffer.from("openinference.project.name"))).toBe(true);
      expect(body.includes(Buffer.from("test-agent"))).toBe(true);
      expect(request.headers["content-type"]).toBe("application/x-protobuf");
    }
    expect(exporter.health({ signal })).toMatchObject({
      status: "degraded",
      details: { queuedRecords: 0, deliveredRecords: 2, rejectedRecords: 1 },
    });
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("includes explicitly opted-in bodies and produces deterministic OTLP span ids", async () => {
    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const exporter = createExporter(transport, { includeSensitiveData: true });
    await exporter.export({ records: [record("one")], signal });
    exporter.start({ signal });
    await exporter.flush(signal);
    const first = Buffer.from(transport.requests[0]!.body).toString("utf8");
    expect(first).toContain("sensitive-body");
    await exporter.stop({ signal, reason: "shutdown" });

    const nextTransport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const next = createExporter(nextTransport, { includeSensitiveData: true });
    await next.export({ records: [record("one")], signal });
    next.start({ signal });
    await next.flush(signal);
    expect(Buffer.from(nextTransport.requests[0]!.body).toString("utf8")).toBe(first);
    await next.stop({ signal, reason: "shutdown" });
  });

  it("maps Core turn fields to Phoenix project, session, and OpenInference attributes", () => {
    expect(mapRecordAttributes(record("mapped"))).toMatchObject({
      agentId: "agent-1",
      conversationId: "conversation-1",
      model: "openai:gpt-5",
      "mono.agent.agent_id": "agent-1",
      "mono.agent.conversation_id": "conversation-1",
      "mono.agent.runtime": "pi",
      "mono.agent.model": "openai:gpt-5",
      "mono.agent.status": "completed",
      "llm.model_name": "openai:gpt-5",
      "session.id": "conversation-1",
      "openinference.span.kind": "AGENT",
    });

    const explicit = record("explicit", {
      "session.id": "explicit-session",
      "openinference.span.kind": "CHAIN",
      "llm.model_name": "explicit-model",
    });
    expect(mapRecordAttributes(explicit)).toMatchObject({
      "session.id": "explicit-session",
      "openinference.span.kind": "CHAIN",
      "llm.model_name": "explicit-model",
    });
  });

  it("warns when sensitive bodies are enabled and optionally redacts bounded credential shapes", async () => {
    const secret = `sk-${"A".repeat(48)}`;
    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const exporter = createExporter(transport, {
      includeSensitiveData: true,
      contentPatternRedaction: true,
    });
    expect(exporter.health({ signal })).toMatchObject({
      status: "healthy",
      summary: expect.stringContaining("sensitive body export is enabled"),
      details: {
        includeSensitiveData: true,
        contentPatternRedaction: true,
        warning: expect.stringContaining("Sensitive OTLP body export is enabled"),
      },
    });

    const result = await exporter.export({
      records: [{
        ...record("credential"),
        attributes: {
          ...record("credential").attributes,
          diagnostic: `attribute ${secret}`,
          harmlessPrefix: "documentation mentions sk- without a token",
        },
        body: { prompt: `body ${secret}` },
      }],
      signal,
    });
    expect(result).toEqual({ accepted: 1, rejected: 0 });
    exporter.start({ signal });
    await exporter.flush(signal);
    const payload = Buffer.from(transport.requests[0]!.body).toString("utf8");
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
    expect(payload).toContain("documentation mentions sk- without a token");
    expect(exporter.health({ signal })).toMatchObject({
      status: "healthy",
      details: { redactedRecords: 1, redactedValues: 2 },
    });
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("diagnoses sensitive export and degraded queue state without starting or sending", async () => {
    const sensitiveTransport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const sensitive = createExporter(sensitiveTransport, {
      includeSensitiveData: true,
      contentPatternRedaction: false,
    });
    expect(sensitive.diagnostics({ signal, verbose: false })).toEqual([{
      code: "exporter-otlp.sensitive-data",
      severity: "warning",
      message: "Sensitive OTLP body export is enabled without credential-pattern redaction.",
    }]);
    expect(sensitiveTransport.requests).toHaveLength(0);

    const degradedTransport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const degraded = createExporter(degradedTransport, {
      contentPatternRedaction: true,
      maxRecordBytes: 128,
    });
    expect(await degraded.export({
      records: [{
        ...record("too-large-for-diagnostics"),
        attributes: { text: "x".repeat(129) },
      }],
      signal,
    })).toEqual({ accepted: 0, rejected: 1 });
    expect(degraded.diagnostics({ signal, verbose: true })).toEqual([{
      code: "exporter-otlp.queue",
      severity: "error",
      message: "The bounded OTLP queue has rejected or dropped records, or retains a delivery failure.",
    }]);
    expect(degradedTransport.requests).toHaveLength(0);

    const controller = new AbortController();
    controller.abort(new Error("diagnostics aborted"));
    expect(() => degraded.diagnostics({ signal: controller.signal, verbose: false }))
      .toThrow(expect.objectContaining({ code: "OTLP_ABORTED" }));
  });

  it("scans retained attributes independently of the sensitive-body gate", async () => {
    const secret = `ghp_${"B".repeat(36)}`;
    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const exporter = createExporter(transport, { contentPatternRedaction: true });
    await exporter.export({
      records: [{
        ...record("attribute-only"),
        attributes: { diagnostic: secret },
        body: { omitted: secret },
      }],
      signal,
    });
    exporter.start({ signal });
    await exporter.flush(signal);
    const payload = Buffer.from(transport.requests[0]!.body).toString("utf8");
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
    expect(payload).not.toContain("mono.agent.body");
    expect(exporter.health({ signal })).toMatchObject({
      status: "healthy",
      details: { redactedRecords: 1, redactedValues: 1 },
    });
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("rejects credential scans that exceed the record byte or node budget", async () => {
    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const byteBound = createExporter(transport, {
      contentPatternRedaction: true,
      maxRecordBytes: 128,
    });
    expect(await byteBound.export({
      records: [{
        ...record("too-large"),
        attributes: { text: "x".repeat(129) },
      }],
      signal,
    })).toEqual({ accepted: 0, rejected: 1 });
    expect(byteBound.health({ signal })).toMatchObject({
      status: "degraded",
      details: { rejectedRecords: 1, redactedValues: 0 },
    });
    await byteBound.stop({ signal, reason: "shutdown" });

    const nodeBound = createExporter(transport, { contentPatternRedaction: true });
    expect(await nodeBound.export({
      records: [{
        ...record("too-many-nodes"),
        attributes: { values: Array.from({ length: 10_001 }, () => null) },
      }],
      signal,
    })).toEqual({ accepted: 0, rejected: 1 });
    await nodeBound.stop({ signal, reason: "shutdown" });
  });

  it("keeps every serialized request within the configured byte batch bound", async () => {
    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const exporter = createExporter(transport, {
      maxRecordBytes: 1_024,
      maxBatchBytes: 1_800,
      maxBatchRecords: 10,
    });
    const records = [largeRecord("one"), largeRecord("two"), largeRecord("three")];
    expect(await exporter.export({ records, signal })).toEqual({ accepted: 3, rejected: 0 });
    exporter.start({ signal });
    await exporter.flush(signal);
    expect(transport.requests.length).toBeGreaterThan(1);
    expect(transport.requests.every((request) => request.body.byteLength <= 1_800)).toBe(true);
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("checks redirects and never forwards configured credentials across origins", async () => {
    const transport = new ScriptedTransport((_request, index) => index === 0
      ? {
          status: 307,
          headers: { location: "https://second.example/v1/traces" },
        }
      : { status: 200, headers: {} });
    const exporter = createExporter(transport, {
      headers: {
        authorization: "Bearer secret",
        "x-collector-token": "also-secret",
      },
    });
    await exporter.export({ records: [record("redirect")], signal });
    exporter.start({ signal });
    await exporter.flush(signal);

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-collector-token": "also-secret",
    });
    expect(transport.requests[1]?.url).toBe("https://second.example/v1/traces");
    expect(transport.requests[1]?.headers.authorization).toBeUndefined();
    expect(transport.requests[1]?.headers["x-collector-token"]).toBeUndefined();
    expect(transport.requests[1]?.headers["content-type"]).toBe("application/x-protobuf");
    expect(transport.requests[1]?.headers["x-project-name"]).toBe("test-agent");
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("rejects protocol-downgrade redirects and leaves the failed batch queued", async () => {
    const transport = new ScriptedTransport(() => ({
      status: 307,
      headers: { location: "http://127.0.0.1:4318/v1/traces" },
    }));
    const exporter = createExporter(transport);
    await exporter.export({ records: [record("downgrade")], signal });
    exporter.start({ signal });
    await expect(exporter.flush(signal)).rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
    expect(exporter.health({ signal })).toMatchObject({
      status: "degraded",
      details: { queuedRecords: 1, deliveredRecords: 0 },
    });
    await expect(exporter.stop({ signal, reason: "shutdown" }))
      .rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
  });

  it("retries retained records on a later flush after a transient failure", async () => {
    const transport = new ScriptedTransport((_request, index) => index === 0
      ? { status: 503, headers: {} }
      : { status: 200, headers: {} });
    const exporter = createExporter(transport);
    await exporter.export({ records: [record("retry")], signal });
    await expect(exporter.flush(signal)).rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
    await exporter.flush(signal);
    expect(transport.requests).toHaveLength(2);
    expect(exporter.health({ signal })).toMatchObject({
      details: { queuedRecords: 0, deliveredRecords: 1 },
    });
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("does not surface collector-provided secret text through errors or health", async () => {
    const secret = "Bearer collector-secret-must-not-escape";
    const transport = new ScriptedTransport(() => {
      throw new Error(secret);
    });
    const exporter = createExporter(transport);
    await exporter.export({ records: [record("safe-error")], signal });

    let failure: unknown;
    try {
      await exporter.flush(signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "OTLP_FLUSH_FAILED" });
    expect(errorChain(failure)).not.toContain(secret);
    expect(JSON.stringify(exporter.health({ signal }))).not.toContain(secret);
    await expect(exporter.stop({ signal, reason: "shutdown" }))
      .rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
  });

  it("bounds request and stop deadlines with an abort-aware injected transport", async () => {
    const transport = new ScriptedTransport((request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }));
    const exporter = createExporter(transport, {
      requestTimeoutMs: 15,
      flushTimeoutMs: 100,
      stopTimeoutMs: 30,
    });
    await exporter.export({ records: [record("timeout")], signal });
    exporter.start({ signal });
    await expect(exporter.flush(signal)).rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
    await expect(exporter.stop({ signal, reason: "shutdown" }))
      .rejects.toSatisfy((error: unknown) => {
        return typeof error === "object" && error !== null && "code" in error &&
          (error.code === "OTLP_FLUSH_FAILED" || error.code === "OTLP_TIMEOUT");
      });
  });

  it("shares one bounded stop outcome when an injected transport ignores abort", async () => {
    const transport = new ScriptedTransport(() => new Promise(() => {}));
    const exporter = createExporter(transport, {
      requestTimeoutMs: 1_000,
      stopTimeoutMs: 20,
    });
    await exporter.export({ records: [record("uncooperative")], signal });
    exporter.start({ signal });
    const first = exporter.stop({ signal, reason: "shutdown" });
    const second = exporter.stop({ signal, reason: "shutdown" });
    expect(second).toBe(first);
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "OTLP_TIMEOUT" });
      }
    }
  });
});

class ScriptedTransport implements OtlpTransport {
  readonly requests: OtlpTransportRequest[] = [];
  private readonly handler: (
    request: OtlpTransportRequest,
    index: number,
  ) => OtlpTransportResponse | Promise<OtlpTransportResponse>;

  constructor(handler: ScriptedTransport["handler"]) {
    this.handler = handler;
  }

  send(request: OtlpTransportRequest): Promise<OtlpTransportResponse> {
    const snapshot: OtlpTransportRequest = {
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body),
    };
    const index = this.requests.push(snapshot) - 1;
    return Promise.resolve(this.handler(request, index));
  }
}

function createExporter(
  transport: OtlpTransport,
  overrides: Readonly<Record<string, unknown>> = {},
): OtlpExporter {
  const config = parseOtlpExporterConfig({
    endpoint: "https://collector.example/v1/traces",
    projectName: "test-agent",
    maxQueueRecords: 10,
    maxQueueBytes: 64 * 1024,
    maxBatchRecords: 10,
    maxBatchBytes: 16 * 1024,
    maxRecordBytes: 8 * 1024,
    flushIntervalMs: 60_000,
    requestTimeoutMs: 1_000,
    flushTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    ...overrides,
  });
  return new OtlpExporter(config, {
    transport,
    clock: () => new Date("2026-07-23T12:00:00.000Z"),
  });
}

function record(
  name: string,
  overrides: Readonly<Record<string, ExportRecord["attributes"][string]>> = {},
): ExportRecord {
  return {
    name,
    timestamp: "2026-07-23T12:00:00.000Z",
    attributes: {
      "mono.agent.run_id": "run-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      runtime: "pi",
      model: "openai:gpt-5",
      status: "completed",
      attempt: 1,
      ...overrides,
    },
    body: { prompt: "sensitive-body" },
  };
}

function largeRecord(name: string): ExportRecord {
  return {
    ...record(name),
    attributes: { payload: "x".repeat(500) },
  };
}

function errorChain(value: unknown): string {
  const messages: string[] = [];
  let current = value;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}
