import { resolve } from "node:path";
import process from "node:process";

import { summarizeRecordedRunMetrics } from "@mono-agent/observability";
import type { RecordedRunMetricGroupBy, RecordedRunMetricsBucket, RecordedRunMetricsReport } from "@mono-agent/observability";

import { resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";

export interface RunMetricsArgs {
  readonly configPath?: string;
  readonly artifactDir?: string;
  readonly since?: string;
  readonly until?: string;
  readonly groupBy?: RecordedRunMetricGroupBy;
  readonly json?: boolean;
  readonly includeMemory?: boolean;
}

export async function runMetrics(args: RunMetricsArgs): Promise<number> {
  const cwd = process.cwd();
  const input: MonoAgentAppConfigInput = {
    env: process.env,
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
  };

  let report;
  try {
    const artifactDir = args.artifactDir === undefined
      ? await resolveAppArtifactDir(input)
      : resolve(cwd, args.artifactDir);
    report = await summarizeRecordedRunMetrics({
      artifactDir,
      ...(args.since === undefined ? {} : { since: args.since }),
      ...(args.until === undefined ? {} : { until: args.until }),
      ...(args.groupBy === undefined ? {} : { groupBy: args.groupBy }),
      scope: args.includeMemory === true ? "all" : "agent",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // In `--json` mode keep stdout a single valid envelope; otherwise the plain
    // stderr message and exit 1 are unchanged.
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "metrics_failed", message } }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  }

  // The `runs report` payload gains the uniform top-level `ok`; the aggregated
  // metrics report is spread in beside it (engine computation untouched).
  process.stdout.write(args.json === true ? `${JSON.stringify({ ok: true, ...report }, null, 2)}\n` : renderMetricsReport(report));
  return 0;
}

export function renderMetricsReport(report: RecordedRunMetricsReport): string {
  let out = `Artifact metrics: ${report.artifactDir}\n`;
  out += `Summary files: ${report.totalSummaryFiles} (${report.parsedSummaryFiles} parsed, ${report.parseFailureCount} parse failed)\n`;
  if (report.since !== undefined || report.until !== undefined) {
    out += `Window: ${report.since ?? "-inf"} to ${report.until ?? "+inf"}\n`;
  }
  out += renderBucket(report.overall);
  if (report.groups.length > 0 && report.groupBy !== undefined) {
    out += `\nGroups by ${report.groupBy}\n`;
    for (const group of report.groups) {
      out += `  ${group.key}: ${group.totalRuns} run${group.totalRuns === 1 ? "" : "s"}`;
      out += `, failed ${group.statusCounts.failed} (${formatPercent(group.statusRates.failed)})`;
      out += `, p90 ${formatDuration(group.durationMs.p90)}`;
      out += `, cost ${formatUsd(group.cost.totalUsd)}\n`;
    }
  }
  if (report.parseFailures.length > 0) {
    out += "\nParse failures\n";
    for (const issue of report.parseFailures) {
      const value = issue.value === undefined ? "" : ` (${issue.value})`;
      out += `  ${issue.fileName}: ${issue.reason}${value}\n`;
    }
  }
  if (report.warnings.length > 0) {
    out += "\nWarnings\n";
    for (const warning of report.warnings) {
      out += `  ${warning}\n`;
    }
  }
  return out;
}

function renderBucket(bucket: RecordedRunMetricsBucket): string {
  let out = `Total runs: ${bucket.totalRuns}\n`;
  out += "\nStatuses\n";
  for (const [status, count] of Object.entries(bucket.statusCounts)) {
    out += `  ${status}: ${count} (${formatPercent(bucket.statusRates[status as keyof typeof bucket.statusRates])})\n`;
  }
  out += "\nDuration\n";
  out += `  samples: ${bucket.durationMs.count}\n`;
  out += `  p50: ${formatDuration(bucket.durationMs.p50)}\n`;
  out += `  p90: ${formatDuration(bucket.durationMs.p90)}\n`;
  out += `  p99: ${formatDuration(bucket.durationMs.p99)}\n`;
  out += `  max: ${formatDuration(bucket.durationMs.max)}\n`;
  out += "\nCost\n";
  out += `  total: ${formatUsd(bucket.cost.totalUsd)}\n`;
  out += `  average/run: ${formatUsd(bucket.cost.averageUsdPerRun)}\n`;
  out += `  runs with cost: ${bucket.cost.runsWithCost}\n`;
  out += "\nFailure kinds\n";
  if (bucket.failureKindRates.length === 0) {
    out += "  none\n";
  } else {
    for (const failureKind of bucket.failureKindRates) {
      out += `  ${failureKind.failureKind}: ${failureKind.count} (${formatPercent(failureKind.rate)})\n`;
    }
  }
  return out;
}

function formatPercent(rate: number): string {
  const fixed = (rate * 100).toFixed(1);
  return `${fixed.replace(/\.0$/u, "")}%`;
}

function formatDuration(value: number | null): string {
  return value === null ? "n/a" : `${formatNumber(value)} ms`;
}

function formatUsd(value: number): string {
  return `$${formatNumber(value, 6)}`;
}

function formatNumber(value: number, maxFractionDigits = 3): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}
