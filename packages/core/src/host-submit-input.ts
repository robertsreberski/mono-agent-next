// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import type { ChannelAttachment } from "@mono-agent/module-sdk";
import { cloneIntrinsicUint8Array } from "./binary.js";
import {
  assertOwnKeys, denseOwnDataArray as boundedOwnDataArray,
  ownDataRecord as boundedOwnDataRecord, snapshotBoundedValue,
} from "./bounded-value.js";
import {
  DEFAULT_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENTS, DEFAULT_MESSAGE_BYTES,
  DEFAULT_TOTAL_ATTACHMENT_BYTES, SUBMIT_SNAPSHOT_MAX_BYTES, SUBMIT_SNAPSHOT_MAX_DEPTH,
  SUBMIT_SNAPSHOT_MAX_ITEMS,
} from "./host-types.js";
import {
  assertBoundedText, denseOwnDataArray, isJsonObject, ownDataRecord, routeText,
} from "./host-values.js";
import type { AgentLiveInput, AgentSubmitInput } from "./types.js";
export function normalizeSubmitInput(input: AgentSubmitInput): AgentSubmitInput {
  input = ownDataRecord(
    input,
    "submission",
    ["requestId", "conversationId", "text", "attachments", "runtime", "model",
      "effort", "maxTurns", "maxOutputTokens", "responseSchema", "interactionHandler",
      "signal", "metadata", "requiredCapabilities", "toolPolicy"],
  ) as unknown as AgentSubmitInput;
  const requestId = routeText(input.requestId ?? randomUUID(), "requestId", 512);
  const conversationId = routeText(input.conversationId, "conversationId", 4_096);
  if (typeof input.text !== "string") throw new TypeError("text must be a string");
  assertBoundedText(input.text, "text", DEFAULT_MESSAGE_BYTES);
  if (input.text.includes("\0")) throw new TypeError("text must not contain NUL");
  if (input.maxTurns !== undefined) boundedSubmitInteger(input.maxTurns, "maxTurns", 1, 10_000);
  if (input.maxOutputTokens !== undefined) boundedSubmitInteger(input.maxOutputTokens, "maxOutputTokens", 1, 100_000_000);
  const durable = snapshotBoundedValue<{
    readonly responseSchema?: unknown; readonly metadata?: unknown;
    readonly requiredCapabilities?: unknown; readonly toolPolicy?: unknown;
  }>({
    ...(input.responseSchema === undefined ? {} : { responseSchema: input.responseSchema }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: input.requiredCapabilities }),
    ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
  }, {
    path: "submission durable fields",
    maxBytes: SUBMIT_SNAPSHOT_MAX_BYTES,
    maxItems: SUBMIT_SNAPSHOT_MAX_ITEMS,
    maxDepth: SUBMIT_SNAPSHOT_MAX_DEPTH,
    label: "submission durable fields",
    cloneBytes: true,
    freeze: true,
    requireOrdinaryArrays: true,
  }).value;
  const responseSchema = durable.responseSchema === undefined
    ? undefined
    : isJsonObject(durable.responseSchema)
      ? durable.responseSchema as NonNullable<AgentSubmitInput["responseSchema"]>
      : (() => { throw new TypeError("responseSchema must contain only JSON values"); })();
  if (responseSchema !== undefined) {
    const encoded = JSON.stringify(responseSchema);
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new RangeError("responseSchema exceeds 65536 bytes");
  }
  const metadata = durable.metadata === undefined
    ? undefined
    : Object.freeze(boundedOwnDataRecord(durable.metadata, "metadata"));
  const requiredCapabilities = durable.requiredCapabilities === undefined ? undefined
    : submitStringList(durable.requiredCapabilities, "requiredCapabilities");
  let toolPolicy: NonNullable<AgentSubmitInput["toolPolicy"]> | undefined;
  if (durable.toolPolicy !== undefined) {
    const policy = ownDataRecord(durable.toolPolicy, "toolPolicy", ["allow", "deny"]);
    toolPolicy = Object.freeze({
      ...(policy.allow === undefined ? {} : { allow: submitStringList(policy.allow, "toolPolicy.allow") }),
      ...(policy.deny === undefined ? {} : { deny: submitStringList(policy.deny, "toolPolicy.deny") }),
    });
  }
  if (input.interactionHandler !== undefined
    && (typeof input.interactionHandler.askUser !== "function"
      || typeof input.interactionHandler.requestApproval !== "function")) {
    throw new TypeError("interactionHandler must implement askUser and requestApproval");
  }
  if (input.signal !== undefined) {
    try {
      AbortSignal.any([input.signal]);
    } catch (error) {
      throw new TypeError("signal must be an AbortSignal", { cause: error });
    }
  }
  const attachments = denseOwnDataArray(input.attachments ?? [], "attachments", DEFAULT_MAX_ATTACHMENTS);
  let totalBytes = 0;
  const normalized = attachments.map((value, index): ChannelAttachment => {
    const attachment = ownDataRecord(value, `attachments.${String(index)}`,
      ["id", "kind", "name", "mediaType", "sizeBytes", "data"]);
    if (
      typeof attachment.id !== "string" || attachment.id.trim().length === 0
      || typeof attachment.name !== "string" || attachment.name.trim().length === 0
      || typeof attachment.mediaType !== "string" || attachment.mediaType.trim().length === 0
      || (attachment.kind !== "image" && attachment.kind !== "audio" && attachment.kind !== "file")
      || typeof attachment.sizeBytes !== "number"
      || !Number.isSafeInteger(attachment.sizeBytes)
      || attachment.sizeBytes < 0
    ) {
      throw new TypeError(`attachments.${index} is not a normalized attachment`);
    }
    assertBoundedText(attachment.id, `attachments.${String(index)}.id`, 512);
    assertBoundedText(attachment.name, `attachments.${String(index)}.name`, 255);
    assertBoundedText(attachment.mediaType, `attachments.${String(index)}.mediaType`, 255);
    if (attachment.id.includes("\0") || attachment.name.includes("\0")
      || attachment.mediaType.includes("\0"))
      throw new TypeError(`attachments.${index} identity must not contain NUL`);
    const data = cloneIntrinsicUint8Array(
      attachment.data,
      `attachments.${String(index)}.data`,
      Math.min(DEFAULT_ATTACHMENT_BYTES, DEFAULT_TOTAL_ATTACHMENT_BYTES - totalBytes),
    );
    if (attachment.sizeBytes !== data.byteLength) throw new TypeError(`attachments.${index} sizeBytes does not match its byte data`);
    totalBytes += data.byteLength;
    if (totalBytes > DEFAULT_TOTAL_ATTACHMENT_BYTES) throw new RangeError(`attachments exceed ${DEFAULT_TOTAL_ATTACHMENT_BYTES} total bytes`);
    return Object.freeze({
      id: attachment.id, kind: attachment.kind, name: attachment.name,
      mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes, data,
    });
  });
  return Object.freeze({
    requestId,
    conversationId,
    text: input.text,
    ...(normalized.length === 0 ? {} : { attachments: Object.freeze(normalized) }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...(responseSchema === undefined ? {} : { responseSchema }),
    ...(input.interactionHandler === undefined ? {} : { interactionHandler: input.interactionHandler }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
  });
}
export function submitStringList(value: unknown, path: string): readonly string[] {
  const entries = denseOwnDataArray(value, path, SUBMIT_SNAPSHOT_MAX_ITEMS);
  for (const [index, entry] of entries.entries()) {
    if (
      typeof entry !== "string"
      || entry.trim().length === 0
      || entry.includes("\0")
    ) {
      throw new TypeError(`${path}.${String(index)} must be a non-empty string`);
    }
    assertBoundedText(entry, `${path}.${String(index)}`, 4_096);
  }
  return value as readonly string[];
}
export function normalizeLiveInput(input: AgentLiveInput): AgentLiveInput {
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new TypeError("live input id must be non-empty");
  }
  assertBoundedText(input.id, "live input id", 512);
  if (typeof input.text !== "string") throw new TypeError("live input text must be a string");
  assertBoundedText(input.text, "live input text", DEFAULT_MESSAGE_BYTES);
  if (
    typeof input.receivedAt !== "string"
    || !Number.isFinite(Date.parse(input.receivedAt))
    || new Date(input.receivedAt).toISOString() !== input.receivedAt
  ) {
    throw new TypeError("live input receivedAt must be a canonical UTC timestamp");
  }
  return Object.freeze({
    id: input.id,
    text: input.text,
    receivedAt: input.receivedAt,
  });
}
export function boundedSubmitInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}
