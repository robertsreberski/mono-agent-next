import {
  describeRunFailureKind,
  RUNS_HEALTH_STALE_RUNNING_MS,
  type RecordedRunListItem,
  type RunSummaryStatus,
} from "@mono-agent/observability";

export const RUNS_HEALTH_MAX_RUNS = 50;
export const RUNS_HEALTH_RECENT_RUNS = 5;

export type RunsHealthStatus = "ok" | "waiting" | "disabled";

export interface RunsHealthDisplay {
  readonly status: RunsHealthStatus;
  readonly details: readonly string[];
}

export interface BuildRunsHealthDisplayInput {
  readonly artifactDir: string;
  readonly totalRuns?: number;
  readonly runs: readonly RecordedRunListItem[];
  readonly warnings: readonly string[];
  readonly selectedSkills?: readonly string[];
  readonly includeSelectedSkills?: boolean;
  readonly runOwnerAlive?: boolean;
  readonly nowMs?: number;
  readonly maxRuns?: number;
}

const RUN_SUMMARY_STATUSES = ["running", "succeeded", "failed", "cancelled", "interrupted"] as const satisfies readonly RunSummaryStatus[];
const FAILED_LIKE_RUN_STATUSES = new Set<RunSummaryStatus>(["failed", "cancelled", "interrupted"]);

export function buildRunsHealthDisplay(input: BuildRunsHealthDisplayInput): RunsHealthDisplay {
  const maxRuns = input.maxRuns ?? RUNS_HEALTH_MAX_RUNS;
  const now = input.nowMs ?? Date.now();
  const totalRuns = input.totalRuns ?? input.runs.length;
  const details = [
    ...(input.includeSelectedSkills ? [formatSelectedSkillsLine(input.selectedSkills)] : []),
    `Artifact dir: ${input.artifactDir}`,
    `Recorded runs: ${totalRuns} total; showing ${input.runs.length} recent (max ${maxRuns}).`,
  ];
  let hasWarnings = false;

  for (const warning of input.warnings) {
    hasWarnings = true;
    details.push(`[WARN] Run artifact reader: ${warning}`);
  }

  if (input.runs.length === 0) {
    details.push("No runs recorded yet.");
    return { status: hasWarnings ? "waiting" : "disabled", details };
  }

  details.push(`Last runs: ${formatRunExamples(input.runs, now)}.`);

  const statusCounts = statusHistogram(input.runs);
  details.push(`Recent status counts: ${RUN_SUMMARY_STATUSES.map((status) => `${status}=${statusCounts[status]}`).join(", ")}.`);

  const staleRunning = input.runs.filter((run) => isStaleRunningRun(run, now));
  if (staleRunning.length > 0) {
    hasWarnings = true;
    details.push(
      `[WARN] Stale running runs older than ${RUNS_HEALTH_STALE_RUNNING_MS / 60_000}m: ${formatRunExamples(staleRunning, now)}.`,
    );
  }

  const runningWhileOwnerGone = input.runOwnerAlive === false
    ? input.runs.filter((run) => run.status === "running")
    : [];
  if (runningWhileOwnerGone.length > 0) {
    hasWarnings = true;
    details.push(`[WARN] Running summaries while process is gone: ${formatRunExamples(runningWhileOwnerGone, now)}.`);
  }

  const userCancelled = input.runs.filter(isUserCancelledRun);
  const unsuccessful = input.runs.filter((run) =>
    FAILED_LIKE_RUN_STATUSES.has(run.status) && !isUserCancelledRun(run)
  );
  if (unsuccessful.length > 0) {
    hasWarnings = true;
    details.push(`[WARN] Recent non-successful runs: ${formatRunExamples(unsuccessful, now)}.`);
  }

  if (userCancelled.length > 0) {
    details.push(`User-cancelled runs: ${userCancelled.length} (expected lifecycle outcome; health unchanged).`);
  }
  const otherCancelled = Math.max(0, statusCounts.cancelled - userCancelled.length);
  if (otherCancelled > 0) {
    hasWarnings = true;
    details.push(`[WARN] Cancelled recent runs: ${otherCancelled}.`);
  }
  if (statusCounts.interrupted > 0) {
    hasWarnings = true;
    details.push(`[WARN] Interrupted recent runs: ${statusCounts.interrupted}.`);
  }

  const failureKindCounts = failureKindHistogram(input.runs.filter((run) => !isUserCancelledRun(run)));
  if (failureKindCounts.length > 0) {
    hasWarnings = true;
    details.push(`[WARN] Failure kinds: ${failureKindCounts.map(([kind, count]) => `${kind}=${count}`).join(", ")}.`);
    for (const [kind, count] of failureKindCounts) {
      const description = describeRunFailureKind({ failureKind: kind });
      const prefix = description.known ? description.kind : `${description.kind} (unclassified)`;
      details.push(`[WARN] ${description.label} [${prefix}, ${count} recent]: ${description.explanation} Next: ${description.nextStep}`);
    }
  } else {
    details.push("Failure kinds: none in recent window.");
  }

  return { status: hasWarnings ? "waiting" : "ok", details };
}

