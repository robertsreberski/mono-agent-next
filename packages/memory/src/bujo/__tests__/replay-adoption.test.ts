import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { replayCaptureOutbox, writeCaptureIntent } from "../capture-outbox.js";
import { appendGraphBatch } from "../graph.js";
import {
  acquireMemoryWriterLease,
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
} from "../generations.js";
import { serializeBullet } from "../grammar.js";
import { migrate } from "../migrate.js";
import {
  REPLAY_PROJECTION_FILE,
  initializeReplayProjection,
  readReplayProjectionStrict,
  replayProjectionAuthorityId,
} from "../replay-projection.js";
import {
  adoptLegacyReplayProjection,
  adoptLegacyReplayProjectionWithHooks,
} from "../replay-adoption.js";
import {
  assertLegacyReplayAdoptionBaseParity,
  assertCanonicalGraphRepairBaseParity,
  safeRebuildMemoryIndex,
} from "../rebuild.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const OLD_AT = "2026-07-12T08:00:00.000Z";
const TARGET_AT = "2026-07-12T08:30:00.000Z";
const NEW_AT = "2026-07-12T09:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit legacy replay adoption", () => {
  it("binds one exact managed BuJo projection, retires rollback, and returns metadata only", async () => {
    const fixture = await managedFixture({ replay: true, rollback: true });
    const before = openMemoryDb({ path: fixture.active, readOnly: true, dim: 4 });
    let expectedAuthority: string;
    try {
      const base = assertLegacyReplayAdoptionBaseParity(fixture.root, before);
      expectedAuthority = replayProjectionAuthorityId({
        schemaVersion: 1,
        kind: "legacy-adoption",
        sourceFingerprint: base.sourceFingerprint,
        logicalIntegrityDigest: before.logicalIntegrityDigest(),
        pendingCaptureCommitment: null,
        pendingMigrationCommitment: null,
      });
    } finally {
      before.close();
    }

    const result = adoptLegacyReplayProjection(adoptionOptions(fixture.root));

    expect(result).toEqual({
      backend: "bujo",
      mode: "bujo",
      status: "adopted",
      counts: { terminals: 0, supersedes: 1, threads: 1 },
      authorityDigest: expectedAuthority,
      rebuildRequired: true,
    });
    expect(Object.keys(result).sort()).toEqual([
      "authorityDigest",
      "backend",
      "counts",
      "mode",
      "rebuildRequired",
      "status",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/OLD|NEW|TARGET|memory\.db|daily|private/iu);
    expect(readManagedIndexManifest(fixture.root)?.rollback).toBeUndefined();

    const adopted = readReplayProjectionStrict(fixture.root);
    expect(adopted.state.kind).toBe("present");
    expect(adopted.projection).toMatchObject({
      terminals: [],
      supersedes: [{ authorityKind: "legacy-adoption", authorityId: expectedAuthority }],
      threads: [{ authorityKind: "legacy-adoption", authorityId: expectedAuthority, weight: 0.75 }],
    });
    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/already exists|refusing to overwrite/iu);
  });

  it("preserves an exact Journal rollback while adopting replay into the active BuJo generation", async () => {
    const root = tempRoot();
    writeDaily(root, [
      bullet("OLD", "invalidated", OLD_AT),
      bullet("TARGET", "open", TARGET_AT),
      bullet("NEW", "open", NEW_AT),
    ]);
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
    initializeReplayProjection(root);
    const bujo = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const rollbackBefore = readManagedIndexManifest(root)?.rollback;
    expect(rollbackBefore?.tier).toBe("journal");
    unlinkSync(join(root, REPLAY_PROJECTION_FILE));
    const active = openMemoryDb({ path: bujo.active, dim: 4 });
    try {
      active.markSuperseded("OLD", "NEW", NEW_AT);
      active.addEdge("NEW", "TARGET", "thread", 0.75, NEW_AT);
      active.checkpoint();
    } finally {
      active.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(root))).not.toThrow();
    expect(readManagedIndexManifest(root)?.rollback).toEqual(rollbackBefore);
  });

  it("rejects a missing unmanaged database and non-BuJo managed identities without creating an authority", async () => {
    const unmanaged = tempRoot();
    expect(() => adoptLegacyReplayProjection(adoptionOptions(unmanaged)))
      .toThrow(/stopped BuJo memory database/iu);
    expect(readReplayProjectionStrict(unmanaged).state.kind).toBe("missing");

    const lite = tempRoot();
    writeDaily(lite, [bullet("LITE", "open", OLD_AT)]);
    await safeRebuildMemoryIndex({ root: lite, tier: "lite" });
    expect(() => adoptLegacyReplayProjection(adoptionOptions(lite)))
      .toThrow(/managed active.*not BuJo/iu);
    expect(readReplayProjectionStrict(lite).state.kind).toBe("missing");
  });

  it("requires the exact configured semantic identity before opening the active generation", async () => {
    const fixture = await managedFixture({ replay: true });
    expect(() => adoptLegacyReplayProjection({
      ...adoptionOptions(fixture.root),
      embeddingModel: "fake-wrong",
    })).toThrow(/configured semantic identity does not match/iu);
    expect(() => adoptLegacyReplayProjection({
      ...adoptionOptions(fixture.root),
      dimension: 8,
    })).toThrow(/configured semantic identity does not match/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("adopts an exact unmanaged BuJo database and retains it as the first managed rollback", async () => {
    const fixture = await unmanagedFixture({ replay: true });
    expect(readManagedIndexManifest(fixture.root)).toBeUndefined();

    expect(adoptLegacyReplayProjection(adoptionOptions(fixture.root))).toMatchObject({
      status: "adopted",
      counts: { supersedes: 1, threads: 1 },
    });
    expect(readManagedIndexManifest(fixture.root)).toBeUndefined();

    const rebuilt = await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    expect(rebuilt.rollback).toBeDefined();
    expect(readManagedIndexManifest(fixture.root)?.rollback).toMatchObject({
      tier: "bujo",
      origin: "legacy-snapshot",
    });
    expect(existsSync(join(fixture.root, "memory.db"))).toBe(true);
  });

  it("recovers an adopted unmanaged pending capture against BuJo before a cross-tier rebuild", async () => {
    const fixture = await unmanagedFixture({ replay: false });
    const added = {
      ...bullet("PENDING-CROSS-TIER", "open", NEW_AT),
      text: "Pending unmanaged capture is rebuilt into Journal.",
    };
    writeCaptureIntent(fixture.root, [{
      candidateIndex: 0,
      kind: "add",
      id: added.id,
      after: { file: "daily/2026-07-12.md", bullet: added },
      record: memoryRecord(added),
      vector: [1, 0, 0, 0],
      threads: [],
    }], {}, NEW_AT);

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root))).not.toThrow();
    const rebuilt = await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "journal",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(current.allMemories().some((record) => record.text === added.text)).toBe(true);
      expect(current.indexMetadata()?.tier).toBe("journal");
    } finally {
      current.close();
    }
  });

  it("adopts a completed capture receipt beside a pending cluster migration and rebuilds both provider-free", async () => {
    const root = tempRoot();
    const createdAt = "2026-05-01T08:00:00.000Z";
    const migrationNow = new Date("2026-07-12T12:00:00.000Z");
    const aging = {
      ...bullet("MIGRATE-ADOPTION", "open", createdAt),
      text: "Pending cluster migration adoption sentinel.",
      salience: 0.2,
    };
    writeDaily(root, [aging]);
    const provider = fakeEmbeddings(4);
    const initial = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const db = openMemoryDb({ path: initial.active, embeddings: provider, dim: 4 });
    const receipt = writeCaptureIntent(root, [], {}, NEW_AT, { retentionKey: "f".repeat(64) });
    try {
      replayCaptureOutbox(root, db, { canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity });
      expect((JSON.parse(readFileSync(join(root, receipt.file), "utf8")) as { state: string }).state)
        .toBe("complete");
      await expect(migrate({
        root,
        db,
        llm: fakeLlm([[aging.text, JSON.stringify({ action: "cluster", collection: "adopted" })]]),
        now: () => migrationNow,
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
        hooks: { afterDecisionDurable: () => { throw new Error("crash-after-paid-cluster"); } },
      })).rejects.toThrow("crash-after-paid-cluster");
      db.checkpoint();
    } finally {
      db.close();
    }
    unlinkSync(join(root, REPLAY_PROJECTION_FILE));

    expect(() => adoptLegacyReplayProjection(adoptionOptions(root))).not.toThrow();
    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 4,
    });
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(current.get(aging.id)).toMatchObject({ status: "migrated", collection: "adopted" });
      expect(current.getEntity("collection:adopted")?.name).toBe("adopted");
    } finally {
      current.close();
    }
    expect(readFileSync(join(root, "monthly", "2026-07.md"), "utf8")).not.toContain("mono-agent-migrate:");
    expect((JSON.parse(readFileSync(join(root, receipt.file), "utf8")) as { state: string }).state)
      .toBe("complete");
  });

  it("adopts a stopped unmanaged WAL family without requiring checkpoint collapse", async () => {
    const fixture = await unmanagedFixture({ replay: true });
    const reader = new BetterSqlite3(fixture.active);
    try {
      reader.pragma("journal_mode = WAL");
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM memories").get();
      const writer = new BetterSqlite3(fixture.active);
      try {
        writer.prepare("UPDATE memories SET access_count = access_count + 1 WHERE id = 'TARGET'").run();
      } finally {
        writer.close();
      }
      for (const suffix of ["-wal", "-shm"]) {
        expect(existsSync(`${fixture.active}${suffix}`)).toBe(true);
        chmodSync(`${fixture.active}${suffix}`, 0o600);
      }

      expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root))).not.toThrow();
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  });

  it.each(["mode", "hardlink", "symlink-sidecar"] as const)(
    "rejects an unsafe unmanaged SQLite family: %s",
    async (scenario) => {
      const fixture = await unmanagedFixture({ replay: true });
      if (scenario === "mode") chmodSync(fixture.active, 0o644);
      if (scenario === "hardlink") linkSync(fixture.active, join(fixture.root, "memory-copy.db"));
      if (scenario === "symlink-sidecar") symlinkSync(fixture.active, `${fixture.active}-wal`);

      expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
        .toThrow(/regular file|owner-only mode 0600/iu);
      expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
    },
  );

  it("rejects unmanaged database replacement while its SQLite fence is held", async () => {
    const fixture = await unmanagedFixture({ replay: true });
    const backup = join(fixture.root, "memory-original.db");
    expect(() => adoptLegacyReplayProjectionWithHooks(adoptionOptions(fixture.root), {
      beforePublication: () => {
        renameSync(fixture.active, backup);
        copyFileSync(backup, fixture.active);
        chmodSync(fixture.active, 0o600);
      },
    })).toThrow(/replaced concurrently|SQLite family changed/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("refuses an unsafe replay-sidecar temp instead of cleaning it during adoption", async () => {
    const fixture = await managedFixture({ replay: true });
    const temporary = join(
      fixture.root,
      "..replay-projection-v1.json-00000000-0000-4000-8000-000000000004.tmp",
    );
    writeFileSync(temporary, "partial", { mode: 0o644 });
    chmodSync(temporary, 0o644);

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/temporary.*owner-only/iu);
    expect(existsSync(temporary)).toBe(true);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("rejects an empty legacy projection and directs fresh roots to safe rebuild", async () => {
    const fixture = await managedFixture({ replay: false });

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/no legacy replay state.*safe rebuild/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("fails closed for an active writer and adopts an exact pending durable capture intent", async () => {
    const writerFixture = await managedFixture({ replay: false });
    const competing = acquireMemoryWriterLease(writerFixture.root);
    try {
      expect(() => adoptLegacyReplayProjection(adoptionOptions(writerFixture.root)))
        .toThrow(/active memory writer|owns this root/iu);
    } finally {
      competing.release();
    }
    expect(readReplayProjectionStrict(writerFixture.root).state.kind).toBe("missing");

    const pendingFixture = await managedFixture({ replay: false });
    writeCaptureIntent(pendingFixture.root, [], {}, NEW_AT);
    expect(adoptLegacyReplayProjection(adoptionOptions(pendingFixture.root))).toMatchObject({
      status: "adopted",
      counts: { terminals: 0, supersedes: 0, threads: 0 },
    });
    expect(readReplayProjectionStrict(pendingFixture.root).state.kind).toBe("present");
  });

  it("requires every completed capture receipt replay delta to be present in SQLite", async () => {
    const fixture = await managedFixture({ replay: false });
    const source = bullet("NEW", "open", NEW_AT);
    const target = bullet("TARGET", "open", TARGET_AT);
    const handle = writeCaptureIntent(fixture.root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file: "daily/2026-07-12.md", bullet: source },
      record: memoryRecord(source),
      vector: [1, 0, 0, 0],
      threads: [{ src: source.id, dst: target.id, weight: 0.75 }],
    }], {}, NEW_AT, { retentionKey: "c".repeat(64) });
    markCaptureIntentComplete(fixture.root, handle.file);

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/does not contain exact thread delta/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("adopts and rebuilds a valid retained completed capture receipt without reapplying actions", async () => {
    const fixture = await managedFixture({ replay: false });
    const source = bullet("NEW", "open", NEW_AT);
    const target = bullet("TARGET", "open", TARGET_AT);
    const handle = writeCaptureIntent(fixture.root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file: "daily/2026-07-12.md", bullet: source },
      record: memoryRecord(source),
      vector: [1, 0, 0, 0],
      threads: [{ src: source.id, dst: target.id, weight: 0.75 }],
    }], {}, NEW_AT, { retentionKey: "d".repeat(64) });
    markCaptureIntentComplete(fixture.root, handle.file);
    const legacy = openMemoryDb({ path: fixture.active, dim: 4 });
    try {
      legacy.addEdge(source.id, target.id, "thread", 0.75, NEW_AT);
      legacy.checkpoint();
    } finally {
      legacy.close();
    }

    expect(adoptLegacyReplayProjection(adoptionOptions(fixture.root)).counts.threads).toBe(1);
    const rebuilt = await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(current.allEdges()).toContainEqual({
        src: source.id,
        dst: target.id,
        kind: "thread",
        weight: 0.75,
        createdAt: NEW_AT,
      });
      expect(current.get(source.id)?.text).toBe(source.text);
    } finally {
      current.close();
    }
    expect((JSON.parse(readFileSync(join(fixture.root, handle.file), "utf8")) as { state: string }).state)
      .toBe("complete");
  });

  it("normalizes only an old completed receipt's omitted thread timestamp after adoption", async () => {
    const fixture = await managedFixture({ replay: false });
    const source = bullet("NEW", "open", NEW_AT);
    const target = bullet("TARGET", "open", TARGET_AT);
    const handle = writeCaptureIntent(fixture.root, [{
      candidateIndex: 0,
      kind: "add",
      id: source.id,
      after: { file: "daily/2026-07-12.md", bullet: source },
      record: memoryRecord(source),
      vector: [1, 0, 0, 0],
      threads: [{ src: source.id, dst: target.id, weight: 0.75 }],
    }], {}, NEW_AT, { retentionKey: "1".repeat(64) });
    const path = join(fixture.root, handle.file);
    const intent = JSON.parse(readFileSync(path, "utf8")) as {
      state: string;
      actions: Array<{ threads?: Array<{ createdAt?: string }> }>;
    };
    intent.state = "complete";
    delete intent.actions[0]?.threads?.[0]?.createdAt;
    writeFileSync(path, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    const legacyAt = "2026-07-12T10:00:00.000Z";
    const legacy = openMemoryDb({ path: fixture.active, dim: 4 });
    try {
      legacy.addEdge(source.id, target.id, "thread", 0.75, legacyAt);
      legacy.checkpoint();
    } finally {
      legacy.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root))).not.toThrow();
    const rebuilt = await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(current.allEdges()).toContainEqual({
        src: source.id,
        dst: target.id,
        kind: "thread",
        weight: 0.75,
        createdAt: NEW_AT,
      });
      expect(current.allEdges()).not.toContainEqual(expect.objectContaining({ createdAt: legacyAt }));
    } finally {
      current.close();
    }
  });

  it("publishes only DB-present replay from a mixed before/after multi-intent capture queue", async () => {
    const fixture = await managedFixture({ replay: false });
    const target = bullet("TARGET", "open", TARGET_AT);
    const applied = { ...bullet("MIXED-APPLIED", "open", NEW_AT), text: "Already applied pending intent." };
    const future = { ...bullet("MIXED-FUTURE", "open", NEW_AT), text: "Still-before pending intent." };
    for (const [index, item] of [applied, future].entries()) {
      writeCaptureIntent(fixture.root, [{
        candidateIndex: index,
        kind: "add",
        id: item.id,
        after: { file: "daily/2026-07-12.md", bullet: item },
        record: memoryRecord(item),
        vector: index === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0],
        threads: [{ src: item.id, dst: target.id, weight: 0.75 }],
      }], {}, NEW_AT);
    }
    appendFileSync(
      join(fixture.root, "daily", "2026-07-12.md"),
      `${serializeBullet(applied)}\n`,
    );
    const prior = openMemoryDb({ path: fixture.active, embeddings: fakeEmbeddings(4), dim: 4 });
    try {
      prior.commitPreparedUpserts([memoryRecord(applied)], [[1, 0, 0, 0]]);
      prior.addEdge(applied.id, target.id, "thread", 0.75, NEW_AT);
      prior.checkpoint();
    } finally {
      prior.close();
    }

    expect(adoptLegacyReplayProjection(adoptionOptions(fixture.root)).counts.threads).toBe(1);
    expect(readReplayProjectionStrict(fixture.root).projection.threads.map((thread) => thread.src))
      .toEqual([applied.id]);

    const rebuilt = await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    const current = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(current.get(applied.id)?.text).toBe(applied.text);
      expect(current.get(future.id)?.text).toBe(future.text);
      expect(current.allEdges().filter((edge) => edge.kind === "thread").map((edge) => edge.src).sort())
        .toEqual([applied.id, future.id].sort());
    } finally {
      current.close();
    }
  });

  it("does not let a completed empty-delta receipt hide canonical/SQLite corruption", async () => {
    const fixture = await managedFixture({ replay: false });
    const item = bullet("TARGET", "open", TARGET_AT);
    const handle = writeCaptureIntent(fixture.root, [{
      candidateIndex: 0,
      kind: "noop",
      id: item.id,
      expected: { file: "daily/2026-07-12.md", bullet: item },
    }], {}, NEW_AT, { retentionKey: "e".repeat(64) });
    markCaptureIntentComplete(fixture.root, handle.file);
    const raw = new BetterSqlite3(fixture.active);
    try {
      raw.prepare("UPDATE memories SET text = 'corrupt' WHERE id = 'TARGET'").run();
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/base parity failed.*(?:memory\/FTS coverage|memory payload)/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("refuses a pre-existing raw SQLite writer before inspecting legacy state", async () => {
    const fixture = await managedFixture({ replay: true });
    const writer = new BetterSqlite3(fixture.active);
    writer.exec("BEGIN IMMEDIATE");
    try {
      expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
        .toThrow(/active SQLite writer owns/iu);
      expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("rejects malformed legacy lifecycle without blessing any projection", async () => {
    const fixture = await managedFixture({ replay: false });
    const raw = new BetterSqlite3(fixture.active);
    try {
      raw.prepare(
        "UPDATE memories SET valid_to = ?, superseded_by = ?, superseded_at = NULL WHERE id = 'OLD'",
      ).run(NEW_AT, "NEW");
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/partial legacy lifecycle/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("detects canonical, SQLite, and missing-sidecar publication races without overwrite", async () => {
    const canonical = await managedFixture({ replay: true });
    expect(() => adoptLegacyReplayProjectionWithHooks(
      adoptionOptions(canonical.root),
      {
        beforePublication: () => appendFileSync(join(canonical.root, "daily", "2026-07-12.md"), "\n"),
      },
    )).toThrow(/canonical base changed/iu);
    expect(readReplayProjectionStrict(canonical.root).state.kind).toBe("missing");

    const sqlite = await managedFixture({ replay: true });
    expect(() => adoptLegacyReplayProjectionWithHooks(
      adoptionOptions(sqlite.root),
      {
        beforePublication: () => {
          const raw = new BetterSqlite3(sqlite.active);
          try {
            raw.pragma("busy_timeout = 0");
            raw.prepare("UPDATE memories SET access_count = access_count + 1 WHERE id = 'TARGET'").run();
          } finally {
            raw.close();
          }
        },
      },
    )).toThrow(/locked|busy/iu);
    expect(readReplayProjectionStrict(sqlite.root).state.kind).toBe("missing");

    const sidecar = await managedFixture({ replay: true });
    expect(() => adoptLegacyReplayProjectionWithHooks(
      adoptionOptions(sidecar.root),
      { beforePublication: () => { initializeReplayProjection(sidecar.root); } },
    )).toThrow(/canonical base changed|appeared|missing sidecar/iu);
    const raced = readReplayProjectionStrict(sidecar.root);
    expect(raced.state.kind).toBe("present");
    expect(raced.projection).toEqual({ schemaVersion: 1, terminals: [], supersedes: [], threads: [] });
  });

  it("re-pins a pending capture commitment after sidecar publication", async () => {
    const fixture = await managedFixture({ replay: false });
    const handle = writeCaptureIntent(fixture.root, [], {}, NEW_AT);

    expect(() => adoptLegacyReplayProjectionWithHooks(
      adoptionOptions(fixture.root),
      { afterPublication: () => unlinkSync(join(fixture.root, handle.file)) },
    )).toThrow(/capture protocol.*during publication|adoption preview changed/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("present");
  });

  it("includes custom daily Markdown names in the adoption base fingerprint fence", async () => {
    const fixture = await managedFixture({ replay: true, customDaily: true });

    expect(() => adoptLegacyReplayProjectionWithHooks(
      adoptionOptions(fixture.root),
      {
        beforePublication: () => appendFileSync(join(fixture.root, "daily", "custom-notes.md"), "changed\n"),
      },
    )).toThrow(/canonical base changed/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("accepts supported SQLite-only live state while preserving canonical-field checks", async () => {
    const fixture = await managedFixture({ replay: true });
    const db = new BetterSqlite3(fixture.active);
    try {
      db.prepare(
        `UPDATE memories
         SET access_count = ?, last_accessed_at = ?, valid_from = ?, tags = ?, collection = ?,
             source_line = ?, source_session = ?
         WHERE id = ?`,
      ).run(
        7,
        "2026-07-12T10:30:00.000Z",
        "2026-07-01T00:00:00.000Z",
        JSON.stringify(["live-only"]),
        "derived-live-cache",
        999,
        "live-session",
        "TARGET",
      );
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root))).not.toThrow();
  });

  it("accepts an exact derived legacy association with a valid non-normalized timestamp", async () => {
    const root = tempRoot();
    const nonNormalized = "2026-07-12T08:30:00+00:00";
    writeDaily(root, [bullet("LEGACY-TIMESTAMP", "open", nonNormalized)]);
    appendGraphBatch(root, {
      entities: [{ id: "person:private", name: "Private", type: "person", createdAt: OLD_AT }],
    });
    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    const db = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(db.allMemoryAssociations()).toContainEqual({
        memoryId: "LEGACY-TIMESTAMP",
        entityId: "person:private",
        provenance: "legacy-name-match",
        createdAt: nonNormalized,
      });
    } finally {
      db.close();
    }
    unlinkSync(join(root, REPLAY_PROJECTION_FILE));
    writeCaptureIntent(root, [], {}, NEW_AT);

    expect(() => adoptLegacyReplayProjection(adoptionOptions(root))).not.toThrow();
  });

  it("repairs legacy association drift alongside canonical non-normalized timestamps", async () => {
    const root = tempRoot();
    const nonNormalized = "2026-07-12T08:30:00+00:00";
    writeDaily(root, [
      bullet("LEGACY-TIMESTAMP", "open", nonNormalized),
      bullet("LEGACY-DRIFT", "open", NEW_AT),
    ]);
    appendGraphBatch(root, {
      entities: [{ id: "person:private", name: "Private", type: "person", createdAt: OLD_AT }],
    });
    const provider = fakeEmbeddings(4);
    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 4,
    });
    unlinkSync(join(root, REPLAY_PROJECTION_FILE));
    const db = openMemoryDb({ path: rebuilt.active, dim: 4 });
    try {
      const raw = new BetterSqlite3(rebuilt.active);
      try {
        raw.prepare(
          "DELETE FROM memory_entities WHERE memory_id = ? AND entity_id = ? AND provenance = 'legacy-name-match'",
        ).run("LEGACY-DRIFT", "person:private");
      } finally {
        raw.close();
      }
      db.addEdge("LEGACY-DRIFT", "LEGACY-TIMESTAMP", "thread", 0.75, NEW_AT);
      db.checkpoint();
    } finally {
      db.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(root))).not.toThrow();
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const normalized = openMemoryDb({ path: resolveActiveMemoryDbPath(root), readOnly: true, dim: 4 });
    try {
      expect(normalized.allMemoryAssociations()).toEqual(expect.arrayContaining([
        {
          memoryId: "LEGACY-TIMESTAMP",
          entityId: "person:private",
          provenance: "legacy-name-match",
          createdAt: nonNormalized,
        },
        {
          memoryId: "LEGACY-DRIFT",
          entityId: "person:private",
          provenance: "legacy-name-match",
          createdAt: NEW_AT,
        },
      ]));
    } finally {
      normalized.close();
    }
  });

  it("rejects non-normalized legacy timestamps that do not preserve the canonical memory spelling", async () => {
    const fixture = await managedFixture({ replay: true, graph: true });
    const raw = new BetterSqlite3(fixture.active);
    try {
      raw.prepare(
        `UPDATE memory_entities
         SET created_at = ?
         WHERE memory_id = ? AND entity_id = ? AND provenance = 'legacy-name-match'`,
      ).run("2026-07-12T08:30:00+00:00", "TARGET", "person:private");
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/base parity failed.*graph payload validation/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("still rejects canonical memory-field drift when live-state tolerance is enabled", async () => {
    const fixture = await managedFixture({ replay: true });
    const db = new BetterSqlite3(fixture.active);
    try {
      const drift = "Canonical text drift must remain fatal.";
      db.prepare("UPDATE memories SET text = ? WHERE id = ?").run(drift, "TARGET");
      db.prepare("DELETE FROM memories_fts WHERE id = ?").run("TARGET");
      db.prepare("INSERT INTO memories_fts (id, text) VALUES (?, ?)").run("TARGET", drift);
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/base parity failed.*memory payload validation/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });

  it("admits only repairable legacy association/about drift and the mandatory rebuild normalizes it", async () => {
    const fixture = await managedFixture({ replay: true, graph: true });
    const db = openMemoryDb({ path: fixture.active, dim: 4 });
    try {
      const raw = new BetterSqlite3(fixture.active);
      try {
        raw.prepare(
          "DELETE FROM memory_entities WHERE memory_id = ? AND entity_id = ? AND provenance = 'legacy-name-match'",
        ).run("TARGET", "person:private");
      } finally {
        raw.close();
      }
      db.addEdge("TARGET", "person:private", "about", 0.8, TARGET_AT);
      db.checkpoint();
    } finally {
      db.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root))).not.toThrow();
    const rebuilt = await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fakeEmbeddings(4),
      dim: 4,
    });
    const normalized = openMemoryDb({ path: rebuilt.active, readOnly: true, dim: 4 });
    try {
      expect(normalized.allEdges().some((edge) => edge.kind === "about")).toBe(false);
      expect(normalized.allMemoryAssociations()).toContainEqual({
        memoryId: "TARGET",
        entityId: "person:private",
        provenance: "legacy-name-match",
        createdAt: TARGET_AT,
      });
    } finally {
      normalized.close();
    }
  });

  it.each([
    {
      label: "unknown entity",
      mutate: (db: ReturnType<typeof openMemoryDb>) => {
        db.mirrorCanonicalEntity({ id: "person:unknown", name: "Unknown", type: "person", createdAt: OLD_AT });
      },
    },
    {
      label: "relation drift",
      mutate: (db: ReturnType<typeof openMemoryDb>) => {
        db.mirrorCanonicalRelation({
          src: "person:private",
          dst: "concept:sentinel",
          relation: "mentions",
          createdAt: OLD_AT,
        });
      },
    },
    {
      label: "capture association drift",
      mutate: (db: ReturnType<typeof openMemoryDb>) => {
        db.mirrorCanonicalAssociation({
          memoryId: "TARGET",
          entityId: "person:private",
          provenance: "capture",
          createdAt: TARGET_AT,
        });
      },
    },
    {
      label: "orphan graph edge",
      mutate: (db: ReturnType<typeof openMemoryDb>) => {
        db.addEdge("TARGET", "person:missing", "about", 0.8, TARGET_AT);
      },
    },
  ])("rejects $label instead of blessing it as deterministic graph repair", async ({ mutate }) => {
    const fixture = await managedFixture({ replay: true, graph: true });
    const db = openMemoryDb({ path: fixture.active, dim: 4 });
    try {
      mutate(db);
      db.checkpoint();
    } finally {
      db.close();
    }

    expect(() => adoptLegacyReplayProjection(adoptionOptions(fixture.root)))
      .toThrow(/base parity failed/iu);
    expect(readReplayProjectionStrict(fixture.root).state.kind).toBe("missing");
  });
});

async function managedFixture(options: {
  readonly replay: boolean;
  readonly rollback?: boolean;
  readonly graph?: boolean;
  readonly customDaily?: boolean;
}): Promise<{ readonly root: string; readonly active: string }> {
  const root = tempRoot();
  writeDaily(root, [
    bullet("OLD", "invalidated", OLD_AT),
    bullet("TARGET", "open", TARGET_AT),
    bullet("NEW", "open", NEW_AT),
  ]);
  if (options.customDaily === true) {
    writeFileSync(join(root, "daily", "custom-notes.md"), "# Custom notes\n", { mode: 0o600 });
  }
  if (options.graph === true) {
    appendGraphBatch(root, {
      entities: [
        { id: "person:private", name: "Private", type: "person", createdAt: OLD_AT },
        { id: "concept:sentinel", name: "sentinel", type: "concept", createdAt: OLD_AT },
      ],
    });
  }
  const provider = fakeEmbeddings(4);
  await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
  if (options.rollback === true) {
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
  }
  unlinkSync(join(root, REPLAY_PROJECTION_FILE));
  const active = resolveActiveMemoryDbPath(root);
  if (options.replay) {
    const db = openMemoryDb({ path: active, dim: 4 });
    try {
      db.markSuperseded("OLD", "NEW", NEW_AT);
      db.addEdge("NEW", "TARGET", "thread", 0.75, NEW_AT);
      db.checkpoint();
    } finally {
      db.close();
    }
  }
  return { root, active };
}

async function unmanagedFixture(options: {
  readonly replay: boolean;
}): Promise<{ readonly root: string; readonly active: string }> {
  const fixture = await managedFixture({ replay: options.replay });
  const active = join(fixture.root, "memory.db");
  copyFileSync(fixture.active, active);
  chmodSync(active, 0o600);
  rmSync(join(fixture.root, ".index"), { recursive: true, force: true });
  return { root: fixture.root, active };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-replay-adoption-"));
  roots.push(root);
  return root;
}

function adoptionOptions(root: string) {
  return {
    root,
    mode: "bujo" as const,
    embeddingModel: "fake-4",
    dimension: 4,
  };
}

function writeDaily(root: string, bullets: readonly Bullet[]): void {
  const daily = join(root, "daily");
  mkdirSync(daily, { recursive: true });
  writeFileSync(
    join(daily, "2026-07-12.md"),
    `# 2026-07-12\n\n${bullets.map((item) => serializeBullet(item)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function bullet(id: string, status: Bullet["status"], createdAt: string): Bullet {
  return {
    id,
    type: "note",
    status,
    text: `Private ${id.toLowerCase()} replay sentinel.`,
    salience: 0.7,
    isInsight: false,
    createdAt,
    refs: [],
  };
}

function memoryRecord(item: Bullet): MemoryRecord {
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

function markCaptureIntentComplete(root: string, file: string): void {
  const path = join(root, file);
  const intent = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  intent.state = "complete";
  writeFileSync(path, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
}
