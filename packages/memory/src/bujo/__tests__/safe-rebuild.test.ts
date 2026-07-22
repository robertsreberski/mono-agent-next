import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import type { EmbeddingProvider } from "../../search/index.js";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { loadVec } from "../../store/vec.js";
import {
  createBujoMemoryStore,
  auditCanonicalGraphParity,
  appendGraphBatch,
  migrate,
  readGraph,
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
  serializeBullet,
} from "../index.js";
import { acquireMemoryWriterLease } from "../generations.js";
import { replayCaptureOutbox, writeCaptureIntent } from "../capture-outbox.js";
import { appendBullet, dailyFilePath, normalizedContentHash } from "../daily.js";
import { assertCanonicalGraphRepairBaseParity, auditCanonicalIndexHealth } from "../rebuild.js";
import {
  REPLAY_PROJECTION_FILE,
  initializeReplayProjection,
  readReplayProjectionStrict,
} from "../replay-projection.js";
import type { Bullet } from "../types.js";

const NOW = "2026-07-11T09:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("safe memory index rebuild", () => {
  it("creates a new nested memory root before any maintenance marker can exist", async () => {
    const parent = tempRoot();
    const root = join(parent, "consumer", ".mono-agent", "memory");
    const result = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(result.indexed).toBe(0);
    expect(existsSync(result.active)).toBe(true);
  });

  it("indexes root-level legacy dates while daily/<date> takes deterministic precedence", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "2026-07-09.md"),
      `# 2026-07-09\n\n${serializeBullet(bullet("ROOT-ONLY", "Root-level legacy source is preserved."))}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "2026-07-11.md"),
      `# 2026-07-11\n\n${serializeBullet(bullet("SHADOWED", "Shadowed root-level copy."))}\n`,
      "utf8",
    );
    writeDaily(root, [bullet("CANONICAL", "Canonical daily layout wins.")]);

    const result = await safeRebuildMemoryIndex({ root, tier: "lite" });

    expect(result.indexed).toBe(2);
    expect(readTexts(result.active)).toEqual([
      "Canonical daily layout wins.",
      "Root-level legacy source is preserved.",
    ]);
  });

  it("keeps live canonical graph timestamps identical after safe rebuild", async () => {
    const root = tempRoot();
    initializeReplayProjection(root);
    writeDaily(root, [bullet("M1", "Morgan maintains the memory graph.")]);
    const live = openMemoryDb({ path: join(root, "memory.db"), embeddings: embeddings("test:graph-parity", 8), dim: 8 });
    await live.upsert({ ...note("M1", "Morgan maintains the memory graph."), source: { file: "daily/2026-07-11.md", line: 3 } });
    const initial = appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      associations: [{
        memoryId: "M1",
        entityId: "person:morgan",
        provenance: "legacy-name-match",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    for (const entity of initial.entities) live.mirrorCanonicalEntity(entity);
    for (const relation of initial.relations) live.mirrorCanonicalRelation(relation);
    for (const association of initial.associations) live.mirrorCanonicalAssociation(association);
    const updated = appendGraphBatch(root, {
      entities: [{ id: "person:morgan", name: "Morgan R.", type: "person", createdAt: NOW }],
      associations: [{ memoryId: "M1", entityId: "person:morgan", provenance: "capture", createdAt: NOW }],
    });
    live.mirrorCanonicalEntity(updated.entities[0]!);
    live.mirrorCanonicalAssociation(updated.associations[0]!);
    const liveEntity = live.getEntity("person:morgan");
    const liveRelation = live.relationsFor("person:morgan");
    const liveAssociation = live.associationsForMemory("M1");
    expect(auditCanonicalGraphParity(root, live).matches).toBe(true);
    live.close();

    expect(liveEntity).toMatchObject({
      name: "Morgan R.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: NOW,
    });
    expect(liveAssociation).toEqual([expect.objectContaining({
      provenance: "capture",
      createdAt: "2026-01-01T00:00:00.000Z",
    })]);

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:graph-parity", 8),
      dim: 8,
    });
    const rebuilt = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(rebuilt.getEntity("person:morgan")).toEqual(liveEntity);
      expect(rebuilt.relationsFor("person:morgan")).toEqual(liveRelation);
      expect(rebuilt.associationsForMemory("M1")).toEqual(liveAssociation);
      expect(auditCanonicalGraphParity(root, rebuilt).matches).toBe(true);
    } finally {
      rebuilt.close();
    }
  });

  it("audits deterministic legacy-name associations as part of the BuJo projection", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Morgan owns the project.")]);
    appendGraphBatch(root, {
      entities: [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: NOW }],
    });

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:derived-graph-parity", 8),
      dim: 8,
    });
    expect(result.derivedLegacyAssociations).toBe(1);
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(auditCanonicalGraphParity(root, db)).toMatchObject({
        status: "match",
        tier: "bujo",
        matches: true,
        associations: { canonical: 1, active: 1, matched: 1, extra: 0 },
      });
    } finally {
      db.close();
    }
  });

  it.each(["lite", "journal"] as const)("expects an empty graph projection for managed %s", async (tier) => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Tier-specific graph projection.")]);
    appendGraphBatch(root, {
      entities: [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: NOW }],
    });

    const result = await safeRebuildMemoryIndex({
      root,
      tier,
      ...(tier === "journal"
        ? { embeddings: embeddings("test:empty-tier-graph", 8), dim: 8 }
        : {}),
    });
    const db = openMemoryDb({ path: result.active, readOnly: true, ...(tier === "journal" ? { dim: 8 } : {}) });
    try {
      expect(auditCanonicalGraphParity(root, db)).toMatchObject({
        status: "match",
        tier,
        matches: true,
        entities: { canonical: 0, active: 0, matched: 0, missing: 0 },
      });
    } finally {
      db.close();
    }
  });

  it("replays an exact pending capture intent before taking the rebuild source snapshot", async () => {
    const root = tempRoot();
    const item = bullet("PENDING", "Morgan owns safe rebuild replay.");
    const record: MemoryRecord = {
      ...note(item.id, item.text),
      salience: item.salience,
      source: { file: "daily/2026-07-11.md", line: 3 },
    };
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file: "daily/2026-07-11.md", bullet: item },
      record,
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
      threads: [],
    }], {
      entities: [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: NOW }],
      associations: [{
        memoryId: item.id,
        entityId: "person:morgan",
        provenance: "capture",
        createdAt: NOW,
      }],
    }, NOW);

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:pending-replay", 8),
      dim: 8,
    });
    const rebuilt = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(rebuilt.get(item.id)?.text).toBe(item.text);
      expect(rebuilt.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "person:morgan", provenance: "capture" }),
      ]);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      rebuilt.close();
    }
  });

  it("accepts its own rollback retirement when replaying a pending ADD after two Lite rebuilds", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("BASE-ROLLBACK-REPLAY", "The retained Lite base is canonical.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const retained = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(retained.rollback).toBeDefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeDefined();

    const item = bullet("PENDING-AFTER-ROLLBACK", "Pending replay advances the retained source safely.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      threads: [],
    }], {}, NOW);

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "lite" });

    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const active = openMemoryDb({ path: rebuilt.active, readOnly: true });
    try {
      expect(active.get(item.id)?.text).toBe(item.text);
    } finally {
      active.close();
    }
    const manifest = readManagedIndexManifest(root);
    expect(manifest?.active.sourceFingerprint).toBe(rebuilt.sourceFingerprint);
    expect(manifest?.rollback?.sourceFingerprint).toBe(rebuilt.sourceFingerprint);
  });

  it("retires current-identity capture recovery before a later snapshot failure", async () => {
    const root = tempRoot();
    const model = embeddings("test:after-snapshot", 8);
    writeDaily(root, [bullet("BASE", "The current generation remains active.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: model, dim: 8 });
    const activeBefore = resolveActiveMemoryDbPath(root);
    const item = bullet("PENDING-FAIL", "Pending capture survives a rebuild fault.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 8),
      threads: [],
    }], {
      entities: [{ id: "concept:recovery", name: "Recovery", type: "concept", createdAt: NOW }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:recovery",
        provenance: "capture",
        createdAt: NOW,
      }],
    }, NOW);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: model,
      dim: 8,
      hooks: { afterSnapshot: () => { throw new Error("fault-after-retained-snapshot"); } },
    })).rejects.toThrow("fault-after-retained-snapshot");

    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const repaired = openMemoryDb({ path: activeBefore, readOnly: true, dim: 8 });
    try {
      expect(repaired.get(item.id)?.text).toBe(item.text);
      expect(repaired.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "concept:recovery", provenance: "capture" }),
      ]);
    } finally {
      repaired.close();
    }

    const startup = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: model,
      dim: 8,
      llm: { id: "must-not-run", complete: async () => { throw new Error("startup replay called LLM"); } },
    });
    await startup.close();
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });

  it("carries a pending capture across a dimension change and into immediate rollback", async () => {
    const root = tempRoot();
    const oldModel = embeddings("test:old-dimension", 8);
    const newModel = embeddings("test:new-dimension", 4);
    writeDaily(root, [bullet("BASE", "Base record under the old model.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: oldModel, dim: 8 });
    const item = bullet("PENDING-DIM", "Pending capture crosses model dimensions safely.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 8),
      threads: [],
    }], {
      entities: [{ id: "concept:dimension", name: "Dimension", type: "concept", createdAt: NOW }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:dimension",
        provenance: "capture",
        createdAt: NOW,
      }],
    }, NOW);

    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: newModel,
      dim: 4,
    });
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const newDb = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(newDb.get(item.id)).toMatchObject({ text: item.text, embeddingModel: newModel.id, dim: 4 });
      expect(newDb.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "concept:dimension", provenance: "capture" }),
      ]);
    } finally {
      newDb.close();
    }

    const rolledBack = await rollbackMemoryIndex({
      root,
      tier: "bujo",
      embeddings: oldModel,
      dim: 8,
    });
    const oldDb = openMemoryDb({ path: rolledBack.active, readOnly: true, dim: 8 });
    try {
      expect(oldDb.get(item.id)).toMatchObject({ text: item.text, embeddingModel: oldModel.id, dim: 8 });
      expect(oldDb.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "concept:dimension", provenance: "capture" }),
      ]);
    } finally {
      oldDb.close();
    }
  });

  it("refuses a retained completed-turn capture before a BuJo-to-Journal dimension change", async () => {
    const root = tempRoot();
    const oldModel = embeddings("test:retained-tier-old", 8);
    writeDaily(root, [bullet("BASE-RETAINED", "The active BuJo generation remains unchanged.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: oldModel, dim: 8 });
    const activeBefore = resolveActiveMemoryDbPath(root);
    const sourceBefore = readFileSync(join(root, "daily", "2026-07-11.md"), "utf8");
    const item = bullet("C-RETAINED", "A retained run-owned capture cannot cross into Journal.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 8),
      threads: [],
    }], {}, NOW, { retentionKey: "a".repeat(64) });

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:retained-tier-journal", 4),
      dim: 4,
    })).rejects.toThrow(/retained completed-turn capture intent requires BuJo.*finish.*intake/iu);
    await expect(safeRebuildMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/retained completed-turn capture intent requires BuJo.*finish.*intake/iu);

    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
    expect(readFileSync(join(root, "daily", "2026-07-11.md"), "utf8")).toBe(sourceBefore);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("keeps a retained completed-turn capture replayable across a compatible BuJo dimension change", async () => {
    const root = tempRoot();
    const oldModel = embeddings("test:retained-dimension-old", 8);
    const newModel = embeddings("test:retained-dimension-new", 4);
    writeDaily(root, [bullet("BASE-RETAINED-DIM", "The compatible BuJo rebuild has a base row.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: oldModel, dim: 8 });
    const item = bullet("C-RETAINED-DIM", "A retained run-owned capture is re-embedded safely.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 8),
      threads: [],
    }], {
      entities: [{ id: "concept:retained", name: "Retained", type: "concept", createdAt: NOW }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:retained",
        provenance: "capture",
        createdAt: NOW,
      }],
    }, NOW, { retentionKey: "b".repeat(64) });

    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: newModel,
      dim: 4,
    });

    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    const db = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(db.get(item.id)).toMatchObject({ text: item.text, embeddingModel: newModel.id, dim: 4 });
      expect(db.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "concept:retained", provenance: "capture" }),
      ]);
    } finally {
      db.close();
    }

    const startup = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: newModel,
      dim: 4,
      llm: { id: "must-not-run", complete: async () => { throw new Error("startup replay called LLM"); } },
    });
    await startup.close();
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it.each(["journal", "lite"] as const)(
    "retires a pending BuJo capture under the old identity before rebuilding into %s",
    async (tier) => {
      const root = tempRoot();
      const oldModel = embeddings("test:tier-old", 8);
      writeDaily(root, [bullet("BASE-TIER", "Base record before the tier change.")]);
      await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: oldModel, dim: 8 });
      const item = bullet("BUJO-PENDING", "Pending BuJo fact crosses a tier boundary.");
      const file = "daily/2026-07-11.md";
      writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "add",
        id: item.id,
        after: { file, bullet: item },
        record: memoryRecordForBullet(item, file),
        vector: deterministicVector(item.text, 8),
        threads: [],
      }], {
        entities: [{ id: "concept:tier", name: "Tier", type: "concept", createdAt: NOW }],
        associations: [{
          memoryId: item.id,
          entityId: "concept:tier",
          provenance: "capture",
          createdAt: NOW,
        }],
      }, NOW);

      const result = tier === "journal"
        ? await safeRebuildMemoryIndex({
          root,
          tier,
          embeddings: embeddings("test:tier-journal", 4),
          dim: 4,
        })
        : await safeRebuildMemoryIndex({ root, tier });
      const db = openMemoryDb({ path: result.active, readOnly: true, ...(tier === "journal" ? { dim: 4 } : {}) });
      try {
        const expectedId = tier === "journal" ? `J-${normalizedContentHash(item.text)}` : item.id;
        expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
        expect(db.count()).toBe(2);
        expect(db.get(expectedId)?.text).toBe(item.text);
        if (tier === "journal") expect(db.get(item.id)).toBeUndefined();
        expect(db.validationSnapshot()).toMatchObject({ entities: 0, relations: 0, associations: 0 });
      } finally {
        db.close();
      }
    },
  );

  it("retires a pending BuJo NOOP before Journal canonicalizes its memory id", async () => {
    const root = tempRoot();
    const item = bullet("BUJO-NOOP", "A pending NOOP must not brick the Journal transition.");
    const oldModel = embeddings("test:noop-old", 8);
    writeDaily(root, [item]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: oldModel, dim: 8 });
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: item.id,
      expected: { file, bullet: item },
    }], {}, NOW);

    const model = embeddings("test:noop-journal", 4);
    const result = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: model, dim: 4 });
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 4 });
    try {
      expect(db.get(item.id)).toBeUndefined();
      expect(db.get(`J-${normalizedContentHash(item.text)}`)?.text).toBe(item.text);
    } finally {
      db.close();
    }
    const startup = createBujoMemoryStore({ root, tier: "journal", embeddings: model, dim: 4 });
    await startup.close();
  });

  it.each(["journal", "lite"] as const)(
    "rejects a pending capture without an active DB before staging source into %s",
    async (tier) => {
      const root = tempRoot();
      const item = bullet("NO-ACTIVE-TIER", "No active DB exists for this capture.");
      const file = "daily/2026-07-11.md";
      writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "add",
        id: item.id,
        after: { file, bullet: item },
        record: memoryRecordForBullet(item, file),
        vector: deterministicVector(item.text, 8),
        threads: [],
      }], {}, NOW);

      const rebuild = tier === "journal"
        ? safeRebuildMemoryIndex({ root, tier, embeddings: embeddings("test:no-active-journal", 4), dim: 4 })
        : safeRebuildMemoryIndex({ root, tier });
      await expect(rebuild).rejects.toThrow(/without an active index.*only recover into BuJo|only recover into BuJo/iu);

      expect(existsSync(join(root, file))).toBe(false);
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
      expect(readManagedIndexManifest(root)).toBeUndefined();
    },
  );

  it("completes a no-active NOOP through the candidate before activation", async () => {
    const root = tempRoot();
    const item = bullet("NO-ACTIVE-NOOP", "The canonical NOOP target already exists.");
    writeDaily(root, [item]);
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: item.id,
      expected: { file, bullet: item },
    }], {}, NOW);

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:no-active-noop", 8),
      dim: 8,
    });

    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(db.get(item.id)?.text).toBe(item.text);
    } finally {
      db.close();
    }
  });

  it("rejects staged-candidate lifecycle and edge changes outside the exact durable replay", async () => {
    const root = tempRoot();
    const item = bullet("NO-ACTIVE-ADD", "Only the staged ADD intent may shape its candidate.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 8),
      threads: [],
    }], {}, NOW);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:no-active-tamper", 8),
      dim: 8,
      hooks: {
        afterCandidateBuilt: () => {
          const generations = join(realpathSync(root), ".index", "generations");
          const candidate = join(generations, readdirSync(generations)[0] ?? "missing", "memory.db");
          const raw = new BetterSqlite3(candidate);
          try {
            raw.prepare(`UPDATE memories SET valid_to = ? WHERE id = ?`)
              .run("2000-01-01T00:00:00.000Z", item.id);
            raw.prepare(
              `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'thread', 1.0, ?)`,
            ).run(item.id, item.id, NOW);
            raw.pragma("wal_checkpoint(TRUNCATE)");
          } finally {
            raw.close();
          }
        },
      },
    })).rejects.toThrow(/staged capture candidate changed.*durable replay/iu);

    expect(readManagedIndexManifest(root)).toBeUndefined();
  });

  it("completes a no-active SUPERSEDE lifecycle through the candidate before activation", async () => {
    const root = tempRoot();
    const old = bullet("NO-ACTIVE-OLD", "The old canonical claim.");
    const replacement = bullet("NO-ACTIVE-NEW", "The replacement canonical claim.");
    writeDaily(root, [old]);
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecordForBullet(replacement, file),
      vector: deterministicVector(replacement.text, 8),
      at: NOW,
    }], {}, NOW);

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:no-active-supersede", 8),
      dim: 8,
    });

    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(db.get(old.id)).toMatchObject({
        status: "invalidated",
        supersededBy: replacement.id,
        supersededAt: NOW,
        validTo: NOW,
      });
      expect(db.get(replacement.id)?.text).toBe(replacement.text);
      expect(db.edges(old.id)).toEqual([
        expect.objectContaining({ dst: replacement.id, kind: "supersedes" }),
      ]);
    } finally {
      db.close();
    }

    const healthDb = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(auditCanonicalIndexHealth(root, "bujo", healthDb)).toEqual({ status: "match" });
    } finally {
      healthDb.close();
    }
  });

  it("keeps a no-active ADD thread edge healthy after its replay intent is retired", async () => {
    const root = tempRoot();
    const target = bullet("NO-ACTIVE-THREAD-TARGET", "The established canonical thread target.");
    const added = bullet("NO-ACTIVE-THREAD-ADD", "The new canonical memory links to its neighbour.");
    writeDaily(root, [target]);
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecordForBullet(added, file),
      vector: deterministicVector(added.text, 8),
      threads: [{ src: added.id, dst: target.id, weight: 0.8 }],
    }], {}, NOW);

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:no-active-thread", 8),
      dim: 8,
    });

    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(db.edges(added.id)).toEqual([
        expect.objectContaining({ dst: target.id, kind: "thread", weight: 0.8 }),
      ]);
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("uses the later endpoint timestamp when replaying a no-active ADD against a future-clock target", async () => {
    const root = tempRoot();
    const sourceAt = new Date("2099-01-01T00:00:00.000Z");
    const targetAt = new Date("2099-01-02T00:00:00.000Z");
    const target = {
      ...bullet("FUTURE-THREAD-TARGET", "The established target has a future-clock timestamp."),
      createdAt: targetAt.toISOString(),
    };
    const added = {
      ...bullet("FUTURE-THREAD-ADD", "The new memory must not inherit the host wall clock."),
      createdAt: sourceAt.toISOString(),
    };
    appendBullet(root, target, targetAt);
    const file = relative(root, dailyFilePath(root, sourceAt));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecordForBullet(added, file),
      vector: deterministicVector(added.text, 8),
      threads: [{ src: added.id, dst: target.id, weight: 0.8 }],
    }], {}, sourceAt.toISOString());

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:no-active-future-thread", 8),
      dim: 8,
    });

    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(db.allEdges()).toContainEqual({
        src: added.id,
        dst: target.id,
        kind: "thread",
        weight: 0.8,
        createdAt: targetAt.toISOString(),
      });
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("refuses a managed legacy replay inventory when its sidecar is missing", async () => {
    const root = tempRoot();
    const source = bullet("LEGACY-REPLAY-SOURCE", "Legacy replay source remains canonical.");
    const target = bullet("LEGACY-REPLAY-TARGET", "Legacy replay target remains canonical.");
    writeDaily(root, [source, target]);
    const provider = embeddings("test:legacy-replay-refusal", 8);
    const first = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });
    const before = readFileSync(join(root, "daily", "2026-07-11.md"), "utf8");
    const db = openMemoryDb({ path: first.active, dim: 8 });
    try {
      db.addEdge(source.id, target.id, "thread", 0.8, NOW);
      db.checkpoint();
    } finally {
      db.close();
    }
    rmSync(join(root, REPLAY_PROJECTION_FILE));

    await expect(safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 }))
      .rejects.toThrow(/sidecar.*missing.*replay|explicit.*adoption/iu);

    expect(readFileSync(join(root, "daily", "2026-07-11.md"), "utf8")).toBe(before);
    expect(existsSync(join(root, REPLAY_PROJECTION_FILE))).toBe(false);
  });

  it.each(["lite", "journal"] as const)(
    "does not retain replay-only lifecycle or edges as a repairable %s rollback",
    async (tier) => {
      const root = tempRoot();
      const old = { ...bullet("NON-BUJO-OLD", "The non-BuJo prior claim."), status: "invalidated" as const };
      const replacement = bullet("NON-BUJO-NEW", "The non-BuJo replacement claim.");
      writeDaily(root, [old, replacement]);
      const model = embeddings(`test:${tier}-replay-rejection`, 8);
      const first = tier === "journal"
        ? await safeRebuildMemoryIndex({ root, tier, embeddings: model, dim: 8 })
        : await safeRebuildMemoryIndex({ root, tier });
      const db = openMemoryDb({ path: first.active, ...(tier === "journal" ? { dim: 8 } : {}) });
      try {
        const records = db.allMemories();
        const oldId = records.find((record) => record.text === old.text)?.id;
        const replacementId = records.find((record) => record.text === replacement.text)?.id;
        expect(oldId).toBeDefined();
        expect(replacementId).toBeDefined();
        db.markSuperseded(oldId!, replacementId!, NOW);
        db.addEdge(replacementId!, oldId!, "thread", 0.8);
        db.checkpoint();
      } finally {
        db.close();
      }

      const rebuilt = tier === "journal"
        ? await safeRebuildMemoryIndex({ root, tier, embeddings: model, dim: 8 })
        : await safeRebuildMemoryIndex({ root, tier });

      expect(rebuilt.rollback).toBeUndefined();
    },
  );

  it("validates managed metadata and actual vector DDL before replay can mutate source", async () => {
    const root = tempRoot();
    const model = embeddings("test:ddl-preflight", 8);
    writeDaily(root, [bullet("DDL-BASE", "The active DB has an eight-dimensional vector table.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: model, dim: 8 });
    const manifestPath = join(root, ".index", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { active: { dimension: number } };
    manifest.active.dimension = 4;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const item = bullet("DDL-PENDING", "This source must remain unstaged after identity failure.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 4),
      threads: [],
    }], {}, NOW);

    await expect(safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: model, dim: 8 }))
      .rejects.toThrow(/metadata|dimension|vector DDL/iu);

    const canonical = readFileSync(join(root, file), "utf8");
    expect(canonical).not.toContain(item.id);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("has no fallible capture replay tail after manifest activation", async () => {
    const root = tempRoot();
    const model = embeddings("test:post-activation", 8);
    writeDaily(root, [bullet("BASE", "Base record before uncertain activation.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: model, dim: 8 });
    const before = resolveActiveMemoryDbPath(root);
    const item = bullet("PENDING-ACTIVE", "Pending capture survives activation uncertainty.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecordForBullet(item, file),
      vector: deterministicVector(item.text, 8),
      threads: [],
    }], {}, NOW);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: model,
      dim: 8,
      hooks: { afterManifestRename: () => { throw new Error("crash-after-activation"); } },
    })).rejects.toThrow(/crash-after-activation|activation.*uncertain/iu);

    expect(resolveActiveMemoryDbPath(root)).not.toBe(before);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const startup = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: model,
      dim: 8,
      llm: { id: "must-not-run", complete: async () => { throw new Error("startup replay called LLM"); } },
    });
    await startup.close();
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    const active = openMemoryDb({ path: resolveActiveMemoryDbPath(root), readOnly: true, dim: 8 });
    try {
      expect(active.get(item.id)?.text).toBe(item.text);
      expect(active.hasVector(item.id)).toBe(true);
    } finally {
      active.close();
    }
  });

  it("refuses explicit rollback while a capture intent is pending", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("ONE", "First Lite generation.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    writeDaily(root, [bullet("ONE", "First Lite generation."), bullet("TWO", "Second Lite generation.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const activeBefore = resolveActiveMemoryDbPath(root);
    const pending = bullet("PENDING-ROLLBACK", "Rollback must recover this under the current identity first.");
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: pending.id,
      after: { file, bullet: pending },
      record: memoryRecordForBullet(pending, file),
      threads: [],
    }], {}, NOW);

    await expect(rollbackMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/capture intent.*pending.*current writable store|recover/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("recovers a paid migration decision provider-free before the rebuild snapshot", async () => {
    const root = tempRoot();
    const model = embeddings("test:migration-pending", 8);
    const createdAt = "2026-01-01T09:00:00.000Z";
    const item = { ...bullet("MIG-PENDING", "A paid migration decision remains durable."), createdAt, salience: 0.2 };
    const created = new Date(createdAt);
    appendBullet(root, item, created);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: model, dim: 8 });
    await db.upsert({
      ...memoryRecordForBullet(item, relative(root, dailyFilePath(root, created))),
      salience: 0.2,
    });
    await expect(migrate({
      db,
      root,
      llm: { id: "paid", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => new Date(NOW),
      hooks: { afterDecisionDurable: () => { throw new Error("fault-after-paid-decision"); } },
    })).rejects.toThrow("fault-after-paid-decision");
    db.close();
    const before = readFileSync(dailyFilePath(root, created), "utf8");
    const embed = vi.fn(model.embed);

    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: { id: model.id, embed },
      dim: 8,
      hooks: {
        afterSnapshot: () => {
          expect(embed).not.toHaveBeenCalled();
          expect(readFileSync(dailyFilePath(root, created), "utf8")).not.toBe(before);
          expect(readFileSync(join(root, "monthly", "2026-07.md"), "utf8"))
            .not.toContain("mono-agent-migrate:");
        },
      },
    });

    expect(embed).toHaveBeenCalled();
    expect(readFileSync(join(root, "monthly", "2026-07.md"), "utf8")).not.toContain("mono-agent-migrate:");
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 8 });
    try {
      expect(current.get(item.id)?.salience).toBe(0.5);
    } finally {
      current.close();
    }
  });

  it("recovers a DB-before forget migration before verifying a coexisting complete receipt", async () => {
    const root = tempRoot();
    const model = embeddings("test:receipt-before-forget", 8);
    const createdAt = "2026-01-01T09:00:00.000Z";
    const item = { ...bullet("MIG-RECEIPT-FORGET", "A later forget owns replay state."), createdAt, salience: 0.2 };
    appendBullet(root, item, new Date(createdAt));
    const initial = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: model, dim: 8 });
    const db = openMemoryDb({ path: initial.active, embeddings: model, dim: 8 });
    const receipt = writeCaptureIntent(root, [], {}, NOW, { retentionKey: "9".repeat(64) });
    replayCaptureOutbox(root, db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
    expect((JSON.parse(readFileSync(join(root, receipt.file), "utf8")) as { state: string }).state)
      .toBe("complete");
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "commitPreparedUpserts") {
          return () => { throw new Error("crash-before-forget-db"); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;
    await expect(migrate({
      db: failingDb,
      root,
      llm: { id: "forget", complete: async () => JSON.stringify({ action: "forget" }) },
      now: () => new Date(NOW),
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    })).rejects.toThrow("crash-before-forget-db");
    expect(readReplayProjectionStrict(root).projection.terminals).toEqual([
      expect.objectContaining({ id: item.id, at: NOW, authorityKind: "migration" }),
    ]);
    expect(db.get(item.id)).toMatchObject({ status: "open" });
    expect(db.get(item.id)).not.toHaveProperty("validTo");
    db.close();

    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: model,
      dim: 8,
      hooks: {
        afterSnapshot: () => {
          expect(readFileSync(join(root, "monthly", "2026-07.md"), "utf8"))
            .not.toContain("mono-agent-migrate:");
        },
      },
    });
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 8 });
    try {
      expect(current.get(item.id)).toMatchObject({ status: "dropped", validTo: NOW });
    } finally {
      current.close();
    }
    expect((JSON.parse(readFileSync(join(root, receipt.file), "utf8")) as { state: string }).state)
      .toBe("complete");
  });

  it("builds beside a divergent legacy index without advertising it as a safe rollback", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Legacy index sentinel."));
    writeDaily(root, [bullet("NEW", "Canonical source sentinel.")]);

    const legacyPath = await resolveActiveMemoryDbPath(root);
    expect(legacyPath).toBe(join(realpathSync(root), "memory.db"));

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "lite" });

    const candidatePath = await resolveActiveMemoryDbPath(root);
    expect(candidatePath).not.toBe(legacyPath);
    expect(readTexts(candidatePath)).toEqual(["Canonical source sentinel."]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(readTexts(legacyPath)).toEqual(["Legacy index sentinel."]);
    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    await expect(rollbackMemoryIndex({ root, tier: "lite" })).rejects.toThrow(/no retained rollback/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(candidatePath);
  });

  it("does not switch the active pointer when a closed candidate fails before manifest activation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Still active after a candidate fault."));
    writeDaily(root, [bullet("NEW", "Candidate that must not activate.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterCandidateValidated: () => {
          throw new Error("fault-after-candidate-validation");
        },
      },
    })).rejects.toThrow("fault-after-candidate-validation");

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
    expect(readTexts(before)).toEqual(["Still active after a candidate fault."]);
  });

  it("keeps the newly referenced generation when failure is injected after manifest rename", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Rollback sentinel."));
    writeDaily(root, [bullet("NEW", "Activated before directory-sync reporting failed.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterManifestRename: () => {
          throw new Error("fault-after-manifest-rename");
        },
      },
    })).rejects.toThrow(/fault-after-manifest-rename|activation.*uncertain/iu);

    const after = await resolveActiveMemoryDbPath(root);
    expect(after).not.toBe(before);
    expect(existsSync(after)).toBe(true);
    expect(readTexts(after)).toEqual(["Activated before directory-sync reporting failed."]);
  });

  it("performs a final source fingerprint CAS and leaves the prior generation active on mutation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Source-CAS rollback sentinel."));
    writeDaily(root, [bullet("A", "Snapshot A.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        beforeSourceCas: () => writeDaily(root, [bullet("B", "Snapshot B changed concurrently.")]),
      },
    })).rejects.toThrow(/source|fingerprint|concurrent/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
    expect(readTexts(before)).toEqual(["Source-CAS rollback sentinel."]);
  });

  it("rejects a rebuild while a configured writer is live before making any embedding call", async () => {
    const root = tempRoot();
    const store = createBujoMemoryStore({ root, tier: "lite" });
    await store.appendHostSummary("conversation", "A live writer owns this memory root.");
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array<number>(8).fill(0)));

    try {
      await expect(safeRebuildMemoryIndex({
        root,
        tier: "journal",
        embeddings: { id: "test:model", embed },
        dim: 8,
      })).rejects.toThrow(/active|agent|lock|stop|writer/iu);
      expect(embed).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("serializes competing rebuilds and rejects the loser before it pays for embeddings", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("ONE", "One canonical fact.")]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const firstEmbeddings = embeddings("test:first", 8);
    const secondEmbed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array<number>(8).fill(0)));

    const first = safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: firstEmbeddings,
      dim: 8,
      hooks: {
        afterSnapshot: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    await entered.promise;

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: { id: "test:second", embed: secondEmbed },
      dim: 8,
    })).rejects.toThrow(/active|lock|rebuild|transaction/iu);
    expect(secondEmbed).not.toHaveBeenCalled();

    release.resolve();
    await first;
  });

  it("reconstructs migrated collection state and its supports edge from canonical graph evidence", async () => {
    const root = tempRoot();
    const migrated: Bullet = { ...bullet("MIGRATED", "Clustered into release-notes."), status: "migrated" };
    writeDaily(root, [migrated]);
    writeGraph(root, [{
      kind: "entity",
      id: "collection:release-notes",
      name: "release-notes",
      type: "collection",
      createdAt: NOW,
    }, {
      kind: "association",
      memoryId: migrated.id,
      entityId: "collection:release-notes",
      provenance: "capture",
      createdAt: NOW,
    }]);

    const result = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:cluster-rebuild", 8),
      dim: 8,
    });
    const rebuilt = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(rebuilt.get(migrated.id)?.collection).toBe("release-notes");
      expect(rebuilt.edges(migrated.id)).toEqual([
        expect.objectContaining({ dst: "collection:release-notes", kind: "supports" }),
      ]);
    } finally {
      rebuilt.close();
    }
  });

  it("rejects ambiguous canonical collection associations for one migrated memory", async () => {
    const root = tempRoot();
    const migrated: Bullet = { ...bullet("MIGRATED", "Ambiguous collection evidence."), status: "migrated" };
    writeDaily(root, [migrated]);
    writeGraph(root, ["alpha", "beta"].flatMap((collection) => [{
      kind: "entity",
      id: `collection:${collection}`,
      name: collection,
      type: "collection",
      createdAt: NOW,
    }, {
      kind: "association",
      memoryId: migrated.id,
      entityId: `collection:${collection}`,
      provenance: "capture",
      createdAt: NOW,
    }]));

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: embeddings("test:ambiguous-cluster", 8),
      dim: 8,
    })).rejects.toThrow(/ambiguous collection associations/iu);
  });

  it.each([
    ["malformed JSON", "not-json\n"],
    ["unknown graph kind", `${JSON.stringify({ kind: "future-record", id: "x" })}\n`],
    [
      "orphan association",
      `${JSON.stringify({
        kind: "association",
        memoryId: "M1",
        entityId: "person:missing",
        provenance: "capture",
        createdAt: NOW,
      })}\n`,
    ],
  ])("rejects strict BuJo graph input with %s instead of silently dropping evidence", async (_label, graph) => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Strict graph rollback sentinel."));
    writeDaily(root, [bullet("M1", "Morgan owns the migration plan.")]);
    writeFileSync(join(root, "graph.jsonl"), graph, "utf8");
    const before = await resolveActiveMemoryDbPath(root);
    const embed = vi.fn(embeddings("test:graph", 8).embed);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: { id: "test:graph", embed },
      dim: 8,
    })).rejects.toThrow(/association|graph|kind|json|orphan/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("rejects symlinked canonical source paths without changing the active index", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    await seedLegacy(root, note("OLD", "Symlink defense sentinel."));
    mkdirSync(join(outside, "daily"), { recursive: true });
    writeDaily(outside, [bullet("OUT", "Must not be followed through a symlink.")]);
    symlinkSync(join(outside, "daily"), join(root, "daily"), "dir");
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({ root, tier: "lite" })).rejects.toThrow(/symlink|symbolic|source/iu);
    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("rejects hard-linked canonical source files without changing the active index", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeDaily(root, [bullet("HARDLINK-BASE", "The prior generation remains active.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const before = resolveActiveMemoryDbPath(root);
    const dailyPath = join(root, "daily", "2026-07-11.md");
    const outsidePath = join(outside, "shared-daily.md");
    rmSync(dailyPath);
    writeFileSync(
      outsidePath,
      `# 2026-07-11\n\n${serializeBullet(bullet("HARDLINK-NEW", "Must not be indexed through a hard link."))}\n`,
      "utf8",
    );
    linkSync(outsidePath, dailyPath);

    await expect(safeRebuildMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/hard link|single-link|exactly one/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("uses the same safe path for model and dimension changes, retaining the old generation", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Embedding identity migration fact.")]);

    await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:model-a", 8),
      dim: 8,
    });
    const firstPath = await resolveActiveMemoryDbPath(root);
    expect(readMetadata(firstPath)).toMatchObject({ embeddingModel: "test:model-a", dimension: 8, tier: "journal" });

    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:model-b", 4),
      dim: 4,
    });
    const secondPath = await resolveActiveMemoryDbPath(root);
    expect(secondPath).not.toBe(firstPath);
    expect(readMetadata(secondPath)).toMatchObject({ embeddingModel: "test:model-b", dimension: 4, tier: "journal" });
    expect(existsSync(firstPath)).toBe(true);

    const rollbackEmbed = vi.fn(async (): Promise<number[][]> => {
      throw new Error("rollback must not embed");
    });
    await rollbackMemoryIndex({
      root,
      tier: "journal",
      embeddings: { id: "test:model-a", embed: rollbackEmbed },
      dim: 8,
    });
    expect(rollbackEmbed).not.toHaveBeenCalled();
    expect(await resolveActiveMemoryDbPath(root)).toBe(rebuilt.rollback);
    expect(readMetadata(resolveActiveMemoryDbPath(root))).toMatchObject({
      embeddingModel: "test:model-a",
      dimension: 8,
      tier: "journal",
    });
  });

  it("rejects an embedding response with the wrong vector dimension before activation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Dimension failure rollback sentinel."));
    writeDaily(root, [bullet("M1", "Candidate with bad provider output.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:wrong-dim", 7),
      dim: 8,
    })).rejects.toThrow(/dimension|expected 8|got 7/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it.each(["embedding_model", "dim"] as const)(
    "rejects a rebuilt candidate whose vector-linked %s identity was nulled after close",
    async (column) => {
      const root = tempRoot();
      writeDaily(root, [bullet("M1", "Candidate vector identity must be complete.")]);

      await expect(safeRebuildMemoryIndex({
        root,
        tier: "journal",
        embeddings: embeddings("test:identity-null", 8),
        dim: 8,
        hooks: {
          afterCandidateClosed: () => {
            const generations = join(realpathSync(root), ".index", "generations");
            const candidate = join(generations, readdirSync(generations)[0] ?? "missing", "memory.db");
            nullVectorIdentity(candidate, column);
          },
        },
      })).rejects.toThrow(/vector rows.*incomplete.*identity|model\/dimension identity/iu);

      expect(readManagedIndexManifest(root)).toBeUndefined();
    },
  );

  it("refuses rollback to a retained generation with NULL vector identity", async () => {
    const root = tempRoot();
    const provider = embeddings("test:rollback-identity", 8);
    writeDaily(root, [bullet("M1", "Rollback vector identity must stay complete.")]);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 });
    const second = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 });
    expect(second.rollback).toBeDefined();
    const activeBefore = resolveActiveMemoryDbPath(root);
    nullVectorIdentity(second.rollback!, "both");

    await expect(rollbackMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 }))
      .rejects.toThrow(/vector rows.*incomplete.*identity|model\/dimension identity/iu);

    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
  });

  it("refuses to retain a nonempty BuJo generation with missing vectors", async () => {
    const root = tempRoot();
    const provider = embeddings("test:bujo-retain-coverage", 8);
    writeDaily(root, [bullet("M1", "Every retained BuJo memory needs its vector.")]);
    const first = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });
    deleteAllVectors(first.active);

    await expect(safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 }))
      .rejects.toThrow(/retained rollback generation failed coverage|vector coverage/iu);

    expect(resolveActiveMemoryDbPath(root)).toBe(first.active);
  });

  it("refuses rollback to a nonempty BuJo generation with missing vectors", async () => {
    const root = tempRoot();
    const provider = embeddings("test:bujo-rollback-coverage", 8);
    writeDaily(root, [bullet("M1", "A damaged BuJo rollback must never activate.")]);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });
    const second = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });
    expect(second.rollback).toBeDefined();
    const activeBefore = resolveActiveMemoryDbPath(root);
    deleteAllVectors(second.rollback!);

    await expect(rollbackMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 }))
      .rejects.toThrow(/retained rollback generation failed coverage|vector coverage/iu);

    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
  });

  it("rejects Journal vector mutation after rollback retention", async () => {
    const root = tempRoot();
    const provider = embeddings("test:journal-rollback-backlog", 8);
    writeDaily(root, [bullet("M1", "Journal can restore missing vectors after lexical rollback.")]);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 });
    const second = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 });
    expect(second.rollback).toBeDefined();
    const activeBefore = resolveActiveMemoryDbPath(root);
    deleteAllVectors(second.rollback!);

    await expect(rollbackMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 }))
      .rejects.toThrow(/integrity|vector coverage/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
  });

  it("refuses a stale rollback after canonical source changes", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Source at activation.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const active = await resolveActiveMemoryDbPath(root);

    writeDaily(root, [bullet("M1", "Source changed after activation.")]);
    await expect(rollbackMemoryIndex({ root, tier: "lite" })).rejects.toThrow(/source|fingerprint|stale|changed/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(active);
    expect(readTexts(active)).toEqual(["Source at activation."]);
  });

  it("keeps legacy raw host observations out of BuJo recall and derives only precise whole-name associations", async () => {
    const root = tempRoot();
    writeDaily(root, [
      bullet("M1", "Morgan owns the Annual migration plan."),
      bullet("RAW", "Host-observed completed turn. Morgan asked about setup."),
    ]);
    writeGraph(root, [
      { kind: "entity", id: "person:morgan", name: "Morgan", type: "person", createdAt: NOW },
      { kind: "entity", id: "person:ann", name: "Ann", type: "person", createdAt: NOW },
      { kind: "relation", src: "person:morgan", dst: "person:ann", relation: "mentors", createdAt: "2025-01-02T03:04:05.000Z" },
    ]);

    const result = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: embeddings("test:bujo", 8), dim: 8 });
    expect(result).toMatchObject({ indexed: 1, skippedRawRecords: 1, parsedSourceItems: 2, derivedLegacyAssociations: 1 });
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(db.get("RAW")).toBeUndefined();
      expect(db.associationsForMemory("M1")).toEqual([
        expect.objectContaining({ entityId: "person:morgan", provenance: "legacy-name-match" }),
      ]);
      expect(db.relationsFor("person:morgan")).toEqual([{
        src: "person:morgan",
        dst: "person:ann",
        relation: "mentors",
        createdAt: "2025-01-02T03:04:05.000Z",
      }]);
    } finally {
      db.close();
    }
  });

  it("never supplements a precise captured association with legacy text matches", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Morgan owns Atlas.")]);
    writeGraph(root, [
      { kind: "entity", id: "person:morgan", name: "Morgan", createdAt: NOW },
      { kind: "entity", id: "project:atlas", name: "Atlas", createdAt: NOW },
      { kind: "association", memoryId: "M1", entityId: "person:morgan", provenance: "capture", createdAt: NOW },
    ]);
    const result = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: embeddings("test:bujo", 8), dim: 8 });
    expect(result.derivedLegacyAssociations).toBe(0);
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      expect(db.associationsForMemory("M1")).toEqual([
        expect.objectContaining({ entityId: "person:morgan", provenance: "capture" }),
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects candidate DB replacement after validation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Candidate replacement sentinel."));
    writeDaily(root, [bullet("NEW", "Validated candidate.")]);
    const before = resolveActiveMemoryDbPath(root);
    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterCandidateValidated: () => {
          const generations = join(realpathSync(root), ".index", "generations");
          const candidate = join(generations, readdirSync(generations)[0] ?? "missing", "memory.db");
          renameSync(candidate, `${candidate}.replaced`);
          writeFileSync(candidate, "not sqlite", { mode: 0o600 });
        },
      },
    })).rejects.toThrow(/candidate|database|changed|replaced/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("rejects a same-count candidate memory payload mutation after close", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Payload mutation sentinel."));
    writeDaily(root, [bullet("NEW", "Expected candidate payload.")]);
    const before = resolveActiveMemoryDbPath(root);
    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterCandidateClosed: () => {
          const generations = join(realpathSync(root), ".index", "generations");
          const candidate = join(generations, readdirSync(generations)[0] ?? "missing", "memory.db");
          const db = openMemoryDb({ path: candidate });
          db.upsertLexical({
            ...note("NEW", "Rogue replacement with the same row count."),
            status: "done",
            source: { file: "daily/2026-07-11.md", line: 3 },
          });
          db.close();
        },
      },
    })).rejects.toThrow(/memory payload validation/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("CAS-protects both absent and existing manifests from non-cooperating edits", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Manifest CAS sentinel."));
    writeDaily(root, [bullet("NEW", "Manifest candidate.")]);
    const manifestPath = join(realpathSync(root), ".index", "manifest.json");
    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: { afterCandidateValidated: () => writeFileSync(manifestPath, "{}\n", { mode: 0o600 }) },
    })).rejects.toThrow(/manifest.*changed|concurrent/iu);

    rmSync(manifestPath);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const active = resolveActiveMemoryDbPath(root);
    const originalManifest = readFileSync(manifestPath, "utf8");
    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: { afterCandidateValidated: () => writeFileSync(manifestPath, `${originalManifest.trim()}\n\n`, { mode: 0o600 }) },
    })).rejects.toThrow(/manifest.*changed|concurrent/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(active);
  });

  it("rejects first activation when the managed ancestors are redirected after manifest temp fsync", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const managed = join(realpathSync(root), ".index");
    const escapedManaged = join(outside, "escaped-index");
    writeDaily(root, [bullet("M1", "The first generation must remain inside its memory root.")]);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterManifestTempFsync: () => {
          renameSync(managed, escapedManaged);
          symlinkSync(escapedManaged, managed, "dir");
        },
      },
    })).rejects.toThrow(/managed memory directory|memory generations directory|symlink|replaced concurrently/iu);

    expect(existsSync(join(escapedManaged, "manifest.json"))).toBe(false);
    expect(readdirSync(escapedManaged).some((name) => name.startsWith(".manifest-"))).toBe(true);
  });

  it.each([
    ["journal", "bujo"],
    ["bujo", "journal"],
  ] as const)("preserves the correct source domain for %s -> %s rollback", async (from, to) => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Morgan owns the cross-tier plan.")]);
    writeGraph(root, [{ kind: "entity", id: "person:morgan", name: "Morgan", createdAt: NOW }]);
    const provider = embeddings("test:cross-tier", 8);
    await safeRebuildMemoryIndex({ root, tier: from, embeddings: provider, dim: 8 });
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: to, embeddings: provider, dim: 8 });
    await rollbackMemoryIndex({ root, tier: from, embeddings: provider, dim: 8 });
    expect(resolveActiveMemoryDbPath(root)).toBe(rebuilt.rollback);
  });

  it.each([
    [false, "journal"],
    [true, "bujo"],
  ] as const)("preserves divergent legacy semantic data without advertising rollback (graph=%s, inferred=%s)", async (withGraph, priorTier) => {
    const root = tempRoot();
    const modelA = embeddings("test:legacy-semantic-a", 8);
    const legacy = openMemoryDb({ path: join(root, "memory.db"), embeddings: modelA, dim: 8 });
    await legacy.upsert(note("OLD", "Legacy semantic rollback sentinel."));
    legacy.close();
    writeDaily(root, [bullet("NEW", "Lite replacement source.")]);
    if (withGraph) writeGraph(root, [{ kind: "entity", id: "person:morgan", name: "Morgan", createdAt: NOW }]);

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(readTexts(join(root, "memory.db"))).toContain("Legacy semantic rollback sentinel.");
    await expect(rollbackMemoryIndex({ root, tier: priorTier, embeddings: modelA, dim: 8 }))
      .rejects.toThrow(/no retained rollback/iu);
  });

  it("preserves divergent legacy Lite data before first Journal activation without advertising rollback", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Legacy Lite rollback sentinel."));
    writeDaily(root, [bullet("NEW", "Journal replacement source.")]);
    const model = embeddings("test:new-journal", 8);

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: model, dim: 8 });
    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(readTexts(join(root, "memory.db"))).toContain("Legacy Lite rollback sentinel.");
  });

  it("preserves divergent legacy model data across first activation without advertising rollback", async () => {
    const root = tempRoot();
    const modelA = embeddings("test:legacy-model-a", 8);
    const modelB = embeddings("test:new-model-b", 4);
    const legacy = openMemoryDb({ path: join(root, "memory.db"), embeddings: modelA, dim: 8 });
    await legacy.upsert(note("OLD", "Legacy model A sentinel."));
    legacy.close();
    writeDaily(root, [bullet("NEW", "Model B replacement source.")]);

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: modelB, dim: 4 });
    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(readTexts(join(root, "memory.db"))).toContain("Legacy model A sentinel.");
  });

  it("rejects a legacy SQLite write transaction before calling embeddings", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Legacy live writer sentinel."));
    writeDaily(root, [bullet("NEW", "Must wait for stopped legacy writer.")]);
    const legacy = new BetterSqlite3(join(root, "memory.db"));
    legacy.exec("BEGIN IMMEDIATE");
    const embed = vi.fn(embeddings("test:locked", 8).embed);
    try {
      await expect(safeRebuildMemoryIndex({
        root,
        tier: "journal",
        embeddings: { id: "test:locked", embed },
        dim: 8,
      })).rejects.toThrow(/active legacy SQLite writer|stop/iu);
      expect(embed).not.toHaveBeenCalled();
    } finally {
      legacy.exec("ROLLBACK");
      legacy.close();
    }
  });

  it("holds a BEGIN IMMEDIATE fence across empty replay proof and cleans only safe replay temps", async () => {
    const root = tempRoot();
    const provider = embeddings("test:empty-replay-fence", 4);
    const legacy = openMemoryDb({ path: join(root, "memory.db"), embeddings: provider, dim: 4 });
    legacy.setIndexMetadata({
      schemaVersion: 1,
      policyVersion: "legacy-test",
      tier: "bujo",
      embeddingModel: provider.id,
      dimension: 4,
      sourceFingerprint: "legacy-test",
      generation: "legacy-test",
      createdAt: NOW,
    });
    legacy.close();
    const temporary = join(
      root,
      "..replay-projection-v1.json-00000000-0000-4000-8000-000000000003.tmp",
    );
    writeFileSync(temporary, "partial", { mode: 0o600 });
    let writerBlocked = false;

    await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 4,
      hooks: {
        beforeReplayProjectionInitialization: () => {
          const raw = new BetterSqlite3(join(root, "memory.db"));
          try {
            raw.pragma("busy_timeout = 0");
            try {
              raw.exec("BEGIN IMMEDIATE");
            } catch (error) {
              writerBlocked = /locked|busy/iu.test(String(error));
            }
          } finally {
            if (raw.inTransaction) raw.exec("ROLLBACK");
            raw.close();
          }
        },
      },
    });

    expect(writerBlocked).toBe(true);
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(join(root, REPLAY_PROJECTION_FILE), "utf8")).toContain('"schemaVersion":1');
  });

  it("releases leases on invalid tier, post-open initialization failure, and flush failure", async () => {
    const invalidRoot = tempRoot();
    expect(() => createBujoMemoryStore({ root: invalidRoot, tier: "journal" })).toThrow(/requires embeddings/iu);
    await createBujoMemoryStore({ root: invalidRoot, tier: "lite" }).close();

    const initRoot = tempRoot();
    writeFileSync(join(initRoot, "daily"), "not a directory");
    expect(() => createBujoMemoryStore({
      root: initRoot,
      tier: "journal",
      embeddings: embeddings("test:init", 8),
      dim: 8,
    })).toThrow(/ENOTDIR|not a directory|must be a real directory/iu);
    rmSync(join(initRoot, "daily"));
    await createBujoMemoryStore({ root: initRoot, tier: "lite" }).close();

    const closeRoot = tempRoot();
    const broken = createBujoMemoryStore({ root: closeRoot, tier: "lite" });
    (broken as unknown as { flush(): Promise<void> }).flush = async () => { throw new Error("flush-fault"); };
    await expect(broken.close()).rejects.toThrow("flush-fault");
    await createBujoMemoryStore({ root: closeRoot, tier: "lite" }).close();
  });

  it("checks managed identity even when an empty semantic generation has no vector rows", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: embeddings("test:model-a", 8), dim: 8 });
    const wrongEmbed = vi.fn(embeddings("test:model-b", 4).embed);
    expect(() => createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings: { id: "test:model-b", embed: wrongEmbed },
      dim: 4,
    })).toThrow(/active generation requires.*model=test:model-a.*dim=8|safe memory rebuild/iu);
    expect(wrongEmbed).not.toHaveBeenCalled();
    await createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings: embeddings("test:model-a", 8),
      dim: 8,
    }).close();
  });

  it("rebuilds Journal duplicates as one content-derived row, hash reservation, and vector", async () => {
    const root = tempRoot();
    writeDaily(root, [
      bullet("legacy-a", "  One   durable journal fact. "),
      bullet("legacy-b", "One durable journal fact."),
    ]);
    const result = await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:journal", 8),
      dim: 8,
    });
    expect(result).toMatchObject({ indexed: 1, skippedJournalDuplicateRecords: 1, parsedSourceItems: 2 });
    const db = openMemoryDb({ path: result.active, readOnly: true, dim: 8 });
    try {
      const state = db.validationSnapshot();
      expect(state).toMatchObject({ memories: 1, contentHashes: 1, vectors: 1, ftsRows: 1 });
      expect(db.topSalient(2)[0]?.id).toMatch(/^J-[a-f0-9]{64}$/u);
    } finally {
      db.close();
    }
  });

  it("preserves and counts legacy visible lines without metadata instead of inventing identity", async () => {
    const root = tempRoot();
    const daily = join(root, "daily");
    mkdirSync(daily, { recursive: true });
    writeFileSync(join(daily, "2026-07-11.md"), [
      "# 2026-07-11",
      "",
      "- ◦ Legacy hand-written event without structured metadata.",
      serializeBullet(bullet("M1", "Structured fact remains indexed.")),
      "",
    ].join("\n"));
    const sourceHash = sha256(join(daily, "2026-07-11.md"));
    const result = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(result).toMatchObject({ indexed: 1, skippedUnstructuredRecords: 1 });
    expect(sha256(join(daily, "2026-07-11.md"))).toBe(sourceHash);
    expect(readTexts(result.active)).toEqual(["Structured fact remains indexed."]);
  });

  it("preserves metadata-backed legacy lines missing only identity, but rejects any other incomplete metadata", async () => {
    const root = tempRoot();
    const daily = join(root, "daily");
    mkdirSync(daily, { recursive: true });
    writeFileSync(join(daily, "2026-07-11.md"), [
      "# 2026-07-11",
      "",
      "- – Legacy automation record.  <!--mem type=note status=open salience=0.6 isInsight=0 created=2026-07-11T09:00:00.000Z refs=-->",
      "",
    ].join("\n"));
    const before = sha256(join(daily, "2026-07-11.md"));
    const result = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(result).toMatchObject({
      indexed: 0,
      skippedMissingIdentityRecords: 1,
      missingIdentityLocations: ["daily/2026-07-11.md:3"],
    });
    expect(sha256(join(daily, "2026-07-11.md"))).toBe(before);

    const malformed = tempRoot();
    mkdirSync(join(malformed, "daily"), { recursive: true });
    writeFileSync(
      join(malformed, "daily", "2026-07-11.md"),
      "- – Missing timestamp.  <!--mem type=note status=open salience=0.6 isInsight=0 refs=-->\n",
    );
    await expect(safeRebuildMemoryIndex({ root: malformed, tier: "lite" })).rejects.toThrow(/malformed memory bullet/iu);

    const legacySource = tempRoot();
    mkdirSync(join(legacySource, "daily"), { recursive: true });
    writeFileSync(
      join(legacySource, "daily", "2026-07-11.md"),
      "- Focus scan legacy schema. <!--mem type=note status=open salience=0.5 source=focus-scan-hourly-->\n",
    );
    const legacySourceResult = await safeRebuildMemoryIndex({ root: legacySource, tier: "lite" });
    expect(legacySourceResult).toMatchObject({
      indexed: 0,
      parsedSourceItems: 1,
      skippedLegacySourceRecords: 1,
      legacySourceLocations: ["daily/2026-07-11.md:1"],
    });
  });

  it("preserves root-level legacy diagnostic locations through rebuild and rollback manifests", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "2026-07-10.md"), [
      "# 2026-07-10",
      "",
      "- – Root legacy record without identity.  <!--mem type=note status=open salience=0.6 isInsight=0 created=2026-07-10T09:00:00.000Z refs=-->",
      "- Root focus scan. <!--mem type=note status=open salience=0.5 source=focus-scan-hourly-->",
      "",
    ].join("\n"));

    const first = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(first).toMatchObject({
      skippedMissingIdentityRecords: 1,
      missingIdentityLocations: ["2026-07-10.md:3"],
      skippedLegacySourceRecords: 1,
      legacySourceLocations: ["2026-07-10.md:4"],
    });
    expect(readManagedIndexManifest(root)?.active).toMatchObject({
      missingIdentityLocations: ["2026-07-10.md:3"],
      legacySourceLocations: ["2026-07-10.md:4"],
    });

    await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(readManagedIndexManifest(root)?.rollback).toMatchObject({
      missingIdentityLocations: ["2026-07-10.md:3"],
      legacySourceLocations: ["2026-07-10.md:4"],
    });
    await rollbackMemoryIndex({ root, tier: "lite" });
    expect(readManagedIndexManifest(root)?.active).toMatchObject({
      missingIdentityLocations: ["2026-07-10.md:3"],
      legacySourceLocations: ["2026-07-10.md:4"],
    });
  });

  it("rejects writable pinned DB paths so retained generations stay immutable", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "First generation sentinel.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const retained = resolveActiveMemoryDbPath(root);
    const before = sha256(retained);
    expect(() => createBujoMemoryStore({ root, tier: "lite", dbPath: retained })).toThrow(/dbPath.*read-only|writable/iu);
    expect(sha256(retained)).toBe(before);
  });

  it("removes its owned writer lock when acquisition fails after O_EXCL creation", () => {
    const root = tempRoot();
    expect(() => acquireMemoryWriterLease(root, {
      afterCreate: () => { throw new Error("post-create-fault"); },
    })).toThrow("post-create-fault");
    expect(existsSync(join(realpathSync(root), ".index", "writer.lock"))).toBe(false);
    const lease = acquireMemoryWriterLease(root);
    lease.release();
  });

  it("does not write a writer-lease payload after the managed directory is relocated", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const managed = join(realpathSync(root), ".index");
    const escaped = join(outside, "escaped-index");

    expect(() => acquireMemoryWriterLease(root, {
      afterCreate: () => {
        renameSync(managed, escaped);
        symlinkSync(escaped, managed, "dir");
      },
    })).toThrow(/managed memory directory|symlink|replaced|acquisition/iu);

    expect(readFileSync(join(escaped, "writer.lock"))).toHaveLength(0);
  });

  it("revalidates the candidate path after embeddings before persisting user text", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeDaily(root, [bullet("PATH-GUARD", "Provider relocation must not leak this memory text.")]);
    const managed = join(realpathSync(root), ".index");
    const escaped = join(outside, "escaped-index");
    const provider: EmbeddingProvider = {
      id: "test:path-relocation",
      embed: async (texts) => {
        renameSync(managed, escaped);
        symlinkSync(escaped, managed, "dir");
        return texts.map((text) => deterministicVector(text, 8));
      },
    };

    await expect(safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 8 }))
      .rejects.toThrow(/managed memory directory|memory generations directory|symlink|replaced/iu);

    const generation = readdirSync(join(escaped, "generations"))[0];
    if (generation === undefined) throw new Error("expected escaped candidate generation");
    const raw = new BetterSqlite3(join(escaped, "generations", generation, "memory.db"), { readonly: true });
    try {
      expect((raw.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("preserves a divergent old-schema database without advertising an unsafe rollback", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Old-schema rollback sentinel."));
    const legacyPath = join(root, "memory.db");
    const raw = new BetterSqlite3(legacyPath);
    raw.exec("DROP TABLE memory_entities; DROP TABLE content_hashes; DROP TABLE index_metadata;");
    raw.pragma("wal_checkpoint(TRUNCATE)");
    raw.close();
    const legacyHash = sha256(legacyPath);
    writeDaily(root, [bullet("NEW", "Candidate from canonical source.")]);

    const result = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(sha256(legacyPath)).toBe(legacyHash);
    expect(result.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    await expect(rollbackMemoryIndex({ root, tier: "lite" })).rejects.toThrow(/no retained rollback/iu);
    expect(readTexts(legacyPath)).toEqual(["Old-schema rollback sentinel."]);
  });

  it("adopts an exact-compatible legacy Lite database as a working rollback", async () => {
    const root = tempRoot();
    const item = bullet("LEGACY-EXACT", "Exact legacy and canonical source agree.");
    writeDaily(root, [item]);
    await seedLegacy(root, memoryRecordForBullet(item, "daily/2026-07-11.md"));

    const result = await safeRebuildMemoryIndex({ root, tier: "lite" });

    expect(result.rollback).toBeDefined();
    await rollbackMemoryIndex({ root, tier: "lite" });
    expect(readTexts(resolveActiveMemoryDbPath(root))).toEqual(["Exact legacy and canonical source agree."]);
  });

  it("omits rollback when an empty semantic database cannot prove parity with changed source", async () => {
    const root = tempRoot();
    const modelA = embeddings("test:empty-a", 8);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: modelA, dim: 8 });
    // Canonical-first mirror failure: source advanced, but the managed DB is
    // still truly empty, so row inference cannot recover model/dimension.
    writeDaily(root, [bullet("M1", "Source changed after empty generation activation.")]);
    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:empty-b", 4),
      dim: 4,
    });

    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    await expect(rollbackMemoryIndex({ root, tier: "journal", embeddings: modelA, dim: 8 }))
      .rejects.toThrow(/no retained rollback generation/iu);
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(root), readOnly: true, dim: 4 });
    try {
      expect(db.indexMetadata()).toMatchObject({ embeddingModel: "test:empty-b", dimension: 4 });
      expect(db.validationSnapshot()).toMatchObject({ memories: 1, vectors: 1 });
    } finally {
      db.close();
    }
  });

  it("does not mint a current Lite rollback identity for a stale source-first mirror", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    writeDaily(root, [bullet("M1", "Canonical source advanced before its Lite mirror.")]);

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "lite" });

    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(readTexts(rebuilt.active)).toEqual(["Canonical source advanced before its Lite mirror."]);
    await expect(rollbackMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/no retained rollback generation/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(rebuilt.active);
  });

  it("does not retain a matching-fingerprint generation whose payload diverged from canonical source", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("PARITY-1", "Canonical rollback truth.")]);
    const first = await safeRebuildMemoryIndex({ root, tier: "lite" });
    overwriteMemoryText(first.active, "PARITY-1", "Stale database payload.");

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "lite" });

    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(readTexts(rebuilt.active)).toEqual(["Canonical rollback truth."]);
  });

  it("refuses a retained rollback whose payload changed after retention", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("PARITY-2", "Retained rollback truth.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "lite" });
    if (rebuilt.rollback === undefined) throw new Error("expected an exact retained rollback");
    overwriteMemoryText(rebuilt.rollback, "PARITY-2", "Mutated retained rollback.");

    await expect(rollbackMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/rollback source parity validation failed.*memory payload/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(rebuilt.active);
    expect(readTexts(rebuilt.active)).toEqual(["Retained rollback truth."]);
  });

  it("keeps an exact Journal rollback when only its recoverable vector backlog is incomplete", async () => {
    const root = tempRoot();
    const oldModel = embeddings("test:journal-backlog-old", 8);
    const newModel = embeddings("test:journal-backlog-new", 4);
    writeDaily(root, [bullet("M1", "Journal lexical source remains exact without its vector.")]);
    const first = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: oldModel, dim: 8 });
    deleteAllVectors(first.active);
    const daily = join(root, "daily", "2026-07-11.md");
    writeFileSync(daily, `${readFileSync(daily, "utf8")}\n`, "utf8");

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: newModel, dim: 4 });

    expect(rebuilt.rollback).toBeDefined();
    await rollbackMemoryIndex({ root, tier: "journal", embeddings: oldModel, dim: 8 });
    const rolledBack = openMemoryDb({ path: resolveActiveMemoryDbPath(root), readOnly: true, dim: 8 });
    try {
      expect(rolledBack.validationSnapshot()).toMatchObject({ memories: 1, vectors: 0 });
      expect(rolledBack.get(`J-${normalizedContentHash("Journal lexical source remains exact without its vector.")}`)?.text)
        .toBe("Journal lexical source remains exact without its vector.");
    } finally {
      rolledBack.close();
    }
  });

  it("validates empty managed semantic identity for read-only stores and allows only explicit FTS fallback", async () => {
    const root = tempRoot();
    const modelA = embeddings("test:empty-managed-a", 8);
    const result = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: modelA, dim: 8 });

    expect(() => createBujoMemoryStore({
      root,
      dbPath: result.active,
      readOnly: true,
      tier: "journal",
      embeddings: embeddings("test:empty-managed-b", 4),
      dim: 4,
    })).toThrow(/managed read-only generation requires.*empty-managed-a.*dim=8/iu);

    const fallback = createBujoMemoryStore({
      root,
      dbPath: result.active,
      readOnly: true,
      allowFtsFallback: true,
    });
    await expect(fallback.recall("anything", { trackAccess: false })).resolves.toEqual([]);
    await fallback.close();

    const matching = createBujoMemoryStore({
      root,
      dbPath: result.active,
      readOnly: true,
      tier: "journal",
      embeddings: modelA,
      dim: 8,
    });
    await matching.close();
  });

  it("accepts exact sidecar-backed replay in read-only BuJo, including explicit FTS fallback", async () => {
    const root = tempRoot();
    const target = bullet("READONLY-TARGET", "Read-only replay target.");
    const source = bullet("READONLY-SOURCE", "Read-only replay source.");
    writeDaily(root, [target]);
    const file = "daily/2026-07-11.md";
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file, bullet: source },
      record: memoryRecordForBullet(source, file),
      vector: deterministicVector(source.text, 8),
      threads: [{ src: source.id, dst: target.id, weight: 0.8 }],
    }], {}, NOW);
    const provider = embeddings("test:read-only-replay", 8);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });

    const matching = createBujoMemoryStore({
      root,
      dbPath: rebuilt.active,
      readOnly: true,
      tier: "bujo",
      embeddings: provider,
      dim: 8,
    });
    await matching.close();

    const fallback = createBujoMemoryStore({
      root,
      dbPath: rebuilt.active,
      readOnly: true,
      allowFtsFallback: true,
    });
    await expect(fallback.recall("Read-only replay", { trackAccess: false })).resolves.not.toEqual([]);
    await fallback.close();
  });

  it("rejects a plausible raw thread from read-only BuJo, including FTS fallback", async () => {
    const root = tempRoot();
    const source = bullet("READONLY-RAW-SOURCE", "Raw read-only source.");
    const target = bullet("READONLY-RAW-TARGET", "Raw read-only target.");
    writeDaily(root, [source, target]);
    const provider = embeddings("test:read-only-raw-replay", 8);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });
    const raw = new BetterSqlite3(rebuilt.active, { fileMustExist: true });
    try {
      raw.prepare(
        "INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'thread', 0.8, ?)",
      ).run(source.id, target.id, NOW);
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }

    expect(() => createBujoMemoryStore({
      root,
      dbPath: rebuilt.active,
      readOnly: true,
      tier: "bujo",
      embeddings: provider,
      dim: 8,
    })).toThrow(/replay projection|replay.*DB|thread/iu);
    expect(() => createBujoMemoryStore({
      root,
      dbPath: rebuilt.active,
      readOnly: true,
      allowFtsFallback: true,
    })).toThrow(/replay projection|replay.*DB|thread/iu);
  });

  it("rejects stale graph-owned about drift in read-only BuJo and heals it on writable startup", async () => {
    const root = tempRoot();
    const item = bullet("READONLY-STALE-ABOUT", "Alice owns the stale graph projection.");
    writeDaily(root, [item]);
    appendGraphBatch(root, {
      entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: NOW }],
    });
    const provider = embeddings("test:read-only-stale-about", 8);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 8 });
    const raw = new BetterSqlite3(rebuilt.active, { fileMustExist: true });
    try {
      raw.prepare(
        "INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'about', 0.8, ?)",
      ).run(item.id, "person:alice", NOW);
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }

    const audited = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 8 });
    try {
      expect(auditCanonicalIndexHealth(root, "bujo", audited)).toEqual({ status: "mismatch" });
    } finally {
      audited.close();
    }
    expect(() => createBujoMemoryStore({
      root,
      dbPath: rebuilt.active,
      readOnly: true,
      tier: "bujo",
      embeddings: provider,
      dim: 8,
    })).toThrow(/exact canonical memory, graph, and replay parity/iu);
    expect(() => createBujoMemoryStore({
      root,
      dbPath: rebuilt.active,
      readOnly: true,
      allowFtsFallback: true,
    })).toThrow(/exact canonical memory, graph, and replay parity/iu);

    const writable = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 8,
      llm: { id: "test:read-only-stale-about", complete: async () => "{}" },
    });
    await writable.close();

    const healed = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 8 });
    try {
      expect(healed.allEdges().some((edge) => edge.kind === "about")).toBe(false);
      expect(auditCanonicalIndexHealth(root, "bujo", healed)).toEqual({ status: "match" });
    } finally {
      healed.close();
    }
  });

  it("detects retained rollback replacement after manifest temp fsync", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "First active generation.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const daily = join(root, "daily", "2026-07-11.md");
    writeFileSync(daily, `${readFileSync(daily, "utf8")}\n`, "utf8");
    const activeBefore = resolveActiveMemoryDbPath(root);
    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterManifestTempFsync: () => {
          const managed = join(realpathSync(root), ".index");
          const temp = readdirSync(managed).find((name) => name.startsWith(".manifest-") && name.endsWith(".tmp"));
          if (temp === undefined) throw new Error("missing manifest temp");
          const manifest = JSON.parse(readFileSync(join(managed, temp), "utf8")) as { rollback: { name: string } };
          const rollbackDb = join(managed, "generations", manifest.rollback.name, "memory.db");
          renameSync(rollbackDb, `${rollbackDb}.replaced`);
          writeFileSync(rollbackDb, "not sqlite", { mode: 0o600 });
        },
      },
    })).rejects.toThrow(/rollback database changed|retained rollback|replaced/iu);
    expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-safe-rebuild-"));
  roots.push(root);
  return root;
}

