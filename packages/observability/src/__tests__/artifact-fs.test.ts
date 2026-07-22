import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeRunId, safeJoin, writeJsonAtomic } from "../artifact-fs.js";
import {
  ObservabilityReadError,
  readRecordedRun,
  readTraceRun,
  registerTraceSource,
  TraceSourceRegistryError,
} from "../index.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-fs-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class Sentinel extends Error {}
const raise = (message: string): never => {
  throw new Sentinel(message);
};

describe("safeJoin path containment", () => {
  const root = "/srv/artifacts";

  it("rejects traversal escapes and accepts in-root names", () => {
    expect(() => safeJoin(root, "../secrets.json", raise)).toThrow(Sentinel);
    expect(() => safeJoin(root, "../../etc/passwd", raise)).toThrow(Sentinel);
    expect(() => safeJoin(root, "a/../../escape", raise)).toThrow(Sentinel);
    // Nested-but-contained names resolve without raising.
    expect(safeJoin(root, "run.summary.json", raise)).toContain("run.summary.json");
    expect(safeJoin(root, "a/b", raise)).toContain(join("a", "b"));
  });
});

describe("normalizeRunId guard", () => {
  it("rejects path separators, parent refs, and empty ids", () => {
    expect(() => normalizeRunId("../secrets", raise)).toThrow(Sentinel);
    expect(() => normalizeRunId("a/b", raise)).toThrow(Sentinel);
    expect(() => normalizeRunId("a\\b", raise)).toThrow(Sentinel);
    expect(() => normalizeRunId("a..b", raise)).toThrow(Sentinel);
    expect(() => normalizeRunId("   ", raise)).toThrow(Sentinel);
    expect(normalizeRunId("  run-42  ", raise)).toBe("run-42");
  });

  it("routes empty ids to the dedicated raiseEmpty callback", () => {
    class Traversal extends Error {}
    class Empty extends Error {}
    const raiseTraversal = (m: string): never => { throw new Traversal(m); };
    const raiseEmpty = (m: string): never => { throw new Empty(m); };
    expect(() => normalizeRunId("", raiseTraversal, raiseEmpty)).toThrow(Empty);
    expect(() => normalizeRunId("a/b", raiseTraversal, raiseEmpty)).toThrow(Traversal);
  });
});

describe("public coded-error rejection of path-like ids", () => {
  it("readRecordedRun rejects traversal run ids with invalid_run_id", async () => {
    const dir = await tempDir();
    await expect(readRecordedRun({ artifactDir: dir }, "../escape")).rejects.toMatchObject({
      code: "invalid_run_id",
    });
    await expect(readRecordedRun({ artifactDir: dir }, "a/b")).rejects.toBeInstanceOf(ObservabilityReadError);
    await expect(readRecordedRun({ artifactDir: dir }, "a\\b")).rejects.toMatchObject({ code: "invalid_run_id" });
  });

  it("registerTraceSource rejects traversal source ids", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    for (const sourceId of ["../secret", "a/b", "a\\b", "..", "nested/../escape"]) {
      await expect(registerTraceSource({
        registryDir,
        sourceId,
        label: "Bad",
        artifactDir: join(dir, "artifacts"),
      })).rejects.toMatchObject({ code: "invalid_source_id" });
    }
  });

  it("writeJsonAtomic tolerates concurrent writers on the same path", async () => {
    const dir = await tempDir();
    const path = join(dir, "manifest.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => writeJsonAtomic(path, JSON.stringify({ index }))),
    );
  });

  it("readTraceRun rejects traversal source and run ids", async () => {
    const dir = await tempDir();
    const registryDir = join(dir, "registry");
    await expect(readTraceRun({ registryDir }, "../source", "ok-run")).rejects.toBeInstanceOf(TraceSourceRegistryError);
    await expect(readTraceRun({ registryDir }, "ok-source", "a/b")).rejects.toMatchObject({ code: "invalid_run_id" });
    await expect(readTraceRun({ registryDir }, "ok-source", "a\\b")).rejects.toMatchObject({ code: "invalid_run_id" });
  });
});
