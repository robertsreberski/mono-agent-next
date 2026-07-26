// SPDX-License-Identifier: MIT
import { link, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  MemoryLocalError,
  openMemoryLocal,
  parseMemoryLocalConfig,
} from "../index.js";
import {
  decodeMemoryRow,
  ftsMatchExpression,
  recordLimits,
  type BujoMemoryRow,
} from "../bujo-db.js";
import { reconstructMemoryRecord } from "../records.js";

const signal = new AbortController().signal;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local", () => {
  it("keeps reconstructed metadata on the exact serialized byte boundary", () => {
    const config = parseMemoryLocalConfig(undefined);
    const metadata = {
      "quoted\"\n💾": ["value", { nested: true }],
    };
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
    const record = {
      id: "bounded-metadata",
      text: "Read-path metadata bound.",
      createdAt: "2026-07-24T00:00:00.000Z",
      metadata,
    } satisfies MemoryRecord;

    expect(reconstructMemoryRecord(record, {
      ...recordLimits(config),
      maxMetadataBytes: metadataBytes,
    })).toEqual(record);
    expect(() => reconstructMemoryRecord(record, {
      ...recordLimits(config),
      maxMetadataBytes: metadataBytes - 1,
    })).toThrow(/metadata exceeds/iu);
  });

  it("canonicalizes parseable v0 timestamps without accepting corrupt stored timestamps", () => {
    const row: BujoMemoryRow = {
      id: "v0:legacy-timestamp",
      seq: 1,
      type: "note",
      status: "open",
      text: "Legacy timestamp compatibility.",
      salience: 0.5,
      is_insight: 0,
      created_at: "2026-07-20T12:00:00+02:00",
      last_accessed_at: null,
      access_count: 0,
      valid_from: null,
      valid_to: null,
      superseded_by: null,
      superseded_at: null,
      due_at: null,
      collection: null,
      source_session: null,
      source_file: "daily/2026-07-20.md",
      source_line: 1,
      embedding_model: null,
      dim: null,
      tags: "[]",
    };
    const config = parseMemoryLocalConfig(undefined);

    expect(decodeMemoryRow(row, config).createdAt).toBe("2026-07-20T10:00:00.000Z");
    for (const createdAt of [
      "not-a-timestamp",
      "2026-02-31T00:00:00Z",
      "07/24/2026",
      "2026-07-20 12:00:00",
      "0",
    ]) {
      expect(() => decodeMemoryRow({ ...row, created_at: createdAt }, config))
        .toThrow(/stored BuJo memory row is invalid/iu);
    }
  });

  it("recalls across all 256 candidates when a low-ranked v0 row omits milliseconds", async () => {
    const { root, directory } = await fixture();
    const initialized = await openMemoryLocal(options(root, directory));
    await initialized.stop();
    const databasePath = join(directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const database = new DatabaseSync(databasePath, { allowExtension: true });
    const auditQuery = [
      "This is a read-only execution-evidence audit.",
      "Call the RunHistory tool exactly once.",
      "After the tool returns, reply with exactly the audit marker.",
      "Do not call any other tool.",
    ].join(" ");
    try {
      loadSqliteVec(database);
      database.enableLoadExtension(false);
      const insertMemory = database.prepare(`
        INSERT INTO memories (
          id, seq, type, status, text, salience, is_insight, created_at, tags
        ) VALUES (?, ?, 'note', 'open', ?, 0.5, 0, ?, '[]')
      `);
      const insertFts = database.prepare("INSERT INTO memories_fts(id, text) VALUES (?, ?)");
      const text = "this is a read only audit tool and the other marker";
      database.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 255; index += 1) {
        const id = `candidate-${String(index).padStart(3, "0")}`;
        insertMemory.run(id, index + 1, text, "2026-07-21T12:00:00.000Z");
        insertFts.run(id, text);
      }
      insertMemory.run("candidate-legacy", 256, text, "2026-07-20T12:00:00Z");
      insertFts.run("candidate-legacy", text);
      database.exec("COMMIT");
      const ranked = database.prepare(`
        SELECT f.id AS id
        FROM memories_fts f
        JOIN memories m ON m.id = f.id
        WHERE memories_fts MATCH ?
        ORDER BY bm25(memories_fts), m.created_at DESC, m.id ASC
        LIMIT 256
      `).all(ftsMatchExpression(auditQuery)) as unknown as { id: string }[];
      expect(ranked).toHaveLength(256);
      expect(ranked.at(-1)?.id).toBe("candidate-legacy");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      database.close();
    }

    const memory = await openMemoryLocal(options(root, directory));
    try {
      const recalled = await memory.recall({ query: auditQuery, limit: 8, signal });
      expect(recalled.records).toHaveLength(8);
      expect(recalled.records.some(({ id }) => id === "candidate-legacy")).toBe(false);
    } finally {
      await memory.stop();
    }
  });

  it("strictly validates bounded configuration", () => {
    expect(parseMemoryLocalConfig(undefined).capture.enabled).toBe(false);
    expect(parseMemoryLocalConfig(undefined).capture.receiptRetentionDays).toBe(30);
    expect(parseMemoryLocalConfig(undefined).recallTool.enabled).toBe(true);
    expect(parseMemoryLocalConfig({ recallTool: { enabled: false } }).recallTool.enabled).toBe(false);
    expect(() => parseMemoryLocalConfig({ unknown: true })).toThrow(/unknown field/u);
    expect(() => parseMemoryLocalConfig({ maxBytes: 0 })).toThrow(/maxBytes/u);
    expect(parseMemoryLocalConfig({
      capture: { receiptRetentionDays: 1 },
    }).capture.receiptRetentionDays).toBe(1);
    expect(parseMemoryLocalConfig({
      capture: { receiptRetentionDays: 3_650 },
    }).capture.receiptRetentionDays).toBe(3_650);
    for (const receiptRetentionDays of [0, 3_651]) {
      expect(() => parseMemoryLocalConfig({
        capture: { receiptRetentionDays },
      })).toThrow(/receiptRetentionDays/u);
    }
    expect(() => parseMemoryLocalConfig({ capture: { enabled: true } })).toThrow(/model/u);
    expect(() => parseMemoryLocalConfig({
      capture: {
        enabled: true,
        model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
      },
      embeddings: {
        provider: "ollama",
        endpoint: "http://example.com:11434",
        model: "nomic-embed-text:v1.5",
        dimensions: 768,
      },
    })).toThrow(/literal-loopback/u);
    for (const [endpoint, normalized] of [
      ["https://host:11434/", "https://host:11434"],
      ["http://[::1]:11434", "http://[::1]:11434"],
      ["http://127.0.0.1:11434/api///", "http://127.0.0.1:11434/api"],
    ] as const) {
      expect(parseMemoryLocalConfig({
        embeddings: {
          provider: "ollama",
          endpoint,
          model: "nomic-embed-text:v1.5",
          dimensions: 768,
        },
      }).embeddings?.endpoint).toBe(normalized);
    }
    for (const endpoint of [
      "https://host:11434/?query=yes",
      "http://127.0.0.1:11434/api/#fragment",
    ]) {
      expect(() => parseMemoryLocalConfig({
        embeddings: {
          provider: "ollama",
          endpoint,
          model: "nomic-embed-text:v1.5",
          dimensions: 768,
        },
      })).toThrow(/query or fragment/u);
    }
  });

  it("projects model-visible recall enablement as an immutable capability", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal(options(root, directory, {
      recallTool: { enabled: false },
    }));
    try {
      expect(memory.capabilities).toEqual({ capture: true, forget: true, recallTool: false });
      expect(Object.isFrozen(memory.capabilities)).toBe(true);
    } finally {
      await memory.stop();
    }
  });

  it("creates an owner-private permanent store and performs deterministic recall, capture, and forget", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal({
      ...options(root, directory, captureConfig()),
      host: host(passthroughGrant()),
    });
    try {
      const databasePath = join(directory, MEMORY_LOCAL_DATABASE_FILENAME);
      const markerPath = join(directory, MEMORY_LOCAL_MARKER_FILENAME);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(markerPath, "utf8"))
        .toMatch(/^initialized:[0-9a-f]{8}-[0-9a-f-]{27}\n$/u);

      await memory.capture?.({ record: record("later", "project alpha status", "2026-07-23T12:00:00.000Z"), signal });
      await memory.capture?.({ record: record("earlier", "project alpha status", "2026-07-22T12:00:00.000Z"), signal });
      await memory.capture?.({
        record: record("conversation", "alpha note", "2026-07-21T12:00:00.000Z", { conversationId: "thread-1" }),
        signal,
      });

      const recalled = await memory.recall({ query: "alpha", limit: 3, conversationId: "thread-1", signal });
      expect(recalled.records.map(({ text }) => text)).toEqual([
        "alpha note",
        "project alpha status",
        "project alpha status",
      ]);
      const earlier = recalled.records.find(({ createdAt }) => createdAt === "2026-07-22T12:00:00.000Z")!;
      expect(await memory.forget?.({ recordId: earlier.id, signal })).toBe(true);
      expect(await memory.forget?.({ recordId: earlier.id, signal })).toBe(false);
      expect((await memory.recall({ query: "status", limit: 3, signal })).records.map(({ createdAt }) => createdAt))
        .toEqual(["2026-07-23T12:00:00.000Z"]);
    } finally {
      await memory.stop();
    }

    const reopened = await openMemoryLocal({
      ...options(root, directory, captureConfig()),
      host: host(passthroughGrant()),
    });
    try {
      expect((await reopened.recall({ query: "alpha", limit: 3, signal })).records.map(({ text }) => text))
        .toEqual(["alpha note", "project alpha status"]);
    } finally {
      await reopened.stop();
    }
  });

  it("makes exact duplicates idempotent and conflicting ids atomic", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal({
      ...options(root, directory, captureConfig()),
      host: host(passthroughGrant()),
    });
    try {
      const first = record("stable", "first content", "2026-07-23T12:00:00.000Z");
      await memory.capture?.({ record: first, signal });
      await memory.capture?.({ record: first, signal });
      await expect(memory.capture?.({
        record: record("stable", "changed content", "2026-07-23T12:00:00.000Z"),
        signal,
      })).rejects.toMatchObject({ code: "duplicate_record" });
      expect((await memory.recall({ query: "first", limit: 10, signal })).records).toHaveLength(1);
      expect((await memory.recall({ query: "changed", limit: 10, signal })).records).toHaveLength(0);
    } finally {
      await memory.stop();
    }
  });

  it("requires an explicit host capability and bounds runtime-backed capture", async () => {
    const first = await fixture();
    await expect(openMemoryLocal(options(first.root, first.directory, captureConfig())))
      .rejects.toMatchObject({ code: "runtime_capture_unavailable" });

    const second = await fixture();
    const grant: MemoryRuntimeCaptureGrant = {
      async complete({ input }) {
        return {
          text: "",
          structuredOutput: { records: [{ text: input }, { text: `derived ${input}` }] },
        };
      },
    };
    const memory = await openMemoryLocal({
      ...options(second.root, second.directory, captureConfig()),
      host: host(grant),
    });
    try {
      await memory.capture?.({ record: record("source", "runtime source", "2026-07-23T12:00:00.000Z"), signal });
      const recalled = (await memory.recall({ query: "runtime", limit: 5, signal })).records;
      expect(recalled.map(({ text }) => text).sort()).toEqual(["derived runtime source", "runtime source"]);
      expect(recalled.map(({ id }) => id)).toEqual([
        expect.stringMatching(/^runtime:[a-f0-9]{48}$/u),
        expect.stringMatching(/^runtime:[a-f0-9]{48}$/u),
      ]);
    } finally {
      await memory.stop();
    }

    const third = await fixture();
    const invalid: MemoryRuntimeCaptureGrant = {
      async complete() {
        return { text: "", structuredOutput: { records: [] } };
      },
    };
    const rejecting = await openMemoryLocal({
      ...options(third.root, third.directory, captureConfig()),
      host: host(invalid),
    });
    try {
      await expect(rejecting.capture?.({ record: record("nope", "not persisted", "2026-07-23T12:00:00.000Z"), signal }))
        .rejects.toMatchObject({ code: "runtime_capture_invalid" });
      expect((await rejecting.recall({ query: "persisted", limit: 5, signal })).records).toHaveLength(0);
    } finally {
      await rejecting.stop();
    }
  });

  it("rejects non-empty, incomplete, symlinked, and permission-unsafe stores without repairing them", async () => {
    const nonempty = await fixture();
    await writeFile(join(nonempty.directory, "operator.txt"), "preserve", { mode: 0o600 });
    await expect(openMemoryLocal(options(nonempty.root, nonempty.directory)))
      .rejects.toMatchObject({ code: "incomplete_initialization" });
    expect(await readdir(nonempty.directory)).toEqual(["operator.txt"]);

    const incomplete = await fixture();
    await writeFile(join(incomplete.directory, MEMORY_LOCAL_DATABASE_FILENAME), "not a database", { mode: 0o600 });
    await expect(openMemoryLocal(options(incomplete.root, incomplete.directory)))
      .rejects.toMatchObject({ code: "incomplete_initialization" });

    const inFlight = await fixture();
    const inFlightMemory = await openMemoryLocal(options(inFlight.root, inFlight.directory));
    await inFlightMemory.stop();
    const markerPath = join(inFlight.directory, MEMORY_LOCAL_MARKER_FILENAME);
    const initializedMarker = await readFile(markerPath, "utf8");
    await writeFile(markerPath, initializedMarker.replace(/^initialized:/u, "initializing:"), { mode: 0o600 });
    await expect(openMemoryLocal(options(inFlight.root, inFlight.directory)))
      .rejects.toMatchObject({ code: "incomplete_initialization" });
    expect(await readFile(markerPath, "utf8")).toMatch(/^initializing:/u);

    const linked = await fixture();
    const actual = join(linked.root, "actual");
    await mkdir(actual, { mode: 0o700 });
    const linkPath = join(linked.root, "linked");
    await symlink(actual, linkPath);
    await expect(openMemoryLocal(options(linked.root, linkPath))).rejects.toMatchObject({ code: "unsafe_store" });

    const unsafeMode = await fixture();
    const initialized = await openMemoryLocal(options(unsafeMode.root, unsafeMode.directory));
    await initialized.stop();
    const databasePath = join(unsafeMode.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    await chmod(databasePath, 0o644);
    await expect(openMemoryLocal(options(unsafeMode.root, unsafeMode.directory))).rejects.toMatchObject({ code: "unsafe_store" });
    expect((await stat(databasePath)).mode & 0o777).toBe(0o644);
  });

  it("rejects hard-linked files and exact-byte marker mutation", async () => {
    const hardLinked = await fixture();
    const initialized = await openMemoryLocal(options(hardLinked.root, hardLinked.directory));
    await initialized.stop();
    const databasePath = join(hardLinked.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    await link(databasePath, join(hardLinked.root, "database-link"));
    await expect(openMemoryLocal(options(hardLinked.root, hardLinked.directory))).rejects.toMatchObject({ code: "unsafe_store" });

    const mutated = await fixture();
    const memory = await openMemoryLocal(options(mutated.root, mutated.directory));
    try {
      const markerPath = join(mutated.directory, MEMORY_LOCAL_MARKER_FILENAME);
      const original = await readFile(markerPath, "utf8");
      await writeFile(markerPath, ` ${original}`, { mode: 0o600 });
      await expect(memory.recall({ query: "anything", limit: 1, signal })).rejects.toBeInstanceOf(MemoryLocalError);
    } finally {
      await memory.stop();
    }
  });

  it("fails closed on database and marker pathname replacement without mutating replacement targets", async () => {
    const databaseSwap = await fixture();
    const memory = await openMemoryLocal(options(databaseSwap.root, databaseSwap.directory));
    const databasePath = join(databaseSwap.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const originalDatabase = join(databaseSwap.directory, "original.sqlite");
    await rename(databasePath, originalDatabase);
    const replacementDatabase = Buffer.from("operator replacement must remain unchanged");
    await writeFile(databasePath, replacementDatabase, { mode: 0o600 });
    try {
      await expect(memory.recall({ query: "anything", limit: 1, signal }))
        .rejects.toMatchObject({ code: "unsafe_store" });
      expect(await readFile(databasePath)).toEqual(replacementDatabase);
    } finally {
      await memory.stop();
    }

    const markerSwap = await fixture();
    const second = await openMemoryLocal(options(markerSwap.root, markerSwap.directory));
    const markerPath = join(markerSwap.directory, MEMORY_LOCAL_MARKER_FILENAME);
    await rename(markerPath, join(markerSwap.directory, "original.marker"));
    const replacementMarker = Buffer.from("initialized:00000000-0000-0000-0000-000000000000\n");
    await writeFile(markerPath, replacementMarker, { mode: 0o600 });
    try {
      await expect(second.recall({ query: "anything", limit: 1, signal }))
        .rejects.toMatchObject({ code: "unsafe_store" });
      expect(await readFile(markerPath)).toEqual(replacementMarker);
    } finally {
      await second.stop();
    }

    const databaseSymlink = await fixture();
    const third = await openMemoryLocal(options(databaseSymlink.root, databaseSymlink.directory));
    await third.stop();
    const symlinkDatabasePath = join(databaseSymlink.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const symlinkTarget = join(databaseSymlink.directory, "database-target.sqlite");
    await rename(symlinkDatabasePath, symlinkTarget);
    const targetBefore = await readFile(symlinkTarget);
    await symlink(symlinkTarget, symlinkDatabasePath);
    await expect(openMemoryLocal(options(databaseSymlink.root, databaseSymlink.directory)))
      .rejects.toMatchObject({ code: "unsafe_store" });
    expect(await readFile(symlinkTarget)).toEqual(targetBefore);
  });

  it("fails closed on database corruption and preserves the corrupt bytes", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal(options(root, directory));
    await memory.capture?.({ record: record("one", "persistent data", "2026-07-23T12:00:00.000Z"), signal });
    await memory.stop();
    const databasePath = join(directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const corrupt = Buffer.from("this is deliberately not sqlite");
    await writeFile(databasePath, corrupt, { mode: 0o600 });
    await expect(openMemoryLocal(options(root, directory))).rejects.toMatchObject({ code: "corrupt_store" });
    expect(await readFile(databasePath)).toEqual(corrupt);
  });

  it("keeps new writes strict and rejects semantically invalid stored rows on reopen", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal({
      ...options(root, directory, captureConfig()),
      host: host(passthroughGrant()),
    });
    await expect(memory.capture?.({
      record: record("noncanonical-input", "new input remains strict", "2026-07-23T12:00:00Z"),
      signal,
    })).rejects.toMatchObject({ code: "invalid_record" });
    await memory.capture?.({
      record: record("persisted", "stored row admission", "2026-07-23T12:00:00.000Z"),
      signal,
    });
    await memory.stop();

    const databasePath = join(directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const database = new DatabaseSync(databasePath, { allowExtension: true });
    try {
      loadSqliteVec(database);
      database.enableLoadExtension(false);
      database.prepare("UPDATE memories SET created_at = ?").run("not-a-timestamp");
    } finally {
      database.close();
    }

    await expect(openMemoryLocal(options(root, directory)))
      .rejects.toMatchObject({ code: "corrupt_store" });
    const inspection = new DatabaseSync(databasePath, { allowExtension: true });
    try {
      loadSqliteVec(inspection);
      inspection.enableLoadExtension(false);
      expect((inspection.prepare("SELECT created_at FROM memories LIMIT 1").get() as {
        created_at: string;
      }).created_at).toBe("not-a-timestamp");
    } finally {
      inspection.close();
    }
  });

  it("rejects oversized stored metadata before semantic row materialization", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal({
      ...options(root, directory, captureConfig()),
      host: host(passthroughGrant()),
    });
    await memory.capture?.({
      record: record("persisted", "stored metadata admission", "2026-07-23T12:00:00.000Z"),
      signal,
    });
    await memory.stop();

    const databasePath = join(directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const database = new DatabaseSync(databasePath, { allowExtension: true });
    try {
      loadSqliteVec(database);
      database.enableLoadExtension(false);
      database.prepare("UPDATE memories SET tags = ?")
        .run(JSON.stringify(["x".repeat(64 * 1024)]));
    } finally {
      database.close();
    }

    await expect(openMemoryLocal(options(root, directory)))
      .rejects.toMatchObject({ code: "corrupt_store" });
  });

  it("rejects invalid SQLite storage classes before materializing stored values", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal({
      ...options(root, directory, captureConfig()),
      host: host(passthroughGrant()),
    });
    await memory.capture?.({
      record: record("persisted", "stored class admission", "2026-07-23T12:00:00.000Z"),
      signal,
    });
    await memory.stop();

    const databasePath = join(directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const database = new DatabaseSync(databasePath, { allowExtension: true });
    try {
      loadSqliteVec(database);
      database.enableLoadExtension(false);
      database.prepare("UPDATE memories SET salience = zeroblob(?)").run(128 * 1024);
      expect((database.prepare("SELECT typeof(salience) AS storage FROM memories LIMIT 1").get() as {
        storage: string;
      }).storage).toBe("blob");
    } finally {
      database.close();
    }

    await expect(openMemoryLocal(options(root, directory)))
      .rejects.toMatchObject({ code: "corrupt_store" });
  });
});

async function fixture(): Promise<{ root: string; directory: string }> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-local-test-"));
  const root = await realpath(authored);
  roots.push(root);
  const directory = join(root, "memory");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory };
}

function options(root: string, directory: string, config: unknown = {}): {
  config: unknown;
  configDirectory: string;
  dataDirectory: string;
} {
  return { config, configDirectory: root, dataDirectory: directory };
}

function record(
  id: string,
  text: string,
  createdAt: string,
  metadata?: Readonly<Record<string, string>>,
): MemoryRecord {
  return { id, text, createdAt, ...(metadata === undefined ? {} : { metadata }) };
}

function host(grant: MemoryRuntimeCaptureGrant): MemoryHost {
  return {
    grantedCapabilities: new Set([HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE]),
    getCapability<T = unknown>(_name: string): T | undefined { return undefined; },
    runtimeCapture: grant,
  };
}

function captureConfig(): unknown {
  return {
    capture: {
      enabled: true,
      model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
      timeoutMs: 5_000,
    },
  };
}

function passthroughGrant(): MemoryRuntimeCaptureGrant {
  return {
    async complete({ input }) {
      return { text: "", structuredOutput: { records: [{ text: input }] } };
    },
  };
}
