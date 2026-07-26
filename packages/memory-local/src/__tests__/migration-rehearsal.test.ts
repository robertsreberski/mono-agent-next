// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
  type MemoryHost,
  type MemoryRecord,
  type MemoryRuntimeCaptureGrant,
} from "@mono-agent/module-sdk";

import {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  adoptV0MemoryLocalCopy,
  openMemoryLocal,
  runMemoryLocalCli,
  snapshotV0MemoryLocalRoot,
  type MemoryEmbeddingProvider,
} from "../index.js";
import {
  adoptV0MemoryLocalCopyForTesting,
  snapshotV0MemoryLocalRootForTesting,
} from "../migration.js";
import { captureReceiptKey } from "../bujo-db.js";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/v0-final-bujo.json", import.meta.url),
);
const signal = new AbortController().signal;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("v0-final BuJo copied-data migration rehearsal", () => {
  it("proves audit, backup, recall, capture idempotency, preview, rebuild, both readers, and rollback", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const backup = join(testRoot, "pre-cutover-backup");
    await seedV0FinalStore(source, fixture);

    const v0Before = readWithV0Final(source, fixture);
    expect(v0Before).toMatchObject({
      records: 3,
      ftsFirst: "v0:orchard",
      vectorFirst: "v0:orchard",
      unresolved: fixture.unresolvedMetadata,
    });
    const sourceDigest = await digestTree(source);

    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    expect(snapshot).toMatchObject({
      schema: "mono-agent.memory-local.v0-snapshot.v1",
      activeGeneration: fixture.generation,
      sourceMarker: {
        state: "initialized",
        storeId: fixture.storeId,
      },
      database: { records: 3, ftsIndexed: 3, vectorsIndexed: 3 },
    });
    const adoption = await adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    });
    expect(adoption).toMatchObject({
      schema: "mono-agent.memory-local.v0-adoption.v1",
      sourceStateSha256: snapshot.sourceStateSha256,
      preAdoptionTreeSha256: snapshot.treeSha256,
      audit: { status: "healthy", records: 3 },
    });
    await mkdir(backup, { mode: 0o700 });

    const provider = new RehearsalEmbeddingProvider(fixture.embedding.dimensions);
    const config = memoryConfig(fixture.embedding.dimensions);
    const memory = await openMemoryLocal({
      config,
      configDirectory: testRoot,
      dataDirectory: rehearsal,
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    try {
      await expect(memory.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        schema: "mono-agent.bujo.v1",
        records: 3,
        fts: { indexed: 3, missing: 0, orphaned: 0 },
        vectors: {
          indexed: 3,
          dimensions: fixture.embedding.dimensions,
          configured: true,
          compatible: true,
        },
      });
      expect((await memory.recall({ query: "north cellar", limit: 2, signal })).records[0])
        .toMatchObject({
          id: "v0:orchard",
          createdAt: "2026-07-20T10:00:00.000Z",
        });
      expect((await memory.recall({ query: "fruit inventory", limit: 1, signal })).records[0]?.id)
        .toBe("v0:orchard");

      await expect(memory.backup({ destinationDirectory: backup, signal })).resolves.toMatchObject({
        directory: backup,
        recordCount: 3,
      });

      const completedTurn = record(
        "v1:completed-turn",
        "The spare key is in the ceramic bowl.",
        "2026-07-23T12:00:00.000Z",
      );
      await memory.capture?.({ record: completedTurn, signal });
      await memory.capture?.({ record: completedTurn, signal });
      await expect(memory.capture?.({
        record: { ...completedTurn, text: "Conflicting completed-turn content." },
        signal,
      })).rejects.toMatchObject({ code: "duplicate_record" });
      await expect(memory.audit({ signal, strict: true })).resolves.toMatchObject({
        records: 4,
        intake: { captures: 0, vectors: 0 },
      });

      await expect(memory.previewForget("v0:bicycle", signal)).resolves.toMatchObject({
        found: true,
        vectorPresent: true,
        record: { id: "v0:bicycle" },
      });
      await expect(memory.rebuild({ signal })).resolves.toMatchObject({
        records: 4,
        ftsIndexed: 4,
        vectorsIndexed: 4,
        vectorDimensions: fixture.embedding.dimensions,
      });
      await expect(memory.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        records: 4,
      });
    } finally {
      await memory.stop();
    }

    const adoptedDatabase = new DatabaseSync(managedDatabasePath(rehearsal, fixture));
    try {
      expect((adoptedDatabase.prepare(
        "SELECT created_at FROM memories WHERE id = ?",
      ).get("v0:orchard") as { created_at: string }).created_at)
        .toBe("2026-07-20T10:00:00Z");
    } finally {
      adoptedDatabase.close();
    }

    const v0After = readWithV0Final(rehearsal, fixture);
    expect(v0After).toMatchObject({
      records: 4,
      ftsFirst: "v0:orchard",
      vectorFirst: "v0:orchard",
      unresolved: fixture.unresolvedMetadata,
    });

    const rollbackV0 = readWithV0Final(backup, fixture);
    expect(rollbackV0).toMatchObject({
      records: 3,
      ftsFirst: "v0:orchard",
      vectorFirst: "v0:orchard",
      unresolved: fixture.unresolvedMetadata,
    });
    const rollbackV1 = await openMemoryLocal({
      config,
      configDirectory: testRoot,
      dataDirectory: backup,
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    try {
      await expect(rollbackV1.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        records: 3,
      });
      expect((await rollbackV1.recall({ query: "planning Tuesday", limit: 1, signal })).records[0]?.id)
        .toBe("v0:planning");
    } finally {
      await rollbackV1.stop();
    }

    expect(await digestTree(source)).toBe(sourceDigest);
  }, 30_000);

  it("removes its exact failed target so an unsupported symlink can be fixed and retried", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    await writeFile(join(source, "notes.txt"), "stable source\n", {
      flag: "wx",
      mode: 0o600,
    });
    await symlink("notes.txt", join(source, "unsafe-link"));

    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    })).rejects.toThrow(/unsupported filesystem entry/u);
    expect(existsSync(rehearsal)).toBe(false);

    await rm(join(source, "unsafe-link"));
    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    })).resolves.toMatchObject({
      targetRoot: rehearsal,
      database: { records: 3 },
    });
  });

  it.each(["directory", "symlink"] as const)(
    "does not replace a concurrently created %s target",
    async (replacementKind) => {
      const fixture = await readFixture();
      const testRoot = await createTestRoot();
      const source = join(testRoot, "v0-source");
      const rehearsal = join(testRoot, "rehearsal-copy");
      const replacement = replacementKind === "directory"
        ? rehearsal
        : join(testRoot, "operator-target");
      await seedV0FinalStore(source, fixture);

      await expect(snapshotV0MemoryLocalRootForTesting({
        sourceRoot: source,
        targetRoot: rehearsal,
        signal,
      }, {
        async beforeSnapshotTargetCreate() {
          await mkdir(replacement, { mode: 0o700 });
          await writeFile(join(replacement, "operator-replacement.txt"), "preserve me\n", {
            flag: "wx",
            mode: 0o600,
          });
          if (replacementKind === "symlink") {
            await symlink(replacement, rehearsal);
          }
        },
      })).rejects.toThrow(/must not already exist/u);

      expect(await readFile(join(replacement, "operator-replacement.txt"), "utf8"))
        .toBe("preserve me\n");
      if (replacementKind === "symlink") {
        expect(await realpath(rehearsal)).toBe(replacement);
      }
    },
  );

  it("removes its observed empty target when opening fails before descriptor binding", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      beforeSnapshotTargetOpen() {
        throw new Error("injected pre-open failure");
      },
    })).rejects.toThrow(/injected pre-open failure/u);
    expect(existsSync(rehearsal)).toBe(false);

    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    })).resolves.toMatchObject({
      targetRoot: rehearsal,
      database: { records: 3 },
    });
  });

  it("reports an already removed creation target when parent durability fails", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      beforeSnapshotTargetOpen() {
        throw new Error("injected pre-open failure");
      },
      beforeSnapshotTargetCleanupParentSync() {
        throw new Error("injected parent-sync failure");
      },
    })).rejects.toThrow(/target was removed.*durability could not be confirmed/u);

    expect(existsSync(rehearsal)).toBe(false);
  });

  it("rejects a target swap before descriptor binding without deleting either directory", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const displaced = join(testRoot, "displaced-created-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      async beforeSnapshotTargetOpen() {
        await rename(rehearsal, displaced);
        await mkdir(rehearsal, { mode: 0o700 });
        await writeFile(join(rehearsal, "operator-replacement.txt"), "preserve me\n", {
          flag: "wx",
          mode: 0o600,
        });
      },
    })).rejects.toThrow(/identity changed during creation/u);

    expect(await readFile(join(rehearsal, "operator-replacement.txt"), "utf8"))
      .toBe("preserve me\n");
    expect(existsSync(displaced)).toBe(true);
  });

  it("restores a replacement moved by a target-creation cleanup race", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const displaced = join(testRoot, "displaced-created-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      beforeSnapshotTargetOpen() {
        throw new Error("injected pre-open failure");
      },
      async beforeSnapshotTargetCleanupRename() {
        await rename(rehearsal, displaced);
        await mkdir(rehearsal, { mode: 0o700 });
        await writeFile(join(rehearsal, "operator-replacement.txt"), "preserve me\n", {
          flag: "wx",
          mode: 0o600,
        });
      },
    })).rejects.toThrow(/preserving it as unusable/u);

    expect(await readFile(join(rehearsal, "operator-replacement.txt"), "utf8"))
      .toBe("preserve me\n");
    expect(existsSync(displaced)).toBe(true);
  });

  it("preserves a replacement target and blocks retry when the created root identity changes", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const displaced = join(testRoot, "displaced-created-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      async beforeSnapshotSourceRecheck() {
        await rename(rehearsal, displaced);
        await mkdir(rehearsal, { mode: 0o700 });
        await writeFile(join(rehearsal, "operator-replacement.txt"), "preserve me\n", {
          flag: "wx",
          mode: 0o600,
        });
        throw new Error("injected post-copy failure");
      },
    })).rejects.toThrow(/preserving it as unusable/u);

    expect(await readFile(join(rehearsal, "operator-replacement.txt"), "utf8"))
      .toBe("preserve me\n");
    expect(existsSync(displaced)).toBe(true);
    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    })).rejects.toThrow(/must not already exist/u);
  });

  it("restores a replacement moved by post-copy failure cleanup", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const displaced = join(testRoot, "displaced-created-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      beforeSnapshotSourceRecheck() {
        throw new Error("injected post-copy failure");
      },
      async beforeSnapshotFailureCleanupRename() {
        await rename(rehearsal, displaced);
        await mkdir(rehearsal, { mode: 0o700 });
        await writeFile(join(rehearsal, "operator-replacement.txt"), "preserve me\n", {
          flag: "wx",
          mode: 0o600,
        });
      },
    })).rejects.toThrow(/could not be safely removed/u);

    expect(await readFile(join(rehearsal, "operator-replacement.txt"), "utf8"))
      .toBe("preserve me\n");
    expect(existsSync(displaced)).toBe(true);
  });

  it("reports an already removed copied target when parent durability fails", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      beforeSnapshotSourceRecheck() {
        throw new Error("injected post-copy failure");
      },
      beforeSnapshotFailureCleanupParentSync() {
        throw new Error("injected parent-sync failure");
      },
    })).rejects.toThrow(/target was removed.*durability could not be confirmed/u);

    expect(existsSync(rehearsal)).toBe(false);
  });

  it("rejects an oversized active database before creating a target or running backup", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const handle = await open(managedDatabasePath(source, fixture), "r+");
    try {
      await handle.truncate((64 * 1024 * 1024 * 1024) + 1);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    })).rejects.toThrow(/bounded tree limits/u);
    expect(existsSync(rehearsal)).toBe(false);
  });

  it("rejects an oversized live WAL before creating a target or running backup", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const handle = await open(`${managedDatabasePath(source, fixture)}-wal`, "wx", 0o600);
    try {
      await handle.truncate((64 * 1024 * 1024 * 1024) + 1);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    })).rejects.toThrow(/bounded tree limits/u);
    expect(existsSync(rehearsal)).toBe(false);
  });

  it("rejects an in-place source mutation after the file was copied", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const sourceFile = join(source, "stable-note.txt");
    await seedV0FinalStore(source, fixture);
    await writeFile(sourceFile, "alpha\n", { flag: "wx", mode: 0o600 });

    await expect(snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      async beforeSnapshotSourceRecheck() {
        const handle = await open(sourceFile, "r+");
        try {
          await handle.write(Buffer.from("o"), 0, 1, 0);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    })).rejects.toThrow(/source file changed after it was copied/u);
    expect(existsSync(rehearsal)).toBe(false);
  });

  it("syncs every copied directory, including the populated target root", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    const nested = join(source, "archive", "2026");
    await seedV0FinalStore(source, fixture);
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(join(nested, "note.txt"), "durable\n", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(source, "a.txt"), "lowercase\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(source, "B.txt"), "uppercase\n", { flag: "wx", mode: 0o600 });
    const synced = new Set<string>();

    await snapshotV0MemoryLocalRootForTesting({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    }, {
      afterSnapshotDirectorySync(path) {
        synced.add(path);
      },
    });

    expect(synced).toEqual(new Set([
      rehearsal,
      join(rehearsal, ".index"),
      join(rehearsal, ".index", "generations"),
      join(rehearsal, ".index", "generations", fixture.generation),
      join(rehearsal, "archive"),
      join(rehearsal, "archive", "2026"),
    ]));
  });

  it("rejects aliases, wrong source provenance, confirmation errors, and target drift", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const otherSource = join(testRoot, "unrelated-v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    await seedV0FinalStore(otherSource, fixture);

    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: source,
      expectedSourceStateSha256: "a".repeat(64),
      expectedTreeSha256: "a".repeat(64),
      confirm: "a".repeat(64),
      signal,
    })).rejects.toThrow(/must differ/u);
    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: join(source, "nested-copy"),
      signal,
    })).rejects.toThrow(/must be disjoint/u);

    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: otherSource,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    })).rejects.toThrow(/source state/u);
    expect(existsSync(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME))).toBe(false);

    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: "b".repeat(64),
      signal,
    })).rejects.toThrow(/matching tree confirmation/u);
    expect(existsSync(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME))).toBe(false);

    await writeFile(join(rehearsal, "operator-drift.txt"), "changed\n", { mode: 0o600 });
    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    })).rejects.toThrow(/snapshot digest/u);
    expect(existsSync(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME))).toBe(false);
  });

  it("online-snapshots a running WAL source without mutating its application state", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "running-v0-source");
    const rehearsal = join(testRoot, "running-copy");
    await seedV0FinalStore(source, fixture);
    const databasePath = managedDatabasePath(source, fixture);
    const live = new DatabaseSync(databasePath, { allowExtension: true });
    try {
      loadSqliteVec(live);
      live.enableLoadExtension(false);
      live.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
      live.prepare("UPDATE memories SET text = ? WHERE id = ?")
        .run("Committed while the predecessor WAL remains active.", "v0:orchard");
      live.prepare("UPDATE memories_fts SET text = ? WHERE id = ?")
        .run("Committed while the predecessor WAL remains active.", "v0:orchard");
      live.exec("COMMIT");
      expect(existsSync(`${databasePath}-wal`)).toBe(true);
      const before = await stat(databasePath);
      const markerBefore = await readFile(join(source, MEMORY_LOCAL_MARKER_FILENAME));
      const manifestBefore = await readFile(join(source, ".index", "manifest.json"));

      const snapshot = await snapshotV0MemoryLocalRoot({
        sourceRoot: source,
        targetRoot: rehearsal,
        signal,
      });
      expect(snapshot.database.records).toBe(3);
      expect((live.prepare("SELECT text FROM memories WHERE id = ?").get(
        "v0:orchard",
      ) as { text: string }).text).toBe(
        "Committed while the predecessor WAL remains active.",
      );
      const after = await stat(databasePath);
      expect({ dev: after.dev, ino: after.ino, mode: after.mode & 0o777 })
        .toEqual({ dev: before.dev, ino: before.ino, mode: before.mode & 0o777 });
      expect(await readFile(join(source, MEMORY_LOCAL_MARKER_FILENAME))).toEqual(markerBefore);
      expect(await readFile(join(source, ".index", "manifest.json"))).toEqual(manifestBefore);

      const copied = new DatabaseSync(managedDatabasePath(rehearsal, fixture));
      try {
        expect((copied.prepare("SELECT text FROM memories WHERE id = ?").get(
          "v0:orchard",
        ) as { text: string }).text).toBe(
          "Committed while the predecessor WAL remains active.",
        );
      } finally {
        copied.close();
      }
      live.exec("BEGIN IMMEDIATE;");
      live.prepare("UPDATE memories SET text = ? WHERE id = ?")
        .run("Written only after the point-in-time snapshot.", "v0:orchard");
      live.prepare("UPDATE memories_fts SET text = ? WHERE id = ?")
        .run("Written only after the point-in-time snapshot.", "v0:orchard");
      live.exec("COMMIT");
      expect((live.prepare("SELECT text FROM memories WHERE id = ?").get(
        "v0:orchard",
      ) as { text: string }).text).toBe(
        "Written only after the point-in-time snapshot.",
      );
      await expect(adoptV0MemoryLocalCopy({
        liveSourceRoot: source,
        targetRoot: rehearsal,
        expectedSourceStateSha256: snapshot.sourceStateSha256,
        expectedTreeSha256: snapshot.treeSha256,
        confirm: snapshot.treeSha256,
        signal,
      })).resolves.toMatchObject({
        sourceStateSha256: snapshot.sourceStateSha256,
        audit: { status: "healthy", records: 3 },
      });
    } finally {
      live.close();
    }
  });

  it("retains an initializing same-inode marker when strict pre-commit audit fails", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const databasePath = join(
      source,
      ".index",
      "generations",
      fixture.generation,
      MEMORY_LOCAL_DATABASE_FILENAME,
    );
    const database = new DatabaseSync(databasePath, { allowExtension: true });
    try {
      loadSqliteVec(database);
      database.enableLoadExtension(false);
      database.prepare("DELETE FROM memories_fts WHERE id = ?").run("v0:bicycle");
    } finally {
      database.close();
    }

    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    })).rejects.toThrow(/strict memory coverage/u);
    const markerPath = join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME);
    const before = await stat(markerPath);
    expect(await readFile(markerPath, "utf8")).toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
    expect(before.mode & 0o777).toBe(0o600);
    const after = await stat(markerPath);
    expect(after.ino).toBe(before.ino);
  });

  it("rejects dangling capture receipts before adoption commit", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const database = new DatabaseSync(managedDatabasePath(source, fixture));
    try {
      database.prepare(
        "INSERT INTO index_metadata(key, value) VALUES (?, ?)",
      ).run(
        captureReceiptKey("migration-receipt-source"),
        JSON.stringify({
          recordIds: [`runtime:${"f".repeat(48)}`],
          sourceHash: "a".repeat(64),
          version: 1,
        }),
      );
    } finally {
      database.close();
    }

    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    })).rejects.toThrow(/invalid memory records or capture receipts/u);
    const markerPath = join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME);
    const marker = await stat(markerPath);
    expect(await readFile(markerPath, "utf8")).toMatch(
      /^initializing:[0-9a-f-]{36}\n$/u,
    );
    expect(marker.mode & 0o777).toBe(0o600);
  });

  it("rejects semantically unreadable v0 records before adoption commit", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const database = new DatabaseSync(managedDatabasePath(source, fixture));
    try {
      database.prepare("UPDATE memories SET created_at = ? WHERE id = ?")
        .run("not-a-timestamp", "v0:orchard");
    } finally {
      database.close();
    }

    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    await expect(adoptV0MemoryLocalCopy({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    })).rejects.toThrow(/invalid memory records/u);
    expect(await readFile(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
  });

  it("fails closed when the adoption database changes before its reserved binding", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const replacementRoot = join(testRoot, "replacement-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    await seedV0FinalStore(replacementRoot, fixture);
    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    const replacementBytes = await readFile(managedDatabasePath(replacementRoot, fixture));
    let displaced = "";

    await expect(adoptV0MemoryLocalCopyForTesting({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    }, {
      async beforeAdoptionDatabaseBind(path) {
        displaced = `${path}.operator-original`;
        await rename(path, displaced);
        await writeFile(path, replacementBytes, { flag: "wx", mode: 0o600 });
      },
    })).rejects.toThrow(/identity changed while binding SQLite/u);

    expect(await readFile(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
    expect((await stat(displaced)).size).toBeGreaterThan(0);
  });

  it("rejects a same-inode, same-length copied database mutation before adoption commit", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });
    const databasePath = managedDatabasePath(rehearsal, fixture);
    const before = await stat(databasePath);

    await expect(adoptV0MemoryLocalCopyForTesting({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    }, {
      async beforeAdoptionCommit(path) {
        expect(path).toBe(databasePath);
        const bytes = await readFile(path);
        const offset = bytes.length - 1;
        const handle = await open(path, "r+");
        try {
          await handle.write(
            Buffer.from([bytes[offset]! ^ 1]),
            0,
            1,
            offset,
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    })).rejects.toThrow(/target tree changed after snapshot confirmation/u);

    const after = await stat(databasePath);
    expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
      dev: before.dev,
      ino: before.ino,
      size: before.size,
    });
    expect(await readFile(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
  });

  it("does not hide an attacker-created binding-authority prefix sibling", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });

    await expect(adoptV0MemoryLocalCopyForTesting({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    }, {
      async beforeAdoptionCommit(path) {
        const attacker = join(
          dirname(path),
          `.${basename(path)}.sqlite-binding.authority-attacker`,
        );
        await mkdir(attacker, { mode: 0o700 });
        await writeFile(join(attacker, "payload"), "not part of the snapshot\n", {
          mode: 0o600,
        });
      },
    })).rejects.toThrow(/target tree changed after snapshot confirmation/u);
    expect(await readFile(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
  });

  it("rejects writer-lease sidecars that appear before adoption commit", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const source = join(testRoot, "v0-source");
    const rehearsal = join(testRoot, "rehearsal-copy");
    await seedV0FinalStore(source, fixture);
    const snapshot = await snapshotV0MemoryLocalRoot({
      sourceRoot: source,
      targetRoot: rehearsal,
      signal,
    });

    await expect(adoptV0MemoryLocalCopyForTesting({
      liveSourceRoot: source,
      targetRoot: rehearsal,
      expectedSourceStateSha256: snapshot.sourceStateSha256,
      expectedTreeSha256: snapshot.treeSha256,
      confirm: snapshot.treeSha256,
      signal,
    }, {
      async beforeAdoptionCommit() {
        await writeFile(
          join(rehearsal, ".memory-local-writer.sqlite-wal"),
          "unexpected lease recovery state\n",
          { mode: 0o600 },
        );
      },
    })).rejects.toThrow(/target tree changed after snapshot confirmation/u);
    expect(await readFile(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
  });

  it("rejects invalid Ollama model identities before committing the adoption marker", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const invalidModels = [
      "ollama:",
      "ollama: ",
      `ollama:${"a".repeat(513)}`,
    ];
    for (const [index, model] of invalidModels.entries()) {
      const source = join(testRoot, `invalid-model-source-${String(index)}`);
      const rehearsal = join(testRoot, `invalid-model-copy-${String(index)}`);
      await seedV0FinalStore(source, fixture);
      const database = new DatabaseSync(managedDatabasePath(source, fixture));
      try {
        database.prepare("UPDATE memories SET embedding_model = ?").run(model);
      } finally {
        database.close();
      }
      const snapshot = await snapshotV0MemoryLocalRoot({
        sourceRoot: source,
        targetRoot: rehearsal,
        signal,
      });

      await expect(adoptV0MemoryLocalCopy({
        liveSourceRoot: source,
        targetRoot: rehearsal,
        expectedSourceStateSha256: snapshot.sourceStateSha256,
        expectedTreeSha256: snapshot.treeSha256,
        confirm: snapshot.treeSha256,
        signal,
      })).rejects.toThrow(/unsupported vector identity/u);
      expect(await readFile(join(rehearsal, MEMORY_LOCAL_MARKER_FILENAME), "utf8"))
        .toMatch(/^initializing:[0-9a-f-]{36}\n$/u);
    }
  }, 10_000);

  it("supports a legacy marker-absent source and rejects an in-flight source marker", async () => {
    const fixture = await readFixture();
    const testRoot = await createTestRoot();
    const legacySource = join(testRoot, "legacy-v0-source");
    const legacyTarget = join(testRoot, "legacy-copy");
    await seedV0FinalStore(legacySource, fixture);
    await rm(join(legacySource, MEMORY_LOCAL_MARKER_FILENAME));

    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: legacySource,
      targetRoot: legacyTarget,
      signal,
    })).resolves.toMatchObject({
      sourceMarker: { state: "absent" },
    });

    const inFlightSource = join(testRoot, "in-flight-v0-source");
    const refusedTarget = join(testRoot, "refused-copy");
    await seedV0FinalStore(inFlightSource, fixture);
    await writeFile(
      join(inFlightSource, MEMORY_LOCAL_MARKER_FILENAME),
      `initializing:${fixture.storeId}\n`,
      { flag: "w", mode: 0o600 },
    );
    await expect(snapshotV0MemoryLocalRoot({
      sourceRoot: inFlightSource,
      targetRoot: refusedTarget,
      signal,
    })).rejects.toThrow(/unsafe permanent marker state/u);
    expect(existsSync(refusedTarget)).toBe(false);
  });

  it("exposes a bounded standalone CLI contract", async () => {
    let stderr = "";
    await expect(runMemoryLocalCli(["snapshot-v0"], {
      stderr: (value) => { stderr += value; },
    })).resolves.toBe(2);
    expect(stderr).toContain("--source-root is required");

    stderr = "";
    await expect(runMemoryLocalCli([
      "snapshot-v0",
      "--source-root",
      "relative-source",
      "--target-root",
      "/absolute-target",
    ], {
      stderr: (value) => { stderr += value; },
    })).resolves.toBe(2);
    expect(stderr).toContain("--source-root must be an absolute path");

    stderr = "";
    await expect(runMemoryLocalCli([
      "snapshot-v0",
      "--source-root",
      "/tmp/../noncanonical-source",
      "--target-root",
      "/absolute-target",
    ], {
      stderr: (value) => { stderr += value; },
    })).resolves.toBe(2);
    expect(stderr).toContain("--source-root must be a canonical absolute path");

    stderr = "";
    await expect(runMemoryLocalCli(["adopt-v0", "--live-source-root", "/a", "--target-root", "/b",
      "--expected-source-state-sha256", "not-a-digest",
      "--expected-tree-sha256", "not-a-digest", "--confirm", "not-a-digest"], {
      stderr: (value) => { stderr += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      error: { code: "maintenance_failed" },
    });
    expect(Buffer.byteLength(stderr)).toBeLessThan(2_048);
  });
});

