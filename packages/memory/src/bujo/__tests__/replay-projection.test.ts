import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/db.js";
import type { MemoryRecord } from "../../store/types.js";
import {
  MAX_REPLAY_PROJECTION_BYTES,
  MAX_REPLAY_PROJECTION_ENTRIES,
  REPLAY_PROJECTION_FILE,
  assertProjectionContainsDelta,
  assertReplayProjectionMatchesDb,
  emptyReplayProjection,
  initializeReplayProjection,
  legacyReplayProjectionFromDb,
  mergeReplayProjection,
  parseReplayProjectionStrict,
  prepareReplayProjectionDelta,
  prepareReplayProjectionPublication,
  publishPreparedReplayProjection,
  readReplayProjectionStrict,
  replayProjectionAuthorityId,
  replayProjectionDbReplacement,
  serializeReplayProjection,
  type ReplayProjectionDelta,
  type ReplayProjectionV1,
} from "../replay-projection.js";

const AUTHORITY = "a".repeat(64);
const OTHER_AUTHORITY = "b".repeat(64);
const OLD_AT = "2026-06-01T00:00:00.000Z";
const REPLACED_AT = "2026-06-02T00:00:00.000Z";
const TERMINAL_AT = "2026-06-03T00:00:00.000Z";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "replay-projection-"));
}

function memory(id: string, status: MemoryRecord["status"], createdAt = OLD_AT): MemoryRecord {
  return {
    id,
    type: "note",
    status,
    text: `private ${id}`,
    salience: 0.5,
    isInsight: false,
    createdAt,
    accessCount: 0,
    tags: [],
    source: {},
  };
}

function thread(src: string, dst: string, weight = 0.5) {
  return { src, dst, weight, at: TERMINAL_AT, authorityKind: "capture" as const, authorityId: AUTHORITY };
}

