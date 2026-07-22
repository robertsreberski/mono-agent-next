import { describe, expect, it } from "vitest";

import type { ReplayTimelineItem, TimelineTurn } from "../data/replay.js";
import { EventTimelineList } from "../ui/components/event-list.js";
import { formatDurationMs, formatTokens } from "../ui/format.js";
import { styles } from "../ui/theme.js";
import { stripAnsi } from "./test-terminal.js";

/** Minimal ReplayTimelineItem builder — only the fields the tests care about are required. */
function item(
  fields: Pick<ReplayTimelineItem, "index" | "category" | "label" | "summary" | "turnIndex"> &
    Partial<ReplayTimelineItem>,
): ReplayTimelineItem {
  return {
    sourceEventCount: 1,
    sourceEventStartIndex: fields.index,
    sourceEventEndIndex: fields.index,
    payload: undefined,
    ...fields,
  };
}

function turn(
  fields: Pick<TimelineTurn, "turnIndex" | "startItemIndex" | "endItemIndex"> & Partial<TimelineTurn>,
): TimelineTurn {
  return { thinkingChars: 0, toolCalls: 0, ...fields };
}

function render(list: EventTimelineList, width = 80): string {
  return stripAnsi(list.render(width).join("\n"));
}

function makeItems(count: number): ReplayTimelineItem[] {
  return Array.from({ length: count }, (_, i) =>
    item({ index: i, category: "message", label: `label-${i}`, summary: `summary-${i}`, turnIndex: 0 }),
  );
}

