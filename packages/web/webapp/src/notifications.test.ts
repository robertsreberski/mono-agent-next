import { describe, expect, it } from "vitest";

import { responseNotifications } from "./notifications";
import type { Bootstrap, Thread } from "./types";

const timestamp = "2026-01-01T00:00:00.000Z";

describe("web response notifications", () => {
  it("deduplicates completed turns by lastTurnId and identifies proactive trigger kinds", () => {
    const running = thread({
      id: "thread-response",
      status: "running",
      lastTurnId: "turn-7",
    });
    const next: Bootstrap = {
      version: 1,
      revision: 9,
      agents: [{
        id: "personal",
        label: "Personal Agent",
        endpoint: "http://127.0.0.1:1",
        online: true,
        pinned: false,
        capabilities: {},
      }],
      threads: [
        { ...running, status: "complete" },
        thread({
          id: "thread-proactive",
          proactive: true,
          trigger: { kind: "cron" },
          status: "complete",
          lastTurnId: "proactive:thread-proactive",
          title: "Morning summary",
        }),
      ],
      newProactiveThreadIds: ["thread-proactive"],
    };
    expect(responseNotifications([running], next)).toEqual([
      {
        title: "Scheduled update · Personal Agent",
        body: "Morning summary",
        tag: "mono-agent-proactive:thread-proactive",
        url: "/?thread=thread-proactive",
      },
      {
        title: "Personal Agent replied",
        body: "Conversation",
        tag: "mono-agent-turn:turn-7",
        url: "/?thread=thread-response",
      },
    ]);
    expect(responseNotifications(next.threads, {
      ...next,
      newProactiveThreadIds: [],
      revision: 10,
    })).toEqual([]);
  });
});

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread",
    agentId: "personal",
    title: "Conversation",
    titleManual: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    ...overrides,
  };
}
