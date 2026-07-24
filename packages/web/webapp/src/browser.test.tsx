// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ApiError } from "./api";
import { ConsoleProvider } from "./console";
import { WebRuntimeProvider } from "./runtime";

const apiMocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  probeBootstrap: vi.fn(),
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
    subscribeEvents: apiMocks.subscribeEvents,
    api: {
      ...actual.api,
      bootstrap: apiMocks.bootstrap,
      probeBootstrap: apiMocks.probeBootstrap,
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node 26 exposes disabled Web Storage globals unless a persistence file is
// configured. Install isolated browser storage for this jsdom contract test.
Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe("browser console shell", () => {
  it("starts locked and keeps bearer authentication scoped to the browser session", async () => {
    apiMocks.probeBootstrap.mockRejectedValueOnce(new ApiError("Unauthorized.", 401, "unauthorized"));
    apiMocks.bootstrap.mockRejectedValueOnce(new ApiError("Unauthorized.", 401, "unauthorized"));
    window.sessionStorage.setItem("mono-agent-web-token", "stale-browser-token-0123456789");
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
    await waitFor(() => host.querySelector<HTMLInputElement>('input[type="password"]'));
    expect(document.title).toBe("");
    expect(host.textContent).toContain("Connect to your agents");
    expect(host.textContent).toContain("Unauthorized.");
    const token = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(token?.getAttribute("autocomplete")).toBe("current-password");
    expect(window.localStorage.getItem("mono-agent-web-token")).toBeNull();
    expect(window.sessionStorage.getItem("mono-agent-web-token")).toBeNull();
    await act(async () => root.unmount());
  });

  it("opens an explicit no-auth console without storing or sending a browser token", async () => {
    window.sessionStorage.setItem("mono-agent-web-token", "stale-browser-token-0123456789");
    apiMocks.probeBootstrap.mockResolvedValueOnce({
      version: 1,
      revision: 0,
      agents: [],
      threads: [],
      newProactiveThreadIds: [],
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
    expect(host.textContent).not.toContain("Connect to your agents");
    expect(host.querySelector('[aria-label="Lock console"]')).toBeNull();
    expect(window.sessionStorage.getItem("mono-agent-web-token")).toBeNull();
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
  throw new Error("Timed out waiting for the browser console state");
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
