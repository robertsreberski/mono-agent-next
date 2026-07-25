// SPDX-License-Identifier: MIT
import { createHash, createHmac } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  ChannelAttachment,
  ChannelDeliveryResult,
  ChannelOutboundMessage,
  JsonObject,
  JsonValue,
  ModuleDiagnostic,
} from "@mono-agent/module-sdk";

import type { WebhookOutboundConfig } from "./config.js";

const MAX_OUTBOUND_RAW_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_OUTBOUND_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_DELIVERY_RECEIPTS = 1_000;
const MAX_DELIVERY_ATTACHMENTS = 10;
const MAX_METADATA_BYTES = 65_536;
const MAX_METADATA_ITEMS = 2_048;
const MAX_METADATA_DEPTH = 16;
const MAX_MESSAGE_ID_BYTES = 512;

interface DeliveryReceipt {
  readonly fingerprint: string;
  readonly promise: Promise<ChannelDeliveryResult>;
  result?: ChannelDeliveryResult;
}

interface PreparedWebhookDelivery {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly payload: Buffer;
}

export class WebhookDelivery {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private capacityExhausted = false;
  private ambiguousOutcome = false;

  constructor(
    private readonly config: WebhookOutboundConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
    const prepared = prepareWebhookDelivery(message);
    if ("failure" in prepared) return Promise.resolve(prepared.failure);
    const key = prepared.idempotencyKey;
    const fingerprint = prepared.fingerprint;
    const prior = this.receipts.get(key);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.resolve(failed(
          key,
          "webhook_delivery_idempotency_conflict",
          "The webhook delivery idempotency key was reused for a different payload.",
        ));
      }
      if (prior.result?.status === "delivered" || prior.result?.status === "duplicate") {
        return Promise.resolve({ ...prior.result, status: "duplicate", idempotencyKey: key });
      }
      return prior.promise;
    }
    if (!this.reserveReceiptCapacity()) {
      return Promise.resolve(failed(
        key,
        "webhook_delivery_receipt_capacity",
        "Webhook delivery receipt capacity is exhausted; restart-safe Core delivery authority is required.",
      ));
    }
    let receipt: DeliveryReceipt;
    const execution = this.send(prepared, signal).then((result) => {
      if (result.status === "delivered" || result.status === "duplicate" || result.status === "unknown") {
        receipt.result = result;
        if (result.status === "unknown") {
          this.ambiguousOutcome = true;
        } else {
          this.capacityExhausted = false;
        }
      } else {
        this.receipts.delete(key);
        this.capacityExhausted = false;
      }
      return result;
    });
    receipt = { fingerprint, promise: execution };
    this.receipts.set(key, receipt);
    return execution;
  }

  private reserveReceiptCapacity(): boolean {
    if (this.receipts.size < MAX_DELIVERY_RECEIPTS) {
      this.capacityExhausted = false;
      return true;
    }
    for (const [key, receipt] of this.receipts) {
      if (receipt.result?.status === "delivered" || receipt.result?.status === "duplicate") {
        this.receipts.delete(key);
        this.capacityExhausted = false;
        return true;
      }
    }
    this.capacityExhausted = true;
    return false;
  }

  private async send(prepared: PreparedWebhookDelivery, signal: AbortSignal): Promise<ChannelDeliveryResult> {
    const { idempotencyKey, payload } = prepared;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...(this.config.apiKey === undefined ? {} : { authorization: `Bearer ${this.config.apiKey}` }),
      ...(this.config.signatureSecret === undefined ? {} : { "x-mono-agent-signature": `sha256=${createHmac("sha256", this.config.signatureSecret).update(payload).digest("hex")}` }),
    };
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetchImpl(this.config.url, { method: "POST", redirect: "error", headers, body: payload, signal: combined });
      if (response.status === 409) {
        await cancelResponseBody(response);
        return { status: "duplicate", idempotencyKey, diagnostic: diagnostic("webhook_duplicate", "Destination reported an already delivered idempotency key.", "info") };
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        return { status: "failed", idempotencyKey, diagnostic: diagnostic("webhook_delivery_rejected", `Webhook delivery was rejected with HTTP ${response.status}.`) };
      }
      const body = await readBounded(response, this.config.maxResponseBytes);
      let messageId: string | undefined;
      if (body.byteLength > 0) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
          if (typeof parsed === "object" && parsed !== null && "messageId" in parsed) {
            const candidate = (parsed as { messageId?: unknown }).messageId;
            if (!validMessageId(candidate)) {
              return {
                status: "unknown",
                idempotencyKey,
                diagnostic: diagnostic(
                  "webhook_delivery_response_invalid",
                  "Webhook delivery returned an invalid message identifier.",
                ),
              };
            }
            messageId = candidate;
          }
        } catch { /* response bodies are optional and never trusted as delivery truth */ }
      }
      return { status: "delivered", idempotencyKey, ...(messageId === undefined ? {} : { messageId }) };
    } catch {
      return { status: "unknown", idempotencyKey, diagnostic: diagnostic("webhook_delivery_unknown", "Webhook delivery outcome is unknown.") };
    }
  }
}

