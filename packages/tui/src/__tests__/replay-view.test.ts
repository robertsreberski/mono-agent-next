import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUI } from "@earendil-works/pi-tui";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReplayTimelineItem } from "../data/replay.js";
import { sessionBoundaryNotice } from "../ui/session-boundary.js";
import { buildDetailCell, buildRawPayloadBody } from "../ui/views/replay-detail.js";
import { ReplayView } from "../ui/views/replay.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-replay-view-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(): ReplayView {
  const tui = new TUI(new TestTerminal(100, 30));
  return new ReplayView({ tui });
}

/** pi-tui coalesces nothing on its own render(); this just gives async fs reads a tick to settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function renderText(view: ReplayView): string {
  return stripAnsi(view.render(100).join("\n"));
}

/**
 * Rendered lines, ANSI-stripped and trimmed of the Text component's own
 * left/right margin padding -- lets a "bare `{`/`}` line" check (the raw JSON
 * body's own opening/closing brace) ignore that padding rather than requiring
 * an exact zero-padding match.
 */
function trimmedLines(view: ReplayView): string[] {
  return view.render(100).map((line) => stripAnsi(line).trim());
}

function runtimeTimelineItem(index: number, payload: Record<string, unknown>): ReplayTimelineItem {
  const type = typeof payload.type === "string" ? payload.type : undefined;
  return {
    index,
    ...(type === undefined ? {} : { type }),
    category: "runtime",
    timestamp: "2026-07-16T00:00:00.000Z",
    label: type ?? "Runtime event",
    summary: JSON.stringify(payload),
    payload,
    sourceEventCount: 1,
    sourceEventStartIndex: index,
    sourceEventEndIndex: index,
    endTimestamp: "2026-07-16T00:00:00.000Z",
    turnIndex: 0,
  };
}

function renderDetailCell(item: ReplayTimelineItem): string | undefined {
  const cell = buildDetailCell(item, [item], []);
  return cell === undefined ? undefined : stripAnsi(cell.render(160).join("\n")).trim();
}

function normalizedJSDocBefore(source: string, anchor: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`Expected one source anchor, found ${parts.length - 1}: ${anchor}`);
  }
  const prefix = parts[0]!.trimEnd();
  const commentStart = prefix.lastIndexOf("/**");
  const commentEnd = commentStart < 0 ? -1 : prefix.indexOf("*/", commentStart);
  if (commentStart < 0 || commentEnd !== prefix.length - 2) {
    throw new Error(`Missing adjacent JSDoc before source anchor: ${anchor}`);
  }
  return prefix
    .slice(commentStart)
    .replace(/^\s*\/\*\*\s?/u, "")
    .replace(/\s*\*\/\s*$/u, "")
    .replace(/^\s*\*\s?/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

async function openRun(view: ReplayView, runId: string): Promise<void> {
  view.list.onSelect?.({ value: runId, label: "", description: "" });
  await flush();
}

describe("replay projection contract comments", () => {
  it("rejects an intervening block comment between a contract JSDoc and its anchor", () => {
    const separated = [
      "/** bounded key-pattern contract */",
      "/* unrelated intervening comment */",
      "const REPLAY_MAX_STRING_BYTES = 32_768;",
    ].join("\n");

    expect(() => normalizedJSDocBefore(separated, "const REPLAY_MAX_STRING_BYTES")).toThrow(
      "Missing adjacent JSDoc before source anchor",
    );
  });

  it("pins the bounded key-pattern and retained-free-text boundary at every replay layer", async () => {
    const contracts = [
      ["../data/replay.ts", "const REPLAY_MAX_STRING_BYTES"],
      ["../ui/views/replay.ts", "export class ReplayView"],
      ["../ui/views/replay-detail.ts", "export function buildDetailCell"],
      ["../ui/views/replay-detail.ts", "function extractFullText"],
    ] as const;
    const sources = new Map<string, string>();

    for (const [relativeSource, anchor] of contracts) {
      let source = sources.get(relativeSource);
      if (source === undefined) {
        source = await readFile(new URL(relativeSource, import.meta.url), "utf8");
        sources.set(relativeSource, source);
      }
      const comment = normalizedJSDocBefore(source, anchor);
      expect(comment).toContain("bounded");
      expect(comment).toContain("key-pattern");
      expect(comment).toContain("non-numeric values under sensitive-looking object keys are redacted");
      expect(comment).toContain("numeric values under matched keys are retained");
      expect(comment).toContain("retained free text is not content-scanned");
    }

    const staleAbsolutes = [
      /show the \(redacted\) payload in full/iu,
      /\bredacted\s*,\s*bounded\b/iu,
      /\balready redacted(?:\/capped)?\b/iu,
      /\bredacted raw event\b/iu,
      /\braw redacted event\b/iu,
    ];
    for (const [relativeSource, source] of sources) {
      for (const staleAbsolute of staleAbsolutes) {
        expect(source.match(staleAbsolute), `${relativeSource}: ${staleAbsolute.source}`).toBeNull();
      }
    }
  });
});

/**
 * Two turns: coalesced thinking -> tool_use ("bash") -> tool_result -> thinking
 * -> text (mentioning "bash" again, so search has 2 matches). summary carries
 * model/effort/source directly (no run_config fallback, no override).
 */
async function writeMultiTurnFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "telegram:1",
    artifactDir: dir,
    source: "telegram",
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "thinking", text: "let me think " }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { content: [{ type: "thinking", text: "some more" }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
  });
  recorder.onEvent({
    type: "user",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { content: [{ type: "thinking", text: "done" }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: { content: [{ type: "text", text: "bash finished, final answer" }] },
  });
  await recorder.finish({ text: "bash finished, final answer", model: "claude-fable-5", effort: "high" });
}

/** A single tool call whose result is an error (`is_error: true`) -- exercises the unified call+result ToolPanel's failure path. */
async function writeFailedToolCallFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({ runId, conversationId: "telegram:1", artifactDir: dir });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "rm -rf /nope" } }] },
  });
  recorder.onEvent({
    type: "user",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "permission denied", is_error: true }] },
  });
  await recorder.finish({ text: "couldn't do that" });
}

