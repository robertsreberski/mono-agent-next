import { createHmac } from "node:crypto";

import type { ChannelDeliveryResult, ChannelOutboundMessage, ModuleDiagnostic } from "@mono-agent/module-sdk";

import type { WebhookOutboundConfig } from "./config.js";

const MAX_OUTBOUND_RAW_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_OUTBOUND_PAYLOAD_BYTES = 32 * 1024 * 1024;

export class WebhookDelivery {
  private readonly completed = new Map<string, ChannelDeliveryResult>();
  private readonly pending = new Map<string, Promise<ChannelDeliveryResult>>();

  constructor(
    private readonly config: WebhookOutboundConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  deliver(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const key = message.idempotencyKey;
    const prior = this.completed.get(key);
    if (prior !== undefined) return Promise.resolve({ ...prior, status: "duplicate", idempotencyKey: key });
    const active = this.pending.get(key);
    if (active !== undefined) return active;
    const execution = this.send(message, signal).then((result) => {
      if (result.status === "delivered" || result.status === "duplicate") {
        this.completed.set(key, result);
        while (this.completed.size > 1_000) this.completed.delete(this.completed.keys().next().value as string);
      }
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, execution);
    return execution;
  }

  private async send(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    if (message.text.length === 0 && (message.attachments?.length ?? 0) === 0) {
      return failed(message.idempotencyKey, "webhook_delivery_empty", "Webhook delivery requires text or an attachment.");
    }
    let attachmentBytes = 0;
    for (const attachment of message.attachments ?? []) {
      if (attachment.sizeBytes !== attachment.data.byteLength) {
        return failed(message.idempotencyKey, "webhook_attachment_invalid", "Webhook attachment size metadata does not match its payload.");
      }
      attachmentBytes += attachment.sizeBytes;
      if (!Number.isSafeInteger(attachmentBytes) || attachmentBytes > MAX_OUTBOUND_RAW_ATTACHMENT_BYTES) {
        return failed(message.idempotencyKey, "webhook_payload_too_large", "Webhook attachment payload exceeds the delivery byte limit.");
      }
    }
    const payload = Buffer.from(JSON.stringify({
      idempotencyKey: message.idempotencyKey,
      conversationId: message.conversationId,
      text: message.text,
      ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
      attachments: (message.attachments ?? []).map((attachment) => ({
        name: attachment.name,
        mediaType: attachment.mediaType,
        data: Buffer.from(attachment.data).toString("base64"),
      })),
    }), "utf8");
    if (payload.byteLength > MAX_OUTBOUND_PAYLOAD_BYTES) {
      return failed(message.idempotencyKey, "webhook_payload_too_large", "Webhook delivery payload exceeds the byte limit.");
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey,
      ...(this.config.apiKey === undefined ? {} : { authorization: `Bearer ${this.config.apiKey}` }),
      ...(this.config.signatureSecret === undefined ? {} : { "x-mono-agent-signature": `sha256=${createHmac("sha256", this.config.signatureSecret).update(payload).digest("hex")}` }),
    };
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetchImpl(this.config.url, { method: "POST", redirect: "error", headers, body: payload, signal: combined });
      if (response.status === 409) {
        await response.body?.cancel();
        return { status: "duplicate", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("webhook_duplicate", "Destination reported an already delivered idempotency key.", "info") };
      }
      const body = await readBounded(response, this.config.maxResponseBytes);
      if (!response.ok) return { status: "failed", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("webhook_delivery_rejected", `Webhook delivery was rejected with HTTP ${response.status}.`) };
      let messageId: string | undefined;
      if (body.byteLength > 0) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
          if (typeof parsed === "object" && parsed !== null && typeof (parsed as { messageId?: unknown }).messageId === "string") messageId = (parsed as { messageId: string }).messageId;
        } catch { /* response bodies are optional and never trusted as delivery truth */ }
      }
      return { status: "delivered", idempotencyKey: message.idempotencyKey, ...(messageId === undefined ? {} : { messageId }) };
    } catch {
      return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("webhook_delivery_unknown", "Webhook delivery outcome is unknown.") };
    }
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new Error("Webhook response exceeds the byte limit.");
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
      if (total > maximum) {
        await reader.cancel();
        throw new Error("Webhook response exceeds the byte limit.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function diagnostic(code: string, message: string, severity: "info" | "warning" | "error" = "error"): ModuleDiagnostic { return { code, severity, message }; }
function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
