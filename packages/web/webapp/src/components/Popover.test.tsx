// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Popover, PopoverProvider } from "./Popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.textContent = "";
});

describe("Popover", () => {
  it("keeps one panel open and restores trigger focus after Escape", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <PopoverProvider>
          <Popover id="context" triggerLabel="Context usage" trigger="Context">
            <p>Context details</p>
          </Popover>
          <Popover
            id="actions"
            triggerLabel="Conversation actions"
            trigger="Actions"
            panelRole="menu"
          >
            <button type="button" role="menuitem">Rename</button>
            <button type="button" role="menuitem">Archive</button>
          </Popover>
        </PopoverProvider>,
      );
    });

    const contextTrigger = requiredButton(host, "Context usage");
    await act(async () => contextTrigger.click());
    await nextFrame();
    expect(document.querySelector('[role="dialog"][aria-label="Context usage"]')).not.toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[role="dialog"][aria-label="Context usage"]'),
    );

    const actionsTrigger = requiredButton(host, "Conversation actions");
    await act(async () => actionsTrigger.click());
    await nextFrame();
    expect(document.querySelector('[role="dialog"][aria-label="Context usage"]')).toBeNull();
    expect(document.querySelector('[role="menu"][aria-label="Conversation actions"]')).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Rename");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await nextFrame();
    expect(document.querySelector('[role="menu"][aria-label="Conversation actions"]')).toBeNull();
    expect(document.activeElement).toBe(actionsTrigger);

    await act(async () => root.unmount());
  });

  it("contains keyboard focus and dismisses outside without stealing focus", async () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(host, outside);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <PopoverProvider>
          <Popover
            id="actions"
            triggerLabel="Conversation actions"
            trigger="Actions"
            panelRole="menu"
          >
            <button type="button" role="menuitem">Rename</button>
            <button type="button" role="menuitem">Archive</button>
          </Popover>
        </PopoverProvider>,
      );
    });

    await act(async () => requiredButton(host, "Conversation actions").click());
    await nextFrame();
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);

    await act(async () => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      outside.focus();
    });
    expect(document.querySelector('[role="menu"][aria-label="Conversation actions"]')).toBeNull();
    expect(document.activeElement).toBe(outside);

    await act(async () => root.unmount());
  });
});

function requiredButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (button === null) throw new Error(`Missing ${label} trigger`);
  return button;
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}
