import type { Attachment, PendingAttachment } from "@assistant-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, uploadContent } from "./api";
import {
  inferAttachmentContentType,
  WebUploadAttachmentAdapter,
} from "./attachment-adapter";
import { attachment, uploadLimits } from "./test/fixtures";

vi.mock("./api", () => ({
  api: {
    createUpload: vi.fn(),
    deleteUpload: vi.fn(),
  },
  uploadContent: vi.fn(),
}));

const createFile = (name: string, size = 4, type = "") =>
  new File(["x".repeat(size)], name, { type });

describe("WebUploadAttachmentAdapter", () => {
  let nextId = 0;

  beforeEach(() => {
    nextId = 0;
    vi.clearAllMocks();
    vi.mocked(api.createUpload).mockImplementation(async (file) =>
      attachment(`upload-${++nextId}`, {
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        kind: file.type.startsWith("image/") ? "image" : "document",
      }),
    );
    vi.mocked(api.deleteUpload).mockResolvedValue(undefined);
    vi.mocked(uploadContent).mockImplementation(async (upload) => ({
      ...upload,
      uploaded: true,
    }));
  });

  it.each([
    ["README.md", "text/markdown"],
    ["rows.CSV", "text/csv"],
    ["photo.PNG", "image/png"],
    ["unknown.bin", "application/octet-stream"],
  ])("infers %s as %s when the browser omits File.type", (name, expected) => {
    expect(inferAttachmentContentType(createFile(name))).toBe(expected);
  });

  it("advertises both MIME types and file extensions to the device picker", () => {
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    expect(adapter.accept).toContain("text/markdown");
    expect(adapter.accept).toContain(".md");
    expect(adapter.accept).toContain(".csv");
  });

  it("serializes concurrent reservations so eleven simultaneous files cannot exceed ten", async () => {
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generators = Array.from({ length: 11 }, (_, index) =>
      adapter.add({ file: createFile(`file-${index}.md`) }),
    );

    const results = await Promise.allSettled(generators.map((generator) => generator.next()));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(api.createUpload).toHaveBeenCalledTimes(10);
    adapter.disposeUnsent();
  });

  it("serializes aggregate-byte checks across simultaneous files", async () => {
    const adapter = new WebUploadAttachmentAdapter({
      ...uploadLimits,
      maxTurnBytes: 8,
    });
    const generators = Array.from({ length: 3 }, (_, index) =>
      adapter.add({ file: createFile(`file-${index}.md`, 4) }),
    );

    const results = await Promise.allSettled(generators.map((generator) => generator.next()));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(api.createUpload).toHaveBeenCalledTimes(2);
    adapter.disposeUnsent();
  });

  it("does not lose the completion wakeup when a local upload finishes immediately", async () => {
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generator = adapter.add({ file: createFile("fast.md") });

    expect((await generator.next()).value?.status.type).toBe("running");
    expect((await generator.next()).value?.status.type).toBe("requires-action");
  });

  it("removes a completed chip even when server cleanup transiently fails", async () => {
    vi.mocked(api.deleteUpload).mockRejectedValueOnce(new Error("temporary"));
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generator = adapter.add({ file: createFile("notes.md") });
    await generator.next();
    const completed = (await generator.next()).value as PendingAttachment;

    await expect(adapter.remove(completed)).resolves.toBeUndefined();
    await expect(adapter.send(completed)).rejects.toThrow("has not finished uploading");
  });

  it("protects submitted IDs across thread creation and cleans them after a failed turn", async () => {
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generator = adapter.add({ file: createFile("turn.md") });
    await generator.next();
    const completed = (await generator.next()).value as PendingAttachment;

    expect(adapter.beginSend([completed])).toEqual(["upload-1"]);
    adapter.disposeUnsent();
    await Promise.resolve();
    expect(api.deleteUpload).not.toHaveBeenCalled();

    await adapter.failSend([completed]);

    expect(api.deleteUpload).toHaveBeenCalledWith("upload-1");
    await expect(adapter.send(completed)).rejects.toThrow("has not finished uploading");
  });

  it("rehydrates a recoverable failed send without uploading or deleting the staged file", async () => {
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generator = adapter.add({ file: createFile("retry.md") });
    await generator.next();
    const completed = (await generator.next()).value as PendingAttachment;
    const submitted = await adapter.send(completed);

    adapter.beginSend([submitted]);
    adapter.disposeUnsent();
    adapter.recoverSend([submitted]);

    const recoveryFile = adapter.prepareRecoveryAttachment(submitted);
    if (!(recoveryFile instanceof File)) throw new Error("Expected the original local file.");
    const recovery = adapter.add({ file: recoveryFile });
    const restored = (await recovery.next()).value as PendingAttachment;

    expect(restored).toMatchObject({
      id: "upload-1",
      status: { type: "requires-action", reason: "composer-send" },
    });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();
    await expect(adapter.send(restored)).resolves.toMatchObject({ id: "upload-1" });

    adapter.releaseRecovery([restored]);
    adapter.beginSend([restored]);
    adapter.completeSend([restored]);
    await expect(adapter.send(restored)).rejects.toThrow("has not finished uploading");
  });

  it("aborts an in-flight transfer and cannot resurrect it after removal", async () => {
    vi.mocked(uploadContent).mockImplementation(
      (_upload, _file, _onProgress, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generator = adapter.add({ file: createFile("large.pdf", 6, "application/pdf") });
    const pending = (await generator.next()).value as PendingAttachment;

    await adapter.remove(pending as Attachment);

    await expect(generator.next()).rejects.toMatchObject({ name: "AbortError" });
    await expect(adapter.send(pending)).rejects.toThrow("has not finished uploading");
  });

  it("disposes staged uploads when the agent or thread context changes", async () => {
    vi.mocked(uploadContent).mockImplementation(
      (_upload, _file, _onProgress, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("context changed", "AbortError")),
            { once: true },
          );
        }),
    );
    const adapter = new WebUploadAttachmentAdapter(uploadLimits);
    const generator = adapter.add({ file: createFile("context.md") });
    await generator.next();

    adapter.disposeUnsent();

    await expect(generator.next()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(api.deleteUpload).toHaveBeenCalledWith("upload-1"));
  });
});
