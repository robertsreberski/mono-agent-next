import { describe, expect, it } from "vitest";

import { formatHumanChannelSections } from "../channel-status-display.js";

describe("formatHumanChannelSections", () => {
  it("groups operator surfaces, labels the shared GUI, and compacts disabled channels", () => {
    const sections = formatHumanChannelSections([
      { id: "telegram", kind: "running", text: "running" },
      { id: "slack", kind: "disabled", text: "disabled: Slack is disabled." },
      { id: "webhook", kind: "waiting_for_config", text: "waiting_for_config: API key required" },
      { id: "tui", kind: "running", text: "running (baseUrl=http://127.0.0.1:5001/gui)" },
    ]);

    expect(sections.map(({ title }) => title)).toEqual(["channels", "operator"]);
    const channels = sections[0]?.lines.join("\n") ?? "";
    expect(channels).toContain("telegram");
    expect(channels).toContain("webhook");
    expect(channels).toContain("API key required");
    expect(channels).toContain("disabled");
    expect(channels).toContain("slack");
    expect(channels).not.toContain("Slack is disabled.");

    const operator = sections[1]?.lines.join("\n") ?? "";
    expect(operator).toContain("gui");
    expect(operator).toContain("TUI + Web; baseUrl=http://127.0.0.1:5001/gui");
    expect(operator).not.toContain("tui");
  });

  it("keeps plugin channels in the regular section and disabled operator ids compact", () => {
    const sections = formatHumanChannelSections([
      { id: "discord", kind: "running", text: "running" },
      { id: "tui", kind: "disabled", text: "disabled: off" },
    ]);

    expect(sections[0]?.lines.join("\n")).toContain("discord");
    const operator = sections[1]?.lines.join("\n") ?? "";
    expect(operator).toContain("disabled");
    expect(operator).toContain("gui");
  });
});
