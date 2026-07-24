// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { InlineAttachmentAdapter, toWebAttachments } from "./inline-attachments";

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
});
