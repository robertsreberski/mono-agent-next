// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOTIFICATIONS_STORAGE_KEY,
  type NotificationPreference,
} from "../notifications";
import { NotificationBell } from "./NotificationBell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> =>
    FakeNotification.permission,
  );
}

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: memoryStorage(),
});

let root: Root | undefined;

describe("NotificationBell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    FakeNotification.permission = "default";
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
      value: { ready: Promise.resolve({ active: null }) },
    });
  });

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    document.body.textContent = "";
    window.localStorage.clear();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "Notification");
    Reflect.deleteProperty(window, "isSecureContext");
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("requests permission only when clicked, then toggles the persisted opt-in", async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });
    const changes: NotificationPreference[] = [];
    const button = await renderBell({
      onPreferenceChange: (preference) => changes.push(preference),
    });

    expect(button.getAttribute("aria-label")).toBe("Enable notifications");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.dataset.notificationPreference).toBe("prompt");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    await act(async () => button.click());

    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("1");
    expect(button.getAttribute("aria-label")).toBe("Disable notifications");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.dataset.notificationPreference).toBe("enabled");

    await act(async () => button.click());

    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("0");
    expect(button.getAttribute("aria-label")).toBe("Enable notifications");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.dataset.notificationPreference).toBe("disabled");
    expect(changes).toEqual(["enabled", "disabled"]);
  });

  it("exposes denied and unsupported states without another permission request", async () => {
    FakeNotification.permission = "denied";
    const notice = vi.fn();
    window.addEventListener("mono-agent:notice", notice);
    const denied = await renderBell();

    expect(denied.disabled).toBe(false);
    expect(denied.getAttribute("aria-label")).toBe(
      "Notifications blocked in browser settings",
    );
    expect(denied.dataset.notificationPreference).toBe("denied");
    await act(async () => denied.click());
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();
    expect((notice.mock.calls[0]?.[0] as CustomEvent).detail.message).toContain(
      "browser’s site settings",
    );
    window.removeEventListener("mono-agent:notice", notice);

    await act(async () => root?.unmount());
    root = undefined;
    document.body.textContent = "";
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const unsupported = await renderBell();

    expect(unsupported.disabled).toBe(true);
    expect(unsupported.getAttribute("aria-label")).toBe("Notifications unavailable");
    expect(unsupported.dataset.notificationPreference).toBe("unsupported");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});

async function renderBell(
  props: {
    readonly onPreferenceChange?: (preference: NotificationPreference) => void;
  } = {},
): Promise<HTMLButtonElement> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<NotificationBell {...props} />));
  const button = host.querySelector("button");
  if (button === null) throw new Error("Notification bell did not render.");
  return button;
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
