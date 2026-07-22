import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  CreateAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import { api, uploadContent } from "./api";
import type { UploadLimits, WebAttachment } from "./types";

type Wake = () => void;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export const inferAttachmentContentType = (file: Pick<File, "name" | "type">): string => {
  if (file.type.trim()) return file.type.trim().toLowerCase();
  const lowerName = file.name.toLowerCase();
  const extension = Object.keys(MIME_BY_EXTENSION).find((candidate) =>
    lowerName.endsWith(candidate),
  );
  return (extension && MIME_BY_EXTENSION[extension]) || "application/octet-stream";
};
const attachmentType = (contentType: string) =>
  contentType.startsWith("image/") ? ("image" as const) : ("document" as const);

export class WebUploadAttachmentAdapter implements AttachmentAdapter {
  readonly accept: string;
  private readonly limits: UploadLimits;
  private readonly uploads = new Map<string, WebAttachment>();
  private readonly activeSizes = new Map<string, number>();
  private readonly transfers = new Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<WebAttachment> }
  >();
  private readonly removing = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly files = new Map<string, File>();
  private readonly recoveryFiles = new WeakMap<File, string>();
  private reservationTail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(limits: UploadLimits) {
    this.limits = limits;
    const allowed = new Set(limits.accept.map((mime) => mime.toLowerCase()));
    const extensions = Object.entries(MIME_BY_EXTENSION)
      .filter(([, mime]) => allowed.has(mime))
      .map(([extension]) => extension);
    this.accept = [...limits.accept, ...extensions].join(",") || "*";
  }

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment, void> {
    const recoveryId = this.recoveryFiles.get(file);
    if (recoveryId) {
      this.recoveryFiles.delete(file);
      const upload = this.uploads.get(recoveryId);
      if (upload?.uploaded) {
        yield {
          id: recoveryId,
          type: attachmentType(upload.contentType),
          name: upload.name,
          contentType: upload.contentType,
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
        return;
      }
    }

    const generation = this.generation;
    const contentType = inferAttachmentContentType(file);
    const normalizedFile = file.type === contentType ? file : new File([file], file.name, {
      type: contentType,
      lastModified: file.lastModified,
    });
    const reservation = await this.reserveUpload(normalizedFile, generation);
    this.files.set(reservation.id, normalizedFile);

    let progress = 0;
    let settled = false;
    let uploaded: WebAttachment | undefined;
    let failure: unknown;
    let wake: Wake | undefined;
    const signal = () => {
      wake?.();
      wake = undefined;
    };

    const controller = new AbortController();
    const transfer = uploadContent(reservation, normalizedFile, (next) => {
      progress = next;
      signal();
    }, controller.signal);
    this.transfers.set(reservation.id, { controller, done: transfer });
    void transfer.then(
      (result) => {
        uploaded = result;
        settled = true;
        signal();
      },
      (error: unknown) => {
        failure = error;
        settled = true;
        signal();
      },
    );

    while (!settled) {
      yield {
        id: reservation.id,
        type: attachmentType(contentType),
        name: file.name,
        contentType,
        file: normalizedFile,
        status: { type: "running", reason: "uploading", progress },
      };
      // The transfer may settle while the generator is paused at `yield`.
      // Re-check before sleeping so a fast local upload cannot lose its wakeup.
      if (!settled) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }

    if (failure) {
      this.transfers.delete(reservation.id);
      this.activeSizes.delete(reservation.id);
      this.uploads.delete(reservation.id);
      this.files.delete(reservation.id);
      if (!this.removing.has(reservation.id)) {
        void api.deleteUpload(reservation.id).catch(() => undefined);
      }
      throw failure;
    }

    this.transfers.delete(reservation.id);
    if (this.removing.has(reservation.id) || !this.uploads.has(reservation.id)) return;
    this.uploads.set(reservation.id, uploaded ?? reservation);
    yield {
      id: reservation.id,
      type: attachmentType(contentType),
      name: file.name,
      contentType,
      file: normalizedFile,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const upload = this.uploads.get(attachment.id);
    if (!upload?.uploaded) throw new Error(`${attachment.name} has not finished uploading.`);
    const contentUrl =
      upload.contentUrl ?? `/api/v1/uploads/${encodeURIComponent(upload.id)}/content`;
    return {
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      contentType: attachment.contentType,
      status: { type: "complete" },
      content:
        attachment.type === "image"
          ? [{ type: "image", image: contentUrl, filename: attachment.name }]
          : [
              {
                type: "file",
                data: contentUrl,
                mimeType: attachment.contentType ?? "application/octet-stream",
                filename: attachment.name,
              },
            ],
    };
  }

  async remove(attachment: Attachment): Promise<void> {
    this.removing.add(attachment.id);
    this.sending.delete(attachment.id);
    this.recovering.delete(attachment.id);
    this.activeSizes.delete(attachment.id);
    const existed = this.uploads.delete(attachment.id);
    this.files.delete(attachment.id);
    const transfer = this.transfers.get(attachment.id);
    transfer?.controller.abort();
    await transfer?.done.catch(() => undefined);
    this.transfers.delete(attachment.id);
    if (!existed) {
      this.removing.delete(attachment.id);
      return;
    }
    // Removal is a local composer action first. The server also expires staged
    // reservations, so a transient cleanup failure must not trap the chip.
    await api.deleteUpload(attachment.id).catch(() => undefined);
    this.removing.delete(attachment.id);
  }

  beginSend(attachments: readonly { id: string }[]): readonly string[] {
    const ids = attachments.map(({ id }) => {
      this.recovering.delete(id);
      this.sending.add(id);
      return this.uploads.get(id)?.id ?? id;
    });
    return ids;
  }

  completeSend(attachments: readonly { id: string }[]): void {
    for (const { id } of attachments) {
      this.sending.delete(id);
      this.recovering.delete(id);
      this.activeSizes.delete(id);
      this.uploads.delete(id);
      this.files.delete(id);
    }
  }

  retainForRecovery(attachments: readonly { id: string }[]): void {
    for (const { id } of attachments) this.recovering.add(id);
  }

  recoverSend(attachments: readonly { id: string }[]): void {
    for (const { id } of attachments) {
      this.sending.delete(id);
      this.recovering.add(id);
    }
  }

  releaseRecovery(attachments: readonly { id: string }[]): void {
    for (const { id } of attachments) this.recovering.delete(id);
  }

  prepareRecoveryAttachment(attachment: CompleteAttachment): File | CreateAttachment {
    const file = this.files.get(attachment.id);
    if (file) {
      this.recoveryFiles.set(file, attachment.id);
      return file;
    }
    return {
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      contentType: attachment.contentType,
      content: attachment.content,
    };
  }

  async failSend(attachments: readonly { id: string }[]): Promise<void> {
    const ids = attachments.map(({ id }) => this.uploads.get(id)?.id ?? id);
    for (const { id } of attachments) {
      this.sending.delete(id);
      this.recovering.delete(id);
      this.activeSizes.delete(id);
      this.uploads.delete(id);
      this.files.delete(id);
    }
    await Promise.all(ids.map((id) => api.deleteUpload(id).catch(() => undefined)));
  }

  disposeUnsent({ includeRecovering = false }: { readonly includeRecovering?: boolean } = {}): void {
    this.generation += 1;
    const ids = [...this.uploads.keys()].filter(
      (id) => !this.sending.has(id) && (includeRecovering || !this.recovering.has(id)),
    );
    for (const id of ids) {
      this.removing.add(id);
      this.activeSizes.delete(id);
      this.uploads.delete(id);
      this.files.delete(id);
    }
    const transfers = ids.flatMap((id) => {
      const transfer = this.transfers.get(id);
      this.transfers.delete(id);
      return transfer ? [transfer] : [];
    });
    for (const transfer of transfers) transfer?.controller.abort();
    void Promise.all(transfers.map((transfer) => transfer?.done.catch(() => undefined))).then(
      async () => {
        await Promise.all(ids.map((id) => api.deleteUpload(id).catch(() => undefined)));
        for (const id of ids) this.removing.delete(id);
      },
    );
  }

  private async reserveUpload(file: File, generation: number): Promise<WebAttachment> {
    const previous = this.reservationTail;
    let release!: () => void;
    this.reservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (generation !== this.generation) {
        throw new DOMException("The attachment context changed.", "AbortError");
      }
      if (file.size > this.limits.maxFileBytes) {
        throw new Error(
          `${file.name} is larger than the ${formatBytes(this.limits.maxFileBytes)} per-file limit.`,
        );
      }
      if (this.activeSizes.size >= this.limits.maxFilesPerTurn) {
        throw new Error(`You can attach up to ${this.limits.maxFilesPerTurn} files per message.`);
      }
      const nextTotal =
        [...this.activeSizes.values()].reduce((sum, size) => sum + size, 0) + file.size;
      if (nextTotal > this.limits.maxTurnBytes) {
        throw new Error(
          `Attachments exceed the ${formatBytes(this.limits.maxTurnBytes)} per-message limit.`,
        );
      }
      const reservation = await api.createUpload(file);
      if (generation !== this.generation) {
        void api.deleteUpload(reservation.id).catch(() => undefined);
        throw new DOMException("The attachment context changed.", "AbortError");
      }
      this.uploads.set(reservation.id, reservation);
      this.activeSizes.set(reservation.id, file.size);
      return reservation;
    } finally {
      release();
    }
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
};
