import type {
  JsonObject,
  JsonValue,
  ModuleToolBinding,
} from "@mono-agent/module-sdk";
import { describe, expect, it } from "vitest";

import {
  RUN_HISTORY_NESTED_RESULT_OMISSION,
  RUN_HISTORY_UNTRUSTED_NOTICE,
  createRunHistoryToolContribution,
  type RunHistoryReader,
} from "../run-history-tool.js";
import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSummary,
} from "../execution-types.js";

describe("RunHistory contribution", () => {
  it("exposes only terminal prior runs from the exact logical conversation", async () => {
    const tool = bind(fixtureReader([
      record("prior", "conversation", "completed"),
      record("current", "conversation", "completed"),
      record("running", "conversation", "running"),
      record("foreign", "other", "completed"),
    ]));

    const listed = value(await execute(tool, { action: "list", limit: 10 }));
    expect(listed.notice).toBe(RUN_HISTORY_UNTRUSTED_NOTICE);
    expect((listed.runs as JsonObject[]).map((run) => run.runId)).toEqual(["prior"]);

    const foreign = await execute(tool, { action: "inspect", runId: "foreign" });
    expect(foreign).toMatchObject({ isError: true });
    expect(value(foreign).error).toBe("run_not_available");
  });

  it("infers actions and uses bounded cursors scoped to one turn binding", async () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      record(`run-${String(index).padStart(2, "0")}`, "conversation", "completed", 12));
    const reader = fixtureReader(records);
    const tool = bind(reader);

    const first = value(await execute(tool, { limit: 5 }));
    expect(first.action).toBe("list");
    expect(first.runs).toHaveLength(5);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(String(first.nextCursor)).not.toContain("run-");
    const firstCursor = cursor(first.nextCursor);
    const second = value(await execute(tool, {
      limit: 5,
      cursor: firstCursor,
    }));
    expect(second.runs).toHaveLength(5);

    const searched = value(await execute(tool, { query: "run-00" }));
    expect(searched.action).toBe("search");
    const inspected = value(await execute(tool, { runId: "run-00" }));
    expect(inspected.action).toBe("inspect");
    expect(inspected.entries).toHaveLength(10);
    const inspectCursor = cursor(inspected.nextCursor);
    const continued = value(await execute(tool, {
      action: "inspect",
      runId: "ignored-by-bound-cursor",
      cursor: inspectCursor,
    }));
    expect(continued.entries).toHaveLength(3);

    const otherTurn = bind(reader, "other-current");
    await expect(execute(otherTurn, {
      action: "list",
      cursor: firstCursor,
    })).resolves.toMatchObject({ isError: true });
    expect(value(await execute(tool, { action: "search", query: "" })).error)
      .toBe("invalid_query");
    expect(value(await execute(tool, { action: "list", limit: 11 })).error)
      .toBe("invalid_limit");
  });

  it("searches user evidence only and sanitizes secrets, artifacts, size, and nested results", async () => {
    const matching = record("matching", "conversation", "completed", 0, [
      userEntry("matching", `password=hunter2 alpha needle ${"x".repeat(3_000)}`),
      artifactEntry("matching"),
      assistantEntry("matching", `${RUN_HISTORY_UNTRUSTED_NOTICE} RunHistory token=private`),
    ]);
    const assistantOnly = record("assistant-only", "conversation", "completed", 0, [
      assistantEntry("assistant-only", "alpha needle"),
    ]);
    const summary = {
      ...matching.summary,
      token: "summary-secret",
    } as unknown as AgentRunSummary;
    const tool = bind(fixtureReader([{ ...matching, summary }, assistantOnly]));

    const searched = value(await execute(tool, { action: "search", query: "alpha needle" }));
    expect((searched.runs as JsonObject[]).map((run) => run.runId)).toEqual(["matching"]);
    expect((searched.runs as JsonObject[])[0]?.token).toBe("[redacted]");

    const inspected = value(await execute(tool, { action: "inspect", runId: "matching" }));
    const encoded = JSON.stringify(inspected);
    expect(encoded).not.toContain("hunter2");
    expect(encoded).not.toContain("summary-secret");
    expect(encoded).not.toContain("private");
    expect(encoded).not.toContain("sha256:fixture-secret");
    expect(encoded).toContain("password=[redacted]");
    expect(encoded).toContain("[artifact omitted]");
    expect(encoded).toContain(RUN_HISTORY_NESTED_RESULT_OMISSION);
    expect(encoded).not.toContain("x".repeat(2_049));
  });

  it("rejects getter-backed input without invoking it and reports source truncation", async () => {
    let reads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "action", {
      enumerable: true,
      get() {
        reads += 1;
        return "list";
      },
    });
    const records = Array.from({ length: 2_001 }, (_, index) =>
      record(`run-${String(index)}`, "conversation", "completed"));
    const tool = bind(fixtureReader(records));

    const invalid = await execute(tool, input as JsonValue);
    expect(invalid).toMatchObject({ isError: true });
    expect(value(invalid).error).toBe("invalid_input");
    expect(reads).toBe(0);
    const listed = value(await execute(tool, { action: "list", limit: 1 }));
    expect(listed.sourceTruncated).toBe(true);
  });

  it("propagates the composed call signal to an in-flight journal read", async () => {
    let observed: AbortSignal | undefined;
    const reader: RunHistoryReader = {
      async listRuns(_cursor, signal) {
        observed = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async readRun() {
        return undefined;
      },
    };
    const binding = bind(reader);
    const controller = new AbortController();
    const pending = execute(binding, { action: "list" }, controller.signal);
    controller.abort(new Error("cancelled read"));
    await expect(pending).rejects.toThrow("cancelled read");
    expect(observed?.aborted).toBe(true);
  });
});

function bind(
  reader: RunHistoryReader,
  currentRunId = "current",
): ModuleToolBinding {
  return createRunHistoryToolContribution(reader).bind({
    conversationId: "conversation",
    runId: currentRunId,
    requestId: `request-${currentRunId}`,
    signal: new AbortController().signal,
  });
}

function execute(
  binding: ModuleToolBinding,
  input: JsonValue,
  signal = new AbortController().signal,
): Promise<unknown> {
  return Promise.resolve(binding.execute(input, { callId: "call", signal }));
}

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

function artifactEntry(runId: string): AgentRunRecord["transcript"][number] {
  return {
    kind: "message",
    entryId: `${runId}:artifact`,
    runId,
    requestId: `request-${runId}`,
    conversationId: "conversation",
    recordedAt: "2026-07-23T10:00:30.000Z",
    role: "user",
    content: [{
      type: "artifact",
      name: "secret.txt",
      ref: {
        id: "secret",
        sha256: "sha256:fixture-secret",
        sizeBytes: 10,
        mediaType: "text/plain",
      },
    }],
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

function cursor(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("Expected a RunHistory cursor");
  return value;
}
