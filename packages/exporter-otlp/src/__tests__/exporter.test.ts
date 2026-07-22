import type { ExportRecord } from "@mono-agent/module-sdk/internal";
import { describe, expect, it } from "vitest";

import { parseOtlpExporterConfig } from "../config.js";
import { OtlpExporter } from "../exporter.js";
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

function record(name: string): ExportRecord {
  return {
    name,
    timestamp: "2026-07-23T12:00:00.000Z",
    attributes: { "mono.agent.run_id": "run-1", attempt: 1 },
    body: { prompt: "sensitive-body" },
  };
}

function largeRecord(name: string): ExportRecord {
  return {
    ...record(name),
    attributes: { payload: "x".repeat(500) },
  };
}
