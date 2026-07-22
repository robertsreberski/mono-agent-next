import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyableMessageText,
  copyTextWithFallback,
} from "./Messages";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

const setClipboard = (value: { writeText: (text: string) => Promise<void> } | undefined) => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
};

const setExecCommand = (implementation: (command: string) => boolean) => {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(implementation),
  });
};

afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
  else Reflect.deleteProperty(document, "execCommand");
});

describe("message copy", () => {
  it("copies only visible text, excluding hidden reasoning and tool content", () => {
    expect(
      copyableMessageText([
        { type: "reasoning", text: "private chain" },
        { type: "text", text: "Answer" },
        { type: "tool-call" },
        { type: "text", text: "More" },
      ]),
    ).toBe("Answer\n\nMore");
  });

  it("uses the Clipboard API in secure contexts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn(() => true);
    setClipboard({ writeText });
    setExecCommand(execCommand);

    await copyTextWithFallback("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a temporary selection on plain LAN HTTP", async () => {
    setClipboard(undefined);
    setExecCommand((command) => command === "copy");

    await expect(copyTextWithFallback("LAN copy")).resolves.toBeUndefined();

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea[aria-hidden='true']")).not.toBeInTheDocument();
  });

  it("rejects visibly actionable clipboard failures", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    await expect(copyTextWithFallback("blocked")).rejects.toThrow(
      "did not allow clipboard access",
    );
  });
});
