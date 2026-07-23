// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";
import { ConsoleProvider } from "./console";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
});

describe("browser console shell", () => {
  it("starts locked and keeps bearer authentication scoped to the browser session", async () => {
    sessionStorage.clear();
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
    expect(localStorage.getItem("mono-agent-web-token")).toBeNull();
    await act(async () => root.unmount());
  });
});
