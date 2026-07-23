import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  openMemoryLocal,
  type MemoryEmbeddingProvider,
} from "../index.js";

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
    const rehearsal = join(testRoot, "v1-rehearsal-copy");
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

    await cp(source, rehearsal, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
    });
    await chmod(rehearsal, 0o700);
    await mkdir(backup, { mode: 0o700 });
    expect(await digestTree(rehearsal)).toBe(sourceDigest);

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
      expect((await memory.recall({ query: "north cellar", limit: 2, signal })).records[0]?.id)
        .toBe("v0:orchard");
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
  const managed = join(
    root,
    ".index",
    "generations",
    fixture.generation,
    MEMORY_LOCAL_DATABASE_FILENAME,
  );
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
