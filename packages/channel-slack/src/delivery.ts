import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  ChannelAttachment,
  ChannelDeliveryResult,
  ChannelOutboundMessage,
  JsonObject,
  JsonValue,
  ModuleDiagnostic,
} from "@mono-agent/module-sdk";

import type { SlackApiClient } from "./client.js";
import type { SlackConfig } from "./config.js";
import {
  isSlackMessageTimestamp,
  resolveSlackDestination,
  slackConversationId,
  type SlackDestination,
} from "./destination.js";
import { MAX_TOTAL_SLACK_ATTACHMENT_BYTES } from "./limits.js";

const MAX_DELIVERY_RECEIPTS = 1_000;
const MAX_DELIVERY_ATTACHMENTS = 10;
const MAX_METADATA_BYTES = 65_536;
const MAX_METADATA_ITEMS = 2_048;
const MAX_METADATA_DEPTH = 16;

interface DeliveryReceipt {
  readonly fingerprint: string;
  readonly promise: Promise<ChannelDeliveryResult>;
  result?: ChannelDeliveryResult;
}

interface PreparedSlackDelivery {
  readonly message: ChannelOutboundMessage;
  readonly destination: SlackDestination;
}

export class SlackDelivery {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private capacityExhausted = false;
  private ambiguousOutcome = false;

  constructor(private readonly config: SlackConfig, private readonly client: SlackApiClient) {}

  get degraded(): boolean {
    return this.capacityExhausted || this.ambiguousOutcome;
  }

  get receiptCapacityExhausted(): boolean {
    return this.capacityExhausted;
  }

  get hasAmbiguousOutcome(): boolean {
    return this.ambiguousOutcome;
  }

  deliver(message: ChannelOutboundMessage, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const prepared = prepareSlackDelivery(message, this.config);
    if ("failure" in prepared) return Promise.resolve(prepared.failure);
    const key = prepared.message.idempotencyKey;
    const fingerprint = deliveryFingerprint(prepared.message);
    const prior = this.receipts.get(key);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.resolve(failed(
          key,
          "slack_delivery_idempotency_conflict",
          "The Slack delivery idempotency key was reused for a different payload.",
        ));
      }
      if (prior.result?.status === "delivered" || prior.result?.status === "duplicate") {
        return Promise.resolve({ ...prior.result, status: "duplicate", idempotencyKey: key });
      }
      return prior.promise;
    }
    if (this.receipts.size >= MAX_DELIVERY_RECEIPTS) {
      this.capacityExhausted = true;
      return Promise.resolve(failed(
        key,
        "slack_delivery_receipt_capacity",
        "Slack delivery receipt capacity is exhausted; restart-safe Core delivery authority is required.",
      ));
    }
    let receipt: DeliveryReceipt;
    const promise = this.send(prepared, signal).catch(() => ({
      status: "unknown" as const,
      idempotencyKey: key,
      diagnostic: diagnostic(
        "slack_delivery_unknown",
        "Slack delivery outcome is unknown.",
      ),
    })).then((result) => {
      if (result.status === "delivered" || result.status === "duplicate" || result.status === "unknown") {
        receipt.result = result;
        if (result.status === "unknown") this.ambiguousOutcome = true;
      } else {
        this.receipts.delete(key);
        this.capacityExhausted = this.receipts.size >= MAX_DELIVERY_RECEIPTS;
      }
      return result;
    });
    receipt = { fingerprint, promise };
    this.receipts.set(key, receipt);
    return promise;
  }

  private async send(prepared: PreparedSlackDelivery, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const { destination, message } = prepared;
    if (message.text.length === 0 && (message.attachments?.length ?? 0) === 0) return failed(message.idempotencyKey, "slack_delivery_empty", "Slack delivery requires text or an attachment.");
    try {
      let messageId: string | undefined;
      if (message.text.length > 0) {
        const receipt = await this.client.postMessage({
          ...destination,
          text: message.text,
          signal,
        });
        if (isSlackMessageTimestamp(receipt.messageId)) messageId = receipt.messageId;
      }
      for (const attachment of message.attachments ?? []) {
        const receipt = await this.client.postFile({
          ...destination,
          attachment,
          signal,
        });
        if (isSlackMessageTimestamp(receipt.messageId)) messageId = receipt.messageId;
      }
      return { status: "delivered", idempotencyKey: message.idempotencyKey, ...(messageId === undefined ? {} : { messageId }) };
    } catch {
      return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: diagnostic("slack_delivery_unknown", "Slack delivery outcome is unknown.") };
    }
  }
}

function prepareSlackDelivery(
  value: ChannelOutboundMessage,
  config: SlackConfig,
):
  | PreparedSlackDelivery
  | { readonly failure: ChannelDeliveryResult } {
  try {
    const input = ownDataRecord(value, "Slack outbound message", [
      "conversationId",
      "text",
      "attachments",
      "replyToMessageId",
      "idempotencyKey",
      "metadata",
    ]);
    const key = boundedText(input.idempotencyKey, "idempotencyKey", 512);
    const conversationId = boundedText(
      input.conversationId,
      "conversationId",
      4_096,
      true,
    );
    const destination = resolveSlackDestination(
      conversationId,
      config.defaultDestination,
    );
    if (destination === undefined
      || (!config.allowAllChannels
        && !config.allowedChannelIds.includes(destination.channelId))) {
      return {
        failure: failed(
          key,
          "slack_destination_forbidden",
          "Slack delivery destination is not authorized.",
        ),
      };
    }
    const text = boundedText(input.text, "text", 40_000, true);
    const attachments = snapshotAttachments(
      input.attachments,
      config.maxAttachmentBytes,
    );
    const replyToMessageId = input.replyToMessageId === undefined
      ? undefined
      : boundedText(input.replyToMessageId, "replyToMessageId", 128);
    const metadata = input.metadata === undefined
      ? undefined
      : snapshotMetadata(input.metadata);
    return Object.freeze({
      destination,
      message: Object.freeze({
        conversationId: slackConversationId(destination),
        text,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        idempotencyKey: key,
        ...(metadata === undefined ? {} : { metadata }),
      }),
    });
  } catch {
    const key = safeIdempotencyKey(value);
    return {
      failure: failed(
        key,
        "slack_delivery_invalid",
        "Slack delivery payload is invalid or exceeds a configured bound.",
      ),
    };
  }
}

