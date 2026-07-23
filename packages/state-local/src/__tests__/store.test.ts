import { appendFile, chmod, link, mkdtemp, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { StateLocalError } from "../errors.js";
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
