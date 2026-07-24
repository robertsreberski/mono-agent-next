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
    await nextFrames(8);
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

  it("implements menu-button arrow navigation and lets Tab leave the menu", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let unavailableActivations = 0;
    await act(async () => {
      root.render(
        <PopoverProvider>
          <button type="button">Before</button>
          <span style={{ display: "none" }}>
            <button type="button">Hidden before</button>
          </span>
          <Popover
            id="actions"
            triggerLabel="Conversation actions"
            trigger="Actions"
            panelRole="menu"
          >
            <button type="button" role="menuitem">Rename</button>
            <button
              type="button"
              role="menuitem"
              aria-disabled="true"
              onClick={() => {
                unavailableActivations += 1;
              }}
            >
              Unavailable
            </button>
            <button type="button" role="menuitem">Archive</button>
          </Popover>
          <span style={{ display: "none" }}>
            <button type="button">Hidden after</button>
          </span>
          <button type="button">After</button>
        </PopoverProvider>,
      );
    });

    const trigger = requiredButton(host, "Conversation actions");
    trigger.focus();
    await pressKey("ArrowDown");
    await nextFrame();
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, -1]);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    await pressKey("Enter");
    expect(unavailableActivations).toBe(0);
    await act(async () => items[1]?.click());
    expect(unavailableActivations).toBe(0);
    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    await pressKey("ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    await pressKey("Home");
    expect(document.activeElement).toBe(items[0]);
    await pressKey("End");
    expect(document.activeElement).toBe(items[2]);

    await pressKey("Tab");
    expect(document.querySelector('[role="menu"][aria-label="Conversation actions"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("After");

    trigger.focus();
    await pressKey("ArrowUp");
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("Archive");
    await pressKey("Tab", { shiftKey: true });
    expect(document.querySelector('[role="menu"][aria-label="Conversation actions"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Before");

    await act(async () => root.unmount());
  });

  it("skips hidden initial controls and falls back to the visible panel", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <PopoverProvider>
          <Popover
            id="hidden-menu"
            triggerLabel="Hidden menu controls"
            trigger="Menu"
            panelRole="menu"
          >
            <span style={{ display: "none" }}>
              <button type="button" role="menuitem">Display-hidden menu item</button>
            </span>
            <span style={{ visibility: "collapse" }}>
              <button type="button" role="menuitem">Collapsed menu item</button>
            </span>
            <span inert>
              <button type="button" role="menuitem">Inert menu item</button>
            </span>
            <button type="button" role="menuitem" disabled>Disabled menu item</button>
            <button type="button" role="menuitem">Visible menu item</button>
          </Popover>
          <Popover id="hidden-dialog" triggerLabel="Hidden dialog controls" trigger="Dialog">
            <span style={{ visibility: "hidden" }}>
              <button type="button">Visibility-hidden dialog control</button>
            </span>
            <span aria-hidden="true">
              <button type="button">ARIA-hidden dialog control</button>
            </span>
            <button type="button">Visible dialog control</button>
          </Popover>
          <Popover id="empty-dialog" triggerLabel="No visible controls" trigger="Empty">
            <span hidden>
              <button type="button">Hidden-only dialog control</button>
            </span>
          </Popover>
          <Popover id="delayed-dialog" triggerLabel="Delayed dialog control" trigger="Delayed">
            <button type="button" disabled>Eventually enabled dialog control</button>
          </Popover>
        </PopoverProvider>,
      );
    });

    await act(async () => requiredButton(host, "Hidden menu controls").click());
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("Visible menu item");

    await act(async () => requiredButton(host, "Hidden dialog controls").click());
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("Visible dialog control");

    await act(async () => requiredButton(host, "Delayed dialog control").click());
    const delayedControl = document.querySelector<HTMLButtonElement>(
      '[role="dialog"][aria-label="Delayed dialog control"] button',
    );
    expect(delayedControl).not.toBeNull();
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          if (delayedControl !== null) delayedControl.disabled = false;
          resolve();
        });
      });
    });
    await nextFrame();
    expect(document.activeElement).toBe(delayedControl);

    await act(async () => requiredButton(host, "No visible controls").click());
    await nextFrames(8);
    const emptyDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="No visible controls"]',
    );
    expect(document.activeElement).toBe(emptyDialog);

    await act(async () => root.unmount());
  });

  it("contains dialog focus and dismisses outside without stealing focus", async () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(host, outside);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <PopoverProvider>
          <Popover id="context" triggerLabel="Context usage" trigger="Context">
            <button type="button">First</button>
            <button type="button">Last</button>
          </Popover>
        </PopoverProvider>,
      );
    });

    await act(async () => requiredButton(host, "Context usage").click());
    await nextFrame();
    const controls = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"][aria-label="Context usage"] button',
      ),
    ];
    expect(document.activeElement).toBe(controls[0]);
    await pressKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(controls[1]);
    await pressKey("Tab");
    expect(document.activeElement).toBe(controls[0]);

    await act(async () => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      outside.focus();
    });
    expect(document.querySelector('[role="dialog"][aria-label="Context usage"]')).toBeNull();
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
  await nextFrames(2);
}

async function nextFrames(count: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      const advance = (remaining: number) => {
        window.requestAnimationFrame(() => {
          if (remaining <= 1) {
            resolve();
          } else {
            advance(remaining - 1);
          }
        });
      };
      advance(count);
    });
  });
}

async function pressKey(
  key: string,
  options: { readonly shiftKey?: boolean } = {},
): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        ...options,
      }),
    );
  });
}