describe("replay projection sidecar", () => {
  it("distinguishes missing from present-empty, writes mode 0600, and makes a no-op publication identity-stable", () => {
    const root = tempRoot();
    expect(readReplayProjectionStrict(root)).toEqual({
      projection: emptyReplayProjection(),
      state: { kind: "missing" },
    });

    const initialized = initializeReplayProjection(root);
    expect(initialized.state.kind).toBe("present");
    if (initialized.state.kind !== "present") throw new Error("expected present projection");
    expect(initialized.state.identity.mode & 0o777).toBe(0o600);
    const prepared = prepareReplayProjectionDelta(root, {});
    expect(prepared.changed).toBe(false);
    const published = publishPreparedReplayProjection(root, prepared);
    expect(published.state).toEqual(initialized.state);
  });

  it("uses missing as an exact CAS sentinel and never overwrites a raced initialization", () => {
    const root = tempRoot();
    const prepared = prepareReplayProjectionDelta(root, {});
    expect(prepared.prior.state.kind).toBe("missing");
    initializeReplayProjection(root);
    expect(() => publishPreparedReplayProjection(root, prepared)).toThrow(/appeared/iu);
  });

  it("requires canonical bytes, exact keys, bounded schema, and owner-only permissions", () => {
    const canonical = serializeReplayProjection(emptyReplayProjection());
    expect(parseReplayProjectionStrict(canonical)).toEqual(emptyReplayProjection());
    expect(() => parseReplayProjectionStrict(`${JSON.stringify(emptyReplayProjection(), null, 2)}\n`))
      .toThrow(/canonical serialized/iu);
    expect(() => parseReplayProjectionStrict(
      '{"schemaVersion":1,"terminals":[],"supersedes":[],"threads":[],"text":"secret"}\n',
    )).toThrow(/schema/iu);

    const root = tempRoot();
    initializeReplayProjection(root);
    chmodSync(join(root, REPLAY_PROJECTION_FILE), 0o644);
    expect(() => readReplayProjectionStrict(root)).toThrow(/0600|owner-only/iu);
  });

  it("rejects adversarial authority, timestamp, topology, duplicate, and byte-bound inputs", () => {
    const valid = {
      schemaVersion: 1,
      terminals: [],
      supersedes: [],
      threads: [thread("a", "b")],
    } as const;
    const raw = (projection: unknown): string => `${JSON.stringify(projection)}\n`;
    const mutateThread = (changes: Record<string, unknown>): unknown => ({
      ...valid,
      threads: [{ ...valid.threads[0], ...changes }],
    });
    expect(() => parseReplayProjectionStrict(raw(mutateThread({ authorityKind: "operator" }))))
      .toThrow(/authority kind/iu);
    expect(() => parseReplayProjectionStrict(raw(mutateThread({ authorityId: "f".repeat(63) }))))
      .toThrow(/64 hexadecimal/iu);
    expect(() => parseReplayProjectionStrict(raw(mutateThread({ at: "2026-06-03T00:00:00Z" }))))
      .toThrow(/timestamp/iu);
    expect(() => parseReplayProjectionStrict(raw(mutateThread({ dst: "a" }))))
      .toThrow(/thread topology/iu);
    expect(() => parseReplayProjectionStrict(raw(mutateThread({ weight: 0 }))))
      .toThrow(/thread topology or weight/iu);
    expect(() => parseReplayProjectionStrict(
      '{"schemaVersion":1,"schemaVersion":1,"terminals":[],"supersedes":[],"threads":[]}\n',
    )).toThrow(/canonical serialized/iu);
    expect(() => parseReplayProjectionStrict(raw({ ...valid, threads: [valid.threads[0], valid.threads[0]] })))
      .toThrow(/unique/iu);
    expect(() => parseReplayProjectionStrict("x".repeat(MAX_REPLAY_PROJECTION_BYTES + 1)))
      .toThrow(/32 MiB/iu);
  });

  it("rejects symlinked and multiply-linked sidecars", () => {
    const canonical = serializeReplayProjection(emptyReplayProjection());
    const outside = join(tempRoot(), "outside.json");
    writeFileSync(outside, canonical, { mode: 0o600 });

    const symlinkRoot = tempRoot();
    symlinkSync(outside, join(symlinkRoot, REPLAY_PROJECTION_FILE));
    expect(() => readReplayProjectionStrict(symlinkRoot)).toThrow(/symlink|regular/iu);

    const hardlinkRoot = tempRoot();
    linkSync(outside, join(hardlinkRoot, REPLAY_PROJECTION_FILE));
    expect(() => readReplayProjectionStrict(hardlinkRoot)).toThrow(/single-link/iu);
  });

  it("sorts deterministically, merges exact deltas idempotently, and rejects conflicts", () => {
    const delta: ReplayProjectionDelta = {
      threads: [thread("z", "b"), thread("a", "b")],
    };
    const once = mergeReplayProjection(emptyReplayProjection(), delta);
    const twice = mergeReplayProjection(once, delta);
    expect(twice).toEqual(once);
    expect(once.threads.map((entry) => entry.src)).toEqual(["a", "z"]);
    assertProjectionContainsDelta(once, delta);
    expect(() => mergeReplayProjection(once, {
      threads: [{ ...thread("a", "b"), authorityId: OTHER_AUTHORITY }],
    })).toThrow(/conflicting thread authority/iu);
  });

  it("enforces supersede topology and five threads per source while allowing a later terminal destination", () => {
    const base = mergeReplayProjection(emptyReplayProjection(), {
      terminals: [{
        id: "b",
        at: TERMINAL_AT,
        authorityKind: "migration",
        authorityId: OTHER_AUTHORITY,
      }],
      supersedes: [{
        src: "a",
        dst: "b",
        at: REPLACED_AT,
        authorityKind: "capture",
        authorityId: AUTHORITY,
      }],
    });
    expect(base.terminals).toHaveLength(1);
    expect(base.supersedes).toHaveLength(1);

    expect(() => mergeReplayProjection(emptyReplayProjection(), {
      supersedes: [
        { src: "a", dst: "b", at: REPLACED_AT, authorityKind: "capture", authorityId: AUTHORITY },
        { src: "c", dst: "b", at: TERMINAL_AT, authorityKind: "capture", authorityId: OTHER_AUTHORITY },
      ],
    })).toThrow(/duplicate supersede destination/iu);
    expect(() => mergeReplayProjection(emptyReplayProjection(), {
      supersedes: [
        { src: "a", dst: "b", at: REPLACED_AT, authorityKind: "capture", authorityId: AUTHORITY },
        { src: "b", dst: "a", at: TERMINAL_AT, authorityKind: "capture", authorityId: OTHER_AUTHORITY },
      ],
    })).toThrow(/cycle/iu);
    expect(() => mergeReplayProjection(emptyReplayProjection(), {
      threads: Array.from({ length: 6 }, (_, index) => thread("a", `dst-${index}`)),
    })).toThrow(/exceeds five/iu);
    expect(() => mergeReplayProjection(emptyReplayProjection(), {
      terminals: Array.from({ length: MAX_REPLAY_PROJECTION_ENTRIES + 1 }, () => ({
        id: "same",
        at: TERMINAL_AT,
        authorityKind: "migration" as const,
        authorityId: AUTHORITY,
      })),
    })).toThrow(/131072 entries/iu);
  });

  it("hashes authority input independent of object key order", () => {
    expect(replayProjectionAuthorityId({ kind: "capture", id: "x", nested: { b: 2, a: 1 } }))
      .toBe(replayProjectionAuthorityId({ nested: { a: 1, b: 2 }, id: "x", kind: "capture" }));
    expect(() => replayProjectionAuthorityId({ bad: undefined })).toThrow(/JSON values/iu);
  });

  it("asserts exact DB lifecycle/edges and provides explicit missing-only legacy adoption", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("a", "invalidated"));
    db.upsertLexical(memory("b", "dropped", REPLACED_AT));
    db.upsertLexical(memory("c", "open", OLD_AT));
    const projection: ReplayProjectionV1 = {
      schemaVersion: 1,
      terminals: [{ id: "b", at: TERMINAL_AT, authorityKind: "migration", authorityId: OTHER_AUTHORITY }],
      supersedes: [{
        src: "a",
        dst: "b",
        at: REPLACED_AT,
        authorityKind: "capture",
        authorityId: AUTHORITY,
      }],
      threads: [thread("b", "c")],
    };
    db.replaceReplayProjection(replayProjectionDbReplacement(projection));
    expect(() => assertReplayProjectionMatchesDb(db, projection)).not.toThrow();

    const adopted = legacyReplayProjectionFromDb(db, "C".repeat(64));
    expect(adopted.terminals[0]?.authorityKind).toBe("legacy-adoption");
    expect(adopted.terminals[0]?.authorityId).toBe("c".repeat(64));
    const prepared = prepareReplayProjectionPublication(root, adopted, { requireMissing: true });
    publishPreparedReplayProjection(root, prepared);
    expect(readFileSync(join(root, REPLAY_PROJECTION_FILE), "utf8")).toBe(serializeReplayProjection(adopted));
    expect(() => prepareReplayProjectionPublication(root, adopted, { requireMissing: true }))
      .toThrow(/requires a missing sidecar/iu);

    db.addEdge("c", "a", "thread", 0.4, TERMINAL_AT);
    expect(() => assertReplayProjectionMatchesDb(db, projection)).toThrow(/DB thread mismatch/iu);
    expect(() => legacyReplayProjectionFromDb(db, AUTHORITY)).not.toThrow();
    db.addEdge("a", "entity:x", "about", 1, TERMINAL_AT);
    // Canonical graph projection, not replay authority, owns about/supports.
    expect(() => legacyReplayProjectionFromDb(db, AUTHORITY)).not.toThrow();
    db.close();
  });
});
