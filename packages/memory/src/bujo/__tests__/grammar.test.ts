import { describe, expect, it } from "vitest";

import { parseBullet, serializeBullet, parseDailyFile, serializeDailyFile } from "../grammar.js";
import type { Bullet } from "../types.js";

const LINE =
  '- [ ] Ship the P1 substrate.  <!--mem id=01J type=task status=open salience=0.8 isInsight=0 created=2026-06-15T09:12:00.000Z refs=01A,01B-->';
const SPLIT_LINE = [
  "- [ ] Ship the P1 substrate.",
  "  <!--mem id=01J type=task status=open salience=0.8 isInsight=0 created=2026-06-15T09:12:00.000Z refs=01A,01B-->",
].join("\n");

describe("parseBullet/serializeBullet", () => {
  it("parses a task bullet with metadata", () => {
    const b = parseBullet(LINE);
    expect(b).toEqual({
      id: "01J", type: "task", status: "open", text: "Ship the P1 substrate.",
      salience: 0.8, isInsight: false, createdAt: "2026-06-15T09:12:00.000Z", refs: ["01A", "01B"],
    } satisfies Bullet);
  });

  it("serializes task/event/note metadata on a hidden indented line", () => {
    const samples: Bullet[] = [
      { id: "01J", type: "task", status: "open", text: "Ship the P1 substrate.", salience: 0.8, isInsight: false, createdAt: "2026-06-15T09:12:00.000Z", refs: ["01A", "01B"] },
      { id: "01C", type: "note", status: "done", text: "Confirmed nomic tag is v1.5.", salience: 0.4, isInsight: false, createdAt: "2026-06-15T10:00:00.000Z", refs: [] },
      { id: "01D", type: "event", status: "open", text: "Met about memory rituals.", salience: 0.5, isInsight: false, createdAt: "2026-06-15T11:00:00.000Z", refs: [] },
      { id: "01E", type: "note", status: "open", text: "Morgan prefers opt-in, never silent fallback.", salience: 0.9, isInsight: true, createdAt: "2026-06-15T12:00:00.000Z", refs: ["01C"] },
    ];
    for (const bullet of samples) {
      const serialized = serializeBullet(bullet);
      const [visible, meta] = serialized.split("\n");
      expect(visible).not.toContain("<!--mem");
      expect(meta?.startsWith("  <!--mem ")).toBe(true);
      const parsed = parseBullet(serialized);
      expect(parsed).toBeDefined();
      expect(parsed).toEqual(bullet);
    }
  });

  it("keeps legacy inline parse compatibility while new serialization is split", () => {
    const parsed = parseBullet(LINE);
    expect(parsed).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(serializeBullet(parsed!)).toBe(SPLIT_LINE);
  });

  it("returns undefined for non-bullet lines", () => {
    expect(parseBullet("## 2026-06-15")).toBeUndefined();
    expect(parseBullet("just prose")).toBeUndefined();
  });

  it("treats bullets with a blank id, created, or text as non-bullets (avoids PK collisions on rebuild)", () => {
    // blank id
    expect(parseBullet(
      "- [ ] Has text.  <!--mem id= type=task status=open salience=0.5 isInsight=0 created=2026-06-15T10:00:00.000Z refs=-->",
    )).toBeUndefined();
    // blank created
    expect(parseBullet(
      "- [ ] Has text.  <!--mem id=01Z type=task status=open salience=0.5 isInsight=0 created= refs=-->",
    )).toBeUndefined();
    // blank text
    expect(parseBullet(
      "- [ ]    <!--mem id=01Z type=task status=open salience=0.5 isInsight=0 created=2026-06-15T10:00:00.000Z refs=-->",
    )).toBeUndefined();
  });

  it("round-trips due, invalidated, and (event,done) via serialize→parse", () => {
    const bullets: Bullet[] = [
      { id: "01F", type: "task", status: "scheduled", text: "Review backlog.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T13:00:00.000Z", refs: [], dueAt: "2026-07-01T09:00:00.000Z" },
      { id: "01G", type: "task", status: "invalidated", text: "Old plan.", salience: 0.2, isInsight: false, createdAt: "2026-06-15T14:00:00.000Z", refs: [] },
      { id: "01H", type: "event", status: "done", text: "Shipped P1.", salience: 0.7, isInsight: false, createdAt: "2026-06-15T15:00:00.000Z", refs: ["01F", "01G"] },
    ];
    for (const b of bullets) {
      expect(parseBullet(serializeBullet(b))).toEqual(b);
    }
  });

  it("serializes invalidated with a struck marker, not the note marker", () => {
    const line = serializeBullet({ id: "01G", type: "task", status: "invalidated", text: "Old plan.", salience: 0.2, isInsight: false, createdAt: "2026-06-15T14:00:00.000Z", refs: [] });
    expect(line.startsWith("- [~] ")).toBe(true);
  });

  it("throws when bullet text contains the metadata delimiter or a newline", () => {
    const base: Bullet = { id: "01Z", type: "note", status: "open", text: "", salience: 0.5, isInsight: false, createdAt: "2026-06-15T16:00:00.000Z", refs: [] };
    expect(() => serializeBullet({ ...base, text: "evil  <!--mem id=x-->" })).toThrow(/delimiter/);
    expect(() => serializeBullet({ ...base, text: "line one\nline two" })).toThrow(/newline/);
  });

  it("falls back to the marker's status when metadata status is empty", () => {
    const b = parseBullet(
      "- [x] Done thing.  <!--mem id=01K type=task status= salience=0.5 isInsight=0 created=2026-06-15T17:00:00.000Z refs=-->",
    );
    expect(b?.status).toBe("done");
  });

  it("falls back to marker-derived values when metadata status/type are not valid enum members", () => {
    // Invalid status falls back to the marker ([x] => done); valid type is kept.
    const b1 = parseBullet(
      "- [x] Thing.  <!--mem id=01L type=task status=bogus salience=0.5 isInsight=0 created=2026-06-15T17:00:00.000Z refs=-->",
    );
    expect(b1?.type).toBe("task");
    expect(b1?.status).toBe("done");
    expect(VALID_ENUM_VALUES.statuses).toContain(b1?.status ?? "");

    // Invalid type falls back to the marker (◦ => event); valid status is kept.
    const b2 = parseBullet(
      "- ◦ Met.  <!--mem id=01M type=invalid status=open salience=0.5 isInsight=0 created=2026-06-15T17:00:00.000Z refs=-->",
    );
    expect(b2?.type).toBe("event");
    expect(b2?.status).toBe("open");
    expect(VALID_ENUM_VALUES.types).toContain(b2?.type ?? "");
  });
});