/**
 * A parallel tool batch: two separate `tool_use` events (t1 then t2 -- a real
 * pi-runtime parallel batch streams each call as its own event, per
 * TimelineTurn's own doc comment), then ONE `user` event carrying BOTH
 * tool_result blocks together (`countToolResultBlocks` documents "a single
 * `user` event CAN carry more than one `tool_result` block"). t2's result is
 * NOT the first block in that batched event, so matching it exercises
 * scanning every block in a candidate item rather than stopping at the first.
 */
async function writeParallelToolBatchFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({ runId, conversationId: "telegram:1", artifactDir: dir });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.500Z",
    message: { content: [{ type: "tool_use", id: "t2", name: "read_file", input: { path: "x.txt" } }] },
  });
  recorder.onEvent({
    type: "user",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "a.txt" },
        { type: "tool_result", tool_use_id: "t2", content: "file contents here" },
      ],
    },
  });
  await recorder.finish({ text: "done" });
}

/**
 * Pre-timestamp-stamping artifact: no ISO timestamps anywhere, no
 * summary.model/effort/source, but a `run_config` event with overridden:true
 * to fall back to. Hand-written after `finish()` (recorder.onEvent always
 * stamps a timestamp when one is absent), mirroring replay-data.test.ts's
 * "run-no-timestamps" pattern.
 */
async function writeOldStyleFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "slack:99",
    artifactDir: dir,
  });
  const summary = await recorder.finish({ text: "hello from the past" });
  const lines = [
    { type: "run_config", model: "model-old", effort: "medium", executionMode: "agentic", overridden: true },
    { type: "assistant", message: { content: [{ type: "text", text: "hello from the past" }] } },
  ];
  await writeFile(summary.artifactPaths[0] ?? "", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/** Single tool_use event with a payload big enough (>12 lines, <40) to exercise expand/collapse. */
async function writeBigPayloadFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "telegram:1",
    artifactDir: dir,
  });
  const bigInput = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, `value-${i}`]));
  recorder.onEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: bigInput }] },
  });
  await recorder.finish({ text: "done" });
}

