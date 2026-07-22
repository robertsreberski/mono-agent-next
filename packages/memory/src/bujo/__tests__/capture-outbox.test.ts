import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditCaptureOutbox,
  replayCaptureOutbox as replayCaptureOutboxImpl,
  writeCaptureIntent,
  type CaptureIntentAction,
  type CaptureIntentReplayOptions,
} from "../capture-outbox.js";
import { appendBullet, dailyFilePath, rewriteBullet } from "../daily.js";
import { parseDailyFile, serializeBullet } from "../grammar.js";
import { appendEntity, appendGraphBatch, readGraph } from "../graph.js";
import { readCanonicalFileSnapshot } from "../path-safety.js";
import {
  assertCanonicalGraphRepairBaseParity,
  auditCanonicalIndexHealth,
} from "../rebuild.js";
import {
  legacyReplayProjectionFromDb,
  prepareReplayProjectionPublication,
  publishPreparedReplayProjection,
  readReplayProjectionStrict,
} from "../replay-projection.js";
import type { Bullet } from "../types.js";
import { openMemoryDb, type MemoryRecord } from "../../store/index.js";

const NOW = new Date("2026-07-11T09:00:00.000Z");

function replayCaptureOutbox(
  root: string,
  db?: Parameters<typeof replayCaptureOutboxImpl>[1],
  options: CaptureIntentReplayOptions = {},
) {
  return replayCaptureOutboxImpl(root, db, {
    ...options,
    ...(db === undefined ? {} : { canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity }),
  });
}

