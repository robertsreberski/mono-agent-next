import { describe, expect, it } from "vitest";

import { slackTargetFromConversation, telegramChatIdFromConversation } from "../channels.js";

describe("telegramChatIdFromConversation", () => {
  it("extracts numeric and group chat ids, stripping a rollover bucket", () => {
    expect(telegramChatIdFromConversation("telegram:42")).toBe(42);
    expect(telegramChatIdFromConversation("telegram:-1001234567890")).toBe(-1001234567890);
    expect(telegramChatIdFromConversation("telegram:42#2026-06-19")).toBe(42);
  });

  it("trims surrounding whitespace so a model-supplied id still parses to a number", () => {
    expect(telegramChatIdFromConversation("telegram: 42")).toBe(42);
    expect(telegramChatIdFromConversation("telegram:42 ")).toBe(42);
    expect(telegramChatIdFromConversation("telegram: 42 #2026-06-19")).toBe(42);
  });

  it("returns undefined for a non-telegram or empty target", () => {
    expect(telegramChatIdFromConversation("slack:C1:1")).toBeUndefined();
    expect(telegramChatIdFromConversation("telegram:")).toBeUndefined();
    expect(telegramChatIdFromConversation("telegram:   ")).toBeUndefined();
  });
});

describe("slackTargetFromConversation", () => {
  it("parses thread-targeted and bare-channel destinations", () => {
    expect(slackTargetFromConversation("slack:C1:171.5")).toEqual({ channelId: "C1", threadTs: "171.5" });
    expect(slackTargetFromConversation("slack:C1")).toEqual({ channelId: "C1" });
    expect(slackTargetFromConversation("slack:C1:171.5#2026-06-19")).toEqual({ channelId: "C1", threadTs: "171.5" });
  });

  it("trims surrounding whitespace so the value reaching the Slack API matches the allowlist check", () => {
    expect(slackTargetFromConversation("slack: C1")).toEqual({ channelId: "C1" });
    expect(slackTargetFromConversation("slack:C1 ")).toEqual({ channelId: "C1" });
    expect(slackTargetFromConversation("slack: C1 : 123 ")).toEqual({ channelId: "C1", threadTs: "123" });
  });

  it("rejects a malformed (colon-bearing) threadTs rather than passing garbage downstream", () => {
    // A canonical Slack threadTs never contains a colon, so a stray/double colon is
    // an operator typo — return undefined so the driver warns + skips cleanly.
    expect(slackTargetFromConversation("slack:C1::extra")).toBeUndefined();
    expect(slackTargetFromConversation("slack:C1:171.5:")).toBeUndefined();
  });

  it("returns undefined for a non-slack or empty target", () => {
    expect(slackTargetFromConversation("telegram:42")).toBeUndefined();
    expect(slackTargetFromConversation("slack:")).toBeUndefined();
  });
});
