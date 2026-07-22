import type { NotifyDeliveryResult } from "@mono-agent/agent-contracts";

import type { ChannelId, MonoAgentAppLogger, RunningChannel } from "./channels.js";

// The delivery-result contract moved to @mono-agent/agent-contracts; keep the
// historical export from this module.
export type { NotifyDeliveryResult } from "@mono-agent/agent-contracts";

/**
 * Push-shaped conversation schemes known to the app. The running channel's
 * optional `notify` hook remains the authoritative delivery capability, so a
 * recognized plugin destination can still fail closed as unsupported. This is
 * intentionally wider than the webhook callback list: WhatsApp is recognized
 * here, but its plugin driver does not expose a native notify hook yet.
 * cron/webhook/openai-api/a2a are request-driven, not push destinations.
 */
const PUSH_CHANNEL_BY_SCHEME: Partial<Record<string, ChannelId>> = {
  telegram: "telegram",
  slack: "slack",
  whatsapp: "whatsapp",
};

/** The push channel that owns a destination conversationId (requires a `<scheme>:<target>` form), or undefined. */
export function channelIdForConversation(conversationId: string): ChannelId | undefined {
  const colon = conversationId.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return PUSH_CHANNEL_BY_SCHEME[conversationId.slice(0, colon)];
}

export interface ProactiveNotifyInput {
  /** Destination conversationId, e.g. `telegram:42` or `slack:C1:171.5`. */
  readonly conversationId: string;
  /** The message to deliver. With `verbatim`, posted as-is; otherwise run as a turn. */
  readonly text: string;
  /**
   * Deliver `text` VERBATIM — post it to the destination unchanged with no model
   * call, then record it to the conversation's history (native cron/webhook
   * notification). Without it, `text` is a prompt run as a turn on the
   * destination's harness (e.g. a Slack interactive trigger).
   */
  readonly verbatim?: boolean;
  /** Stable host delivery identity for adapters with duplicate suppression. */
  readonly deliveryKey?: string;
  /** Currently running channels, keyed by id (the app's live registry). */
  readonly running: ReadonlyMap<ChannelId, Pick<RunningChannel, "notify">>;
  readonly logger?: MonoAgentAppLogger;
}

/**
 * Route a proactive notification to the channel that owns its destination
 * conversation, so the message runs as a real turn on that channel's own harness
 * (shared session/history) and is delivered through its normal stream. The owning
 * channel's `notify` hook enforces its adapter allowlist before delivering, so a
 * non-allowlisted (e.g. payload-supplied) destination is rejected here. Returns a
 * structured {@link NotifyDeliveryResult}; never throws (the trigger run already
 * succeeded), so the caller can report the outcome to the model.
 */
export async function routeProactiveNotification(input: ProactiveNotifyInput): Promise<NotifyDeliveryResult> {
  const channelId = channelIdForConversation(input.conversationId);
  if (channelId === undefined) {
    input.logger?.warn?.("Proactive notification skipped: unrecognized destination.", {
      conversationId: input.conversationId,
    });
    return { delivered: false, reason: "unrecognized destination conversationId" };
  }
  const channel = input.running.get(channelId);
  if (channel?.notify === undefined) {
    input.logger?.warn?.(
      "Proactive notification skipped: destination channel is not running or does not support delivery.",
      { conversationId: input.conversationId, channelId },
    );
    return { delivered: false, reason: `${channelId} channel is not running or does not support proactive delivery` };
  }
  try {
    return await channel.notify({
      conversationId: input.conversationId,
      text: input.text,
      ...(input.verbatim === undefined ? {} : { verbatim: input.verbatim }),
      ...(input.deliveryKey === undefined ? {} : { deliveryKey: input.deliveryKey }),
    });
  } catch (error) {
    const reason = reasonOf(error);
    input.logger?.warn?.("Proactive notification failed: destination channel notify threw.", {
      conversationId: input.conversationId,
      channelId,
      reason,
    });
    return { delivered: false, reason };
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
