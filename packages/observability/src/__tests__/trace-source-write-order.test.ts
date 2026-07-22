import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const writeFault = vi.hoisted(() => ({
  intercept: undefined as undefined | ((
    original: (filePath: string, contents: string) => Promise<void>,
    filePath: string,
    contents: string,
  ) => Promise<void>),
}));

vi.mock("../artifact-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../artifact-fs.js")>();
  return {
    ...actual,
    writeJsonAtomic: async (filePath: string, contents: string): Promise<void> => {
      const intercept = writeFault.intercept;
      return intercept === undefined
        ? await actual.writeJsonAtomic(filePath, contents)
        : await intercept(actual.writeJsonAtomic, filePath, contents);
    },
  };
});

import { registerTraceSource } from "../index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  writeFault.intercept = undefined;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("trace source write ordering", () => {
  it("queues stop after an entered update and keeps the terminal manifest final", async () => {
    const root = await temporaryRoot();
    const registryDir = join(root, "registry");
    const source = await registerTraceSource({
      registryDir,
      sourceId: "ordered-stop",
      label: "Ordered Stop",
      artifactDir: join(root, "artifacts"),
    });
    const entered = deferred();
    const release = deferred();
    const writes: Array<{ status?: string; metadata?: Record<string, unknown> }> = [];
    writeFault.intercept = async (original, filePath, contents) => {
      writes.push(JSON.parse(contents) as { status?: string; metadata?: Record<string, unknown> });
      if (writes.length === 1) {
        entered.resolve();
        await release.promise;
      }
      await original(filePath, contents);
    };

    const update = source.update({ metadata: { revision: "entered" } });
    await entered.promise;
    const stop = source.stop();
    expect(source.manifest.status).toBe("stopped");
    const lateUpdate = source.update({ metadata: { revision: "late" } });
    const lateHeartbeat = source.heartbeat();
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    release.resolve();
    await Promise.all([update, stop, lateUpdate, lateHeartbeat]);

    expect(writes).toHaveLength(2);
    expect(writes.map((entry) => entry.status)).toEqual(["running", "stopped"]);
    const persisted = JSON.parse(await readFile(join(registryDir, "ordered-stop.json"), "utf8")) as {
      status?: string;
      metadata?: Record<string, unknown>;
    };
    expect(persisted.status).toBe("stopped");
    expect(persisted.metadata).toEqual({ revision: "entered" });
  });

  it("serializes newer updates after delayed actual writes without regressing the manifest", async () => {
    const root = await temporaryRoot();
    const registryDir = join(root, "registry");
    const source = await registerTraceSource({
      registryDir,
      sourceId: "ordered-update",
      label: "Ordered Update",
      artifactDir: join(root, "artifacts"),
    });
    const entered = deferred();
    const release = deferred();
    const revisions: unknown[] = [];
    writeFault.intercept = async (original, filePath, contents) => {
      const parsed = JSON.parse(contents) as { metadata?: Record<string, unknown> };
      revisions.push(parsed.metadata?.revision);
      if (revisions.length === 1) {
        entered.resolve();
        await release.promise;
      }
      await original(filePath, contents);
    };

    const older = source.update({ metadata: { revision: 1 } });
    await entered.promise;
    const newer = source.update({ metadata: { revision: 2 } });
    await Promise.resolve();
    expect(revisions).toEqual([1]);

    release.resolve();
    await Promise.all([older, newer]);

    expect(revisions).toEqual([1, 2]);
    const persisted = JSON.parse(await readFile(join(registryDir, "ordered-update.json"), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    expect(persisted.metadata).toEqual({ revision: 2 });
  });

  it("coalesces interval heartbeats to one waiter behind a slow manifest write", async () => {
    vi.useFakeTimers();
    const root = await temporaryRoot();
    const source = await registerTraceSource({
      registryDir: join(root, "registry"),
      sourceId: "bounded-heartbeat",
      label: "Bounded Heartbeat",
      artifactDir: join(root, "artifacts"),
      heartbeatMs: 250,
    });
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    writeFault.intercept = async (original, filePath, contents) => {
      writes += 1;
      if (writes === 1) {
        entered.resolve();
        await release.promise;
      }
      await original(filePath, contents);
    };

    await vi.advanceTimersByTimeAsync(250);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(writes).toBe(1);

    release.resolve();
    const stop = source.stop();
    await stop;
    expect(writes).toBe(2);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trace-source-write-order-"));
  roots.push(root);
  return root;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
