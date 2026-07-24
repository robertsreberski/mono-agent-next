import type { ChannelAttachment } from "@mono-agent/module-sdk";

import type { SlackConfig } from "./config.js";
import { isSlackMessageTimestamp } from "./destination.js";
import type { SlackRemoteFile } from "./socket.js";

export interface SlackPostRequest {
  readonly channelId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly buttons?: readonly { readonly label: string; readonly value: string }[];
  readonly signal: AbortSignal;
}

export interface SlackFilePostRequest {
  readonly channelId: string;
  readonly threadId?: string;
  readonly attachment: ChannelAttachment;
  readonly signal: AbortSignal;
}

export interface SlackHomeView {
  readonly type: "home";
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
}

export interface SlackApiClient {
  download(file: SlackRemoteFile, maxBytes: number, signal: AbortSignal): Promise<ChannelAttachment>;
  postMessage(request: SlackPostRequest): Promise<{ readonly messageId: string }>;
  postFile(request: SlackFilePostRequest): Promise<{ readonly messageId?: string }>;
  setAssistantStatus?(
    channelId: string,
    threadId: string,
    status: string,
    signal: AbortSignal,
  ): Promise<void>;
  publishHome?(userId: string, view: SlackHomeView, signal: AbortSignal): Promise<void>;
  addReaction?(channelId: string, messageId: string, name: string, signal: AbortSignal): Promise<void>;
}

export type SlackApiClientFactory = (config: SlackConfig) => SlackApiClient;

export function createSlackWebApiClient(config: SlackConfig, fetchImpl: typeof fetch = fetch): SlackApiClient {
  const api = async (
    method: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${config.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal,
    });
    const value = await boundedJson(response, 2 * 1024 * 1024);
    if (!response.ok || !record(value) || value.ok !== true) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}.`);
    }
    return value;
  };
  return {
    async download(file, maxBytes, signal) {
      if (file.sizeBytes !== undefined && file.sizeBytes > maxBytes) {
        throw new Error("Slack attachment exceeds the configured byte limit.");
      }
      const url = new URL(file.privateUrl);
      if (url.protocol !== "https:" || !isSlackHost(url.hostname)) {
        throw new Error("Slack attachment URL is not trusted.");
      }
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${config.botToken}` },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error(`Slack file download failed with HTTP ${response.status}.`);
      const data = await boundedBytes(response, maxBytes, "Slack attachment");
      return {
        id: file.id,
        kind: attachmentKind(file.mediaType),
        name: file.name,
        mediaType: file.mediaType,
        sizeBytes: data.byteLength,
        data,
      };
    },
    async postMessage(request) {
      const value = await api("chat.postMessage", {
        channel: request.channelId,
        text: request.text,
        ...(request.threadId === undefined ? {} : { thread_ts: request.threadId }),
        ...(request.buttons === undefined || request.buttons.length === 0
          ? {}
          : { blocks: messageBlocks(request.text, request.buttons) }),
      }, request.signal);
      if (!isSlackMessageTimestamp(value.ts)) throw new Error("Slack chat.postMessage returned no timestamp.");
      return { messageId: value.ts };
    },
    async postFile(request) {
      const bytes = Buffer.from(request.attachment.data);
      const upload = await api("files.getUploadURLExternal", {
        filename: request.attachment.name,
        length: bytes.byteLength,
      }, request.signal);
      if (typeof upload.upload_url !== "string" || typeof upload.file_id !== "string") {
        throw new Error("Slack upload URL response is invalid.");
      }
      const uploadUrl = new URL(upload.upload_url);
      if (uploadUrl.protocol !== "https:" || !isSlackHost(uploadUrl.hostname)) {
        throw new Error("Slack upload URL is not trusted.");
      }
      const sent = await fetchImpl(uploadUrl, {
        method: "POST",
        redirect: "error",
        body: bytes,
        signal: request.signal,
      });
      if (!sent.ok) throw new Error(`Slack file upload failed with HTTP ${sent.status}.`);
      const completed = await api("files.completeUploadExternal", {
        files: [{ id: upload.file_id, title: request.attachment.name }],
        channel_id: request.channelId,
        ...(request.threadId === undefined ? {} : { thread_ts: request.threadId }),
      }, request.signal);
      return isSlackMessageTimestamp(completed.ts)
        ? { messageId: completed.ts }
        : {};
    },
    async setAssistantStatus(channelId, threadId, status, signal) {
      await api("assistant.threads.setStatus", {
        channel_id: channelId,
        thread_ts: threadId,
        status,
      }, signal);
    },
    async publishHome(userId, view, signal) {
      await api("views.publish", { user_id: userId, view }, signal);
    },
    async addReaction(channelId, messageId, name, signal) {
      await api("reactions.add", {
        channel: channelId,
        timestamp: messageId,
        name,
      }, signal);
    },
  };
}

function messageBlocks(
  text: string,
  buttons: readonly { readonly label: string; readonly value: string }[],
): readonly Readonly<Record<string, unknown>>[] {
  const blocks: Readonly<Record<string, unknown>>[] = [{
    type: "section",
    text: { type: "mrkdwn", text },
  }];
  for (let offset = 0; offset < buttons.length; offset += 5) {
    blocks.push({
      type: "actions",
      elements: buttons.slice(offset, offset + 5).map((button) => ({
        type: "button",
        text: { type: "plain_text", text: button.label.slice(0, 75) },
        action_id: "mono_agent_ask",
        value: button.value,
      })),
    });
  }
  return blocks;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedJson(response: Response, max: number): Promise<unknown> {
  const bytes = await boundedBytes(response, max, "Slack response");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function attachmentKind(mediaType: string): "image" | "audio" | "file" {
  return mediaType.startsWith("image/")
    ? "image"
    : mediaType.startsWith("audio/") ? "audio" : "file";
}

function isSlackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "slack.com" || normalized.endsWith(".slack.com");
}

async function boundedBytes(response: Response, max: number, label: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > max)) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds the byte limit.`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error(`${label} exceeds the byte limit.`);
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
  return bytes;
}