function bullet(id: string, text: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: NOW,
    refs: [] as readonly string[],
  };
}

function writeDaily(root: string, bullets: readonly Bullet[]): void {
  const daily = join(root, "daily");
  mkdirSync(daily, { recursive: true });
  writeFileSync(
    join(daily, "2026-07-11.md"),
    `# 2026-07-11\n\n${bullets.map((item) => serializeBullet(item)).join("\n")}\n`,
    "utf8",
  );
}

function writeGraph(root: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(join(root, "graph.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function overwriteMemoryText(path: string, id: string, text: string): void {
  const db = openMemoryDb({ path });
  try {
    const record = db.get(id);
    if (record === undefined) throw new Error(`missing memory ${id}`);
    db.upsertLexical({ ...record, text });
    db.checkpoint();
  } finally {
    db.close();
  }
}

function note(id: string, text: string): MemoryRecord {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: NOW,
    accessCount: 0,
    tags: [],
    source: {},
  };
}

function memoryRecordForBullet(
  item: Bullet,
  file: string,
): MemoryRecord {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    text: item.text,
    salience: item.salience,
    isInsight: item.isInsight,
    createdAt: item.createdAt,
    accessCount: 0,
    tags: [],
    source: { file },
  };
}

async function seedLegacy(root: string, record: MemoryRecord): Promise<void> {
  const db = openMemoryDb({ path: join(root, "memory.db") });
  try {
    await db.upsert(record);
  } finally {
    db.close();
  }
}

function readTexts(path: string): string[] {
  const db = openMemoryDb({ path });
  try {
    return db.topSalient(100).map((record) => record.text).sort();
  } finally {
    db.close();
  }
}

function readMetadata(path: string) {
  const db = openMemoryDb({ path });
  try {
    return db.indexMetadata();
  } finally {
    db.close();
  }
}

function embeddings(id: string, dim: number): EmbeddingProvider {
  return {
    id,
    embed: async (texts) => texts.map((text) => deterministicVector(text, dim)),
  };
}

function nullVectorIdentity(path: string, column: "embedding_model" | "dim" | "both"): void {
  const raw = new BetterSqlite3(path);
  try {
    const assignment = column === "both" ? "embedding_model = NULL, dim = NULL" : `${column} = NULL`;
    raw.exec(`UPDATE memories SET ${assignment}`);
    raw.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

function deleteAllVectors(path: string): void {
  const raw = new BetterSqlite3(path);
  try {
    loadVec(raw);
    raw.exec("DELETE FROM memories_vec");
    raw.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

function deterministicVector(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const [index, byte] of Buffer.from(text).entries()) {
    const slot = index % dim;
    vector[slot] = (vector[slot] ?? 0) + byte / 255;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
