import type {
  Attachment as AssistantAttachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

import type { Attachment as WebAttachment } from "./types";

const MAX_FILE_BYTES = 512 * 1_024;
const MAX_TOTAL_BYTES = 700 * 1_024;
const MAX_FILES = 3;

type ErrorReporter = (message: string) => void;

interface StagedFile {
  readonly file: File;
  dataUrl?: string;
}

/**
 * Keeps browser files inside assistant-ui's composer until send time while
 * producing the bounded inline data URL shape expected by the web API.
 */
export class InlineAttachmentAdapter implements AttachmentAdapter {
  readonly accept = "*";
  readonly #staged = new Map<string, StagedFile>();

  constructor(private readonly reportError: ErrorReporter) {}

  async add({ file }: { readonly file: File }): Promise<PendingAttachment> {
    if (file.size > MAX_FILE_BYTES) {
      throw this.#error(`${file.name} exceeds the 512 KiB inline attachment limit.`);
    }
    if (this.#staged.size >= MAX_FILES) {
      throw this.#error(`You can attach at most ${MAX_FILES} files to one message.`);
    }
    const totalBytes = [...this.#staged.values()]
      .reduce((sum, entry) => sum + entry.file.size, file.size);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw this.#error("Attachments exceed the safe inline request budget.");
    }

    const id =
      globalThis.crypto?.randomUUID?.()
      ?? `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staged: StagedFile = { file };
    this.#staged.set(id, staged);
    try {
      staged.dataUrl = await readFileDataUrl(file);
    } catch (cause) {
      this.#staged.delete(id);
      const error = cause instanceof Error
        ? cause
        : new Error(`Could not read ${file.name}.`);
      this.reportError(error.message);
      throw error;
    }

    return {
      id,
      type: "file",
      name: file.name,
      contentType: mediaType(file),
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async remove(attachment: AssistantAttachment): Promise<void> {
    this.#staged.delete(attachment.id);
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const staged = this.#staged.get(attachment.id);
    if (staged?.dataUrl === undefined) {
      throw this.#error(`Could not prepare ${attachment.name} for upload.`);
    }
    this.#staged.delete(attachment.id);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{
        type: "file",
        filename: attachment.name,
        data: staged.dataUrl,
        mimeType: attachment.contentType ?? "application/octet-stream",
      }],
    };
  }

  #error(message: string): Error {
    this.reportError(message);
    return new Error(message);
  }
}

export function toWebAttachments(
  attachments: readonly CompleteAttachment[],
): readonly WebAttachment[] {
  return attachments.map((attachment) => {
    const content = attachment.content.find(
      (part) => part.type === "file" || part.type === "image",
    );
    const url =
      content?.type === "file"
        ? content.data
        : content?.type === "image"
          ? content.image
          : undefined;
    if (url === undefined) {
      throw new Error(`Attachment ${attachment.name} has no inline content.`);
    }
    return {
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.contentType ?? attachment.file?.type ?? "application/octet-stream",
      ...(attachment.file === undefined ? {} : { sizeBytes: attachment.file.size }),
      url,
    };
  });
}

function mediaType(file: File): string {
  return file.type || "application/octet-stream";
}

async function readFileDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(
      reader.error ?? new Error(`Could not read ${file.name}.`),
    );
    reader.readAsDataURL(file);
  });
}