interface V0FixtureRecord {
  readonly id: string;
  readonly seq: number;
  readonly type: "task" | "event" | "note";
  readonly status: "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated";
  readonly text: string;
  readonly createdAt: string;
  readonly conversationId: string;
  readonly tags: readonly string[];
  readonly vector: readonly number[];
}

interface V0Fixture {
  readonly schema: "mono-agent.v0-final.bujo-copy.v1";
  readonly storeId: string;
  readonly generation: string;
  readonly embedding: {
    readonly id: string;
    readonly dimensions: number;
  };
  readonly records: readonly V0FixtureRecord[];
  readonly unresolvedMetadata: Readonly<Record<string, string>>;
}

async function readFixture(): Promise<V0Fixture> {
  const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as V0Fixture;
  if (
    parsed.schema !== "mono-agent.v0-final.bujo-copy.v1"
    || parsed.records.length !== 3
    || parsed.embedding.dimensions !== 3
  ) {
    throw new Error("Sanitized v0-final fixture is malformed.");
  }
  return parsed;
}

async function seedV0FinalStore(root: string, fixture: V0Fixture): Promise<void> {
  const generationDirectory = join(root, ".index", "generations", fixture.generation);
  await mkdir(generationDirectory, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(join(root, ".index"), 0o700);
  await chmod(join(root, ".index", "generations"), 0o700);
  await chmod(generationDirectory, 0o700);
  const databasePath = join(generationDirectory, MEMORY_LOCAL_DATABASE_FILENAME);
  const database = new DatabaseSync(databasePath, { allowExtension: true });
  try {
    loadSqliteVec(database);
    database.enableLoadExtension(false);
    database.exec(`
      PRAGMA application_id = 1296125233;
      PRAGMA user_version = 1;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('task','event','note')),
        status TEXT NOT NULL CHECK(status IN ('open','done','scheduled','migrated','dropped','invalidated')),
        text TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.5,
        is_insight INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        valid_from TEXT,
        valid_to TEXT,
        superseded_by TEXT,
        superseded_at TEXT,
        due_at TEXT,
        collection TEXT,
        source_session TEXT,
        source_file TEXT,
        source_line INTEGER,
        embedding_model TEXT,
        dim INTEGER,
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE edges (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('thread','about','supports','supersedes')),
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(src, dst, kind)
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text);
      CREATE VIRTUAL TABLE memories_vec USING vec0(
        embedding float[${fixture.embedding.dimensions}] distance_metric=cosine
      );
      CREATE INDEX idx_memories_status ON memories(status);
      CREATE INDEX idx_memories_due ON memories(due_at);
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE entity_relations (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(src, dst, relation)
      );
      CREATE TABLE memory_entities (
        memory_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        provenance TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, entity_id)
      );
      CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
      CREATE TABLE content_hashes (
        content_hash TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insertMemory = database.prepare(`
      INSERT INTO memories(
        id, seq, type, status, text, salience, is_insight, created_at,
        last_accessed_at, access_count, valid_from, valid_to, superseded_by,
        superseded_at, due_at, collection, source_session, source_file,
        source_line, embedding_model, dim, tags
      ) VALUES (?, ?, ?, ?, ?, 0.5, 0, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL,
        'v0-final', ?, 'sanitized-v0-copy', NULL, ?, ?, ?)
    `);
    const insertFts = database.prepare("INSERT INTO memories_fts(id, text) VALUES (?, ?)");
    const insertVector = database.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)");
    const insertHash = database.prepare(
      "INSERT INTO content_hashes(content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const record of fixture.records) {
      insertMemory.run(
        record.id,
        record.seq,
        record.type,
        record.status,
        record.text,
        record.createdAt,
        record.conversationId,
        fixture.embedding.id,
        fixture.embedding.dimensions,
        JSON.stringify(record.tags),
      );
      insertFts.run(record.id, record.text);
      insertVector.run(BigInt(record.seq), vectorBlob(record.vector));
      insertHash.run(
        createHash("sha256").update(record.id).update("\0").update(record.text).digest("hex"),
        record.id,
        "sanitized-v0-copy",
        record.createdAt,
      );
    }
    const insertMetadata = database.prepare("INSERT INTO index_metadata(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(fixture.unresolvedMetadata)) {
      insertMetadata.run(key, value);
    }
    database.exec(`
      INSERT INTO entities(id, name, type, summary, created_at)
      VALUES ('entity:orchard', 'North cellar', 'place', 'Sanitized migration fixture.', '2026-07-20T10:00:00.000Z');
      INSERT INTO memory_entities(memory_id, entity_id, provenance, created_at)
      VALUES ('v0:orchard', 'entity:orchard', 'v0-final', '2026-07-20T10:00:00.000Z');
      INSERT INTO edges(src, dst, kind, weight, created_at)
      VALUES ('v0:planning', 'v0:orchard', 'about', 0.5, '2026-07-21T10:00:00.000Z');
    `);
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
  const manifestPath = join(root, ".index", "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, active: { name: fixture.generation } }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(root, MEMORY_LOCAL_MARKER_FILENAME),
    `initialized:${fixture.storeId}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function readWithV0Final(
  root: string,
  fixture: V0Fixture,
): {
  readonly records: number;
  readonly ftsFirst: string | undefined;
  readonly vectorFirst: string | undefined;
  readonly unresolved: Readonly<Record<string, string>>;
} {
  const managed = managedDatabasePath(root, fixture);
  const databasePath = existsSync(managed)
    ? managed
    : join(root, MEMORY_LOCAL_DATABASE_FILENAME);
  const database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: true });
  try {
    loadSqliteVec(database);
    database.enableLoadExtension(false);
    const count = database.prepare("SELECT COUNT(*) AS count FROM memories").get() as
      | { count: number }
      | undefined;
    const fts = database.prepare(`
      SELECT id FROM memories_fts
      WHERE memories_fts MATCH '"north" OR "cellar"'
      ORDER BY bm25(memories_fts), id
      LIMIT 1
    `).get() as { id: string } | undefined;
    const vector = database.prepare(`
      SELECT m.id AS id
      FROM memories_vec v
      JOIN memories m ON m.seq = v.rowid
      WHERE v.embedding MATCH ? AND k = 1
      ORDER BY v.distance, m.id
    `).get(vectorBlob([1, 0, 0])) as { id: string } | undefined;
    const unresolved: Record<string, string> = {};
    for (const key of Object.keys(fixture.unresolvedMetadata).sort()) {
      const row = database.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      if (row !== undefined) unresolved[key] = row.value;
    }
    return {
      records: Number(count?.count),
      ftsFirst: fts?.id,
      vectorFirst: vector?.id,
      unresolved,
    };
  } finally {
    database.close();
  }
}

function managedDatabasePath(root: string, fixture: V0Fixture): string {
  return join(
    root,
    ".index",
    "generations",
    fixture.generation,
    MEMORY_LOCAL_DATABASE_FILENAME,
  );
}

class RehearsalEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "ollama:nomic-embed-text:v1.5";

  constructor(readonly dimensions: number) {}

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => {
      if (/\b(?:apple|apples|fruit|orchard|cellar|inventory)\b/iu.test(text)) {
        return Object.freeze([1, 0, 0]);
      }
      if (/\b(?:planning|quarterly|Tuesday)\b/iu.test(text)) {
        return Object.freeze([0, 1, 0]);
      }
      return Object.freeze([0, 0, 1]);
    });
  }
}

