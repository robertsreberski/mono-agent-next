// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";
import { ConsoleProvider } from "./console";

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
});

describe("browser console shell", () => {
  it("starts locked and keeps bearer authentication scoped to the browser session", async () => {
    window.sessionStorage.clear();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ConsoleProvider><App /></ConsoleProvider>);
    });
    expect(document.title).toBe("");
    expect(host.textContent).toContain("Connect to your agents");
    const token = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(token?.getAttribute("autocomplete")).toBe("current-password");
    expect(window.localStorage.getItem("mono-agent-web-token")).toBeNull();
    await act(async () => root.unmount());
  });
});

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
