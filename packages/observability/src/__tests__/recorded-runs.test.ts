import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createJsonlRunRecorder,
  deriveRunSource,
  listRecordedRuns,
  readRecordedRun,
  ObservabilityReadError,
  reconcileStaleRunArtifacts,
  mapRunToSession,
} from "../index.js";
import { classifyRecordedRunEvent } from "../recorded-runs.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "observability-reader-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSummary(dir: string, name: string, summary: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("recorded run reader", () => {
  it("lists summary artifacts newest first with redacted metadata", async () => {
    const dir = await tempDir();
    const first = createJsonlRunRecorder({ runId: "run-one", conversationId: "chat-1", artifactDir: dir });
    first.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    const firstSummary = await first.finish({ usage: { inputTokens: 1, apiKey: "fixture-redacted-value" } });

    const second = createJsonlRunRecorder({ runId: "run-two", conversationId: "chat-2", artifactDir: dir });
    const secondSummary = await second.finish({ failureKind: "provider_error", diagnostics: { token: "fixture-token-value" } });

    await utimes(firstSummary.artifactPaths[1] ?? "", new Date("2026-05-15T10:00:00Z"), new Date("2026-05-15T10:00:00Z"));
    await utimes(secondSummary.artifactPaths[1] ?? "", new Date("2026-05-15T11:00:00Z"), new Date("2026-05-15T11:00:00Z"));

    const list = await listRecordedRuns({ artifactDir: dir });

    expect(list.warnings).toEqual([]);
    expect(list.totalRuns).toBe(2);
    expect(list.runs.map((run) => run.runId)).toEqual(["run-two", "run-one"]);
    expect(list.runs[0]).toMatchObject({ status: "failed", failureKind: "provider_error", eventCount: 0 });
    expect(JSON.stringify(list.runs)).not.toContain("fixture-redacted-value");
    expect(JSON.stringify(list.runs)).not.toContain("fixture-token-value");
    expect(JSON.stringify(list.runs)).toContain("[redacted]");
  });

  it("returns an empty list when the artifact directory does not exist", async () => {
    const dir = join(await tempDir(), "missing");
    await expect(listRecordedRuns({ artifactDir: dir })).resolves.toEqual({ totalRuns: 0, runs: [], warnings: [] });
  });

  it("rejects invalid scope values with a typed reader error", async () => {
    const dir = await tempDir();
    await expect(listRecordedRuns({ artifactDir: dir, scope: "invalid" as never })).rejects.toMatchObject({
      code: "invalid_reader_options",
      details: { code: "invalid_reader_options", field: "scope" },
    });
  });

  it("scopes agent and memory summaries while preserving legacy explicit reads", async () => {
    const dir = await tempDir();
    await createJsonlRunRecorder({ runId: "agent-run", conversationId: "telegram:1", artifactDir: dir }).finish({});
    await createJsonlRunRecorder({
      runId: "mem-new",
      conversationId: "memory:capture:distill",
      artifactDir: dir,
      artifactKind: "memory",
      source: "memory",
    }).finish({});
    await writeSummary(dir, "mem-legacy.summary.json", {
      runId: "mem-legacy",
      conversationId: "memory:legacy",
      status: "succeeded",
      startedAt: "2026-06-24T10:00:00.000Z",
      endedAt: "2026-06-24T10:00:01.000Z",
      updatedAt: "2026-06-24T10:00:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });
    await writeFile(join(dir, "mem-legacy.events.jsonl"), "", "utf8");

    const defaultList = await listRecordedRuns({ artifactDir: dir });
    expect(defaultList.runs.map((run) => run.runId)).toEqual(["agent-run"]);

    const memoryList = await listRecordedRuns({ artifactDir: dir, scope: "memory" });
    expect(memoryList.runs.map((run) => run.runId).sort()).toEqual(["mem-legacy", "mem-new"]);
    expect(memoryList.runs.find((run) => run.runId === "mem-new")?.summaryFileName).toBe("memory/mem-new.summary.json");
    expect(memoryList.runs.find((run) => run.runId === "mem-legacy")?.summaryFileName).toBe("mem-legacy.summary.json");

    const allList = await listRecordedRuns({ artifactDir: dir, scope: "all" });
    expect(allList.runs.map((run) => run.runId).sort()).toEqual(["agent-run", "mem-legacy", "mem-new"]);

    await expect(readRecordedRun({ artifactDir: dir }, "mem-new")).resolves.toBeUndefined();
    await expect(readRecordedRun({ artifactDir: dir }, "mem-legacy")).resolves.toMatchObject({
      summary: { runId: "mem-legacy" },
    });
    await expect(readRecordedRun({ artifactDir: dir, scope: "memory" }, "mem-new")).resolves.toMatchObject({
      summary: { runId: "mem-new", summaryFileName: "memory/mem-new.summary.json" },
    });
  });

  it("surfaces identity, model, effort, source, sourceDetail, and userInput on both list items and run detail", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({
      runId: "run-meta",
      conversationId: "cron:nightly-digest",
      artifactDir: dir,
      userInput: "Summarize today's digest.",
      source: "cron",
      sourceDetail: "nightly-digest",
    });
    await recorder.finish({
      model: "pi:openai-codex:gpt-5.5",
      effort: "high",
      providerSessionId: "provider-session-1",
      isolated: false,
    });

    const expectedMeta = {
      conversationId: "cron:nightly-digest",
      providerSessionId: "provider-session-1",
      isolated: false,
      model: "pi:openai-codex:gpt-5.5",
      effort: "high",
      source: "cron",
      sourceDetail: "nightly-digest",
      userInput: "Summarize today's digest.",
    };
    const list = await listRecordedRuns({ artifactDir: dir });
    expect(list.runs[0]).toMatchObject(expectedMeta);

    const detail = await readRecordedRun({ artifactDir: dir }, "run-meta");
    expect(detail?.summary).toMatchObject(expectedMeta);
  });

  it("retains bare assignment prose across summary, reader, and session surfaces", async () => {
    const dir = await tempDir();
    const freeText = "password=free-text-value";
    const recorder = createJsonlRunRecorder({
      runId: "run-free-text",
      conversationId: "telegram:1",
      artifactDir: dir,
      userInput: freeText,
      systemPrompt: freeText,
    });
    const summary = await recorder.finish({
      error: freeText,
      failureKind: "runtime_error",
    });

    expect(summary).toMatchObject({
      userInput: freeText,
      systemPrompt: freeText,
      error: freeText,
    });

    const list = await listRecordedRuns({ artifactDir: dir });
    expect(list.runs[0]).toMatchObject({
      userInput: freeText,
      systemPrompt: freeText,
      error: freeText,
    });

    const detail = await readRecordedRun({ artifactDir: dir }, "run-free-text");
    expect(detail?.summary).toMatchObject({
      userInput: freeText,
      systemPrompt: freeText,
      error: freeText,
    });

    const session = mapRunToSession(summary, [], { instanceLabel: "test" });
    expect(session).toMatchObject({
      instr: freeText,
      sysPrompt: freeText,
      error: freeText,
    });
  });

  it("surfaces systemPrompt on both list items and run detail, truncated at maxStringBytes", async () => {
    const dir = await tempDir();
    const systemPrompt = `You are Mono. ${"Follow the identity and recalled memory. ".repeat(20)}`;
    const recorder = createJsonlRunRecorder({ runId: "run-sys", conversationId: "telegram:1", artifactDir: dir });
    await recorder.finish({ systemPrompt });

    const maxStringBytes = 128;
    const list = await listRecordedRuns({ artifactDir: dir, maxStringBytes });
    const listItem = list.runs.find((run) => run.runId === "run-sys");
    expect(listItem?.systemPrompt).toBeDefined();
    // Re-bounded at the reader's maxStringBytes -> the head plus a "[truncated …]" tail.
    expect(listItem!.systemPrompt).toContain("[truncated");
    expect(listItem!.systemPrompt!.startsWith("You are Mono.")).toBe(true);
    expect(listItem!.systemPrompt!.length).toBeLessThan(systemPrompt.length);

    const detail = await readRecordedRun({ artifactDir: dir, maxStringBytes }, "run-sys");
    expect(detail?.summary.systemPrompt).toBe(listItem?.systemPrompt);
  });

  it("exposes summary artifact metadata for sanitized run filenames", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "Run:Detail", conversationId: "chat-1", artifactDir: dir });
    const summary = await recorder.finish({});

    const list = await listRecordedRuns({ artifactDir: dir });

    expect(summary.artifactPaths[1]).toMatch(/run-detail\.summary\.json$/u);
    expect(list.runs[0]).toMatchObject({
      runId: "Run:Detail",
      summaryFileName: "run-detail.summary.json",
    });
    expect(list.runs[0]?.summaryMtimeMs).toBeGreaterThan(0);

    const detail = await readRecordedRun({ artifactDir: dir }, "Run:Detail");
    expect(detail?.summary).toMatchObject({
      runId: "Run:Detail",
      summaryFileName: "run-detail.summary.json",
    });
    expect(detail?.summary.summaryMtimeMs).toBeGreaterThan(0);
  });

  it("normalizes epoch-string and epoch-number timestamps to ISO, passing ISO strings through unchanged", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "run-epoch", conversationId: "chat-1", artifactDir: dir });
    const summary = await recorder.finish({});
    // Overwrite the (empty) events file with raw provider-shaped lines exercising
    // every timestamp shape the reader must normalize.
    await writeFile(
      summary.artifactPaths[0] ?? "",
      `${[
        JSON.stringify({ type: "provider_request_started", timestamp: "1778952408375" }), // 13-digit epoch ms (string)
        JSON.stringify({ type: "provider_request_started", timestamp: "1778952408" }), // 10-digit epoch seconds (string)
        JSON.stringify({ type: "provider_request_started", timestamp: 1778952409123 }), // 13-digit epoch ms (number)
        JSON.stringify({ type: "provider_request_started", timestamp: 1778952410 }), // 10-digit epoch seconds (number)
        JSON.stringify({ type: "assistant", timestamp: "2026-05-16T08:00:00.000Z" }), // ISO passthrough
      ].join("\n")}\n`,
      "utf8",
    );

    const detail = await readRecordedRun({ artifactDir: dir }, "run-epoch");
    expect(detail?.events.map((event) => event.timestamp)).toEqual([
      new Date(1778952408375).toISOString(),
      new Date(1778952408_000).toISOString(),
      new Date(1778952409123).toISOString(),
      new Date(1778952410_000).toISOString(),
      "2026-05-16T08:00:00.000Z",
    ]);
  });

  it("reads event timelines, classifies visible runtime events, caps events, and warns for malformed lines", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "Run:Detail", conversationId: "chat-1", artifactDir: dir });
    recorder.onEvent({ type: "thinking.delta", summary: "checking available tools" });
    recorder.onEvent({ type: "tool.call", toolName: "Read", status: "started", token: "hide-me" });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "visible response" }] } });
    const summary = await recorder.finish({ cost: { totalUsd: 0.01 } });
    await writeFile(summary.artifactPaths[0] ?? "", `${await readFile(summary.artifactPaths[0] ?? "", "utf8")}not-json\n`, "utf8");

    const detail = await readRecordedRun({ artifactDir: dir, maxEventsPerRun: 2 }, "Run:Detail");

    expect(detail?.summary).toMatchObject({ runId: "Run:Detail", conversationId: "chat-1", eventCount: 3 });
    expect(detail?.events).toHaveLength(2);
    expect(detail?.events.map((event) => event.category)).toEqual(["thinking", "tool"]);
    expect(detail?.events[0]?.summary).toMatch(/checking available tools/u);
    expect(detail?.events[1]?.label).toBe("Tool: Read");
    expect(JSON.stringify(detail?.events)).not.toContain("hide-me");
    expect(detail?.warnings).toEqual(["Event list was capped at 2 events."]);
  });

  it("can retain the true event tail when a bounded detail read is capped", async () => {
    const dir = await tempDir();
    const recorder = createJsonlRunRecorder({ runId: "long-run", conversationId: "chat-1", artifactDir: dir });
    for (let index = 0; index < 6; index += 1) {
      recorder.onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: `visible-${String(index)}` }] },
      });
    }
    await recorder.finish({});

    const detail = await readRecordedRun({
      artifactDir: dir,
      maxEventsPerRun: 4,
      eventSelection: "head-tail",
    }, "long-run");

    expect(detail?.events.map((event) => JSON.stringify(event.payload))).toEqual([
      expect.stringContaining("visible-0"),
      expect.stringContaining("visible-1"),
      expect.stringContaining("visible-4"),
      expect.stringContaining("visible-5"),
    ]);
    expect(detail?.events.map((event) => event.index)).toEqual([0, 1, 4, 5]);
    expect(detail?.warnings).toEqual([
      "Event list was capped at 4 events using first-and-last selection.",
    ]);
  });

  it("classifies assistant thinking content blocks as thinking events", () => {
    expect(classifyRecordedRunEvent({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "I need to inspect the trace." },
          { type: "thinking", text: "Then group adjacent chunks." },
        ],
      },
    })).toBe("thinking");

    expect(classifyRecordedRunEvent({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Visible answer." }],
      },
    })).toBe("message");
  });

  it("continues past invalid summary files with warnings", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "bad.summary.json"), "{bad", "utf8");
    const good = createJsonlRunRecorder({ runId: "good", conversationId: "chat", artifactDir: dir });
    await good.finish({});

    const list = await listRecordedRuns({ artifactDir: dir });

    expect(list.totalRuns).toBe(1);
    expect(list.runs.map((run) => run.runId)).toEqual(["good"]);
    expect(list.warnings[0]).toMatch(/Skipping bad.summary.json: invalid JSON/u);
  });

  it("refuses run ids that could be path traversal", async () => {
    const dir = await tempDir();
    await expect(readRecordedRun({ artifactDir: dir }, "../secrets")).rejects.toBeInstanceOf(ObservabilityReadError);
    await expect(readRecordedRun({ artifactDir: dir }, "nested/run")).rejects.toMatchObject({ code: "invalid_run_id" });
  });
});

