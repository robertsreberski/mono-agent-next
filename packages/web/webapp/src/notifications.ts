// SPDX-License-Identifier: MIT
import type { Bootstrap, Thread } from "./types";

export const NOTIFICATIONS_STORAGE_KEY = "mono-agent-web-notifications-enabled";
export const LEGACY_NOTIFICATIONS_STORAGE_KEY = "mono-agent.web.notifications-enabled";

const ENABLED_STORAGE_VALUE = "1";
const DISABLED_STORAGE_VALUE = "0";

export type NotificationPreference =
  | "unsupported"
  | "prompt"
  | "disabled"
  | "enabled"
  | "denied";

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

export function notificationPreference(): NotificationPreference {
  const optedIn = readPersistedOptIn();
  if (!notificationsSupported()) return "unsupported";
  if (window.Notification.permission === "denied") return "denied";
  if (window.Notification.permission === "default") return "prompt";
  return optedIn ? "enabled" : "disabled";
}

export function notificationsSupported(): boolean {
  return (
    window.isSecureContext === true
    && "Notification" in window
    && typeof window.Notification.requestPermission === "function"
    && "serviceWorker" in navigator
  );
}

export function setNotificationOptIn(enabled: boolean): NotificationPreference {
  writePersistedOptIn(
    enabled && notificationsSupported() && window.Notification.permission === "granted",
  );
  return notificationPreference();
}

export async function toggleNotificationPreference(): Promise<NotificationPreference> {
  const current = notificationPreference();
  if (current === "enabled") return setNotificationOptIn(false);
  if (current === "unsupported" || current === "denied") return current;
  if (window.Notification.permission === "granted") return setNotificationOptIn(true);
  await requestNotificationPermission();
  return notificationPreference();
}

export async function showBackgroundNotification(payload: NotificationPayload): Promise<void> {
  if (
    notificationPreference() !== "enabled"
    || (!document.hidden && document.hasFocus())
  ) {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage({ type: "mono-agent:notify", ...payload });
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (window.Notification.permission === "granted") {
    writePersistedOptIn(true);
    return "granted";
  }
  if (window.Notification.permission === "denied") {
    writePersistedOptIn(false);
    return "denied";
  }
  try {
    const permission = await window.Notification.requestPermission();
    writePersistedOptIn(permission === "granted");
    return permission;
  } catch {
    return window.Notification.permission;
  }
}

function readPersistedOptIn(): boolean {
  try {
    const current = window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    const legacy = window.localStorage.getItem(LEGACY_NOTIFICATIONS_STORAGE_KEY);
    if (current === ENABLED_STORAGE_VALUE || current === DISABLED_STORAGE_VALUE) {
      if (legacy !== null) {
        try {
          window.localStorage.removeItem(LEGACY_NOTIFICATIONS_STORAGE_KEY);
        } catch {
          // The canonical preference is already durable, so cleanup can retry later.
        }
      }
      return current === ENABLED_STORAGE_VALUE;
    }
    if (legacy !== null) {
      const enabled = legacy === ENABLED_STORAGE_VALUE;
      try {
        window.localStorage.setItem(
          NOTIFICATIONS_STORAGE_KEY,
          enabled ? ENABLED_STORAGE_VALUE : DISABLED_STORAGE_VALUE,
        );
      } catch {
        // Preserve and honor the legacy preference when canonical persistence fails.
        return enabled;
      }
      try {
        window.localStorage.removeItem(LEGACY_NOTIFICATIONS_STORAGE_KEY);
      } catch {
        // The canonical preference is durable; legacy cleanup can retry later.
      }
      return enabled;
    }
  } catch {
    // Treat unavailable browser storage as an explicit opt-out.
  }
  return false;
}

function writePersistedOptIn(enabled: boolean): void {
  try {
    window.localStorage.setItem(
      NOTIFICATIONS_STORAGE_KEY,
      enabled ? ENABLED_STORAGE_VALUE : DISABLED_STORAGE_VALUE,
    );
    window.localStorage.removeItem(LEGACY_NOTIFICATIONS_STORAGE_KEY);
  } catch {
    // A browser that cannot persist the opt-in remains disabled.
  }
}
