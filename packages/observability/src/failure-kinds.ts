import type { RunSummaryStatus } from "./types.js";

export interface RunFailureKindDescription {
  readonly kind: string;
  readonly label: string;
  readonly explanation: string;
  readonly nextStep: string;
  readonly known: boolean;
}

export interface KnownRunFailureKindDescription {
  readonly kind: string;
  readonly label: string;
  readonly explanation: string;
  readonly nextStep: string;
}

export interface DescribeRunFailureKindInput {
  readonly status?: RunSummaryStatus;
  readonly failureKind?: string | null;
}

export const KNOWN_RUN_FAILURE_KINDS = [
  {
    kind: "context_limit",
    label: "Context limit",
    explanation: "The request exceeded the selected model's usable context window after compaction recovery.",
    nextStep: "Inspect the compaction diagnostics and failover history, then shorten the retained conversation or configure a fallback with a larger usable window.",
  },
  {
    kind: "usage_limit",
    label: "Usage limit",
    explanation: "The runtime hit a provider usage, quota, output-token, or turn limit before the run could finish.",
    nextStep: "Narrow the task, check quota/model limits, then inspect the local artifact summary for the partial run.",
  },
  {
    kind: "process_death",
    label: "Process death",
    explanation: "A previous mono-agent process died or was killed while the run was active.",
    nextStep: "Inspect the run artifact and host logs, then restart the agent after investigating the process failure.",
  },
  {
    kind: "interrupted",
    label: "Interrupted",
    explanation: "The run was left incomplete without a more specific persisted failure kind.",
    nextStep: "Inspect the local artifact summary and logs to determine whether the host exited, was stopped, or lost the worker.",
  },
  {
    kind: "cancelled",
    label: "Cancelled",
    explanation: "The run was cancelled before completion.",
    nextStep: "If the cancellation was expected, no action is needed; otherwise check the caller, watchdog, or channel logs.",
  },
  {
    kind: "cancelled_user",
    label: "Cancelled by user",
    explanation: "The run was cancelled by an explicit user or API cancellation request.",
    nextStep: "No action is needed when this was intentional; otherwise inspect the channel or API caller that sent the cancellation.",
  },
  {
    kind: "cancelled_stale",
    label: "Cancelled as stale",
    explanation: "The run was cancelled because stale-run handling found it no longer had a live coordinator.",
    nextStep: "Inspect the artifact and host logs for the original coordinator exit before retrying the work.",
  },
  {
    kind: "cancelled_shutdown",
    label: "Cancelled during shutdown",
    explanation: "The run was cancelled because the coordinator was shutting down.",
    nextStep: "Retry the work after restart if the shutdown was expected; otherwise inspect the shutdown trigger.",
  },
  {
    kind: "cancelled_signal",
    label: "Cancelled by signal",
    explanation: "The worker received an interrupt or termination signal before the run completed.",
    nextStep: "Inspect host logs or supervising processes to find what sent the signal before retrying.",
  },
  {
    kind: "provider_unavailable",
    label: "Provider unavailable",
    explanation: "The selected provider or model was temporarily unreachable, overloaded, or disconnected.",
    nextStep: "Check provider/network availability and retry; if retries keep failing, switch models or inspect provider logs.",
  },
  {
    kind: "provider_unavailable_exhausted",
    label: "Provider failover exhausted",
    explanation: "Every eligible provider/model attempt failed with an availability problem.",
    nextStep: "Inspect the failover history in the artifact, verify provider health, and adjust fallback models if needed.",
  },
  {
    kind: "provider_auth",
    label: "Provider authentication",
    explanation: "The selected provider or model could not authenticate because credentials were missing, invalid, or could not be refreshed.",
    nextStep: "Inspect the artifact error and host auth configuration, refresh or repair the provider credentials, then restart the agent.",
  },
  {
    kind: "skipped_capability_mismatch",
    label: "Capability mismatch",
    explanation: "No eligible provider/model entry matched the capabilities required by the request.",
    nextStep: "Inspect the failover history and adjust the model chain or request options so at least one entry satisfies the required capabilities.",
  },
  {
    kind: "runtime_error",
    label: "Runtime error",
    explanation: "The runtime reported an internal or adapter-level error while executing the run.",
    nextStep: "Inspect the local artifact summary and logs for the concrete error message.",
  },
  {
    kind: "session_not_found",
    label: "Provider session not found",
    explanation: "The runtime tried to resume a provider session that was expired, evicted, or no longer live.",
    nextStep: "Retry without the stale session or inspect session retention settings and provider logs.",
  },
  {
    kind: "session_busy",
    label: "Provider session busy",
    explanation: "The runtime tried to use a provider session that was already executing another turn.",
    nextStep: "Wait for the in-flight turn to finish, then retry or use a separate session.",
  },
  {
    kind: "exception",
    label: "Unclassified exception",
    explanation: "The runtime surfaced an exception without a more specific failure kind.",
    nextStep: "Inspect the local artifact summary and logs for the underlying error name and message.",
  },
] as const satisfies readonly KnownRunFailureKindDescription[];

const KNOWN_RUN_FAILURE_KIND_BY_KIND = new Map<string, KnownRunFailureKindDescription>(
  KNOWN_RUN_FAILURE_KINDS.map((entry) => [entry.kind, entry]),
);

export function describeRunFailureKind(input: DescribeRunFailureKindInput): RunFailureKindDescription {
  const kind = normalizeFailureKind(input.failureKind) ?? inferFailureKindFromStatus(input.status);
  const known = KNOWN_RUN_FAILURE_KIND_BY_KIND.get(kind);
  if (known !== undefined) {
    return { ...known, known: true };
  }
  return {
    kind,
    label: kind === "unknown" ? "Unknown failure" : `Unclassified failure (${kind})`,
    explanation: "The runtime surfaced a failure kind that is not yet part of the documented display taxonomy.",
    nextStep: "Inspect the local artifact summary and logs, then add a display description if this kind is expected.",
    known: false,
  };
}

function normalizeFailureKind(failureKind: string | null | undefined): string | undefined {
  if (failureKind === null || failureKind === undefined) {
    return undefined;
  }
  const trimmed = failureKind.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function inferFailureKindFromStatus(status: RunSummaryStatus | undefined): string {
  switch (status) {
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "exception";
    default:
      return "unknown";
  }
}
