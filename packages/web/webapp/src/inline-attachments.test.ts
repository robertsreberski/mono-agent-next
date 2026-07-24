// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  InlineAttachmentAdapter,
  serializeInlineTurnRequest,
  toWebAttachments,
} from "./inline-attachments";
import type { Attachment, StartTurnInput } from "./types";

const MAX_TURN_REQUEST_BYTES = 1_048_576;

describe("inline assistant-ui attachment adapter", () => {
  it("converts a staged browser file into the bounded web attachment shape", async () => {
    const reportError = vi.fn();
    const adapter = new InlineAttachmentAdapter(reportError);
    const pending = await adapter.add({
      file: new File(["hello"], "notes.txt", { type: "text/plain" }),
    });
    const complete = await adapter.send(pending);

    expect(complete).toMatchObject({
      id: pending.id,
      name: "notes.txt",
      contentType: "text/plain",
      status: { type: "complete" },
    });
    expect(toWebAttachments([complete])).toEqual([{
      id: pending.id,
      name: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      url: "data:text/plain;base64,aGVsbG8=",
    }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("rejects oversized files through the accessible error reporter", async () => {
    const reportError = vi.fn();
    const adapter = new InlineAttachmentAdapter(reportError);
    const oversized = new File(
      [new Uint8Array((512 * 1_024) + 1)],
      "oversized.bin",
      { type: "application/octet-stream" },
    );

    await expect(adapter.add({ file: oversized })).rejects.toThrow(
      "oversized.bin exceeds the 512 KiB inline attachment limit.",
    );
    expect(reportError).toHaveBeenCalledWith(
      "oversized.bin exceeds the 512 KiB inline attachment limit.",
    );
  });

  it("tracks and aborts a direct adapter read without reporting discard as an error", async () => {
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementation(() => undefined);
    const abortSpy = vi.spyOn(FileReader.prototype, "abort")
      .mockImplementation(() => undefined);
    const reportError = vi.fn();
    const adapter = new InlineAttachmentAdapter(reportError);
    try {
      const addition = adapter.add({
        file: new File(["pending"], "pasted.txt", { type: "text/plain" }),
      });
      const rejection = addition.catch((cause: unknown) => cause);
      expect(adapter.hasPending).toBe(true);
      expect(adapter.pendingVersion).toBe(1);

      await adapter.abortPending();

      expect(await rejection).toMatchObject({
        name: "AbortError",
        message: "Attachment preparation was discarded.",
      });
      expect(adapter.hasPending).toBe(false);
      expect(adapter.pendingVersion).toBeUndefined();

      const laterAddition = adapter.add({
        file: new File(["later"], "later.txt", { type: "text/plain" }),
      });
      const laterRejection = laterAddition.catch((cause: unknown) => cause);
      expect(adapter.pendingVersion).toBe(2);
      await adapter.abortPending();
      expect(await laterRejection).toMatchObject({ name: "AbortError" });
      expect(adapter.pendingVersion).toBeUndefined();
      expect(abortSpy).toHaveBeenCalledTimes(2);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      abortSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("rejects a complete request when permitted attachments plus text exceed 1 MiB", () => {
    const input: StartTurnInput = {
      text: "x".repeat(100 * 1_024),
      attachments: [
        inlineAttachment("first.bin", 350 * 1_024),
        inlineAttachment("second.bin", 350 * 1_024),
      ],
      quote: {
        conversationId: "conversation-1",
        messageId: "message-1",
        text: "quoted source",
      },
      runtime: "pi",
      model: "openai-codex:gpt-5.6-terra",
      effort: "high",
    };

    expect(() => serializeInlineTurnRequest(input)).toThrow(
      "Message content and attachments exceed the 1 MiB request limit.",
    );
  });

  it("serializes the same permitted attachment budget when the complete request fits", () => {
    const input: StartTurnInput = {
      text: "short message",
      attachments: [
        inlineAttachment("first.bin", 350 * 1_024),
        inlineAttachment("second.bin", 350 * 1_024),
      ],
    };

    expect(JSON.parse(serializeInlineTurnRequest(input))).toEqual(input);
  });

  it("accepts an exactly 1,048,576-byte serialized UTF-8 request", () => {
    const input = textInputAtSerializedBytes(MAX_TURN_REQUEST_BYTES);
    const body = serializeInlineTurnRequest(input);

    expect(utf8Bytes(body)).toBe(MAX_TURN_REQUEST_BYTES);
  });

  it("rejects a serialized UTF-8 request one byte over the limit", () => {
    const input = textInputAtSerializedBytes(MAX_TURN_REQUEST_BYTES + 1);

    expect(() => serializeInlineTurnRequest(input)).toThrow(
      "Message content and attachments exceed the 1 MiB request limit.",
    );
  });

  it("counts non-ASCII bytes and JSON escapes from the final serialized body", () => {
    const exact = textInputAtSerializedBytes(MAX_TURN_REQUEST_BYTES);
    const exactBody = JSON.stringify(exact);
    const nonAscii = { text: `é${exact.text.slice(1)}` };
    const escaped = { text: `\n${exact.text.slice(1)}` };

    expect(nonAscii.text.length).toBe(exact.text.length);
    expect(JSON.stringify(nonAscii).length).toBe(exactBody.length);
    expect(utf8Bytes(JSON.stringify(nonAscii))).toBe(MAX_TURN_REQUEST_BYTES + 1);
    expect(() => serializeInlineTurnRequest(nonAscii)).toThrow(
      "Message content and attachments exceed the 1 MiB request limit.",
    );

    expect(escaped.text.length).toBe(exact.text.length);
    expect(JSON.stringify(escaped).length).toBe(exactBody.length + 1);
    expect(utf8Bytes(JSON.stringify(escaped))).toBe(MAX_TURN_REQUEST_BYTES + 1);
    expect(() => serializeInlineTurnRequest(escaped)).toThrow(
      "Message content and attachments exceed the 1 MiB request limit.",
    );
  });
});

function inlineAttachment(name: string, sizeBytes: number): Attachment {
  return {
    id: `attachment-${name}`,
    name,
    mediaType: "application/octet-stream",
    sizeBytes,
    url: `data:application/octet-stream;base64,${zeroBase64(sizeBytes)}`,
  };
}

function zeroBase64(sizeBytes: number): string {
  const completeTriples = Math.floor(sizeBytes / 3);
  const remainder = sizeBytes % 3;
  return "AAAA".repeat(completeTriples)
    + (remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : "");
}

function textInputAtSerializedBytes(targetBytes: number): StartTurnInput {
  const empty: StartTurnInput = { text: "" };
  const structuralBytes = utf8Bytes(JSON.stringify(empty));
  return { text: "x".repeat(targetBytes - structuralBytes) };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
