import { link, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  MEMORY_LOCAL_MARKER_FILENAME,
  MemoryLocalError,
  openMemoryLocal,
  parseMemoryLocalConfig,
} from "../index.js";

const signal = new AbortController().signal;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local", () => {
  it("strictly validates bounded configuration", () => {
    expect(parseMemoryLocalConfig(undefined).capture.mode).toBe("direct");
    expect(() => parseMemoryLocalConfig({ unknown: true })).toThrow(/unknown field/u);
    expect(() => parseMemoryLocalConfig({ limits: { maxRecords: 0 } })).toThrow(/maxRecords/u);
    expect(() => parseMemoryLocalConfig({ capture: { mode: "implicit" } })).toThrow(/direct or runtime/u);
  });

  it("creates an owner-private permanent store and performs deterministic recall, capture, and forget", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal(options(root, directory));
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
      expect(recalled.records.map(({ id }) => id)).toEqual(["conversation", "later", "earlier"]);
      expect(await memory.forget?.({ recordId: "earlier", signal })).toBe(true);
      expect(await memory.forget?.({ recordId: "earlier", signal })).toBe(false);
      expect((await memory.recall({ query: "status", limit: 3, signal })).records.map(({ id }) => id)).toEqual(["later"]);
    } finally {
      await memory.stop();
    }

    const reopened = await openMemoryLocal(options(root, directory));
    try {
      expect((await reopened.recall({ query: "alpha", limit: 3, signal })).records.map(({ id }) => id)).toEqual([
        "later",
        "conversation",
      ]);
    } finally {
      await reopened.stop();
    }
  });

  it("makes exact duplicates idempotent and conflicting ids atomic", async () => {
    const { root, directory } = await fixture();
    const memory = await openMemoryLocal(options(root, directory));
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
    await expect(openMemoryLocal(options(first.root, first.directory, { capture: { mode: "runtime" } })))
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
      ...options(second.root, second.directory, { capture: { mode: "runtime", maxRecords: 2 } }),
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
      ...options(third.root, third.directory, { capture: { mode: "runtime", maxRecords: 1 } }),
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
