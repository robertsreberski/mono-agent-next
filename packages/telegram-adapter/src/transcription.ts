/**
 * Optional speech-to-text for inbound Telegram audio (voice / audio / video_note).
 * The transcriber posts the downloaded bytes to an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (e.g. a local WhisperKit server) and
 * returns the transcript text, which the download path then inlines into the
 * attachment's `text` field so a caption-less voice note reaches the model as
 * words, not just an on-disk file path.
 */

/** Transcription endpoint + model settings (the full transcriptions-route URL, not a base). */
export interface TelegramTranscriptionConfig {
  /** Full URL of the OpenAI-compatible transcriptions route (e.g. `http://localhost:50060/v1/audio/transcriptions`). */
  readonly endpoint: string;
  /** Model name sent as the multipart `model` part (required by the server). */
  readonly model: string;
  /** Optional ISO-639 language hint sent as the `language` part. */
  readonly language?: string;
  /**
   * Bound for one transcription call in milliseconds (default 120s, enforced
   * by the download path). Independent of `attachments.downloadTimeoutMs`:
   * download latency scales with file size, transcription latency with audio
   * duration.
   */
  readonly timeoutMs?: number;
}

/** A pluggable transcriber. The download path passes a per-call abort signal. */
export interface TelegramTranscriber {
  transcribe(
    input: { bytes: Uint8Array; mimeType: string; filename?: string },
    signal: AbortSignal,
  ): Promise<string>;
}

type FetchImpl = typeof fetch;

/**
 * Build a {@link TelegramTranscriber} that POSTs `multipart/form-data` (parts
 * `file`, `model`, and optional `language`) to an OpenAI-compatible
 * transcriptions endpoint and reads back `{ text }`. Uses only native `fetch` +
 * `FormData` + `Blob` (no added dependencies). A non-2xx response, or a body
 * without a non-empty `text` string, throws so the caller can fall back.
 */
export function createOpenAiTranscriber(
  config: TelegramTranscriptionConfig,
  fetchImpl: FetchImpl = fetch,
): TelegramTranscriber {
  return {
    async transcribe(input, signal): Promise<string> {
      const form = new FormData();
      const filename = input.filename ?? defaultAudioFilename(input.mimeType);
      // Copy into a fresh ArrayBuffer-backed view so the Blob owns contiguous bytes
      // regardless of the source Uint8Array's offset into a larger buffer.
      const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType });
      form.append("file", blob, filename);
      form.append("model", config.model);
      if (config.language !== undefined) {
        form.append("language", config.language);
      }

      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        body: form,
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Telegram transcription request failed with status ${response.status}.`,
        );
      }
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
        throw new Error("Telegram transcription response contained no text.");
      }
      return payload.text;
    },
  };
}

/**
 * Default upload filename whose extension matches the container, for servers
 * that key their decoder off the extension rather than sniffing content.
 */
function defaultAudioFilename(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "audio/mpeg":
      return "audio.mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return "audio.m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "audio.wav";
    case "video/mp4":
      return "video.mp4";
    default:
      return "voice.ogg";
  }
}
