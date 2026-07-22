import { describe, expect, it, vi } from "vitest";

import type { ChannelId, RunningChannel } from "../channels.js";
import { channelIdForConversation, routeProactiveNotification } from "../proactive-notify.js";

describe("channelIdForConversation", () => {
  it("maps push-channel prefixes to their channel id", () => {
    expect(channelIdForConversation("telegram:42")).toBe("telegram");
    expect(channelIdForConversation("slack:C1:171.5")).toBe("slack");
    expect(channelIdForConversation("whatsapp:123@s.whatsapp.net")).toBe("whatsapp");
  });

  it("returns undefined for non-deliverable destinations", () => {
    expect(channelIdForConversation("cron:morning-brief")).toBeUndefined();
    expect(channelIdForConversation("webhook:req-1")).toBeUndefined();
    expect(channelIdForConversation("nonsense")).toBeUndefined();
    // A scheme without a target (no colon) is not a routable destination.
    expect(channelIdForConversation("telegram")).toBeUndefined();
  });
});

describe("routeProactiveNotification", () => {
  const running = (entries: Partial<Record<ChannelId, Pick<RunningChannel, "notify">>>) =>
    new Map(Object.entries(entries) as [ChannelId, Pick<RunningChannel, "notify">][]);

  it("delivers to the destination channel's notify and returns its result", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const result = await routeProactiveNotification({
      conversationId: "telegram:42",
      text: "morning brief",
      running: running({ telegram: { notify } }),
    });
    expect(result.delivered).toBe(true);
    expect(notify).toHaveBeenCalledWith({ conversationId: "telegram:42", text: "morning brief" });
  });

  it("returns a failure result (does not throw) when the channel's notify rejects", async () => {
    const warn = vi.fn();
    const notify = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    const result = await routeProactiveNotification({
      conversationId: "telegram:42",
      text: "morning brief",
      running: running({ telegram: { notify } }),
      logger: { warn },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("delivery failed");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips + warns when the destination prefix is not a push channel", async () => {
    const warn = vi.fn();
    const result = await routeProactiveNotification({
      conversationId: "cron:job",
      text: "x",
      running: running({}),
      logger: { warn },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips + warns when the destination channel is not running or has no notify", async () => {
    const warn = vi.fn();
    const result = await routeProactiveNotification({
      conversationId: "whatsapp:123@s.whatsapp.net",
      text: "x",
      running: running({}),
      logger: { warn },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