function isUserCancelledRun(run: RecordedRunListItem): boolean {
  return run.status === "cancelled" && run.failureKind?.trim() === "cancelled_user";
}

export function formatSelectedSkillsLine(selectedSkills: readonly string[] | undefined): string {
  if (selectedSkills === undefined) {
    return "Active skills: unavailable.";
  }
  const names = selectedSkills.map((skill) => skill.trim()).filter(Boolean);
  return names.length === 0 ? "Active skills: none." : `Active skills: ${names.join(", ")}.`;
}

function statusHistogram(runs: readonly RecordedRunListItem[]): Record<RunSummaryStatus, number> {
  const counts: Record<RunSummaryStatus, number> = {
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  for (const run of runs) {
    counts[run.status] += 1;
  }
  return counts;
}

function isStaleRunningRun(run: RecordedRunListItem, now: number): boolean {
  if (run.status !== "running" || run.startedAt === undefined) {
    return false;
  }
  const startedAtMs = Date.parse(run.startedAt);
  return Number.isFinite(startedAtMs) && now - startedAtMs > RUNS_HEALTH_STALE_RUNNING_MS;
}

function failureKindHistogram(runs: readonly RecordedRunListItem[]): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const failureKind = displayFailureKind(run);
    if (failureKind !== undefined) {
      counts.set(failureKind, (counts.get(failureKind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([leftKind, leftCount], [rightKind, rightCount]) =>
    rightCount - leftCount || leftKind.localeCompare(rightKind),
  );
}

function displayFailureKind(run: RecordedRunListItem): string | undefined {
  const failureKind = run.failureKind?.trim();
  if (failureKind !== undefined && failureKind.length > 0) {
    return failureKind;
  }
  if (!FAILED_LIKE_RUN_STATUSES.has(run.status)) {
    return undefined;
  }
  return describeRunFailureKind({ status: run.status }).kind;
}

function formatRunExamples(runs: readonly RecordedRunListItem[], nowMs: number): string {
  const shown = runs.slice(0, RUNS_HEALTH_RECENT_RUNS).map((run) =>
    `${run.runId} ${run.status} ${formatRelativeAge(runTimestamp(run), nowMs)}`,
  );
  const remaining = runs.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} and ${remaining} more` : shown.join(", ");
}

function runTimestamp(run: RecordedRunListItem): string | undefined {
  return run.endedAt ?? run.updatedAt ?? run.startedAt;
}

function formatRelativeAge(timestamp: string | undefined, nowMs: number): string {
  if (timestamp === undefined) {
    return "age unknown";
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return "age unknown";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h ago`;
  }
  return `${Math.floor(elapsedHours / 24)}d ago`;
}