function prepareWebhookDelivery(
  value: ChannelOutboundMessage,
): PreparedWebhookDelivery | { readonly failure: ChannelDeliveryResult } {
  try {
    const input = ownDataRecord(value, "Webhook outbound message", [
      "conversationId",
      "text",
      "attachments",
      "replyToMessageId",
      "idempotencyKey",
      "metadata",
    ]);
    const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 512);
    const conversationId = boundedText(input.conversationId, "conversationId", 4_096);
    const text = boundedText(input.text, "text", 1_000_000, true);
    const attachments = snapshotAttachments(input.attachments);
    if (text.length === 0 && attachments.length === 0) {
      return {
        failure: failed(
          idempotencyKey,
          "webhook_delivery_empty",
          "Webhook delivery requires text or an attachment.",
        ),
      };
    }
    const replyToMessageId = input.replyToMessageId === undefined
      ? undefined
      : boundedText(input.replyToMessageId, "replyToMessageId", 4_096);
    const metadata = input.metadata === undefined
      ? undefined
      : snapshotMetadata(input.metadata);
    const message: ChannelOutboundMessage = Object.freeze({
      conversationId,
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      idempotencyKey,
      ...(metadata === undefined ? {} : { metadata }),
    });
    const payload = Buffer.from(JSON.stringify({
      idempotencyKey,
      conversationId,
      text,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      ...(metadata === undefined ? {} : { metadata }),
      attachments: attachments.map((attachment) => ({
        name: attachment.name,
        mediaType: attachment.mediaType,
        data: Buffer.from(attachment.data).toString("base64"),
      })),
    }), "utf8");
    if (payload.byteLength > MAX_OUTBOUND_PAYLOAD_BYTES) {
      return {
        failure: failed(
          idempotencyKey,
          "webhook_payload_too_large",
          "Webhook delivery payload exceeds the byte limit.",
        ),
      };
    }
    return Object.freeze({
      idempotencyKey,
      fingerprint: deliveryFingerprint(message),
      payload,
    });
  } catch {
    return {
      failure: failed(
        safeIdempotencyKey(value),
        "webhook_delivery_invalid",
        "Webhook delivery payload is invalid or exceeds a configured bound.",
      ),
    };
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch { /* response cleanup must not change a definitive HTTP outcome */ }
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

function snapshotAttachments(value: unknown): readonly ChannelAttachment[] {
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
    if (!Number.isSafeInteger(input.sizeBytes) || (input.sizeBytes as number) < 0) {
      throw new TypeError("attachment size is invalid");
    }
    const remaining = MAX_OUTBOUND_RAW_ATTACHMENT_BYTES - totalBytes;
    const data = cloneStableUint8Array(input.data, remaining);
    if (input.sizeBytes !== data.byteLength) {
      throw new TypeError("attachment size does not match data");
    }
    totalBytes += data.byteLength;
    return Object.freeze({
      id: boundedText(input.id, "attachment id", 512),
      kind: input.kind,
      name: boundedText(input.name, "attachment name", 255),
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
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
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
  maxBytes: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || Buffer.byteLength(value, "utf8") > maxBytes
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
    && descriptor.value.trim().length > 0
    && Buffer.byteLength(descriptor.value, "utf8") <= 512
    && !descriptor.value.includes("\0")
      ? descriptor.value
      : "invalid";
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const TYPED_ARRAY_TAG_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;

function cloneStableUint8Array(value: unknown, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes)
    || maxBytes < 0
    || TYPED_ARRAY_BUFFER_GETTER === undefined
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
    || TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined
    || TYPED_ARRAY_TAG_GETTER === undefined
    || utilTypes.isProxy(value)) {
    throw new TypeError("attachment data must be stable Uint8Array bytes");
  }
  try {
    if (TYPED_ARRAY_TAG_GETTER.call(value) !== "Uint8Array") {
      throw new TypeError("Expected Uint8Array");
    }
    const beforeLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
    const beforeOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value) as unknown;
    const buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    if (!Number.isSafeInteger(beforeLength)
      || (beforeLength as number) < 0
      || (beforeLength as number) > maxBytes
      || !Number.isSafeInteger(beforeOffset)
      || (beforeOffset as number) < 0
      || (!(buffer instanceof ArrayBuffer)
        && !(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer))) {
      throw new TypeError("Invalid Uint8Array internals");
    }
    const copy = new Uint8Array(
      buffer as ArrayBufferLike,
      beforeOffset as number,
      beforeLength as number,
    ).slice();
    if (TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) !== beforeLength
      || TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value) !== beforeOffset
      || TYPED_ARRAY_BUFFER_GETTER.call(value) !== buffer
      || copy.byteLength !== beforeLength) {
      throw new TypeError("Uint8Array changed while being copied");
    }
    return copy;
  } catch (error) {
    throw new TypeError("attachment data must be stable Uint8Array bytes", { cause: error });
  }
}

function validMessageId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_ID_BYTES;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, message: string, severity: "info" | "warning" | "error" = "error"): ModuleDiagnostic { return { code, severity, message }; }
function failed(idempotencyKey: string, code: string, message: string): ChannelDeliveryResult { return { status: "failed", idempotencyKey, diagnostic: diagnostic(code, message) }; }
