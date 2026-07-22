import type { NotifyDestination } from "@mono-agent/agent-contracts";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { ChannelId, MonoAgentAppLogger } from "./channels.js";
import { channelIdForConversation } from "./proactive-notify.js";
import { listSeenNotifyDestinations } from "./seen-conversations.js";
import type { SeenConversation } from "./seen-conversations.js";

// The destination contract moved to @mono-agent/agent-contracts; keep the
// historical export from this module.
export type { NotifyDestination } from "@mono-agent/agent-contracts";

// Lazy per this module (mirrors channels.ts): the calls below are already
// gated by `opts.isRunning(...)`, so the adapter package only loads when the
// channel is actually up.
type SlackAdapterModule = typeof import("@mono-agent/slack-adapter");
type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");
let slackModule: SlackAdapterModule | undefined;
let telegramModule: TelegramAdapterModule | undefined;
const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/slack-adapter"));
const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));

/** Channels whose conversations can receive a proactive notification turn. */
const NOTIFY_CAPABLE: ReadonlySet<ChannelId> = new Set<ChannelId>(["telegram", "slack"]);

export interface ResolveNotifyDestinationsInput {
  readonly input: MonoAgentAppConfigInput;
  readonly artifactDir: string;
  /** App-lifetime cached sightings; omitted by standalone callers for a direct scan. */
  readonly seenDestinations?: readonly SeenConversation[];
  /** Whether a given channel is currently running (only running channels can deliver). */
  readonly isRunning: (id: ChannelId) => boolean;
  readonly logger?: MonoAgentAppLogger | undefined;
}

/**
 * The conversations a native cron/webhook notification may be delivered to, used by
 * the app to infer a destination when a job/endpoint sets no explicit
 * `notifyConversationId`. Combines two id-free sources so the operator never types a conversationId:
 *  - conversations the agent has actually handled (run-artifact summaries), filtered to
 *    notify-capable + running channels, newest-first;
 *  - the adapter allowlist entries (when not allow-all), surfaced as candidates the agent
 *    can reach even before it has conversed there (covers a fresh single-user agent).
 * WhatsApp is excluded (no notify hook yet) so the agent never picks an undeliverable id.
 */
export async function resolveNotifyDestinations(
  opts: ResolveNotifyDestinationsInput,
): Promise<readonly NotifyDestination[]> {
  const out: NotifyDestination[] = [];
  const present = new Set<string>();

  const seen = opts.seenDestinations ?? await listSeenNotifyDestinations(opts.artifactDir);
  for (const sighting of seen) {
    if (!NOTIFY_CAPABLE.has(sighting.channelId) || !opts.isRunning(sighting.channelId)) {
      continue;
    }
    out.push({
      conversationId: sighting.conversationId,
      channelId: sighting.channelId,
      ...(sighting.lastSeen === undefined ? {} : { lastSeen: sighting.lastSeen }),
    });
    present.add(sighting.conversationId);
  }

  if (opts.isRunning("telegram")) {
    for (const chatId of await telegramAllowlist(opts)) {
      addAllowlisted(out, present, `telegram:${chatId}`, "telegram");
    }
  }
  if (opts.isRunning("slack")) {
    for (const channelId of await slackAllowlist(opts)) {
      addAllowlisted(out, present, `slack:${channelId}`, "slack");
    }
  }

  return out;
}

/** Whether a run artifact can contribute a Telegram/Slack native-notify candidate. */
export function isNotifyDestinationConversationId(conversationId: string | undefined): boolean {
  const channelId = conversationId === undefined ? undefined : channelIdForConversation(conversationId);
  return channelId !== undefined && NOTIFY_CAPABLE.has(channelId);
}

function addAllowlisted(
  out: NotifyDestination[],
  present: Set<string>,
  conversationId: string,
  channelId: ChannelId,
): void {
  if (present.has(conversationId)) {
    return;
  }
  present.add(conversationId);
  out.push({ conversationId, channelId, fromAllowlist: true });
}

/** Allowlisted Telegram chat ids (empty when allow-all, disabled, or unavailable — no enumerable candidate). */
async function telegramAllowlist(opts: ResolveNotifyDestinationsInput): Promise<readonly string[]> {
  try {
    const adapter = await loadTelegramModule();
    const config = await adapter.loadTelegramAdapterConfig({ env: opts.input.env, jsonPath: opts.input.configPath });
    return config.enabled && !config.allowAllChats ? config.allowedChatIds : [];
  } catch (error) {
    opts.logger?.warn?.("notify destinations: telegram allowlist unavailable.", { reason: reasonOf(error) });
    return [];
  }
}

/** Allowlisted Slack channel ids (empty when allow-all, disabled, or unavailable). */
async function slackAllowlist(opts: ResolveNotifyDestinationsInput): Promise<readonly string[]> {
  try {
    const adapter = await loadSlackModule();
    const config = await adapter.loadSlackAdapterConfig({ env: opts.input.env, jsonPath: opts.input.configPath });
    return config.enabled && !config.allowAllChannels ? config.allowedChannelIds : [];
  } catch (error) {
    opts.logger?.warn?.("notify destinations: slack allowlist unavailable.", { reason: reasonOf(error) });
    return [];
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
