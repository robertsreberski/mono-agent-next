import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { StateLocalError } from "../errors.js";
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

  it("fails a second writer while the process lease is live and allows reopening after release", async () => {
    const config = await createConfig();
    const first = await open(config);
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_ALREADY_OPEN" });
    await first.close();
    const reopened = await open(config);
    await reopened.close();
  });

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

    const path = join(config.root, "records.json");
    const corrupt = Buffer.from('{"not":"a snapshot"}\n', "utf8");
    await writeFile(path, corrupt, { mode: 0o600 });
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readFile(path)).toEqual(corrupt);
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

    await store.close();
    const terminal = JSON.parse(await readFile(path, "utf8")) as { status: string };
    expect(terminal.status).toBe("stopped");
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
