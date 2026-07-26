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

import { MEMORY_LOCAL_DATABASE_FILENAME } from "../index.js";
import {
  CAPTURE_RECEIPT_LOW_WATERMARK,
  MAX_CAPTURE_RECEIPTS,
  assertCaptureReceiptIntegrity,
  captureReceiptCount,
  captureReceiptKey,
  getMetadata,
  openBujoDatabase,
  setMetadata,
} from "../bujo-db.js";
import { openMemoryLocalForTesting as openMemoryLocal } from "../store.js";

const signal = new AbortController().signal;
const roots: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1_000;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local capture receipt retention", () => {
  it("writes v2 receipts and treats them as replay tombstones only through the configured horizon", async () => {
    const fixture = await createFixture();
    let now = Date.parse("2026-07-01T12:00:00.000Z");
    let modelCalls = 0;
    const grant = countingGrant(() => {
      modelCalls += 1;
    });
    const source = record("retained-source", "remember the retained bicycle");

    const first = await openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });
    await first.capture({ record: source, signal });
    await first.stop();
    expect(modelCalls).toBe(1);
    expect(readReceipt(fixture, source.id)).toEqual({
      recordIds: [expect.stringMatching(/^runtime:[a-f0-9]{48}$/u)],
      retainedAt: "2026-07-01T12:00:00.000Z",
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      version: 2,
    });

    now += 23 * 60 * 60 * 1_000;
    const withinHorizon = await openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });
    await withinHorizon.capture({ record: source, signal });
    await withinHorizon.stop();
    expect(modelCalls).toBe(1);

    now += 2 * 60 * 60 * 1_000;
    const expired = await openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });
    await expired.capture({ record: source, signal });
    await expect(expired.audit({ signal, strict: true })).resolves.toMatchObject({
      status: "healthy",
      receipts: {
        count: 1,
        capacity: MAX_CAPTURE_RECEIPTS,
        lowWatermark: CAPTURE_RECEIPT_LOW_WATERMARK,
      },
    });
    await expired.stop();
    expect(modelCalls).toBe(2);
    expect(readReceipt(fixture, source.id)).toMatchObject({
      retainedAt: "2026-07-02T13:00:00.000Z",
      version: 2,
    });

    const receipt = readReceipt(fixture, source.id) as Readonly<Record<string, unknown>>;
    writeReceipt(fixture, source.id, { ...receipt, retainedAt: "not-a-timestamp" });
    const malformed = await openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });
    await expect(malformed.audit({ signal, strict: true }))
      .rejects.toMatchObject({ code: "corrupt_store" });
    await expect(malformed.capture({ record: source, signal }))
      .rejects.toMatchObject({ code: "corrupt_store" });
    await malformed.stop();
    expect(modelCalls).toBe(2);
  });

  it("resets a v2 horizon on forget and preserves migrated v1 receipts permanently", async () => {
    const fixture = await createFixture();
    let now = Date.parse("2026-07-01T12:00:00.000Z");
    let modelCalls = 0;
    const grant = countingGrant(() => {
      modelCalls += 1;
    });
    const source = record("forget-retention-source", "remember the private bicycle");
    const open = () => openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });

    const original = await open();
    await original.capture({ record: source, signal });
    const derived = (await original.recall({
      query: "private bicycle",
      limit: 1,
      signal,
    })).records[0]!;
    now += 2 * DAY_MS;
    await expect(original.forget({ recordId: derived.id, signal })).resolves.toBe(true);
    await original.capture({ record: source, signal });
    expect(modelCalls).toBe(1);
    await original.stop();
    expect(readReceipt(fixture, source.id)).toMatchObject({
      recordIds: [],
      retainedAt: "2026-07-03T12:00:00.000Z",
      version: 2,
    });

    now += 2 * DAY_MS;
    const afterResetHorizon = await open();
    await afterResetHorizon.capture({ record: source, signal });
    await afterResetHorizon.stop();
    expect(modelCalls).toBe(2);

    const receipt = readReceipt(fixture, source.id) as {
      readonly sourceHash: string;
      readonly recordIds: readonly string[];
    };
    writeReceipt(fixture, source.id, {
      recordIds: receipt.recordIds,
      sourceHash: receipt.sourceHash,
      version: 1,
    });
    now += 3_650 * DAY_MS;
    const migrated = await open();
    await migrated.capture({ record: source, signal });
    await migrated.stop();
    expect(modelCalls).toBe(2);
    expect(readReceipt(fixture, source.id)).toMatchObject({ version: 1 });
  });

  it("ignores expired dangling receipts while forgetting and matches receipt keys case-sensitively", async () => {
    const fixture = await createFixture();
    let now = Date.parse("2026-07-01T12:00:00.000Z");
    const grant = countingGrant(() => undefined);
    const open = () => openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });
    const expiredSource = record("expired-dangling-source", "remember the expired bicycle");
    const activeSource = record("active-forget-source", "remember the active bicycle");

    const captured = await open();
    await captured.capture({ record: expiredSource, signal });
    await captured.capture({ record: activeSource, signal });
    const activeRecord = (await captured.recall({
      query: "active bicycle",
      limit: 1,
      signal,
    })).records[0]!;
    await captured.stop();

    const expired = readReceipt(fixture, expiredSource.id) as Readonly<Record<string, unknown>>;
    writeReceipt(fixture, expiredSource.id, {
      ...expired,
      recordIds: ["runtime:ffffffffffffffffffffffffffffffffffffffffffffffff"],
    });
    const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
    try {
      setMetadata(
        database,
        "MEMORY-LOCAL:CAPTURE-RECEIPT:case-variant",
        "not a receipt",
      );
      expect(captureReceiptCount(database)).toBe(2);
    } finally {
      database.close();
    }

    now += 2 * DAY_MS;
    const reopened = await open();
    await expect(reopened.audit({ signal, strict: true })).resolves.toMatchObject({
      status: "healthy",
      receipts: { count: 2 },
    });
    await expect(reopened.forget({ recordId: activeRecord.id, signal })).resolves.toBe(true);
    await reopened.stop();
  });

  it("bounds integrity scans with an honest capacity error", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture, { capture: { enabled: false } }));
    await initialized.stop();
    seedLegacyReceipts(fixture, 3);
    const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
    try {
      expect(() => assertCaptureReceiptIntegrity(database, undefined, 3)).not.toThrow();
      let failure: unknown;
      try {
        assertCaptureReceiptIntegrity(database, undefined, 2);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "capacity_exceeded",
        message: expect.not.stringContaining("corrupt"),
      });
    } finally {
      database.close();
    }
  });

  it("fails before the model at capacity, prunes expired v2 receipts, and serializes concurrent admission", async () => {
    const fixture = await createFixture();
    const initialized = await openMemoryLocal(options(fixture, {
      capture: { enabled: false, receiptRetentionDays: 1 },
    }));
    await initialized.stop();
    seedLegacyReceipts(fixture, MAX_CAPTURE_RECEIPTS + 1);

    let now = Date.parse("2026-07-03T12:00:00.000Z");
    let modelCalls = 0;
    const grant = countingGrant(() => {
      modelCalls += 1;
    });
    const open = () => openMemoryLocal({
      ...options(fixture, captureConfig(1)),
      host: runtimeHost(grant),
      clock: () => new Date(now),
    });

    const full = await open();
    await expect(full.audit({ signal })).resolves.toMatchObject({
      status: "degraded",
      receipts: { count: MAX_CAPTURE_RECEIPTS + 1 },
    });
    await expect(full.capture({
      record: record("blocked-source", "must not reach the model"),
      signal,
    })).rejects.toMatchObject({
      code: "capacity_exceeded",
      message: expect.not.stringContaining("corrupt"),
    });
    expect(modelCalls).toBe(0);
    expect(await full.diagnostics({ signal, verbose: true })).toContainEqual({
      code: "memory-local.receipt-capacity",
      severity: "warning",
      message: `Memory capture receipt capacity is exhausted (${MAX_CAPTURE_RECEIPTS + 1} of ${MAX_CAPTURE_RECEIPTS}).`,
      hint: expect.not.stringContaining("blocked-source"),
    });
    await full.stop();

    convertReceiptsToExpiredV2(
      fixture,
      MAX_CAPTURE_RECEIPTS - CAPTURE_RECEIPT_LOW_WATERMARK + 2,
      "2026-07-01T12:00:00.000Z",
    );
    const reclaiming = await open();
    await reclaiming.capture({
      record: record("reclaimed-source", "capacity can be reclaimed"),
      signal,
    });
    await reclaiming.stop();
    expect(modelCalls).toBe(1);
    expect(countReceipts(fixture)).toBe(CAPTURE_RECEIPT_LOW_WATERMARK + 1);

    convertRemainingExpiredReceiptsToV1(fixture, "2026-07-01T12:00:00.000Z");
    seedLegacyReceipts(
      fixture,
      MAX_CAPTURE_RECEIPTS - countReceipts(fixture) - 1,
      MAX_CAPTURE_RECEIPTS * 2,
    );
    expect(countReceipts(fixture)).toBe(MAX_CAPTURE_RECEIPTS - 1);

    const concurrent = await open();
    const results = await Promise.allSettled([
      concurrent.capture({
        record: record("concurrent-first", "first concurrent memory"),
        signal,
      }),
      concurrent.capture({
        record: record("concurrent-second", "second concurrent memory"),
        signal,
      }),
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "capacity_exceeded" },
    });
    expect(modelCalls).toBe(2);
    await concurrent.stop();

    const reopened = await open();
    await expect(reopened.audit({ signal })).resolves.toMatchObject({
      status: "degraded",
      records: 2,
      receipts: { count: MAX_CAPTURE_RECEIPTS },
    });
    await reopened.stop();
  }, 120_000);
});

