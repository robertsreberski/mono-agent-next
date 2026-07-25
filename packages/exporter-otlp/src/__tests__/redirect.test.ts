// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  createExporter,
  errorCodes,
  record,
  ScriptedTransport,
  signal,
} from "./helpers.js";

describe("OtlpExporter redirects", () => {
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
    expect(transport.requests[1]?.url).toBe(
      "https://second.example/v1/traces",
    );
    expect(transport.requests[1]?.headers.authorization).toBeUndefined();
    expect(transport.requests[1]?.headers["x-collector-token"]).toBeUndefined();
    expect(transport.requests[1]?.headers["content-type"])
      .toBe("application/x-protobuf");
    expect(transport.requests[1]?.headers["x-project-name"]).toBe("test-agent");
    await exporter.stop({ signal, reason: "shutdown" });
  });

  it("rejects cross-origin redirects when sensitive data is included", async () => {
    const transport = new ScriptedTransport(() => ({
      status: 307,
      headers: { location: "https://second.example/v1/traces" },
    }));
    const exporter = createExporter(transport, { includeSensitiveData: true });
    await exporter.export({
      records: [record("sensitive-redirect")],
      signal,
    });

    let failure: unknown;
    try {
      await exporter.flush(signal);
    } catch (error) {
      failure = error;
    }
    expect(errorCodes(failure)).toEqual([
      "OTLP_FLUSH_FAILED",
      "OTLP_REDIRECT_REJECTED",
    ]);
    expect(transport.requests).toHaveLength(1);
    expect(Buffer.from(transport.requests[0]!.body).toString("utf8"))
      .toContain("sensitive-body");
    expect(exporter.health({ signal })).toMatchObject({
      status: "degraded",
      details: { queuedRecords: 1, deliveredRecords: 0 },
    });
    await expect(exporter.stop({ signal, reason: "shutdown" }))
      .rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
  });

  it("rejects protocol-downgrade redirects and leaves the failed batch queued", async () => {
    const transport = new ScriptedTransport(() => ({
      status: 307,
      headers: { location: "http://127.0.0.1:4318/v1/traces" },
    }));
    const exporter = createExporter(transport);
    await exporter.export({ records: [record("downgrade")], signal });
    exporter.start({ signal });
    await expect(exporter.flush(signal))
      .rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
    expect(exporter.health({ signal })).toMatchObject({
      status: "degraded",
      details: { queuedRecords: 1, deliveredRecords: 0 },
    });
    await expect(exporter.stop({ signal, reason: "shutdown" }))
      .rejects.toMatchObject({ code: "OTLP_FLUSH_FAILED" });
  });
});
