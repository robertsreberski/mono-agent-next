// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ConsoleProvider } from "./console";
import { WebRuntimeProvider } from "./runtime";

const apiMocks = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => ({
    version: 1 as const,
    revision: 1,
    agents: [
      {
        id: "agent-1",
        label: "Personal Agent",
        endpoint: "http://127.0.0.1:4110",
        online: true,
        pinned: true,
        capabilities: {},
      },
    ],
    threads: [],
    newProactiveThreadIds: [],
  })),
  thread: vi.fn(),
  subscribeEvents: vi.fn(
    async (
      _revision: number | undefined,
      _onEvent: (event: unknown) => void,
      signal: AbortSignal,
    ) => await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    readToken: () => "authenticated-test-token",
    saveToken: vi.fn(),
    subscribeEvents: apiMocks.subscribeEvents,
    api: {
      ...actual.api,
      probeBootstrap: async () => {
        throw new actual.ApiError("Unauthorized.", 401, "unauthorized");
      },
      bootstrap: apiMocks.bootstrap,
      thread: apiMocks.thread,
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(window, "matchMedia");
  vi.clearAllMocks();
});

describe("responsive console shell", () => {
  it("starts with a collapsed rail and restores focus after closing mobile navigation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ConsoleProvider>
          <WebRuntimeProvider>
            <App />
          </WebRuntimeProvider>
        </ConsoleProvider>,
      );
    });
    await waitFor(() => host.querySelector(".console-shell"));

    expect(host.querySelector(".console-shell")?.classList.contains("rail-collapsed")).toBe(true);
    expect(
      requiredElement<HTMLButtonElement>(host, 'button[aria-label="Expand agent rail"]')
        .getAttribute("aria-expanded"),
    ).toBe("false");
    const mobileNavigation = requiredElement<HTMLElement>(host, ".mobile-navigation");
    const chat = requiredElement<HTMLElement>(host, ".chat");
    expect(
      mobileNavigation.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    const chooseAgent = requiredElement<HTMLButtonElement>(
      host,
      '.mobile-navigation button[aria-label="Choose agent"]',
    );
    await act(async () => {
      chooseAgent.focus();
      chooseAgent.click();
    });
    await waitFor(() => host.querySelector<HTMLElement>('[role="dialog"][aria-label="Choose agent"]'));

    const drawer = requiredElement<HTMLElement>(
      host,
      '[role="dialog"][aria-label="Choose agent"]',
    );
    await waitFor(() => drawer.contains(document.activeElement));
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(chat.hasAttribute("inert")).toBe(true);
    expect(chat.getAttribute("aria-hidden")).toBe("true");
    expect(mobileNavigation.hasAttribute("inert")).toBe(true);
    expect(document.body.hasAttribute("data-console-modal-open")).toBe(true);
    expect(host.querySelector(".drawer-scrim")?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(host.querySelector('[role="dialog"][aria-label="Choose agent"]')).toBeNull();
    expect(document.activeElement).toBe(chooseAgent);
    expect(chat.hasAttribute("inert")).toBe(false);
    expect(document.body.hasAttribute("data-console-modal-open")).toBe(false);

    await act(async () => root.unmount());
  });

  it("closes a mobile drawer when the viewport crosses into desktop", async () => {
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: "(min-width: 901px)",
        onchange: null,
        addEventListener: (
          type: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => {
          if (type === "change") onChange = listener;
        },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ConsoleProvider>
          <WebRuntimeProvider>
            <App />
          </WebRuntimeProvider>
        </ConsoleProvider>,
      );
    });
    await waitFor(() => host.querySelector(".console-shell"));
    await act(async () => {
      requiredElement<HTMLButtonElement>(
        host,
        '.mobile-navigation button[aria-label="Open conversations"]',
      ).click();
    });
    await waitFor(() => host.querySelector('[role="dialog"][aria-label="Conversations"]'));
    expect(document.body.hasAttribute("data-console-modal-open")).toBe(true);

    await act(async () => {
      onChange?.({ matches: true } as MediaQueryListEvent);
    });
    expect(host.querySelector('[role="dialog"][aria-label="Conversations"]')).toBeNull();
    expect(requiredElement<HTMLElement>(host, ".chat").hasAttribute("inert")).toBe(false);
    expect(document.body.hasAttribute("data-console-modal-open")).toBe(false);
    await act(async () => root.unmount());
  });
});

async function waitFor<Value>(
  read: () => Value | null | undefined | false,
  attempts = 20,
): Promise<Value> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for the console interaction state");
}

function requiredElement<ElementType extends Element>(
  host: HTMLElement,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected ${selector} to be rendered`);
  return element;
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