describe("EventTimelineList", () => {
  it("windows around the selection and slides at the edges (selection marker on the right row)", () => {
    const list = new EventTimelineList({ maxVisible: 5 });
    list.setItems(makeItems(20), []);

    // Initial window starts at the top.
    let lines = render(list).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("label-0");

    // Move selection past the visible range -- window must slide to keep it in view.
    list.setSelectedIndex(12);
    lines = render(list).split("\n");
    expect(lines).toHaveLength(5);
    const selectedLine = lines.find((line) => line.includes("❯"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("label-12");
    expect(render(list)).not.toContain("label-0");

    // Jump to the very end -- window clamps to the tail.
    list.moveToLast();
    lines = render(list).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines.some((line) => line.includes("❯") && line.includes("label-19"))).toBe(true);
  });

  it("hides filtered-out rows and snaps selection to the nearest visible row", () => {
    const list = new EventTimelineList({ maxVisible: 10 });
    const items = [
      item({ index: 0, category: "message", label: "m0", summary: "", turnIndex: 0 }),
      item({ index: 1, category: "tool", label: "t1", summary: "", turnIndex: 0 }),
      item({ index: 2, category: "message", label: "m2", summary: "", turnIndex: 0 }),
    ];
    list.setItems(items, []);
    list.setSelectedIndex(1); // select the "tool" row

    list.setCategoryFilter(new Set(["message"]));

    const rendered = render(list);
    expect(rendered).not.toContain("t1");
    expect(list.visibleCount()).toBe(2);
    expect(list.selectedItem()?.category).toBe("message"); // snapped away from the hidden row
  });

  it("renders an empty-filter hint when the category filter hides every row", () => {
    const list = new EventTimelineList();
    list.setItems([item({ index: 0, category: "tool", label: "t0", summary: "", turnIndex: 0 })], []);

    list.setCategoryFilter(new Set(["thinking"]));

    const rendered = render(list);
    expect(rendered).toContain("no events match");
    expect(rendered.toLowerCase()).toContain("filter");
  });

  it("renders a dim placeholder when there are no items at all", () => {
    const list = new EventTimelineList();
    list.setItems([], []);
    expect(render(list)).toContain("no events");
  });

  it("highlights search matches and moveToMatch jumps between them, wrapping at the ends", () => {
    const list = new EventTimelineList();
    const items = [
      item({ index: 0, category: "message", label: "alpha", summary: "no match here", turnIndex: 0 }),
      item({ index: 1, category: "message", label: "beta", summary: "contains needle text", turnIndex: 0 }),
      item({ index: 2, category: "message", label: "gamma", summary: "another needle here", turnIndex: 0 }),
    ];
    list.setItems(items, []);

    list.setSearch("needle");
    expect(list.matchCount()).toBe(2);
    // Raw (non-stripped) render carries the inverse escape around the match.
    const raw = list.render(80).join("\n");
    expect(raw).toContain(styles.inverse("needle"));

    list.moveToMatch(1);
    expect(list.selectedItem()?.index).toBe(1);
    list.moveToMatch(1);
    expect(list.selectedItem()?.index).toBe(2);
    list.moveToMatch(1); // wraps forward past the last match
    expect(list.selectedItem()?.index).toBe(1);
    list.moveToMatch(-1); // wraps backward past the first match
    expect(list.selectedItem()?.index).toBe(2);
  });

  it("truncates a highlighted row to width without throwing or corrupting the visible text", () => {
    const list = new EventTimelineList();
    const longSummary = `some prefix text needle ${"filler ".repeat(20)}`;
    list.setItems(
      [item({ index: 0, category: "message", label: "row", summary: longSummary, turnIndex: 0 })],
      [],
    );
    list.setSearch("needle");
    for (const width of [80, 40, 20, 10]) {
      expect(() => list.render(width)).not.toThrow();
      const lines = list.render(width);
      expect(lines).toHaveLength(1);
      // stripAnsi must produce clean, non-corrupted plain text at every width.
      expect(stripAnsi(lines[0]!)).not.toContain(String.fromCharCode(27));
    }
  });

  it("is a no-op for moveToMatch when there is no active search", () => {
    const list = new EventTimelineList();
    list.setItems(makeItems(3), []);
    list.moveToMatch(1);
    expect(list.selectedItem()?.index).toBe(0);
  });

  it("renders turn marker rows between turns with stats, and selection movement skips them", () => {
    const list = new EventTimelineList({ maxVisible: 20 });
    const items = [
      item({ index: 0, category: "thinking", label: "think", summary: "", turnIndex: 0, contentChars: 500 }),
      item({ index: 1, category: "tool", label: "tool-call", summary: "", turnIndex: 0 }),
      item({ index: 2, category: "message", label: "answer", summary: "", turnIndex: 1 }),
    ];
    const turns = [
      turn({ turnIndex: 0, startItemIndex: 0, endItemIndex: 1, thinkingChars: 500, toolCalls: 1 }),
      turn({ turnIndex: 1, startItemIndex: 2, endItemIndex: 2 }),
    ];
    list.setItems(items, turns);

    const rendered = render(list);
    expect(rendered).toContain("turn 1/2");
    expect(rendered).toContain("turn 2/2");
    expect(rendered).toContain("1 tools");

    // Selection movement counts only item rows, never markers.
    list.setSelectedIndex(0);
    list.moveSelection(1);
    expect(list.selectedItem()?.index).toBe(1);
    list.moveSelection(1);
    expect(list.selectedItem()?.index).toBe(2);
  });

  it("hides a turn's marker row when every item in that turn is filtered out (no orphan marker)", () => {
    const list = new EventTimelineList({ maxVisible: 20 });
    const items = [
      item({ index: 0, category: "tool", label: "tool-call", summary: "", turnIndex: 0 }),
      item({ index: 1, category: "message", label: "answer", summary: "", turnIndex: 1 }),
    ];
    const turns = [
      turn({ turnIndex: 0, startItemIndex: 0, endItemIndex: 0 }),
      turn({ turnIndex: 1, startItemIndex: 1, endItemIndex: 1 }),
    ];
    list.setItems(items, turns);

    list.setCategoryFilter(new Set(["message"])); // turn 0's only item ("tool") is hidden entirely

    const rendered = render(list);
    expect(rendered).not.toContain("turn 1/2");
    expect(rendered).toContain("turn 2/2");
    expect(rendered).toContain("answer");
  });

  it("omits turn markers entirely for a single-turn run", () => {
    const list = new EventTimelineList();
    list.setItems(
      [item({ index: 0, category: "message", label: "only", summary: "", turnIndex: 0 })],
      [turn({ turnIndex: 0, startItemIndex: 0, endItemIndex: 0 })],
    );
    expect(render(list)).not.toContain("turn 1/1");
  });

  it("moveToTurn jumps to the next/prev turn's first visible item", () => {
    const list = new EventTimelineList({ maxVisible: 20 });
    const items = [
      item({ index: 0, category: "thinking", label: "think", summary: "", turnIndex: 0 }),
      item({ index: 1, category: "tool", label: "tool-call", summary: "", turnIndex: 0 }),
      item({ index: 2, category: "message", label: "answer", summary: "", turnIndex: 1 }),
    ];
    const turns = [
      turn({ turnIndex: 0, startItemIndex: 0, endItemIndex: 1 }),
      turn({ turnIndex: 1, startItemIndex: 2, endItemIndex: 2 }),
    ];
    list.setItems(items, turns);

    list.moveToTurn(1);
    expect(list.selectedItem()?.index).toBe(2);
    expect(list.turnOfSelection()).toBe(1);
    list.moveToTurn(-1);
    expect(list.selectedItem()?.index).toBe(0);
  });

  it("omits the clock/delta columns when no item in the run carries a timestamp", () => {
    const list = new EventTimelineList();
    list.setItems(
      [item({ index: 0, category: "message", label: "no-ts", summary: "hi there", turnIndex: 0 })],
      [],
    );
    const rendered = render(list);
    expect(rendered).not.toMatch(/\+\d/u); // no "+120ms"-style delta column
  });

  it("shows the clock/delta columns when at least one item in the run carries a timestamp", () => {
    const list = new EventTimelineList();
    const items = [
      item({
        index: 0,
        category: "message",
        label: "first",
        summary: "",
        turnIndex: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
        timestampMs: Date.parse("2026-01-01T00:00:00.000Z"),
      }),
      item({
        index: 1,
        category: "message",
        label: "second",
        summary: "",
        turnIndex: 0,
        timestamp: "2026-01-01T00:00:00.120Z",
        timestampMs: Date.parse("2026-01-01T00:00:00.120Z"),
        deltaMs: 120,
      }),
    ];
    list.setItems(items, []);
    expect(render(list)).toContain("+120ms");
  });

  it("shows chars and duration for a thinking row when both the chars and the span are available", () => {
    const list = new EventTimelineList();
    const withSpan = item({
      index: 0,
      category: "thinking",
      label: "Assistant thoughts",
      summary: "",
      turnIndex: 0,
      contentChars: 12_300,
      timestamp: "2026-01-01T00:00:00.000Z",
      endTimestamp: "2026-01-01T00:00:04.100Z",
    });
    list.setItems([withSpan], []);
    expect(render(list)).toContain(`(${formatTokens(12_300)} · ${formatDurationMs(4_100)})`);
  });

  it("shows only chars for a thinking row when the span can't be computed", () => {
    const list = new EventTimelineList();
    const noSpan = item({
      index: 0,
      category: "thinking",
      label: "Assistant thoughts",
      summary: "",
      turnIndex: 0,
      contentChars: 500,
    });
    list.setItems([noSpan], []);
    const rendered = render(list);
    expect(rendered).toContain(`(${formatTokens(500)})`);
    expect(rendered).not.toContain("·");
  });

  it("exposes status-line counters", () => {
    const list = new EventTimelineList();
    const items = [
      item({ index: 0, category: "message", label: "a", summary: "", turnIndex: 0 }),
      item({ index: 1, category: "tool", label: "b", summary: "", turnIndex: 1 }),
    ];
    list.setItems(items, [
      turn({ turnIndex: 0, startItemIndex: 0, endItemIndex: 0 }),
      turn({ turnIndex: 1, startItemIndex: 1, endItemIndex: 1 }),
    ]);

    expect(list.totalCount()).toBe(2);
    expect(list.visibleCount()).toBe(2);
    expect(list.selectedVisibleOrdinal()).toBe(1);
    expect(list.turnOfSelection()).toBe(0);

    list.setSelectedIndex(1);
    expect(list.selectedVisibleOrdinal()).toBe(2);
    expect(list.turnOfSelection()).toBe(1);
  });

  it("handles up/down, pageUp/pageDown, and home/end via handleInput", () => {
    const list = new EventTimelineList({ maxVisible: 3 });
    list.setItems(makeItems(10), []);

    list.handleInput("\x1b[B"); // down
    expect(list.selectedItem()?.index).toBe(1);
    list.handleInput("\x1b[A"); // up
    expect(list.selectedItem()?.index).toBe(0);
    list.handleInput("\x1b[6~"); // pageDown
    expect(list.selectedItem()?.index).toBe(3);
    list.handleInput("\x1b[5~"); // pageUp
    expect(list.selectedItem()?.index).toBe(0);
    list.handleInput("\x1b[F"); // end
    expect(list.selectedItem()?.index).toBe(9);
    list.handleInput("\x1b[H"); // home
    expect(list.selectedItem()?.index).toBe(0);
  });

  it("fires onSelectionChange when the selection moves", () => {
    const list = new EventTimelineList();
    list.setItems(makeItems(3), []);
    const seen: Array<number | undefined> = [];
    list.onSelectionChange = (selected) => seen.push(selected?.index);
    list.moveSelection(1);
    expect(seen).toEqual([1]);
  });

  it("invokes categoryStyle-mapped colors per category (smoke: label renders without throwing for every category)", () => {
    const list = new EventTimelineList();
    const items = (["thinking", "tool", "error", "runtime", "message"] as const).map((category, index) =>
      item({ index, category, label: `${category}-label`, summary: "", turnIndex: 0 }),
    );
    list.setItems(items, []);
    const rendered = render(list);
    for (const category of ["thinking", "tool", "error", "runtime", "message"]) {
      expect(rendered).toContain(`${category}-label`);
    }
  });

  describe("row glyphs (chat's visual vocabulary, additive at the start of the label)", () => {
    it("prefixes a thinking row with the live thinking marker (∴)", () => {
      const list = new EventTimelineList();
      list.setItems([item({ index: 0, category: "thinking", label: "Assistant thoughts", summary: "", turnIndex: 0 })], []);
      expect(render(list)).toContain("∴");
    });

    it("prefixes an error-category row with a warning glyph (⚠)", () => {
      const list = new EventTimelineList();
      list.setItems([item({ index: 0, category: "error", label: "Error", summary: "boom", turnIndex: 0 })], []);
      expect(render(list)).toContain("⚠");
    });

    it("prefixes a tool CALL row (assistant-typed) with →", () => {
      const list = new EventTimelineList();
      list.setItems(
        [item({ index: 0, category: "tool", label: "Tool: bash", summary: "ls", turnIndex: 0, type: "assistant" })],
        [],
      );
      const rendered = render(list);
      expect(rendered).toContain("→");
      expect(rendered).not.toContain("✓");
      expect(rendered).not.toContain("✗");
    });

    it("prefixes a successful tool RESULT row (user-typed) with ✓", () => {
      const list = new EventTimelineList();
      list.setItems(
        [item({ index: 0, category: "tool", label: "Tool result: bash", summary: "a.txt", turnIndex: 0, type: "user" })],
        [],
      );
      const rendered = render(list);
      expect(rendered).toContain("✓");
      expect(rendered).not.toContain("✗");
    });

    it("prefixes an errored tool RESULT row with ✗ (summary carries the 'error: ' prefix)", () => {
      const list = new EventTimelineList();
      list.setItems(
        [
          item({
            index: 0,
            category: "tool",
            label: "Tool result: bash",
            summary: "error: boom",
            turnIndex: 0,
            type: "user",
          }),
        ],
        [],
      );
      const rendered = render(list);
      expect(rendered).toContain("✗");
      expect(rendered).not.toContain("✓");
    });

    it("prefixes a user message row with green 'you' styling, matching live chat's UserCell", () => {
      const list = new EventTimelineList();
      list.setItems(
        [item({ index: 0, category: "message", label: "user", summary: "hi", turnIndex: 0, type: "user" })],
        [],
      );
      const raw = list.render(80).join("\n");
      expect(raw).toContain(styles.user("you"));
    });

    it("does not glyph-prefix an assistant message row", () => {
      const list = new EventTimelineList();
      list.setItems(
        [item({ index: 0, category: "message", label: "Assistant message", summary: "hi", turnIndex: 0, type: "assistant" })],
        [],
      );
      const raw = list.render(80).join("\n");
      expect(raw).not.toContain(styles.user("you"));
      expect(stripAnsi(raw)).not.toMatch(/[∴⚠→✓✗]/u);
    });
  });
});
