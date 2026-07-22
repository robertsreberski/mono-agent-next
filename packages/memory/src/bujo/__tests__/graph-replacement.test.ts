import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { replayCaptureOutbox, writeCaptureIntent } from "../capture-outbox.js";
import {
  appendGraphBatch,
  replaceDbCanonicalGraphProjectionWithParity,
  type CanonicalGraphRepairGuard,
} from "../graph.js";
import { appendBullet, dailyFilePath } from "../daily.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { readCanonicalFileSnapshot, writeCanonicalFileAtomic } from "../path-safety.js";
import { assertCanonicalGraphRepairBaseParity } from "../rebuild.js";
import { createBujoMemoryStore } from "../store.js";
import {
  legacyReplayProjectionFromDb,
  prepareReplayProjectionPublication,
  publishPreparedReplayProjection,
  replayProjectionDbSnapshot,
} from "../replay-projection.js";

const AT = "2026-07-12T08:00:00.000Z";
const ASSOCIATED_AT = "2026-07-12T08:30:00.000Z";

describe("replaceDbCanonicalGraphProjectionWithParity", () => {
  it("runs a required synchronous guard before reading canonical graph or DB memory", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-guard-order-"));
    writeCanonicalFileAtomic(root, "graph.jsonl", "not-json\n");
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "open", "Untrusted SQLite memory."));
    db.upsertEntity({ id: "person:stale", name: "Stale", createdAt: AT });
    db.addEdge("M1", "person:stale", "about");
    const dbBefore = db.canonicalGraphSnapshot();
    const events: string[] = [];
    const unreadable = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") {
          events.push("db-read");
          throw new Error("DB memory must not be read before the guard succeeds");
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guard = (() => {
      events.push("guard");
      throw new Error("parity rejected");
    }) satisfies CanonicalGraphRepairGuard;

    expect(() => replaceDbCanonicalGraphProjectionWithParity(root, unreadable, guard))
      .toThrow(/parity rejected/iu);
    expect(events).toEqual(["guard"]);
    expect(db.canonicalGraphSnapshot()).toEqual(dbBefore);

    expect(() => replaceDbCanonicalGraphProjectionWithParity(
      root,
      unreadable,
      undefined as unknown as CanonicalGraphRepairGuard,
    )).toThrow(/requires an exact synchronous parity guard/iu);
    expect(events).toEqual(["guard"]);
    db.close();
  });

  it("rejects an asynchronous guard before reading canonical graph or DB memory", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-async-guard-"));
    writeCanonicalFileAtomic(root, "graph.jsonl", "not-json\n");
    const db = openMemoryDb({ path: ":memory:" });
    let dbRead = false;
    const unreadable = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") dbRead = true;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(() => replaceDbCanonicalGraphProjectionWithParity(
      root,
      unreadable,
      (() => Promise.resolve()) as unknown as CanonicalGraphRepairGuard,
    )).toThrow(/must complete synchronously/iu);
    expect(dbRead).toBe(false);
    db.close();
  });

  it("runs the exact memory/replay guard on both sides of a permitted total replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-exact-guard-"));
    appendGraphBatch(root, {
      entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: AT }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "open", "Alice owns the launch."));
    const exactMemory = db.get("M1")!;
    db.upsertEntity({ id: "person:stale", name: "Stale", createdAt: AT });
    let guardCalls = 0;
    const guard = ((guardRoot, guardedDb) => {
      guardCalls += 1;
      expect(guardRoot).toBe(root);
      expect(guardedDb.allMemories()).toEqual([exactMemory]);
      expect(replayProjectionDbSnapshot(guardedDb)).toEqual({
        terminals: [],
        supersedes: [],
        threads: [],
      });
    }) satisfies CanonicalGraphRepairGuard;

    const projection = replaceDbCanonicalGraphProjectionWithParity(root, db, guard);

    expect(guardCalls).toBe(3);
    expect(projection.derivedLegacyAssociations).toBe(1);
    expect(db.allEntities().map((entity) => entity.id)).toEqual(["person:alice"]);
    expect(db.allMemoryAssociations()).toHaveLength(1);
    db.close();
  });

  it.each(["canonical daily", "DB memory"] as const)(
    "fails after graph mutation when the post-guard detects a %s race",
    (race) => {
      const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-post-guard-"));
      appendGraphBatch(root, {
        entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: AT }],
      });
      writeCanonicalFileAtomic(root, "daily/2026-07-12.md", "# 2026-07-12\n\ntrusted\n");
      const trustedDaily = readCanonicalFileSnapshot(root, "daily/2026-07-12.md")!.content;
      const db = openMemoryDb({ path: ":memory:" });
      db.upsertLexical(memory("M1", "open", "Alice owns the launch."));
      const trustedMemory = db.get("M1")!;
      let guardCalls = 0;
      const guard = ((guardRoot, guardedDb) => {
        guardCalls += 1;
        if (readCanonicalFileSnapshot(guardRoot, "daily/2026-07-12.md")?.content !== trustedDaily) {
          throw new Error("canonical memory/replay parity changed");
        }
        if (JSON.stringify(guardedDb.allMemories()) !== JSON.stringify([trustedMemory])) {
          throw new Error("canonical memory/replay parity changed");
        }
      }) satisfies CanonicalGraphRepairGuard;
      const raced = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "replaceCanonicalGraphProjection") {
            return (...args: Parameters<MemoryDb["replaceCanonicalGraphProjection"]>) => {
              const replaced = target.replaceCanonicalGraphProjection(...args);
              if (race === "canonical daily") {
                const current = readCanonicalFileSnapshot(root, "daily/2026-07-12.md")!;
                writeCanonicalFileAtomic(root, "daily/2026-07-12.md", "# 2026-07-12\n\nraced\n", current.identity);
              } else {
                target.upsertLexical(memory("M1", "open", "Changed concurrently."));
              }
              return replaced;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      expect(() => replaceDbCanonicalGraphProjectionWithParity(root, raced, guard))
        .toThrow(/canonical memory\/replay parity changed/iu);
      expect(guardCalls).toBe(3);
      // The graph transaction committed, but the post-guard failure remains
      // visible so the owning durable protocol cannot retire its intent.
      expect(db.allEntities().map((entity) => entity.id)).toEqual(["person:alice"]);
      db.close();
    },
  );

  it("rejects a DB memory race between the pre-read guard and snapshot before graph mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-snapshot-race-"));
    appendGraphBatch(root, {
      entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: AT }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "open", "Alice owns the launch."));
    db.upsertEntity({ id: "person:stale", name: "Stale", createdAt: AT });
    const trustedMemory = db.get("M1")!;
    const graphBefore = {
      entities: db.allEntities(),
      relations: db.allEntityRelations(),
      associations: db.allMemoryAssociations(),
      edges: db.allEdges(),
    };
    let guardCalls = 0;
    let snapshotReads = 0;
    let replacementCalled = false;
    const raced = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") {
          return () => {
            snapshotReads += 1;
            target.upsertLexical(memory("M1", "open", "Changed before snapshot."));
            return target.canonicalGraphSnapshot();
          };
        }
        if (property === "replaceCanonicalGraphProjection") {
          return (...args: Parameters<MemoryDb["replaceCanonicalGraphProjection"]>) => {
            replacementCalled = true;
            return target.replaceCanonicalGraphProjection(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guard = ((_guardRoot, guardedDb) => {
      guardCalls += 1;
      if (JSON.stringify(guardedDb.allMemories()) !== JSON.stringify([trustedMemory])) {
        throw new Error("canonical memory/replay parity changed before graph replacement");
      }
    }) satisfies CanonicalGraphRepairGuard;

    expect(() => replaceDbCanonicalGraphProjectionWithParity(root, raced, guard))
      .toThrow(/parity changed before graph replacement/iu);
    expect(guardCalls).toBe(2);
    expect(snapshotReads).toBe(1);
    expect(replacementCalled).toBe(false);
    expect({
      entities: db.allEntities(),
      relations: db.allEntityRelations(),
      associations: db.allMemoryAssociations(),
      edges: db.allEdges(),
    }).toEqual(graphBefore);
    db.close();
  });

  it("removes stale derived associations and adds the newly derived total projection", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-"));
    appendGraphBatch(root, { entities: [
      { id: "person:alice", name: "Alice", type: "person", createdAt: AT },
      { id: "person:bob", name: "Bob", type: "person", createdAt: AT },
    ] });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "open", "Alice owns the launch."));
    db.upsertEntity({ id: "person:stale", name: "Stale", createdAt: AT });

    const first = guardedReplacement(root, db);
    expect(first.derivedLegacyAssociations).toBe(1);
    expect(db.allEntities().map((entity) => entity.id)).toEqual(["person:alice", "person:bob"]);
    expect(db.allMemoryAssociations()).toEqual([{
      memoryId: "M1",
      entityId: "person:alice",
      provenance: "legacy-name-match",
      createdAt: AT,
    }]);

    db.upsertLexical(memory("M1", "open", "Bob owns the launch."));
    const second = guardedReplacement(root, db);
    expect(second.derivedLegacyAssociations).toBe(1);
    expect(db.allMemoryAssociations()).toEqual([{
      memoryId: "M1",
      entityId: "person:bob",
      provenance: "legacy-name-match",
      createdAt: AT,
    }]);
    db.close();
  });

  it("uses the canonical association timestamp for exact supports and clears stale graph-owned state", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-support-"));
    appendGraphBatch(root, {
      entities: [{ id: "collection:projects", name: "projects", type: "collection", createdAt: AT }],
      associations: [{
        memoryId: "M1",
        entityId: "collection:projects",
        provenance: "capture",
        createdAt: ASSOCIATED_AT,
      }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "migrated", "Project archive.", "stale"));
    db.addEdge("M1", "stale", "supports");
    db.addEdge("M1", "stale", "about");

    guardedReplacement(root, db);

    expect(db.get("M1")?.collection).toBe("projects");
    expect(db.allEdges()).toEqual([{
      src: "M1",
      dst: "collection:projects",
      kind: "supports",
      weight: 1,
      createdAt: ASSOCIATED_AT,
    }]);
    db.close();
  });

  it("fails closed when the DB memory projection changes after derivation", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-cas-"));
    appendGraphBatch(root, {
      entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: AT }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "open", "Alice owns the launch."));
    const raced = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "replaceCanonicalGraphProjection") {
          return (...args: Parameters<MemoryDb["replaceCanonicalGraphProjection"]>) => {
            target.upsertLexical(memory("M1", "open", "Changed concurrently."));
            return target.replaceCanonicalGraphProjection(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(() => guardedReplacement(root, raced)).toThrow(/compare-and-swap/iu);
    expect(db.allEntities()).toEqual([]);
    expect(db.allMemoryAssociations()).toEqual([]);
    db.close();
  });

  it.each(["append", "same-bytes replacement"] as const)(
    "detects a canonical graph %s after DB replacement and converges on retry",
    (race) => {
      const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-source-race-"));
      const alice = { id: "person:alice", name: "Alice", type: "person", createdAt: AT } as const;
      appendGraphBatch(root, { entities: [alice] });
      const db = openMemoryDb({ path: ":memory:" });
      db.upsertLexical(memory("M1", "open", "Alice owns the launch."));
      const raced = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "replaceCanonicalGraphProjection") {
            return (...args: Parameters<MemoryDb["replaceCanonicalGraphProjection"]>) => {
              const replaced = target.replaceCanonicalGraphProjection(...args);
              if (race === "append") {
                appendGraphBatch(root, {
                  entities: [{ id: "person:bob", name: "Bob", type: "person", createdAt: ASSOCIATED_AT }],
                });
              } else {
                const snapshot = readCanonicalFileSnapshot(root, "graph.jsonl")!;
                writeCanonicalFileAtomic(root, "graph.jsonl", snapshot.content, snapshot.identity);
              }
              return replaced;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      expect(() => guardedReplacement(root, raced)).toThrow(/source changed/iu);
      expect(db.allEntities().map((entity) => entity.id)).toEqual(["person:alice"]);

      expect(() => guardedReplacement(root, db)).not.toThrow();
      expect(db.allEntities().map((entity) => entity.id)).toEqual(
        race === "append" ? ["person:alice", "person:bob"] : ["person:alice"],
      );
      expect(db.allMemoryAssociations()).toEqual([{
        memoryId: "M1",
        entityId: "person:alice",
        provenance: "legacy-name-match",
        createdAt: AT,
      }]);
      db.close();
    },
  );

  it("keeps a capture intent pending when graph source changes after DB replacement, then converges", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-durable-race-"));
    const item = bullet("M1", "Alice owns the launch.");
    const file = relative(root, dailyFilePath(root, new Date(item.createdAt)));
    const alice = { id: "person:alice", name: "Alice", type: "person", createdAt: AT } as const;
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryFromBullet(item),
      vector: [1, 0],
      threads: [],
    }], { entities: [alice] }, AT);
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      dim: 2,
      embeddings: {
        id: "test:durable-source-race",
        embed: async () => { throw new Error("durable replay must use its stored vector"); },
      },
    });
    const raced = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "replaceCanonicalGraphProjection") {
          return (...args: Parameters<MemoryDb["replaceCanonicalGraphProjection"]>) => {
            const replaced = target.replaceCanonicalGraphProjection(...args);
            appendGraphBatch(root, {
              entities: [{ id: "person:bob", name: "Bob", type: "person", createdAt: ASSOCIATED_AT }],
            });
            return replaced;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(() => replayCaptureOutbox(root, raced, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    })).toThrow(/source changed/iu);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    expect(db.allEntities().map((entity) => entity.id)).toEqual(["person:alice"]);

    expect(() => replayCaptureOutbox(root, db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    })).not.toThrow();
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    expect(db.allEntities().map((entity) => entity.id)).toEqual(["person:alice", "person:bob"]);
    expect(db.allMemoryAssociations()).toEqual([{
      memoryId: item.id,
      entityId: alice.id,
      provenance: "legacy-name-match",
      createdAt: item.createdAt,
    }]);
    db.close();
  });

  it("heals a completed pre-fix projection during writable BuJo startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-replace-startup-"));
    const item = bullet("M1", "Alice owns the launch.");
    const target = bullet("M2", "An established related note.");
    appendBullet(root, item, new Date(item.createdAt));
    appendBullet(root, target, new Date(target.createdAt));
    const entity = { id: "person:alice", name: "Alice", type: "person", createdAt: AT } as const;
    appendGraphBatch(root, { entities: [entity] });
    const provider = {
      id: "test:startup-projection-heal",
      embed: async (): Promise<number[][]> => {
        throw new Error("startup graph healing must not call the embedding provider");
      },
    };
    const path = join(root, "memory.db");
    let db = openMemoryDb({ path, embeddings: provider, dim: 2 });
    db.commitPreparedUpserts([memoryFromBullet(item), memoryFromBullet(target)], [[1, 0], [0, 1]]);
    db.mirrorCanonicalEntity(entity);
    db.addEdge(item.id, target.id, "thread", 0.8, item.createdAt);
    publishPreparedReplayProjection(root, prepareReplayProjectionPublication(
      root,
      legacyReplayProjectionFromDb(db, "a".repeat(64)),
      { requireMissing: true },
    ));
    const replayEdges = db.edges(item.id);
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "mismatch",
      associations: { missing: 1 },
    });
    db.close();

    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 2,
      llm: { id: "test:startup-projection-heal", complete: async () => "{}" },
    });
    try {
      db = openMemoryDb({ path, readOnly: true, dim: 2 });
      try {
        expect(auditCanonicalGraphParity(root, db)).toMatchObject({ status: "match", matches: true });
        expect(db.allMemoryAssociations()).toEqual([{
          memoryId: item.id,
          entityId: entity.id,
          provenance: "legacy-name-match",
          createdAt: item.createdAt,
        }]);
        expect(db.edges(item.id)).toEqual(replayEdges);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });
});

function memory(
  id: string,
  status: MemoryRecord["status"],
  text: string,
  collection?: string,
): MemoryRecord {
  return {
    id,
    type: "note",
    status,
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: AT,
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-07-12.md", line: 1 },
    ...(collection === undefined ? {} : { collection }),
  };
}

function bullet(id: string, text: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: AT,
    refs: [],
  };
}

function memoryFromBullet(item: ReturnType<typeof bullet>): MemoryRecord {
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
    source: { file: "daily/2026-07-12.md" },
  };
}

function guardedReplacement(root: string, db: MemoryDb) {
  return replaceDbCanonicalGraphProjectionWithParity(root, db, (guardRoot, guardedDb) => {
    expect(guardRoot).toBe(root);
    expect(guardedDb).toBe(db);
  });
}
