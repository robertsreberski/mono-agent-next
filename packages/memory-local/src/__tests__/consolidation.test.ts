// SPDX-License-Identifier: MIT
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
  type MemoryHost,
  type MemoryRecord,
  type MemoryRuntimeCaptureGrant,
  type ModuleCommand,
  type ModuleLogger,
} from "@mono-agent/module-sdk";

import {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_FUTURE_LOG_FILENAME,
  MEMORY_LOCAL_INDEX_FILENAME,
  type MemoryEmbeddingProvider,
} from "../index.js";
import { boundedInlineForTesting } from "../consolidation.js";
import { openMemoryLocalForTesting as openMemoryLocal } from "../store.js";

const signal = new AbortController().signal;
const roots: string[] = [];
const logger: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local deterministic consolidation", () => {
  it("clips multibyte projection text on the 4096-byte UTF-8 boundary", () => {
    const rendered = boundedInlineForTesting(`${"a".repeat(4_092)}💾tail`, 4_096);

    expect(rendered.endsWith("…")).toBe(true);
    expect(rendered).not.toContain("\uFFFD");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("refreshes bounded projections idempotently without canonical, model, or embedding writes", async () => {
    const fixture = await createFixture();
    let modelCalls = 0;
    const grant: MemoryRuntimeCaptureGrant = {
      async complete({ input }) {
        modelCalls += 1;
        return { text: "", structuredOutput: { records: [{ text: input }] } };
      },
    };
    const embeddings = new CountingEmbeddings(3);
    const memory = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(grant),
      embeddingProvider: embeddings,
    });
    try {
      await memory.capture?.({
        record: record("turn-1", "Morgan prefers opt-in memory.", "2026-07-20T10:00:00.000Z"),
        signal,
      });
      await memory.capture?.({
        record: record("turn-2", "morgan prefers opt in memory", "2026-07-21T10:00:00.000Z"),
        signal,
      });
      await memory.capture?.({
        record: record("turn-3", "The launch date is March 3rd.", "2026-07-22T10:00:00.000Z"),
        signal,
      });
      await memory.capture?.({
        record: record("turn-4", `Bounded projection ${"z".repeat(32_000)}`, "2026-07-23T10:00:00.000Z"),
        signal,
      });
      const canonicalBefore = canonicalSnapshot(fixture.directory);
      const modelCallsBefore = modelCalls;
      const embeddingCallsBefore = embeddings.calls;

      await expect(openMemoryLocal(options(fixture, { capture: { enabled: false } })))
        .rejects.toMatchObject({ code: "writer_active" });

      const first = await memory.consolidate({ signal });
      const firstIndex = await readFile(
        join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME),
        "utf8",
      );
      const firstFutureLog = await readFile(
        join(fixture.directory, MEMORY_LOCAL_FUTURE_LOG_FILENAME),
        "utf8",
      );
      expect(first).toEqual({
        duplicateGroups: 1,
        records: 4,
        entities: 0,
        indexBytes: Buffer.byteLength(firstIndex),
        futureLogBytes: Buffer.byteLength(firstFutureLog),
      });
      expect(first.indexBytes).toBeLessThan(16 * 1024);
      expect(firstFutureLog).toBe("# Future Log\n");
      expect(firstIndex).toContain("# Index");
      expect(firstIndex).toContain("Morgan prefers opt-in memory.");
      expect(firstIndex).toContain("Bounded projection");
      expect(firstIndex).toContain("…");

      await expect(memory.consolidate({ signal })).resolves.toEqual(first);
      expect(await readFile(join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME), "utf8"))
        .toBe(firstIndex);
      expect(await readFile(join(fixture.directory, MEMORY_LOCAL_FUTURE_LOG_FILENAME), "utf8"))
        .toBe(firstFutureLog);
      expect(canonicalSnapshot(fixture.directory)).toEqual(canonicalBefore);
      expect(modelCalls).toBe(modelCallsBefore);
      expect(embeddings.calls).toBe(embeddingCallsBefore);

      const command = findCommand(memory.commands, "memory-local:consolidate");
      await expect(command.run(undefined, { signal, logger })).resolves.toEqual(first);
      expect(JSON.stringify(await command.run({}, { signal, logger })).length).toBeLessThan(512);
      expect(modelCalls).toBe(modelCallsBefore);
      expect(embeddings.calls).toBe(embeddingCallsBefore);
    } finally {
      await memory.stop();
    }
  });

  it("keeps the prior projection on a pre-commit crash, redacts the error, and retries", async () => {
    const fixture = await createFixture();
    let failBeforeCommit = false;
    const memory = await openMemoryLocal({
      ...options(fixture, captureConfig()),
      host: runtimeHost(passthroughGrant()),
      hooks: {
        beforeConsolidationCommit() {
          if (failBeforeCommit) {
            throw Object.assign(new Error("sk-private-projection-secret"), {
              code: "ERR_PRIVATE_sk-private",
            });
          }
        },
      },
    });
    try {
      await memory.capture?.({
        record: record("old", "Old projection fact", "2026-07-20T10:00:00.000Z"),
        signal,
      });
      await memory.consolidate({ signal });
      const oldIndex = await readFile(join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME), "utf8");
      const oldFutureLog = await readFile(
        join(fixture.directory, MEMORY_LOCAL_FUTURE_LOG_FILENAME),
        "utf8",
      );
      await memory.capture?.({
        record: record("new", "New projection fact", "2026-07-21T10:00:00.000Z"),
        signal,
      });
      const canonicalBeforeFailure = canonicalSnapshot(fixture.directory);

      failBeforeCommit = true;
      let failure: unknown;
      try {
        await memory.consolidate({ signal });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "maintenance_failed",
        message: expect.not.stringContaining("sk-private"),
      });
      expect((failure as Error & { cause?: Error }).cause?.message)
        .not.toContain("sk-private");
      expect(await readFile(join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME), "utf8"))
        .toBe(oldIndex);
      expect(await readFile(join(fixture.directory, MEMORY_LOCAL_FUTURE_LOG_FILENAME), "utf8"))
        .toBe(oldFutureLog);
      expect((await readdir(fixture.directory)).filter((name) =>
        /^\.memory-local-(?:index|future-log)-.+\.tmp$/u.test(name))).toEqual([]);
      expect(canonicalSnapshot(fixture.directory)).toEqual(canonicalBeforeFailure);

      failBeforeCommit = false;
      await expect(memory.consolidate({ signal })).resolves.toMatchObject({
        duplicateGroups: 0,
        records: 2,
      });
      expect(await readFile(join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME), "utf8"))
        .toContain("New projection fact");
    } finally {
      await memory.stop();
    }
  });

  it("strict audit labels an incomplete or unsafe projection pair without repairing it", async () => {
    const fixture = await createFixture();
    let failBeforeCommit = true;
    const memory = await openMemoryLocal({
      ...options(fixture, captureConfig()),
      host: runtimeHost(passthroughGrant()),
      hooks: {
        beforeConsolidationCommit() {
          if (failBeforeCommit) throw new Error("crash after companion publication");
        },
      },
    });
    try {
      await memory.capture?.({
        record: record("audit-source", "Projection audit fact", "2026-07-23T10:00:00.000Z"),
        signal,
      });
      const canonical = canonicalSnapshot(fixture.directory);
      await expect(memory.consolidate({ signal }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      await expect(readFile(join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(
        join(fixture.directory, MEMORY_LOCAL_FUTURE_LOG_FILENAME),
        "utf8",
      )).toBe("# Future Log\n");
      await expect(memory.audit({ signal })).resolves.toMatchObject({
        status: "degraded",
        projections: {
          index: "missing",
          futureLog: "ready",
          complete: false,
          coherent: false,
        },
      });
      await expect(memory.audit({ signal, strict: true }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      expect(canonicalSnapshot(fixture.directory)).toEqual(canonical);

      failBeforeCommit = false;
      await memory.consolidate({ signal });
      await expect(memory.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        projections: {
          index: "ready",
          futureLog: "ready",
          complete: true,
          coherent: true,
        },
      });

      const indexPath = join(fixture.directory, MEMORY_LOCAL_INDEX_FILENAME);
      const outside = join(fixture.root, "outside-index.md");
      await writeFile(outside, "operator data must remain unchanged\n", { mode: 0o600 });
      await rm(indexPath);
      await symlink(outside, indexPath);
      const outsideBefore = await readFile(outside);
      await expect(memory.audit({ signal })).resolves.toMatchObject({
        status: "degraded",
        projections: { index: "unsafe", futureLog: "ready", coherent: false },
      });
      await expect(memory.audit({ signal, strict: true }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      expect(await readFile(outside)).toEqual(outsideBefore);
      expect(canonicalSnapshot(fixture.directory)).toEqual(canonical);
    } finally {
      await memory.stop();
    }
  });
});

describe("memory-local maintenance commands", () => {
  it("exposes bounded schemas and requires explicit rebuild and forget authorization", async () => {
    const fixture = await createFixture();
    const embeddings = new CountingEmbeddings(3);
    const memory = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: embeddings,
    });
    const backup = await createEmptyDirectory(fixture.root, "backup");
    try {
      await memory.capture?.({
        record: record("command-source", "Command target fact", "2026-07-23T10:00:00.000Z"),
        signal,
      });
      const recordId = (await memory.recall({
        query: "Command target",
        limit: 1,
        signal,
      })).records[0]!.id;
      expect(memory.commands.map(({ name }) => name)).toEqual([
        "memory-local:audit",
        "memory-local:backup",
        "memory-local:rebuild",
        "memory-local:forget",
        "memory-local:consolidate",
        "memory-local:retry",
      ]);
      for (const command of memory.commands) {
        expect(command.name).toMatch(/^memory-local:/u);
        expect(command.kind).toBe("maintenance");
        expect(command.inputSchema).toBeDefined();
      }
      expect(findCommand(memory.commands, "memory-local:rebuild").inputSchema)
        .toMatchObject({
          required: ["confirm"],
          properties: { confirm: { const: true } },
        });
      expect(findCommand(memory.commands, "memory-local:forget").inputSchema)
        .toMatchObject({
          oneOf: [
            { required: ["recordId"] },
            { required: ["recordId", "dryRun", "confirm"] },
          ],
        });
      expect(findCommand(memory.commands, "memory-local:retry").inputSchema)
        .toMatchObject({
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1_000, default: 32 },
          },
        });

      await expect(findCommand(memory.commands, "memory-local:audit")
        .run({ strict: true }, { signal, logger })).resolves.toMatchObject({
          status: "healthy",
          records: 1,
          receipts: {
            count: 1,
            capacity: 100_000,
            lowWatermark: 90_000,
          },
        });
      const backupCommand = findCommand(memory.commands, "memory-local:backup");
      await expect(backupCommand.run(undefined, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      await expect(backupCommand
        .run({ destinationDirectory: backup }, { signal, logger })).resolves.toMatchObject({
          directory: backup,
          recordCount: 1,
          databaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });

      const rebuild = findCommand(memory.commands, "memory-local:rebuild");
      const embeddingCallsBefore = embeddings.calls;
      await expect(rebuild.run(undefined, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      await expect(rebuild.run({}, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      await expect(rebuild.run({ confirm: false }, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      expect(embeddings.calls).toBe(embeddingCallsBefore);
      await expect(rebuild.run({ confirm: true }, { signal, logger }))
        .resolves.toMatchObject({ records: 1, ftsIndexed: 1, vectorsIndexed: 1 });
      expect(embeddings.calls).toBeGreaterThan(embeddingCallsBefore);

      const forget = findCommand(memory.commands, "memory-local:forget");
      let getterInvoked = false;
      const hostile = {};
      Object.defineProperty(hostile, "recordId", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return recordId;
        },
      });
      await expect(forget.run(hostile, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      expect(getterInvoked).toBe(false);

      await expect(forget.run({ recordId }, { signal, logger })).resolves.toMatchObject({
        operation: "preview",
        dryRun: true,
        found: true,
        record: { id: recordId, text: "Command target fact" },
      });
      await expect(forget.run({ recordId, dryRun: false }, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      await expect(forget.run({ recordId, dryRun: true, confirm: true }, { signal, logger }))
        .rejects.toMatchObject({ code: "maintenance_failed" });
      expect((await memory.recall({ query: "target", limit: 1, signal })).records)
        .toHaveLength(1);
      await expect(forget.run({
        recordId,
        dryRun: false,
        confirm: true,
      }, { signal, logger })).resolves.toEqual({
        operation: "forget",
        dryRun: false,
        confirmed: true,
        recordId,
        forgotten: true,
      });
      await expect(forget.run({ recordId }, { signal, logger })).resolves.toMatchObject({
        operation: "preview",
        found: false,
      });
    } finally {
      await memory.stop();
    }
  }, 15_000);

  it("retries bounded durable intake through a running host command", async () => {
    const fixture = await createFixture();
    let captureAvailable = false;
    const grant: MemoryRuntimeCaptureGrant = {
      async complete({ input }) {
        if (!captureAvailable) throw new Error("runtime unavailable");
        return { text: "", structuredOutput: { records: [{ text: input }] } };
      },
    };
    const memory = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(grant),
      embeddingProvider: new CountingEmbeddings(3),
    });
    try {
      await expect(memory.capture?.({
        record: record("retry-command", "Remember the violet bicycle.", "2026-07-23T11:00:00.000Z"),
        signal,
      })).rejects.toMatchObject({ code: "runtime_capture_invalid" });

      const retry = findCommand(memory.commands, "memory-local:retry");
      for (const input of [{ limit: 0 }, { limit: 1_001 }, { limit: 1.5 }, { extra: true }]) {
        await expect(retry.run(input, { signal, logger }))
          .rejects.toMatchObject({ code: "maintenance_failed" });
      }

      captureAvailable = true;
      await expect(retry.run({ limit: 1 }, { signal, logger })).resolves.toEqual({
        capturesRetried: 1,
        vectorsRetried: 0,
        failed: 0,
        remainingCaptures: 0,
        remainingVectors: 0,
      });
      await expect(retry.run(undefined, { signal, logger })).resolves.toEqual({
        capturesRetried: 0,
        vectorsRetried: 0,
        failed: 0,
        remainingCaptures: 0,
        remainingVectors: 0,
      });
      expect((await memory.recall({ query: "violet bicycle", limit: 1, signal })).records)
        .toHaveLength(1);
    } finally {
      await memory.stop();
    }
  });
});

class CountingEmbeddings implements MemoryEmbeddingProvider {
  readonly id = "ollama:nomic-embed-text:v1.5";
  calls = 0;

  constructor(readonly dimensions: number) {}

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.calls += 1;
    return texts.map((text) => {
      const values = Array.from({ length: this.dimensions }, () => 0);
      values[Buffer.byteLength(text) % this.dimensions] = 1;
      return Object.freeze(values);
    });
  }
}

async function createFixture(): Promise<{ readonly root: string; readonly directory: string }> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-consolidation-"));
  const root = await realpath(authored);
  roots.push(root);
  const directory = await createEmptyDirectory(root, "memory");
  return { root, directory };
}

async function createEmptyDirectory(root: string, name: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

function options(
  fixture: { readonly root: string; readonly directory: string },
  config: unknown,
): { readonly config: unknown; readonly configDirectory: string; readonly dataDirectory: string } {
  return {
    config,
    configDirectory: fixture.root,
    dataDirectory: fixture.directory,
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

function memoryConfig(dimensions: number): unknown {
  return {
    ...captureConfig() as Record<string, unknown>,
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
      return { text: "", structuredOutput: { records: [{ text: input }] } };
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

function findCommand(commands: readonly ModuleCommand[], name: string): ModuleCommand {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) throw new Error(`Missing command ${name}`);
  return command;
}

function canonicalSnapshot(directory: string): unknown {
  const database = new DatabaseSync(join(directory, MEMORY_LOCAL_DATABASE_FILENAME), {
    allowExtension: true,
    readOnly: true,
  });
  try {
    loadSqliteVec(database);
    database.enableLoadExtension(false);
    const tables = [
      "memories",
      "edges",
      "entities",
      "entity_relations",
      "memory_entities",
      "content_hashes",
      "index_metadata",
    ] as const;
    return tables.map((table) => ({
      table,
      rows: database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    }));
  } finally {
    database.close();
  }
}
