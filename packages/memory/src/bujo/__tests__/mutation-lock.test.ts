import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { recoverDurableMutationState } from "../mutation-lock.js";
import {
  REPLAY_PROJECTION_FILE,
  initializeReplayProjection,
  prepareReplayProjectionPublication,
  publishPreparedReplayProjection,
  replayProjectionDbReplacement,
  type ReplayProjectionV1,
} from "../replay-projection.js";

const CREATED_AT = "2026-07-01T00:00:00.000Z";
const REPLAY_AT = "2026-07-02T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-mutation-recovery-"));
  roots.push(root);
  return root;
}

function memory(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    type: "note",
    status: "open",
    text: `memory ${id}`,
    salience: 0.5,
    isInsight: false,
    createdAt: CREATED_AT,
    accessCount: 0,
    tags: [],
    source: {},
    ...overrides,
  };
}

type ReplaySeed = (db: MemoryDb) => void;
type ExactReplaySeed = (db: MemoryDb) => ReplayProjectionV1;

const AUTHORITY_ID = "a".repeat(64);

const replayStateCases: ReadonlyArray<readonly [string, ReplaySeed]> = [
  ["validTo lifecycle", (db) => db.upsertLexical(memory("subject", { validTo: REPLAY_AT }))],
  ["supersededBy lifecycle", (db) => db.upsertLexical(memory("subject", { supersededBy: "target" }))],
  ["supersededAt lifecycle", (db) => db.upsertLexical(memory("subject", { supersededAt: REPLAY_AT }))],
  ["complete supersession lifecycle", (db) => db.upsertLexical(memory("subject", {
    status: "invalidated",
    validTo: REPLAY_AT,
    supersededBy: "target",
    supersededAt: REPLAY_AT,
  }))],
  ["thread edge", (db) => db.addEdge("subject", "target", "thread", 0.8, REPLAY_AT)],
  ["supersedes edge", (db) => db.addEdge("subject", "target", "supersedes", 1, REPLAY_AT)],
];

const exactReplayCases: ReadonlyArray<readonly [string, ExactReplaySeed]> = [
  ["terminal lifecycle", (db) => {
    db.upsertLexical(memory("subject", { status: "dropped" }));
    return {
      schemaVersion: 1,
      terminals: [{
        id: "subject",
        at: REPLAY_AT,
        authorityKind: "migration",
        authorityId: AUTHORITY_ID,
      }],
      supersedes: [],
      threads: [],
    };
  }],
  ["complete supersession lifecycle and edge", (db) => {
    db.upsertLexical(memory("subject", { status: "invalidated" }));
    db.upsertLexical(memory("target", { createdAt: REPLAY_AT }));
    return {
      schemaVersion: 1,
      terminals: [],
      supersedes: [{
        src: "subject",
        dst: "target",
        at: REPLAY_AT,
        authorityKind: "migration",
        authorityId: AUTHORITY_ID,
      }],
      threads: [],
    };
  }],
  ["thread edge", (db) => {
    db.upsertLexical(memory("subject"));
    db.upsertLexical(memory("target"));
    return {
      schemaVersion: 1,
      terminals: [],
      supersedes: [],
      threads: [{
        src: "subject",
        dst: "target",
        weight: 0.8,
        at: REPLAY_AT,
        authorityKind: "migration",
        authorityId: AUTHORITY_ID,
      }],
    };
  }],
];

describe.each(["lite", "journal"] as const)("%s durable mutation recovery", (tier) => {
  it("accepts ordinary state without taking a full replay snapshot", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical(memory("dropped", { status: "dropped" }));
      db.upsertLexical(memory("invalidated", { status: "invalidated" }));
      db.addEdge("dropped", "entity:one", "about", 0.8, CREATED_AT);
      db.addEdge("invalidated", "collection:one", "supports", 1, CREATED_AT);
      const snapshot = vi.spyOn(db, "replayProjectionSnapshot")
        .mockImplementation(() => { throw new Error("full replay snapshot sentinel"); });

      expect(recoverDurableMutationState(root, db, tier)).toEqual({ captureReplayed: 0 });
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(replayStateCases)("rejects %s without taking a full replay snapshot", (_label, seed) => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical(memory("subject"));
      db.upsertLexical(memory("target"));
      seed(db);
      const snapshot = vi.spyOn(db, "replayProjectionSnapshot")
        .mockImplementation(() => { throw new Error("full replay snapshot sentinel"); });

      expect(() => recoverDurableMutationState(root, db, tier))
        .toThrow(`memory-bujo: ${tier} rejects BuJo replay-owned lifecycle and edges.`);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(["valid", "malformed"] as const)("does not consume a %s BuJo sidecar", (sidecar) => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical(memory("subject"));
      db.upsertLexical(memory("target"));
      if (sidecar === "valid") {
        initializeReplayProjection(root);
      } else {
        writeFileSync(join(root, REPLAY_PROJECTION_FILE), "{not-json", { mode: 0o600 });
      }

      expect(recoverDurableMutationState(root, db, tier)).toEqual({ captureReplayed: 0 });
      db.addEdge("subject", "target", "thread", 0.8, REPLAY_AT);
      expect(() => recoverDurableMutationState(root, db, tier))
        .toThrow(`memory-bujo: ${tier} rejects BuJo replay-owned lifecycle and edges.`);
    } finally {
      db.close();
    }
  });
});

describe("BuJo durable mutation recovery", () => {
  it("accepts an exact empty sidecar without using the non-BuJo presence probe", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical(memory("source"));
      db.upsertLexical(memory("target"));
      initializeReplayProjection(root);
      const boundedProbe = vi.spyOn(db, "hasReplayProjectionState")
        .mockImplementation(() => { throw new Error("non-BuJo replay probe sentinel"); });

      expect(recoverDurableMutationState(root, db, "bujo")).toEqual({ captureReplayed: 0 });
      expect(boundedProbe).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(replayStateCases)("rejects unattested %s through exact parity", (_label, seed) => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      db.upsertLexical(memory("subject"));
      db.upsertLexical(memory("target"));
      initializeReplayProjection(root);
      seed(db);
      const boundedProbe = vi.spyOn(db, "hasReplayProjectionState")
        .mockImplementation(() => { throw new Error("non-BuJo replay probe sentinel"); });

      expect(() => recoverDurableMutationState(root, db, "bujo"))
        .toThrow(/memory-replay-projection:/u);
      expect(boundedProbe).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(exactReplayCases)("accepts exact nonempty %s", (_label, seed) => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    try {
      const projection = seed(db);
      db.replaceReplayProjection(replayProjectionDbReplacement(projection));
      publishPreparedReplayProjection(root, prepareReplayProjectionPublication(
        root,
        projection,
        { requireMissing: true },
      ));
      const boundedProbe = vi.spyOn(db, "hasReplayProjectionState")
        .mockImplementation(() => { throw new Error("non-BuJo replay probe sentinel"); });

      expect(recoverDurableMutationState(root, db, "bujo")).toEqual({ captureReplayed: 0 });
      expect(boundedProbe).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
