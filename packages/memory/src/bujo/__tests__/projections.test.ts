import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDb, type MemoryDb } from "../../store/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { writeFutureLog, writeIndex } from "../projections.js";
import { fakeEmbeddings } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-16T10:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-projections-"));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

describe("writeFutureLog", () => {
  it("writes future-log.md with scheduled items soonest-first and returns count", async () => {
    const root = newRoot();
    const db = openDb(root);

    // dueAt within horizon (365 days from now)
    const soon = new Date(FIXED.getTime() + 7 * 86_400_000).toISOString();   // 7 days out
    const later = new Date(FIXED.getTime() + 30 * 86_400_000).toISOString(); // 30 days out
    const muchLater = new Date(FIXED.getTime() + 400 * 86_400_000).toISOString(); // beyond 365 day horizon

    await db.upsert({
      id: "SCHED1",
      type: "task",
      status: "scheduled",
      text: "Write quarterly report",
      salience: 0.7,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: later,
      source: {},
    });

    await db.upsert({
      id: "SCHED2",
      type: "task",
      status: "open",
      text: "Review team feedback",
      salience: 0.6,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: soon,
      source: {},
    });

    await db.upsert({
      id: "SCHED3",
      type: "task",
      status: "scheduled",
      text: "This item is beyond the horizon",
      salience: 0.5,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: muchLater,
      source: {},
    });

    // Item with no dueAt should not appear.
    await db.upsert({
      id: "NODUEDATE",
      type: "note",
      status: "open",
      text: "No due date item",
      salience: 0.5,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    const count = writeFutureLog(root, db, FIXED);

    // Only SCHED1 and SCHED2 are within the 365-day horizon.
    expect(count).toBe(2);

    const content = readFileSync(join(root, "future-log.md"), "utf8");
    expect(content).toContain("# Future Log");

    // Both scheduled items must appear.
    expect(content).toContain("SCHED1");
    expect(content).toContain("SCHED2");

    // Item beyond horizon must not appear.
    expect(content).not.toContain("SCHED3");

    // No-due-date item must not appear.
    expect(content).not.toContain("NODUEDATE");

    // Soonest first: SCHED2 (7 days) should appear before SCHED1 (30 days).
    const sched1Pos = content.indexOf("SCHED1");
    const sched2Pos = content.indexOf("SCHED2");
    expect(sched2Pos).toBeLessThan(sched1Pos);

    // Each item uses the BuJo scheduled bullet notation.
    expect(content).toContain("- [<]");

    // Each item includes the ^id anchor.
    expect(content).toContain("^SCHED1");
    expect(content).toContain("^SCHED2");
  });

  it("returns 0 and writes an empty future-log.md when no items are due", async () => {
    const root = newRoot();
    const db = openDb(root);

    const count = writeFutureLog(root, db, FIXED);
    expect(count).toBe(0);

    const content = readFileSync(join(root, "future-log.md"), "utf8");
    expect(content).toContain("# Future Log");
  });

  it("creates the root directory if it does not exist", async () => {
    const base = mkdtempSync(join(tmpdir(), "bujo-projections-mkdir-"));
    const root = join(base, "nested", "subdir");
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    openDbs.push(db);

    expect(() => writeFutureLog(root, db, FIXED)).not.toThrow();
  });

  it("refuses a symlinked future-log target", () => {
    const root = newRoot();
    const outside = join(mkdtempSync(join(tmpdir(), "bujo-projections-outside-")), "future-log.md");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, join(root, "future-log.md"));
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    openDbs.push(db);

    expect(() => writeFutureLog(root, db, FIXED)).toThrow(/symlink|regular/iu);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });
});

describe("writeIndex", () => {
  it("writes index.md with counts, top memories, and entities", async () => {
    const root = newRoot();
    const db = openDb(root);

    await db.upsert({
      id: "MEM1",
      type: "note",
      status: "open",
      text: "Morgan works best in the mornings",
      salience: 0.9,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    await db.upsert({
      id: "MEM2",
      type: "note",
      status: "open",
      text: "mono-agent is a personal AI assistant",
      salience: 0.8,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: FIXED.toISOString() });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: FIXED.toISOString() });

    writeIndex(root, db, FIXED);

    const content = readFileSync(join(root, "index.md"), "utf8");

    // Must contain the Overview section with counts.
    expect(content).toContain("## Overview");
    expect(content).toContain("2"); // memory count
    expect(content).toContain("2"); // entity count

    // Must contain Top memories section with at least one memory.
    expect(content).toContain("## Top memories");
    expect(content).toMatch(/Morgan works best|mono-agent is a personal/u);

    // Must contain Entities section with at least one entity.
    expect(content).toContain("## Entities");
    expect(content).toMatch(/Morgan \(person\)|mono-agent \(project\)/u);
  });

  it("shows one row per normalized referent and excludes ephemeral temporal entities", () => {
    const root = newRoot();
    const db = openDb(root);

    for (let index = 0; index < 55; index += 1) {
      const suffix = String(index).padStart(2, "0");
      db.upsertEntity({
        id: `project:durable-${suffix}`,
        name: `Durable ${suffix}`,
        type: "project",
        createdAt: FIXED.toISOString(),
      });
    }
    for (const [id, type] of [
      ["command:canonical-widget", "command"],
      ["concept:canonical-widget", "concept"],
      ["tool:canonical-widget", "tool"],
    ] as const) {
      db.upsertEntity({ id, name: "Canonical Widget", type, createdAt: FIXED.toISOString() });
    }
    db.upsertEntity({
      id: "concept:novel-1984",
      name: "1984",
      type: "concept",
      createdAt: FIXED.toISOString(),
    });
    for (const [id, name] of [
      ["language:c", "C"],
      ["language:c-sharp", "C#"],
      ["language:c-plus-plus", "C++"],
    ] as const) {
      db.upsertEntity({ id, name, type: "language", createdAt: FIXED.toISOString() });
    }
    db.upsertEntity({
      id: "project:alpha-agent-primary",
      name: "Alpha-Agent",
      type: "project",
      createdAt: FIXED.toISOString(),
    });
    db.upsertEntity({
      id: "project:alpha-agent-secondary",
      name: "alpha agent",
      type: "project",
      createdAt: FIXED.toISOString(),
    });
    db.upsertEntity({ id: "date:today", name: "2026-07-16", type: "date", createdAt: FIXED.toISOString() });
    db.upsertEntity({ id: "day:thursday", name: "Thursday", type: "day", createdAt: FIXED.toISOString() });
    db.upsertEntity({ id: "time:one-pm", name: "13:00", createdAt: FIXED.toISOString() });
    db.upsertEntity({ id: "year:next-year", name: "2027", type: "year", createdAt: FIXED.toISOString() });
    const inventoryBefore = db.allEntities();
    const countBefore = db.countEntities();

    writeIndex(root, db, FIXED);

    const content = readFileSync(join(root, "index.md"), "utf8");
    const entityRows = content
      .slice(content.indexOf("## Entities"))
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(content).toContain(`- Entities: ${countBefore}`);
    expect(db.allEntities()).toEqual(inventoryBefore);
    expect(entityRows).toHaveLength(50);
    expect(entityRows).toContain("- 1984 (concept)");
    expect(entityRows.filter((line) => /^- C(?:#|\+\+)? \(language\)$/u.test(line))).toEqual([
      "- C (language)",
      "- C# (language)",
      "- C++ (language)",
    ]);
    expect(entityRows.filter((line) => line.includes("Canonical Widget"))).toEqual(["- Canonical Widget"]);
    expect(entityRows.filter((line) => /alpha[ -]agent/iu.test(line))).toEqual(["- Alpha-Agent (project)"]);
    expect(entityRows.join("\n")).not.toContain("2026-07-16");
    expect(entityRows.join("\n")).not.toContain("Thursday");
    expect(entityRows.join("\n")).not.toContain("13:00");
    expect(entityRows.join("\n")).not.toContain("2027");
  });

  it("paginates past more than 500 early filtered and duplicate rows", () => {
    const root = newRoot();
    const db = openDb(root);

    for (let index = 0; index < 260; index += 1) {
      const suffix = String(index).padStart(3, "0");
      db.upsertEntity({
        id: `time:early-${suffix}`,
        name: `000 Temporal ${suffix}`,
        type: "time",
        createdAt: FIXED.toISOString(),
      });
    }
    for (let index = 0; index < 260; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const type = index % 2 === 0 ? "concept" : "tool";
      db.upsertEntity({
        id: `${type}:duplicate-noise-${suffix}`,
        name: "001 Duplicate Noise",
        type,
        createdAt: FIXED.toISOString(),
      });
    }
    for (let index = 0; index < 50; index += 1) {
      const suffix = String(index).padStart(2, "0");
      db.upsertEntity({
        id: `project:zulu-durable-${suffix}`,
        name: `Zulu Durable ${suffix}`,
        type: "project",
        createdAt: FIXED.toISOString(),
      });
    }
    const inventoryBefore = db.allEntities();

    writeIndex(root, db, FIXED);

    const content = readFileSync(join(root, "index.md"), "utf8");
    const entityRows = content
      .slice(content.indexOf("## Entities"))
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(entityRows).toHaveLength(50);
    expect(new Set(entityRows).size).toBe(50);
    expect(entityRows.filter((line) => line.includes("001 Duplicate Noise"))).toEqual([
      "- 001 Duplicate Noise",
    ]);
    expect(entityRows.filter((line) => line.includes("Zulu Durable"))).toHaveLength(49);
    expect(entityRows.join("\n")).not.toContain("000 Temporal");
    expect(db.allEntities()).toEqual(inventoryBefore);
  });

  it("reconciles a conflicting duplicate after the first 50 preview groups", () => {
    const root = newRoot();
    const db = openDb(root);

    for (let index = 0; index < 49; index += 1) {
      const suffix = String(index).padStart(2, "0");
      db.upsertEntity({
        id: `project:useful-${suffix}`,
        name: `A Useful ${suffix}`,
        type: "project",
        createdAt: FIXED.toISOString(),
      });
    }
    for (let index = 0; index < 200; index += 1) {
      const suffix = String(index).padStart(3, "0");
      db.upsertEntity({
        id: `time:filler-${suffix}`,
        name: `B Temporal ${suffix}`,
        type: "time",
        createdAt: FIXED.toISOString(),
      });
    }
    db.upsertEntity({
      id: "concept:zulu",
      name: "Zulu",
      type: "concept",
      createdAt: FIXED.toISOString(),
    });
    db.upsertEntity({
      id: "tool:zulu",
      name: "Zulu",
      type: "tool",
      createdAt: FIXED.toISOString(),
    });
    const inventoryBefore = db.allEntities();

    expect(db.listEntities(2, 249).map((entity) => entity.id)).toEqual([
      "concept:zulu",
      "tool:zulu",
    ]);

    writeIndex(root, db, FIXED);

    const content = readFileSync(join(root, "index.md"), "utf8");
    const entityRows = content
      .slice(content.indexOf("## Entities"))
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(entityRows).toHaveLength(50);
    expect(entityRows.filter((line) => line.includes("Zulu"))).toEqual(["- Zulu"]);
    expect(entityRows.join("\n")).not.toContain("B Temporal");
    expect(db.allEntities()).toEqual(inventoryBefore);
  });

  it("creates the root directory if it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "bujo-projections-idx-mkdir-"));
    const root = join(base, "deep", "nested");
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    openDbs.push(db);

    expect(() => writeIndex(root, db, FIXED)).not.toThrow();

    const content = readFileSync(join(root, "index.md"), "utf8");
    expect(content).toContain("## Overview");
  });

  it("refuses a symlinked index target", () => {
    const root = newRoot();
    const outside = join(mkdtempSync(join(tmpdir(), "bujo-projections-outside-")), "index.md");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, join(root, "index.md"));
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    openDbs.push(db);

    expect(() => writeIndex(root, db, FIXED)).toThrow(/symlink|regular/iu);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });
});
