// SPDX-License-Identifier: MIT
import type { ChannelDeliveryResult, ChannelOutboundMessage } from "@mono-agent/module-sdk";
import type { TriggerEvent, TriggerReceipt } from "@mono-agent/module-sdk/internal";
import { AgentAdmissionError, RunExecutionError, errorMessage } from "./errors.js";
import { deliveryTriggerKind } from "./host-outbound.js";
import { normalizeSubmitInput } from "./host-submit-input.js";
import type { AgentResponse, AgentSubmitInput } from "./types.js";

const MAX_TRIGGER_CLAIMS = 10_000;
const PROACTIVE_SUPPRESSION_SENTINEL = "NOTHING_TO_REPORT";

interface TriggerContext {
  readonly hostSignal: AbortSignal;
  submitRequest(
    input: AgentSubmitInput,
    emit: () => Promise<void>,
    emitAsk: undefined,
    emitApproval: undefined,
    observeAdmission: (replayed: boolean) => void,
  ): Promise<AgentResponse>;
  deliver(channelInstanceId: string, message: ChannelOutboundMessage): Promise<ChannelDeliveryResult>;
  redact(message: string): string;
  recordFailure(message: string): void;
}

/**
 * Owns proactive trigger execution and the at-most-once claim ledger.
 *
 * Unknown outcomes are retained so a replayed event cannot execute twice.
 * Retention is bounded: past the cap the oldest claim is dropped, which degrades
 * that one event to at-least-once rather than growing the ledger without limit.
 */
export class HostTriggers {
  readonly #claims = new Map<string, "pending" | "delivery_unknown" | "execution_unknown">();
  constructor(private readonly context: TriggerContext) {}

  clear(): void {
    this.#claims.clear();
  }
  async emit(event: TriggerEvent, signal: AbortSignal): Promise<TriggerReceipt> {
    const combined = AbortSignal.any([this.context.hostSignal, signal]);
    const claimed = this.#claims.get(event.id);
    if (claimed !== undefined) return {
      status: "unknown", code: claimed === "pending" ? "execution_unknown" : claimed,
      reason: this.context.redact("The prior trigger outcome is unknown"),
    };
    this.#claim(event.id, "pending");
    const conversationId = `trigger:${event.triggerInstanceId}:${event.id}`;
    let delivery: ChannelDeliveryResult | undefined;
    let replayed = false;
    try {
      const response = await this.context.submitRequest(normalizeSubmitInput({
        requestId: event.id,
        conversationId,
        text: event.prompt,
        ...(event.runtime === undefined ? {} : { runtime: event.runtime }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(typeof event.metadata?.effort === "string" ? { effort: event.metadata.effort } : {}),
        signal: combined,
        metadata: {
          triggerId: event.id,
          triggerInstanceId: event.triggerInstanceId,
          ...(event.metadata ?? {}),
        },
      }), async () => {}, undefined, undefined, (value) => { replayed = value; });
      if (response.status !== "completed") {
        throw new Error(`Trigger turn ended with ${response.status}`);
      }
      if (replayed && event.deliveryChannel === undefined) {
        this.#claims.delete(event.id);
        return { status: "rejected", code: "duplicate", reason: "duplicate trigger event" };
      }
      if (response.text === PROACTIVE_SUPPRESSION_SENTINEL) {
        this.#claims.delete(event.id);
        return replayed
          ? { status: "rejected", code: "duplicate", reason: "duplicate trigger event" }
          : { status: "accepted", runId: response.runId };
      }
      if (event.deliveryChannel !== undefined) {
        const destination = typeof event.metadata?.destination === "string"
          ? event.metadata.destination
          : conversationId;
        delivery = await this.context.deliver(event.deliveryChannel, {
          conversationId: destination,
          text: response.text,
          idempotencyKey: event.id,
          metadata: {
            triggerId: event.id,
            sourceConversationId: conversationId,
            ...deliveryTriggerKind(event.metadata),
          },
        });
        if (delivery.status !== "delivered" && delivery.status !== "duplicate") {
          throw new Error(`Trigger delivery ended with ${delivery.status}`);
        }
        if (replayed && delivery.status === "duplicate") {
          this.#claims.delete(event.id);
          return { status: "rejected", code: "duplicate", reason: "duplicate trigger event" };
        }
      }
      this.#claims.delete(event.id);
      return { status: "accepted", runId: response.runId };
    } catch (error) {
      if (error instanceof AgentAdmissionError && error.code === "request_in_progress") {
        this.#claim(event.id, "execution_unknown");
        return { status: "unknown", code: "execution_unknown", reason: this.context.redact(errorMessage(error)) };
      }
      if (error instanceof AgentAdmissionError && error.code === "request_conflict") {
        this.#claims.delete(event.id);
        return { status: "rejected", code: "execution_failed", reason: this.context.redact(errorMessage(error)) };
      }
      const deliveryUnknown = delivery?.status === "unknown";
      const executionUnknown = error instanceof RunExecutionError && error.status === "uncertain"
        || error instanceof AgentAdmissionError
          && (error.code === "uncertain_admission" || error.code === "stale_admission");
      if (deliveryUnknown) {
        this.#claim(event.id, "delivery_unknown");
        return { status: "unknown", code: "delivery_unknown", reason: this.context.redact(errorMessage(error)) };
      }
      if (executionUnknown) {
        this.#claim(event.id, "execution_unknown");
        return { status: "unknown", code: "execution_unknown", reason: this.context.redact(errorMessage(error)) };
      }
      this.#claims.delete(event.id);
      return { status: "rejected", code: "execution_failed", reason: this.context.redact(errorMessage(error)) };
    }
  }
  #claim(id: string, state: "pending" | "delivery_unknown" | "execution_unknown"): void {
    this.#claims.delete(id);
    this.#claims.set(id, state);
    while (this.#claims.size > MAX_TRIGGER_CLAIMS) {
      const oldest = this.#claims.keys().next();
      if (oldest.done === true) break;
      this.#claims.delete(oldest.value);
      this.context.recordFailure("trigger claim ledger is full; the oldest claim was dropped");
    }
  }
}
