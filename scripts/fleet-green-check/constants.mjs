import { fileURLToPath } from "node:url";

export const ISSUE_NUMBER = "119";
export const REPO = "robertsreberski/mono-agent";
export const LABEL_PREFIX = "com.mono-agent.";
export const LABEL_PATTERN = /^com\.mono-agent\.[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
export const MAX_LABEL_FOLDER_SEGMENT = 40;
export const CLI_MARKER = "/packages/agent-app/";
export const DEFAULT_EXPECT_NODE = "24.15.0";
export const DEFAULT_EXPECT_ABI = "137";
export const BUILD_PROVENANCE_PROBE = fileURLToPath(new URL("../build-provenance-probe.mjs", import.meta.url));
export const MANAGED_RUNTIME_ATTESTATION_PROBE = fileURLToPath(new URL("../managed-runtime-attestation-probe.mjs", import.meta.url));
export const COMMAND_TIMEOUT_MS = Object.freeze({
  plist: 5_000,
  service: 5_000,
  loaded: 30_000,
  attestation: 120_000,
  process: 5_000,
  runtime: 5_000,
  validate: 30_000,
  memory: 60_000,
  metrics: 30_000,
  git: 5_000,
  github: 30_000,
});
export const LAUNCHD_PROBE_ENV_KEYS = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
]);
export const MEMORY_PASS_STATUSES = new Set(["healthy"]);
export const MEMORY_WARN_STATUSES = new Set(["in_progress"]);
export const MEMORY_SKIP_STATUSES = new Set(["not_configured"]);
export const MEMORY_FAIL_STATUSES = new Set(["degraded", "unhealthy", "unknown"]);
export const MEMORY_STATUSES = new Set([
  ...MEMORY_PASS_STATUSES,
  ...MEMORY_WARN_STATUSES,
  ...MEMORY_SKIP_STATUSES,
  ...MEMORY_FAIL_STATUSES,
]);
export const BUJO_MEMORY_STATUSES = new Set([
  ...MEMORY_PASS_STATUSES,
  ...MEMORY_WARN_STATUSES,
  ...MEMORY_FAIL_STATUSES,
]);
export const MEMORY_MODES = new Set(["lite", "journal", "bujo"]);
export const MEMORY_REPORT_KEYS = ["schemaVersion", "backend", "mode", "status", "checkedAt", "issues", "counts"];
export const MEMORY_REPORT_KEYS_WITHOUT_MODE = MEMORY_REPORT_KEYS.filter((key) => key !== "mode");
export const MEMORY_COUNT_KEYS = [
  "pending",
  "due",
  "dead",
  "outbox",
  "temporary",
  "memories",
  "vectors",
  "missingVectors",
];
// Frozen by packages/memory/src/bujo/audit.ts. The producer emits issue codes
// in this order, so accepting a reordered or duplicated list would widen the
// supposedly closed fleet boundary beyond the CLI contract.
export const MEMORY_ISSUE_CODES = [
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "mutation_in_progress",
  "intake_invalid",
  "intake_pending",
  "dead_letters",
  "outbox_invalid",
  "outbox_pending",
  "work_stalled",
  "temporary_artifacts",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
];
export const MEMORY_ISSUE_INDEX = new Map(MEMORY_ISSUE_CODES.map((code, index) => [code, index]));
export const MEMORY_UNKNOWN_ISSUES = new Set([
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
]);
export const MEMORY_UNHEALTHY_ISSUES = new Set([
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "intake_invalid",
  "outbox_invalid",
  "temporary_artifacts",
]);
export const MEMORY_DEGRADED_ISSUES = new Set([
  "dead_letters",
  "work_stalled",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
]);
export const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

// The ONLY failure kind treated as fleet-normal: a transient provider failover
// (this is #136's "healthy failover" resilience evidence). Every OTHER kind in
// the observability taxonomy — provider_auth, context_limit, usage_limit, process_death,
// runtime_error, etc. (see KNOWN_ARTIFACT_FAILURE_KINDS in
// packages/observability/src/summary-schema.ts) — and any unclassified failure
// drives RED. Even a tolerated kind drives RED when it dominates the window
// (see the volume guard in evaluateRuns): tolerance is for the occasional blip,
// never for a wedged instance failing over on every run.
export const TOLERATED_FAILURE_KINDS = new Set(["provider_unavailable"]);

// Volume guards: a tolerated kind stops being "a blip" once it dominates.
export const RUNS_FAILURE_RATE_LIMIT = 0.5;
export const RUNS_FAILURE_RATE_MIN_SAMPLE = 5;

// The cancelled* kind family (cancelled, cancelled_user/_shutdown/_stale/_signal
// — see failure-kinds.ts) is a lifecycle OUTCOME, not a failure: a superseding
// message cancelling an in-flight turn is expected. `metrics` buckets failure
// kinds across runs of ANY status, so these land in failureKindRates even with
// zero failed runs; they must never drive the verdict. Counts are surfaced.
export const CANCELLED_KIND_PATTERN = /^cancelled(_|$)/u;
export const BUILD_MARKER_KEYS = Object.freeze([
  "schemaVersion",
  "gitSha",
  "completedAt",
  "nodeVersion",
  "nodeAbi",
  "sourceState",
  "outputDigest",
  "dependencyDigest",
]);
export const BUILD_MARKER_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
export const BUILD_MARKER_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
export const PROCESS_START_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u;
export const PROCESS_MONTH_INDEX = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
]);
export const PROCESS_WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
export const CLOSED_SYSTEM_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
export const CLOSED_GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
});
export const PLUTIL = "/usr/bin/plutil";
export const LAUNCHCTL = "/bin/launchctl";
export const ENV = "/usr/bin/env";
export const MANAGED_BACKGROUND_WORKER_ENV = "MONO_AGENT_MANAGED_WORKER";
// Keep this fail-closed list aligned with BACKGROUND_OPERATIONAL_ENV_NAMES in
// packages/agent-app/src/background-environment.ts. The lifecycle marker is
// added by managedBackgroundEnvironment rather than the public allowlist.
export const MANAGED_BACKGROUND_ENV_NAMES = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  MANAGED_BACKGROUND_WORKER_ENV,
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
]);
export const MANAGED_PLIST_KEYS = Object.freeze([
  "Label",
  "ProgramArguments",
  "WorkingDirectory",
  "RunAtLoad",
  "KeepAlive",
  "StandardOutPath",
  "StandardErrorPath",
  "ThrottleInterval",
  "ProcessType",
]);
