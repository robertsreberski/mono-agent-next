import {
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  agentAttachmentKindFromMimeType,
  decodeAgentAttachmentText,
  type AgentAttachment,
  type AgentRequestBase,
  type AgentResponder as SharedAgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";

import {
  TelegramMessageStream,
  type AgentMessageStream,
  type TelegramMessageStreamLogger,
} from "./message-stream.js";
import {
  createOpenAiTranscriber,
  type TelegramTranscriber,
  type TelegramTranscriptionConfig,
} from "./transcription.js";
import type {
  TelegramChatId,
  TelegramAudio,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramUser,
  TelegramVideo,
  TelegramVideoNote,
  TelegramVoice,
} from "./types.js";
import { redactTelegramErrorMessage } from "./log-redaction.js";

export type TelegramAttachmentKind =
  | "document"
  | "photo"
  | "audio"
  | "video"
  | "video_note"
  | "voice";

export interface TelegramAttachmentBase {
  kind: TelegramAttachmentKind;
  fileId: string;
  fileUniqueId: string;
  fileSize?: number;
}

export interface TelegramDocumentAttachment extends TelegramAttachmentBase {
  kind: "document";
  fileName?: string;
  mimeType?: string;
}

export interface TelegramPhotoAttachmentSize {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface TelegramPhotoAttachment extends TelegramAttachmentBase {
  kind: "photo";
  width: number;
  height: number;
  sizes: readonly TelegramPhotoAttachmentSize[];
}

export interface TelegramAudioAttachment extends TelegramAttachmentBase {
  kind: "audio";
  duration: number;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramVideoAttachment extends TelegramAttachmentBase {
  kind: "video";
  duration: number;
  width: number;
  height: number;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramVoiceAttachment extends TelegramAttachmentBase {
  kind: "voice";
  duration: number;
  mimeType?: string;
}

export interface TelegramVideoNoteAttachment extends TelegramAttachmentBase {
  kind: "video_note";
  duration: number;
  /** Diameter (width == height) of the square round video, in pixels. */
  length: number;
}

export type TelegramAttachment =
  | TelegramDocumentAttachment
  | TelegramPhotoAttachment
  | TelegramAudioAttachment
  | TelegramVideoAttachment
  | TelegramVideoNoteAttachment
  | TelegramVoiceAttachment;

export interface TelegramAgentMessageInput {
  text: string;
  attachments: readonly TelegramAttachment[];
}

export interface AgentRequest extends AgentRequestBase {
  conversationId: string;
  chatId: TelegramChatId;
  messageId: number;
  updateId: number;
  userId?: number;
  username?: string;
  text: string;
  /**
   * Downloaded attachment bytes, ready for a vision/document-aware runtime, in
   * the transport-agnostic {@link AgentAttachment} shape (base64 data + mime +
   * name).
   *
   * BREAKING (intentional, unified contract): on earlier versions this field
   * held Telegram-specific `TelegramAttachment[]` metadata. It is now
   * `AgentAttachment[]` (matching Slack and the OpenAI-compatible channel). The
   * original Telegram file metadata (fileId, sizes, kind, …) is preserved under
   * `metadata.telegram.attachments` — custom responders that filtered by
   * `fileId`/`sizes`/`kind` should read it from there.
   */
  attachments?: readonly AgentAttachment[];
  abortSignal: AbortSignal;
  metadata: {
    telegram: TelegramRequestMetadata;
    [key: string]: unknown;
  };
}

export interface TelegramRequestMetadata {
  updateId: number;
  /** Per-chat model selected through Telegram runtime controls. */
  model?: string;
  /** Per-chat effort selected through Telegram runtime controls. */
  effort?: string;
  chat: {
    id: TelegramChatId;
    type?: string;
    title?: string;
    username?: string;
  };
  message: {
    id: number;
    date?: number;
  };
  attachments?: readonly TelegramAttachment[];
  from?: {
    id: number;
    isBot?: boolean;
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
  };
}

export type { AgentResponse };
export type AgentResponder = SharedAgentResponder<AgentRequest, AgentMessageStream, AgentResponse>;

export interface TelegramAdapterMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  newSessionText?: string;
  newSessionErrorText?: string;
  errorText?: TelegramAdapterErrorText;
  unsupportedText?: string;
}

export type TelegramAdapterErrorText =
  | string
  | ((input: TelegramAdapterErrorTextInput) => string | Promise<string>);

export interface TelegramAdapterErrorTextInput {
  readonly error: unknown;
  readonly request: AgentRequest;
}

export interface TelegramAdapterStreamOptions {
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  maxSendRetries?: number;
  retryCapMs?: number;
  retryBaseDelayMs?: number;
  showHints?: boolean;
  formatMarkdown?: boolean;
  /**
   * Deliver only the final answer with a "typing…" indicator while working,
   * instead of streaming interim edits. When tools produced a progress message,
   * the final answer is posted separately and that progress message is removed.
   * Defaults to true for the Telegram bot.
   */
  finalOnly?: boolean;
}

export interface TelegramAdapterLogger extends TelegramMessageStreamLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export const DEFAULT_ERROR_TEXT = "The agent failed while processing your message.";

export const DEFAULT_MESSAGES: Required<TelegramAdapterMessages> = {
  welcomeText:
    "Hello! Send text or Telegram media. I pass your caption and download allowed attachments to share with the configured agent.",
  helpText:
    "Send text, documents, photos, audio, video, round videos (video notes), or voice messages. I forward your caption and download supported attachments (within size/type limits) for the agent. Use /cancel to stop the current response.",
  busyText: "I am still working on your previous message. Use /cancel to stop it.",
  unauthorizedText: "This Telegram chat is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  newSessionText: "Started a new session. Conversation history was cleared; skills and startup context will reload on your next message.",
  newSessionErrorText: "I could not start a new session. The existing conversation was left available; check the agent logs for details.",
  errorText: DEFAULT_ERROR_TEXT,
  unsupportedText: "I can handle text and Telegram document, photo, audio, video, round video, or voice metadata in this adapter.",
};

/**
 * Build the responder-facing {@link AgentRequest} from a Telegram update. The
 * grammY message handler passes `ctx.update` and `ctx.message`, which are
 * structurally compatible with the wire types this reads.
 *
 * `resolvedAttachments` are the downloaded {@link AgentAttachment} bytes (when
 * available) that populate `request.attachments`; the original Telegram file
 * metadata is always preserved under `metadata.telegram.attachments`.
 */
export function buildAgentRequest(
  update: TelegramUpdate,
  message: TelegramMessage,
  input: TelegramAgentMessageInput,
  abortSignal: AbortSignal,
  resolvedAttachments?: readonly AgentAttachment[],
): AgentRequest {
  const from = metadataFromUser(message.from);
  const telegramMetadata: TelegramRequestMetadata = {
    updateId: update.update_id,
    chat: metadataFromChat(message.chat),
    message: metadataFromMessage(message),
  };
  if (input.attachments.length > 0) {
    telegramMetadata.attachments = input.attachments;
  }
  const conversationId = `telegram:${String(message.chat.id)}`;
  const request: AgentRequest = {
    conversationId,
    replyTo: { conversationId },
    chatId: message.chat.id,
    messageId: message.message_id,
    updateId: update.update_id,
    text: input.text,
    abortSignal,
    metadata: {
      telegram: telegramMetadata,
    },
  };

  if (resolvedAttachments !== undefined && resolvedAttachments.length > 0) {
    request.attachments = resolvedAttachments;
  }
  if (message.from?.id !== undefined) {
    request.userId = message.from.id;
  }
  if (message.from?.username !== undefined) {
    request.username = message.from.username;
  }
  if (from !== undefined) {
    request.metadata.telegram.from = from;
  }

  return request;
}

export function normalizeTelegramMessageInput(
  message: TelegramMessage,
): TelegramAgentMessageInput | undefined {
  if (message.animation !== undefined) {
    return undefined;
  }
  const text = normalizeMessageText(message);
  const attachments = extractTelegramAttachments(message);
  if (text.length === 0 && attachments.length === 0) {
    return undefined;
  }
  return {
    text: text.length > 0 ? text : summarizeTelegramAttachments(attachments),
    attachments,
  };
}

/**
 * Merge a Telegram media-group (album) into a single input: Telegram delivers an
 * album of N photos/videos as N separate messages sharing one `media_group_id`,
 * with the caption on only one of them. We concatenate every message's
 * attachments and take the single caption (first non-empty), so the agent sees
 * all photos as one request instead of N single-attachment turns.
 */
export function mergeTelegramMessageInputs(
  messages: readonly TelegramMessage[],
): TelegramAgentMessageInput | undefined {
  const attachments: TelegramAttachment[] = [];
  let text = "";
  for (const message of messages) {
    if (message.animation !== undefined) {
      continue;
    }
    if (text.length === 0) {
      const messageText = normalizeMessageText(message);
      if (messageText.length > 0) {
        text = messageText;
      }
    }
    attachments.push(...extractTelegramAttachments(message));
  }
  if (text.length === 0 && attachments.length === 0) {
    return undefined;
  }
  return {
    text: text.length > 0 ? text : summarizeTelegramAttachments(attachments),
    attachments,
  };
}

function metadataFromChat(messageChat: TelegramMessage["chat"]): TelegramRequestMetadata["chat"] {
  const chat: TelegramRequestMetadata["chat"] = { id: messageChat.id };
  if (messageChat.type !== undefined) {
    chat.type = messageChat.type;
  }
  if (messageChat.title !== undefined) {
    chat.title = messageChat.title;
  }
  if (messageChat.username !== undefined) {
    chat.username = messageChat.username;
  }
  return chat;
}

function metadataFromMessage(
  message: TelegramMessage,
): TelegramRequestMetadata["message"] {
  const metadata: TelegramRequestMetadata["message"] = { id: message.message_id };
  if (message.date !== undefined) {
    metadata.date = message.date;
  }
  return metadata;
}

function normalizeMessageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

function extractTelegramAttachments(message: TelegramMessage): readonly TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];
  const document = attachmentFromDocument(message.document);
  if (document !== undefined) {
    attachments.push(document);
  }
  const photo = attachmentFromPhoto(message.photo);
  if (photo !== undefined) {
    attachments.push(photo);
  }
  const audio = attachmentFromAudio(message.audio);
  if (audio !== undefined) {
    attachments.push(audio);
  }
  const video = attachmentFromVideo(message.video);
  if (video !== undefined) {
    attachments.push(video);
  }
  const videoNote = attachmentFromVideoNote(message.video_note);
  if (videoNote !== undefined) {
    attachments.push(videoNote);
  }
  const voice = attachmentFromVoice(message.voice);
  if (voice !== undefined) {
    attachments.push(voice);
  }
  return attachments;
}

function attachmentFromDocument(
  document: TelegramDocument | undefined,
): TelegramDocumentAttachment | undefined {
  if (document === undefined) {
    return undefined;
  }
  const attachment: TelegramDocumentAttachment = {
    kind: "document",
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
  };
  addFileSize(attachment, document.file_size);
  if (document.file_name !== undefined) {
    attachment.fileName = document.file_name;
  }
  if (document.mime_type !== undefined) {
    attachment.mimeType = document.mime_type;
  }
  return attachment;
}

function attachmentFromPhoto(
  photos: TelegramPhotoSize[] | undefined,
): TelegramPhotoAttachment | undefined {
  const sizes = photos?.map(photoSizeFromTelegram).filter(isDefined) ?? [];
  if (sizes.length === 0) {
    return undefined;
  }
  const largest = sizes.reduce((best, candidate) =>
    candidate.width * candidate.height > best.width * best.height ? candidate : best,
  );
  const attachment: TelegramPhotoAttachment = {
    kind: "photo",
    fileId: largest.fileId,
    fileUniqueId: largest.fileUniqueId,
    width: largest.width,
    height: largest.height,
    sizes,
  };
  addFileSize(attachment, largest.fileSize);
  return attachment;
}

function attachmentFromAudio(audio: TelegramAudio | undefined): TelegramAudioAttachment | undefined {
  if (audio === undefined) {
    return undefined;
  }
  const attachment: TelegramAudioAttachment = {
    kind: "audio",
    fileId: audio.file_id,
    fileUniqueId: audio.file_unique_id,
    duration: audio.duration,
  };
  addFileSize(attachment, audio.file_size);
  if (audio.file_name !== undefined) {
    attachment.fileName = audio.file_name;
  }
  if (audio.mime_type !== undefined) {
    attachment.mimeType = audio.mime_type;
  }
  return attachment;
}

function attachmentFromVideo(video: TelegramVideo | undefined): TelegramVideoAttachment | undefined {
  if (video === undefined) {
    return undefined;
  }
  const attachment: TelegramVideoAttachment = {
    kind: "video",
    fileId: video.file_id,
    fileUniqueId: video.file_unique_id,
    duration: video.duration,
    width: video.width,
    height: video.height,
  };
  addFileSize(attachment, video.file_size);
  if (video.file_name !== undefined) {
    attachment.fileName = video.file_name;
  }
  if (video.mime_type !== undefined) {
    attachment.mimeType = video.mime_type;
  }
  return attachment;
}

function attachmentFromVideoNote(
  videoNote: TelegramVideoNote | undefined,
): TelegramVideoNoteAttachment | undefined {
  if (videoNote === undefined) {
    return undefined;
  }
  const attachment: TelegramVideoNoteAttachment = {
    kind: "video_note",
    fileId: videoNote.file_id,
    fileUniqueId: videoNote.file_unique_id,
    duration: videoNote.duration,
    length: videoNote.length,
  };
  addFileSize(attachment, videoNote.file_size);
  return attachment;
}

function attachmentFromVoice(voice: TelegramVoice | undefined): TelegramVoiceAttachment | undefined {
  if (voice === undefined) {
    return undefined;
  }
  const attachment: TelegramVoiceAttachment = {
    kind: "voice",
    fileId: voice.file_id,
    fileUniqueId: voice.file_unique_id,
    duration: voice.duration,
  };
  addFileSize(attachment, voice.file_size);
  if (voice.mime_type !== undefined) {
    attachment.mimeType = voice.mime_type;
  }
  return attachment;
}

function photoSizeFromTelegram(
  size: TelegramPhotoSize,
): TelegramPhotoAttachmentSize | undefined {
  const attachmentSize: TelegramPhotoAttachmentSize = {
    fileId: size.file_id,
    fileUniqueId: size.file_unique_id,
    width: size.width,
    height: size.height,
  };
  addFileSize(attachmentSize, size.file_size);
  return attachmentSize;
}

function addFileSize(target: { fileSize?: number }, fileSize: number | undefined): void {
  if (typeof fileSize === "number" && Number.isFinite(fileSize)) {
    target.fileSize = fileSize;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function summarizeTelegramAttachments(attachments: readonly TelegramAttachment[]): string {
  return attachments.map(describeTelegramAttachment).join("\n");
}

function describeTelegramAttachment(attachment: TelegramAttachment): string {
  const details = attachmentDetails(attachment);
  return details.length === 0
    ? `Telegram ${attachment.kind}`
    : `Telegram ${attachment.kind}: ${details.join(", ")}`;
}

function attachmentDetails(attachment: TelegramAttachment): string[] {
  const details: string[] = [];
  if ("fileName" in attachment && attachment.fileName !== undefined) {
    details.push(attachment.fileName);
  }
  if ("mimeType" in attachment && attachment.mimeType !== undefined) {
    details.push(attachment.mimeType);
  }
  if ("width" in attachment && "height" in attachment) {
    details.push(`${attachment.width}x${attachment.height}`);
  }
  if ("duration" in attachment) {
    details.push(`${attachment.duration}s`);
  }
  if (attachment.fileSize !== undefined) {
    details.push(formatBytes(attachment.fileSize));
  }
  return details;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Telegram-compatible aliases retained for existing adapter consumers. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = DEFAULT_AGENT_ATTACHMENT_MAX_BYTES;
export const DEFAULT_ATTACHMENT_MIME_ALLOWLIST = DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST;

/**
 * Minimal seam over the Telegram Bot API needed to fetch attachment bytes:
 * resolve a `file_id` to a `file_path` (getFile) then download it from the file
 * URL. Both calls honor the request `abortSignal`.
 */
export interface TelegramFileDownloader {
  /** Resolve a `file_id` to a downloadable `file_path` (Bot API `getFile`). */
  resolveFilePath(fileId: string, signal: AbortSignal): Promise<string | undefined>;
  /**
   * Download the file at `file_path` (GET on the file URL). `maxBytes`, when
   * provided, lets the downloader abort an oversized transfer mid-stream instead
   * of buffering the whole body first; the caller still re-checks the cap as a
   * backstop, so a custom downloader that ignores `maxBytes` stays bounded.
   */
  download(filePath: string, signal: AbortSignal, maxBytes?: number): Promise<Uint8Array>;
}

export interface DownloadTelegramAttachmentsOptions {
  /** Skip files larger than this many decoded bytes. Default ~20 MB. */
  readonly maxBytes?: number;
  /** Only download files whose MIME type is allowed. Defaults to images + common docs/text. */
  readonly mimeAllowlist?: readonly string[];
  /**
   * Per-file download timeout (ms) for the default downloader, composed with the
   * run abort signal. Defaults to 30000. Only consulted by the built-in
   * downloader; custom downloaders manage their own timeouts.
   */
  readonly downloadTimeoutMs?: number;
  /**
   * Auto-transcription config for inbound audio (voice / audio / video_note). When
   * set (and no {@link transcriber} seam is supplied), a default OpenAI-compatible
   * transcriber is built from it once and used to fill each audio attachment's
   * `text` with the transcript. Omit to leave audio as an on-disk file only.
   */
  readonly transcription?: TelegramTranscriptionConfig;
  /**
   * Test/override seam for the transcriber (mirrors the downloader seam). When
   * present it wins over {@link transcription}; when absent the config builds the
   * default transcriber. With neither, audio is never transcribed.
   */
  readonly transcriber?: TelegramTranscriber;
  readonly logger?: TelegramAdapterLogger;
}

interface ResolvedTelegramAttachmentSource {
  readonly fileId: string;
  readonly mimeType: string;
  readonly name: string | undefined;
  readonly declaredSize: number | undefined;
  readonly durationSeconds: number | undefined;
}

/**
 * Download the bytes for each inbound {@link TelegramAttachment} and map them to
 * the transport-agnostic {@link AgentAttachment} shape. Enforces a byte cap and a
 * MIME allowlist, ties every request to `abortSignal`, and skips (never throws on)
 * an attachment whose download fails so the run still proceeds. Photos and audio
 * without a declared MIME type fall back to sensible defaults.
 */
export async function downloadTelegramAttachments(
  attachments: readonly TelegramAttachment[],
  downloader: TelegramFileDownloader,
  abortSignal: AbortSignal,
  options?: DownloadTelegramAttachmentsOptions,
): Promise<AgentAttachment[]> {
  const maxBytes = options?.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const allowlist = new Set(
    (options?.mimeAllowlist ?? DEFAULT_ATTACHMENT_MIME_ALLOWLIST).map((mime) => mime.toLowerCase()),
  );
  const logger = options?.logger;
  // Build the transcriber once (not per attachment): the seam wins, else the
  // config builds a default OpenAI-compatible transcriber, else none.
  const transcriber =
    options?.transcriber ??
    (options?.transcription === undefined ? undefined : createOpenAiTranscriber(options.transcription));
  // Independent of downloadTimeoutMs: download latency scales with file size,
  // transcription latency with audio duration (a multi-minute note can take
  // minutes on a local whisper server).
  const transcribeTimeoutMs = options?.transcription?.timeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
  const resolved: AgentAttachment[] = [];

  for (const attachment of attachments) {
    if (abortSignal.aborted) {
      break;
    }
    const source = attachmentSource(attachment);
    const mimeType = source.mimeType.toLowerCase();
    if (!allowlist.has(mimeType)) {
      logger?.debug?.("Skipping Telegram attachment with disallowed MIME type.", {
        mimeType: source.mimeType,
        name: source.name,
      });
      continue;
    }
    if (source.declaredSize !== undefined && source.declaredSize > maxBytes) {
      logger?.debug?.("Skipping oversized Telegram attachment.", {
        sizeBytes: source.declaredSize,
        maxBytes,
        name: source.name,
      });
      continue;
    }

    try {
      const filePath = await downloader.resolveFilePath(source.fileId, abortSignal);
      if (filePath === undefined) {
        logger?.warn?.("Telegram getFile returned no file_path; skipping attachment.", {
          fileId: source.fileId,
          name: source.name,
        });
        continue;
      }
      const bytes = await downloader.download(filePath, abortSignal, maxBytes);
      if (bytes.byteLength > maxBytes) {
        logger?.warn?.("Telegram attachment exceeded the size cap after download; skipping.", {
          sizeBytes: bytes.byteLength,
          maxBytes,
          name: source.name,
        });
        continue;
      }
      // Audio kinds (voice / audio / video_note) get an inlined transcript so a
      // caption-less clip reaches the model as words. The file is still saved,
      // so the fallback note can point at it when transcription fails.
      const transcript =
        transcriber !== undefined && isTranscribableKind(attachment.kind)
          ? await transcribeAttachment({
              transcriber,
              bytes,
              source,
              abortSignal,
              timeoutMs: transcribeTimeoutMs,
              logger,
            })
          : undefined;
      resolved.push(buildAgentAttachment(source, mimeType, bytes, transcript));
    } catch (error) {
      // Download failures never fail the run — skip the attachment and continue.
      logger?.warn?.("Failed to download Telegram attachment; skipping it.", {
        fileId: source.fileId,
        name: source.name,
        error: redactTelegramErrorMessage(error),
      });
    }
  }

  return resolved;
}

function buildAgentAttachment(
  source: ResolvedTelegramAttachmentSource,
  mimeType: string,
  bytes: Uint8Array,
  transcript?: string,
): AgentAttachment {
  const kind = agentAttachmentKindFromMimeType(mimeType);
  const attachment: { -readonly [K in keyof AgentAttachment]?: AgentAttachment[K] } = {
    kind,
    mimeType: source.mimeType,
    data: Buffer.from(bytes).toString("base64"),
    sizeBytes: bytes.byteLength,
  };
  if (source.name !== undefined) {
    attachment.name = source.name;
  }
  if (source.durationSeconds !== undefined) {
    attachment.durationSeconds = source.durationSeconds;
  }
  if (transcript !== undefined) {
    // Audio transcript (or the fallback note) inlined so the model sees words.
    attachment.text = transcript;
  } else {
    const text = decodeAgentAttachmentText(mimeType, bytes);
    if (text !== undefined) {
      attachment.text = text;
    }
  }
  return attachment as AgentAttachment;
}

/** The three Telegram audio-bearing kinds whose bytes we auto-transcribe. */
function isTranscribableKind(kind: TelegramAttachmentKind): boolean {
  return kind === "voice" || kind === "audio" || kind === "video_note";
}

/** Default per-call transcription timeout when `transcription.timeoutMs` is unset (120s). */
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 120_000;

/** The text inlined when transcription fails, pointing at the saved audio file. */
export const TELEGRAM_TRANSCRIPTION_UNAVAILABLE_NOTE =
  "[automatic transcription unavailable — audio saved at the path above]";

/**
 * Transcribe one audio attachment, bounding the call by `timeoutMs` composed with
 * the run signal. Any failure logs a single warn line and returns the fallback
 * note (never throws), so a flaky transcriber degrades to "audio saved" rather
 * than failing the whole download.
 */
async function transcribeAttachment(input: {
  readonly transcriber: TelegramTranscriber;
  readonly bytes: Uint8Array;
  readonly source: ResolvedTelegramAttachmentSource;
  readonly abortSignal: AbortSignal;
  readonly timeoutMs: number;
  readonly logger: TelegramAdapterLogger | undefined;
}): Promise<string> {
  const useTimeout = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0;
  const signal = useTimeout
    ? AbortSignal.any([input.abortSignal, AbortSignal.timeout(input.timeoutMs)])
    : input.abortSignal;
  try {
    const transcript = await input.transcriber.transcribe(
      {
        bytes: input.bytes,
        mimeType: input.source.mimeType,
        ...(input.source.name === undefined ? {} : { filename: input.source.name }),
      },
      signal,
    );
    if (transcript.trim().length === 0) {
      throw new Error("Transcriber returned empty text.");
    }
    return transcript;
  } catch (error) {
    input.logger?.warn?.("Failed to transcribe Telegram audio; inlining the fallback note.", {
      fileId: input.source.fileId,
      name: input.source.name,
      error: redactTelegramErrorMessage(error),
    });
    return TELEGRAM_TRANSCRIPTION_UNAVAILABLE_NOTE;
  }
}

function attachmentSource(attachment: TelegramAttachment): ResolvedTelegramAttachmentSource {
  const name = "fileName" in attachment ? attachment.fileName : undefined;
  return {
    fileId: attachment.fileId,
    mimeType: attachmentMimeType(attachment),
    name,
    declaredSize: attachment.fileSize,
    durationSeconds: "duration" in attachment ? attachment.duration : undefined,
  };
}

function attachmentMimeType(attachment: TelegramAttachment): string {
  if ("mimeType" in attachment && attachment.mimeType !== undefined) {
    return attachment.mimeType;
  }
  if (attachment.kind === "photo") {
    return "image/jpeg";
  }
  if (attachment.kind === "voice") {
    return "audio/ogg";
  }
  // Telegram may omit mime_type on audio/video; fall back to a sensible default
  // on the allowlist so the attachment is not skipped as application/octet-stream.
  if (attachment.kind === "audio") {
    return "audio/mpeg";
  }
  if (attachment.kind === "video" || attachment.kind === "video_note") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

function metadataFromUser(
  user: TelegramUser | undefined,
): TelegramRequestMetadata["from"] | undefined {
  if (user === undefined) {
    return undefined;
  }

  const metadata: NonNullable<TelegramRequestMetadata["from"]> = { id: user.id };
  if (user.is_bot !== undefined) {
    metadata.isBot = user.is_bot;
  }
  if (user.username !== undefined) {
    metadata.username = user.username;
  }
  if (user.first_name !== undefined) {
    metadata.firstName = user.first_name;
  }
  if (user.last_name !== undefined) {
    metadata.lastName = user.last_name;
  }
  if (user.language_code !== undefined) {
    metadata.languageCode = user.language_code;
  }
  return metadata;
}

/**
 * Deliver a terminal/system message (cancelled, error, …) in place. Such copy is
 * fixed text we author, not model output, so it is delivered as plain text
 * (`format: false`) — no MarkdownV2 escaping — while still reusing the stream's
 * resilient edit-or-recreate delivery.
 */
export async function finishSafely(
  stream: TelegramMessageStream,
  text: string,
  logger: TelegramAdapterLogger | undefined,
): Promise<void> {
  try {
    await stream.finish(text, { format: false });
  } catch (error) {
    logger?.error?.("Failed to send Telegram terminal stream message.", {
      error: redactTelegramErrorMessage(error),
    });
  }
}

export async function resolveErrorText(input: {
  readonly configured: TelegramAdapterErrorText;
  readonly error: unknown;
  readonly request: AgentRequest;
  readonly logger: TelegramAdapterLogger | undefined;
}): Promise<string> {
  if (typeof input.configured === "string") {
    return input.configured;
  }

  try {
    const resolved = await input.configured({
      error: input.error,
      request: input.request,
    });
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved;
    }
    input.logger?.warn?.("Telegram adapter error text callback returned empty text.");
  } catch (error) {
    input.logger?.error?.("Telegram adapter error text callback failed.", {
      error: redactTelegramErrorMessage(error),
    });
  }

  return DEFAULT_ERROR_TEXT;
}
