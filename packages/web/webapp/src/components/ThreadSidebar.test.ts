import { describe, expect, it } from "vitest";

import type { Thread } from "../types";
import { relativeTime, threadMatchesQuery } from "./ThreadSidebar";

describe("ThreadSidebar helpers", () => {
  it("matches conversation titles case-insensitively", () => {
    expect(threadMatchesQuery(thread("Quarterly Review"), "quarterly")).toBe(true);
    expect(threadMatchesQuery(thread("Quarterly Review"), " REVIEW ")).toBe(true);
    expect(threadMatchesQuery(thread("Quarterly Review"), "personal")).toBe(false);
  });

  it("uses compact relative timestamps", () => {
    const now = Date.parse("2026-07-24T12:00:00.000Z");
    expect(relativeTime("2026-07-24T11:59:45.000Z", now)).toBe("Now");
    expect(relativeTime("2026-07-24T11:45:00.000Z", now)).toBe("15m");
    expect(relativeTime("2026-07-24T09:00:00.000Z", now)).toBe("3h");
  });
});

function thread(title: string): Thread {
  return {
    id: "thread-1",
    agentId: "agent-1",
    title,
    titleManual: false,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    status: "complete",
  };
}
