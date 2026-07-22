import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_RUNS } from "../artifact-fs.js";
import { auditRecordedRuns } from "../index.js";

const fixtureDir = fileURLToPath(new URL("../__fixtures__/artifact-audit/", import.meta.url));
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-audit-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("auditRecordedRuns", () => {
  it("counts parsed summaries, statuses, failure kinds, and malformed files", async () => {
    const report = await auditRecordedRuns(fixtureDir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });

    expect(report.totalSummaryFiles).toBe(13);
    expect(report.parsedSummaryFiles).toBe(12);
    expect(report.parseFailureCount).toBe(1);
    expect(report.parseFailures[0]?.fileName).toBe("13-malformed.summary.json");
    expect(report.parseFailures[0]?.reason).toMatch(/invalid JSON/u);

    expect(report.statusHistogram).toEqual({
      running: 2,
      succeeded: 1,
      failed: 6,
      cancelled: 1,
      interrupted: 1,
    });
    expect(report.failureKindHistogram).toEqual({
      provider_unavailable: 1,
      provider_unavailable_exhausted: 1,
      provider_auth: 0,
      skipped_capability_mismatch: 0,
      context_limit: 0,
      usage_limit: 1,
      process_death: 2,
      runtime_error: 1,
      cancelled: 1,
      cancelled_user: 0,
      cancelled_stale: 0,
      cancelled_shutdown: 0,
      cancelled_signal: 0,
    });
    expect(report.summariesWithFailureKind).toBe(8);
  });

  it("recognizes user cancellation without degrading artifact health", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "cancelled-user.summary.json"), JSON.stringify({
      runId: "cancelled-user",
      conversationId: "telegram:42",
      status: "cancelled",
      failureKind: "cancelled_user",
      startedAt: "2026-06-24T11:59:00.000Z",
      durationMs: 1,
      eventCount: 0,
      artifactPaths: [],
    }), "utf8");

    const report = await auditRecordedRuns(dir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });

    expect(report.unrecognizedFailureKindCount).toBe(0);
    expect(report.failureKindHistogram.cancelled_user).toBe(1);
  });

  it("reports unrecognized statuses and failure kinds without treating them as parse failures", async () => {
    const report = await auditRecordedRuns(fixtureDir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });

    expect(report.unrecognizedStatuses).toEqual([
      { fileName: "11-unknown-status.summary.json", reason: "unrecognized status", value: "timed_out" },
    ]);
    expect(report.unrecognizedFailureKinds).toEqual([
      { fileName: "12-unknown-failure-kind.summary.json", reason: "unrecognized failureKind", value: "provider_error" },
    ]);
    expect(report.unrecognizedStatusCount).toBe(1);
    expect(report.unrecognizedFailureKindCount).toBe(1);
  });

  it("flags stale running summaries without rewriting the artifact", async () => {
    const stalePath = join(fixtureDir, "01-running-stale.summary.json");
    const before = await readFile(stalePath, "utf8");

    const report = await auditRecordedRuns(fixtureDir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });

    expect(report.staleRunning).toEqual([
      {
        fileName: "01-running-stale.summary.json",
        reason: "running summary started before stale cutoff",
        value: "2026-06-24T11:58:00.000Z",
      },
    ]);
    expect(report.staleRunningCount).toBe(1);
    await expect(readFile(stalePath, "utf8")).resolves.toBe(before);
  });

  it("reports every summary file instead of applying listRecordedRuns maxRuns cap", async () => {
    const dir = await tempDir();
    const count = DEFAULT_MAX_RUNS + 7;
    for (let index = 0; index < count; index += 1) {
      await writeSummary(dir, `run-${String(index).padStart(3, "0")}.summary.json`, {
        runId: `run-${index}`,
        conversationId: "fixture",
        status: "succeeded",
        startedAt: "2026-06-24T10:00:00.000Z",
        endedAt: "2026-06-24T10:00:01.000Z",
        durationMs: 1000,
        eventCount: 0,
        artifactPaths: [],
      });
    }

    const report = await auditRecordedRuns(dir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });

    expect(report.totalSummaryFiles).toBe(count);
    expect(report.parsedSummaryFiles).toBe(count);
    expect(report.statusHistogram.succeeded).toBe(count);
  });

  it("defaults to agent summaries and includes memory summaries only by scope", async () => {
    const dir = await tempDir();
    await writeSummary(dir, "agent.summary.json", summary({ runId: "agent", conversationId: "telegram:1" }));
    await writeSummary(dir, "mem-legacy.summary.json", summary({ runId: "mem-legacy", conversationId: "memory:legacy" }));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeSummary(join(dir, "memory"), "mem-new.summary.json", summary({
      runId: "mem-new",
      conversationId: "memory:new",
      source: "memory",
    }));
    await writeSummary(join(dir, "memory"), "mem-malformed.summary.json", { not: "a run summary" });

    const defaults = await auditRecordedRuns(dir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });
    expect(defaults.totalSummaryFiles).toBe(1);
    expect(defaults.parsedSummaryFiles).toBe(1);
    expect(defaults.statusHistogram.succeeded).toBe(1);

    const memory = await auditRecordedRuns(dir, {
      scope: "memory",
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });
    expect(memory.totalSummaryFiles).toBe(3);
    expect(memory.parsedSummaryFiles).toBe(3);
    expect(memory.unrecognizedStatuses).toEqual([{ fileName: "memory/mem-malformed.summary.json", reason: "missing status" }]);

    const all = await auditRecordedRuns(dir, {
      scope: "all",
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });
    expect(all.totalSummaryFiles).toBe(4);
    expect(all.parsedSummaryFiles).toBe(4);
  });

  it("includes rates for every known failure kind with explicit denominators", async () => {
    const report = await auditRecordedRuns(fixtureDir, {
      now: Date.parse("2026-06-24T12:00:00.000Z"),
      staleAfterMs: 30_000,
    });

    expect(report.rateDenominators).toEqual({ parsedSummaries: 12, summariesWithFailureKind: 8 });
    expect(report.failureKindRates).toContainEqual({
      failureKind: "process_death",
      count: 2,
      rateOfParsedSummaries: 2 / 12,
      rateOfSummariesWithFailureKind: 2 / 8,
    });
  });
});

async function writeSummary(dir: string, name: string, summary: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: "run",
    conversationId: "telegram:1",
    status: "succeeded",
    startedAt: "2026-06-24T10:00:00.000Z",
    endedAt: "2026-06-24T10:00:01.000Z",
    durationMs: 1000,
    eventCount: 0,
    artifactPaths: [],
    ...overrides,
  };
}
