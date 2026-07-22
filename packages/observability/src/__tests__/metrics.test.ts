import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { summarizeRecordedRunMetrics } from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-metrics-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("summarizeRecordedRunMetrics", () => {
  it("aggregates status rates, failure-kind rates, duration percentiles, costs, and groups by model", async () => {
    const dir = await populatedMetricsDir();

    const report = await summarizeRecordedRunMetrics({ artifactDir: dir, groupBy: "model" });

    expect(report.totalSummaryFiles).toBe(8);
    expect(report.parsedSummaryFiles).toBe(7);
    expect(report.parseFailures[0]?.fileName).toBe("08-malformed.summary.json");
    expect(report.overall.totalRuns).toBe(7);
    expect(report.overall.statusCounts).toEqual({
      running: 1,
      succeeded: 2,
      failed: 2,
      cancelled: 1,
      interrupted: 1,
    });
    expect(report.overall.statusRates.failed).toBeCloseTo(2 / 7);
    expect(report.overall.failureKindRates).toContainEqual({
      failureKind: "usage_limit",
      count: 1,
      rate: 1 / 7,
    });
    expect(report.overall.failureKindRates).toContainEqual({
      failureKind: "provider_unavailable",
      count: 1,
      rate: 1 / 7,
    });
    expect(report.overall.durationMs).toEqual({
      count: 7,
      p50: 400,
      p90: 640,
      p99: 694,
      max: 700,
    });
    expect(report.overall.cost).toEqual({
      totalUsd: 0.6,
      averageUsdPerRun: 0.6 / 7,
      runsWithCost: 3,
    });
    expect(report.groups.map((group) => group.key)).toEqual([
      "claude:claude-sonnet-4-6",
      "codex:gpt-5.5",
      "unknown",
    ]);
    expect(report.groups.find((group) => group.key === "codex:gpt-5.5")?.statusCounts).toMatchObject({
      running: 1,
      succeeded: 1,
      failed: 1,
    });
  });

  it("filters windows by startedAt and excludes missing or invalid startedAt only when a window is active", async () => {
    const dir = await populatedMetricsDir();

    const unfiltered = await summarizeRecordedRunMetrics({ artifactDir: dir });
    const filtered = await summarizeRecordedRunMetrics({
      artifactDir: dir,
      since: "2026-06-24T10:03:00.000Z",
      until: "2026-06-24T10:04:00.000Z",
    });

    expect(unfiltered.overall.totalRuns).toBe(7);
    expect(filtered.overall.totalRuns).toBe(2);
    expect(filtered.overall.statusCounts).toMatchObject({
      cancelled: 1,
      interrupted: 1,
    });
  });

  it("groups by channel prefix and failure kind while leaving artifacts untouched", async () => {
    const dir = await populatedMetricsDir();
    const stalePath = join(dir, "06-running-missing-start.summary.json");
    const before = await readFile(stalePath, "utf8");

    const channelReport = await summarizeRecordedRunMetrics({ artifactDir: dir, groupBy: "channel" });
    const failureKindReport = await summarizeRecordedRunMetrics({ artifactDir: dir, groupBy: "failureKind" });

    expect(channelReport.groups.map((group) => [group.key, group.totalRuns])).toEqual([
      ["cron", 1],
      ["slack", 2],
      ["telegram", 3],
      ["unknown", 1],
    ]);
    expect(failureKindReport.groups.map((group) => [group.key, group.totalRuns])).toEqual([
      ["cancelled", 1],
      ["none", 3],
      ["process_death", 1],
      ["provider_unavailable", 1],
      ["usage_limit", 1],
    ]);
    await expect(readFile(stalePath, "utf8")).resolves.toBe(before);
  });

  it("defaults to agent metrics and includes memory summaries only by scope", async () => {
    const dir = await tempDir();
    await writeSummary(dir, "agent.summary.json", metricSummary({ runId: "agent", conversationId: "telegram:1", durationMs: 100 }));
    await writeSummary(dir, "mem-legacy.summary.json", metricSummary({
      runId: "mem-legacy",
      conversationId: "memory:legacy",
      durationMs: 200,
    }));
    await writeSummary(join(dir, "memory"), "mem-new.summary.json", metricSummary({
      runId: "mem-new",
      conversationId: "memory:new",
      source: "memory",
      durationMs: 300,
    }));

    const defaults = await summarizeRecordedRunMetrics({ artifactDir: dir });
    expect(defaults.overall.totalRuns).toBe(1);
    expect(defaults.overall.durationMs.max).toBe(100);

    const memory = await summarizeRecordedRunMetrics({ artifactDir: dir, scope: "memory" });
    expect(memory.overall.totalRuns).toBe(2);
    expect(memory.overall.durationMs.max).toBe(300);

    const all = await summarizeRecordedRunMetrics({ artifactDir: dir, scope: "all" });
    expect(all.overall.totalRuns).toBe(3);
    expect(all.overall.durationMs.max).toBe(300);
  });
});

