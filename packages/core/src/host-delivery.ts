// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { Channel, ChannelDeliveryResult, ChannelOutboundMessage } from "@mono-agent/module-sdk";
import { assertOwnKeys, ownDataRecord } from "./bounded-value.js";
import { errorMessage } from "./errors.js";
import { ConversationTails, durableFingerprint } from "./host-admission.js";
import { settlementSignal } from "./host-lifecycle.js";
import { normalizeOutboundMessage } from "./host-outbound.js";
import type { VerbatimEntry } from "./host-types.js";
import { normalizeModuleDiagnostic } from "./runtime-result-normalizer.js";
import type { CanonicalTranscript, DurableFingerprint, StateExecutionClient } from "./state-execution-client.js";
import type { AgentTranscriptEntry } from "./types.js";

type DeliveryIntent = Awaited<ReturnType<StateExecutionClient["prepareDelivery"]>> | undefined;
export interface ChannelDeliveryOutcome {
  readonly result: ChannelDeliveryResult;
  readonly destinationConversationId?: string;
}
interface DeliveryContext {
  readonly hostSignal: AbortSignal;
  readonly lifecycleTimeoutMs: number;
  readonly channels: ReadonlyMap<string, Channel>;
  readonly transcripts: Map<string, CanonicalTranscript>;
  readonly localHistoryTails: ConversationTails;
  execution(): StateExecutionClient | undefined;
  loadConversation(id: string, signal: AbortSignal): Promise<CanonicalTranscript | undefined>;
  appendLocalVerbatim(id: string, entries: readonly VerbatimEntry[], updatedAt: string): void;
  redact(message: string): string;
}

