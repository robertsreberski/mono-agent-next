import { describe, expect, it } from "vitest";

import type { JsonObject } from "@mono-agent/module-sdk";

import {
  RUN_HISTORY_NESTED_RESULT_OMISSION,
  RUN_HISTORY_UNTRUSTED_NOTICE,
  createRunHistoryTool,
  type RunHistoryReader,
} from "../run-history-tool.js";
import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSummary,
} from "../types.js";

const signal = new AbortController().signal;

describe("RunHistory", () => {
  it("exposes only terminal prior runs from the exact logical conversation", async () => {
    const reader = fixtureReader([
      record("prior", "conversation", "completed"),
      record("current", "conversation", "completed"),
      record("running", "conversation", "running"),
      record("foreign", "other", "completed"),
    ]);
    const tool = createRunHistoryTool({
      reader,
      conversationId: "conversation",
      currentRunId: "current",
      signal,
    });

    const listed = value(await tool.execute({ action: "list", limit: 10 }));
    expect(listed.notice).toBe(RUN_HISTORY_UNTRUSTED_NOTICE);
    expect((listed.runs as JsonObject[]).map((run) => run.runId)).toEqual(["prior"]);

    const foreign = await tool.execute({ action: "inspect", runId: "foreign" });
    expect(foreign).toMatchObject({ isError: true });
    expect(value(foreign).error).toBe("run_not_available");
  });

  it("uses bounded opaque cursors for list and inspect pagination", async () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      record(`run-${String(index).padStart(2, "0")}`, "conversation", "completed", 12));
    const tool = createRunHistoryTool({
      reader: fixtureReader(records),
      conversationId: "conversation",
      currentRunId: "current",
      signal,
    });

    const first = value(await tool.execute({ action: "list", limit: 5 }));
    expect(first.runs).toHaveLength(5);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(String(first.nextCursor)).not.toContain("run-");
    const second = value(await tool.execute({
      action: "list",
      limit: 5,
      cursor: first.nextCursor,
    }));
    expect(second.runs).toHaveLength(5);

    const inspected = value(await tool.execute({ action: "inspect", runId: "run-00" }));
    expect(inspected.entries).toHaveLength(10);
    const continued = value(await tool.execute({
      action: "inspect",
      runId: "ignored-by-bound-cursor",
      cursor: inspected.nextCursor,
    }));
    expect(continued.entries).toHaveLength(3);

    await expect(tool.execute({ action: "list", cursor: "not-a-cursor" }))
      .resolves.toMatchObject({ isError: true });
  });

  it("searches user evidence only and redacts assignments, sensitive keys, and nested results", async () => {
    const matching = record("matching", "conversation", "completed", 0, [
      userEntry("matching", "password=hunter2 alpha needle"),
      assistantEntry("matching", `${RUN_HISTORY_UNTRUSTED_NOTICE} RunHistory token=private`),
    ]);
    const assistantOnly = record("assistant-only", "conversation", "completed", 0, [
      assistantEntry("assistant-only", "alpha needle"),
    ]);
    const summary = {
      ...matching.summary,
      token: "summary-secret",
    } as unknown as AgentRunSummary;
    const reader = fixtureReader([{ ...matching, summary }, assistantOnly]);
    const tool = createRunHistoryTool({
      reader,
      conversationId: "conversation",
      currentRunId: "current",
      signal,
    });

    const searched = value(await tool.execute({ action: "search", query: "alpha needle" }));
    expect((searched.runs as JsonObject[]).map((run) => run.runId)).toEqual(["matching"]);
    expect((searched.runs as JsonObject[])[0]?.token).toBe("[redacted]");

    const inspected = value(await tool.execute({ action: "inspect", runId: "matching" }));
    const encoded = JSON.stringify(inspected);
    expect(encoded).not.toContain("hunter2");
    expect(encoded).not.toContain("summary-secret");
    expect(encoded).not.toContain("private");
    expect(encoded).toContain("password=[redacted]");
    expect(encoded).toContain(RUN_HISTORY_NESTED_RESULT_OMISSION);
  });
});

function fixtureReader(records: readonly AgentRunRecord[]): RunHistoryReader {
  const byId = new Map(records.map((entry) => [entry.summary.runId, entry]));
  return {
    async listRuns() {
      return { runs: records.map((entry) => entry.summary) };
    },
    async readRun(runId) {
      return byId.get(runId);
    },
  };
}

function record(
  runId: string,
  conversationId: string,
  status: AgentRunStatus,
  extraEvents = 0,
  transcript: AgentRunRecord["transcript"] = [],
): AgentRunRecord {
  const summary: AgentRunSummary = {
    runId,
    requestId: `request-${runId}`,
    conversationId,
    status,
    startedAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:01:00.000Z",
    ...(status === "running" ? {} : { endedAt: "2026-07-23T10:01:00.000Z" }),
    attempts: [],
    ...(status === "failed" || status === "uncertain"
      ? { failureCode: "bounded-failure" }
      : {}),
  };
  return {
    summary,
    events: [
      {
        type: "admitted",
        runId,
        sequence: 0,
        recordedAt: "2026-07-23T10:00:00.000Z",
      },
      ...Array.from({ length: extraEvents }, (_, index) => ({
        type: "admitted" as const,
        runId,
        sequence: index + 1,
        recordedAt: "2026-07-23T10:00:00.000Z",
      })),
    ],
    transcript,
  };
}

function userEntry(runId: string, text: string): AgentRunRecord["transcript"][number] {
  return {
    kind: "message",
    entryId: `${runId}:user`,
    runId,
    requestId: `request-${runId}`,
    conversationId: "conversation",
    recordedAt: "2026-07-23T10:00:00.000Z",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistantEntry(runId: string, text: string): AgentRunRecord["transcript"][number] {
  return {
    kind: "message",
    entryId: `${runId}:assistant`,
    runId,
    requestId: `request-${runId}`,
    conversationId: "conversation",
    recordedAt: "2026-07-23T10:01:00.000Z",
    role: "assistant",
    content: [{ type: "text", text }],
    route: { runtimeInstanceId: "primary", model: "provider:model" },
  };
}

function value(output: unknown): JsonObject {
  return (output as { readonly content: readonly [{ readonly value: JsonObject }] })
    .content[0].value;
}
