import { describe, expect, it, vi } from "vitest";

import { buildComposerCommands } from "./Composer";

function callbacks() {
  return {
    createConversation: vi.fn(),
    openRunSettings: vi.fn(),
    stopResponse: vi.fn(),
  };
}

describe("buildComposerCommands", () => {
  it("exposes only capability-backed commands for an active response", () => {
    const unavailable = buildComposerCommands({
      attachmentCount: 0,
      canCancel: false,
      canCreateConversation: true,
      hasRunSettings: true,
      isRunning: true,
      ...callbacks(),
    });
    expect(unavailable).toEqual([]);

    const actions = callbacks();
    const commands = buildComposerCommands({
      attachmentCount: 0,
      canCancel: true,
      canCreateConversation: true,
      hasRunSettings: true,
      isRunning: true,
      ...actions,
    });
    expect(commands.map((command) => command.id)).toEqual(["stop"]);
    commands[0]?.execute();
    expect(actions.stopResponse).toHaveBeenCalledOnce();
    expect(actions.openRunSettings).not.toHaveBeenCalled();
  });

  it("offers settings and a clean conversation only when actionable", () => {
    const commands = buildComposerCommands({
      attachmentCount: 0,
      canCancel: false,
      canCreateConversation: true,
      hasRunSettings: true,
      isRunning: false,
      ...callbacks(),
    });
    expect(commands.map((command) => command.id)).toEqual(["settings", "new"]);

    const withAttachment = buildComposerCommands({
      attachmentCount: 1,
      canCancel: false,
      canCreateConversation: true,
      hasRunSettings: true,
      isRunning: false,
      ...callbacks(),
    });
    expect(withAttachment.map((command) => command.id)).toEqual(["settings"]);

    const withoutAgent = buildComposerCommands({
      attachmentCount: 0,
      canCancel: false,
      canCreateConversation: false,
      hasRunSettings: false,
      isRunning: false,
      ...callbacks(),
    });
    expect(withoutAgent).toEqual([]);
  });
});