async function createFixture(): Promise<{ readonly root: string; readonly directory: string }> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-receipts-"));
  const root = await realpath(authored);
  roots.push(root);
  const directory = join(root, "memory");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory };
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

function captureConfig(receiptRetentionDays: number): unknown {
  return {
    capture: {
      enabled: true,
      model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
      receiptRetentionDays,
      timeoutMs: 5_000,
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

function countingGrant(onCall: () => void): MemoryRuntimeCaptureGrant {
  return {
    async complete({ input }) {
      onCall();
      return { text: "", structuredOutput: { records: [{ text: input }] } };
    },
  };
}

function record(id: string, text: string): MemoryRecord {
  return { id, text, createdAt: "2026-07-01T10:00:00.000Z" };
}

function readReceipt(
  fixture: { readonly directory: string },
  sourceId: string,
): unknown {
  const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
  try {
    const value = getMetadata(database, captureReceiptKey(sourceId));
    return value === undefined ? undefined : JSON.parse(value);
  } finally {
    database.close();
  }
}

function writeReceipt(
  fixture: { readonly directory: string },
  sourceId: string,
  value: Readonly<Record<string, unknown>>,
): void {
  const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
  try {
    setMetadata(database, captureReceiptKey(sourceId), JSON.stringify(value));
  } finally {
    database.close();
  }
}

function countReceipts(fixture: { readonly directory: string }): number {
  const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
  try {
    return captureReceiptCount(database);
  } finally {
    database.close();
  }
}

function seedLegacyReceipts(
  fixture: { readonly directory: string },
  count: number,
  offset = 0,
): void {
  const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
  const insert = database.prepare(
    "INSERT INTO index_metadata(key, value) VALUES (?, ?)",
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index += 1) {
      const ordinal = offset + index;
      insert.run(
        captureReceiptKey(`capacity-${String(ordinal).padStart(6, "0")}`),
        JSON.stringify({
          recordIds: [],
          sourceHash: ordinal.toString(16).padStart(64, "0"),
          version: 1,
        }),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function convertReceiptsToExpiredV2(
  fixture: { readonly directory: string },
  count: number,
  retainedAt: string,
): void {
  const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
  const update = database.prepare("UPDATE index_metadata SET value = ? WHERE key = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index += 1) {
      update.run(
        JSON.stringify({
          recordIds: [],
          retainedAt,
          sourceHash: index.toString(16).padStart(64, "0"),
          version: 2,
        }),
        captureReceiptKey(`capacity-${String(index).padStart(6, "0")}`),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function convertRemainingExpiredReceiptsToV1(
  fixture: { readonly directory: string },
  retainedAt: string,
): void {
  const database = openBujoDatabase(join(fixture.directory, MEMORY_LOCAL_DATABASE_FILENAME));
  const rows = database.prepare(`
    SELECT key, value
    FROM index_metadata
    WHERE key LIKE 'memory-local:capture-receipt:%'
  `).all() as unknown as { readonly key: string; readonly value: string }[];
  const update = database.prepare("UPDATE index_metadata SET value = ? WHERE key = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const receipt = JSON.parse(row.value) as {
        readonly version: number;
        readonly retainedAt?: string;
        readonly sourceHash: string;
        readonly recordIds: readonly string[];
      };
      if (receipt.version !== 2 || receipt.retainedAt !== retainedAt) continue;
      update.run(JSON.stringify({
        recordIds: receipt.recordIds,
        sourceHash: receipt.sourceHash,
        version: 1,
      }), row.key);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