describe("reconcileStaleRunArtifacts", () => {
  async function writeSummary(dir: string, name: string, summary: Record<string, unknown>): Promise<void> {
    await writeFile(join(dir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  it("rewrites orphaned running runs (started before the cutoff) to interrupted, leaving live and terminal runs", async () => {
    const dir = await tempDir();
    const cutoff = Date.parse("2026-05-15T12:00:00.000Z");
    await writeSummary(dir, "orphan.summary.json", {
      runId: "orphan", conversationId: "c", status: "running", startedAt: "2026-05-15T11:00:00.000Z",
    });
    await writeSummary(dir, "live.summary.json", {
      runId: "live", conversationId: "c", status: "running", startedAt: "2026-05-15T12:30:00.000Z",
    });
    await writeSummary(dir, "done.summary.json", {
      runId: "done", conversationId: "c", status: "succeeded", startedAt: "2026-05-15T10:00:00.000Z", endedAt: "2026-05-15T10:01:00.000Z",
    });

    const result = await reconcileStaleRunArtifacts(dir, {
      startedBeforeMs: cutoff,
      clock: () => Date.parse("2026-05-15T13:00:00.000Z"),
    });

    expect(result.reconciled).toEqual(["orphan"]);
    expect(result.warnings).toEqual([]);

    const orphan = JSON.parse(await readFile(join(dir, "orphan.summary.json"), "utf8")) as Record<string, unknown>;
    expect(orphan.status).toBe("interrupted");
    expect(orphan.failureKind).toBe("process_death");
    expect(orphan.endedAt).toBe("2026-05-15T13:00:00.000Z");

    // A "running" run started after the cutoff belongs to THIS process — must be untouched.
    const live = JSON.parse(await readFile(join(dir, "live.summary.json"), "utf8")) as Record<string, unknown>;
    expect(live.status).toBe("running");
    const done = JSON.parse(await readFile(join(dir, "done.summary.json"), "utf8")) as Record<string, unknown>;
    expect(done.status).toBe("succeeded");
  });

  it("returns empty for a missing artifact directory", async () => {
    const dir = join(await tempDir(), "missing");
    await expect(reconcileStaleRunArtifacts(dir, { startedBeforeMs: 0 })).resolves.toEqual({ reconciled: [], warnings: [] });
  });
});

describe("deriveRunSource", () => {
  it("maps each known conversationId prefix to its source, and falls back to \"other\"", () => {
    expect(deriveRunSource("telegram:12345")).toBe("telegram");
    expect(deriveRunSource("slack:C123:U456")).toBe("slack");
    expect(deriveRunSource("cron:nightly-digest")).toBe("cron");
    expect(deriveRunSource("webhook:my-endpoint")).toBe("webhook");
    expect(deriveRunSource("memory:capture:distill")).toBe("memory");
    expect(deriveRunSource("a2a:peer-1")).toBe("a2a");
    expect(deriveRunSource("openai:thread-1")).toBe("openai-api");
    expect(deriveRunSource("tui-local")).toBe("tui");
    expect(deriveRunSource("tui:session-1")).toBe("tui");
    expect(deriveRunSource("something-else")).toBe("other");
  });
});
