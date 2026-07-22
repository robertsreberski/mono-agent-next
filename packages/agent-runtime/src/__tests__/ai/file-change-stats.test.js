import { describe, expect, it, vi } from "vitest";
import { statsForCompletedChange } from "../../ai/file-change-stats.js";
import { generateClaudeResponse } from "../../ai/providers/claude-sdk.js";
import { normalizeCodexItemEvent } from "../../ai/streaming/codex-events.js";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

function snapshot(content) {
  return { exists: true, content, line_count: content.split("\n").length };
}

function missing() {
  return { exists: false, line_count: 0 };
}

describe("statsForCompletedChange", () => {
  it("emits hunks for a single-line edit", () => {
    const before = snapshot("a\nb\nc");
    const after = snapshot("a\nB\nc");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats).toMatchObject({
      before_lines: 3,
      after_lines: 3,
      added_lines: 1,
      removed_lines: 1,
      changed_lines: 2,
    });
    expect(stats.hunks).toEqual([{ start: 2, end: 2 }]);
  });

  it("emits multi-region hunks for non-adjacent edits", () => {
    const before = snapshot("a\nb\nc\nd\ne\nf\ng");
    const after = snapshot("A\nb\nc\nD\ne\nf\nG");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.hunks).toEqual([
      { start: 1, end: 1 },
      { start: 4, end: 4 },
      { start: 7, end: 7 },
    ]);
    expect(stats.added_lines).toBe(3);
    expect(stats.removed_lines).toBe(3);
  });

  it("merges consecutive added lines into a single hunk", () => {
    const before = snapshot("a\nb");
    const after = snapshot("a\nX\nY\nZ\nb");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.hunks).toEqual([{ start: 2, end: 4 }]);
    expect(stats.added_lines).toBe(3);
    expect(stats.removed_lines).toBe(0);
  });

  it("records pure-insert at the top of the file", () => {
    const before = snapshot("a\nb");
    const after = snapshot("X\na\nb");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.hunks).toEqual([{ start: 1, end: 1 }]);
  });

  it("returns no hunks for pure deletions (no line in after to point to)", () => {
    const before = snapshot("a\nX\nb");
    const after = snapshot("a\nb");
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.added_lines).toBe(0);
    expect(stats.removed_lines).toBe(1);
    expect(stats.hunks).toEqual([]);
  });

  it("synthesizes a whole-file hunk for kind=add", () => {
    const after = snapshot("first\nsecond\nthird");
    const stats = statsForCompletedChange({ kind: "add" }, missing(), after);
    expect(stats).toMatchObject({
      before_lines: 0,
      after_lines: 3,
      added_lines: 3,
      removed_lines: 0,
    });
    expect(stats.hunks).toEqual([{ start: 1, end: 3 }]);
  });

  it("omits hunks for kind=delete (no after-line target)", () => {
    const before = snapshot("a\nb\nc");
    const stats = statsForCompletedChange({ kind: "delete" }, before, missing());
    expect(stats).toMatchObject({
      before_lines: 3,
      after_lines: 0,
      added_lines: 0,
      removed_lines: 3,
    });
    expect(stats.hunks).toBeUndefined();
  });

  it("falls back to count-only when files exceed the hunk line cap", () => {
    const beforeBody = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n");
    const afterBody = `${beforeBody}\nappended`;
    const stats = statsForCompletedChange(
      { kind: "update" },
      snapshot(beforeBody),
      snapshot(afterBody),
    );
    expect(stats.added_lines).toBe(1);
    expect(stats.removed_lines).toBe(0);
    expect(stats.hunks).toBeUndefined();
  });

  it("returns unavailable when files exceed the diff line limit", () => {
    const beforeBody = Array.from({ length: 4500 }, (_, i) => `line-${i + 1}`).join("\n");
    const afterBody = beforeBody;
    const stats = statsForCompletedChange(
      { kind: "update" },
      snapshot(beforeBody),
      snapshot(afterBody),
    );
    expect(stats.unavailable_reason).toBe("too_many_lines");
    expect(stats.hunks).toBeUndefined();
  });

  it("propagates unavailable_reason from snapshot when content is missing", () => {
    const before = { exists: true, line_count: 10, unavailable_reason: "too_large" };
    const after = { exists: true, line_count: 12 };
    const stats = statsForCompletedChange({ kind: "update" }, before, after);
    expect(stats.unavailable_reason).toBe("too_large");
    expect(stats.hunks).toBeUndefined();
  });
});

describe("Claude SDK file write hooks", () => {
  it("does not install synthetic file_edit hooks around Write/Edit/NotebookEdit", async () => {
    let capturedOptions;
    const emitted = [];
    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;
      return (async function* stream() {
        yield { type: "result", result: "done", usage: {}, duration_ms: 1, num_turns: 1 };
      })();
    });

    const result = await generateClaudeResponse("system", {
      model: { model: "claude-test", reference: "claude:claude-test" },
      messages: [{ role: "user", content: "write a file" }],
      effort: "low",
      cwd: "/tmp",
      allowedTools: ["Write", "Edit", "NotebookEdit"],
      onEvent: (event) => emitted.push(event),
    });

    expect(result.error).toBeNull();
    expect(capturedOptions).toBeDefined();
    const hookGroups = Object.values(capturedOptions.hooks).flat();
    expect(hookGroups.map((group) => group.matcher)).not.toContain("Edit|Write|NotebookEdit");

    for (const name of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      for (const group of capturedOptions.hooks[name] || []) {
        for (const hook of group.hooks || []) {
          await hook({
            tool_name: "Write",
            tool_input: { file_path: "notes.txt", content: "hello" },
            tool_response: "ok",
          }, "write-1");
        }
      }
    }

    const contentBlocks = emitted.flatMap((event) => event?.message?.content || []);
    expect(contentBlocks.some((block) => block?.type === "tool_use" && block.name === "file_edit")).toBe(false);
    expect(contentBlocks.some((block) => block?.type === "tool_result" && String(block.tool_use_id || "").startsWith("file_edit:"))).toBe(false);
  });
});

describe("Codex file change event normalization", () => {
  it("keeps provider-native file changes out of the tool timeline", () => {
    const raw = {
      type: "item.completed",
      item: {
        id: "change-1",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "notes.txt", kind: "update" }],
        summary: { files: 1, added_lines: 1, removed_lines: 0, changed_lines: 1, unavailable_count: 0 },
      },
    };

    const event = normalizeCodexItemEvent(raw);

    expect(event).toMatchObject({
      type: "file_change",
      id: "change-1",
      status: "completed",
      changes: [{ path: "notes.txt", kind: "update" }],
      summary: { files: 1, added_lines: 1, removed_lines: 0, changed_lines: 1, unavailable_count: 0 },
      is_error: false,
    });
    expect(event.message).toBeUndefined();
    expect(event.name).toBeUndefined();
    expect(event.tool_use_id).toBeUndefined();
  });
});
