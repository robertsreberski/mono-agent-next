import type { ChannelAttachment } from "@mono-agent/module-sdk";

import type { TelegramTranscriptionConfig } from "./config.js";

const MAX_TRANSCRIPTION_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;

export type TelegramTranscriber = (
  attachment: ChannelAttachment,
  signal: AbortSignal,
) => Promise<string>;

export function createTelegramTranscriber(
  config: TelegramTranscriptionConfig,
  fetchImpl: typeof fetch = fetch,
): TelegramTranscriber {
  return async (attachment, signal) => {
    if (attachment.sizeBytes !== attachment.data.byteLength) {
      throw new Error("Telegram transcription attachment size is invalid.");
    }
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("Telegram transcription timed out.")),
      config.timeoutMs,
    );
    timer.unref();
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      const form = new FormData();
      form.set(
        "file",
        new Blob([Buffer.from(attachment.data)], { type: attachment.mediaType }),
        attachment.name,
      );
      form.set("model", config.model);
      if (config.language !== undefined) form.set("language", config.language);
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: combined,
      });
      const payload = await readBoundedJson(response, MAX_TRANSCRIPTION_RESPONSE_BYTES);
      if (!response.ok) {
        throw new Error(`Telegram transcription failed with HTTP ${response.status}.`);
      }
      if (!isRecord(payload) || typeof payload.text !== "string") {
        throw new Error("Telegram transcription response must contain text.");
      }
      const text = payload.text.trim();
      if (text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES) {
        throw new Error("Telegram transcription response text is empty or too large.");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new Error("Telegram transcription response exceeds the byte limit.");
  }
  if (response.body === null) throw new Error("Telegram transcription response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Telegram transcription response exceeds the byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
