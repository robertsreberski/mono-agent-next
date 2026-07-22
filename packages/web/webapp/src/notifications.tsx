import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./components/Icon";
import { useConsoleStore } from "./console-store";
import type { ThreadDetail, ThreadSummary } from "./types";

export const NOTIFICATIONS_STORAGE_KEY = "mono-agent.web.notifications-enabled";
const NOTIFICATION_MESSAGE_TYPE = "mono-agent:select-thread";

export type NotificationPreference =
  | "unsupported"
  | "prompt"
  | "disabled"
  | "enabled"
  | "denied";

interface RunSnapshot {
  readonly id?: string;
  readonly status: ThreadSummary["runState"]["status"];
}

export interface ResponseArrival {
  readonly thread: ThreadSummary;
  readonly turnId: string;
}

const runSnapshots = (threads: readonly ThreadSummary[]): ReadonlyMap<string, RunSnapshot> =>
  new Map(threads.map((thread) => [thread.id, {
    ...(thread.runState.id === undefined ? {} : { id: thread.runState.id }),
    status: thread.runState.status,
  }]));

export const responseArrivals = (
  previous: ReadonlyMap<string, RunSnapshot>,
  threads: readonly ThreadSummary[],
): readonly ResponseArrival[] => threads.flatMap((thread) => {
  const turnId = thread.runState.id;
  if (!turnId || thread.runState.status !== "complete") return [];
  const prior = previous.get(thread.id);
  return prior?.id === turnId && prior.status === "complete"
    ? []
    : [{ thread, turnId }];
});

export const responsePreview = (detail: ThreadDetail, turnId: string): string | undefined => {
  const message = [...detail.messages].reverse().find(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.role === "assistant" &&
      candidate.status === "complete",
  );
  const text = message?.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return undefined;
  return text.length <= 180 ? text : `${text.slice(0, 179).trimEnd()}…`;
};

export const responseNotificationTitle = (agentLabel: string, thread: ThreadSummary): string =>
  thread.trigger === undefined
    ? `${agentLabel} replied`
    : `${agentLabel} · ${thread.trigger.kind.toUpperCase()}`;

const supported = (): boolean =>
  window.isSecureContext === true &&
  typeof Notification !== "undefined" &&
  "serviceWorker" in navigator;

const preference = (): NotificationPreference => {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "prompt";
  return localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "1" ? "enabled" : "disabled";
};

const dispatchNotice = (message: string): void => {
  window.dispatchEvent(new CustomEvent("mono-agent:notice", { detail: { message } }));
};

interface NotificationsValue {
  readonly preference: NotificationPreference;
  readonly toggle: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { readonly children: ReactNode }) {
  const store = useConsoleStore();
  const [currentPreference, setCurrentPreference] = useState<NotificationPreference>(preference);
  const previousRuns = useRef<ReadonlyMap<string, RunSnapshot> | null>(null);
  const notifiedTurns = useRef(new Set<string>());
  const handledDeepLink = useRef<string | null>(null);
  const pendingThreadSelection = useRef<string | null>(null);

  const toggle = useCallback(async () => {
    if (!supported()) {
      dispatchNotice("Response notifications require a secure browser context.");
      setCurrentPreference("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setCurrentPreference("denied");
      dispatchNotice("Notifications are blocked in this browser's site settings.");
      return;
    }
    if (currentPreference === "enabled") {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setCurrentPreference("disabled");
      return;
    }
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
      setCurrentPreference("enabled");
    } else {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      setCurrentPreference(permission === "denied" ? "denied" : "prompt");
      if (permission === "denied") {
        dispatchNotice("Notifications are blocked in this browser's site settings.");
      }
    }
  }, [currentPreference]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as { type?: unknown; threadId?: unknown };
      if (payload.type !== NOTIFICATION_MESSAGE_TYPE || typeof payload.threadId !== "string") return;
      pendingThreadSelection.current = payload.threadId;
      if (store.threads.some((thread) => thread.id === payload.threadId)) {
        store.selectThread(payload.threadId);
        pendingThreadSelection.current = null;
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [store]);

  useEffect(() => {
    const threadId = pendingThreadSelection.current;
    if (!threadId || !store.threads.some((thread) => thread.id === threadId)) return;
    store.selectThread(threadId);
    pendingThreadSelection.current = null;
  }, [store]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const threadId = url.searchParams.get("thread");
    if (!threadId || handledDeepLink.current === threadId) return;
    if (!store.threads.some((thread) => thread.id === threadId)) return;
    handledDeepLink.current = threadId;
    store.selectThread(threadId);
    url.searchParams.delete("thread");
    window.history.replaceState(window.history.state, "", url);
  }, [store]);

  useEffect(() => {
    if (!store.bootstrap) return;
    const nextRuns = runSnapshots(store.bootstrap.threads);
    const previous = previousRuns.current;
    previousRuns.current = nextRuns;
    if (previous === null) return;

    for (const arrival of responseArrivals(previous, store.bootstrap.threads)) {
      if (notifiedTurns.current.has(arrival.turnId)) continue;
      notifiedTurns.current.add(arrival.turnId);
      if (
        currentPreference !== "enabled" ||
        Notification.permission !== "granted" ||
        (document.visibilityState === "visible" && document.hasFocus())
      ) continue;

      const agent = store.agents.find((candidate) => candidate.sourceId === arrival.thread.sourceId);
      void (async () => {
        try {
          const detail = await api.thread(arrival.thread.id);
          const registration = await navigator.serviceWorker.ready;
          const tag = `mono-agent-turn-${arrival.turnId}`;
          if ((await registration.getNotifications({ tag })).length > 0) return;
          const target = new URL(window.location.href);
          target.searchParams.set("thread", arrival.thread.id);
          await registration.showNotification(
            responseNotificationTitle(agent?.label ?? "mono-agent", arrival.thread),
            {
              body: responsePreview(detail, arrival.turnId) ?? `Response ready in ${arrival.thread.title}.`,
              tag,
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              data: { threadId: arrival.thread.id, url: target.href },
            },
          );
        } catch {
          dispatchNotice("The response arrived, but its notification could not be shown.");
        }
      })();
    }
  }, [currentPreference, store]);

  return (
    <NotificationsContext.Provider value={{ preference: currentPreference, toggle }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function NotificationBell() {
  const notifications = useContext(NotificationsContext);
  if (!notifications) {
    throw new Error("NotificationBell must be used inside NotificationsProvider.");
  }
  const enabled = notifications.preference === "enabled";
  const unavailable = notifications.preference === "unsupported";
  const blocked = notifications.preference === "denied";
  const label = enabled
    ? "Disable response notifications"
    : blocked
      ? "Response notifications blocked"
      : unavailable
        ? "Response notifications unavailable"
        : "Enable response notifications";
  return (
    <button
      type="button"
      className={`icon-button header-notifications${enabled ? " is-enabled" : ""}`}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      disabled={unavailable}
      onClick={() => void notifications.toggle()}
    >
      <Icon name={blocked ? "bell-off" : "bell"} size={17} />
    </button>
  );
}