export class HostDelivery {
  readonly #inflight = new Map<string, {
    readonly fingerprint: DurableFingerprint;
    readonly promise: Promise<ChannelDeliveryOutcome>;
  }>();
  constructor(readonly context: DeliveryContext) {}

  deliver(
    channelId: string, message: ChannelOutboundMessage, signal: AbortSignal,
  ): Promise<ChannelDeliveryOutcome> {
    const channel = this.context.channels.get(channelId);
    const normalized = normalizeOutboundMessage(
      message,
      channel?.resolveDefaultDeliveryConversationId?.bind(channel),
    );
    if (Buffer.byteLength(deliveryHistoryText(normalized), "utf8") > 1_000_000)
      throw new RangeError("channel delivery history text exceeds 1000000 bytes");
    if (channel?.deliver === undefined || channel.resolveDeliveryHistory === undefined) {
      return Promise.resolve(outcome("failed", normalized.idempotencyKey, "channel_delivery_unsupported",
        `Channel ${channelId} does not support proactive delivery`));
    }
    const fingerprint = deliveryFingerprint(channelId, normalized);
    const existing = this.#inflight.get(normalized.idempotencyKey);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.resolve(outcome("failed", normalized.idempotencyKey,
            "channel_delivery_idempotency_conflict",
            "The idempotency key is already active for a different delivery"));
    }
    const running = this.#once(channelId, channel, normalized, fingerprint,
      AbortSignal.any([this.context.hostSignal, signal]));
    const tracked = running.finally(() => {
      if (this.#inflight.get(normalized.idempotencyKey)?.promise === tracked)
        this.#inflight.delete(normalized.idempotencyKey);
    });
    this.#inflight.set(normalized.idempotencyKey, { fingerprint, promise: tracked });
    return tracked;
  }

  async #once(
    channelId: string, channel: Channel, message: ChannelOutboundMessage,
    fingerprint: DurableFingerprint, signal: AbortSignal,
  ): Promise<ChannelDeliveryOutcome> {
    const execution = this.context.execution();
    const intent = execution === undefined ? undefined : await execution.prepareDelivery({
      idempotencyKey: message.idempotencyKey, fingerprint, channelInstanceId: channelId, signal,
    });
    if (intent?.status === "duplicate") {
      return this.#confirm(channelId, channel, message, fingerprint, {
        status: "duplicate", idempotencyKey: message.idempotencyKey,
        ...(intent.messageId === undefined ? {} : { messageId: intent.messageId }),
      }, intent, signal);
    }
    if (intent?.status === "conflict")
      return outcome("failed", message.idempotencyKey, "channel_delivery_idempotency_conflict",
        "The idempotency key was already used for a different delivery");
    if (intent?.status === "join" || intent?.status === "unknown")
      return outcome("unknown", message.idempotencyKey,
        intent.status === "join" ? "channel_delivery_in_progress" : intent.code ?? "channel_delivery_unknown",
        intent.status === "join" ? "A matching delivery is already in progress"
          : "The prior delivery outcome is unknown and will not be replayed");
    if (signal.aborted) {
      await this.#settle(intent, fingerprint, message,
        { status: "failed", code: "channel-delivery-cancelled-before-send" }, true);
      return outcome("failed", message.idempotencyKey, "channel_delivery_cancelled",
        "The channel delivery was cancelled before sending");
    }
    let raw: unknown;
    try { raw = await channel.deliver!(message, signal); }
    catch (error) {
      await this.#settle(intent, fingerprint, message,
        { status: "unknown", code: "channel-delivery-threw" }, true);
      return outcome("unknown", message.idempotencyKey, "channel_delivery_unknown",
        `The channel delivery outcome is unknown: ${this.context.redact(errorMessage(error))}`);
    }
    let result: ChannelDeliveryResult;
    try { result = normalizeResult(raw, message.idempotencyKey); }
    catch (error) {
      const mismatch = error instanceof TypeError
        && error.message === "channel delivery result idempotency key is invalid";
      await this.#settle(intent, fingerprint, message, { status: "unknown",
        code: mismatch ? "channel-delivery-idempotency-mismatch" : "channel-delivery-malformed-result" }, true);
      return outcome("unknown", message.idempotencyKey,
        mismatch ? "channel_delivery_idempotency_mismatch" : "channel_delivery_unknown",
        `The channel delivery outcome is unknown: ${this.context.redact(errorMessage(error))}`);
    }
    if (result.status === "delivered" || result.status === "duplicate")
      return this.#confirm(channelId, channel, message, fingerprint, result, intent, signal);
    if (intent?.status !== "send") return { result };
    try {
      const settled = await this.#settle(intent, fingerprint, message,
        { status: result.status, code: result.diagnostic?.code ?? `channel-delivery-${result.status}` });
      const confirmed = result.status === "failed"
        ? settled?.status === "join" : settled?.status === "unknown";
      if (!confirmed) throw new Error(`delivery settlement returned ${settled?.status ?? "nothing"}`);
    } catch (error) {
      return outcome("unknown", message.idempotencyKey, "channel_delivery_settlement_unknown",
        `The channel response could not be durably settled: ${this.context.redact(errorMessage(error))}`);
    }
    return { result };
  }

  async #confirm(
    channelId: string, channel: Channel, message: ChannelOutboundMessage,
    fingerprint: DurableFingerprint, result: ChannelDeliveryResult,
    intent: DeliveryIntent, signal: AbortSignal,
  ): Promise<ChannelDeliveryOutcome> {
    try {
      const destination = historyDestination(channel.resolveDeliveryHistory!(message, result),
        `${channelId} delivery history resolution`);
      const entry = Object.freeze({
        kind: "verbatim", entryId: `delivery:${createHash("sha256")
          .update(`${channelId}\0${message.idempotencyKey}`).digest("hex")}`,
        runId: message.idempotencyKey, requestId: message.idempotencyKey,
        conversationId: destination, role: "assistant", text: deliveryHistoryText(message),
      } as const);
      const entryFingerprint = durableFingerprint({
        schemaVersion: 1, kind: "mono-agent.delivery-history-fingerprint", channelInstanceId: channelId,
        deliveryFingerprint: fingerprint, messageId: result.messageId ?? null, destination, entry,
      });
      const execution = this.context.execution();
      if (execution === undefined) {
        await this.context.localHistoryTails.run(
          destination, signal, () => this.#appendLocal(destination, entry),
        );
      } else {
        const lifecycleSignal = settlementSignal(this.context.lifecycleTimeoutMs, this.context.hostSignal);
        if (intent?.status === "send") {
          const settled = await execution.retryDeliveryWithHistory({
            idempotencyKey: message.idempotencyKey, fingerprint,
            attempt: intent.attempt, token: intent.token,
            ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
            conversationId: destination, entry, entryFingerprint, signal: lifecycleSignal,
          });
          if (settled.status === "conflict" || settled.conversationId !== destination
            || settled.entryId !== entry.entryId) throw new Error("channel delivery history identity conflict");
        }
        const stored = (await this.context.loadConversation(destination, lifecycleSignal))?.entries
          .find((candidate) => candidate.entryId === entry.entryId);
        if (!sameEntry(stored, entry)) throw new Error("channel delivery history identity conflict");
      }
      return { result, destinationConversationId: destination };
    } catch (error) {
      await this.#settle(intent, fingerprint, message,
        { status: "unknown", code: "channel-delivery-history-unknown" }, true);
      return outcome("unknown", message.idempotencyKey, "channel_delivery_history_unknown",
        `The delivery destination history could not be confirmed: ${this.context.redact(errorMessage(error))}`);
    }
  }

  #appendLocal(destination: string, entry: Omit<VerbatimEntry, "recordedAt">): void {
    const prior = this.context.transcripts.get(destination)?.entries
      .find((candidate) => candidate.entryId === entry.entryId);
    if (prior !== undefined && !sameEntry(prior, entry))
      throw new Error("channel delivery history identity conflict");
    if (prior !== undefined) return;
    const local = { ...entry, recordedAt: new Date().toISOString() };
    this.context.appendLocalVerbatim(destination, [local], local.recordedAt);
  }

  #settle(
    intent: DeliveryIntent, fingerprint: DurableFingerprint, message: ChannelOutboundMessage,
    settlement: Readonly<{ status: "delivered" | "failed" | "unknown"; messageId?: string; code?: string }>,
    bestEffort = false,
  ): Promise<Awaited<ReturnType<StateExecutionClient["settleDelivery"]>> | undefined> {
    if (intent?.status !== "send") return Promise.resolve(undefined);
    const pending = this.context.execution()!.settleDelivery({
      idempotencyKey: message.idempotencyKey, fingerprint,
      attempt: intent.attempt, token: intent.token, ...settlement,
      signal: settlementSignal(this.context.lifecycleTimeoutMs, this.context.hostSignal),
    });
    return bestEffort ? pending.catch(() => undefined) : pending;
  }
}

