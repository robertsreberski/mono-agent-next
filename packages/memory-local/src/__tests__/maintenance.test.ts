// SPDX-License-Identifier: MIT
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
  type MemoryHost,
  type MemoryRecord,
  type MemoryRuntimeCaptureGrant,
} from "@mono-agent/module-sdk";

import {
  MEMORY_LOCAL_DATABASE_FILENAME,
  type MemoryEmbeddingProvider,
} from "../index.js";
import {
  captureReceiptKey,
  getMetadata,
  openBujoDatabase,
  setMetadata,
} from "../bujo-db.js";
import { openMemoryLocalForTesting as openMemoryLocal } from "../store.js";

const signal = new AbortController().signal;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local maintenance and recovery", () => {
  it("fences concurrent writers and reopens after the live writer releases its OS lock", async () => {
    const fixture = await createFixture();
    const first = await openMemoryLocal(options(fixture, { capture: { enabled: false } }));
    try {
      await expect(openMemoryLocal(options(fixture, { capture: { enabled: false } })))
        .rejects.toMatchObject({ code: "writer_active" });
    } finally {
      await first.stop();
    }

    const recovered = await openMemoryLocal(options(fixture, { capture: { enabled: false } }));
    await expect(recovered.audit({ signal, strict: true })).resolves.toMatchObject({
      status: "healthy",
      records: 0,
    });
    await recovered.stop();
  });

  it("audits, previews, backs up, rebuilds, forgets, and reopens a vector plus FTS store", async () => {
    const fixture = await createFixture();
    const provider = new DeterministicEmbeddingProvider(3);
    const config = memoryConfig(3);
    const memory = await openMemoryLocal({
      ...options(fixture, config),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    const backup = await createEmptyDirectory(fixture.root, "backup");
    try {
      await memory.capture?.({
        record: record("turn-one", "apples are stocked in the cellar", "2026-07-20T10:00:00.000Z"),
        signal,
      });
      await memory.capture?.({
        record: record("turn-two", "quarterly planning is next Tuesday", "2026-07-21T10:00:00.000Z"),
        signal,
      });

      const audit = await memory.audit({ signal, strict: true });
      expect(audit).toMatchObject({
        status: "healthy",
        records: 2,
        fts: { indexed: 2, missing: 0, orphaned: 0 },
        vectors: { indexed: 2, dimensions: 3, configured: true, compatible: true },
        intake: { captures: 0, vectors: 0 },
      });

      const semantic = await memory.recall({ query: "fruit inventory", limit: 1, signal });
      expect(semantic.records[0]?.text).toContain("apples");

      const preview = await memory.previewForget(semantic.records[0]!.id, signal);
      expect(preview).toMatchObject({ found: true, vectorPresent: true });
      expect(preview.record?.text).toContain("apples");

      await expect(memory.backup({ destinationDirectory: backup, signal })).resolves.toMatchObject({
        directory: backup,
        recordCount: 2,
        databaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        markerSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      await expect(memory.rebuild({ signal })).resolves.toMatchObject({
        records: 2,
        ftsIndexed: 2,
        vectorsIndexed: 2,
        vectorDimensions: 3,
      });
      await expect(memory.forget?.({ recordId: semantic.records[0]!.id, signal })).resolves.toBe(true);
      await expect(memory.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        records: 1,
      });
    } finally {
      await memory.stop();
    }

    const backupMemory = await openMemoryLocal({
      config,
      configDirectory: fixture.root,
      dataDirectory: backup,
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    try {
      await expect(backupMemory.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        records: 2,
      });
      expect((await backupMemory.recall({ query: "cellar", limit: 2, signal })).records[0]?.text)
        .toContain("apples");
    } finally {
      await backupMemory.stop();
    }
  });

  it.each([
    ["the last derived record", ["receipt fact alpha"]],
    ["one of multiple derived records", ["receipt fact alpha", "receipt fact beta"]],
  ])("keeps replay idempotent after forgetting %s", async (_case, facts) => {
    const fixture = await createFixture();
    const provider = new DeterministicEmbeddingProvider(3);
    const source = record(
      `forget-source-${String(facts.length)}`,
      "completed turn for receipt-aware forgetting",
      "2026-07-23T12:00:00.000Z",
    );
    let captureCalls = 0;
    const grant: MemoryRuntimeCaptureGrant = {
      async complete() {
        captureCalls += 1;
        return {
          text: "",
          structuredOutput: {
            records: facts.map((text) => ({ text })),
          },
        };
      },
    };
    const open = () => openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(grant),
      embeddingProvider: provider,
    });

    const original = await open();
    const survivorCount = facts.length - 1;
    try {
      await original.capture?.({ record: source, signal });
      expect(captureCalls).toBe(1);
      const recalled = await original.recall({
        query: "receipt fact",
        limit: facts.length,
        signal,
      });
      expect(recalled.records).toHaveLength(facts.length);
      const target = recalled.records.find(({ text }) => text === facts[0])!;
      await expect(original.previewForget(target.id, signal)).resolves.toMatchObject({
        found: true,
        vectorPresent: true,
      });
      await expect(original.forget?.({ recordId: target.id, signal })).resolves.toBe(true);
      await expect(original.forget?.({ recordId: target.id, signal })).resolves.toBe(false);
      await expect(original.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        records: survivorCount,
        fts: { indexed: survivorCount, missing: 0, orphaned: 0 },
        vectors: { indexed: survivorCount, missing: 0 },
        intake: { captures: 0, vectors: 0 },
      });
    } finally {
      await original.stop();
    }

    const replayed = await open();
    try {
      await expect(replayed.capture?.({ record: source, signal })).resolves.toBeUndefined();
      expect(captureCalls).toBe(1);
      await expect(replayed.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        records: survivorCount,
        fts: { indexed: survivorCount, missing: 0, orphaned: 0 },
        vectors: { indexed: survivorCount, missing: 0 },
        intake: { captures: 0, vectors: 0 },
      });
      const recalled = await replayed.recall({
        query: "receipt fact",
        limit: Math.max(1, facts.length),
        signal,
      });
      expect(recalled.records.map(({ text }) => text)).toEqual(facts.slice(1));
    } finally {
      await replayed.stop();
    }
  });

  it("fails strict audit on dangling receipts and rolls back forget on malformed receipts", async () => {
    const fixture = await createFixture();
    const source = record(
      "receipt-integrity-source",
      "receipt integrity fact",
      "2026-07-23T12:00:00.000Z",
    );
    const original = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: new DeterministicEmbeddingProvider(3),
    });
    await original.capture?.({ record: source, signal });
    const target = (await original.recall({
      query: "receipt integrity",
      limit: 1,
      signal,
    })).records[0]!;
    await original.stop();

    const databasePath = join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME);
    const corrupted = openBujoDatabase(databasePath);
    const receiptKey = captureReceiptKey(source.id);
    const receipt = JSON.parse(getMetadata(corrupted, receiptKey)!) as {
      version: 1;
      sourceHash: string;
      recordIds: string[];
    };
    setMetadata(corrupted, receiptKey, JSON.stringify({
      ...receipt,
      recordIds: [...receipt.recordIds, `runtime:${"f".repeat(48)}`],
    }));
    corrupted.close();

    const dangling = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: new DeterministicEmbeddingProvider(3),
    });
    await expect(dangling.audit({ signal, strict: true }))
      .rejects.toMatchObject({ code: "corrupt_store" });
    await dangling.stop();

    const malformed = openBujoDatabase(databasePath);
    setMetadata(
      malformed,
      receiptKey,
      JSON.stringify(receipt),
    );
    const malformedReceiptKey = captureReceiptKey("zzzz-unrelated-source");
    expect(receiptKey < malformedReceiptKey).toBe(true);
    setMetadata(malformed, malformedReceiptKey, "{");
    malformed.close();

    const protectedStore = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: new DeterministicEmbeddingProvider(3),
    });
    try {
      await expect(protectedStore.forget?.({ recordId: target.id, signal }))
        .rejects.toMatchObject({ code: "corrupt_store" });
      await expect(protectedStore.previewForget(target.id, signal)).resolves.toMatchObject({
        found: true,
        vectorPresent: true,
      });
      expect((await protectedStore.recall({
        query: "receipt integrity",
        limit: 1,
        signal,
      })).records[0]?.id).toBe(target.id);
    } finally {
      await protectedStore.stop();
    }
  });

  it("checks capture-receipt integrity beyond the first bounded keyset page", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(
      fixture,
      { capture: { enabled: false } },
    ));
    await initialized.stop();

    const database = openBujoDatabase(
      join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME),
    );
    const receipts = Array.from({ length: 513 }, (_, index) => ({
      key: captureReceiptKey(`paged-receipt-${String(index).padStart(3, "0")}`),
      sourceHash: index.toString(16).padStart(64, "0"),
    })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const insert = database.prepare(
      "INSERT INTO index_metadata(key, value) VALUES (?, ?)",
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, receipt] of receipts.entries()) {
        insert.run(receipt.key, JSON.stringify({
          recordIds: index === receipts.length - 1
            ? [`runtime:${"f".repeat(48)}`]
            : [],
          sourceHash: receipt.sourceHash,
          version: 1,
        }));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    const audited = await openMemoryLocal(options(
      fixture,
      { capture: { enabled: false } },
    ));
    try {
      await expect(audited.audit({ signal, strict: true }))
        .rejects.toMatchObject({ code: "corrupt_store" });
    } finally {
      await audited.stop();
    }
  });

  it("keeps failed capture and vector intake retryable without exposing provider errors", async () => {
    const fixture = await createFixture();
    let captureAvailable = false;
    const grant: MemoryRuntimeCaptureGrant = {
      async complete({ input }) {
        if (!captureAvailable) throw new Error("runtime token sk-private-runtime-value");
        return { text: "", structuredOutput: { records: [{ text: input }] } };
      },
    };
    let embeddingsAvailable = false;
    let now = Date.parse("2026-07-23T12:00:00.000Z");
    const provider = new DeterministicEmbeddingProvider(3, () => embeddingsAvailable);
    const memory = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(grant),
      embeddingProvider: provider,
      clock: () => new Date(now),
    });
    try {
      await expect(memory.capture?.({
        record: record("retry-capture", "remember the blue bicycle", "2026-07-22T10:00:00.000Z"),
        signal,
      })).rejects.toMatchObject({
        code: "runtime_capture_invalid",
        message: expect.not.stringContaining("sk-private"),
      });
      await expect(memory.audit({ signal })).resolves.toMatchObject({
        status: "degraded",
        records: 0,
        intake: { captures: 1, vectors: 0 },
      });

      captureAvailable = true;
      await expect(memory.retryIntake({ signal })).resolves.toMatchObject({
        capturesRetried: 1,
        vectorsRetried: 0,
        failed: 1,
        remainingCaptures: 0,
        remainingVectors: 1,
      });
      expect((await memory.recall({ query: "bicycle", limit: 1, signal })).records[0]?.text)
        .toContain("blue bicycle");
      await expect(memory.health({ signal })).resolves.toMatchObject({
        status: "degraded",
        summary: expect.not.stringContaining("sk-private"),
      });

      embeddingsAvailable = true;
      now += 101;
      await expect(memory.retryIntake({ signal })).resolves.toMatchObject({
        vectorsRetried: 1,
        failed: 0,
        remainingCaptures: 0,
        remainingVectors: 0,
      });
      await expect(memory.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        vectors: { indexed: 1 },
      });
    } finally {
      await memory.stop();
    }
  });

  it("atomically rolls back a crashed capture commit and converges after restart", async () => {
    const fixture = await createFixture();
    let embeddingsAvailable = false;
    let crashBeforeCommit = true;
    const provider = new DeterministicEmbeddingProvider(3, () => embeddingsAvailable);
    const source = record(
      "atomic-capture",
      "remember the red bicycle",
      "2026-07-22T11:00:00.000Z",
    );
    const crashed = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
      hooks: {
        beforeCaptureCommit() {
          if (!crashBeforeCommit) return;
          crashBeforeCommit = false;
          throw new Error("simulated crash before atomic capture commit");
        },
      },
    });
    await expect(crashed.capture?.({ record: source, signal }))
      .rejects.toThrow("simulated crash before atomic capture commit");
    await expect(crashed.audit({ signal })).resolves.toMatchObject({
      status: "degraded",
      records: 0,
      vectors: { indexed: 0, missing: 0 },
      intake: { captures: 1, vectors: 0 },
    });
    await crashed.stop();

    const recovered = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    await expect(recovered.retryIntake({ signal })).resolves.toMatchObject({
      capturesRetried: 1,
      vectorsRetried: 0,
      failed: 1,
      remainingCaptures: 0,
      remainingVectors: 1,
    });
    await expect(recovered.capture?.({ record: source, signal })).resolves.toBeUndefined();
    await expect(recovered.audit({ signal })).resolves.toMatchObject({
      status: "degraded",
      records: 1,
      vectors: { indexed: 0, missing: 1 },
      intake: { captures: 0, vectors: 1 },
    });
    embeddingsAvailable = true;
    await expect(recovered.retryIntake({ signal })).resolves.toMatchObject({
      vectorsRetried: 1,
      failed: 0,
      remainingVectors: 0,
    });
    await expect(recovered.audit({ signal, strict: true })).resolves.toMatchObject({
      status: "healthy",
      records: 1,
      vectors: { indexed: 1, missing: 0 },
      intake: { captures: 0, vectors: 0 },
    });
    await recovered.stop();
  });

  it("detects a missing expected vector and exact duplicate replay restores retry intake", async () => {
    const fixture = await createFixture();
    const provider = new DeterministicEmbeddingProvider(3);
    const source = record(
      "replay-source",
      "remember the green bicycle",
      "2026-07-22T12:00:00.000Z",
    );
    const original = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    await original.capture?.({ record: source, signal });
    await original.stop();

    const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
    database.exec(`
      DELETE FROM memories_vec;
      DELETE FROM index_metadata WHERE key LIKE 'memory-local:vector-intake:%';
    `);
    database.close();

    const recovered = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: provider,
    });
    await expect(recovered.audit({ signal, strict: true }))
      .rejects.toMatchObject({ code: "maintenance_failed" });
    await expect(recovered.audit({ signal })).resolves.toMatchObject({
      status: "degraded",
      records: 1,
      vectors: { indexed: 0, missing: 1 },
      intake: { vectors: 0 },
    });
    await expect(recovered.capture?.({ record: source, signal })).resolves.toBeUndefined();
    await expect(recovered.audit({ signal })).resolves.toMatchObject({
      intake: { captures: 0, vectors: 1 },
      vectors: { missing: 1 },
    });
    await expect(recovered.retryIntake({ signal })).resolves.toMatchObject({
      vectorsRetried: 1,
      failed: 0,
      remainingVectors: 0,
    });
    await expect(recovered.audit({ signal, strict: true })).resolves.toMatchObject({
      status: "healthy",
      records: 1,
      vectors: { indexed: 1, missing: 0 },
    });
    await recovered.stop();

    const lostAfterConfiguredCapture = openBujoDatabase(
      join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME),
    );
    lostAfterConfiguredCapture.exec(`
      DELETE FROM memories_vec;
      DELETE FROM index_metadata WHERE key LIKE 'memory-local:vector-intake:%';
    `);
    lostAfterConfiguredCapture.close();
    const recallOnly = await openMemoryLocal(options(
      fixture,
      { capture: { enabled: false } },
    ));
    await expect(recallOnly.audit({ signal })).resolves.toMatchObject({
      status: "degraded",
      vectors: { configured: false, indexed: 0, missing: 1 },
    });
    await expect(recallOnly.audit({ signal, strict: true }))
      .rejects.toMatchObject({ code: "maintenance_failed" });
    await recallOnly.stop();
  });

  it("falls back to FTS on a vector identity mismatch and repairs it through rebuild", async () => {
    const fixture = await createFixture();
    const original = await openMemoryLocal({
      ...options(fixture, memoryConfig(3)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: new DeterministicEmbeddingProvider(3),
    });
    await original.capture?.({
      record: record("dimension-source", "dimension migration remains searchable", "2026-07-23T10:00:00.000Z"),
      signal,
    });
    await original.stop();

    const replacement = await openMemoryLocal({
      ...options(fixture, memoryConfig(4)),
      host: runtimeHost(passthroughGrant()),
      embeddingProvider: new DeterministicEmbeddingProvider(4),
    });
    try {
      await expect(replacement.audit({ signal })).resolves.toMatchObject({
        status: "degraded",
        vectors: { dimensions: 3, compatible: false },
      });
      expect((await replacement.recall({ query: "migration", limit: 1, signal })).records).toHaveLength(1);
      await expect(replacement.rebuild({ signal })).resolves.toMatchObject({
        records: 1,
        vectorDimensions: 4,
      });
      await expect(replacement.audit({ signal, strict: true })).resolves.toMatchObject({
        status: "healthy",
        vectors: { dimensions: 4, compatible: true, indexed: 1 },
      });
    } finally {
      await replacement.stop();
    }
  });
});

class DeterministicEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "ollama:nomic-embed-text:v1.5";

  constructor(
    readonly dimensions: number,
    private readonly available: () => boolean = () => true,
  ) {}

  async embed(
    texts: readonly string[],
    _signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (!this.available()) throw new Error("embedding bearer private-embedding-value");
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      if (/\b(?:apple|apples|fruit|cellar|inventory)\b/iu.test(text)) {
        vector[0] = 1;
      } else if (/\b(?:planning|quarterly|Tuesday)\b/iu.test(text)) {
        vector[Math.min(1, this.dimensions - 1)] = 1;
      } else {
        vector[this.dimensions - 1] = 1;
      }
      return Object.freeze(vector);
    });
  }
}

async function createFixture(): Promise<{ readonly root: string; readonly directory: string }> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-maintenance-"));
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
