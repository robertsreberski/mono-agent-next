import type { KnownArtifactFailureKind, RunSummaryStatus } from "./types.js";

export const SUMMARY_SUFFIX = ".summary.json";
export const EVENTS_SUFFIX = ".events.jsonl";

export const RUN_SUMMARY_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly RunSummaryStatus[];

export const KNOWN_ARTIFACT_FAILURE_KINDS = [
  "provider_unavailable",
  "provider_unavailable_exhausted",
  "provider_auth",
  "skipped_capability_mismatch",
  "context_limit",
  "usage_limit",
  "process_death",
  "runtime_error",
  "cancelled",
  "cancelled_user",
  "cancelled_stale",
  "cancelled_shutdown",
  "cancelled_signal",
] as const satisfies readonly KnownArtifactFailureKind[];

export function isRunSummaryStatus(value: unknown): value is RunSummaryStatus {
  return typeof value === "string" && (RUN_SUMMARY_STATUSES as readonly string[]).includes(value);
}

export function isKnownArtifactFailureKind(value: unknown): value is KnownArtifactFailureKind {
  return typeof value === "string" && (KNOWN_ARTIFACT_FAILURE_KINDS as readonly string[]).includes(value);
}

export function isStaleRunningSummary(raw: Record<string, unknown>, startedBeforeMs: number): boolean {
  if (raw.status !== "running") {
    return false;
  }
  const startedAtMs = typeof raw.startedAt === "string" ? Date.parse(raw.startedAt) : Number.NaN;
  return !(Number.isFinite(startedAtMs) && startedAtMs >= startedBeforeMs);
}
