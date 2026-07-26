// SPDX-License-Identifier: MIT
import type { SlackApiClient } from "./client.js";
import type { SlackConfig, SlackHomeButtonConfig } from "./config.js";
import { MAX_SLACK_STATUS_TEXT_LENGTH } from "./limits.js";
import type { SlackMessageEvent } from "./socket.js";

const MAX_ACTIVITY_CONVERSATIONS = 100;
const MAX_ACTIVITY_ENTRIES = 32;

export type SlackActivityFailure = (
  operation: "assistant-status" | "reaction",
) => void;

export async function indicateActivity(
  client: SlackApiClient,
  unavailable: Set<string>,
  reacted: Set<string>,
  conversationId: string,
  event: SlackMessageEvent,
  status: string,
  signal: AbortSignal,
  failed?: SlackActivityFailure,
): Promise<void> {
  if (!unavailable.has(conversationId) && client.setAssistantStatus !== undefined) {
    try {
      await client.setAssistantStatus(event.channelId, event.threadId, status, signal);
      return;
    } catch {
      failed?.("assistant-status");
      unavailable.add(conversationId);
      while (unavailable.size > MAX_ACTIVITY_CONVERSATIONS) {
        const oldest = unavailable.values().next().value as string | undefined;
        if (oldest === undefined) break;
        unavailable.delete(oldest);
      }
    }
  }
  if (!reacted.has(conversationId) && client.addReaction !== undefined) {
    reacted.add(conversationId);
    try {
      await client.addReaction(event.channelId, event.messageId, "eyes", signal);
    } catch {
      failed?.("reaction");
    }
  }
}

export function rememberActivity(
  ledger: Map<string, string[]>,
  conversationId: string,
  text: string,
): void {
  let entries = ledger.get(conversationId);
  if (entries === undefined) {
    entries = [];
    ledger.set(conversationId, entries);
  }
  entries.push(text.slice(0, 1_024));
  if (entries.length > MAX_ACTIVITY_ENTRIES) {
    entries.splice(0, entries.length - MAX_ACTIVITY_ENTRIES);
  }
  while (ledger.size > MAX_ACTIVITY_CONVERSATIONS) {
    const oldest = ledger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

export function statusText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return (normalized.length === 0 ? "is working…" : normalized)
    .slice(0, MAX_SLACK_STATUS_TEXT_LENGTH);
}

export function homeView(config: SlackConfig): {
  readonly type: "home";
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
} {
  const blocks: Readonly<Record<string, unknown>>[] = [];
  if (config.homeTab.headerText !== undefined) {
    blocks.push(Object.freeze({
      type: "section",
      text: Object.freeze({ type: "mrkdwn", text: config.homeTab.headerText }),
    }));
  }
  for (let offset = 0; offset < config.homeTab.buttons.length; offset += 5) {
    const buttons: readonly SlackHomeButtonConfig[] = config.homeTab.buttons.slice(
      offset,
      offset + 5,
    );
    blocks.push(Object.freeze({
      type: "actions",
      elements: Object.freeze(buttons.map((button) => Object.freeze({
        type: "button",
        action_id: button.actionId,
        text: Object.freeze({
          type: "plain_text",
          text: button.label,
          emoji: false,
        }),
      }))),
    }));
  }
  return Object.freeze({ type: "home", blocks: Object.freeze(blocks) });
}
