import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ARTIFACT_RETENTION_SWEEP_INTERVAL_MS,
  runArtifactRetentionPass,
  startArtifactRetentionScheduler,
} from "../artifact-retention.js";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("artifact retention app scheduler", () => {
  it("logs dry-run deletion plans without removing files", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", NOW - 40 * DAY_MS);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await runArtifactRetentionPass({
      artifactDir: dir,
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: true },
      logger,
      clock: () => NOW,
    });

    expect(result.prunedRunIds).toEqual(["old-run"]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Artifact retention dry run completed.",
      expect.objectContaining({ prunedRunCount: 1, removedFileCount: 2, prunedRunIds: ["old-run"] }),
    );
    await expectExists(join(dir, "old-run.summary.json"), true);
    await expectExists(join(dir, "old-run.events.jsonl"), true);
  });

  it("logs the complete dry-run plan instead of truncating large candidate sets", async () => {
    const dir = await tempDir();
    for (let index = 0; index < 21; index += 1) {
      await writeRun(dir, `old-run-${String(index).padStart(2, "0")}`, NOW - (40 + index) * DAY_MS);
    }
    const logger = { info: vi.fn(), warn: vi.fn() };

    await runArtifactRetentionPass({
      artifactDir: dir,
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: true },
      logger,
      clock: () => NOW,
    });

    const meta = logger.info.mock.calls[0]?.[1] as { prunedRunIds?: readonly string[]; removedFilePaths?: readonly string[] };
    expect(meta.prunedRunIds).toHaveLength(21);
    expect(meta.removedFilePaths).toHaveLength(42);
  });

  it("runs once on scheduler start, after stale-run reconciliation hook, and registers an unref interval", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", NOW - 40 * DAY_MS);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const unref = vi.fn();
    const clearInterval = vi.fn();
    const beforeFirstRun = vi.fn(async () => undefined);

    const scheduler = startArtifactRetentionScheduler({
      artifactDir: dir,
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: false },
      logger,
      clock: () => NOW,
      beforeFirstRun,
      setInterval: (callback, ms) => {
        expect(typeof callback).toBe("function");
        expect(ms).toBe(DEFAULT_ARTIFACT_RETENTION_SWEEP_INTERVAL_MS);
        return { unref };
      },
      clearInterval,
    });

    await scheduler.runNow();

    expect(beforeFirstRun).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Artifact retention pruned terminal run artifacts.",
      expect.objectContaining({ prunedRunCount: 1, removedFileCount: 2, skippedRunningCount: 0 }),
    );
    await expectExists(join(dir, "old-run.summary.json"), false);
    await expectExists(join(dir, "old-run.events.jsonl"), false);

    scheduler.stop();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("runs separate agent and memory retention passes each sweep", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-agent-run", NOW - 10 * DAY_MS);
    await writeRun(join(dir, "memory"), "old-memory-run", NOW - 10 * DAY_MS);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const beforeFirstRun = vi.fn(async () => undefined);

    const scheduler = startArtifactRetentionScheduler({
      artifactDir: dir,
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 500, dryRun: false },
      logger,
      clock: () => NOW,
      beforeFirstRun,
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
    });

    await scheduler.runNow();

    expect(beforeFirstRun).toHaveBeenCalledTimes(1);
    await expectExists(join(dir, "old-agent-run.summary.json"), true);
    await expectExists(join(dir, "memory", "old-memory-run.summary.json"), false);
    expect(logger.info).toHaveBeenCalledWith(
      "Memory artifact retention pruned terminal run artifacts.",
      expect.objectContaining({ scope: "memory", prunedRunIds: ["old-memory-run"] }),
    );
    scheduler.stop();
  });

  it("bounds forget backups on the initial and interval sweeps", async () => {
    const dir = await tempDir();
    const memoryRoot = join(dir, ".mono-agent", "memory");
    const operatorRoot = join(dir, ".mono-agent", "operator");
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
    await mkdir(operatorRoot, { mode: 0o755 });
    for (let index = 1; index <= 4; index += 1) {
      await writeOperatorBackup(operatorRoot, `forget-${index}`, NOW - index * DAY_MS);
    }
    const logger = { info: vi.fn(), warn: vi.fn() };
    let intervalSweep: (() => void) | undefined;

    const scheduler = startArtifactRetentionScheduler({
      artifactDir: join(dir, "artifacts"),
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 500, dryRun: false },
      memoryRoot,
      logger,
      clock: () => NOW,
      setInterval: (callback) => {
        intervalSweep = callback;
        return { unref: vi.fn() };
      },
      clearInterval: vi.fn(),
    });

    await vi.waitFor(async () => {
      await expectExists(join(operatorRoot, "forget-4"), false);
    });
    const expired = join(operatorRoot, "forget-expired");
    await writeOperatorBackup(operatorRoot, "forget-expired", NOW - 40 * DAY_MS);
    intervalSweep?.();
    await vi.waitFor(async () => {
      await expectExists(expired, false);
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Memory forget-backup retention pruned snapshots.",
      expect.objectContaining({ maxAgeDays: 30, maxCount: 3, retainedCount: 3, prunedCount: 1 }),
    );
    scheduler.stop();
  });

  it("lets stop cancel an asynchronously claimed forget backup before removal", async () => {
    const dir = await tempDir();
    const memoryRoot = join(dir, ".mono-agent", "memory");
    const operatorRoot = join(dir, ".mono-agent", "operator");
    const candidate = join(operatorRoot, "forget-cancelled");
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
    await mkdir(operatorRoot, { mode: 0o755 });
    await writeOperatorBackup(operatorRoot, "forget-cancelled", NOW - 40 * DAY_MS);
    let releaseClaim: (() => void) | undefined;
    let markClaimed: (() => void) | undefined;
    const claimed = new Promise<void>((resolve) => { markClaimed = resolve; });
    const waitForRelease = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const logger = { info: vi.fn(), warn: vi.fn() };

    const scheduler = startArtifactRetentionScheduler({
      artifactDir: join(dir, "artifacts"),
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 500, dryRun: false },
      memoryRoot,
      logger,
      clock: () => NOW,
      forgetBackupRetentionHooks: {
        afterClaim: async () => {
          markClaimed?.();
          await waitForRelease;
        },
      },
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
    });

    await claimed;
    scheduler.stop();
    releaseClaim?.();
    await vi.waitFor(async () => {
      await expectExists(candidate, true);
    });
    expect(logger.info).not.toHaveBeenCalledWith(
      "Memory forget-backup retention pruned snapshots.",
      expect.anything(),
    );
  });

  it("does not prune after stop while the first-run hook is still pending", async () => {
    const dir = await tempDir();
    await writeRun(dir, "old-run", NOW - 40 * DAY_MS);
    const logger = { info: vi.fn(), warn: vi.fn() };
    let releaseHook: (() => void) | undefined;
    const hookReleased = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });

    const scheduler = startArtifactRetentionScheduler({
      artifactDir: dir,
      retention: { maxAgeDays: 30, maxCount: 5000, dryRun: false },
      logger,
      clock: () => NOW,
      beforeFirstRun: async () => {
        await hookReleased;
      },
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
    });

    scheduler.stop();
    releaseHook?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expectExists(join(dir, "old-run.summary.json"), true);
    await expectExists(join(dir, "old-run.events.jsonl"), true);
    expect(logger.info).not.toHaveBeenCalledWith(
      "Artifact retention pruned terminal run artifacts.",
      expect.anything(),
    );
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-artifact-retention-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeRun(dir: string, runId: string, updatedAtMs: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const updatedAt = new Date(updatedAtMs).toISOString();
  await writeFile(
    join(dir, `${runId}.summary.json`),
    `${JSON.stringify({
      runId,
      conversationId: "chat",
      status: "succeeded",
      startedAt: new Date(updatedAtMs - 1_000).toISOString(),
      endedAt: updatedAt,
      updatedAt,
      artifactPaths: [
        join(dir, `${runId}.events.jsonl`),
        join(dir, `${runId}.summary.json`),
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(dir, `${runId}.events.jsonl`), "{}\n", "utf8");
}

async function writeOperatorBackup(dir: string, name: string, updatedAtMs: number): Promise<void> {
  const backup = join(dir, name);
  await mkdir(backup, { mode: 0o755 });
  const updatedAt = new Date(updatedAtMs);
  await utimes(backup, updatedAt, updatedAt);
}

async function expectExists(path: string, exists: boolean): Promise<void> {
  await expect(access(path, constants.F_OK).then(() => true, () => false)).resolves.toBe(exists);
}