describe("capture outbox", () => {
  it("counts malformed intents and abandoned atomic temps while failing closed", () => {
    const root = tempRoot();
    const handle = writeCaptureIntent(root, [], {}, NOW.toISOString());
    writeFileSync(join(root, handle.file), "{not-json\n", { mode: 0o600 });
    const temp = join(
      root,
      ".capture-outbox",
      ".intent-00000000-0000-4000-8000-000000000000.json-00000000-0000-4000-8000-000000000001.tmp",
    );
    writeFileSync(temp, "{partial", { mode: 0o600 });

    expect(auditCaptureOutbox(root)).toEqual({ valid: false, pending: 1, temporary: 1 });
  });

  it("counts every intent even when the first physical payload is malformed", () => {
    const root = tempRoot();
    const handles = [
      writeCaptureIntent(root, [], {}, NOW.toISOString()),
      writeCaptureIntent(root, [], {}, NOW.toISOString()),
    ].sort((left, right) => left.file.localeCompare(right.file));
    writeFileSync(join(root, handles[0]!.file), "{not-json\n", { mode: 0o600 });

    expect(auditCaptureOutbox(root)).toEqual({ valid: false, pending: 2, temporary: 0 });
  });

  it("fails an over-capacity physical inventory before parsing intent payloads", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".capture-outbox"));
    for (let index = 0; index < 33; index += 1) {
      writeFileSync(
        join(root, ".capture-outbox", `intent-${index.toString(16).padStart(36, "0")}.json`),
        "{deliberately-not-json\n",
        { mode: 0o600 },
      );
    }

    expect(auditCaptureOutbox(root)).toEqual({ valid: false, pending: 33, temporary: 0 });
  });

  it.each([0, -0.1, 1.000_001])(
    "rejects an ADD thread weight outside (0, 1]: %s",
    (weight) => {
      const root = tempRoot();
      const item = bullet("BAD-WEIGHT", "Malformed thread weight must fail before publication.");
      const file = relative(root, dailyFilePath(root, NOW));

      expect(() => writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "add",
        id: item.id,
        after: { file, bullet: item },
        record: memoryRecord(item, file),
        vector: [1, 0],
        threads: [{ src: item.id, dst: "TARGET", weight }],
      }], {}, NOW.toISOString())).toThrow(/invalid add action/iu);
      expect(existsSync(join(root, ".capture-outbox"))).toBe(false);
    },
  );

  it("rejects an ADD thread self-edge before publication", () => {
    const root = tempRoot();
    const item = bullet("SELF-EDGE", "Self-threading evidence must fail before publication.");
    const file = relative(root, dailyFilePath(root, NOW));

    expect(() => writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [{ src: item.id, dst: item.id, weight: 0.8 }],
    }], {}, NOW.toISOString())).toThrow(/invalid add action/iu);
    expect(existsSync(join(root, ".capture-outbox"))).toBe(false);
  });

  it("refuses a new ADD intent before publication when a thread target is missing", () => {
    const root = tempRoot();
    const item = bullet("MISSING-THREAD", "Missing thread targets must fail before mutation.");
    const file = relative(root, dailyFilePath(root, NOW));
    expect(() => writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [{ src: item.id, dst: "MISSING", weight: 0.8 }],
    }], {}, NOW.toISOString())).toThrow(/thread target.*canonical timestamp/iu);
    expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
    expect(existsSync(join(root, ".capture-outbox"))).toBe(false);
  });

  it("completes an ADD from the exact pre-mutation state after an immediate crash", () => {
    const root = tempRoot();
    const item = bullet("ADD", "A prepared capture survives an immediate crash.");
    const file = relative(root, dailyFilePath(root, NOW));
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [],
    };
    writeCaptureIntent(root, [action], {
      entities: [{ id: "concept:crash", name: "Crash", type: "concept", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:crash",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:outbox"),
      dim: 2,
    });
    try {
      replayCaptureOutbox(root, db);
      expect(db.get(item.id)?.text).toBe(item.text);
      expect(db.hasVector(item.id)).toBe(true);
      expect(db.associationsForMemory(item.id)).toEqual([
        expect.objectContaining({ entityId: "concept:crash", provenance: "capture" }),
      ]);
      expect(parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets).toEqual([item]);
    } finally {
      db.close();
    }
  });

  it("treats a completed intent as a replay receipt and never reapplies its mutable payload", () => {
    const root = tempRoot();
    const target = bullet("COMPLETE-TARGET", "The completed intent target is canonical.");
    const added = bullet("COMPLETE-ADD", "The completed intent still carries replay authority.");
    appendBullet(root, target, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const handle = writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecord(added, file),
      vector: [1, 0],
      threads: [{ src: added.id, dst: target.id, weight: 0.8 }],
    }], {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:completed-intent-upgrade"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([memoryRecord(target, file)], [[0, 1]]);

      replayCaptureOutbox(root, db, { retainIntent: true });
      const completed = JSON.parse(readFileSync(join(root, handle.file), "utf8")) as { state: string };
      expect(completed.state).toBe("complete");
      const beforeMemory = db.get(added.id);
      const beforeEdges = db.allEdges();

      expect(replayCaptureOutboxImpl(root, db)).toEqual([{
        entities: [],
        relations: [],
        associations: [],
        appliedMemoryIds: [],
      }]);

      expect(db.get(added.id)).toEqual(beforeMemory);
      expect(db.allEdges()).toEqual(beforeEdges);
      expect(beforeEdges).toContainEqual({
        src: added.id,
        dst: target.id,
        kind: "thread",
        weight: 0.8,
        createdAt: NOW.toISOString(),
      });
      expect(readReplayProjectionStrict(root).projection.threads).toEqual([
        expect.objectContaining({ src: added.id, dst: target.id, authorityKind: "capture" }),
      ]);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not let a completed retained receipt revert a later memory or entity evolution", () => {
    const root = tempRoot();
    const before = bullet("RETAINED-EVOLUTION", "The first durable value.");
    const after = { ...before, text: "The later durable value." };
    const file = relative(root, dailyFilePath(root, NOW));
    const retained = writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: before.id,
      after: { file, bullet: before },
      record: memoryRecord(before, file),
      vector: [1, 0],
      threads: [],
    }], {
      entities: [{ id: "concept:evolving", name: "First", type: "concept", createdAt: NOW.toISOString() }],
    }, NOW.toISOString(), { retentionKey: "a".repeat(64) });
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:retained-evolution"),
      dim: 2,
    });
    try {
      replayCaptureOutbox(root, db);
      expect((JSON.parse(readFileSync(join(root, retained.file), "utf8")) as { state: string }).state)
        .toBe("complete");

      writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "update",
        id: before.id,
        before: { file, bullet: before },
        after: { file, bullet: after },
        record: memoryRecord(after, file),
        vector: [0, 1],
      }], {
        entities: [{ id: "concept:evolving", name: "Later", type: "concept", createdAt: NOW.toISOString() }],
      }, NOW.toISOString());

      expect(() => replayCaptureOutbox(root, db)).not.toThrow();
      expect(db.get(before.id)?.text).toBe(after.text);
      expect(db.getEntity("concept:evolving")?.name).toBe("Later");
      expect(readGraph(root).entities.find((entity) => entity.id === "concept:evolving")?.name).toBe("Later");
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);

      // A restart sees only the retained completed receipt. It verifies replay
      // authority and leaves the later canonical/SQLite graph untouched.
      expect(replayCaptureOutbox(root, db)).toEqual([{
        entities: [], relations: [], associations: [], appliedMemoryIds: [],
      }]);
      expect(db.get(before.id)?.text).toBe(after.text);
      expect(db.getEntity("concept:evolving")?.name).toBe("Later");
      expect(readGraph(root).entities.find((entity) => entity.id === "concept:evolving")?.name).toBe("Later");
    } finally {
      db.close();
    }
  });

  it("preflights two replay deltas cumulatively and publishes each with a fresh CAS", () => {
    const root = tempRoot();
    const targets = [
      bullet("CAS-TARGET-A", "First distinct canonical target."),
      bullet("CAS-TARGET-B", "Second distinct canonical target."),
    ];
    for (const target of targets) appendBullet(root, target, NOW);
    const additions = [
      bullet("CAS-ADD-A", "First distinct replay source."),
      bullet("CAS-ADD-B", "Second distinct replay source."),
    ];
    const file = relative(root, dailyFilePath(root, NOW));
    additions.forEach((added, index) => {
      writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "add",
        id: added.id,
        after: { file, bullet: added },
        record: memoryRecord(added, file),
        vector: index === 0 ? [1, 0] : [0, 1],
        threads: [{ src: added.id, dst: targets[index]!.id, weight: 0.8 }],
      }], {}, NOW.toISOString());
    });
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:multi-intent-replay-cas"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts(
        targets.map((target) => memoryRecord(target, file)),
        [[1, 0], [0, 1]],
      );

      expect(replayCaptureOutbox(root, db)).toHaveLength(2);

      expect(readReplayProjectionStrict(root).projection.threads.map(({ src, dst }) => ({ src, dst })))
        .toEqual([
          { src: additions[0]!.id, dst: targets[0]!.id },
          { src: additions[1]!.id, dst: targets[1]!.id },
        ]);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("attests an already-applied pending thread when no sidecar exists", () => {
    const root = tempRoot();
    const target = bullet("UPGRADE-THREAD-TARGET", "Upgrade thread target.");
    const source = bullet("UPGRADE-THREAD-SOURCE", "Upgrade thread source.");
    appendBullet(root, target, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file, bullet: source },
      record: memoryRecord(source, file),
      vector: [1, 0],
      threads: [{ src: source.id, dst: target.id, weight: 0.8 }],
    }], {}, NOW.toISOString());
    appendBullet(root, source, NOW);
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:already-applied-thread"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts(
        [memoryRecord(target, file), memoryRecord(source, file)],
        [[0, 1], [1, 0]],
      );
      db.addEdge(source.id, target.id, "thread", 0.8, NOW.toISOString());

      expect(replayCaptureOutbox(root, db)).toHaveLength(1);

      expect(readReplayProjectionStrict(root).projection.threads).toEqual([
        expect.objectContaining({ src: source.id, dst: target.id, at: NOW.toISOString() }),
      ]);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("normalizes an already-applied legacy thread whose durable intent omitted its timestamp", () => {
    const root = tempRoot();
    const target = bullet("LEGACY-UPGRADE-TARGET", "Legacy upgrade target.");
    const source = bullet("LEGACY-UPGRADE-SOURCE", "Legacy upgrade source.");
    appendBullet(root, target, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const handle = writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file, bullet: source },
      record: memoryRecord(source, file),
      vector: [1, 0],
      threads: [{ src: source.id, dst: target.id, weight: 0.8 }],
    }], {}, NOW.toISOString());
    const intentPath = join(root, handle.file);
    const legacy = JSON.parse(readFileSync(intentPath, "utf8")) as {
      actions: Array<{ threads?: Array<{ createdAt?: string }> }>;
    };
    delete legacy.actions[0]?.threads?.[0]?.createdAt;
    writeFileSync(intentPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    appendBullet(root, source, NOW);
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:legacy-already-applied-thread"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts(
        [memoryRecord(target, file), memoryRecord(source, file)],
        [[0, 1], [1, 0]],
      );
      db.addEdge(source.id, target.id, "thread", 0.8, "2026-07-11T10:00:00.000Z");

      expect(replayCaptureOutbox(root, db)).toHaveLength(1);

      expect(readReplayProjectionStrict(root).projection.threads).toEqual([
        expect.objectContaining({ src: source.id, dst: target.id, at: NOW.toISOString() }),
      ]);
      expect(db.allEdges()).toContainEqual({
        src: source.id,
        dst: target.id,
        kind: "thread",
        weight: 0.8,
        createdAt: NOW.toISOString(),
      });
    } finally {
      db.close();
    }
  });

  it("derives a thread target timestamp from a custom daily Markdown filename", () => {
    const root = tempRoot();
    const target = bullet("CUSTOM-DAILY-TARGET", "Custom daily target.");
    const source = bullet("CUSTOM-DAILY-SOURCE", "Custom daily source.");
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily", "custom-notes.md"), `${serializeBullet(target)}\n`, { mode: 0o600 });
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file, bullet: source },
      record: memoryRecord(source, file),
      vector: [1, 0],
      threads: [{ src: source.id, dst: target.id, weight: 0.8 }],
    }], {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:custom-daily-thread"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([memoryRecord(target, "daily/custom-notes.md")], [[0, 1]]);
      expect(replayCaptureOutbox(root, db)).toHaveLength(1);
      expect(readReplayProjectionStrict(root).projection.threads).toEqual([
        expect.objectContaining({ src: source.id, dst: target.id, at: NOW.toISOString() }),
      ]);
    } finally {
      db.close();
    }
  });

  it.each(["drifted", "db-only"] as const)(
    "rejects a %s legacy thread target before canonical or sidecar mutation",
    (scenario) => {
      const root = tempRoot();
      const target = bullet("UNTRUSTED-TARGET", "Untrusted target.");
      const source = bullet("UNTRUSTED-SOURCE", "Untrusted source.");
      appendBullet(root, target, NOW);
      const file = relative(root, dailyFilePath(root, NOW));
      writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "add",
        id: source.id,
        after: { file, bullet: source },
        record: memoryRecord(source, file),
        vector: [1, 0],
        threads: [{ src: source.id, dst: target.id, weight: 0.8 }],
      }], {}, NOW.toISOString());
      if (scenario === "db-only") {
        writeFileSync(join(root, file), "# 2026-07-11\n", { mode: 0o600 });
      }
      const db = openMemoryDb({
        path: join(root, "memory.db"),
        embeddings: noCallEmbeddings(`test:${scenario}-thread-target`),
        dim: 2,
      });
      try {
        const indexedTarget = scenario === "drifted"
          ? { ...target, createdAt: "2026-07-11T10:00:00.000Z" }
          : target;
        db.commitPreparedUpserts([memoryRecord(indexedTarget, file)], [[0, 1]]);

        expect(() => replayCaptureOutbox(root, db)).toThrow(/canonical|timestamp/iu);
        expect(readReplayProjectionStrict(root).state.kind).toBe("missing");
        expect(parseDailyFile(readFileSync(join(root, file), "utf8")).bullets.some((item) => item.id === source.id))
          .toBe(false);
      } finally {
        db.close();
      }
    },
  );

  it("attests an already-applied pending supersede when no sidecar exists", () => {
    const root = tempRoot();
    const old = bullet("UPGRADE-SUPERSEDE-OLD", "Upgrade predecessor.");
    const replacement = bullet("UPGRADE-SUPERSEDE-NEW", "Upgrade replacement.");
    appendBullet(root, old, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      vector: [0, 1],
      at: NOW.toISOString(),
    }], {}, NOW.toISOString());
    appendBullet(root, replacement, NOW);
    expect(rewriteBullet(root, file, old.id, { status: "invalidated" })).toBe(true);
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:already-applied-supersede"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts(
        [memoryRecord({ ...old, status: "invalidated" }, file), memoryRecord(replacement, file)],
        [[1, 0], [0, 1]],
      );
      db.markSuperseded(old.id, replacement.id, NOW.toISOString());

      expect(replayCaptureOutbox(root, db)).toHaveLength(1);

      expect(readReplayProjectionStrict(root).projection.supersedes).toEqual([
        expect.objectContaining({ src: old.id, dst: replacement.id, at: NOW.toISOString() }),
      ]);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("converges instead of throwing when a pre-existing entity row diverges from the canonical record", () => {
    const root = tempRoot();
    const item = bullet("PAOLA-ADD", "Paola owns the capture that used to wedge the outbox.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [],
    }], {
      // Capture-time entity: no summary, capture-time createdAt — exactly the shape
      // graphForPreparedActions emits.
      entities: [{ id: "person:paola", name: "Paola", type: "person", createdAt: NOW.toISOString() }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:diverged-entity"),
      dim: 2,
    });
    try {
      // The live wedge shape: a DB row predating the memory rework carries a stale
      // summary and an old created_at, with NO graph.jsonl line to reconcile against.
      db.upsertEntity({
        id: "person:paola",
        name: "Paola",
        type: "person",
        summary: "stale",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
      });

      expect(() => replayCaptureOutbox(root, db)).not.toThrow();

      // The dumb-mirror upsert overwrote the diverged row to the canonical record:
      // summary cleared, updatedAt cleared, created_at taken from the canonical entity.
      expect(db.getEntity("person:paola")).toEqual({
        id: "person:paola",
        name: "Paola",
        type: "person",
        createdAt: NOW.toISOString(),
      });
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("converges when graph.jsonl and the index disagree on createdAt/summary", () => {
    const root = tempRoot();
    const createdAtA = "2025-01-01T00:00:00.000Z";
    // Canonical graph line: authoritative createdAt A and a summary S.
    appendEntity(root, {
      id: "person:paola",
      name: "Paola",
      type: "person",
      summary: "canonical summary",
      createdAt: createdAtA,
    });
    const item = bullet("PAOLA-GRAPH", "Paola's capture reconciles against the canonical graph line.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0],
      threads: [],
    }], {
      entities: [{ id: "person:paola", name: "Paola", type: "person", createdAt: NOW.toISOString() }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:graph-index-disagree"),
      dim: 2,
    });
    try {
      // Index row disagrees with the graph line: createdAt B and no summary.
      db.upsertEntity({
        id: "person:paola",
        name: "Paola",
        type: "person",
        createdAt: "2025-06-06T00:00:00.000Z",
      });

      expect(() => replayCaptureOutbox(root, db)).not.toThrow();

      // Convergence to the merged canonical record: createdAt A + summary S.
      expect(db.getEntity("person:paola")).toEqual({
        id: "person:paola",
        name: "Paola",
        type: "person",
        summary: "canonical summary",
        createdAt: createdAtA,
      });
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("replaces the full derived graph projection after an ADD", () => {
    const root = tempRoot();
    const earlier = new Date(NOW.getTime() - 60_000);
    const existing = {
      ...bullet("DERIVED-EXISTING", "Morgan already appears in canonical memory."),
      createdAt: earlier.toISOString(),
    };
    const added = bullet("DERIVED-ADDED", "Morgan also appears in the newly captured memory.");
    appendBullet(root, existing, earlier);
    const entity = {
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      createdAt: earlier.toISOString(),
    } as const;
    appendEntity(root, entity);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecord(added, file),
      vector: [1, 0],
      threads: [],
    }], {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:replace-derived-add"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts(
        [memoryRecord(existing, relative(root, dailyFilePath(root, earlier)))],
        [[1, 0]],
      );
      db.mirrorCanonicalEntity(entity);
      db.mirrorCanonicalAssociation({
        memoryId: existing.id,
        entityId: entity.id,
        provenance: "legacy-name-match",
        createdAt: existing.createdAt,
      });

      replayCaptureOutbox(root, db);

      expect(db.allMemoryAssociations()).toEqual([
        {
          memoryId: added.id,
          entityId: entity.id,
          provenance: "legacy-name-match",
          createdAt: added.createdAt,
        },
        {
          memoryId: existing.id,
          entityId: entity.id,
          provenance: "legacy-name-match",
          createdAt: existing.createdAt,
        },
      ].sort((left, right) => left.memoryId.localeCompare(right.memoryId)));
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("removes stale derived associations when canonical capture evidence supersedes them", () => {
    const root = tempRoot();
    const item = bullet("DERIVED-SUPPRESSED", "Morgan and Paola are both named here.");
    appendBullet(root, item, NOW);
    const entities = [{
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      createdAt: NOW.toISOString(),
    }, {
      id: "person:paola",
      name: "Paola",
      type: "person",
      createdAt: NOW.toISOString(),
    }] as const;
    for (const entity of entities) appendEntity(root, entity);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: item.id,
      expected: { file, bullet: item },
    }], {
      entities: [entities[1]],
      associations: [{
        memoryId: item.id,
        entityId: entities[1].id,
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:remove-stale-derived"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([memoryRecord(item, file)], [[1, 0]]);
      for (const entity of entities) {
        db.mirrorCanonicalEntity(entity);
        db.mirrorCanonicalAssociation({
          memoryId: item.id,
          entityId: entity.id,
          provenance: "legacy-name-match",
          createdAt: item.createdAt,
        });
      }

      replayCaptureOutbox(root, db);

      expect(db.allMemoryAssociations()).toEqual([{
        memoryId: item.id,
        entityId: entities[1].id,
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }]);
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("finishes mixed applied/before ADD, UPDATE, SUPERSEDE, and NOOP actions in one intent", () => {
    const root = tempRoot();
    const added = bullet("ADDED", "The add action was already applied.");
    const updateBefore = bullet("UPDATE", "Update before state.");
    const updateAfter = { ...updateBefore, text: "Update after state." };
    const old = bullet("OLD", "Supersede before state.");
    const replacement = bullet("NEW", "Supersede replacement state.");
    const noop = bullet("NOOP", "Noop exact state.");
    appendBullet(root, updateBefore, NOW);
    appendBullet(root, old, NOW);
    appendBullet(root, noop, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const actions: CaptureIntentAction[] = [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecord(added, file),
      threads: [],
    }, {
      candidateIndex: 1,
      kind: "update",
      id: updateBefore.id,
      before: { file, bullet: updateBefore },
      after: { file, bullet: updateAfter },
      record: memoryRecord(updateAfter, file),
    }, {
      candidateIndex: 2,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      at: NOW.toISOString(),
    }, {
      candidateIndex: 3,
      kind: "noop",
      id: noop.id,
      expected: { file, bullet: noop },
    }];
    writeCaptureIntent(root, actions, {}, NOW.toISOString());
    appendBullet(root, added, NOW);

    replayCaptureOutbox(root, undefined, { retainIntent: true });

    const replayed = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
    expect(replayed.find((item) => item.id === added.id)).toEqual(added);
    expect(replayed.find((item) => item.id === updateBefore.id)).toEqual(updateAfter);
    expect(replayed.find((item) => item.id === old.id)?.status).toBe("invalidated");
    expect(replayed.find((item) => item.id === replacement.id)).toEqual(replacement);
    expect(replayed.find((item) => item.id === noop.id)).toEqual(noop);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("recovers legacy salience-only drift for ADD, UPDATE, and NOOP from exact canonical states", () => {
    const root = tempRoot();
    const added = { ...bullet("LEGACY-ADD", "Canonical add survived the old decay job."), salience: 0.8 };
    const updateBefore = { ...bullet("LEGACY-UPDATE", "Canonical update before state."), salience: 0.95 };
    const updateAfter = { ...updateBefore, text: "Canonical update after state." };
    const noop = { ...bullet("LEGACY-NOOP", "Canonical noop survived the old decay job."), salience: 0.7 };
    appendBullet(root, added, NOW);
    appendBullet(root, updateBefore, NOW);
    appendBullet(root, noop, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const vector = [1, 0] as const;
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file, bullet: added },
      record: memoryRecord(added, file),
      vector,
      threads: [],
    }, {
      candidateIndex: 1,
      kind: "update",
      id: updateBefore.id,
      before: { file, bullet: updateBefore },
      after: { file, bullet: updateAfter },
      record: memoryRecord(updateAfter, file),
      vector,
    }, {
      candidateIndex: 2,
      kind: "noop",
      id: noop.id,
      expected: { file, bullet: noop },
    }], {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:legacy-add-update-salience"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([{
        ...memoryRecord(added, file),
        salience: 0.05,
      }, {
        ...memoryRecord(updateBefore, file),
        salience: 0.7358,
      }, {
        ...memoryRecord(noop, file),
        salience: 0.1,
      }], [vector, vector, vector]);

      replayCaptureOutbox(root, db);

      expect(db.get(added.id)).toMatchObject({ text: added.text, salience: added.salience });
      expect(db.get(updateBefore.id)).toMatchObject({ text: updateAfter.text, salience: updateAfter.salience });
      expect(db.get(noop.id)).toMatchObject({ text: noop.text, salience: noop.salience });
      expect(db.hasVector(added.id)).toBe(true);
      expect(db.hasVector(updateBefore.id)).toBe(true);
      expect(db.hasVector(noop.id)).toBe(true);
      const canonical = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
      expect(canonical.find((item) => item.id === added.id)).toEqual(added);
      expect(canonical.find((item) => item.id === updateBefore.id)).toEqual(updateAfter);
      expect(canonical.find((item) => item.id === noop.id)).toEqual(noop);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("replays an UPDATE after canonical mutation with a legacy-decayed DB-before row", () => {
    const root = tempRoot();
    const before = { ...bullet("UPDATE-HALF", "Canonical update before crash."), salience: 0.8 };
    const after = { ...before, text: "Canonical update after crash." };
    appendBullet(root, before, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const vector = [1, 0] as const;
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "update",
      id: before.id,
      before: { file, bullet: before },
      after: { file, bullet: after },
      record: memoryRecord(after, file),
      vector,
    }], {}, NOW.toISOString());
    // Reachable crash window: canonical rewrite completed, DB commit did not.
    expect(rewriteBullet(root, file, before.id, { text: after.text })).toBe(true);
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:update-half-state-salience"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([{
        ...memoryRecord(before, file),
        salience: 0.05,
      }], [vector]);

      replayCaptureOutbox(root, db, { retainIntent: true });
      const firstRecord = db.get(before.id);
      expect(firstRecord).toMatchObject({ text: after.text, salience: after.salience });
      expect(parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets).toEqual([after]);
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);

      expect(replayCaptureOutbox(root, db)).toEqual([{
        entities: [], relations: [], associations: [], appliedMemoryIds: [],
      }]);
      expect(db.get(before.id)).toEqual(firstRecord);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("repairs a known supersede half-state before applying its graph", () => {
    const root = tempRoot();
    const old = bullet("OLD", "Atlas launches in July.");
    const replacement = bullet("NEW", "Atlas launches in August.");
    appendBullet(root, old, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const record = memoryRecord(replacement, file);
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record,
      at: NOW.toISOString(),
    };
    writeCaptureIntent(root, [action], {
      entities: [{ id: "project:atlas", name: "Atlas", type: "project", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: replacement.id,
        entityId: "project:atlas",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());

    // Simulate a process dying after append-new but before invalidating old.
    appendBullet(root, replacement, NOW);
    replayCaptureOutbox(root, undefined, { retainIntent: true });

    const daily = readCanonicalFileSnapshot(root, file)!;
    const parsed = parseDailyFile(daily.content);
    expect(parsed.bullets.find((item) => item.id === old.id)?.status).toBe("invalidated");
    expect(parsed.bullets.find((item) => item.id === replacement.id)?.text).toBe(replacement.text);
    expect(readGraph(root).associations).toEqual([
      expect.objectContaining({ memoryId: replacement.id, entityId: "project:atlas" }),
    ]);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("replays legacy-decayed SUPERSEDE sources with valid 768-dimension prepared vectors", () => {
    const root = tempRoot();
    const oldAtFloor = { ...bullet("OLD-FLOOR", "The first legacy source remains canonical."), salience: 0.8 };
    const oldPartial = { ...bullet("OLD-PARTIAL", "The second legacy source remains canonical."), salience: 0.95 };
    const replacementAtFloor = { ...bullet("NEW-FLOOR", "The first replacement is current."), salience: 0.85 };
    const replacementPartial = { ...bullet("NEW-PARTIAL", "The second replacement is current."), salience: 0.9 };
    appendBullet(root, oldAtFloor, NOW);
    appendBullet(root, oldPartial, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const vector = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
    const pairs: ReadonlyArray<readonly [Bullet, Bullet]> = [
      [oldAtFloor, replacementAtFloor],
      [oldPartial, replacementPartial],
    ];
    const actions: CaptureIntentAction[] = pairs.map(([old, replacement], candidateIndex) => ({
      candidateIndex,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      vector,
      at: NOW.toISOString(),
    }));
    writeCaptureIntent(root, actions, {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:legacy-supersede-salience"),
      dim: 768,
    });
    try {
      db.commitPreparedUpserts([{
        ...memoryRecord(oldAtFloor, file),
        salience: 0.05,
      }, {
        ...memoryRecord(oldPartial, file),
        salience: 0.7358,
      }], [vector, vector]);

      replayCaptureOutbox(root, db);

      expect(db.get(oldAtFloor.id)).toMatchObject({
        salience: oldAtFloor.salience,
        status: "invalidated",
        supersededBy: replacementAtFloor.id,
        supersededAt: NOW.toISOString(),
        validTo: NOW.toISOString(),
      });
      expect(db.get(oldPartial.id)).toMatchObject({
        salience: oldPartial.salience,
        status: "invalidated",
        supersededBy: replacementPartial.id,
        supersededAt: NOW.toISOString(),
        validTo: NOW.toISOString(),
      });
      expect(db.get(replacementAtFloor.id)).toMatchObject({
        text: replacementAtFloor.text,
        salience: replacementAtFloor.salience,
      });
      expect(db.get(replacementPartial.id)).toMatchObject({
        text: replacementPartial.text,
        salience: replacementPartial.salience,
      });
      for (const id of [oldAtFloor.id, oldPartial.id, replacementAtFloor.id, replacementPartial.id]) {
        expect(db.hasVector(id)).toBe(true);
      }
      const canonical = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
      expect(canonical.find((item) => item.id === oldAtFloor.id)?.status).toBe("invalidated");
      expect(canonical.find((item) => item.id === oldPartial.id)?.status).toBe("invalidated");
      expect(canonical.find((item) => item.id === replacementAtFloor.id)).toEqual(replacementAtFloor);
      expect(canonical.find((item) => item.id === replacementPartial.id)).toEqual(replacementPartial);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("replays a SUPERSEDE after canonical mutation with a legacy-decayed DB-before row", () => {
    const root = tempRoot();
    const old = { ...bullet("SUPERSEDE-HALF-OLD", "Canonical predecessor before crash."), salience: 0.95 };
    const replacement = { ...bullet("SUPERSEDE-HALF-NEW", "Canonical replacement after crash."), salience: 0.9 };
    appendBullet(root, old, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const vector = [1, 0] as const;
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      vector,
      at: NOW.toISOString(),
    }], {}, NOW.toISOString());
    // Reachable crash window: append + invalidation completed, DB commit did not.
    appendBullet(root, replacement, NOW);
    expect(rewriteBullet(root, file, old.id, { status: "invalidated" })).toBe(true);
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:supersede-half-state-salience"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([{
        ...memoryRecord(old, file),
        salience: 0.7358,
      }], [vector]);

      replayCaptureOutbox(root, db, { retainIntent: true });
      const firstOld = db.get(old.id);
      const firstReplacement = db.get(replacement.id);
      const firstEdges = db.edges(old.id);
      expect(firstOld).toMatchObject({
        text: old.text,
        salience: old.salience,
        status: "invalidated",
        supersededBy: replacement.id,
        supersededAt: NOW.toISOString(),
        validTo: NOW.toISOString(),
      });
      expect(firstReplacement).toMatchObject({ text: replacement.text, salience: replacement.salience });
      expect(firstEdges).toEqual([
        expect.objectContaining({ kind: "supersedes", dst: replacement.id }),
      ]);
      const replayAuthority = readReplayProjectionStrict(root).projection;
      expect(replayAuthority.supersedes).toEqual([
        expect.objectContaining({ src: old.id, dst: replacement.id, at: NOW.toISOString() }),
      ]);
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);

      expect(replayCaptureOutbox(root, db)).toEqual([{
        entities: [], relations: [], associations: [], appliedMemoryIds: [],
      }]);
      expect(db.get(old.id)).toEqual(firstOld);
      expect(db.get(replacement.id)).toEqual(firstReplacement);
      expect(db.edges(old.id)).toEqual(firstEdges);
      expect(readReplayProjectionStrict(root).projection).toEqual(replayAuthority);
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("retires graph-owned collection state while preserving replay edges on SUPERSEDE", () => {
    const root = tempRoot();
    const old = { ...bullet("COLLECTION-OLD", "The migrated project note."), status: "migrated" as const };
    const replacement = bullet("COLLECTION-NEW", "The current project note.");
    const target = bullet("THREAD-TARGET", "A related canonical note.");
    appendBullet(root, old, NOW);
    appendBullet(root, target, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const collection = {
      id: "collection:projects",
      name: "projects",
      type: "collection",
      createdAt: NOW.toISOString(),
    } as const;
    appendGraphBatch(root, {
      entities: [collection],
      associations: [{
        memoryId: old.id,
        entityId: collection.id,
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    });
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      vector: [1, 0],
      at: NOW.toISOString(),
    }], {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:supersede-collection-projection"),
      dim: 2,
    });
    try {
      db.commitPreparedUpserts([{
        ...memoryRecord(old, file),
        collection: "projects",
      }, memoryRecord(target, file)], [[1, 0], [0, 1]]);
      db.mirrorCanonicalEntity(collection);
      db.mirrorCanonicalAssociation({
        memoryId: old.id,
        entityId: collection.id,
        provenance: "capture",
        createdAt: NOW.toISOString(),
      });
      db.addEdge(old.id, collection.id, "supports");
      db.addEdge(old.id, target.id, "thread", 0.8, NOW.toISOString());
      publishPreparedReplayProjection(root, prepareReplayProjectionPublication(
        root,
        legacyReplayProjectionFromDb(db, "a".repeat(64)),
        { requireMissing: true },
      ));

      replayCaptureOutbox(root, db);

      expect(db.get(old.id)).toMatchObject({
        status: "invalidated",
        supersededBy: replacement.id,
        supersededAt: NOW.toISOString(),
        validTo: NOW.toISOString(),
      });
      expect(db.get(old.id)).not.toHaveProperty("collection");
      expect(db.edges(old.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "thread", dst: target.id, weight: 0.8 }),
        expect.objectContaining({ kind: "supersedes", dst: replacement.id, weight: 1 }),
      ]));
      expect(db.edges(old.id).some((edge) => edge.kind === "supports")).toBe(false);
      expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
    } finally {
      db.close();
    }
  });

  it("fails closed when canonical state matches neither the before nor after outcome", () => {
    const root = tempRoot();
    const before = bullet("TARGET", "Morgan prefers blue deployments.");
    const after = { ...before, text: "Morgan prefers reviewed blue deployments." };
    appendBullet(root, before, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "update",
      id: before.id,
      before: { file, bullet: before },
      after: { file, bullet: after },
      record: memoryRecord(after, file),
    };
    writeCaptureIntent(root, [action], {
      entities: [{ id: "concept:review", name: "Review", type: "concept", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: before.id,
        entityId: "concept:review",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    expect(rewriteBullet(root, file, before.id, { text: "A conflicting external rewrite." })).toBe(true);

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/conflicts with canonical action update/iu);
    expect(readGraph(root).associations).toEqual([]);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects a symlinked outbox directory without writing outside the memory root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(root, ".capture-outbox"), "dir");

    expect(() => writeCaptureIntent(root, [], {}, NOW.toISOString())).toThrow(/directory.*symlink/iu);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects an oversized graph plan before publishing an intent", () => {
    const root = tempRoot();
    const entities = Array.from({ length: 17 }, (_, index) => ({
      id: `concept:${index}`,
      name: `Concept ${index}`,
      createdAt: NOW.toISOString(),
    }));

    expect(() => writeCaptureIntent(root, [], { entities }, NOW.toISOString())).toThrow(/schema|bound/iu);
    expect(existsSync(join(root, ".capture-outbox"))).toBe(false);
  });

  it("stores a valid eight-action 16,384-dimension batch within the encoded intent bound", () => {
    const root = tempRoot();
    const file = relative(root, dailyFilePath(root, NOW));
    const vector = Array.from({ length: 16_384 }, (_, index) => (index % 17) / 17);
    const actions: CaptureIntentAction[] = Array.from({ length: 8 }, (_, candidateIndex) => {
      const item = bullet(`HIGH-${candidateIndex}`, `High-dimension capture ${candidateIndex}.`);
      return {
        candidateIndex,
        kind: "add",
        id: item.id,
        after: { file, bullet: item },
        record: memoryRecord(item, file),
        vector,
        threads: [],
      };
    });

    writeCaptureIntent(root, actions, {}, NOW.toISOString());
    const [name] = readdirSync(join(root, ".capture-outbox"));
    expect(name).toBeDefined();
    expect(statSync(join(root, ".capture-outbox", name!)).size).toBeLessThan(2 * 1024 * 1024);
    replayCaptureOutbox(root, undefined, { retainIntent: true });
    expect(parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets).toHaveLength(8);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects a replay vector that does not match the active database dimension", () => {
    const root = tempRoot();
    const item = bullet("WRONG-DIM", "Wrong-dimension replay sentinel.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      vector: [1, 0, 0],
      threads: [],
    }], {
      entities: [{ id: "concept:dimension", name: "Dimension", type: "concept", createdAt: NOW.toISOString() }],
      associations: [{
        memoryId: item.id,
        entityId: "concept:dimension",
        provenance: "capture",
        createdAt: NOW.toISOString(),
      }],
    }, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:wrong-dim"),
      dim: 2,
    });
    try {
      expect(() => replayCaptureOutbox(root, db)).toThrow(/dimension mismatch.*expected 2.*got 3/iu);
      expect(db.count()).toBe(0);
      expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
      expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("preflights every canonical action before applying the first one", () => {
    const root = tempRoot();
    const first = bullet("FIRST", "This valid ADD must remain unapplied.");
    const conflictBefore = bullet("CONFLICT", "Expected before state.");
    const conflictAfter = { ...conflictBefore, text: "Expected after state." };
    appendBullet(root, { ...conflictBefore, text: "External conflicting state." }, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: first.id,
      after: { file, bullet: first },
      record: memoryRecord(first, file),
      threads: [],
    }, {
      candidateIndex: 1,
      kind: "update",
      id: conflictBefore.id,
      before: { file, bullet: conflictBefore },
      after: { file, bullet: conflictAfter },
      record: memoryRecord(conflictAfter, file),
    }], {}, NOW.toISOString());

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/conflicts with canonical action update/iu);
    const replayed = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
    expect(replayed.some((item) => item.id === first.id)).toBe(false);
    expect(replayed.find((item) => item.id === conflictBefore.id)?.text).toBe("External conflicting state.");
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects a tampered record-to-bullet binding and keeps the intent pending", () => {
    const root = tempRoot();
    const item = bullet("BOUND", "Canonical binding sentinel.");
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      threads: [],
    }], {}, NOW.toISOString());
    const [name] = readdirSync(join(root, ".capture-outbox"));
    const path = join(root, ".capture-outbox", name!);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { actions: Array<{ record: { text: string } }> };
    raw.actions[0]!.record.text = "Tampered SQLite text.";
    writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/does not match.*canonical bullet/iu);
    expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
  });

  it("rejects memory-id overlap across queued intents before applying either intent", () => {
    const root = tempRoot();
    const item = bullet("OVERLAP", "Only one durable intent may own a memory id.");
    const file = relative(root, dailyFilePath(root, NOW));
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "add",
      id: item.id,
      after: { file, bullet: item },
      record: memoryRecord(item, file),
      threads: [],
    };
    writeCaptureIntent(root, [action], {}, NOW.toISOString());
    writeCaptureIntent(root, [action], {}, NOW.toISOString());

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true })).toThrow(/queued intents.*overlap/iu);
    expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(2);
  });

  it("rejects mutable graph-key overlap across randomly ordered queued intents", () => {
    const root = tempRoot();
    const file = relative(root, dailyFilePath(root, NOW));
    for (const [index, name] of ["Older", "Newer"].entries()) {
      const item = bullet(`GRAPH-OVERLAP-${index}`, `${name} graph mutation.`);
      writeCaptureIntent(root, [{
        candidateIndex: 0,
        kind: "add",
        id: item.id,
        after: { file, bullet: item },
        record: memoryRecord(item, file),
        threads: [],
      }], {
        entities: [{ id: "concept:shared", name, type: "concept", createdAt: NOW.toISOString() }],
      }, NOW.toISOString());
    }

    expect(() => replayCaptureOutbox(root, undefined, { retainIntent: true }))
      .toThrow(/queued intents.*overlap on graph entity/iu);
    expect(existsSync(dailyFilePath(root, NOW))).toBe(false);
    expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
  });

  it("rejects a non-salience supersede DB mismatch even alongside legacy salience drift", () => {
    const root = tempRoot();
    const old = bullet("OLD-POISON", "The canonical old value.");
    const replacement = bullet("NEW-POISON", "The replacement value.");
    appendBullet(root, old, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "supersede",
      oldId: old.id,
      newId: replacement.id,
      beforeOld: { file, bullet: old },
      afterOld: { file, bullet: { ...old, status: "invalidated" } },
      afterNew: { file, bullet: replacement },
      record: memoryRecord(replacement, file),
      at: NOW.toISOString(),
    }], {}, NOW.toISOString());
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical({
        ...memoryRecord(old, file),
        text: "A divergent SQLite value.",
        salience: 0.05,
      });

      expect(() => replayCaptureOutbox(root, db)).toThrow(/supersede target.*conflicts.*active index/iu);

      const canonical = parseDailyFile(readFileSync(dailyFilePath(root, NOW), "utf8")).bullets;
      expect(canonical).toEqual([old]);
      expect(db.get(old.id)?.text).toBe("A divergent SQLite value.");
      expect(db.get(old.id)?.salience).toBe(0.05);
      expect(db.get(replacement.id)).toBeUndefined();
      expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("preserves live telemetry while clearing unsupported graph-derived collection state", () => {
    const root = tempRoot();
    const before = bullet("LIVE-UPDATE", "Before durable replay.");
    const after = { ...before, text: "After durable replay." };
    appendBullet(root, before, NOW);
    const file = relative(root, dailyFilePath(root, NOW));
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "update",
      id: before.id,
      before: { file, bullet: before },
      after: { file, bullet: after },
      record: memoryRecord(after, file),
      vector: [1, 0],
    }], {}, NOW.toISOString());
    const db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: noCallEmbeddings("test:live-telemetry"),
      dim: 2,
    });
    const lastAccessedAt = "2026-07-11T09:30:00.000Z";
    try {
      db.commitPreparedUpserts([{
        ...memoryRecord(before, file),
        accessCount: 5,
        lastAccessedAt,
        validFrom: "2026-07-01T00:00:00.000Z",
        collection: "live-state",
        tags: ["latest"],
        source: { file, line: 3, session: "live-session" },
      }], [[1, 0]]);

      replayCaptureOutbox(root, db);

      const replayed = db.get(before.id);
      expect(replayed).toMatchObject({
        text: after.text,
        accessCount: 5,
        lastAccessedAt,
        validFrom: "2026-07-01T00:00:00.000Z",
        tags: ["latest"],
        source: { file, line: 3, session: "live-session" },
      });
      expect(replayed).not.toHaveProperty("collection");
      expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "capture-outbox-"));
}

function noCallEmbeddings(id: string) {
  return {
    id,
    embed: async (_texts: readonly string[]): Promise<number[][]> => {
      throw new Error("stored outbox vectors must not call the embedding provider");
    },
  };
}

function bullet(id: string, text: string): Bullet {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: NOW.toISOString(),
    refs: [],
  };
}

function memoryRecord(item: Bullet, file: string): MemoryRecord {
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
