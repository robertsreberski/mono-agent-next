import { resolve } from "node:path";
import process from "node:process";

import { auditRecordedRuns } from "@mono-agent/observability";
import type { ArtifactAuditFileIssue, ArtifactAuditReport } from "@mono-agent/observability";

import {
  resolveAppArtifactDir,
  resolveAppTraceStaleAfterMs,
} from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";

export interface RunAuditRunsArgs {
  readonly configPath?: string;
  readonly artifactDir?: string;
  readonly consumerPath?: string;
  readonly staleAfterMs?: number;
  readonly json?: boolean;
  readonly includeMemory?: boolean;
}

export async function runAuditRuns(args: RunAuditRunsArgs): Promise<number> {
  const cwd = resolve(process.cwd(), args.consumerPath ?? ".");
  const input: MonoAgentAppConfigInput = {
    env: process.env,
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
  };

  let report;
  try {
    const artifactDir = args.artifactDir === undefined
      ? await resolveAppArtifactDir(input)
      : resolve(process.cwd(), args.artifactDir);
    const staleAfterMs = args.staleAfterMs ?? await resolveAppTraceStaleAfterMs(input);
    report = await auditRecordedRuns(artifactDir, { staleAfterMs, scope: args.includeMemory === true ? "all" : "agent" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // In `--json` mode keep stdout a single valid envelope; otherwise the plain
    // stderr message and exit 1 are unchanged.
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "audit_failed", message } }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  }

  // The `runs audit` payload gains the uniform top-level `ok`; the audit report
  // is spread in beside it (engine computation untouched).
  process.stdout.write(args.json === true ? `${JSON.stringify({ ok: true, ...report }, null, 2)}\n` : renderAuditReport(report));
  return 0;
}

export function renderAuditReport(report: ArtifactAuditReport): string {
  let out = `Artifact audit: ${report.artifactDir}\n`;
  out += `Summary files: ${report.totalSummaryFiles} (${report.parsedSummaryFiles} parsed, ${report.parseFailureCount} parse failed)\n`;
  out += `Stale running: ${report.staleRunningCount}\n`;
  out += `Unrecognized statuses: ${report.unrecognizedStatusCount}\n`;
  out += `Unrecognized failure kinds: ${report.unrecognizedFailureKindCount}\n`;
  out += "\nStatuses\n";
  for (const [status, count] of Object.entries(report.statusHistogram)) {
    out += `  ${status}: ${count}\n`;
  }
  out += "\nFailure kinds\n";
  for (const rate of report.failureKindRates) {
    out += `  ${rate.failureKind}: ${rate.count} (${formatPercent(rate.rateOfParsedSummaries)} of parsed, ${formatPercent(rate.rateOfSummariesWithFailureKind)} of failure-kind summaries)\n`;
  }
  out += renderIssues("Parse failures", report.parseFailures);
  out += renderIssues("Unrecognized status details", report.unrecognizedStatuses);
  out += renderIssues("Unrecognized failure-kind details", report.unrecognizedFailureKinds);
  out += renderIssues("Stale running details", report.staleRunning);
  if (report.warnings.length > 0) {
    out += "\nWarnings\n";
    for (const warning of report.warnings) {
      out += `  ${warning}\n`;
    }
  }
  return out;
}

function renderIssues(title: string, issues: readonly ArtifactAuditFileIssue[]): string {
  if (issues.length === 0) {
    return "";
  }
  let out = `\n${title}\n`;
  for (const issue of issues) {
    const value = issue.value === undefined ? "" : ` (${issue.value})`;
    out += `  ${issue.fileName}: ${issue.reason}${value}\n`;
  }
  return out;
}

function formatPercent(rate: number): string {
  const fixed = (rate * 100).toFixed(1);
  return `${fixed.replace(/\.0$/u, "")}%`;
}
