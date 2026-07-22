import type { ChannelDeliveryResult, ChannelOutboundMessage, ModuleDiagnostic } from "@mono-agent/module-sdk";

import type { SlackApiClient } from "./client.js";
import type { SlackConfig } from "./config.js";

export class SlackDelivery {
  private readonly completed = new Map<string, ChannelDeliveryResult>();
  private readonly pending = new Map<string, Promise<ChannelDeliveryResult>>();
  constructor(private readonly config: SlackConfig, private readonly client: SlackApiClient) {}

  deliver(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const key = message.idempotencyKey;
    const prior = this.completed.get(key);
    if (prior !== undefined) return Promise.resolve({ ...prior, status: "duplicate", idempotencyKey: key });
    const active = this.pending.get(key);
    if (active !== undefined) return active;
    const promise = this.send(message, signal).then((result) => {
      if (result.status === "delivered") {
        this.completed.set(key, result);
        while (this.completed.size > 1_000) this.completed.delete(this.completed.keys().next().value as string);
      }
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async send(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const destination = slackDestination(message.conversationId, this.config.defaultDestination);
    if (destination === undefined || (!this.config.allowAllChannels && !this.config.allowedChannelIds.includes(destination.channelId))) return failed(message.idempotencyKey, "slack_destination_forbidden", "Slack delivery destination is not authorized.");
    if (message.text.length === 0 && (message.attachments?.length ?? 0) === 0) return failed(message.idempotencyKey, "slack_delivery_empty", "Slack delivery requires text or an attachment.");
    for (const attachment of message.attachments ?? []) {
      if (attachment.sizeBytes !== attachment.data.byteLength || attachment.sizeBytes > this.config.maxAttachmentBytes) return failed(message.idempotencyKey, "slack_attachment_invalid", "Slack delivery attachment size is invalid or exceeds the configured limit.");
    }
    try {
      let messageId: string | undefined;
      if (message.text.length > 0) messageId = (await this.client.postMessage({ ...destination, text: message.text, idempotencyKey: message.idempotencyKey, signal })).messageId;
      for (const attachment of message.attachments ?? []) messageId = (await this.client.postFile({ ...destination, attachment, idempotencyKey: message.idempotencyKey, signal })).messageId;
      return { status: "delivered", idempotencyKey: message.idempotencyKey, ...(messageId === undefined ? {} : { messageId }) };
    } catch {
      return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("slack_delivery_unknown", "Slack delivery outcome is unknown.") };
    }
  }
}

function slackDestination(conversationId: string, fallback: string | undefined): { readonly channelId: string; readonly threadId?: string } | undefined {
  const value = conversationId.startsWith("slack:") ? conversationId.slice("slack:".length) : conversationId.length === 0 ? fallback : undefined;
  if (value === undefined) return undefined;
  const [channelId, threadId] = value.split(":", 2);
  return channelId === undefined || channelId.length === 0 ? undefined : { channelId, ...(threadId === undefined || threadId.length === 0 ? {} : { threadId }) };
}
function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
function diagnostic(code: string, message: string): ModuleDiagnostic { return { code, severity: "error", message }; }