// Mirrors the SQLite CHECK constraints — a parsed Bullet must never escape these sets.
const VALID_ENUM_VALUES = {
  types: ["task", "event", "note"],
  statuses: ["open", "done", "scheduled", "migrated", "dropped", "invalidated"],
};

describe("parseDailyFile/serializeDailyFile", () => {
  it("round-trips a daily file, preserving non-bullet lines verbatim", () => {
    const file = ["# 2026-06-15", "", LINE, "", "Some freeform note.", ""].join("\n");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(serializeDailyFile(parsed)).toBe(["# 2026-06-15", "", SPLIT_LINE, "", "Some freeform note.", ""].join("\n"));
  });

  it("parses split and legacy bullets interleaved with prose", () => {
    const file = [
      "# 2026-06-15",
      "",
      SPLIT_LINE,
      "Some prose between bullets.",
      "- ◦ Standup.  <!--mem id=01M type=event status=open salience=0.3 isInsight=0 created=2026-06-15T18:00:00.000Z refs=-->",
      "",
    ].join("\n");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(2);
    expect(parsed.bullets.map((b) => b.id)).toEqual(["01J", "01M"]);
    expect(parsed.lines.filter((l) => l.bullet !== undefined).map((l) => l.lineNumber)).toEqual([3, 6]);
    expect(serializeDailyFile(parsed)).not.toContain("Standup.  <!--mem");
  });
});