function memoryConfig(dimensions: number): unknown {
  return {
    capture: {
      enabled: true,
      model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
      timeoutMs: 5_000,
    },
    embeddings: {
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "nomic-embed-text:v1.5",
      dimensions,
      timeoutMs: 1_000,
      breakerFailures: 3,
      breakerResetMs: 100,
    },
  };
}

function passthroughGrant(): MemoryRuntimeCaptureGrant {
  return {
    async complete({ input }) {
      return { text: "captured", structuredOutput: { records: [{ text: input }] } };
    },
  };
}

function runtimeHost(grant: MemoryRuntimeCaptureGrant): MemoryHost {
  return {
    grantedCapabilities: new Set([HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE]),
    getCapability<T = unknown>(_name: string): T | undefined { return undefined; },
    runtimeCapture: grant,
  };
}

function record(id: string, text: string, createdAt: string): MemoryRecord {
  return { id, text, createdAt };
}

function vectorBlob(vector: readonly number[]): Buffer {
  const output = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => output.writeFloatLE(value, index * 4));
  return output;
}

async function createTestRoot(): Promise<string> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-migration-"));
  const root = await realpath(authored);
  roots.push(root);
  return root;
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1);
      const identity = await stat(path);
      hash.update(entry.isDirectory() ? "d\0" : "f\0");
      hash.update(relative);
      hash.update("\0");
      hash.update(String(identity.mode & 0o777));
      hash.update("\0");
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        hash.update(await readFile(path));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}
