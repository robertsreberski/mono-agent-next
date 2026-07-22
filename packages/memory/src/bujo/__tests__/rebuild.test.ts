import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import { appendAssociation, appendEntity, appendRelation } from "../graph.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { fakeEmbeddings } from "./helpers.js";
import { rebuildFromMarkdown } from "../rebuild.js";

describe("rebuildFromMarkdown", () => {
  it("indexes every bullet across daily files, with no LLM, deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-06-14.md"),
      '# 2026-06-14\n\n- [ ] Ship substrate.  <!--mem id=01A type=task status=open salience=0.8 isInsight=0 created=2026-06-14T09:00:00.000Z refs=-->\n');
    writeFileSync(join(root, "daily", "2026-06-15.md"),
      '# 2026-06-15\n\n- – Morgan prefers opt-in memory.  <!--mem id=01B type=note status=open salience=0.9 isInsight=1 created=2026-06-15T09:00:00.000Z refs=-->\n');

    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await rebuildFromMarkdown(root, db);
    expect(result.indexed).toBe(2);
    expect(db.count()).toBe(2);
    expect((await db.recall("substrate", { topK: 2 })).map((h) => h.record.id)).toContain("01A");
    db.close();
  });

  it("ingests entities and relations from graph.jsonl after rebuild — no LLM called", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-graph-"));
    mkdirSync(join(root, "daily"), { recursive: true });

    // Write a daily file so rebuild has something to index
    writeFileSync(
      join(root, "daily", "2026-06-15.md"),
      "# 2026-06-15\n\n- – Morgan maintains mono-agent.  <!--mem id=RB1 type=note status=open salience=0.7 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->\n",
    );

    // Write graph.jsonl with an entity and a relation
    appendEntity(root, { id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    appendEntity(root, { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: "2026-06-15T09:00:00.000Z" });
    appendRelation(root, { src: "person:morgan", dst: "project:mono-agent", relation: "maintains", createdAt: "2026-06-15T09:00:00.000Z" });
    appendAssociation(root, {
      memoryId: "RB1",
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: "2026-06-15T09:00:00.000Z",
    });

    // Open a fresh db (simulates a delete+rebuild)
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });

    // No LLM passed — rebuildFromMarkdown takes no llm parameter
    const llmSpy = vi.fn();
    const result = await rebuildFromMarkdown(root, db);

    // Memories were indexed
    expect(result.indexed).toBe(1);

    // Entities were loaded from graph.jsonl into the db
    expect(db.getEntity("person:morgan")).toMatchObject({ name: "Morgan", type: "person" });
    expect(db.getEntity("project:mono-agent")).toMatchObject({ name: "mono-agent", type: "project" });

    // Relations were loaded
    expect(db.relationsFor("person:morgan")).toEqual([{
      src: "person:morgan",
      dst: "project:mono-agent",
      relation: "maintains",
      createdAt: "2026-06-15T09:00:00.000Z",
    }]);
    expect(db.associationsForMemory("RB1")).toEqual([{
      memoryId: "RB1",
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: "2026-06-15T09:00:00.000Z",
    }]);
    expect(auditCanonicalGraphParity(root, db).matches).toBe(true);

    // LLM was never called (rebuildFromMarkdown has no llm parameter)
    expect(llmSpy).not.toHaveBeenCalled();

    db.close();
  });

  it("records the real 1-based markdown line number for each bullet (not the bullet ordinal)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-line-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    // line 1: heading, line 2: blank, line 3: bullet 01A, line 4: blank, line 5: bullet 01B
    writeFileSync(
      join(root, "daily", "2026-06-14.md"),
      "# 2026-06-14\n\n- [ ] First.  <!--mem id=01A type=task status=open salience=0.8 isInsight=0 created=2026-06-14T09:00:00.000Z refs=-->\n\n- – Second.  <!--mem id=01B type=note status=open salience=0.5 isInsight=0 created=2026-06-14T10:00:00.000Z refs=-->\n",
    );

    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    await rebuildFromMarkdown(root, db);
    expect(db.get("01A")?.source.line).toBe(3);
    expect(db.get("01B")?.source.line).toBe(5);
    db.close();
  });

  it("uses the split bullet's physical visible line for rebuild provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-split-line-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(
      join(root, "daily", "2026-06-14.md"),
      [
        "# 2026-06-14",
        "",
        "- – First split bullet.",
        "  <!--mem id=01A type=note status=open salience=0.8 isInsight=0 created=2026-06-14T09:00:00.000Z refs=-->",
        "- – Second split bullet.",
        "  <!--mem id=01B type=note status=open salience=0.5 isInsight=0 created=2026-06-14T10:00:00.000Z refs=-->",
        "",
      ].join("\n"),
    );

    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    await rebuildFromMarkdown(root, db);
    expect(db.get("01A")?.source.line).toBe(3);
    expect(db.get("01B")?.source.line).toBe(5);
    db.close();
  });

  it("treats a missing daily directory as empty (indexed 0, no throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-noenoent-")); // no daily/ created
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await rebuildFromMarkdown(root, db);
    expect(result.indexed).toBe(0);
    db.close();
  });

  it("re-throws non-ENOENT readdir errors instead of silently wiping the index", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-enotdir-"));
    // Make `daily` a FILE, so readdirSync throws ENOTDIR (not ENOENT) → must propagate.
    writeFileSync(join(root, "daily"), "not a directory");
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    await expect(rebuildFromMarkdown(root, db)).rejects.toThrow();
    db.close();
  });
});
