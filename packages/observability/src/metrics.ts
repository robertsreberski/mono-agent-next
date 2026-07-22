import { readArtifactSummaryRecords } from "./artifact-summaries.js";
import { isRecord } from "./artifact-fs.js";
import {
  RUN_SUMMARY_STATUSES,
  isRunSummaryStatus,
} from "./summary-schema.js";
import type {
  ArtifactAuditFileIssue,
  RunArtifactScope,
  RunSummaryStatus,
} from "./types.js";

export type RecordedRunMetricGroupBy = "model" | "channel" | "failureKind";

export interface RecordedRunMetricsOptions {
  readonly artifactDir: string;
  readonly scope?: RunArtifactScope;
  readonly since?: string;
  readonly until?: string;
  readonly groupBy?: RecordedRunMetricGroupBy;
  readonly includeEvents?: boolean;
}

export interface RecordedRunDurationMetrics {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface RecordedRunCostMetrics {
  readonly totalUsd: number;
  readonly averageUsdPerRun: number;
  readonly runsWithCost: number;
}

export interface RecordedRunFailureKindMetric {
  readonly failureKind: string;
  readonly count: number;
  readonly rate: number;
}

export interface RecordedRunMetricsBucket {
  readonly key: string;
  readonly totalRuns: number;
  readonly statusCounts: Readonly<Record<RunSummaryStatus, number>>;
  readonly statusRates: Readonly<Record<RunSummaryStatus, number>>;
  readonly failureKindRates: readonly RecordedRunFailureKindMetric[];
  readonly durationMs: RecordedRunDurationMetrics;
  readonly cost: RecordedRunCostMetrics;
}

export interface RecordedRunMetricsReport {
  readonly artifactDir: string;
  readonly totalSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly parseFailureCount: number;
  readonly parseFailures: readonly ArtifactAuditFileIssue[];
  readonly since?: string;
  readonly until?: string;
  readonly groupBy?: RecordedRunMetricGroupBy;
  readonly overall: RecordedRunMetricsBucket;
  readonly groups: readonly RecordedRunMetricsBucket[];
  readonly warnings: readonly string[];
}

export async function summarizeRecordedRunMetrics(options: RecordedRunMetricsOptions): Promise<RecordedRunMetricsReport> {
  const window = normalizeWindow(options);
  const records = await readArtifactSummaryRecords(
    options.artifactDir,
    options.scope === undefined ? {} : { scope: options.scope },
  );
  const summaries = records.summaries
    .map((entry) => entry.raw)
    .filter((summary) => isInWindow(summary, window));
  const groups = options.groupBy === undefined
    ? []
    : buildGroups(summaries, options.groupBy);

  return {
    artifactDir: records.artifactDir,
    totalSummaryFiles: records.totalSummaryFiles,
    parsedSummaryFiles: records.parsedSummaryFiles,
    parseFailureCount: records.parseFailures.length,
    parseFailures: records.parseFailures,
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.groupBy === undefined ? {} : { groupBy: options.groupBy }),
    overall: buildBucket("overall", summaries),
    groups,
    warnings: records.warnings,
  };
}

function buildGroups(
  summaries: readonly Record<string, unknown>[],
  groupBy: RecordedRunMetricGroupBy,
): readonly RecordedRunMetricsBucket[] {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const summary of summaries) {
    const key = groupKey(summary, groupBy);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [summary]);
    } else {
      bucket.push(summary);
    }
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entries]) => buildBucket(key, entries));
}

function buildBucket(key: string, summaries: readonly Record<string, unknown>[]): RecordedRunMetricsBucket {
  const statusCounts = emptyStatusCounts();
  const failureKindCounts = new Map<string, number>();
  const durations: number[] = [];
  let totalUsd = 0;
  let runsWithCost = 0;

  for (const summary of summaries) {
    if (isRunSummaryStatus(summary.status)) {
      statusCounts[summary.status] += 1;
    }
    const failureKind = stringValue(summary.failureKind);
    if (failureKind !== undefined) {
      failureKindCounts.set(failureKind, (failureKindCounts.get(failureKind) ?? 0) + 1);
    }
    if (typeof summary.durationMs === "number" && Number.isFinite(summary.durationMs)) {
      durations.push(summary.durationMs);
    }
    const costUsd = costUsdFor(summary);
    if (costUsd !== undefined) {
      totalUsd += costUsd;
      runsWithCost += 1;
    }
  }

  const roundedTotalUsd = roundMetric(totalUsd);
  return {
    key,
    totalRuns: summaries.length,
    statusCounts,
    statusRates: statusRates(statusCounts, summaries.length),
    failureKindRates: failureKindRates(failureKindCounts, summaries.length),
    durationMs: durationMetrics(durations),
    cost: {
      totalUsd: roundedTotalUsd,
      averageUsdPerRun: summaries.length === 0 ? 0 : roundedTotalUsd / summaries.length,
      runsWithCost,
    },
  };
}

