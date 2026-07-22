import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import type { EmbeddingProvider } from "../../search/index.js";
import { appendBullet, dailyFilePath } from "../daily.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { consolidateBujoMemory } from "../consolidate.js";
import { parseDailyFile } from "../grammar.js";
import { migrate } from "../migrate.js";
import { fakeEmbeddings } from "./helpers.js";
import type { Bullet } from "../types.js";

function recordFor(root: string, bullet: Bullet, when: Date): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, when)) },
  };
}

describe("consolidateBujoMemory", () => {
  it("reports duplicate groups and refreshes projections without changing canonical or indexed state", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    const olderDate = new Date("2026-06-01T09:00:00.000Z");
    const newerDate = new Date("2026-06-02T09:00:00.000Z");
    const base = fakeEmbeddings(64);
    let embeddingCalls = 0;
    let providerUnavailable = false;
    const embeddings: EmbeddingProvider = {
      id: "consolidate-provider:64",
      embed: async (texts) => {
        embeddingCalls += 1;
        if (providerUnavailable) throw new Error("consolidation must not call embeddings");
        return await base.embed(texts);
      },
    };
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: 64, clock: () => now });
    const older: Bullet = {
      id: "OLD",
      type: "note",
      status: "open",
      text: "Morgan prefers opt-in memory.",
      salience: 0.8,
      isInsight: false,
      createdAt: olderDate.toISOString(),
      refs: [],
    };
    const newer: Bullet = {
      id: "NEW",
      type: "note",
      status: "open",
      text: "morgan prefers opt in memory",
      salience: 0.7,
      isInsight: false,
      createdAt: newerDate.toISOString(),
      refs: [],
    };
    const unique: Bullet = {
      id: "UNIQUE",
      type: "note",
      status: "open",
      text: "The launch date is March 3rd.",
      salience: 0.6,
      isInsight: false,
      createdAt: newerDate.toISOString(),
      refs: [],
    };
    for (const [bullet, date] of [[older, olderDate], [newer, newerDate], [unique, newerDate]] as const) {
      appendBullet(root, bullet, date);
      await db.upsert(recordFor(root, bullet, date));
    }
    db.addEdge("OLD", "NEW", "supports");
    const callsBefore = embeddingCalls;
    const olderSource = dailyFilePath(root, olderDate);
    const newerSource = dailyFilePath(root, newerDate);
    const olderBefore = readFileSync(olderSource, "utf8");
    const newerBefore = readFileSync(newerSource, "utf8");
    const recordsBefore = ["OLD", "NEW", "UNIQUE"].map((id) => db.get(id));
    const edgesBefore = db.edges("OLD");
    const validationBefore = db.validationSnapshot();
    const supersede = vi.spyOn(db, "markSuperseded");
    const prepare = vi.spyOn(db, "prepareUpsertVectors");
    providerUnavailable = true;

    await expect(consolidateBujoMemory({ root, db, now })).resolves.toEqual({
      duplicateGroups: 1,
    });

    expect(embeddingCalls).toBe(callsBefore);
    expect(supersede).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(["OLD", "NEW", "UNIQUE"].map((id) => db.get(id))).toEqual(recordsBefore);
    expect(db.edges("OLD")).toEqual(edgesBefore);
    expect(db.validationSnapshot()).toEqual(validationBefore);
    expect(readFileSync(olderSource, "utf8")).toBe(olderBefore);
    expect(readFileSync(newerSource, "utf8")).toBe(newerBefore);
    expect(readFileSync(join(root, "index.md"), "utf8")).toContain("# Index");
    expect(readFileSync(join(root, "future-log.md"), "utf8")).toBe("# Future Log\n");
    db.close();
  });

  it("does not replay a pending capture intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-capture-"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    const db = openMemoryDb({ path: join(root, "memory.db") });
    const bullet: Bullet = {
      id: "CONSOLIDATE-CAPTURE",
      type: "note",
      status: "open",
      text: "projection refresh leaves durable capture pending",
      salience: 0.6,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, now);
    await db.upsert(recordFor(root, bullet, now));
    const source = dailyFilePath(root, now);
    const parsed = parseDailyFile(readFileSync(source, "utf8")).bullets[0]!;
    const handle = writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: bullet.id,
      expected: { file: relative(root, source), bullet: parsed },
    }], { entities: [], relations: [], associations: [] }, now.toISOString());
    const intentPath = join(root, handle.file);
    const intentBefore = readFileSync(intentPath, "utf8");

    const result = await consolidateBujoMemory({ root, db, now });

    expect(result).toEqual({ duplicateGroups: 0 });
    expect(existsSync(intentPath)).toBe(true);
    expect(readFileSync(intentPath, "utf8")).toBe(intentBefore);
    expect(db.get(bullet.id)?.status).toBe("open");
    db.close();
  });

  it("does not recover an already-paid migration decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-migration-"));
    const now = new Date("2026-08-20T12:00:00.000Z");
    const created = new Date("2026-04-01T09:00:00.000Z");
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const bullet: Bullet = {
      id: "CONSOLIDATE-MIGRATION",
      type: "note",
      status: "open",
      text: "projection refresh leaves paid migration pending",
      salience: 0.2,
      isInsight: false,
      createdAt: created.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, created);
    await db.upsert(recordFor(root, bullet, created));
    await expect(migrate({
      db,
      root,
      llm: { id: "migration", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => now,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-consolidate-migration-pending"); } },
    })).rejects.toThrow("leave-consolidate-migration-pending");
    const monthly = join(root, "monthly", "2026-08.md");
    const monthlyBefore = readFileSync(monthly, "utf8");

    const result = await consolidateBujoMemory({ root, db, now });

    expect(result).toEqual({ duplicateGroups: 0 });
    expect(readFileSync(monthly, "utf8")).toBe(monthlyBefore);
    expect(db.get(bullet.id)?.salience).toBe(0.2);
    db.close();
  });
});