function deliveryFingerprint(message: ChannelOutboundMessage): string {
  const encoded = JSON.stringify({
    conversationId: message.conversationId,
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: createHash("sha256").update(attachment.data).digest("hex"),
    })),
    replyToMessageId: message.replyToMessageId ?? null,
    metadata: message.metadata ?? null,
  }, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
  return createHash("sha256").update(encoded).digest("hex");
}

function snapshotAttachments(
  value: unknown,
  maxAttachmentBytes: number,
): readonly ChannelAttachment[] {
  if (value === undefined) return Object.freeze([]);
  if (utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_DELIVERY_ATTACHMENTS) {
    throw new TypeError("attachments must be one bounded ordinary array");
  }
  assertDenseDataArray(value, "attachments");
  let totalBytes = 0;
  const attachments = value.map((entry, index): ChannelAttachment => {
    const input = ownDataRecord(entry, `attachment ${String(index)}`, [
      "id",
      "kind",
      "name",
      "mediaType",
      "sizeBytes",
      "data",
    ]);
    if (input.kind !== "image" && input.kind !== "audio" && input.kind !== "file") {
      throw new TypeError("attachment kind is invalid");
    }
    const sizeBytes = input.sizeBytes;
    if (!Number.isSafeInteger(sizeBytes)
      || (sizeBytes as number) < 0
      || (sizeBytes as number) > maxAttachmentBytes) {
      throw new TypeError("attachment size is invalid");
    }
    const source = input.data;
    if (utilTypes.isProxy(source) || !(source instanceof Uint8Array)) {
      throw new TypeError("attachment data must be Uint8Array");
    }
    if (source.byteLength !== sizeBytes
      || totalBytes + source.byteLength > MAX_TOTAL_SLACK_ATTACHMENT_BYTES) {
      throw new TypeError("attachment size does not match its bounded data");
    }
    const data = new Uint8Array(source);
    if (data.byteLength !== sizeBytes) {
      throw new TypeError("attachment size does not match data");
    }
    totalBytes += data.byteLength;
    return Object.freeze({
      id: boundedText(input.id, "attachment id", 512),
      kind: input.kind,
      name: boundedText(input.name, "attachment name", 1_024),
      mediaType: boundedText(input.mediaType, "attachment mediaType", 255),
      sizeBytes: data.byteLength,
      data,
    });
  });
  return Object.freeze(attachments);
}

function snapshotMetadata(value: unknown): JsonObject {
  const state = {
    items: 0,
    bytes: 0,
    seen: new WeakSet<object>(),
  };
  const snapshot = snapshotJson(value, state, 0);
  if (!isRecord(snapshot)) throw new TypeError("metadata must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_METADATA_BYTES) {
    throw new TypeError("metadata exceeds the delivery bound");
  }
  return snapshot as JsonObject;
}

function snapshotJson(
  value: unknown,
  state: { items: number; bytes: number; seen: WeakSet<object> },
  depth: number,
): JsonValue {
  state.items += 1;
  if (state.items > MAX_METADATA_ITEMS || depth > MAX_METADATA_DEPTH) {
    throw new TypeError("metadata exceeds the delivery structure bound");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("metadata number is invalid");
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_METADATA_BYTES) {
      throw new TypeError("metadata exceeds the delivery byte bound");
    }
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("metadata contains a non-JSON value");
  }
  if (state.seen.has(value)) throw new TypeError("metadata contains a cycle");
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || value.length > MAX_METADATA_ITEMS) {
      throw new TypeError("metadata array is invalid");
    }
    assertDenseDataArray(value, "metadata array");
    const output = value.map((entry) => snapshotJson(entry, state, depth + 1));
    state.seen.delete(value);
    return Object.freeze(output);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("metadata object is invalid");
  }
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string"
      || key === "__proto__"
      || key === "prototype"
      || key === "constructor") {
      throw new TypeError("metadata key is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("metadata property is invalid");
    }
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MAX_METADATA_BYTES) {
      throw new TypeError("metadata exceeds the delivery byte bound");
    }
    output[key] = snapshotJson(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return Object.freeze(output);
}

function assertDenseDataArray(value: readonly unknown[], label: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError(`${label} must contain only dense data entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only dense data entries`);
    }
  }
}

function ownDataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const fields = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.has(key)) {
      throw new TypeError(`${label} contains an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function boundedText(
  value: unknown,
  label: string,
  maxCharacters: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maxCharacters
    || value.includes("\0")) {
    throw new TypeError(`${label} exceeds its delivery bound`);
  }
  return value;
}

function safeIdempotencyKey(value: unknown): string {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return "invalid";
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "idempotencyKey");
  return descriptor !== undefined
    && "value" in descriptor
    && typeof descriptor.value === "string"
    && descriptor.value.length > 0
    && descriptor.value.length <= 512
    && !descriptor.value.includes("\0")
      ? descriptor.value
      : "invalid";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
function diagnostic(code: string, message: string): ModuleDiagnostic { return { code, severity: "error", message }; }
