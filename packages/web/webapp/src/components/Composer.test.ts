import { describe, expect, it, vi } from "vitest";
import { buildComposerCommands } from "./Composer";

const callbacks = () => ({
  createConversation: vi.fn(),
  openRunSettings: vi.fn(),
  stopResponse: vi.fn(),
});

describe("buildComposerCommands", () => {
  it("replaces unavailable run settings with stop while a response is running", () => {
    const actions = callbacks();
    const commands = buildComposerCommands({
      attachmentCount: 0,
      hasAgent: true,
      hasRunSettings: true,
      isRunning: true,
      ...actions,
    });

    expect(commands.map((command) => command.id)).toEqual(["stop"]);
    commands[0]?.execute();
    expect(actions.stopResponse).toHaveBeenCalledOnce();
    expect(actions.openRunSettings).not.toHaveBeenCalled();
  });

  it("offers settings and a clean conversation only when both are actionable", () => {
    const commands = buildComposerCommands({
      attachmentCount: 0,
      hasAgent: true,
      hasRunSettings: true,
      isRunning: false,
      ...callbacks(),
    });

    expect(commands.map((command) => command.id)).toEqual(["settings", "new"]);
  });
});
