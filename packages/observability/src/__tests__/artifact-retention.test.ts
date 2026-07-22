import { access, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  pruneRunArtifacts,
} from "../index.js";
import type { RunSummaryStatus } from "../index.js";
import { ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS } from "../artifact-fs.js";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-retention-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pruneRunArtifacts", () => {
  it("removes an old atomic-write temp during retention", async () => {
    const dir = await tempDir();
    const orphanPath = join(dir, `orphan.summary.json.${process.pid}.1.tmp`);
    await writeFile(orphanPath, "orphan", "utf8");
    const old = new Date(NOW - ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS - 1_000);
    await utimes(orphanPath, old, old);

    await pruneRunArtifacts({ artifactDir: dir, maxCount: 100_000, clock: () => NOW });

    await expectExists(orphanPath, false);
  });

  it("prunes terminal run artifacts older than maxAgeDays", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", "succeeded", NOW - 8 * DAY_MS);
    await writeRun(dir, "fresh-run", "succeeded", NOW - DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result).toMatchObject({
      dryRun: false,
      scannedSummaryFiles: 2,
      parsedSummaryFiles: 2,
      eligibleRunCount: 2,
      skippedRunningCount: 0,
      prunedRunCount: 1,
      removedFileCount: 2,
      prunedRunIds: ["old-run"],
      warnings: [],
    });
    expect(relatives(dir, result.removedFilePaths)).toEqual(["old-run.events.jsonl", "old-run.summary.json"]);
    await expectExists(join(dir, "old-run.summary.json"), false);
    await expectExists(join(dir, "old-run.events.jsonl"), false);
    await expectExists(join(dir, "fresh-run.summary.json"), true);
    await expectExists(join(dir, "fresh-run.events.jsonl"), true);
  });

  it("keeps the newest terminal summaries by maxCount and prunes older terminal siblings", async () => {
    const dir = await tempDir();
    await writeRun(dir, "run-1", "succeeded", NOW - 4 * DAY_MS);
    await writeRun(dir, "run-2", "failed", NOW - 3 * DAY_MS);
    await writeRun(dir, "run-3", "cancelled", NOW - 2 * DAY_MS);
    await writeRun(dir, "run-4", "interrupted", NOW - DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxCount: 2,
      clock: () => NOW,
    });

    expect(result.prunedRunIds).toEqual(["run-1", "run-2"]);
    expect(result.removedFileCount).toBe(4);
    expect((await readdir(dir)).sort((a, b) => a.localeCompare(b))).toEqual([
      "run-3.events.jsonl",
      "run-3.summary.json",
      "run-4.events.jsonl",
      "run-4.summary.json",
    ]);
  });

  it("reports planned deletions during dryRun without deleting files", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", "succeeded", NOW - 30 * DAY_MS);
    const orphanPath = join(dir, `dry-run.summary.json.${process.pid}.1.tmp`);
    await writeFile(orphanPath, "orphan", "utf8");
    const old = new Date(NOW - ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS - 1_000);
    await utimes(orphanPath, old, old);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      dryRun: true,
      clock: () => NOW,
    });

    expect(result.dryRun).toBe(true);
    expect(result.prunedRunIds).toEqual(["old-run"]);
    expect(result.removedFileCount).toBe(2);
    expect(relatives(dir, result.removedFilePaths)).toEqual(["old-run.events.jsonl", "old-run.summary.json"]);
    await expectExists(join(dir, "old-run.summary.json"), true);
    await expectExists(join(dir, "old-run.events.jsonl"), true);
    await expectExists(orphanPath, true);
  });

  it("never prunes running summaries even when old or beyond maxCount", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-running", "running", NOW - 30 * DAY_MS);
    await writeRun(dir, "old-terminal", "succeeded", NOW - 29 * DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      maxCount: 0,
      clock: () => NOW,
    });

    expect(result.skippedRunningCount).toBe(1);
    expect(result.prunedRunIds).toEqual(["old-terminal"]);
    await expectExists(join(dir, "old-running.summary.json"), true);
    await expectExists(join(dir, "old-running.events.jsonl"), true);
    await expectExists(join(dir, "old-terminal.summary.json"), false);
    await expectExists(join(dir, "old-terminal.events.jsonl"), false);
  });

  it("prunes memory namespace and legacy top-level memory runs without pruning agent runs", async () => {
    const dir = await tempDir();
    const memoryDir = join(dir, "memory");
    await writeRun(dir, "agent-run", "succeeded", NOW - 30 * DAY_MS);
    await writeRun(dir, "mem-legacy", "succeeded", NOW - 30 * DAY_MS);
    await writeRun(memoryDir, "mem-new", "succeeded", NOW - 30 * DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      scope: "memory",
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result.prunedRunIds).toEqual(["mem-legacy", "mem-new"]);
    expect(relatives(dir, result.removedFilePaths)).toEqual([
      "mem-legacy.events.jsonl",
      "mem-legacy.summary.json",
      "memory/mem-new.events.jsonl",
      "memory/mem-new.summary.json",
    ]);
    await expectExists(join(dir, "agent-run.summary.json"), true);
    await expectExists(join(dir, "agent-run.events.jsonl"), true);
    await expectExists(join(dir, "mem-legacy.summary.json"), false);
    await expectExists(join(memoryDir, "mem-new.summary.json"), false);
  });

  it("default retention skips memory summaries", async () => {
    const dir = await tempDir();
    await writeRun(dir, "agent-run", "succeeded", NOW - 30 * DAY_MS);
    await writeRun(dir, "mem-legacy", "succeeded", NOW - 30 * DAY_MS);
    await writeRun(join(dir, "memory"), "mem-new", "succeeded", NOW - 30 * DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result.prunedRunIds).toEqual(["agent-run"]);
    await expectExists(join(dir, "mem-legacy.summary.json"), true);
    await expectExists(join(dir, "memory", "mem-new.summary.json"), true);
  });

  it("skips malformed summary files with warnings and continues pruning valid runs", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "bad.summary.json"), "{bad", "utf8");
    await writeRun(dir, "old-run", "failed", NOW - 30 * DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result.scannedSummaryFiles).toBe(2);
    expect(result.parsedSummaryFiles).toBe(1);
    expect(result.prunedRunIds).toEqual(["old-run"]);
    expect(result.warnings).toEqual([expect.stringMatching(/Skipping bad\.summary\.json: invalid JSON/u)]);
    await expectExists(join(dir, "bad.summary.json"), true);
    await expectExists(join(dir, "old-run.summary.json"), false);
  });

  it("keeps the summary retryable when event deletion fails", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", "failed", NOW - 30 * DAY_MS);
    await rm(join(dir, "old-run.events.jsonl"));
    await mkdir(join(dir, "old-run.events.jsonl"));

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result.prunedRunIds).toEqual([]);
    expect(result.removedFilePaths).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Keeping summary");
    await expectExists(join(dir, "old-run.summary.json"), true);
  });

  it("can cancel before deleting selected runs", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", "failed", NOW - 30 * DAY_MS);

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
      shouldContinue: () => false,
    });

    expect(result.prunedRunIds).toEqual([]);
    expect(result.warnings).toEqual(["Artifact retention cancelled before all selected runs were pruned."]);
    await expectExists(join(dir, "old-run.summary.json"), true);
    await expectExists(join(dir, "old-run.events.jsonl"), true);
  });

  it("returns a warning and empty result when the artifact directory is missing", async () => {
    const dir = join(await tempDir(), "missing");

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result).toMatchObject({
      artifactDir: dir,
      dryRun: false,
      scannedSummaryFiles: 0,
      parsedSummaryFiles: 0,
      eligibleRunCount: 0,
      skippedRunningCount: 0,
      prunedRunCount: 0,
      removedFileCount: 0,
      prunedRunIds: [],
      removedFilePaths: [],
    });
    expect(result.warnings).toEqual([`Artifact directory does not exist: ${dir}.`]);
  });

  it("returns before scanning when no retention limit is configured", async () => {
    const dir = join(await tempDir(), "missing");

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      clock: () => NOW,
    });

    expect(result).toMatchObject({
      artifactDir: dir,
      dryRun: false,
      scannedSummaryFiles: 0,
      parsedSummaryFiles: 0,
      eligibleRunCount: 0,
      skippedRunningCount: 0,
      prunedRunCount: 0,
      removedFileCount: 0,
      prunedRunIds: [],
      removedFilePaths: [],
    });
    expect(result.warnings).toEqual(["No retention limit provided; set maxAgeDays or maxCount to prune run artifacts."]);
  });

  it("does not recurse into memory or session directories and ignores untrusted artifactPaths", async () => {
    const dir = await tempDir();
    const memoryDir = join(dir, "memory");
    const sessionsDir = join(dir, "sessions");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    await writeRun(memoryDir, "memory-run", "succeeded", NOW - 30 * DAY_MS);
    await writeRun(sessionsDir, "session-run", "succeeded", NOW - 30 * DAY_MS);
    await writeRun(dir, "top-run", "succeeded", NOW - 30 * DAY_MS, {
      artifactPaths: [
        join(memoryDir, "memory-run.events.jsonl"),
        join(memoryDir, "memory-run.summary.json"),
        join(sessionsDir, "session-run.summary.json"),
      ],
    });
    await writeFile(join(dir, "top-run.extra.json"), "{}", "utf8");
    await writeFile(join(dir, "orphan.events.jsonl"), "{}\n", "utf8");

    const result = await pruneRunArtifacts({
      artifactDir: dir,
      maxAgeDays: 7,
      clock: () => NOW,
    });

    expect(result.prunedRunIds).toEqual(["top-run"]);
    expect(relatives(dir, result.removedFilePaths)).toEqual(["top-run.events.jsonl", "top-run.summary.json"]);
    await expectExists(join(memoryDir, "memory-run.summary.json"), true);
    await expectExists(join(memoryDir, "memory-run.events.jsonl"), true);
    await expectExists(join(sessionsDir, "session-run.summary.json"), true);
    await expectExists(join(sessionsDir, "session-run.events.jsonl"), true);
    await expectExists(join(dir, "top-run.extra.json"), true);
    await expectExists(join(dir, "orphan.events.jsonl"), true);
  });
});

async function writeRun(
  dir: string,
  runId: string,
  status: RunSummaryStatus,
  updatedAtMs: number,
  overrides: { readonly artifactPaths?: readonly string[] } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const updatedAt = new Date(updatedAtMs).toISOString();
  const base = runId;
  await writeFile(
    join(dir, `${base}.summary.json`),
    `${JSON.stringify({
      runId,
      conversationId: "chat",
      status,
      startedAt: new Date(updatedAtMs - 1_000).toISOString(),
      ...(status === "running" ? {} : { endedAt: updatedAt }),
      updatedAt,
      durationMs: 1_000,
      eventCount: 1,
      artifactPaths: overrides.artifactPaths ?? [
        join(dir, `${base}.events.jsonl`),
        join(dir, `${base}.summary.json`),
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(dir, `${base}.events.jsonl`), `${JSON.stringify({ type: "test" })}\n`, "utf8");
}

async function expectExists(path: string, exists: boolean): Promise<void> {
  await expect(access(path, constants.F_OK).then(() => true, () => false)).resolves.toBe(exists);
}

function relatives(root: string, paths: readonly string[]): readonly string[] {
  return paths.map((path) => relative(root, path)).sort((a, b) => a.localeCompare(b));
}
