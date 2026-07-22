import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../../search/index.js";
import { DEFAULT_VEC_DIM, openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { loadVec } from "../../store/vec.js";
import {
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
  serializeBullet,
} from "../index.js";
import { normalizedContentHash } from "../daily.js";
import type { Bullet } from "../types.js";

const NOW = "2026-07-11T09:00:00.000Z";
const roots: string[] = [];

interface MutableGeneration {
  name: string;
  dimension?: number;
  integrityDigest?: string;
}

interface MutableManifest {
  active: MutableGeneration;
  rollback?: MutableGeneration;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed rollback logical integrity", () => {
  it("keeps the logical digest stable across checkpoint/reopen and changes it with vector bytes", async () => {
    const root = tempRoot();
    const path = join(root, "digest.db");
    const provider = embeddings("test:digest", 4);
    const db = openMemoryDb({ path, embeddings: provider, dim: 4 });
    await db.upsert(note("DIGEST", "The vector payload participates in integrity."));
    db.checkpoint();
    const before = db.logicalIntegrityDigest();
    db.checkpoint();
    expect(db.logicalIntegrityDigest()).toBe(before);
    db.close();

    expect(logicalDigest(path, 4)).toBe(before);

    const raw = openRaw(path);
    try {
      loadVec(raw);
      const row = raw.prepare(`SELECT seq FROM memories WHERE id = ?`).get("DIGEST") as { seq: number };
      raw.prepare(`UPDATE memories_vec SET embedding = ? WHERE rowid = ?`)
        .run(vectorBlob([1, 0, 0, 0]), BigInt(row.seq));
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }

    expect(logicalDigest(path, 4)).not.toBe(before);
  });

  it.each(["lifecycle", "vector"] as const)(
    "rejects a retained rollback changed only in WAL (%s) while the main-file SHA stays unchanged",
    async (mutation) => {
      const root = tempRoot();
      const provider = embeddings(`test:wal-${mutation}`, 4);
      writeDaily(root, [bullet("WAL", "The retained generation must stay immutable.")]);
      await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
      const activeBefore = (await safeRebuildMemoryIndex({
        root,
        tier: "bujo",
        embeddings: provider,
        dim: 4,
      })).active;

      let attacker: ReturnType<typeof openRaw> | undefined;
      let mainBefore: string | undefined;
      let mainAfter: string | undefined;
      try {
        await expect(safeRebuildMemoryIndex({
          root,
          tier: "bujo",
          embeddings: provider,
          dim: 4,
          hooks: {
            afterManifestTempFsync: () => {
              const pending = pendingManifest(root);
              const rollback = pending.rollback;
              if (rollback === undefined) throw new Error("test: pending manifest has no rollback");
              const path = generationPath(root, rollback.name);
              attacker = openRaw(path);
              loadVec(attacker);
              attacker.pragma("busy_timeout = 0");
              attacker.pragma("wal_autocheckpoint = 0");
              mainBefore = sha256(path);
              attacker.exec("BEGIN IMMEDIATE");
              if (mutation === "lifecycle") {
                attacker.prepare(`UPDATE memories SET valid_to = ? WHERE id = ?`)
                  .run("2000-01-01T00:00:00.000Z", "WAL");
              } else {
                const row = attacker.prepare(`SELECT seq FROM memories WHERE id = ?`).get("WAL") as { seq: number };
                attacker.prepare(`UPDATE memories_vec SET embedding = ? WHERE rowid = ?`)
                  .run(vectorBlob([1, 0, 0, 0]), BigInt(row.seq));
              }
              attacker.exec("COMMIT");
              mainAfter = sha256(path);
            },
          },
        })).rejects.toThrow(/database is locked|SQLite writer|source parity|logical integrity|digest/iu);
      } finally {
        attacker?.close();
      }

      expect(mainBefore).toBeDefined();
      expect(mainAfter === undefined || mainAfter === mainBefore).toBe(true);
      expect(resolveActiveMemoryDbPath(root)).toBe(activeBefore);
    },
    // This case performs two full rebuilds plus intentional SQLite lock/WAL
    // contention. Node 24's parallel repository gate can exceed Vitest's
    // generic five-second default even though focused runs finish in ~3s.
    15_000,
  );

  it("rejects a WAL-only vector change to the new candidate before manifest activation", async () => {
    const root = tempRoot();
    const provider = embeddings("test:candidate-wal", 4);
    writeDaily(root, [bullet("CANDIDATE-WAL", "Candidate vectors are part of the activation CAS.")]);
    let attacker: ReturnType<typeof openRaw> | undefined;
    let mainBefore: string | undefined;
    let mainAfter: string | undefined;

    try {
      await expect(safeRebuildMemoryIndex({
        root,
        tier: "bujo",
        embeddings: provider,
        dim: 4,
        hooks: {
          afterManifestTempFsync: () => {
            const active = pendingManifest(root).active;
            const path = generationPath(root, active.name);
            attacker = openRaw(path);
            loadVec(attacker);
            attacker.pragma("busy_timeout = 0");
            attacker.pragma("wal_autocheckpoint = 0");
            mainBefore = sha256(path);
            const row = attacker.prepare(`SELECT seq FROM memories WHERE id = ?`)
              .get("CANDIDATE-WAL") as { seq: number };
            attacker.exec("BEGIN IMMEDIATE");
            attacker.prepare(`UPDATE memories_vec SET embedding = ? WHERE rowid = ?`)
              .run(vectorBlob([1, 0, 0, 0]), BigInt(row.seq));
            attacker.exec("COMMIT");
            mainAfter = sha256(path);
          },
        },
      })).rejects.toThrow(/database is locked|SQLite writer|candidate.*logical state|logical integrity|digest/iu);
    } finally {
      attacker?.close();
    }

    expect(mainBefore).toBeDefined();
    expect(mainAfter === undefined || mainAfter === mainBefore).toBe(true);
    expect(readManagedIndexManifest(root)).toBeUndefined();
  });

  it("rejects an ABA vector change captured only by the online rollback backup", async () => {
    const root = tempRoot();
    const provider = embeddings("test:backup-aba", 4);
    writeDaily(root, [bullet("BACKUP-ABA", "A rollback copy must equal the pinned source snapshot.")]);
    const first = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const sourceDigest = logicalDigest(first.active, 4);
    const originalBackup = BetterSqlite3.prototype.backup;
    let intercepted = false;

    BetterSqlite3.prototype.backup = async function (...args): ReturnType<typeof originalBackup> {
      intercepted = true;
      const originalVector = replaceVector(first.active, "BACKUP-ABA", vectorBlob([1, 0, 0, 0]));
      try {
        return await originalBackup.apply(this, args);
      } finally {
        replaceVector(first.active, "BACKUP-ABA", originalVector);
      }
    };
    try {
      await expect(safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 }))
        .rejects.toThrow(/database is locked|SQLite writer|backup does not match.*pinned|pinned active database state/iu);
    } finally {
      BetterSqlite3.prototype.backup = originalBackup;
    }

    expect(intercepted).toBe(true);
    expect(logicalDigest(first.active, 4)).toBe(sourceDigest);
    expect(resolveActiveMemoryDbPath(root)).toBe(first.active);
  });

  it("rejects a rollback backup whose copied logical state differs from its fenced source", async () => {
    const root = tempRoot();
    const provider = embeddings("test:backup-copy", 4);
    writeDaily(root, [bullet("BACKUP-COPY", "The online copy must equal its fenced source.")]);
    const first = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const originalBackup = BetterSqlite3.prototype.backup;

    BetterSqlite3.prototype.backup = async function (...args): ReturnType<typeof originalBackup> {
      const result = await originalBackup.apply(this, args);
      replaceVector(String(args[0]), "BACKUP-COPY", vectorBlob([1, 0, 0, 0]));
      return result;
    };
    try {
      await expect(safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 }))
        .rejects.toThrow(/backup does not match.*pinned|pinned active database state/iu);
    } finally {
      BetterSqlite3.prototype.backup = originalBackup;
    }

    expect(resolveActiveMemoryDbPath(root)).toBe(first.active);
  });

  it("does not advertise a same-provider rollback whose preexisting vector differs from the rebuilt candidate", async () => {
    const root = tempRoot();
    const provider = embeddings("test:prior-vector-parity", 4);
    writeDaily(root, [bullet("VECTOR-PARITY", "The rebuilt candidate is the no-call vector oracle.")]);
    const first = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    replaceVector(first.active, "VECTOR-PARITY", vectorBlob([1, 0, 0, 0]));

    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });

    expect(rebuilt.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(vectorFor(rebuilt.active, "VECTOR-PARITY")).not.toEqual([1, 0, 0, 0]);
    expect(vectorFor(first.active, "VECTOR-PARITY")).toEqual([1, 0, 0, 0]);
  });

  it("rejects a noncanonical edge even when the manifest digest is recomputed", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("EDGE", "Only source-derived edges belong in rollback.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const { path } = rollbackPath(root);

    const raw = openRaw(path);
    try {
      raw.prepare(
        `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'thread', 1.0, ?)`,
      ).run("EDGE", "EDGE", NOW);
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }
    rewriteRollbackDigest(root);

    await expect(rollbackMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/rollback source parity.*(?:edge inventory|replay projection)/iu);
  });

  it("rejects changed manifest-temp bytes before the activation rename", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("TEMP-MANIFEST", "The fsynced manifest bytes stay pinned.")]);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterManifestTempFsync: () => {
          const path = pendingManifestPath(root);
          const pending = JSON.parse(readFileSync(path, "utf8")) as MutableManifest & {
            active: MutableGeneration & { createdAt?: string };
          };
          pending.active.createdAt = "2000-01-01T00:00:00.000Z";
          writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
        },
      },
    })).rejects.toThrow(/manifest temporary file changed/iu);

    expect(readManagedIndexManifest(root)).toBeUndefined();
  });

  it.each(["afterManifestRename", "afterManifestDirFsync"] as const)(
    "reports uncertain activation when %s changes the final manifest",
    async (hook) => {
      const root = tempRoot();
      writeDaily(root, [bullet("FINAL-MANIFEST", "Post-rename durability must not report false success.")]);
      const mutate = (): void => {
        const path = manifestPath(root);
        const manifest = JSON.parse(readFileSync(path, "utf8")) as MutableManifest & {
          active: MutableGeneration & { createdAt?: string };
        };
        manifest.active.createdAt = "2000-01-01T00:00:00.000Z";
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      };

      await expect(safeRebuildMemoryIndex({
        root,
        tier: "lite",
        hooks: hook === "afterManifestRename"
          ? { afterManifestRename: mutate }
          : { afterManifestDirFsync: mutate },
      })).rejects.toThrow(/activation completed.*durability reporting is uncertain.*manifest changed/iu);
    },
  );

  it("holds a candidate writer fence across manifest activation", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("CANDIDATE-FENCE", "No uncommitted writer may cross activation.")]);
    let attacker: ReturnType<typeof openRaw> | undefined;
    try {
      await expect(safeRebuildMemoryIndex({
        root,
        tier: "lite",
        hooks: {
          afterManifestTempFsync: () => {
            attacker = openRaw(generationPath(root, pendingManifest(root).active.name));
            attacker.pragma("busy_timeout = 0");
            attacker.exec("BEGIN IMMEDIATE");
          },
        },
      })).rejects.toThrow(/database is locked|SQLite writer/iu);
    } finally {
      if (attacker?.inTransaction) attacker.exec("ROLLBACK");
      attacker?.close();
    }
    expect(readManagedIndexManifest(root)).toBeUndefined();
  });

  it("holds a rollback-target writer fence across manifest activation", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("ROLLBACK-FENCE", "A retained target cannot change during its swap.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const current = await safeRebuildMemoryIndex({ root, tier: "lite" });
    let attacker: ReturnType<typeof openRaw> | undefined;
    try {
      await expect(rollbackMemoryIndex({
        root,
        tier: "lite",
        hooks: {
          afterManifestTempFsync: () => {
            attacker = openRaw(generationPath(root, pendingManifest(root).active.name));
            attacker.pragma("busy_timeout = 0");
            attacker.exec("BEGIN IMMEDIATE");
          },
        },
      })).rejects.toThrow(/database is locked|SQLite writer/iu);
    } finally {
      if (attacker?.inTransaction) attacker.exec("ROLLBACK");
      attacker?.close();
    }
    expect(resolveActiveMemoryDbPath(root)).toBe(current.active);
  });

  it.each(["source_file", "created_at"] as const)(
    "rejects Journal content-hash %s tampering even when the manifest digest is recomputed",
    async (column) => {
      const root = tempRoot();
      const provider = embeddings(`test:journal-hash-${column}`, 4);
      const text = "Journal hash provenance remains canonical.";
      writeDaily(root, [bullet("JOURNAL-HASH", text)]);
      await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
      await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
      const { path } = rollbackPath(root);

      const raw = openRaw(path);
      try {
        if (column === "source_file") {
          raw.prepare(`UPDATE content_hashes SET source_file = ? WHERE content_hash = ?`)
            .run("daily/forged.md", normalizedContentHash(text));
        } else {
          raw.prepare(`UPDATE content_hashes SET created_at = ? WHERE content_hash = ?`)
            .run("2000-01-01T00:00:00.000Z", normalizedContentHash(text));
        }
        raw.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        raw.close();
      }
      rewriteRollbackDigest(root);

      await expect(rollbackMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 }))
        .rejects.toThrow(/rollback source parity.*content-hash provenance/iu);
    },
  );

  it("rejects index metadata createdAt tampering even when the manifest digest is recomputed", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("METADATA", "Manifest and database creation time must agree.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const { path } = rollbackPath(root);

    const raw = openRaw(path);
    try {
      raw.prepare(`UPDATE index_metadata SET value = ? WHERE key = 'createdAt'`)
        .run("2000-01-01T00:00:00.000Z");
      raw.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      raw.close();
    }
    rewriteRollbackDigest(root);

    await expect(rollbackMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/metadata does not match its manifest generation/iu);
  });

  it("fails closed for a legacy rollback descriptor without a logical digest", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("OLD-DIGEST", "Old manifests need one safe rebuild before rollback.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const manifest = mutableManifest(root);
    if (manifest.rollback === undefined) throw new Error("test: expected rollback descriptor");
    delete manifest.rollback.integrityDigest;
    writeMutableManifest(root, manifest);

    await expect(rollbackMemoryIndex({ root, tier: "lite" }))
      .rejects.toThrow(/no trusted logical integrity digest|run rebuild/iu);
  });

  it("rescues to a valid target without advertising a corrupted outgoing current", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("RESCUE", "The canonical rollback target remains sound.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const current = await safeRebuildMemoryIndex({ root, tier: "lite" });
    const corruptedPath = current.active;
    overwriteMemoryText(corruptedPath, "RESCUE", "Corrupted outgoing payload.");

    const result = await rollbackMemoryIndex({ root, tier: "lite" });

    expect(result.rollback).toBeUndefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
    expect(readTexts(result.active)).toEqual(["The canonical rollback target remains sound."]);
    expect(readTexts(corruptedPath)).toEqual(["Corrupted outgoing payload."]);
  });

  it("retains an exact outgoing current as the target for a reverse rollback", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("REVERSE", "Exact generations can reverse a rollback.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });

    const first = await rollbackMemoryIndex({ root, tier: "lite" });
    expect(first.rollback).toBeDefined();
    expect(readManagedIndexManifest(root)?.rollback?.integrityDigest).toMatch(/^[a-f0-9]{64}$/u);

    const reverse = await rollbackMemoryIndex({ root, tier: "lite" });
    expect(reverse.active).toBe(first.rollback);
    expect(reverse.rollback).toBeDefined();
    expect(readTexts(reverse.active)).toEqual(["Exact generations can reverse a rollback."]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-rollback-integrity-"));
  roots.push(root);
  return root;
}

function bullet(id: string, text: string): Bullet {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: NOW,
    refs: [],
  };
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

function writeDaily(root: string, bullets: readonly Bullet[]): void {
  const daily = join(root, "daily");
  mkdirSync(daily, { recursive: true });
  writeFileSync(
    join(daily, "2026-07-11.md"),
    `# 2026-07-11\n\n${bullets.map((item) => serializeBullet(item)).join("\n")}\n`,
    "utf8",
  );
}

function embeddings(id: string, dim: number): EmbeddingProvider {
  return {
    id,
    embed: async (texts) => texts.map((text) => deterministicVector(text, dim)),
  };
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

function vectorBlob(values: readonly number[]): Buffer {
  const blob = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => blob.writeFloatLE(value, index * 4));
  return blob;
}

function replaceVector(path: string, id: string, replacement: Buffer): Buffer {
  const raw = openRaw(path);
  try {
    loadVec(raw);
    raw.pragma("busy_timeout = 0");
    const row = raw.prepare(
      `SELECT v.embedding AS embedding FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE m.id = ?`,
    ).get(id) as { embedding: Buffer };
    const prior = Buffer.from(row.embedding);
    raw.prepare(
      `UPDATE memories_vec SET embedding = ? WHERE rowid = (SELECT seq FROM memories WHERE id = ?)`,
    ).run(replacement, id);
    raw.pragma("wal_checkpoint(TRUNCATE)");
    return prior;
  } finally {
    raw.close();
  }
}

function vectorFor(path: string, id: string): number[] {
  const raw = openRaw(path);
  try {
    loadVec(raw);
    const row = raw.prepare(
      `SELECT v.embedding AS embedding FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE m.id = ?`,
    ).get(id) as { embedding: Buffer };
    const vector: number[] = [];
    for (let offset = 0; offset < row.embedding.byteLength; offset += 4) {
      vector.push(row.embedding.readFloatLE(offset));
    }
    return vector;
  } finally {
    raw.close();
  }
}

function openRaw(path: string): BetterSqlite3.Database {
  return new BetterSqlite3(path);
}

function logicalDigest(path: string, dimension = DEFAULT_VEC_DIM): string {
  const db = openMemoryDb({ path, readOnly: true, dim: dimension });
  try {
    return db.logicalIntegrityDigest();
  } finally {
    db.close();
  }
}

function generationPath(root: string, generation: string): string {
  return join(realpathSync(root), ".index", "generations", generation, "memory.db");
}

function pendingManifest(root: string): MutableManifest {
  return JSON.parse(readFileSync(pendingManifestPath(root), "utf8")) as MutableManifest;
}

function pendingManifestPath(root: string): string {
  const managed = join(realpathSync(root), ".index");
  const temp = readdirSync(managed).find((name) => name.startsWith(".manifest-") && name.endsWith(".tmp"));
  if (temp === undefined) throw new Error("test: pending manifest temp not found");
  return join(managed, temp);
}

function mutableManifest(root: string): MutableManifest {
  return JSON.parse(readFileSync(manifestPath(root), "utf8")) as MutableManifest;
}

function writeMutableManifest(root: string, manifest: MutableManifest): void {
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function manifestPath(root: string): string {
  return join(realpathSync(root), ".index", "manifest.json");
}

function rollbackPath(root: string): { readonly path: string; readonly generation: MutableGeneration } {
  const rollback = mutableManifest(root).rollback;
  if (rollback === undefined) throw new Error("test: expected rollback descriptor");
  return { path: generationPath(root, rollback.name), generation: rollback };
}

function rewriteRollbackDigest(root: string): void {
  const manifest = mutableManifest(root);
  const rollback = manifest.rollback;
  if (rollback === undefined) throw new Error("test: expected rollback descriptor");
  rollback.integrityDigest = logicalDigest(
    generationPath(root, rollback.name),
    rollback.dimension ?? DEFAULT_VEC_DIM,
  );
  writeMutableManifest(root, manifest);
}

function overwriteMemoryText(path: string, id: string, text: string): void {
  const db = openMemoryDb({ path });
  try {
    const record = db.get(id);
    if (record === undefined) throw new Error(`test: missing memory ${id}`);
    db.upsertLexical({ ...record, text });
    db.checkpoint();
  } finally {
    db.close();
  }
}

function readTexts(path: string): string[] {
  const db = openMemoryDb({ path, readOnly: true });
  try {
    return db.topSalient(100).map((record) => record.text).sort();
  } finally {
    db.close();
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
