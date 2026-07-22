import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, bootstrap, thread } from "./test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("./api", () => ({
  api: { thread: vi.fn() },
}));

import { api } from "./api";
import {
  NOTIFICATIONS_STORAGE_KEY,
  NotificationBell,
  NotificationsProvider,
  responseArrivals,
  responseNotificationTitle,
  responsePreview,
} from "./notifications";

const source = agent("agent", { label: "Research agent" });
const running = thread("thread", "agent", {
  title: "Investigation",
  runState: { id: "turn-1", status: "running" },
});
const complete = thread("thread", "agent", {
  title: "Investigation",
  runState: { id: "turn-1", status: "complete" },
});

const createStore = (currentThread = running) => ({
  bootstrap: bootstrap([source], [currentThread]),
  agents: [source],
  threads: [currentThread],
  selectThread: vi.fn(),
});

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> =>
    FakeNotification.permission,
  );
}

const showNotification = vi.fn().mockResolvedValue(undefined);
const getNotifications = vi.fn().mockResolvedValue([]);
const serviceWorker = {
  ready: Promise.resolve({
    getNotifications,
    showNotification,
  }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

describe("response notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showNotification.mockResolvedValue(undefined);
    getNotifications.mockResolvedValue([]);
    FakeNotification.requestPermission.mockImplementation(async () =>
      FakeNotification.permission,
    );
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "isSecureContext");
    Reflect.deleteProperty(navigator, "serviceWorker");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("finds only newly completed successful runs", () => {
    const previous = new Map([[running.id, { id: "turn-1", status: "running" as const }]]);

    expect(responseArrivals(previous, [complete])).toEqual([
      { thread: complete, turnId: "turn-1" },
    ]);
    expect(responseArrivals(
      new Map([[complete.id, { id: "turn-1", status: "complete" as const }]]),
      [complete],
    )).toEqual([]);
    expect(responseArrivals(previous, [{
      ...complete,
      runState: { id: "turn-1", status: "failed" },
    }])).toEqual([]);
    const notification = {
      ...complete,
      id: "notification-one",
      trigger: { kind: "cron" as const },
    };
    expect(responseArrivals(new Map(), [notification])).toEqual([
      { thread: notification, turnId: "turn-1" },
    ]);
  });

  it("builds a bounded preview from response text only", () => {
    expect(responsePreview({
      thread: complete,
      messages: [{
        id: "response",
        threadId: complete.id,
        turnId: "turn-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: `Ready ${"now ".repeat(60)}` },
          { type: "error", message: "not included" },
        ],
        attachments: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        status: "complete",
      }],
    }, "turn-1")).toMatch(/^Ready .*…$/u);
  });

  it("marks cron and webhook arrivals in browser notification titles", () => {
    expect(responseNotificationTitle("Research agent", complete)).toBe("Research agent replied");
    expect(responseNotificationTitle("Research agent", {
      ...complete,
      trigger: { kind: "cron" },
    })).toBe("Research agent · CRON");
    expect(responseNotificationTitle("Research agent", {
      ...complete,
      trigger: { kind: "webhook" },
    })).toBe("Research agent · WEBHOOK");
  });

  it("shows one service-worker notification when a hidden console receives a response", async () => {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    storeMock.current = createStore(running);
    vi.mocked(api.thread).mockResolvedValue({
      thread: complete,
      messages: [{
        id: "response",
        threadId: complete.id,
        turnId: "turn-1",
        role: "assistant",
        parts: [{ type: "text", text: "The investigation is complete." }],
        attachments: [],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
        status: "complete",
      }],
    });
    const notificationTree = () => (
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>
    );
    const view = render(notificationTree());
    expect(screen.getByRole("button", { name: "Disable response notifications" }))
      .toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(serviceWorker.addEventListener).toHaveBeenCalled());

    storeMock.current = createStore(complete);
    view.rerender(notificationTree());

    await waitFor(() => expect(api.thread).toHaveBeenCalledWith("thread"));
    await waitFor(() => expect(showNotification).toHaveBeenCalledWith(
      "Research agent replied",
      expect.objectContaining({
        body: "The investigation is complete.",
        tag: "mono-agent-turn-turn-1",
        data: expect.objectContaining({ threadId: "thread" }),
      }),
    ));
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("does not notify for a response that arrives in the focused console", async () => {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "1");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    storeMock.current = createStore(running);
    const notificationTree = () => (
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>
    );
    const view = render(notificationTree());
    await waitFor(() => expect(serviceWorker.addEventListener).toHaveBeenCalled());

    storeMock.current = createStore(complete);
    view.rerender(notificationTree());

    expect(api.thread).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("requests permission only from the explicit bell action", async () => {
    FakeNotification.permission = "default";
    storeMock.current = createStore();
    render(
      <NotificationsProvider>
        <NotificationBell />
      </NotificationsProvider>,
    );

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });
    fireEvent.click(screen.getByRole("button", { name: "Enable response notifications" }));

    await waitFor(() => expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("1"));
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });
});
