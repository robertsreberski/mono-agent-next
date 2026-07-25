import { appendFile, chmod, link, mkdtemp, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { StateLocalError } from "../errors.js";
import { ExecutionStore } from "../execution-store.js";
import { INDEX_GROWTH_MARKER_BYTES } from "../index-log-compaction.js";
import { stateLocalInternalAccess } from "../internal-state-access.js";
import { acquireProcessLease } from "../secure-fs.js";
import { StateLocalStore, type StateLocalStoreHooks } from "../store.js";

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("StateLocalStore", () => {
  it("persists exact CAS updates and returns deterministic cursor pages", async () => {
    const config = await createConfig();
    const store = await open(config);

    const zeta = await store.write({ key: "runs/zeta", value: bytes("z"), signal });
    await store.write({ key: "runs/alpha", value: bytes("a"), signal });
    await store.write({ key: "other/value", value: bytes("o"), signal });

    await expect(store.write({
      key: "runs/zeta",
      value: bytes("wrong"),
      expectedVersion: "v999",
      signal,
    })).rejects.toMatchObject({ code: "STATE_VERSION_MISMATCH" });

    const updated = await store.write({
      key: "runs/zeta",
      value: bytes("z2"),
      expectedVersion: zeta.version,
      signal,
    });
    expect(updated.version).not.toBe(zeta.version);

    const first = await store.list({ prefix: "runs/", limit: 1, signal });
    expect(first.records.map((record) => record.key)).toEqual(["runs/alpha"]);
    expect(first.cursor).toEqual(expect.any(String));
    const cursor = first.cursor;
    if (cursor === undefined) throw new Error("Expected a cursor for the second page.");

    const second = await store.list({
      prefix: "runs/",
      cursor,
      limit: 1,
      signal,
    });
    expect(second.records.map((record) => record.key)).toEqual(["runs/zeta"]);
    expect(second.cursor).toBeUndefined();

    const stalePage = await store.list({ prefix: "runs/", limit: 1, signal });
    const staleCursor = stalePage.cursor;
    if (staleCursor === undefined) throw new Error("Expected a cursor to test snapshot binding.");
    await store.write({ key: "other/new", value: bytes("new"), signal });
    await expect(store.list({ prefix: "runs/", cursor: staleCursor, limit: 1, signal }))
      .rejects.toMatchObject({ code: "STATE_INVALID_CURSOR" });

    await expect(store.list({ prefix: "other/", cursor, limit: 1, signal }))
      .rejects.toMatchObject({ code: "STATE_INVALID_CURSOR" });

    const returned = await store.read({ key: "runs/zeta", signal });
    expect(text(returned?.value)).toBe("z2");
    returned?.value.fill(0);
    expect(text((await store.read({ key: "runs/zeta", signal }))?.value)).toBe("z2");

    await store.close();
    const reopened = await open(config);
    expect(text((await reopened.read({ key: "runs/zeta", signal }))?.value)).toBe("z2");
    expect(await reopened.delete({ key: "runs/zeta", expectedVersion: updated.version, signal })).toBe(true);
    expect(await reopened.delete({ key: "runs/zeta", signal })).toBe(false);
    await reopened.close();
  });

  it("reserves core namespaces while the explicit execution accessor round-trips them", async () => {
    const config = await createConfig();
    const store = await open(config);
    const execution = new ExecutionStore(store[stateLocalInternalAccess]);
    await expect(execution.transaction({
      puts: [{
        key: "core/runs/internal",
        expectedVersion: null,
        value: { status: "private" },
      }],
      bytePuts: [{
        key: "@core/transcript",
        expectedVersion: null,
        value: bytes("private-bytes"),
      }],
      signal,
    })).resolves.toMatchObject({ status: "applied" });

    await expect(execution.read(
      "core/runs/internal",
      (value) => value as { readonly status: string },
      signal,
    )).resolves.toMatchObject({ value: { status: "private" } });
    expect(text((await execution.readBytes("@core/transcript", signal))?.value))
      .toBe("private-bytes");
    await expect(store.read({ key: "core/runs/internal", signal }))
      .resolves.toBeUndefined();
    await expect(store.read({ key: "@core/transcript", signal }))
      .resolves.toBeUndefined();
    for (const prefix of ["core/", "@core/"]) {
      await expect(store.list({ prefix, limit: 10, signal }))
        .resolves.toEqual({ records: [] });
      await expect(store.scan({ prefix, limit: 10, signal }))
        .resolves.toEqual({ records: [] });
    }
    await expect(store.write({
      key: "core/user-collision",
      value: bytes("blocked"),
      signal,
    })).rejects.toMatchObject({ code: "STATE_INVALID_KEY" });
    await expect(store.write({
      key: "@core/user-collision",
      value: bytes("blocked"),
      signal,
    })).rejects.toMatchObject({ code: "STATE_INVALID_KEY" });
    await expect(execution.transaction({
      puts: [{
        key: "public/internal-bypass",
        expectedVersion: null,
        value: { status: "blocked" },
      }],
      signal,
    })).rejects.toMatchObject({ code: "STATE_INVALID_KEY" });

    await store.write({ key: "public/alpha", value: bytes("a"), signal });
    await store.write({ key: "public/bravo", value: bytes("b"), signal });
    const firstPublicPage = await store.list({ prefix: "public/", limit: 1, signal });
    expect(firstPublicPage.records.map(({ key }) => key)).toEqual(["public/alpha"]);
    expect(firstPublicPage.cursor).toEqual(expect.any(String));
    const publicCursor = firstPublicPage.cursor;
    if (publicCursor === undefined) throw new Error("Expected a public list cursor.");
    await expect(execution.transaction({
      puts: [{
        key: "core/runs/internal-after-page",
        expectedVersion: null,
        value: { status: "private" },
      }],
      signal,
    })).resolves.toMatchObject({ status: "applied" });
    await expect(store.list({
      prefix: "public/",
      cursor: publicCursor,
      limit: 1,
      signal,
    })).resolves.toMatchObject({
      records: [{ key: "public/bravo" }],
    });
    await expect(store.health({ signal })).resolves.toMatchObject({
      status: "healthy",
      details: { records: 2, presence: 0 },
    });

    await store.close();
    const reopened = await open(config);
    const reopenedExecution = new ExecutionStore(reopened[stateLocalInternalAccess]);
    await expect(reopenedExecution.read(
      "core/runs/internal",
      (value) => value as { readonly status: string },
      signal,
    )).resolves.toMatchObject({ value: { status: "private" } });
    expect(text((await reopenedExecution.readBytes("@core/transcript", signal))?.value))
      .toBe("private-bytes");
    await reopened.close();
  });

  it("commit-capacity-does-not-poison", async () => {
    const config = await createConfig();
    const store = await StateLocalStore.open(config, {
      instanceId: "snapshot-capacity-test",
      signal,
      clock: () => new Date("2026-07-23T12:00:00.000Z"),
      hooks: { snapshotByteLimit: 256 },
    });

    await expect(store.write({
      key: "capacity/oversized",
      value: Buffer.alloc(200, 1),
      signal,
    })).rejects.toMatchObject({ code: "STATE_LIMIT_EXCEEDED" });
    await expect(store.write({
      key: "capacity/healthy",
      value: bytes("ok"),
      signal,
    })).resolves.toMatchObject({ version: "v1" });
    expect(text((await store.read({ key: "capacity/healthy", signal }))?.value)).toBe("ok");
    await store.close();
  });

  it("keeps the store usable after a proven pre-append index byte rejection", async () => {
    const config = await createConfig();
    const hooks: StateLocalStoreHooks = {
      lease: {
        indexLimits: {
          maximumBytes: 1_024,
          maximumFrames: 100,
          compactAfterReclaimableBytes: 1,
          compactAfterObsoleteFrames: 1,
        },
      },
    };
    const store = await open(config, hooks);
    await expect(store.write({
      key: "capacity/oversized",
      value: Buffer.alloc(900, 1),
      signal,
    })).rejects.toMatchObject({ code: "STATE_LIMIT_EXCEEDED" });
    expect(await store.read({ key: "capacity/oversized", signal })).toBeUndefined();
    await store.write({ key: "capacity/healthy", value: bytes("ok"), signal });
    await store.close();

    const reopened = await open(config, hooks);
    expect(text((await reopened.read({ key: "capacity/healthy", signal }))?.value)).toBe("ok");
    expect(await reopened.read({ key: "capacity/oversized", signal })).toBeUndefined();
    await reopened.close();
  });

  it("heartbeat-poisons-and-refreshes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const healthyConfig = await createConfig(true);
      let healthyCommits = 0;
      let expectHealthyHeartbeat = false;
      let resolveHealthyHeartbeat: (() => void) | undefined;
      const healthyHeartbeat = new Promise<void>((resolve) => {
        resolveHealthyHeartbeat = resolve;
      });
      const healthy = await StateLocalStore.open(healthyConfig, {
        instanceId: "heartbeat-refresh-test",
        signal,
        clock: () => new Date("2026-07-23T12:00:00.000Z"),
        hooks: {
          presence: {
            afterCommit: () => {
              healthyCommits += 1;
              if (expectHealthyHeartbeat) resolveHealthyHeartbeat?.();
            },
          },
        },
      });
      await healthy.start({ signal });
      const beforeHeartbeat = healthyCommits;
      expectHealthyHeartbeat = true;
      await vi.advanceTimersByTimeAsync(60_000);
      await healthyHeartbeat;
      expect(healthyCommits).toBeGreaterThan(beforeHeartbeat);
      await expect(healthy.write({
        key: "heartbeat/still-writable",
        value: bytes("yes"),
        signal,
      })).resolves.toMatchObject({ version: expect.any(String) });
      await healthy.close();

      const poisonedConfig = await createConfig(true);
      let poisonNextHeartbeat = false;
      let resolveFailedHeartbeat: (() => void) | undefined;
      const failedHeartbeat = new Promise<void>((resolve) => {
        resolveFailedHeartbeat = resolve;
      });
      const poisoned = await StateLocalStore.open(poisonedConfig, {
        instanceId: "heartbeat-poison-test",
        signal,
        clock: () => new Date("2026-07-23T12:00:00.000Z"),
        hooks: {
          presence: {
            afterCommit: () => {
              if (poisonNextHeartbeat) {
                resolveFailedHeartbeat?.();
                throw new Error("simulated heartbeat publication failure");
              }
            },
          },
        },
      });
      await poisoned.start({ signal });
      poisonNextHeartbeat = true;
      await vi.advanceTimersByTimeAsync(60_000);
      await failedHeartbeat;
      await Promise.resolve();
      await expect(poisoned.read({ key: "heartbeat/blocked", signal }))
        .rejects.toMatchObject({ code: "STATE_POISONED" });
      await expect(poisoned.write({
        key: "heartbeat/also-blocked",
        value: bytes("no"),
        signal,
      })).rejects.toMatchObject({ code: "STATE_POISONED" });
      poisonNextHeartbeat = false;
      await poisoned.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a second writer while the process lease is live and allows reopening after release", async () => {
    const config = await createConfig();
    const first = await open(config);
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_ALREADY_OPEN" });
    await first.close();
    const reopened = await open(config);
    await reopened.close();
  });

  it("compacts repeatedly before injected frame and byte ceilings", async () => {
    for (const [name, indexLimits] of [
      [
        "frames",
        {
          maximumFrames: 5,
          compactAfterObsoleteFrames: 2,
        },
      ],
      [
        "bytes",
        {
          maximumBytes: 4_096,
          maximumFrames: 100,
          compactAfterObsoleteFrames: 99,
          compactAfterReclaimableBytes: 256,
        },
      ],
    ] as const) {
      const config = await createConfig();
      const store = await StateLocalStore.open(config, {
        instanceId: `index-${name}-ceiling-test`,
        signal,
        clock: () => new Date("2026-07-23T12:00:00.000Z"),
        hooks: { lease: { indexLimits } },
      });
      const indexPath = join(config.root, "lease.sqlite.index");
      const witnessPath = `${indexPath}.witness`;
      const beforeIndex = await stat(indexPath);
      const beforeWitness = await stat(witnessPath);
      for (let revision = 0; revision < 20; revision += 1) {
        await store.write({
          key: "compaction/latest",
          value: bytes(`${name}-${String(revision)}`),
          signal,
        });
      }
      const afterIndex = await stat(indexPath);
      const afterWitness = await stat(witnessPath);
      expect({
        device: afterIndex.dev,
        inode: afterIndex.ino,
        links: afterIndex.nlink,
      }).toEqual({
        device: beforeIndex.dev,
        inode: beforeIndex.ino,
        links: 2,
      });
      expect({
        device: afterWitness.dev,
        inode: afterWitness.ino,
        links: afterWitness.nlink,
      }).toEqual({
        device: beforeWitness.dev,
        inode: beforeWitness.ino,
        links: 2,
      });
      await store.close();

      const reopened = await StateLocalStore.open(config, {
        instanceId: `index-${name}-ceiling-reopen-test`,
        signal,
        clock: () => new Date("2026-07-23T12:00:00.000Z"),
        hooks: { lease: { indexLimits } },
      });
      expect(text((await reopened.read({
        key: "compaction/latest",
        signal,
      }))?.value)).toBe(`${name}-19`);
      await reopened.write({
        key: "compaction/after-reopen",
        value: bytes("healthy"),
        signal,
      });
      await reopened.close();
    }
  });

  it("uses expanded staging for large overwrites and recovers a partial in-place copy", async () => {
    const config = await createConfig();
    await writePrivateDirectory(config.root);
    const leasePath = join(config.root, "large-index.sqlite");
    const indexLimits = {
      maximumBytes: 150_000,
      maximumFrames: 100,
      compactAfterReclaimableBytes: 1,
      compactAfterObsoleteFrames: 1,
    };
    const firstValue = Buffer.alloc(100_000, 1);
    const committedValue = Buffer.alloc(100_000, 2);
    const finalValue = Buffer.alloc(100_000, 3);
    let crashDuringCopy = true;
    const lease = await acquireProcessLease(leasePath, {
      indexLimits,
      afterIndexCompactionCopyChunk: (_target, copiedBytes, totalBytes) => {
        if (!crashDuringCopy || copiedBytes >= totalBytes) return;
        crashDuringCopy = false;
        throw new Error("simulated crash during compaction copy");
      },
    });
    lease.writeIndex("large", firstValue);
    expect(() => lease.writeIndex("large", committedValue))
      .toThrow("simulated crash during compaction copy");
    await lease.release();

    const reopened = await acquireProcessLease(leasePath, { indexLimits });
    expect(reopened.readIndex("large", committedValue.byteLength))
      .toEqual(committedValue);
    reopened.writeIndex("large", finalValue);
    expect(reopened.readIndex("large", finalValue.byteLength)).toEqual(finalValue);
    await reopened.release();

    const verified = await acquireProcessLease(leasePath, { indexLimits });
    expect(verified.readIndex("large", finalValue.byteLength)).toEqual(finalValue);
    await verified.release();
  });

  it("truncates a near-ceiling staged body when its commit footer is absent", async () => {
    const config = await createConfig();
    await writePrivateDirectory(config.root);
    const leasePath = join(config.root, "near-ceiling-index.sqlite");
    const indexLimits = {
      maximumBytes: 1_024,
      maximumFrames: 100,
      compactAfterReclaimableBytes: 1,
      compactAfterObsoleteFrames: 1,
    };
    const retainedValue = Buffer.alloc(900, 1);
    const pendingValue = Buffer.alloc(900, 2);
    let crashAfterBody = true;
    const lease = await acquireProcessLease(leasePath, {
      indexLimits,
      afterIndexCompactionBody: () => {
        if (!crashAfterBody) return;
        crashAfterBody = false;
        throw new Error("simulated crash after near-ceiling compaction body");
      },
    });
    lease.writeIndex("near-ceiling", retainedValue);
    expect(() => lease.writeIndex("near-ceiling", pendingValue))
      .toThrow("simulated crash after near-ceiling compaction body");
    await lease.release();

    const reopened = await acquireProcessLease(leasePath, { indexLimits });
    expect(reopened.readIndex("near-ceiling", retainedValue.byteLength))
      .toEqual(retainedValue);
    reopened.writeIndex("near-ceiling", pendingValue);
    expect(reopened.readIndex("near-ceiling", pendingValue.byteLength))
      .toEqual(pendingValue);
    await reopened.release();
  });

  it.each([
    ["header-only", 8],
    ["partial metadata", 11],
  ] as const)("truncates a near-ceiling staged %s prefix", async (_name, prefixBytes) => {
    const config = await createConfig();
    await writePrivateDirectory(config.root);
    const leasePath = join(config.root, `prefix-${String(prefixBytes)}-index.sqlite`);
    const indexPath = `${leasePath}.index`;
    const indexLimits = {
      maximumBytes: 1_024,
      maximumFrames: 100,
      compactAfterReclaimableBytes: 1,
      compactAfterObsoleteFrames: 1,
    };
    const retainedValue = Buffer.alloc(900, 1);
    const pendingValue = Buffer.alloc(900, 2);
    const lease = await acquireProcessLease(leasePath, {
      indexLimits,
      afterIndexCompactionBody: () => {
        throw new Error("simulated crash after compaction body");
      },
    });
    lease.writeIndex("near-ceiling", retainedValue);
    const sourceBytes = (await stat(indexPath)).size;
    expect(() => lease.writeIndex("near-ceiling", pendingValue))
      .toThrow("simulated crash after compaction body");
    await lease.release();
    const handle = await openFile(indexPath, "r+");
    try {
      await handle.truncate(sourceBytes + prefixBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const reopened = await acquireProcessLease(leasePath, { indexLimits });
    expect(reopened.readIndex("near-ceiling", retainedValue.byteLength))
      .toEqual(retainedValue);
    reopened.writeIndex("near-ceiling", pendingValue);
    expect(reopened.readIndex("near-ceiling", pendingValue.byteLength))
      .toEqual(pendingValue);
    await reopened.release();
  });

  it("grows a compact image within the logical ceiling without changing the inode", async () => {
    const config = await createConfig();
    await writePrivateDirectory(config.root);
    const leasePath = join(config.root, "growing-index.sqlite");
    const indexPath = `${leasePath}.index`;
    const indexLimits = {
      maximumBytes: 1_024,
      maximumFrames: 100,
      compactAfterReclaimableBytes: 1,
      compactAfterObsoleteFrames: 1,
    };
    const retainedValue = Buffer.alloc(300, 1);
    const growingReplacement = Buffer.alloc(900, 2);
    const healthyReplacement = Buffer.alloc(300, 3);
    const lease = await acquireProcessLease(leasePath, { indexLimits });
    lease.writeIndex("capacity", retainedValue);
    const before = await stat(indexPath);
    lease.writeIndex("capacity", growingReplacement);
    expect(lease.readIndex("capacity", growingReplacement.byteLength))
      .toEqual(growingReplacement);
    const after = await stat(indexPath);
    expect({ device: after.dev, inode: after.ino }).toEqual({
      device: before.dev,
      inode: before.ino,
    });
    expect(after.size).toBeLessThanOrEqual(1_024);
    lease.writeIndex("capacity", healthyReplacement);
    expect(lease.readIndex("capacity", healthyReplacement.byteLength))
      .toEqual(healthyReplacement);
    await lease.release();

    const reopened = await acquireProcessLease(leasePath, { indexLimits });
    expect(reopened.readIndex("capacity", healthyReplacement.byteLength))
      .toEqual(healthyReplacement);
    await reopened.release();
  });

  it("grows by one byte at the logical ceiling with staging beyond that ceiling", async () => {
    const config = await createConfig();
    await writePrivateDirectory(config.root);
    const leasePath = join(config.root, "growth-edge-index.sqlite");
    const indexPath = `${leasePath}.index`;
    const indexLimits = {
      maximumBytes: 1_024,
      maximumFrames: 100,
      compactAfterReclaimableBytes: 1,
      compactAfterObsoleteFrames: 1,
    };
    const retainedValue = Buffer.alloc(924, 1);
    const growingValue = Buffer.alloc(925, 2);
    const lease = await acquireProcessLease(leasePath, { indexLimits });
    lease.writeIndex("edge", retainedValue);
    const before = await stat(indexPath);
    expect(before.size).toBe(1_023);
    lease.writeIndex("edge", growingValue);
    expect(lease.readIndex("edge", growingValue.byteLength)).toEqual(growingValue);
    const after = await stat(indexPath);
    expect({ device: after.dev, inode: after.ino, size: after.size }).toEqual({
      device: before.dev,
      inode: before.ino,
      size: 1_024,
    });
    await lease.release();

    const reopened = await acquireProcessLease(leasePath, { indexLimits });
    expect(reopened.readIndex("edge", growingValue.byteLength)).toEqual(growingValue);
    await reopened.release();
  });

  it.each(["body", "prepared", "copy", "rewritten"] as const)(
    "recovers growing compaction after a crash at %s",
    async (boundary) => {
      const config = await createConfig();
      await writePrivateDirectory(config.root);
      const leasePath = join(config.root, `growth-${boundary}-index.sqlite`);
      const indexLimits = {
        maximumBytes: 1_024,
        maximumFrames: 100,
        compactAfterReclaimableBytes: 1,
        compactAfterObsoleteFrames: 1,
      };
      const retainedValue = Buffer.alloc(300, 1);
      const growingValue = Buffer.alloc(900, 2);
      const finalValue = Buffer.alloc(850, 3);
      let crash = true;
      const crashAtBoundary = (): void => {
        if (!crash) return;
        crash = false;
        throw new Error(`simulated growing compaction crash at ${boundary}`);
      };
      const boundaryHooks = boundary === "body"
        ? { afterIndexCompactionBody: crashAtBoundary }
        : boundary === "prepared"
          ? { afterIndexCompactionPrepared: crashAtBoundary }
          : boundary === "copy"
            ? { afterIndexCompactionCopyChunk: crashAtBoundary }
            : { afterIndexCompactionRewritten: crashAtBoundary };
      const lease = await acquireProcessLease(leasePath, {
        indexLimits,
        ...boundaryHooks,
      });
      lease.writeIndex("growth", retainedValue);
      expect(() => lease.writeIndex("growth", growingValue))
        .toThrow(`simulated growing compaction crash at ${boundary}`);
      await lease.release();

      const reopened = await acquireProcessLease(leasePath, { indexLimits });
      const recovered = boundary === "body" ? retainedValue : growingValue;
      expect(reopened.readIndex("growth", recovered.byteLength)).toEqual(recovered);
      reopened.writeIndex("growth", finalValue);
      expect(reopened.readIndex("growth", finalValue.byteLength)).toEqual(finalValue);
      await reopened.release();

      const verified = await acquireProcessLease(leasePath, { indexLimits });
      expect(verified.readIndex("growth", finalValue.byteLength)).toEqual(finalValue);
      await verified.release();
    },
  );

  it("repairs exact partial growth-marker prefixes and rejects malformed ones", async () => {
    for (const [name, prefixBytes, corruptByte] of [
      ["header", 8, undefined],
      ["metadata", 10, undefined],
      ["bad-metadata", 10, 8],
      ["bad-checksum", INDEX_GROWTH_MARKER_BYTES, INDEX_GROWTH_MARKER_BYTES - 1],
    ] as const) {
      const config = await createConfig();
      await writePrivateDirectory(config.root);
      const leasePath = join(config.root, `growth-marker-${name}.sqlite`);
      const indexPath = `${leasePath}.index`;
      const indexLimits = {
        maximumBytes: 1_024,
        maximumFrames: 100,
        compactAfterReclaimableBytes: 1,
        compactAfterObsoleteFrames: 1,
      };
      const retainedValue = Buffer.alloc(300, 1);
      const growingValue = Buffer.alloc(900, 2);
      const lease = await acquireProcessLease(leasePath, {
        indexLimits,
        afterIndexCompactionBody: () => {
          throw new Error("simulated crash after growing compaction body");
        },
      });
      lease.writeIndex("growth", retainedValue);
      const sourceBytes = (await stat(indexPath)).size;
      expect(() => lease.writeIndex("growth", growingValue))
        .toThrow("simulated crash after growing compaction body");
      await lease.release();
      const handle = await openFile(indexPath, "r+");
      try {
        await handle.truncate(sourceBytes + prefixBytes);
        if (corruptByte !== undefined) {
          const original = Buffer.alloc(1);
          await handle.read(original, 0, 1, sourceBytes + corruptByte);
          await handle.write(
            Buffer.from([original[0]! ^ 0xff]),
            0,
            1,
            sourceBytes + corruptByte,
          );
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (corruptByte !== undefined) {
        const corruptBytes = await readFile(indexPath);
        await expect(acquireProcessLease(leasePath, { indexLimits }))
          .rejects.toMatchObject({ code: "STATE_CORRUPT" });
        expect(await readFile(indexPath)).toEqual(corruptBytes);
        continue;
      }
      const reopened = await acquireProcessLease(leasePath, { indexLimits });
      expect(reopened.readIndex("growth", retainedValue.byteLength)).toEqual(retainedValue);
      reopened.writeIndex("growth", growingValue);
      expect(reopened.readIndex("growth", growingValue.byteLength)).toEqual(growingValue);
      await reopened.release();
    }
  });

  it("does not confuse an ordinary frame sharing the growth-marker length", async () => {
    const config = await createConfig();
    await writePrivateDirectory(config.root);
    const leasePath = join(config.root, "growth-marker-length-index.sqlite");
    const value = Buffer.alloc(88, 1);
    const lease = await acquireProcessLease(leasePath);
    lease.writeIndex("ordinary", value);
    await lease.release();

    const reopened = await acquireProcessLease(leasePath);
    expect(reopened.readIndex("ordinary", value.byteLength)).toEqual(value);
    await reopened.release();
  });

  it.each(["certificate", "footer", "image"] as const)(
    "fails closed when a committed growing compaction %s is corrupt",
    async (target) => {
      const config = await createConfig();
      await writePrivateDirectory(config.root);
      const leasePath = join(config.root, `growth-corrupt-${target}.sqlite`);
      const indexPath = `${leasePath}.index`;
      const indexLimits = {
        maximumBytes: 1_024,
        maximumFrames: 100,
        compactAfterReclaimableBytes: 1,
        compactAfterObsoleteFrames: 1,
      };
      const retainedValue = Buffer.alloc(300, 1);
      const growingValue = Buffer.alloc(900, 2);
      const lease = await acquireProcessLease(leasePath, {
        indexLimits,
        afterIndexCompactionPrepared: () => {
          throw new Error("simulated crash after growing compaction commit");
        },
      });
      lease.writeIndex("growth", retainedValue);
      expect(() => lease.writeIndex("growth", growingValue))
        .toThrow("simulated crash after growing compaction commit");
      await lease.release();
      const staged = await readFile(indexPath);
      const corruptOffset = target === "certificate"
        ? staged.byteLength - Buffer.byteLength("mas-commit-v2\n") - 8 - 1
        : target === "footer"
          ? staged.byteLength - Buffer.byteLength("mas-commit-v2\n") - 8
          : staged.lastIndexOf(growingValue);
      expect(corruptOffset).toBeGreaterThan(0);
      const handle = await openFile(indexPath, "r+");
      try {
        await handle.write(Buffer.from([staged[corruptOffset]! ^ 0xff]), 0, 1, corruptOffset);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const corruptBytes = await readFile(indexPath);

      await expect(acquireProcessLease(leasePath, { indexLimits }))
        .rejects.toMatchObject({ code: "STATE_CORRUPT" });
      expect(await readFile(indexPath)).toEqual(corruptBytes);
    },
  );

  it.each([
    [
      "frame",
      {
        maximumFrames: 2,
        compactAfterObsoleteFrames: 1,
      },
      Buffer.alloc(16, 1),
      Buffer.alloc(16, 2),
    ],
    [
      "byte",
      {
        maximumBytes: 1_024,
        maximumFrames: 100,
        compactAfterReclaimableBytes: 1,
        compactAfterObsoleteFrames: 1,
      },
      Buffer.alloc(800, 1),
      Buffer.alloc(64, 2),
    ],
  ] as const)(
    "rejects an unreclaimable %s ceiling before append and remains usable",
    async (name, indexLimits, retainedValue, blockedValue) => {
      const config = await createConfig();
      await writePrivateDirectory(config.root);
      const leasePath = join(config.root, `${name}-capacity-index.sqlite`);
      const lease = await acquireProcessLease(leasePath, { indexLimits });
      lease.writeIndex("retained", retainedValue);
      if (name === "frame") lease.writeIndex("second", Buffer.alloc(16, 3));
      expect(() => lease.writeIndex("blocked", blockedValue))
        .toThrowError(expect.objectContaining({ code: "STATE_LIMIT_EXCEEDED" }));
      expect(lease.readIndex("retained", retainedValue.byteLength)).toEqual(retainedValue);
      const latestValue = Buffer.alloc(retainedValue.byteLength, 4);
      lease.writeIndex("retained", latestValue);
      expect(lease.readIndex("retained", latestValue.byteLength)).toEqual(latestValue);
      await lease.release();

      const reopened = await acquireProcessLease(leasePath, { indexLimits });
      expect(reopened.readIndex("retained", latestValue.byteLength)).toEqual(latestValue);
      expect(reopened.readIndex("blocked", blockedValue.byteLength)).toBeUndefined();
      await reopened.release();
    },
  );

  it("rejects live-frame corruption before compaction can re-sign it", async () => {
    const config = await createConfig();
    const indexLimits = {
      maximumFrames: 10,
      compactAfterReclaimableBytes: 1,
      compactAfterObsoleteFrames: 1,
    };
    const store = await StateLocalStore.open(config, {
      instanceId: "index-corruption-before-compaction-test",
      signal,
      clock: () => new Date("2026-07-23T12:00:00.000Z"),
      hooks: { lease: { indexLimits } },
    });
    await store.write({
      key: "compaction/victim",
      value: bytes("safe-latest"),
      signal,
    });
    const indexPath = join(config.root, "lease.sqlite.index");
    const encodedValue = Buffer.from("safe-latest", "utf8").toString("base64");
    const indexBytes = await readFile(indexPath);
    const valueOffset = indexBytes.lastIndexOf(encodedValue);
    if (valueOffset < 0) throw new Error("Expected the live snapshot bytes in the index.");
    const handle = await openFile(indexPath, "r+");
    try {
      await handle.write(Buffer.from(encodedValue[0] === "A" ? "B" : "A"), 0, 1, valueOffset);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const corruptedBytes = await readFile(indexPath);

    await expect(store.write({
      key: "compaction/victim",
      value: bytes("must-not-be-signed"),
      signal,
    })).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    await expect(store.read({ key: "compaction/victim", signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    expect(await readFile(indexPath)).toEqual(corruptedBytes);
    await store.close();
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readFile(indexPath)).toEqual(corruptedBytes);
  });

  it.each(["body", "prepared", "copy", "rewritten"] as const)(
    "recovers a crash at the %s compaction boundary",
    async (boundary) => {
      const config = await createConfig();
      const indexLimits = {
        maximumFrames: 5,
        compactAfterObsoleteFrames: 2,
      };
      let crash = true;
      const crashAtBoundary = (): void => {
        if (!crash) return;
        crash = false;
        throw new Error(`simulated crash at compaction ${boundary}`);
      };
      const boundaryHooks = boundary === "body"
        ? { afterIndexCompactionBody: crashAtBoundary }
        : boundary === "prepared"
          ? { afterIndexCompactionPrepared: crashAtBoundary }
          : boundary === "copy"
            ? { afterIndexCompactionCopyChunk: crashAtBoundary }
            : { afterIndexCompactionRewritten: crashAtBoundary };
      const store = await StateLocalStore.open(config, {
        instanceId: `index-compaction-${boundary}-test`,
        signal,
        clock: () => new Date("2026-07-23T12:00:00.000Z"),
        hooks: {
          lease: {
            indexLimits,
            ...boundaryHooks,
          },
        },
      });
      await store.write({
        key: "compaction/crash",
        value: bytes("one"),
        signal,
      });
      await store.write({
        key: "compaction/crash",
        value: bytes("two"),
        signal,
      });
      await expect(store.write({
        key: "compaction/crash",
        value: bytes("pending"),
        signal,
      })).rejects.toMatchObject({ code: "STATE_POISONED" });
      await store.close();

      const reopened = await StateLocalStore.open(config, {
        instanceId: `index-compaction-${boundary}-reopen-test`,
        signal,
        clock: () => new Date("2026-07-23T12:00:00.000Z"),
        hooks: { lease: { indexLimits } },
      });
      expect(text((await reopened.read({
        key: "compaction/crash",
        signal,
      }))?.value)).toBe(boundary === "body" ? "two" : "pending");
      await reopened.write({
        key: "compaction/crash",
        value: bytes("after-recovery"),
        signal,
      });
      expect(text((await reopened.read({
        key: "compaction/crash",
        signal,
      }))?.value)).toBe("after-recovery");
      await reopened.close();
    },
  );

  it("recovers a complete committed snapshot after an injected post-rename crash", async () => {
    const config = await createConfig();
    let crash = true;
    const hooks: StateLocalStoreHooks = {
      snapshot: {
        afterRename: () => {
          if (!crash) return;
          crash = false;
          throw new Error("simulated crash after rename");
        },
      },
    };
    const store = await open(config, hooks);

    await expect(store.write({ key: "turns/one", value: bytes("committed"), signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await expect(store.read({ key: "turns/one", signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await store.close();

    const reopened = await open(config);
    expect(text((await reopened.read({ key: "turns/one", signal }))?.value)).toBe("committed");
    await reopened.close();
  });

  it("poisons after a committed snapshot hook reports a capacity-shaped failure", async () => {
    const config = await createConfig();
    let crash = true;
    const store = await open(config, {
      snapshot: {
        afterRename: () => {
          if (!crash) return;
          crash = false;
          throw new StateLocalError(
            "STATE_LIMIT_EXCEEDED",
            "simulated post-commit capacity-shaped failure",
          );
        },
      },
    });

    await expect(store.write({ key: "turns/one", value: bytes("committed"), signal }))
      .rejects.toMatchObject({ code: "STATE_LIMIT_EXCEEDED" });
    await expect(store.read({ key: "turns/one", signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await expect(store.write({ key: "turns/two", value: bytes("must-not-commit"), signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await store.close();

    const reopened = await open(config);
    expect(text((await reopened.read({ key: "turns/one", signal }))?.value)).toBe("committed");
    expect(await reopened.read({ key: "turns/two", signal })).toBeUndefined();
    await reopened.close();
  });

  it("rejects a snapshot inode swap before rename and poisons subsequent access", async () => {
    const config = await createConfig();
    let swap = true;
    const store = await open(config, {
      snapshot: {
        beforeRename: async (target) => {
          if (!swap) return;
          swap = false;
          const replacement = `${target}.replacement`;
          await writeFile(replacement, await readFile(target), { mode: 0o600 });
          await rename(replacement, target);
        },
      },
    });

    await expect(store.write({ key: "turns/one", value: bytes("value"), signal }))
      .rejects.toMatchObject({ code: "STATE_PATH_CHANGED" });
    await expect(store.list({ limit: 10, signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await store.close();
  });

  it("never overwrites a post-check operator replacement of the transactional snapshot path", async () => {
    const config = await createConfig();
    const operatorBytes = Buffer.from("operator-owned snapshot replacement", "utf8");
    let swap = true;
    let moved = "";
    const store = await open(config, {
      snapshot: {
        afterCheck: async (target) => {
          if (!swap) return;
          swap = false;
          moved = `${target}.owned`;
          await rename(target, moved);
          await writeFile(target, operatorBytes, { mode: 0o600, flag: "wx" });
        },
      },
    });

    await expect(store.write({ key: "turns/one", value: bytes("value"), signal }))
      .rejects.toMatchObject({ code: "STATE_PATH_CHANGED" });
    expect(await readFile(join(config.root, "lease.sqlite.index"))).toEqual(operatorBytes);
    await expect(store.read({ key: "turns/one", signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await store.close();
    expect(await readFile(join(config.root, "lease.sqlite.index"))).toEqual(operatorBytes);
    expect(moved).not.toBe("");
  });

  it("never touches a rollback-journal hardlink injected during a state transaction", async () => {
    const config = await createConfig();
    const external = join(config.root, "..", "operator-journal");
    const operatorBytes = Buffer.from("external bytes behind injected journal hardlink", "utf8");
    await writeFile(external, operatorBytes, { mode: 0o600 });
    let injected = false;
    let sidecar = "";
    const store = await open(config, {
      snapshot: {
        afterCheck: async (target) => {
          if (injected) return;
          injected = true;
          sidecar = `${target.slice(0, -".index".length)}-journal`;
          await link(external, sidecar);
        },
      },
    });

    await expect(store.write({ key: "turns/one", value: bytes("committed"), signal }))
      .rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
    expect(await readFile(external)).toEqual(operatorBytes);
    expect(await readFile(sidecar)).toEqual(operatorBytes);
    await expect(store.close()).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
    expect(await readFile(external)).toEqual(operatorBytes);
    expect(await readFile(sidecar)).toEqual(operatorBytes);
  });

  it("truncates only an incomplete descriptor-log tail and retains committed state", async () => {
    const config = await createConfig();
    const store = await open(config);
    const lockPath = join(config.root, "lease.sqlite");
    const lockBytes = await readFile(lockPath);
    await store.write({ key: "turns/one", value: bytes("committed"), signal });
    await store.close();
    expect(await readFile(lockPath)).toEqual(lockBytes);
    expect((await readdir(config.root)).filter((name) =>
      /^lease\.sqlite-(?:journal|wal|shm)$/u.test(name))).toEqual([]);
    const indexPath = join(config.root, "lease.sqlite.index");
    const committedSize = (await stat(indexPath)).size;
    await appendFile(indexPath, Buffer.from([0, 0, 0]));
    expect((await stat(indexPath)).size).toBe(committedSize + 3);

    const reopened = await open(config);
    expect(text((await reopened.read({ key: "turns/one", signal }))?.value)).toBe("committed");
    expect((await stat(indexPath)).size).toBe(committedSize);
    await reopened.close();
  });

  it("rejects a full-length frame with a damaged commit footer without truncating it", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.write({ key: "turns/one", value: bytes("committed"), signal });
    await store.close();
    const indexPath = join(config.root, "lease.sqlite.index");
    const size = (await stat(indexPath)).size;
    const handle = await openFile(indexPath, "r+");
    try {
      await handle.write(Buffer.from([0]), 0, 1, size - 1);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect((await stat(indexPath)).size).toBe(size);
  });

  it("rejects a committed frame whose four-byte length is corrupted without truncating it", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.write({ key: "turns/one", value: bytes("committed"), signal });
    await store.close();
    const indexPath = join(config.root, "lease.sqlite.index");
    const size = (await stat(indexPath)).size;
    const frameOffset = Buffer.byteLength("mono-agent-state-index-v2\n", "utf8");
    const corruptLength = Buffer.allocUnsafe(4);
    corruptLength.writeUInt32BE(0x7fff_ffff);
    const handle = await openFile(indexPath, "r+");
    try {
      await handle.write(corruptLength, 0, corruptLength.byteLength, frameOffset);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect((await stat(indexPath)).size).toBe(size);
  });

  it("uses a committed footer to reject coherently corrupted header lengths", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.write({ key: "turns/one", value: bytes("committed"), signal });
    await store.close();
    const indexPath = join(config.root, "lease.sqlite.index");
    const size = (await stat(indexPath)).size;
    const frameOffset = Buffer.byteLength("mono-agent-state-index-v2\n", "utf8");
    const corruptHeader = Buffer.allocUnsafe(8);
    corruptHeader.writeUInt32BE(0x7fff_ffff, 0);
    corruptHeader.writeUInt32BE(0x8000_0000, 4);
    const handle = await openFile(indexPath, "r+");
    try {
      await handle.write(corruptHeader, 0, corruptHeader.byteLength, frameOffset);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect((await stat(indexPath)).size).toBe(size);
  });

  it("rejects a directory device/inode swap while open", async () => {
    const config = await createConfig();
    const store = await open(config);
    const moved = `${config.root}.moved`;
    await rename(config.root, moved);
    await writePrivateDirectory(config.root);

    await expect(store.read({ key: "anything", signal }))
      .rejects.toMatchObject({ code: "STATE_PATH_CHANGED" });
    await store.close();
  });

  it("fails closed on corruption without rewriting the corrupt bytes", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.write({ key: "one", value: bytes("one"), signal });
    await store.close();

    const path = join(config.root, "lease.sqlite");
    const corrupt = Buffer.from('{"not":"a snapshot"}\n', "utf8");
    await writeIndexedSnapshot(path, corrupt);
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readIndexedSnapshot(path)).toEqual(corrupt);
  });

  it("publishes owner-private presence and a stopped terminal descriptor", async () => {
    const config = await createConfig(true);
    const store = await open(config);
    await store.start({ signal });
    const descriptor = await store.publishPresence(
      { status: "degraded", details: { reason: "test" } },
      signal,
    );
    expect(descriptor.status).toBe("degraded");

    const registry = config.discovery?.registryDirectory;
    expect(registry).toBeDefined();
    expect((await stat(registry!)).mode & 0o777).toBe(0o700);
    const path = join(registry!, "agent-one.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(path)).nlink).toBe(1);
    expect(await readdir(registry!)).toEqual(["agent-one.json"]);

    await store.close();
    const terminal = JSON.parse(await readFile(path, "utf8")) as { status: string };
    expect(terminal.status).toBe("stopped");
  });

  it("repairs a torn fixed-size presence cache from its committed publication", async () => {
    const config = await createConfig(true);
    const registry = config.discovery?.registryDirectory;
    expect(registry).toBeDefined();
    const path = join(registry!, "agent-one.json");

    const first = await open(config);
    await first.start({ signal });
    await first.close();
    await writeFile(path, '{"schema":"mono-agent.state-presence.v1","status":', {
      mode: 0o600,
    });
    await expect(readFile(path, "utf8")).resolves.not.toMatch(/\}$/u);

    const reopened = await open(config);
    await reopened.start({ signal });
    const repairedBytes = await readFile(path);
    expect(repairedBytes.byteLength).toBe(64 * 1024);
    const repaired = JSON.parse(repairedBytes.toString("utf8")) as {
      status: string;
      details: { _stateLocalPublication: { generation: number; checksum: string } };
    };
    expect(repaired.status).toBe("ready");
    expect(repaired.details._stateLocalPublication.generation).toBeGreaterThan(1);
    expect(repaired.details._stateLocalPublication.checksum).toMatch(/^[a-f0-9]{64}$/u);
    await reopened.close();
  });

  it("accepts optional host presence when discovery is not configured", async () => {
    const store = await open(await createConfig());
    await store.start({ signal });
    await expect(store.publishHostPresence({
      status: "ready",
      details: { operatorRegistry: { schema: "mono-agent.operator-registry-details.v1" } },
      signal,
    })).resolves.toBeUndefined();
    await store.close();
  });

  it("implements atomic create/update compare-and-swap without throwing on conflicts", async () => {
    const config = await createConfig();
    const store = await open(config);
    const created = await store.compareAndSwap({
      key: "cas/key",
      expectedVersion: null,
      value: bytes("one"),
      signal,
    });
    expect(created).toMatchObject({ status: "applied", record: { key: "cas/key" } });
    if (created.status !== "applied") throw new Error("Expected CAS create to apply.");

    expect(await store.compareAndSwap({
      key: "cas/key",
      expectedVersion: null,
      value: bytes("duplicate"),
      signal,
    })).toEqual({ status: "conflict", currentVersion: created.record.version });
    expect(await store.compareAndSwap({
      key: "missing",
      expectedVersion: created.record.version,
      value: bytes("missing"),
      signal,
    })).toEqual({ status: "conflict" });

    const updated = await store.compareAndSwap({
      key: "cas/key",
      expectedVersion: created.record.version,
      value: bytes("two"),
      signal,
    });
    expect(updated.status).toBe("applied");
    if (updated.status !== "applied") throw new Error("Expected CAS update to apply.");
    expect(text(updated.record.value)).toBe("two");
    expect(await store.compareAndSwap({
      key: "cas/key",
      expectedVersion: created.record.version,
      value: bytes("stale"),
      signal,
    })).toMatchObject({ status: "conflict" });
    await store.close();
  });

  it("commits explicit multi-key transactions all at once and preserves them across restart", async () => {
    const config = await createConfig();
    const store = await open(config);
    const alpha = await store.write({ key: "runs/alpha", value: bytes("old"), signal });
    const guard = await store.write({ key: "runs/guard", value: bytes("guard"), signal });
    const retired = await store.write({ key: "runs/retired", value: bytes("retired"), signal });

    const result = await store.transaction({
      checks: [{ key: "runs/guard", expectedVersion: guard.version }],
      puts: [
        { key: "runs/alpha", expectedVersion: alpha.version, value: bytes("updated") },
        { key: "runs/current", expectedVersion: null, value: bytes("current") },
      ],
      deletes: [
        { key: "runs/retired", expectedVersion: retired.version },
        { key: "runs/already-absent", expectedVersion: null },
      ],
      signal,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("Expected transaction to apply.");
    expect(result.records.map((record) => record.key)).toEqual(["runs/alpha", "runs/current"]);
    expect(new Set(result.records.map((record) => record.version)).size).toBe(2);
    expect(result.deletedKeys).toEqual(["runs/retired"]);
    result.records[0]?.value.fill(0);
    expect(text((await store.read({ key: "runs/alpha", signal }))?.value)).toBe("updated");
    await store.close();

    const reopened = await open(config);
    expect(text((await reopened.read({ key: "runs/alpha", signal }))?.value)).toBe("updated");
    expect(text((await reopened.read({ key: "runs/current", signal }))?.value)).toBe("current");
    expect(await reopened.read({ key: "runs/retired", signal })).toBeUndefined();
    await reopened.close();
  });

  it("reopens a transaction snapshot containing long Unicode and JSON-escaped keys", async () => {
    const config = await createConfig();
    const store = await open(config);
    const longSegment = `${"界".repeat(500)}${'"'.repeat(500)}`;
    const keys = Array.from(
      { length: 30 },
      (_, index) => `runs/${String(index).padStart(2, "0")}-${longSegment}`,
    );
    const result = await store.transaction({
      checks: [],
      puts: keys.map((key) => ({ key, expectedVersion: null, value: bytes("x") })),
      deletes: [],
      signal,
    });
    expect(result.status).toBe("applied");
    await store.close();

    const encoded = await readIndexedSnapshot(join(config.root, "lease.sqlite"));
    const legacyUnderestimate =
      config.maxTotalBytes * 2 + config.maxRecords * 256 + 4_096;
    expect(encoded.byteLength).toBeGreaterThan(legacyUnderestimate);

    const reopened = await open(config);
    const records = await reopened.scan({ prefix: "runs/", limit: 100, signal });
    expect(records.records.map((record) => record.key)).toEqual(keys);
    await reopened.close();
  });

  it("reports every transaction conflict and leaves all candidate mutations unapplied", async () => {
    const config = await createConfig();
    const store = await open(config);
    const alpha = await store.write({ key: "runs/alpha", value: bytes("alpha"), signal });
    const retired = await store.write({ key: "runs/retired", value: bytes("retired"), signal });

    const result = await store.transaction({
      checks: [{ key: "runs/missing", expectedVersion: alpha.version }],
      puts: [
        { key: "runs/alpha", expectedVersion: retired.version, value: bytes("changed") },
        { key: "runs/new", expectedVersion: null, value: bytes("new") },
      ],
      deletes: [{ key: "runs/retired", expectedVersion: alpha.version }],
      signal,
    });

    expect(result).toEqual({
      status: "conflict",
      conflicts: [
        { key: "runs/missing" },
        { key: "runs/alpha", currentVersion: alpha.version },
        { key: "runs/retired", currentVersion: retired.version },
      ],
    });
    expect(text((await store.read({ key: "runs/alpha", signal }))?.value)).toBe("alpha");
    expect(text((await store.read({ key: "runs/retired", signal }))?.value)).toBe("retired");
    expect(await store.read({ key: "runs/new", signal })).toBeUndefined();
    await store.close();
  });

  it("rejects ambiguous, sparse, accessor-backed, and oversized transaction inputs", async () => {
    const config = await createConfig();
    const store = await open(config);
    const sparse = new Array(1);
    const accessor = Object.defineProperty({}, "key", {
      enumerable: true,
      get: () => "runs/accessor",
    });
    Object.defineProperties(accessor, {
      expectedVersion: { enumerable: true, value: null },
      value: { enumerable: true, value: bytes("value") },
    });

    expect(() => store.transaction({
      checks: sparse,
      puts: [],
      deletes: [],
      signal,
    } as never)).toThrowError(expect.objectContaining({ code: "STATE_INVALID_CONFIG" }));
    expect(() => store.transaction({
      checks: [],
      puts: [accessor],
      deletes: [],
      signal,
    } as never)).toThrowError(expect.objectContaining({ code: "STATE_INVALID_CONFIG" }));
    expect(() => store.transaction({
      checks: [{ key: "runs/repeated-entry", expectedVersion: null }],
      puts: [{ key: "runs/repeated-entry", expectedVersion: null, value: bytes("value") }],
      deletes: [],
      signal,
    })).toThrowError(expect.objectContaining({ code: "STATE_INVALID_CONFIG" }));
    expect(() => store.transaction({
      checks: [],
      puts: [{
        key: "runs/oversized",
        expectedVersion: null,
        value: new Uint8Array(config.maxRecordBytes + 1),
      }],
      deletes: [],
      signal,
    })).toThrowError(expect.objectContaining({ code: "STATE_LIMIT_EXCEEDED" }));
    const ownAccessor = new Uint8Array(config.maxRecordBytes + 1);
    Object.defineProperty(ownAccessor, "byteLength", {
      configurable: true,
      get: () => 0,
    });
    expect(() => store.transaction({
      checks: [],
      puts: [{
        key: "runs/own-byte-length",
        expectedVersion: null,
        value: ownAccessor,
      }],
      deletes: [],
      signal,
    })).toThrowError(expect.objectContaining({ code: "STATE_LIMIT_EXCEEDED" }));
    class MisreportedUint8Array extends Uint8Array {
      override get byteLength(): number {
        return 0;
      }
    }
    expect(() => store.transaction({
      checks: [],
      puts: [{
        key: "runs/subclass-byte-length",
        expectedVersion: null,
        value: new MisreportedUint8Array(config.maxRecordBytes + 1),
      }],
      deletes: [],
      signal,
    })).toThrowError(expect.objectContaining({ code: "STATE_LIMIT_EXCEEDED" }));
    const proxied = new Proxy(new Uint8Array(config.maxRecordBytes + 1), {
      get(target, property) {
        if (property === "byteLength" || property === "length") return 0;
        return Reflect.get(target, property, target);
      },
    });
    expect(() => store.transaction({
      checks: [],
      puts: [{
        key: "runs/proxied-byte-length",
        expectedVersion: null,
        value: proxied,
      }],
      deletes: [],
      signal,
    })).toThrowError(expect.objectContaining({ code: "STATE_INVALID_CONFIG" }));
    expect(() => store.transaction({
      checks: Array.from({ length: 1_001 }, (_, index) => ({
        key: `runs/bounded-${index}`,
        expectedVersion: null,
      })),
      puts: [],
      deletes: [],
      signal,
    })).toThrowError(expect.objectContaining({ code: "STATE_LIMIT_EXCEEDED" }));
    expect(() => store.transaction(Object.assign({
      checks: [{ key: "runs/symbol", expectedVersion: null }],
      puts: [],
      deletes: [],
      signal,
    }, { [Symbol("hidden")]: true }))).toThrowError(expect.objectContaining({
      code: "STATE_INVALID_CONFIG",
    }));
    expect(await store.scan({ prefix: "runs/", limit: 10, signal })).toEqual({ records: [] });
    await store.close();
  });

  it("uses prefix-bound last-key scan cursors that continue across intervening commits", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.write({ key: "runs/a", value: bytes("a"), signal });
    await store.write({ key: "runs/c", value: bytes("c"), signal });
    await store.write({ key: "other/a", value: bytes("other"), signal });

    const first = await store.scan({ prefix: "runs/", limit: 1, signal });
    expect(first.records.map((record) => record.key)).toEqual(["runs/a"]);
    if (first.cursor === undefined) throw new Error("Expected a forward scan cursor.");
    await store.write({ key: "runs/b", value: bytes("b"), signal });
    const second = await store.scan({
      prefix: "runs/",
      cursor: first.cursor,
      limit: 10,
      signal,
    });
    expect(second.records.map((record) => record.key)).toEqual(["runs/b", "runs/c"]);
    expect(second.cursor).toBeUndefined();
    await expect(store.scan({
      prefix: "other/",
      cursor: first.cursor,
      limit: 10,
      signal,
    })).rejects.toMatchObject({ code: "STATE_INVALID_CURSOR" });
    await store.close();
  });

  it("paginates after maximally escaped valid keys without emitting an unusable cursor", async () => {
    const config = await createConfig();
    const store = await open(config);
    const escapedKey = `runs/${"\ud800".repeat(1_000)}`;
    const laterKey = "runs/\ue000";
    await store.write({ key: escapedKey, value: bytes("escaped"), signal });
    await store.write({ key: laterKey, value: bytes("later"), signal });

    const first = await store.scan({ prefix: "runs/", limit: 1, signal });
    expect(first.records.map((record) => record.key)).toEqual([escapedKey]);
    expect(first.cursor?.length).toBeGreaterThan(4_096);
    if (first.cursor === undefined) throw new Error("Expected a long escaped-key cursor.");
    const second = await store.scan({
      prefix: "runs/",
      cursor: first.cursor,
      limit: 1,
      signal,
    });
    expect(second.records.map((record) => record.key)).toEqual([laterKey]);
    expect(second.cursor).toBeUndefined();
    await store.close();
  });

  it("recovers one complete transaction snapshot after an uncertain committed write", async () => {
    const config = await createConfig();
    let crash = true;
    const store = await open(config, {
      snapshot: {
        afterRename: () => {
          if (!crash) return;
          crash = false;
          throw new Error("simulated transaction crash after commit");
        },
      },
    });

    await expect(store.transaction({
      checks: [],
      puts: [
        { key: "runs/one", expectedVersion: null, value: bytes("one") },
        { key: "runs/two", expectedVersion: null, value: bytes("two") },
      ],
      deletes: [],
      signal,
    })).rejects.toMatchObject({ code: "STATE_POISONED" });
    await expect(store.read({ key: "runs/one", signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await store.close();

    const reopened = await open(config);
    expect(text((await reopened.read({ key: "runs/one", signal }))?.value)).toBe("one");
    expect(text((await reopened.read({ key: "runs/two", signal }))?.value)).toBe("two");
    await reopened.close();
  });

  it("persists, filters, and safely removes hidden presence records", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.write({ key: "visible/a", value: bytes("a"), signal });
    await store.write({ key: "visible/b", value: bytes("b"), signal });
    const first = await store.list({ prefix: "visible/", limit: 1, signal });
    const cursor = first.cursor;
    if (cursor === undefined) throw new Error("Expected a cursor before presence update.");

    const active = {
      presenceId: "presence-active",
      agentId: "agent-a",
      instanceId: "instance-new",
      updatedAt: "2026-07-23T11:59:00.000Z",
      expiresAt: "2026-07-23T12:01:00.000Z",
      metadata: { endpoint: "http://127.0.0.1:3000" },
    } as const;
    const expired = {
      presenceId: "presence-expired",
      agentId: "agent-b",
      instanceId: "instance-old",
      updatedAt: "2026-07-23T10:00:00.000Z",
      expiresAt: "2026-07-23T11:00:00.000Z",
    } as const;
    const returned = await store.upsertPresence({ presence: active, signal });
    await store.upsertPresence({ presence: expired, signal });

    expect((await store.list({ prefix: "visible/", cursor, limit: 1, signal })).records)
      .toHaveLength(1);
    expect((await store.list({ limit: 100, signal })).records.map((record) => record.key))
      .toEqual(["visible/a", "visible/b"]);
    await expect(store.read({ key: "@mono-agent/internal/presence/forbidden", signal }))
      .rejects.toMatchObject({ code: "STATE_INVALID_KEY" });

    (returned.metadata as { endpoint?: string }).endpoint = "mutated";
    expect(await store.listPresence({ signal })).toEqual([active]);
    expect(await store.listPresence({ agentId: "agent-b", signal })).toEqual([]);
    expect((await store.listPresence({ includeExpired: true, signal })).map((item) => item.presenceId))
      .toEqual(["presence-active", "presence-expired"]);
    expect(await store.removePresence({
      presenceId: active.presenceId,
      instanceId: "stale-instance",
      signal,
    })).toBe(false);
    expect(await store.removePresence({
      presenceId: active.presenceId,
      instanceId: active.instanceId,
      signal,
    })).toBe(true);
    await store.close();

    const reopened = await open(config);
    expect((await reopened.listPresence({ includeExpired: true, signal })).map((item) => item.presenceId))
      .toEqual(["presence-expired"]);
    await reopened.close();
  });

  it("keeps accepted Unicode presence identities reopenable and rejects oversized durable keys", async () => {
    const config = await createConfig();
    const store = await open(config);
    const acceptedPresenceId = "界".repeat(128);
    const presence = {
      presenceId: acceptedPresenceId,
      agentId: "agent-unicode",
      instanceId: "instance-unicode",
      updatedAt: "2026-07-23T11:59:00.000Z",
      expiresAt: "2026-07-23T12:01:00.000Z",
    } as const;

    await store.upsertPresence({ presence, signal });
    await expect(store.upsertPresence({
      presence: {
        ...presence,
        presenceId: "界".repeat(129),
      },
      signal,
    })).rejects.toMatchObject({ code: "STATE_LIMIT_EXCEEDED" });
    await store.close();

    const reopened = await open(config);
    expect(await reopened.listPresence({ includeExpired: true, signal })).toEqual([presence]);
    await reopened.close();
  });
});

async function createConfig(withPresence = false): Promise<ResolvedStateLocalConfig> {
  const parent = await mkdtemp(join(tmpdir(), "mono-agent-state-test-"));
  roots.push(parent);
  return {
    root: join(parent, "state"),
    maxRecordBytes: 1024,
    maxRecords: 100,
    maxTotalBytes: 10_000,
    ...(withPresence
      ? {
          discovery: {
            registryDirectory: join(parent, "registry"),
            sourceId: "agent-one",
            sourceLabel: "Agent One",
            heartbeatMs: 60_000,
          },
        }
      : {}),
  };
}

function open(config: ResolvedStateLocalConfig, hooks?: StateLocalStoreHooks) {
  return StateLocalStore.open(config, {
    instanceId: "state-test",
    signal,
    clock: () => new Date("2026-07-23T12:00:00.000Z"),
    ...(hooks === undefined ? {} : { hooks }),
  });
}

async function writePrivateDirectory(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function text(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : Buffer.from(value).toString("utf8");
}

async function readIndexedSnapshot(path: string): Promise<Buffer> {
  const lease = await acquireProcessLease(path);
  try {
    const bytes = lease.readIndex("snapshot", 1024 * 1024);
    if (bytes === undefined) throw new Error("Expected indexed snapshot bytes.");
    return bytes;
  } finally {
    await lease.release();
  }
}

async function writeIndexedSnapshot(path: string, bytes: Uint8Array): Promise<void> {
  const lease = await acquireProcessLease(path);
  try {
    lease.writeIndex("snapshot", bytes);
  } finally {
    await lease.release();
  }
}
