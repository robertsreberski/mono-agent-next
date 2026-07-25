// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import type { ArtifactRef } from "@mono-agent/module-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  normalizeToolResult,
  TOOL_RESULT_ARTIFACT_FILE_NAME,
  TOOL_RESULT_ARTIFACT_MEDIA_TYPE,
  TOOL_RESULT_INLINE_MAX_BYTES,
  TOOL_RESULT_MAX_JSON_DEPTH,
  TOOL_RESULT_MAX_JSON_ITEMS,
  TOOL_RESULT_MAX_PARTS,
  TOOL_RESULT_PREVIEW_MAX_BYTES,
  type ToolResultArtifactSink,
  type ToolResultArtifactWrite,
} from "../tool-result-normalizer.js";

describe("normalizeToolResult", () => {
  it("normalizes supported MCP parts and preserves isError", async () => {
    const existing = artifactRef(Buffer.from("existing", "utf8"), "text/plain");
    const result = await normalizeToolResult({
      isError: true,
      content: [
        { type: "text", text: "failed safely" },
        { type: "json", value: { retryable: false } },
        { type: "image", data: "aGVsbG8=", mimeType: "IMAGE/PNG", name: "probe.png" },
        { type: "artifact", ref: existing, preview: "existing preview" },
      ],
    });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: "failed safely" },
        { type: "json", value: { retryable: false } },
        {
          type: "file",
          data: "aGVsbG8=",
          mediaType: "image/png",
          name: "probe.png",
        },
        { type: "artifact", ref: existing, preview: "existing preview" },
      ],
    });
  });

  it("keeps an exact-limit envelope inline and atomically offloads limit plus one", async () => {
    const overhead = encodedEnvelopeBytes("");
    const exactText = "x".repeat(TOOL_RESULT_INLINE_MAX_BYTES - overhead);
    const exact = await normalizeToolResult({
      content: [{ type: "text", text: exactText }],
    });
    expect(encodedEnvelopeBytes(exactText)).toBe(TOOL_RESULT_INLINE_MAX_BYTES);
    expect(exact).toEqual({
      isError: false,
      content: [{ type: "text", text: exactText }],
    });

    const writes: ToolResultArtifactWrite[] = [];
    const sink = recordingSink(writes);
    const overText = "x".repeat(
      TOOL_RESULT_INLINE_MAX_BYTES - encodedEnvelopeBytes("", true) + 1,
    );
    const offloaded = await normalizeToolResult(
      {
        isError: true,
        content: [{ type: "text", text: overText }],
      },
      { artifactSink: sink },
    );

    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(write).toBeDefined();
    expect(write?.mediaType).toBe(TOOL_RESULT_ARTIFACT_MEDIA_TYPE);
    expect(write?.fileName).toBe(TOOL_RESULT_ARTIFACT_FILE_NAME);
    expect(write?.data.byteLength).toBe(
      encodedEnvelopeBytes(overText, true),
    );
    expect(JSON.parse(Buffer.from(write!.data).toString("utf8"))).toEqual({
      isError: true,
      content: [{ type: "text", text: overText }],
    });
    expect(offloaded.isError).toBe(true);
    expect(offloaded.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("complete"),
    });
    expect(offloaded.content[1]).toMatchObject({
      type: "artifact",
      ref: artifactRef(write!.data, TOOL_RESULT_ARTIFACT_MEDIA_TYPE),
    });
    const preview = offloaded.content[1]?.type === "artifact"
      ? offloaded.content[1].preview
      : undefined;
    expect(Buffer.byteLength(preview ?? "", "utf8")).toBeLessThanOrEqual(
      TOOL_RESULT_PREVIEW_MAX_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(offloaded), "utf8")).toBeLessThan(
      TOOL_RESULT_INLINE_MAX_BYTES,
    );
  });

  it("returns bounded errors when artifact persistence is absent, fails, or lies", async () => {
    const overhead = encodedEnvelopeBytes("");
    const overText = "sensitive-output-".repeat(
      Math.ceil((TOOL_RESULT_INLINE_MAX_BYTES - overhead + 1) / 17),
    );
    const withoutSink = await normalizeToolResult({
      content: [{ type: "text", text: overText }],
    });
    expectBoundedFailure(withoutSink, "persistence is unavailable");

    const failedSink: ToolResultArtifactSink = {
      async putArtifact() {
        throw new Error(overText);
      },
    };
    const failed = await normalizeToolResult(
      { content: [{ type: "text", text: overText }] },
      { artifactSink: failedSink },
    );
    expectBoundedFailure(failed, "could not be persisted");

    const lyingSink: ToolResultArtifactSink = {
      async putArtifact() {
        return artifactRef(Buffer.from("different", "utf8"), TOOL_RESULT_ARTIFACT_MEDIA_TYPE);
      },
    };
    const lied = await normalizeToolResult(
      { content: [{ type: "text", text: overText }] },
      { artifactSink: lyingSink },
    );
    expectBoundedFailure(lied, "could not be persisted");
  });

  it("serializes byte-backed files completely before returning an artifact reference", async () => {
    const bytes = new Uint8Array(200_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const writes: ToolResultArtifactWrite[] = [];

    const result = await normalizeToolResult(
      {
        content: [{
          type: "file",
          mediaType: "application/octet-stream",
          data: bytes,
          name: "probe.bin",
        }],
      },
      { artifactSink: recordingSink(writes) },
    );

    expect(writes).toHaveLength(1);
    const stored = JSON.parse(Buffer.from(writes[0]!.data).toString("utf8")) as {
      content: { data: string }[];
    };
    expect(Buffer.from(stored.content[0]!.data, "base64")).toEqual(Buffer.from(bytes));
    expect(result.content.some((part) => part.type === "artifact")).toBe(true);
  });

  it("transforms every string surface before measuring, previewing, and offloading", async () => {
    const privatePath = "/private/core/run/outbound";
    const marker = "[REDACTED_PATH]";
    const writes: ToolResultArtifactWrite[] = [];
    const existing = artifactRef(Buffer.from("existing"), "text/plain", privatePath);
    const result = await normalizeToolResult({
      content: [
        { type: "text", text: `${privatePath}:${"x".repeat(270_000)}` },
        { type: "json", value: { [`key:${privatePath}`]: { nested: privatePath } } },
        { type: "file", mediaType: "text/plain", data: privatePath, name: privatePath },
        { type: "artifact", ref: existing, preview: `preview:${privatePath}` },
        { type: "resource", resource: { uri: `file://${privatePath}`, text: privatePath } },
      ],
    }, {
      artifactSink: recordingSink(writes),
      transformString: (value) => value.replaceAll(privatePath, marker),
    });

    expect(writes).toHaveLength(1);
    const durable = Buffer.from(writes[0]!.data).toString("utf8");
    expect(durable).not.toContain(privatePath);
    expect(durable).toContain(marker);
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(result.content[1]).toMatchObject({
      type: "artifact",
      preview: expect.not.stringContaining(privatePath),
    });
  });

  it("fails closed on excessive parts, JSON depth, JSON items, and cycles", async () => {
    const tooManyParts = Array.from(
      { length: TOOL_RESULT_MAX_PARTS + 1 },
      () => ({ type: "text", text: "x" }),
    );
    expectBoundedFailure(
      await normalizeToolResult({ content: tooManyParts }),
      "part limit",
    );

    let nested: unknown = "leaf";
    for (let index = 0; index < TOOL_RESULT_MAX_JSON_DEPTH + 1; index += 1) {
      nested = [nested];
    }
    expectBoundedFailure(
      await normalizeToolResult({ content: [{ type: "json", value: nested }] }),
      "depth limit",
    );

    expectBoundedFailure(
      await normalizeToolResult({
        content: [{
          type: "json",
          value: Array.from({ length: TOOL_RESULT_MAX_JSON_ITEMS + 1 }, () => null),
        }],
      }),
      "item limit",
    );

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expectBoundedFailure(
      await normalizeToolResult({ content: [{ type: "json", value: circular }] }),
      "cycles",
    );
  });

  it("propagates cancellation and never invokes the sink after abort", async () => {
    const sink = { putArtifact: vi.fn() };
    const controller = new AbortController();
    controller.abort();

    await expect(normalizeToolResult(
      { content: [{ type: "text", text: "x" }] },
      { artifactSink: sink, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(sink.putArtifact).not.toHaveBeenCalled();
  });
});

function recordingSink(writes: ToolResultArtifactWrite[]): ToolResultArtifactSink {
  return {
    async putArtifact(write) {
      writes.push({
        ...write,
        data: new Uint8Array(write.data),
      });
      return artifactRef(write.data, write.mediaType, write.fileName);
    },
  };
}

function artifactRef(
  data: Uint8Array,
  mediaType: string,
  fileName?: string,
): ArtifactRef {
  const digest = createHash("sha256").update(data).digest("hex");
  return {
    id: `artifact:sha256:${digest}`,
    sha256: `sha256:${digest}`,
    sizeBytes: data.byteLength,
    mediaType,
    ...(fileName === undefined ? {} : { fileName }),
  };
}

function encodedEnvelopeBytes(text: string, isError = false): number {
  return Buffer.byteLength(JSON.stringify({
    isError,
    content: [{ type: "text", text }],
  }), "utf8");
}

function expectBoundedFailure(
  result: Awaited<ReturnType<typeof normalizeToolResult>>,
  message: string,
): void {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(message),
  });
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(2_048);
}
