// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComposerTriggerPopover,
  type ComposerTriggerCommand,
} from "./ComposerTriggerPopover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.textContent = "";
});

function Harness({ children }: { readonly children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [],
    onNew: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input aria-label="Message" />
          {children}
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </AssistantRuntimeProvider>
  );
}

async function renderCommands(commands: readonly ComposerTriggerCommand[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <Harness>
        <ComposerTriggerPopover commands={commands} />
      </Harness>,
    );
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

describe("ComposerTriggerPopover", () => {
  it("filters and executes slash commands without leaving command text behind", async () => {
    const startNew = vi.fn();
    const openSettings = vi.fn();
    const view = await renderCommands([
      {
        id: "new",
        label: "New conversation",
        description: "Start a clean thread",
        icon: "spark",
        execute: startNew,
      },
      {
        id: "settings",
        label: "Run settings",
        icon: "settings",
        execute: openSettings,
      },
    ]);
    const input = requiredElement<HTMLTextAreaElement>(
      view.host,
      'textarea[aria-label="Message"]',
    );

    await inputText(input, "/new");
    const option = await waitFor(() =>
      document.querySelector<HTMLElement>('[role="option"]')
    );
    expect(document.querySelector('[role="listbox"][aria-label="Commands"]')).not.toBeNull();
    expect(option.textContent).toContain("New conversation");
    expect(option.textContent).toContain("Start a clean thread");
    expect(document.body.textContent).not.toContain("Run settings");
    expect(option.querySelector("[data-command-icon='spark']")).not.toBeNull();

    await act(async () => option.click());
    expect(startNew).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();
    await waitFor(() => input.value === "");
    await view.unmount();
  });

  it("uses native listbox selection and keyboard execution", async () => {
    const openSettings = vi.fn();
    const view = await renderCommands([{
      id: "settings",
      label: "Run settings",
      icon: "settings",
      execute: openSettings,
    }]);
    const input = requiredElement<HTMLTextAreaElement>(
      view.host,
      'textarea[aria-label="Message"]',
    );

    await inputText(input, "/");
    const option = await waitFor(() =>
      document.querySelector<HTMLElement>('[role="option"]')
    );
    expect(option.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
    });
    expect(openSettings).toHaveBeenCalledOnce();
    await waitFor(() => input.value === "");
    await view.unmount();
  });
});

async function inputText(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor<Value>(
  read: () => Value | null | undefined | false,
  attempts = 40,
): Promise<Value> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for slash-command state");
}

function requiredElement<ElementType extends Element>(
  host: ParentNode,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}
