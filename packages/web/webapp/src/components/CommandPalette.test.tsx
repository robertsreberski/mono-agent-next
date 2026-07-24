// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consoleMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../console", () => ({
  useConsole: () => consoleMock.value,
}));

import { CommandPalette } from "./CommandPalette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  consoleMock.value = createConsoleState();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  document.body.textContent = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("uses combobox/listbox semantics and delegates navigation through ConsoleProvider actions", async () => {
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.textContent = "Open commands";
    document.body.append(trigger, host);
    trigger.focus();
    const root = createRoot(host);
    const onClose = vi.fn();

    await act(async () => {
      root.render(<CommandPalette open onClose={onClose} />);
    });
    await act(async () => {
      await animationFrame();
    });

    const input = requiredElement<HTMLInputElement>(host, '[cmdk-input]');
    const list = requiredElement(host, '[cmdk-list]');
    const options = [...host.querySelectorAll<HTMLElement>('[cmdk-item]')];
    expect(input.getAttribute("role")).toBe("combobox");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(options.length).toBeGreaterThan(3);
    expect(options.every((option) => option.getAttribute("role") === "option")).toBe(true);
    expect(document.activeElement).toBe(input);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(input);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
      await animationFrame();
    });
    expect(consoleMock.value.createThread).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("filters by agent keywords and exposes only one active option", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<CommandPalette open onClose={vi.fn()} />);
    });
    await act(async () => {
      await animationFrame();
    });

    const input = requiredElement<HTMLInputElement>(host, '[cmdk-input]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "secondary-agent");
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "secondary-agent",
      }));
    });
    const visibleOptions = [...host.querySelectorAll<HTMLElement>('[cmdk-item]')];
    expect(visibleOptions).toHaveLength(1);
    expect(visibleOptions[0]?.textContent).toContain("Switch to Secondary");
    expect(
      [...host.querySelectorAll('[cmdk-item][aria-selected="true"]')],
    ).toHaveLength(1);

    await act(async () => root.unmount());
  });
});

function createConsoleState() {
  const primary = {
    id: "primary",
    label: "Primary",
    endpoint: "http://127.0.0.1:1",
    online: true,
    pinned: true,
    capabilities: {},
  };
  const secondary = {
    id: "secondary-agent",
    label: "Secondary",
    endpoint: "http://127.0.0.1:2",
    online: true,
    pinned: false,
    capabilities: {},
  };
  return {
    bootstrap: {
      version: 1 as const,
      revision: 1,
      agents: [primary, secondary],
      threads: [],
      newProactiveThreadIds: [],
    },
    selectedAgent: primary,
    selectedAgentId: primary.id,
    selectedThread: {
      id: "thread-1",
      agentId: primary.id,
      title: "Selected conversation",
      titleManual: false,
      createdAt: "2026-07-24T08:00:00.000Z",
      updatedAt: "2026-07-24T08:00:00.000Z",
      status: "complete",
    },
    showArchived: false,
    showOffline: false,
    refreshing: false,
    tokenAuthentication: false,
    createThread: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => undefined),
    patchAgent: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    selectAgent: vi.fn(async () => undefined),
    setShowArchived: vi.fn(),
    setShowOffline: vi.fn(),
    logout: vi.fn(),
  };
}

async function animationFrame(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function requiredElement<ElementType extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): ElementType {
  const element = root.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected ${selector}`);
  return element;
}
