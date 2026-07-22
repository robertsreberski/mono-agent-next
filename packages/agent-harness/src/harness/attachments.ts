import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { AgentAttachment } from "@mono-agent/agent-contracts";
import type { RuntimeEventLike } from "@mono-agent/observability";

import type { AgentHarnessOptions, AgentHarnessRequest } from "../types.js";
import { fileIdentity, type AttachmentFileIdentity } from "./file-authority.js";
import { errorMessageText } from "./value-utils.js";

export interface AttachmentRequestContext {
  /** Canonical attachment root, or an authoritative empty string when absent. */
  readonly root: string;
  /** Exact lexical paths persisted successfully for this request only. */
  readonly allowedPaths: readonly string[];
  /** File identities captured from the descriptors that wrote this request's attachments. */
  readonly allowedIdentities: readonly AttachmentFileIdentity[];
}

export async function applyHarnessAttachments(
  options: AgentHarnessOptions,
  request: AgentHarnessRequest,
  runId: string,
  emit: (event: RuntimeEventLike) => void,
): Promise<{
  readonly request: AgentHarnessRequest;
  readonly persistUserMessage: string;
  readonly attachmentContext: AttachmentRequestContext;
}> {
    const attachments = request.attachments;
    const configuredDir = options.attachmentsDir;
    let canonicalDir: string | undefined;
    if (configuredDir !== undefined
      && ((attachments !== undefined && attachments.length > 0) || options.mcpRequestContext !== undefined)) {
      try {
        await mkdir(configuredDir, { recursive: true });
        canonicalDir = await realpath(configuredDir);
      } catch (error) {
        if (attachments !== undefined && attachments.length > 0) {
          emit({
            type: "runtime_warning",
            warning_kind: "attachment_persist_failed",
            message: `Could not prepare the attachment directory: ${errorMessageText(error)}`,
          });
        }
      }
    }
    const allowedPaths: string[] = [];
    const allowedIdentities: AttachmentFileIdentity[] = [];
    const attachmentContext = (): AttachmentRequestContext => ({
      root: canonicalDir ?? "",
      allowedPaths: [...allowedPaths],
      allowedIdentities: [...allowedIdentities],
    });
    if (attachments === undefined || attachments.length === 0) {
      return { request, persistUserMessage: request.userMessage, attachmentContext: attachmentContext() };
    }
    const promptLines: string[] = [];
    const persistLines: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment === undefined) {
        continue;
      }
      let savedPath: string | undefined;
      if (canonicalDir !== undefined) {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          savedPath = join(canonicalDir, attachmentFileName(runId, index, attachment));
          // Capture authority from the descriptor that created and wrote the
          // file. Never canonicalize the file path itself: realpath would turn
          // a post-write symlink swap into authority for its target.
          handle = await open(savedPath, "wx", 0o600);
          await handle.writeFile(Buffer.from(attachment.data, "base64"));
          await handle.sync();
          const persisted = await handle.stat();
          if (!persisted.isFile() || persisted.nlink !== 1) {
            throw new Error("persisted attachment is not a uniquely linked regular file");
          }
          allowedPaths.push(savedPath);
          allowedIdentities.push({ path: savedPath, ...fileIdentity(persisted) });
        } catch (error) {
          emit({
            type: "runtime_warning",
            warning_kind: "attachment_persist_failed",
            message: `Could not save attachment ${attachment.name ?? `#${index}`}: ${errorMessageText(error)}`,
          });
          savedPath = undefined;
        } finally {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
          }
        }
      }
      promptLines.push(describeAttachment(attachment, savedPath, { includeText: true }));
      persistLines.push(describeAttachment(attachment, savedPath, { includeText: false }));
    }
    if (promptLines.length === 0) {
      return { request, persistUserMessage: request.userMessage, attachmentContext: attachmentContext() };
    }
    const header = configuredDir !== undefined
      ? `[The user attached ${attachments.length} file(s) — saved to disk so you can open them with your tools:]`
      : `[The user attached ${attachments.length} file(s):]`;
    return {
      request: { ...request, userMessage: `${request.userMessage}\n\n${header}\n${promptLines.join("\n")}` },
      persistUserMessage: `${request.userMessage}\n\n${header}\n${persistLines.join("\n")}`,
      attachmentContext: attachmentContext(),
    };
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  // Audio/video: nameless media (Telegram voice notes) must still save with a
  // usable suffix — ffmpeg and transcription tools sniff format by extension.
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

const ATTACHMENT_TEXT_MAX_CHARS = 8_000;

function attachmentFileName(runId: string, index: number, attachment: AgentAttachment): string {
  const sanitized = sanitizeAttachmentName(attachment.name);
  const base = sanitized ?? `attachment-${index}${MIME_EXTENSIONS[attachment.mimeType] ?? ""}`;
  // runId may come from a caller-supplied createRunId(); sanitize it too so it
  // cannot inject path separators or leading dots and escape attachmentsDir.
  const safeRunId = sanitizeAttachmentName(runId) ?? `run-${index}`;
  return `${safeRunId}-${index}-${base}`;
}

function sanitizeAttachmentName(name: string | undefined): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const cleaned = name.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * One line per attachment. The prompt variant (`includeText: true`) inlines the
 * extracted document body so the current turn sees it one-shot. The persistence
 * variant (`includeText: false`) keeps ONLY the redacted metadata (saved path,
 * mime type, size, original name) — never the extracted body — so durable
 * history/memory retain an actionable file reference without baking the
 * (potentially sensitive) document content into future prompts.
 */
function describeAttachment(
  attachment: AgentAttachment,
  savedPath: string | undefined,
  options: { readonly includeText: boolean } = { includeText: true },
): string {
  const parts: string[] = [];
  if (savedPath !== undefined) {
    parts.push(savedPath);
  }
  parts.push(attachment.mimeType);
  if (typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes)) {
    parts.push(formatAttachmentBytes(attachment.sizeBytes));
  }
  if (typeof attachment.durationSeconds === "number" && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0) {
    parts.push(formatAttachmentDuration(attachment.durationSeconds));
  }
  let line = `- ${parts.join(" — ")}`;
  if (typeof attachment.name === "string" && attachment.name.length > 0) {
    line += ` (original: ${attachment.name})`;
  }
  if (options.includeText && attachment.kind === "document" && typeof attachment.text === "string" && attachment.text.trim().length > 0) {
    const text = attachment.text.length > ATTACHMENT_TEXT_MAX_CHARS
      ? `${attachment.text.slice(0, ATTACHMENT_TEXT_MAX_CHARS)}…[truncated]`
      : attachment.text;
    line += `\n  --- extracted text ---\n${text}\n  --- end of extracted text ---`;
  }
  return line;
}

function formatAttachmentDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")} min`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