async function populatedMetricsDir(): Promise<string> {
  const dir = await tempDir();
  await writeSummary(dir, "01-succeeded-codex.summary.json", {
    runId: "run-1",
    conversationId: "telegram:1",
    status: "succeeded",
    startedAt: "2026-06-24T10:00:00.000Z",
    endedAt: "2026-06-24T10:00:01.000Z",
    durationMs: 100,
    usage: { cost_usd: 9 },
    cost: { cumulativeUsd: 0.1 },
    model: "codex:gpt-5.5",
    eventCount: 0,
    artifactPaths: [],
  });
  await writeSummary(dir, "02-failed-usage.summary.json", {
    runId: "run-2",
    conversationId: "telegram:1",
    status: "failed",
    failureKind: "usage_limit",
    startedAt: "2026-06-24T10:01:00.000Z",
    endedAt: "2026-06-24T10:01:01.000Z",
    durationMs: 200,
    cost: { totalUsd: 0.2 },
    model: "codex:gpt-5.5",
    eventCount: 0,
    artifactPaths: [],
  });
  await writeSummary(dir, "03-failed-provider.summary.json", {
    runId: "run-3",
    conversationId: "slack:C1",
    status: "failed",
    failureKind: "provider_unavailable",
    startedAt: "2026-06-24T10:02:00.000Z",
    endedAt: "2026-06-24T10:02:01.000Z",
    durationMs: 300,
    usage: { cost_usd: 0.3 },
    model: "claude:claude-sonnet-4-6",
    eventCount: 0,
    artifactPaths: [],
  });
  await writeSummary(dir, "04-cancelled-unknown.summary.json", {
    runId: "run-4",
    conversationId: "email",
    status: "cancelled",
    failureKind: "cancelled",
    startedAt: "2026-06-24T10:03:00.000Z",
    endedAt: "2026-06-24T10:03:01.000Z",
    durationMs: 400,
    eventCount: 0,
    artifactPaths: [],
  });
  await writeSummary(dir, "05-interrupted-claude.summary.json", {
    runId: "run-5",
    conversationId: "cron:nightly",
    status: "interrupted",
    failureKind: "process_death",
    startedAt: "2026-06-24T10:04:00.000Z",
    endedAt: "2026-06-24T10:04:01.000Z",
    durationMs: 500,
    cost: { cumulativeUsd: "redacted" },
    model: "claude:claude-sonnet-4-6",
    eventCount: 0,
    artifactPaths: [],
  });
  await writeSummary(dir, "06-running-missing-start.summary.json", {
    runId: "run-6",
    conversationId: "telegram:2",
    status: "running",
    durationMs: 600,
    model: "codex:gpt-5.5",
    eventCount: 0,
    artifactPaths: [],
  });
  await writeSummary(dir, "07-succeeded-invalid-start.summary.json", {
    runId: "run-7",
    conversationId: "slack:C2",
    status: "succeeded",
    startedAt: "not-an-iso-date",
    endedAt: "2026-06-24T10:05:01.000Z",
    durationMs: 700,
    model: "claude:claude-sonnet-4-6",
    eventCount: 0,
    artifactPaths: [],
  });
  await writeFile(join(dir, "08-malformed.summary.json"), "{bad", "utf8");
  return dir;
}

async function writeSummary(dir: string, name: string, summary: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function metricSummary(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: "run",
    conversationId: "telegram:1",
    status: "succeeded",
    startedAt: "2026-06-24T10:00:00.000Z",
    endedAt: "2026-06-24T10:00:01.000Z",
    durationMs: 100,
    eventCount: 0,
    artifactPaths: [],
    ...overrides,
  };
}