export function deliveryHistoryText(message: ChannelOutboundMessage): string {
  return [message.text, ...(message.attachments ?? []).map((item) =>
    `[sent attachment: ${item.name}]`)].filter((part) => part.length > 0).join("\n");
}
function deliveryFingerprint(channelId: string, message: ChannelOutboundMessage): DurableFingerprint {
  return durableFingerprint({
    schemaVersion: 1, kind: "mono-agent.delivery-fingerprint", channelInstanceId: channelId,
    conversationId: message.conversationId, text: message.text,
    attachments: (message.attachments ?? []).map((item) => ({
      id: item.id, kind: item.kind, name: item.name, mediaType: item.mediaType, sizeBytes: item.sizeBytes,
      sha256: `sha256:${createHash("sha256").update(item.data).digest("hex")}`,
    })),
    replyToMessageId: message.replyToMessageId ?? null, metadata: message.metadata ?? null,
  });
}
function historyDestination(value: unknown, label: string): string {
  const input = ownDataRecord(value, label);
  assertOwnKeys(input, ["conversationId"], label);
  return boundedText(input.conversationId, `${label} conversationId`, 4_096);
}
function normalizeResult(value: unknown, idempotencyKey: string): ChannelDeliveryResult {
  const label = "channel delivery result";
  const input = ownDataRecord(value, label);
  assertOwnKeys(input, ["status", "idempotencyKey", "messageId", "diagnostic"], label);
  if (!["delivered", "duplicate", "unknown", "failed"].includes(String(input.status)))
    throw new TypeError("channel delivery result status is invalid");
  if (input.idempotencyKey !== idempotencyKey)
    throw new TypeError("channel delivery result idempotency key is invalid");
  if (input.messageId !== undefined) {
    if ((input.status !== "delivered" && input.status !== "duplicate")
      || typeof input.messageId !== "string" || input.messageId.trim().length === 0
      || input.messageId.includes("\0")) throw new TypeError("channel delivery result messageId is invalid");
    boundedText(input.messageId, "channel delivery result messageId", 512);
  }
  return Object.freeze({
    status: input.status, idempotencyKey,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.diagnostic === undefined ? {} : {
      diagnostic: normalizeModuleDiagnostic(input.diagnostic, "channel delivery result diagnostic"),
    }),
  }) as ChannelDeliveryResult;
}
function sameEntry(
  stored: AgentTranscriptEntry | undefined,
  entry: Omit<VerbatimEntry, "recordedAt">,
): boolean {
  return stored !== undefined
    && JSON.stringify({ ...stored, recordedAt: undefined }) === JSON.stringify(entry);
}
function outcome(
  status: "failed" | "unknown", key: string, code: string, message: string,
): ChannelDeliveryOutcome {
  return {
    result: Object.freeze({
      status, idempotencyKey: key,
      diagnostic: Object.freeze({ code, severity: "error", message }),
    }),
  };
}
function boundedText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes)
    throw new TypeError(`${name} must be a bounded non-empty string`);
  return value;
}