/**
 * Two coalesced thinking chunks whose joined text (300 chars) exceeds
 * SUMMARY_MAX_CHARS (220) -- proves the pane reconstructs the FULL text from
 * the raw events rather than showing the compacted (truncated) `summary`.
 * ISO timestamps 2s apart so `setDurationMs` has a span to compute.
 */
async function writeLongThinkingFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({ runId, conversationId: "telegram:1", artifactDir: dir });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "thinking", text: "a".repeat(150) }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { content: [{ type: "thinking", text: "b".repeat(150) }] },
  });
  await recorder.finish({ text: "done" });
}

/**
 * A plain (non-tool) user message, a runtime/telemetry event that is NOT
 * `runtime_warning` (provider_request_started), and a `runtime_warning` event
 * -- covers the three pane branches Part B splits out of the old
 * blanket-raw-JSON rendering: user message -> UserCell, generic runtime ->
 * kept as raw JSON, `runtime_warning` -> NoticeCell.
 */
async function writeCellShowcaseFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({ runId, conversationId: "telegram:1", artifactDir: dir });
  recorder.onEvent({
    type: "user",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "text", text: "hi from user" }] },
  });
  recorder.onEvent({
    type: "provider_request_started",
    timestamp: "2026-01-01T00:00:00.500Z",
    model: "gpt-5.5",
  });
  recorder.onEvent({
    type: "runtime_warning",
    timestamp: "2026-01-01T00:00:00.700Z",
    message: "provider degraded",
  });
  await recorder.finish({ text: "hello back" });
}

async function writeSessionBoundaryFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({ runId, conversationId: "telegram:42#2026-07-16", artifactDir: dir });
  recorder.onEvent({
    type: "session_boundary",
    timestamp: "2026-07-16T00:00:00.000Z",
    kind: "rollover",
    previousConversationId: "telegram:42#2026-07-15",
    conversationId: "telegram:42#2026-07-16",
    reason: "daily_rollover",
  });
  await recorder.finish({ text: "ready" });
}

async function writeHostileSessionBoundaryFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({ runId, conversationId: "telegram:42#2026-07-16", artifactDir: dir });
  recorder.onEvent({
    type: "session_boundary",
    timestamp: "2026-07-16T00:00:00.000Z",
    summary: "row-only\u009b\u202e",
    kind: "roll\u001b[2J-over",
    previousConversationId: "previous\u001b]52;c;payload\u0007",
    conversationId: "current\u001b_payload\u001b\\",
    reason: "daily_rollover",
    rawOnly: "raw-only\u0085\u2066",
  });
  await recorder.finish({ text: "ready" });
}

/** cron run identified by sourceDetail (job id); no userInput. Fixed clock => deterministic 0ms duration. */
async function writeCronFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "cron:1",
    artifactDir: dir,
    source: "cron",
    sourceDetail: "daily-digest",
    clock: () => 0,
  });
  await recorder.finish({ text: "ok" });
}

/** telegram run with no sourceDetail, identified by its userInput. Fixed clock => deterministic 0ms duration. */
async function writeUserInputFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "telegram:1",
    artifactDir: dir,
    userInput: "summarize my inbox",
    clock: () => 0,
  });
  await recorder.finish({
    text: "ok",
    model: "pi:openai:gpt-5.5",
    effort: "high",
    usage: { input: 1_200, output: 340 },
    cost: { totalUsd: 0.045 },
  });
}

/** slack run with neither sourceDetail nor userInput -- falls back to conversationId. */
async function writeBareFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "slack:7",
    artifactDir: dir,
    clock: () => 0,
  });
  await recorder.finish({ text: "ok" });
}

/** failed run (failureKind set, no error string) for status-filter coverage. */
async function writeFailedFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "webhook:1",
    artifactDir: dir,
    clock: () => 0,
  });
  await recorder.finish({ text: "", failureKind: "provider_unavailable" });
}

/** cancelled run (status "cancelled", neither succeeded nor failed) for status-filter coverage. */
async function writeCancelledFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "webhook:2",
    artifactDir: dir,
    clock: () => 0,
  });
  await recorder.finish({ text: "", cancelled: true });
}