function groupKey(summary: Record<string, unknown>, groupBy: RecordedRunMetricGroupBy): string {
  if (groupBy === "model") {
    return stringValue(summary.model) ?? "unknown";
  }
  if (groupBy === "failureKind") {
    return stringValue(summary.failureKind) ?? "none";
  }
  const conversationId = stringValue(summary.conversationId);
  if (conversationId === undefined) {
    return "unknown";
  }
  const separator = conversationId.indexOf(":");
  return separator > 0 ? conversationId.slice(0, separator) : "unknown";
}

function statusRates(
  statusCounts: Readonly<Record<RunSummaryStatus, number>>,
  totalRuns: number,
): Record<RunSummaryStatus, number> {
  return RUN_SUMMARY_STATUSES.reduce(
    (rates, status) => ({ ...rates, [status]: rate(statusCounts[status], totalRuns) }),
    {} as Record<RunSummaryStatus, number>,
  );
}

function failureKindRates(
  failureKindCounts: ReadonlyMap<string, number>,
  totalRuns: number,
): readonly RecordedRunFailureKindMetric[] {
  return [...failureKindCounts.entries()]
    .sort(([failureKindA, countA], [failureKindB, countB]) => countB - countA || failureKindA.localeCompare(failureKindB))
    .map(([failureKind, count]) => ({
      failureKind,
      count,
      rate: rate(count, totalRuns),
    }));
}

function durationMetrics(samples: readonly number[]): RecordedRunDurationMetrics {
  const sorted = samples.filter((sample) => Number.isFinite(sample)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, p50: null, p90: null, p99: null, max: null };
  }
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
  };
}

function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const low = sorted[lo];
  const high = sorted[hi];
  if (low === undefined || high === undefined) {
    return null;
  }
  if (lo === hi) {
    return low;
  }
  return low + (high - low) * (rank - lo);
}

function costUsdFor(summary: Record<string, unknown>): number | undefined {
  const cost = isRecord(summary.cost) ? summary.cost : {};
  const usage = isRecord(summary.usage) ? summary.usage : {};
  return finiteNumber(cost.cumulativeUsd)
    ?? finiteNumber(cost.totalUsd)
    ?? finiteNumber(usage.cost_usd);
}

function normalizeWindow(options: RecordedRunMetricsOptions): {
  readonly active: boolean;
  readonly sinceMs?: number;
  readonly untilMs?: number;
} {
  const sinceMs = parseIsoWindow(options.since, "since");
  const untilMs = parseIsoWindow(options.until, "until");
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new Error("since must be before or equal to until.");
  }
  return {
    active: sinceMs !== undefined || untilMs !== undefined,
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
  };
}

function isInWindow(
  summary: Record<string, unknown>,
  window: { readonly active: boolean; readonly sinceMs?: number; readonly untilMs?: number },
): boolean {
  if (!window.active) {
    return true;
  }
  if (typeof summary.startedAt !== "string") {
    return false;
  }
  const startedAtMs = Date.parse(summary.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }
  if (window.sinceMs !== undefined && startedAtMs < window.sinceMs) {
    return false;
  }
  if (window.untilMs !== undefined && startedAtMs > window.untilMs) {
    return false;
  }
  return true;
}

function parseIsoWindow(value: string | undefined, field: "since" | "until"): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a valid ISO date/time.`);
  }
  return parsed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function emptyStatusCounts(): Record<RunSummaryStatus, number> {
  return RUN_SUMMARY_STATUSES.reduce(
    (counts, status) => ({ ...counts, [status]: 0 }),
    {} as Record<RunSummaryStatus, number>,
  );
}

function rate(count: number, denominator: number): number {
  return denominator === 0 ? 0 : count / denominator;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12));
}
