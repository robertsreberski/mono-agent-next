import type {
  Attachment as AssistantAttachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

import type {
  Attachment as WebAttachment,
  StartTurnInput,
} from "./types";

const MAX_FILE_BYTES = 512 * 1_024;
const MAX_TOTAL_BYTES = 700 * 1_024;
const MAX_FILES = 3;
const MAX_TURN_REQUEST_BYTES = 1_048_576;

type ErrorReporter = (message: string) => void;

interface StagedFile {
  readonly file: File;
  dataUrl?: string;
}

interface PendingFileRead {
  readonly promise: Promise<string>;
  abort(): void;
}

class InlineAttachmentAbortError extends Error {
  constructor() {
    super("Attachment preparation was discarded.");
    this.name = "AbortError";
  }
}

export function isInlineAttachmentAbort(cause: unknown): boolean {
  return cause instanceof InlineAttachmentAbortError;
}

/**
 * Keeps browser files inside assistant-ui's composer until send time while
 * producing the bounded inline data URL shape expected by the web API.
 */
export class InlineAttachmentAdapter implements AttachmentAdapter {
  readonly accept = "*";
  readonly #staged = new Map<string, StagedFile>();
  readonly #pendingReads = new Set<PendingFileRead>();
  #preparationVersion = 0;

  constructor(private readonly reportError: ErrorReporter) {}

  get hasPending(): boolean {
    return this.#pendingReads.size > 0;
  }

  get pendingVersion(): number | undefined {
    return this.hasPending ? this.#preparationVersion : undefined;
  }

  async abortPending(): Promise<void> {
    while (this.#pendingReads.size > 0) {
      const pending = [...this.#pendingReads];
      pending.forEach((read) => read.abort());
      await Promise.allSettled(pending.map((read) => read.promise));
      // Let each adapter.add continuation remove its read and staged quota
      // before the originating composer is reset.
      await Promise.resolve();
    }
  }

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
    this.#preparationVersion += 1;
    const read = readFileDataUrl(file);
    this.#staged.set(id, staged);
    this.#pendingReads.add(read);
    try {
      staged.dataUrl = await read.promise;
    } catch (cause) {
      this.#staged.delete(id);
      const error = cause instanceof Error
        ? cause
        : new Error(`Could not read ${file.name}.`);
      if (!isInlineAttachmentAbort(error)) this.reportError(error.message);
      throw error;
    } finally {
      this.#pendingReads.delete(read);
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

/**
 * Serialize exactly the body that fetch will submit, then enforce the web
 * server's complete JSON-body limit. The attachment adapter's raw-file budget
 * cannot prove this by itself because base64 expansion shares the same request
 * with text, quotes, and run overrides.
 */
export function serializeInlineTurnRequest(input: StartTurnInput): string {
  const body = JSON.stringify(input);
  if (new TextEncoder().encode(body).byteLength > MAX_TURN_REQUEST_BYTES) {
    throw new Error(
      "Message content and attachments exceed the 1 MiB request limit. "
      + "Remove an attachment or shorten the message.",
    );
  }
  return body;
}

function mediaType(file: File): string {
  return file.type || "application/octet-stream";
}

function readFileDataUrl(file: File): PendingFileRead {
  const reader = new FileReader();
  let settled = false;
  let resolvePromise!: (value: string) => void;
  let rejectPromise!: (cause: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const resolve = (value: string) => {
    if (settled) return;
    settled = true;
    resolvePromise(value);
  };
  const reject = (cause: Error) => {
    if (settled) return;
    settled = true;
    rejectPromise(cause);
  };
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(
    reader.error ?? new Error(`Could not read ${file.name}.`),
  );
  reader.onabort = () => reject(new InlineAttachmentAbortError());
  try {
    reader.readAsDataURL(file);
  } catch (cause) {
    reject(cause instanceof Error ? cause : new Error(`Could not read ${file.name}.`));
  }
  return {
    promise,
    abort: () => {
      if (settled) return;
      try {
        reader.abort();
      } catch {
        // The explicit rejection below settles even non-standard FileReader
        // implementations that throw or omit the abort event.
      } finally {
        reject(new InlineAttachmentAbortError());
      }
    },
  };
}