describe("ReplayView list mode", () => {
  it("leads the label with sourceDetail (job id) over conversationId for a cron-sourced run", async () => {
    await writeCronFixture("run-cron");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain("[cron] daily-digest");
    expect(text).not.toContain("cron:1");
  });

  it("falls back to a quoted, compacted userInput preview when sourceDetail is absent", async () => {
    await writeUserInputFixture("run-input");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain('[telegram] "summarize my inbox"');
  });

  it("falls back to conversationId when neither sourceDetail nor userInput is present", async () => {
    await writeBareFixture("run-bare");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain("[slack] slack:7");
  });

  it("description carries duration, event count, model@effort, and token usage", async () => {
    await writeUserInputFixture("run-input");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain("0ms");
    expect(text).toContain("0 ev");
    expect(text).toContain("gpt-5.5@high");
    expect(text).toContain("↑1.2k ↓340");
    expect(text).toContain("$0.045");
  });

  it("`s` cycles the source filter (refetching, showing zero matches for an empty source, header reflects it) and back to all", async () => {
    await writeCronFixture("run-cron");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    expect(renderText(view)).toContain("[cron] daily-digest");

    // all -> tui (no tui runs recorded in this fixture dir).
    view.handleInput("s");
    await flush();
    let text = renderText(view);
    expect(text).toContain("source: tui");
    expect(text).not.toContain("daily-digest");

    // tui -> telegram -> slack -> cron -> webhook -> memory -> other -> all.
    for (let i = 0; i < 7; i += 1) {
      view.handleInput("s");
      await flush();
    }
    text = renderText(view);
    expect(text).not.toContain("source:");
    expect(text).toContain("daily-digest");
  });

  it("`x` cycles the status filter to failed-only, then succeeded, then back to all; a cancelled run is strictly excluded from both buckets", async () => {
    await writeCronFixture("run-cron"); // succeeded
    await writeFailedFixture("run-failed");
    await writeCancelledFixture("run-cancelled");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    expect(renderText(view)).toContain("(3/3)");

    view.handleInput("x"); // all -> failed
    let text = renderText(view);
    expect(text).toContain("status: failed");
    // Strict "failed" bucket: only the genuinely failed run, NOT the
    // cancelled one -- a naive "!== succeeded" filter would have swept it in.
    expect(text).toContain("(1/3)");
    expect(text).not.toContain("daily-digest");

    view.handleInput("x"); // failed -> succeeded
    text = renderText(view);
    expect(text).toContain("status: succeeded");
    expect(text).toContain("(1/3)");
    expect(text).toContain("daily-digest");

    view.handleInput("x"); // succeeded -> all
    text = renderText(view);
    expect(text).not.toContain("status:");
    expect(text).toContain("(3/3)");
  });
});

