// SPDX-License-Identifier: MIT
import type { Bootstrap, Thread } from "./types";

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
}

export function responseNotifications(
  previous: readonly Thread[],
  next: Bootstrap,
): readonly NotificationPayload[] {
  const before = new Map(previous.map((thread) => [thread.id, thread]));
  const agentLabels = new Map(next.agents.map((agent) => [agent.id, agent.label]));
  const payloads: NotificationPayload[] = [];
  for (const threadId of next.newProactiveThreadIds) {
    const thread = next.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) continue;
    const trigger = thread.trigger?.kind === "cron"
      ? "Scheduled update"
      : thread.trigger?.kind === "webhook"
        ? "Webhook update"
        : "Proactive update";
    payloads.push({
      title: `${trigger} · ${agentLabels.get(thread.agentId) ?? "mono-agent"}`,
      body: thread.title,
      tag: `mono-agent-proactive:${thread.id}`,
      url: `/?thread=${encodeURIComponent(thread.id)}`,
    });
  }
  for (const thread of next.threads) {
    const prior = before.get(thread.id);
    if (
      prior?.status !== "running"
      || thread.status !== "complete"
      || thread.lastTurnId === undefined
      || prior.lastTurnId !== thread.lastTurnId
    ) {
      continue;
    }
    payloads.push({
      title: `${agentLabels.get(thread.agentId) ?? "mono-agent"} replied`,
      body: thread.title,
      tag: `mono-agent-turn:${thread.lastTurnId}`,
      url: `/?thread=${encodeURIComponent(thread.id)}`,
    });
  }
  return payloads;
}

export async function showBackgroundNotification(payload: NotificationPayload): Promise<void> {
  if (
    !("Notification" in window)
    || Notification.permission !== "granted"
    || (!document.hidden && document.hasFocus())
    || !("serviceWorker" in navigator)
  ) {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage({ type: "mono-agent:notify", ...payload });
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  return Notification.requestPermission();
}
