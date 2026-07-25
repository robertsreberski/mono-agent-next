// SPDX-License-Identifier: MIT
import type {
  ChannelAttachment, ChannelCompletionDelivery, ChannelOutboundMessage, JsonObject,
} from "@mono-agent/module-sdk";
import { snapshotBoundedValue } from "./bounded-value.js";
import { normalizeSubmitInput } from "./host-submit-input.js";
import {
  SUBMIT_SNAPSHOT_MAX_BYTES, SUBMIT_SNAPSHOT_MAX_DEPTH, SUBMIT_SNAPSHOT_MAX_ITEMS,
} from "./host-types.js";
import { immutableClone, isJsonObject, ownDataRecord, routeText } from "./host-values.js";
export function normalizeOutboundMessage(
  message: ChannelOutboundMessage,
  resolveDefault?: () => string | undefined,
): ChannelOutboundMessage {
  const input = ownDataRecord(
    message,
    "outbound message",
    [
      "conversationId", "text", "attachments", "replyToMessageId",
      "idempotencyKey", "metadata",
    ],
  );
  const idempotencyKey = routeText(input.idempotencyKey, "idempotencyKey", 512);
  const conversationId = input.conversationId === "" ? resolveDefault?.() : input.conversationId;
  if (input.conversationId === "" && conversationId === undefined)
    throw new TypeError("conversationId requires an adapter-owned default");
  const normalized = normalizeSubmitInput({
    requestId: idempotencyKey,
    conversationId: conversationId as string,
    text: input.text as string,
    ...(input.attachments === undefined
      ? {}
      : { attachments: input.attachments as readonly ChannelAttachment[] }),
  });
  const replyToMessageId = input.replyToMessageId === undefined ? undefined
    : routeText(input.replyToMessageId, "replyToMessageId", 4_096);
  const metadata = input.metadata === undefined
    ? undefined
    : snapshotBoundedValue(input.metadata, {
        path: "outbound message metadata",
        maxBytes: SUBMIT_SNAPSHOT_MAX_BYTES,
        maxItems: SUBMIT_SNAPSHOT_MAX_ITEMS,
        maxDepth: SUBMIT_SNAPSHOT_MAX_DEPTH,
        label: "JSON",
        freeze: true,
        requireOrdinaryArrays: true,
      }).value;
  if (metadata !== undefined && !isJsonObject(metadata))
    throw new TypeError("outbound message metadata must be a JSON object");
  return immutableClone({
    conversationId: normalized.conversationId,
    text: normalized.text,
    ...(normalized.attachments === undefined ? {} : { attachments: normalized.attachments }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    idempotencyKey,
    ...(metadata === undefined ? {} : { metadata }),
  });
}
export function deliveryTriggerKind(metadata: JsonObject | undefined): JsonObject {
  const triggerKind = metadata?.triggerKind;
  return triggerKind === "cron" || triggerKind === "webhook"
    ? Object.freeze({ triggerKind })
    : Object.freeze({});
}
export function normalizeCompletionDelivery(value: unknown): ChannelCompletionDelivery | undefined {
  if (value === undefined) return undefined;
  const input = ownDataRecord(value, "channel completion delivery", ["channel", "destination"]);
  const channel = routeText(input.channel, "channel completion delivery channel", 512);
  const destination = input.destination === undefined ? undefined
    : routeText(input.destination, "channel completion delivery destination", 4_096);
  return Object.freeze({
    channel, ...(destination === undefined ? {} : { destination }),
  });
}