describe("ReplayView detail mode", () => {
  it("shows the headline with a source badge, model, and effort (no override marker) after opening a run", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    const text = renderText(view);
    expect(text).toContain("run run-a");
    expect(text).toContain("[telegram]");
    expect(text).toContain("claude-fable-5");
    expect(text).toContain("effort:high");
    expect(text).not.toContain("(override)");
  });

  it("falls back to run_config for model/effort/source on an old (pre-timestamp) artifact, marking them as override, without crashing", async () => {
    await writeOldStyleFixture("run-old");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-old");

    const text = renderText(view);
    expect(text).toContain("[slack]"); // derived from conversationId, no persisted source
    expect(text).toContain("model-old");
    expect(text).toContain("effort:medium");
    expect(text).toContain("(override)");
    // No per-row clock/delta column anywhere (no item carries a timestamp).
    expect(text).not.toMatch(/\+\d+(ms|s)/u);
  });

  it("shows the override marker even when model/effort are persisted directly on the summary (not via run_config fallback)", async () => {
    // A newer artifact: `run_config` fires with overridden:true, but the
    // FINAL summary also carries model/effort directly (no fallback needed
    // to display them). The marker must key off runConfig.overridden alone.
    const recorder = createJsonlRunRecorder({
      runId: "run-overridden-summary",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    recorder.onEvent({
      type: "run_config",
      model: "model-b",
      effort: "high",
      executionMode: "agentic",
      overridden: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await recorder.finish({ text: "hi", model: "model-b", effort: "high" });

    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-overridden-summary");

    const text = renderText(view);
    expect(text).toContain("model-b");
    expect(text).toContain("effort:high");
    expect(text).toContain("(override)");
  });

  it("`t` filters to thinking-only rows and `a` restores; status line reflects the active filter", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    view.handleInput("t");
    let text = renderText(view);
    expect(text).toContain("filters: thinking");
    expect(text).not.toContain("Tool:");

    view.handleInput("a");
    text = renderText(view);
    expect(text).not.toContain("filters:");
    expect(text).toContain("Tool:");
  });

  it("hides the payload pane when the category filter matches zero rows (filtered-out selection)", async () => {
    await writeMultiTurnFixture("run-a"); // thinking/tool/message only -- no "error" category items.
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    // Sanity: something is selected and its payload shows before filtering.
    expect(renderText(view)).toContain("let me think");

    view.handleInput("e"); // filter to error-only -- zero matches in this fixture.
    const text = renderText(view);
    expect(text).toContain("no events match");
    // No stale payload body (header index markers or prior content) should
    // survive into a pane that's supposed to be empty when nothing is
    // selected/visible.
    expect(text).not.toMatch(/#\d+ /u);
    expect(text).not.toContain("let me think");
  });

  it("hides the payload pane for a run with an entirely empty timeline (empty selection)", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-empty-timeline",
      conversationId: "telegram:1",
      artifactDir: dir,
    });
    await recorder.finish({ text: "" }); // No onEvent calls at all -- zero timeline items.

    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-empty-timeline");

    const text = renderText(view);
    expect(text).toContain("no events");
    expect(text).not.toMatch(/#\d+ /u);
  });

  it("`]` jumps the selection to the next turn (status line reflects it)", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    const before = renderText(view);
    expect(before).toContain("turn 1/2");

    view.handleInput("]");
    const after = renderText(view);
    expect(after).toContain("turn 2/2");
  });

  it("commits a search via / + typing + enter, jumps to a match, advances with n, and unwinds via esc layering (search -> collapse -> list)", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    view.handleInput("/");
    for (const ch of "bash") {
      view.handleInput(ch);
    }
    expect(renderText(view)).toContain('search: "bash█"');
    view.handleInput("\x7f"); // backspace
    expect(renderText(view)).toContain('search: "bas█"');
    view.handleInput("h"); // retype -- back to "bash"

    view.handleInput("\r"); // commit
    let text = renderText(view);
    expect(text).toContain('search: "bash" (2 matches)');
    // Committing jumps the selection to a match: the tool_use item ("Tool: bash").
    expect(text).toContain("Tool: bash");

    view.handleInput("n"); // advance to the next match (the closing text item)
    text = renderText(view);
    expect(text).toContain("bash finished, final answer");

    // Set up the second esc-layer: expand the payload pane (enter, since
    // search input is no longer open here).
    view.handleInput("\r");

    // Layer 1: committed search clears first.
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(true);
    expect(renderText(view)).not.toContain("search:");

    // Layer 2: payload expansion collapses next.
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(true);

    // Layer 3: returns to the run list.
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(false);

    // Already at the list -- back() is a no-op (existing behavior).
    expect(view.back()).toBe(false);
  });

  it("`enter` reveals the raw JSON payload below the chat-style cell; `enter` again collapses it", async () => {
    await writeBigPayloadFixture("run-big");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-big");

    // Collapsed: the chat-style ToolPanel cell only -- no pretty-printed JSON
    // strip below it. A bare "{" LINE (the raw JSON's opening brace on its
    // own line, ignoring the Text component's own left/right margin padding)
    // is the tell; the panel's own single-line args preview also contains
    // braces, just never isolated on their own (trimmed) line.
    const collapsedLines = trimmedLines(view);
    expect(collapsedLines).not.toContain("{");
    expect(collapsedLines.join("\n")).toContain("bash");

    view.handleInput("\r"); // expand
    const expandedLines = trimmedLines(view);
    expect(expandedLines).toContain("{");
    expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);

    view.handleInput("\r"); // collapse again
    expect(trimmedLines(view)).not.toContain("{");
  });

  it("shows a coalesced thinking item as chat's ∴ thought cell, joining retained raw-event text instead of the compacted summary", async () => {
    await writeLongThinkingFixture("run-long-thinking");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-long-thinking");

    const text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("∴ thought"); // active: false -- a recorded run is never "still thinking"
    expect(text).not.toContain("∴ thinking…");
    // All 150 "b"s must be present -- word-wrap wraps the contiguous run
    // across several rendered lines, so count occurrences rather than look
    // for one unbroken substring. The row-list preview (`item.summary`,
    // truncated at 220 chars) contributes at most 70 "b"s on its own, so
    // reaching 150 proves the pane reconstructed the FULL text, not the
    // compacted summary.
    const bCount = (text.match(/b/gu) ?? []).length;
    expect(bCount).toBeGreaterThanOrEqual(150);
    expect(text).toContain("2.0s"); // the item's own (endTimestamp - timestamp) span
  });

  it("shows a tool_use item as chat's ToolPanel, unified with its matching tool_result", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    view.handleInput("o"); // filter to tool-category rows -- snaps selection to the tool_use item
    const text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("✓ bash");
    expect(text).toContain("a.txt"); // the matched tool_result's content, unified into the same panel
    expect(text).not.toContain("◐"); // never a misleading "still pending" glyph for a recorded run
  });

  it("marks the unified tool_use+tool_result panel as an error when the matched result's `is_error` is true", async () => {
    await writeFailedToolCallFixture("run-failed-tool");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-failed-tool");

    // Item 0 (default selection) is the tool_use call; it must reflect the
    // matched result's error state, not render a false ✓ success.
    const text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("✗ bash");
    expect(text).not.toContain("✓ bash");
    expect(text).toContain("permission denied");
  });

  it("matches a tool_use to its tool_result even when the result isn't the FIRST tool_result block in a batched (parallel-calls) event", async () => {
    await writeParallelToolBatchFixture("run-parallel-tools");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-parallel-tools");

    view.handleInput("\x1b[B"); // down -- item 1 is the SECOND tool_use call (t2/read_file)
    const text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("✓ read_file");
    expect(text).toContain("file contents here"); // t2's result, the SECOND block in the batched event
  });

  it("shows a plain user message as chat's UserCell, keeps generic runtime JSON, and notices runtime_warning", async () => {
    await writeCellShowcaseFixture("run-showcase");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-showcase");

    // Item 0 (default selection): plain user message -> UserCell.
    let text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("you hi from user");

    // Item 1: generic runtime/telemetry event -> still raw JSON (untouched).
    view.handleInput("\x1b[B"); // down
    expect(trimmedLines(view)).toContain("{");
    text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("provider_request_started");

    // Item 2: runtime_warning -> NoticeCell, not raw JSON.
    view.handleInput("\x1b[B"); // down
    expect(trimmedLines(view)).not.toContain("{");
    text = stripAnsi(view.render(100).join("\n"));
    expect(text).toContain("⚠ provider degraded");
  });

  it("shows a recorded session boundary as a friendly collapsed notice while preserving raw expansion", async () => {
    await writeSessionBoundaryFixture("run-boundary");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-boundary");

    const collapsed = trimmedLines(view);
    expect(collapsed).toContain(
      "i session boundary: rollover · daily rollover · telegram:42#2026-07-15 -> telegram:42#2026-07-16",
    );
    expect(collapsed).not.toContain("{");

    view.handleInput("\r");
    expect(trimmedLines(view)).toContain("{");
  });

  it("renders only exact session-boundary replay events with the live friendly notice contract", () => {
    const direct = runtimeTimelineItem(0, {
      type: "session_boundary",
      kind: "rollover",
      previousConversationId: "telegram:42#2026-07-15",
      conversationId: "telegram:42#2026-07-16",
      reason: "daily_rollover",
    });
    expect(renderDetailCell(direct)).toBe(
      "i session boundary: rollover · daily rollover · telegram:42#2026-07-15 -> telegram:42#2026-07-16",
    );

    const liveShape = runtimeTimelineItem(1, {
      type: "runtime_telemetry",
      kind: "session_boundary",
      data: {
        type: "session_boundary",
        kind: "rollover",
        previousConversationId: "telegram:42#2026-07-15",
        conversationId: "telegram:42#2026-07-16",
        reason: "daily_rollover",
      },
    });
    expect(renderDetailCell(liveShape)).toBe(renderDetailCell(direct));

    const adjacentSessionEvent = runtimeTimelineItem(2, {
      type: "session_boundary_started",
      kind: "rollover",
    });
    const unrelatedTelemetry = runtimeTimelineItem(3, {
      type: "runtime_telemetry",
      kind: "cache_hit",
      data: { kind: "cache_hit", tokens: 400 },
    });
    expect(buildDetailCell(adjacentSessionEvent, [adjacentSessionEvent], [])).toBeUndefined();
    expect(buildDetailCell(unrelatedTelemetry, [unrelatedTelemetry], [])).toBeUndefined();
  });

  it("makes persisted session-boundary fields terminal-inert before notice rendering", () => {
    // Assert the formatter directly: stripAnsi would erase an injected escape
    // sequence and could turn a vulnerable NoticeCell assertion falsely green.
    const notice = sessionBoundaryNotice({
      type: "session_boundary",
      kind: "roll\u001b[2J-over",
      reason: "daily\nrollover\r\t\u0000\u007f\u009b\u202e",
      previousConversationId: "previous\u001b]52;c;payload\u0007",
      conversationId: "current\u001b_cursor\u001b\\",
    });

    expect(notice).toContain("session boundary: roll\\u001b[2J over");
    expect(notice).toContain("daily\\u000arollover\\u000d\\u0009\\u0000\\u007f\\u009b\\u202e");
    expect(notice).toContain("previous\\u001b]52;c;payload\\u0007 -> current\\u001b_cursor\\u001b\\");
    expect(notice).not.toMatch(/[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u);

    const resumeNotice = sessionBoundaryNotice({
      type: "session_boundary",
      kind: "resume_replay",
      providerSessionId: "provider\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007",
    });
    expect(resumeNotice).toContain(
      "provider provider\\u001b]8;;https://example.invalid\\u0007link\\u001b]8;;\\u0007",
    );
    expect(resumeNotice).not.toMatch(/[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u);
  });

  it("keeps hostile persisted session-boundary controls inert in the event row and raw expansion", async () => {
    await writeHostileSessionBoundaryFixture("run-hostile-boundary");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-hostile-boundary");

    const collapsed = view.render(100).join("\n");
    expect(collapsed).toContain("row-only\\u009b\\u202e");
    expect(collapsed).not.toContain("raw-only");
    expect(collapsed).not.toContain("\u009b");
    expect(collapsed).not.toContain("\u202e");
    expect(collapsed).not.toContain("\u001b]52;c;payload\u0007");

    view.handleInput("\r");
    const expanded = view.render(100).join("\n");
    expect(expanded).toContain("row-only\\u009b\\u202e");
    expect(expanded).toContain("raw-only\\u0085\\u2066");
    expect(expanded).not.toContain("\u009b");
    expect(expanded).not.toContain("\u0085");
    expect(expanded).not.toContain("\u202e");
    expect(expanded).not.toContain("\u2066");
    expect(expanded).not.toContain("\u001b]52;c;payload\u0007");

    const directRaw = buildRawPayloadBody({
      ...runtimeTimelineItem(0, { type: "runtime" }),
      payload: "raw\n\u001b]52;c;payload\u0007\u009b\u202e",
    }, true);
    expect(directRaw).toBe("raw\\u000a\\u001b]52;c;payload\\u0007\\u009b\\u202e");
  });

  it("esc from plain detail (no search, no expansion) returns to the list (regression)", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    expect(view.isInDetail()).toBe(true);
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(false);
    expect(view.back()).toBe(false);
  });
});
