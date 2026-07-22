import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ComposerTriggerPopover,
  type ComposerTriggerCommand,
} from "./ComposerTriggerPopover";

function Harness({
  children,
}: {
  readonly children: ReactNode;
}) {
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

const renderCommands = (commands: readonly ComposerTriggerCommand[]) =>
  render(
    <Harness>
      <ComposerTriggerPopover commands={commands} />
    </Harness>,
  );

describe("ComposerTriggerPopover", () => {
  it("filters and executes slash commands without leaving command text behind", async () => {
    const startNew = vi.fn();
    const archive = vi.fn();
    renderCommands([
      {
        id: "new",
        label: "New conversation",
        description: "Start a clean thread",
        icon: "new",
        execute: startNew,
      },
      {
        id: "archive",
        label: "Archive conversation",
        icon: "archive",
        execute: archive,
      },
    ]);
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(input, { target: { value: "/new" } });

    const option = await screen.findByRole("option", { name: /New conversation/i });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(option).toHaveTextContent("Start a clean thread");
    expect(screen.queryByRole("option", { name: /Archive conversation/i })).not.toBeInTheDocument();
    expect(option.querySelector("[data-command-icon='new']")).toBeInTheDocument();

    fireEvent.click(option);

    expect(startNew).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("uses native listbox keyboard behavior and a safe icon fallback", async () => {
    const execute = vi.fn();
    renderCommands([
      {
        id: "mystery",
        label: "Mystery command",
        icon: "not-an-app-icon",
        execute,
      },
    ]);
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(input, { target: { value: "/" } });

    const option = await screen.findByRole("option", { name: /Mystery command/i });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(option.querySelector("[data-command-icon='command']")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(execute).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input).toHaveValue(""));
  });
});
