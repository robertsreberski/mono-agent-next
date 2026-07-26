// SPDX-License-Identifier: MIT
import type { ChannelAttachment } from "@mono-agent/module-sdk";

import type { TelegramTranscriptionConfig } from "./config.js";
import { isRecord, readBoundedJson } from "./http.js";
import {
  resolveTelegramHttpTransport,
  type TelegramHttpTransportInput,
} from "./transport.js";

const MAX_TRANSCRIPTION_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;

export type TelegramTranscriber = (
  attachment: ChannelAttachment,
  signal: AbortSignal,
) => Promise<string>;

export function createTelegramTranscriber(
  config: TelegramTranscriptionConfig,
  transportInput?: TelegramHttpTransportInput,
): TelegramTranscriber {
  const transport = resolveTelegramHttpTransport(undefined, transportInput);
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
      const form = transport.createFormData();
      form.set(
        "file",
        new Blob([Buffer.from(attachment.data)], { type: attachment.mediaType }),
        attachment.name,
      );
      form.set("model", config.model);
      if (config.language !== undefined) form.set("language", config.language);
      const response = await transport.fetch(config.endpoint, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: combined,
      });
      const payload = await readBoundedJson(
        response,
        MAX_TRANSCRIPTION_RESPONSE_BYTES,
        "Telegram transcription response",
      );
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
