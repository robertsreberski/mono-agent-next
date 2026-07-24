// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_NOTIFICATIONS_STORAGE_KEY,
  NOTIFICATIONS_STORAGE_KEY,
  notificationPreference,
  requestNotificationPermission,
  responseNotifications,
  setNotificationOptIn,
  showBackgroundNotification,
} from "./notifications";
import type { Bootstrap, Thread } from "./types";

const timestamp = "2026-01-01T00:00:00.000Z";
const postMessage = vi.fn();
const serviceWorker = {
  ready: Promise.resolve({
    active: { postMessage },
  }),
};

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> =>
    FakeNotification.permission,
  );
}

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: memoryStorage(),
});

describe("web response notifications", () => {
  beforeEach(() => {
    window.localStorage.clear();
    postMessage.mockClear();
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission.mockClear();
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "Notification");
    Reflect.deleteProperty(window, "isSecureContext");
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(document, "hidden");
  });

  it("deduplicates completed turns by lastTurnId and identifies proactive trigger kinds", () => {
    const running = thread({
      id: "thread-response",
      status: "running",
      lastTurnId: "turn-7",
    });
    const next: Bootstrap = {
      version: 1,
      revision: 9,
      agents: [{
        id: "personal",
        label: "Personal Agent",
        endpoint: "http://127.0.0.1:1",
        online: true,
        pinned: false,
        capabilities: {},
      }],
      threads: [
        { ...running, status: "complete" },
        thread({
          id: "thread-proactive",
          proactive: true,
          trigger: { kind: "cron" },
          status: "complete",
          lastTurnId: "proactive:thread-proactive",
          title: "Morning summary",
        }),
      ],
      newProactiveThreadIds: ["thread-proactive"],
    };
    expect(responseNotifications([running], next)).toEqual([
      {
        title: "Scheduled update · Personal Agent",
        body: "Morning summary",
        tag: "mono-agent-proactive:thread-proactive",
        url: "/?thread=thread-proactive",
      },
      {
        title: "Personal Agent replied",
        body: "Conversation",
        tag: "mono-agent-turn:turn-7",
        url: "/?thread=thread-response",
      },
    ]);
    expect(responseNotifications(next.threads, {
      ...next,
      newProactiveThreadIds: [],
      revision: 10,
    })).toEqual([]);
  });

  it("migrates the legacy opt-in once to the canonical preference key", () => {
    window.localStorage.setItem(LEGACY_NOTIFICATIONS_STORAGE_KEY, "1");

    expect(notificationPreference()).toBe("enabled");
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("1");
    expect(window.localStorage.getItem(LEGACY_NOTIFICATIONS_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(LEGACY_NOTIFICATIONS_STORAGE_KEY, "1");
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "0");
    expect(notificationPreference()).toBe("disabled");
    expect(window.localStorage.getItem(LEGACY_NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  });

  it("keeps honoring the legacy opt-in when canonical persistence fails", () => {
    window.localStorage.setItem(LEGACY_NOTIFICATIONS_STORAGE_KEY, "1");
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("storage full");
    });

    expect(notificationPreference()).toBe("enabled");
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_NOTIFICATIONS_STORAGE_KEY)).toBe("1");

    setItem.mockRestore();
    expect(notificationPreference()).toBe("enabled");
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("1");
    expect(window.localStorage.getItem(LEGACY_NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  });

  it("reports prompt, denied, and unsupported browser states without requesting permission", () => {
    FakeNotification.permission = "default";
    expect(notificationPreference()).toBe("prompt");

    FakeNotification.permission = "denied";
    expect(notificationPreference()).toBe("denied");

    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    expect(notificationPreference()).toBe("unsupported");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("persists permission only after an explicit request", async () => {
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });

    expect(notificationPreference()).toBe("prompt");
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();

    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("1");
    expect(notificationPreference()).toBe("enabled");
  });

  it("delivers through the service worker only when explicitly enabled in the background", async () => {
    const payload = {
      title: "Personal Agent replied",
      body: "Conversation",
      tag: "mono-agent-turn:turn-7",
      url: "/?thread=thread-response",
    };

    await showBackgroundNotification(payload);
    expect(postMessage).not.toHaveBeenCalled();

    expect(setNotificationOptIn(true)).toBe("enabled");
    await showBackgroundNotification(payload);
    expect(postMessage).toHaveBeenCalledWith({
      type: "mono-agent:notify",
      ...payload,
    });

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await showBackgroundNotification({ ...payload, tag: "foreground" });
    expect(postMessage).toHaveBeenCalledTimes(1);

    expect(setNotificationOptIn(false)).toBe("disabled");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    await showBackgroundNotification({ ...payload, tag: "disabled" });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread",
    agentId: "personal",
    title: "Conversation",
    titleManual: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
