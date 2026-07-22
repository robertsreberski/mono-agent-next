import { describe, expect, it } from "vitest";

import {
  otlpExporterConfigSchema,
  parseOtlpExporterConfig,
} from "../config.js";

describe("OTLP exporter config", () => {
  it("accepts HTTPS and literal-loopback HTTP with resolved environment-backed headers", () => {
    const remote = parseOtlpExporterConfig({
      endpoint: "https://collector.example/v1/traces",
      projectName: "personal-agent",
      headers: { Authorization: "Bearer resolved-secret" },
    });
    expect(remote.endpoint).toBe("https://collector.example/v1/traces");
    expect(remote.headers).toEqual({ authorization: "Bearer resolved-secret" });

    expect(parseOtlpExporterConfig({
      endpoint: "http://127.0.0.1:6006/v1/traces",
      projectName: "local",
    }).endpoint).toBe("http://127.0.0.1:6006/v1/traces");
    expect(parseOtlpExporterConfig({
      endpoint: "http://[::1]:4318/v1/traces",
      projectName: "local-v6",
    }).endpoint).toBe("http://[::1]:4318/v1/traces");
  });

  it("marks every configurable header value as an SDK secret environment field", () => {
    const jsonSchema = otlpExporterConfigSchema.jsonSchema as {
      properties: { headers: { additionalProperties: Record<string, unknown> } };
    };
    expect(jsonSchema.properties.headers.additionalProperties).toMatchObject({
      "x-mono-agent-env-eligible": true,
      "x-mono-agent-secret": true,
    });
  });

  it.each([
    "http://localhost:4318/v1/traces",
    "http://192.168.1.5:4318/v1/traces",
    "http://8.8.8.8:4318/v1/traces",
    "ftp://collector.example/v1/traces",
    "https://user:password@collector.example/v1/traces",
    "https://collector.example/v1/traces?token=secret",
    "https://collector.example/v1/traces#fragment",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => parseOtlpExporterConfig({ endpoint, projectName: "test" }))
      .toThrow(/endpoint/u);
  });

  it("rejects raw env wrappers, forbidden headers, injection, and inconsistent bounds", () => {
    expect(() => parseOtlpExporterConfig({
      endpoint: "https://collector.example/v1/traces",
      projectName: "test",
      headers: { Authorization: { $env: "TOKEN" } },
    })).toThrow(/resolved printable/u);
    expect(() => parseOtlpExporterConfig({
      endpoint: "https://collector.example/v1/traces",
      projectName: "test",
      headers: { Host: "evil.example" },
    })).toThrow(/forbidden/u);
    expect(() => parseOtlpExporterConfig({
      endpoint: "https://collector.example/v1/traces",
      projectName: "test",
      headers: { Authorization: "secret\r\nX-Evil: yes" },
    })).toThrow(/printable/u);
    expect(() => parseOtlpExporterConfig({
      endpoint: "https://collector.example/v1/traces",
      projectName: "test",
      maxRecordBytes: 1_024,
      maxBatchBytes: 512,
    })).toThrow(/maxRecordBytes/u);
  });
});
