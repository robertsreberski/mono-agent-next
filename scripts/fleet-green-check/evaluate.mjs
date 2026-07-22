import {
  LABEL_PREFIX,
  LABEL_PATTERN,
  CLI_MARKER,
  DEFAULT_EXPECT_NODE,
  DEFAULT_EXPECT_ABI,
  MEMORY_PASS_STATUSES,
  MEMORY_WARN_STATUSES,
  MEMORY_SKIP_STATUSES,
  MEMORY_FAIL_STATUSES,
  MEMORY_STATUSES,
  BUJO_MEMORY_STATUSES,
  MEMORY_MODES,
  MEMORY_REPORT_KEYS,
  MEMORY_REPORT_KEYS_WITHOUT_MODE,
  MEMORY_COUNT_KEYS,
  MEMORY_ISSUE_INDEX,
  MEMORY_UNKNOWN_ISSUES,
  MEMORY_UNHEALTHY_ISSUES,
  MEMORY_DEGRADED_ISSUES,
  ISO_INSTANT_PATTERN,
  TOLERATED_FAILURE_KINDS,
  RUNS_FAILURE_RATE_LIMIT,
  RUNS_FAILURE_RATE_MIN_SAMPLE,
  CANCELLED_KIND_PATTERN,
  BUILD_MARKER_KEYS,
  BUILD_MARKER_SHA_PATTERN,
  BUILD_MARKER_FINGERPRINT_PATTERN,
  PROCESS_START_PATTERN,
  PROCESS_MONTH_INDEX,
  PROCESS_WEEKDAYS,
} from "./constants.mjs";

export function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    strictRuns: false,
    help: false,
    expectNode: DEFAULT_EXPECT_NODE,
    expectAbi: DEFAULT_EXPECT_ABI,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--strict-runs") {
      parsed.strictRuns = true;
    } else if (arg === "--labels") {
      parsed.labels = parseLabelCsv(requireValue(argv, (i += 1), arg), arg);
    } else if (arg === "--expect-labels") {
      parsed.expectLabels = parseLabelCsv(requireValue(argv, (i += 1), arg), arg);
    } else if (arg === "--expect-sha") {
      const value = requireValue(argv, (i += 1), arg);
      if (!BUILD_MARKER_SHA_PATTERN.test(value)) {
        throw new Error("--expect-sha requires a full lowercase 40-64 character hexadecimal sha.");
      }
      parsed.expectSha = value;
    } else if (arg === "--expect-node") {
      const value = requireValue(argv, (i += 1), arg);
      if (!/^\d+\.\d+\.\d+$/u.test(value)) {
        throw new Error("--expect-node requires an exact semantic version (for example 24.15.0).");
      }
      parsed.expectNode = value;
    } else if (arg === "--expect-abi") {
      const value = requireValue(argv, (i += 1), arg);
      if (!/^\d+$/u.test(value)) {
        throw new Error("--expect-abi requires a numeric Node modules ABI (for example 137).");
      }
      parsed.expectAbi = value;
    } else if (arg === "--min-runs") {
      const value = Number.parseInt(requireValue(argv, (i += 1), arg), 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--min-runs requires a non-negative integer.");
      }
      parsed.minRuns = value;
    } else if (arg === "--repo") {
      parsed.repo = requireValue(argv, (i += 1), arg);
    } else {
      throw new Error("Unknown argument.");
    }
  }
  if (parsed.labels !== undefined && parsed.expectLabels !== undefined
    && !sameStringSet(parsed.labels, parsed.expectLabels)) {
    throw new Error("--labels must exactly match --expect-labels when both are provided.");
  }
  return parsed;
}

export function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseLabelCsv(value, flag) {
  const labels = value.split(",").map((label) => label.trim());
  if (labels.length === 0
    || labels.some((label) => !LABEL_PATTERN.test(label))
    || new Set(labels).size !== labels.length) {
    throw new Error(`${flag} requires a non-empty, duplicate-free CSV of canonical mono-agent labels.`);
  }
  return labels;
}

export function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function evaluateExpectedLabels(actualLabels, expectedLabels) {
  if (expectedLabels === undefined) return null;
  const actual = new Set(actualLabels);
  const expected = new Set(expectedLabels);
  let missing = 0;
  let extra = 0;
  for (const label of expected) {
    if (!actual.has(label)) missing += 1;
  }
  for (const label of actual) {
    if (!expected.has(label)) extra += 1;
  }
  return missing === 0 && extra === 0
    ? null
    : `fleet labels mismatch (missing ${missing}, extra ${extra})`;
}

// Parse `launchctl list <label>` output. Loaded services print a plist-ish block
// with PID and LastExitStatus; a missing service exits non-zero with a "Could
// not find service" message.
export function parseLaunchctlList(text, exitCode) {
  if (exitCode !== 0) {
    return { found: false, pid: null, lastExitStatus: null };
  }
  const pid = matchInt(text, /"?PID"?\s*=\s*(\d+)/u);
  const lastExitStatus = matchInt(text, /"?LastExitStatus"?\s*=\s*(-?\d+)/u);
  return { found: true, pid, lastExitStatus };
}

export function matchInt(text, pattern) {
  const match = text.match(pattern);
  return match === null ? null : Number.parseInt(match[1], 10);
}

// Derive the deploy checkout root from a plist cli.js path.
export function deriveRepoFromCliPath(cliPath) {
  if (typeof cliPath !== "string") {
    return null;
  }
  const index = cliPath.indexOf(CLI_MARKER);
  return index === -1 ? null : cliPath.slice(0, index);
}

// Reduce a `metrics --json` report's overall bucket to the fields we track.
export function reduceMetrics(report) {
  const overall = report?.overall;
  if (!isRecord(overall)) {
    throw new Error("invalid metrics report");
  }
  const totalRuns = Number(overall.totalRuns);
  const failedRuns = Number(overall.statusCounts?.failed ?? 0);
  if (!Number.isInteger(totalRuns) || totalRuns < 0 || !Number.isInteger(failedRuns) || failedRuns < 0 || failedRuns > totalRuns) {
    throw new Error("invalid metrics counts");
  }
  if (!Array.isArray(overall.failureKindRates)) {
    throw new Error("invalid metrics failure kinds");
  }
  const failureKinds = overall.failureKindRates.map((entry) => {
    const kind = isRecord(entry) && typeof entry.failureKind === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(entry.failureKind)
      ? entry.failureKind
      : "unknown";
    const count = isRecord(entry) ? Number(entry.count) : Number.NaN;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("invalid metrics failure count");
    }
    return { kind, count };
  });
  return {
    ran: true,
    totalRuns,
    failedRuns,
    failureKinds,
  };
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseBuildProvenanceProbe(text, exitCode) {
  const report = parseJsonObject(text);
  if (report === null || report.schemaVersion !== 2 || typeof report.status !== "string") {
    return { status: "malformed" };
  }
  if (report.status === "missing" || report.status === "unsafe" || report.status === "malformed") {
    return exitCode === 1 && hasExactKeys(report, ["schemaVersion", "status"])
      ? { status: report.status }
      : { status: "malformed" };
  }
  if (report.status !== "ok"
    || exitCode !== 0
    || !hasExactKeys(report, ["schemaVersion", "status", "marker", "fingerprint", "outputDigest", "dependencyDigest"])
    || typeof report.fingerprint !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.fingerprint)
    || typeof report.outputDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.outputDigest)
    || typeof report.dependencyDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.dependencyDigest)
    || !isRecord(report.marker)
    || !hasExactKeys(report.marker, BUILD_MARKER_KEYS)) {
    return { status: "malformed" };
  }
  const marker = report.marker;
  const completedAtMs = Date.parse(marker.completedAt);
  if (marker.schemaVersion !== 2
    || typeof marker.gitSha !== "string"
    || !BUILD_MARKER_SHA_PATTERN.test(marker.gitSha)
    || typeof marker.completedAt !== "string"
    || !Number.isFinite(completedAtMs)
    || new Date(completedAtMs).toISOString() !== marker.completedAt
    || typeof marker.nodeVersion !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(marker.nodeVersion)
    || typeof marker.nodeAbi !== "string"
    || !/^\d+$/u.test(marker.nodeAbi)
    || (marker.sourceState !== "clean" && marker.sourceState !== "dirty")
    || typeof marker.outputDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(marker.outputDigest)
    || typeof marker.dependencyDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(marker.dependencyDigest)) {
    return { status: "malformed" };
  }
  return {
    status: "ok",
    fingerprint: report.fingerprint,
    outputDigest: report.outputDigest,
    dependencyDigest: report.dependencyDigest,
    marker: {
      schemaVersion: 2,
      gitSha: marker.gitSha,
      completedAt: marker.completedAt,
      nodeVersion: marker.nodeVersion,
      nodeAbi: marker.nodeAbi,
      sourceState: marker.sourceState,
      outputDigest: marker.outputDigest,
      dependencyDigest: marker.dependencyDigest,
    },
  };
}

export function parseManagedRuntimeAttestationProbe(text, exitCode) {
  const report = parseJsonObject(text);
  if (report === null || report.schemaVersion !== 1 || typeof report.status !== "string") {
    return { status: "malformed" };
  }
  if (report.status === "unsafe") {
    return exitCode === 1 && hasExactKeys(report, ["schemaVersion", "status"])
      ? { status: "unsafe" }
      : { status: "malformed" };
  }
  if (report.status !== "ok"
    || exitCode !== 0
    || !hasExactKeys(report, ["schemaVersion", "status", "fingerprint", "installedAt"])
    || typeof report.fingerprint !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.fingerprint)
    || !isValidIsoInstant(report.installedAt)) {
    return { status: "malformed" };
  }
  return { status: "ok", fingerprint: report.fingerprint, installedAt: report.installedAt };
}

export function parseProcessStart(text, exitCode) {
  if (exitCode !== 0 || typeof text !== "string") {
    return { ran: false };
  }
  const value = text.trim().replace(/\s+/gu, " ");
  const match = PROCESS_START_PATTERN.exec(value);
  if (match === null) {
    return { ran: false };
  }
  const month = PROCESS_MONTH_INDEX.get(match[2]);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const year = Number.parseInt(match[7], 10);
  if (month === undefined || year < 1000 || year > 9999
    || day < 1 || day > daysInMonth(year, month + 1)
    || hour > 23 || minute > 59 || second > 59) {
    return { ran: false };
  }
  const startedAtMs = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(startedAtMs);
  if (!Number.isFinite(startedAtMs)
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month
    || parsed.getUTCDate() !== day
    || PROCESS_WEEKDAYS[parsed.getUTCDay()] !== match[1]) {
    return { ran: false };
  }
  return { ran: true, startedAtMs };
}

export function evaluateLoaded(loaded, service, runtime, expected = {}) {
  if (!service || typeof service.pid !== "number") {
    return { status: "fail", note: "running process required" };
  }
  if (!loaded || loaded.ran !== true) {
    return { status: "fail", note: "loaded-code probe unavailable" };
  }
  if (loaded.checkoutUnavailable === true) {
    return { status: "fail", note: "deploy checkout unavailable" };
  }
  if (loaded.launchDefinitionInitial?.timedOut === true) {
    return { status: "fail", note: "loaded launch definition probe timed out" };
  }
  if (loaded.launchDefinitionInitial?.status !== "ok") {
    return { status: "fail", note: "loaded launch definition unavailable" };
  }
  if (loaded.processStart?.timedOut === true) {
    return { status: "fail", note: "process start probe timed out" };
  }
  if (loaded.processStart?.ran !== true) {
    return { status: "fail", note: "process start unavailable" };
  }
  if (loaded.processIdentity?.timedOut === true) {
    return { status: "fail", note: "process identity probe timed out" };
  }
  if (loaded.processIdentity?.ran !== true) {
    return { status: "fail", note: "process identity unavailable" };
  }
  if (loaded.managed !== true && loaded.processIdentity.argvMatches !== true) {
    return { status: "fail", note: "process arguments do not match plist" };
  }
  if (loaded.processIdentity.executableMatches !== true) {
    return { status: "fail", note: "process executable does not match plist" };
  }
  if (loaded.processIdentity.cwdMatches !== true) {
    return { status: "fail", note: "process working directory does not match plist" };
  }
  if (typeof loaded.checkoutInitial?.error === "string") {
    const timedOut = loaded.checkoutInitial.error === "checkout probe timed out";
    const changed = loaded.checkoutInitial.error === "checkout changed during probe";
    return {
      status: "fail",
      note: timedOut ? "checkout probe timed out" : changed ? "checkout changed during probe" : "checkout probe unavailable",
    };
  }
  if (loaded.checkoutInitial?.clean !== true) {
    return { status: "fail", note: "deploy checkout dirty" };
  }
  if (loaded.markerInitial?.timedOut === true) {
    return { status: "fail", note: "build marker probe timed out" };
  }
  if (loaded.markerInitial?.status !== "ok") {
    const notes = {
      missing: "build marker missing",
      unsafe: "build marker unsafe",
      malformed: "build marker malformed",
    };
    return { status: "fail", note: notes[loaded.markerInitial?.status] ?? "build marker malformed" };
  }
  if (loaded.managed === true) {
    if (loaded.runtimeAttestationInitial?.timedOut === true) {
      return { status: "fail", note: "managed runtime attestation timed out" };
    }
    if (loaded.runtimeAttestationInitial?.status !== "ok") {
      return { status: "fail", note: "managed runtime attestation failed" };
    }
  }
  if (loaded.serviceRecheck?.timedOut === true) {
    return { status: "fail", note: "service recheck timed out" };
  }
  if (loaded.serviceRecheck?.found !== service.found
    || loaded.serviceRecheck?.pid !== service.pid
    || loaded.serviceRecheck?.lastExitStatus !== service.lastExitStatus) {
    return { status: "fail", note: "service changed during probe" };
  }
  if (loaded.launchDefinitionInitial?.timedOut === true
    || loaded.launchDefinitionFinal?.timedOut === true
    || loaded.launchDefinitionTerminal?.timedOut === true) {
    return { status: "fail", note: "loaded launch definition probe timed out" };
  }
  if (loaded.launchDefinitionInitial?.status !== "ok"
    || loaded.launchDefinitionFinal?.status !== "ok"
    || loaded.launchDefinitionTerminal?.status !== "ok") {
    return { status: "fail", note: "loaded launch definition unavailable" };
  }
  if (loaded.launchDefinitionInitial.fingerprint !== loaded.launchDefinitionFinal.fingerprint
    || loaded.launchDefinitionFinal.fingerprint !== loaded.launchDefinitionTerminal.fingerprint) {
    return { status: "fail", note: "loaded launch definition changed during probe" };
  }
  if (loaded.managed === true) {
    if (loaded.runtimeAttestationInitial?.timedOut === true || loaded.runtimeAttestationFinal?.timedOut === true) {
      return { status: "fail", note: "managed runtime attestation timed out" };
    }
    if (loaded.runtimeAttestationInitial?.status !== "ok"
      || loaded.runtimeAttestationFinal?.status !== "ok") {
      return { status: "fail", note: "managed runtime attestation failed" };
    }
    if (loaded.runtimeAttestationInitial.fingerprint !== loaded.runtimeAttestationFinal.fingerprint) {
      return { status: "fail", note: "managed runtime changed during probe" };
    }
    if (loaded.runtimeAttestationInitial.installedAt !== loaded.runtimeAttestationFinal.installedAt) {
      return { status: "fail", note: "managed runtime install changed during probe" };
    }
  }
  if (loaded.markerInitial?.timedOut === true || loaded.markerFinal?.timedOut === true) {
    return { status: "fail", note: "build marker probe timed out" };
  }
  if (typeof loaded.checkoutInitial?.error === "string" || typeof loaded.checkoutFinal?.error === "string") {
    const timedOut = loaded.checkoutInitial?.error === "checkout probe timed out"
      || loaded.checkoutFinal?.error === "checkout probe timed out";
    const changed = loaded.checkoutInitial?.error === "checkout changed during probe"
      || loaded.checkoutFinal?.error === "checkout changed during probe";
    return {
      status: "fail",
      note: timedOut ? "checkout probe timed out" : changed ? "checkout changed during probe" : "checkout probe unavailable",
    };
  }
  const initialMarker = loaded.markerInitial;
  const finalMarker = loaded.markerFinal;
  if (!initialMarker || !finalMarker
    || initialMarker.status !== finalMarker.status
    || (initialMarker.status === "ok"
      && (initialMarker.fingerprint !== finalMarker.fingerprint
        || initialMarker.outputDigest !== finalMarker.outputDigest
        || initialMarker.dependencyDigest !== finalMarker.dependencyDigest))) {
    return { status: "fail", note: "build changed during probe" };
  }
  if (initialMarker.status !== "ok") {
    const notes = {
      missing: "build marker missing",
      unsafe: "build marker unsafe",
      malformed: "build marker malformed",
    };
    return { status: "fail", note: notes[initialMarker.status] ?? "build marker malformed" };
  }
  if (typeof loaded.checkoutInitial?.sha !== "string" || typeof loaded.checkoutFinal?.sha !== "string") {
    return { status: "fail", note: "checkout sha unavailable" };
  }
  if (loaded.checkoutInitial.sha !== loaded.checkoutFinal.sha) {
    return { status: "fail", note: "checkout changed during probe" };
  }
  if (loaded.checkoutInitial.clean !== true || loaded.checkoutFinal.clean !== true) {
    return { status: "fail", note: "deploy checkout dirty" };
  }
  if (initialMarker.marker.sourceState !== "clean") {
    return { status: "fail", note: "build source not clean" };
  }
  if (initialMarker.marker.gitSha !== loaded.checkoutInitial.sha) {
    return { status: "fail", note: "build marker sha mismatch" };
  }
  if (initialMarker.outputDigest !== initialMarker.marker.outputDigest
    || finalMarker.outputDigest !== finalMarker.marker.outputDigest) {
    return { status: "fail", note: "build output digest mismatch" };
  }
  if (initialMarker.dependencyDigest !== initialMarker.marker.dependencyDigest
    || finalMarker.dependencyDigest !== finalMarker.marker.dependencyDigest) {
    return { status: "fail", note: "build dependency digest mismatch" };
  }
  if (loaded.plistRecheck?.timedOut === true) {
    return { status: "fail", note: "plist recheck timed out" };
  }
  if (loaded.plistRecheck?.status !== "ok"
    || loaded.plistRecheck.fingerprint !== loaded.plistFingerprint
    || loaded.plistRecheck.shapeFingerprint !== loaded.plistShapeFingerprint) {
    return { status: "fail", note: "launchd plist changed during probe" };
  }
  if (typeof expected.expectSha === "string"
    && (loaded.checkoutInitial.sha !== expected.expectSha
      || initialMarker.marker.gitSha !== expected.expectSha)) {
    return { status: "fail", note: `loaded sha ${shortSha(loaded.checkoutInitial.sha)} != expected ${shortSha(expected.expectSha)}` };
  }
  if (!runtime || runtime.ran !== true
    || initialMarker.marker.nodeVersion !== runtime.node
    || initialMarker.marker.nodeAbi !== runtime.abi) {
    return { status: "fail", note: "build/runtime mismatch" };
  }
  if (loaded.processStart?.timedOut === true) {
    return { status: "fail", note: "process start probe timed out" };
  }
  if (loaded.processStart?.ran !== true) {
    return { status: "fail", note: "process start unavailable" };
  }
  if (loaded.processIdentity?.timedOut === true) {
    return { status: "fail", note: "process identity probe timed out" };
  }
  if (loaded.processIdentity?.ran !== true) {
    return { status: "fail", note: "process identity unavailable" };
  }
  if (loaded.managed !== true && loaded.processIdentity.argvMatches !== true) {
    return { status: "fail", note: "process arguments do not match plist" };
  }
  if (loaded.managed === true && loaded.processIdentity.executableMatches !== true) {
    return { status: "fail", note: "process executable does not match plist" };
  }
  if (loaded.processIdentity.cwdMatches !== true) {
    return { status: "fail", note: "process working directory does not match plist" };
  }
  if (loaded.processStart.startedAtMs <= Date.parse(initialMarker.marker.completedAt)) {
    return { status: "fail", note: "process predates build" };
  }
  if (loaded.managed === true
    && loaded.processStart.startedAtMs <= Math.floor(
      Date.parse(loaded.runtimeAttestationInitial.installedAt) / 1_000,
    ) * 1_000) {
    return { status: "fail", note: "process predates managed runtime" };
  }
  return { status: "pass", note: "" };
}

// Classify the runs-24h check. `metrics` is a reduced object, an { error }, or
// { ran: false } when skipped (no working dir). Returns one of
// pass | warn | fail | skip with a human-readable note plus the untolerated
// (non-transient / unclassified) failure kinds. RED (fail) is driven by:
//   - any failure kind outside TOLERATED_FAILURE_KINDS, or an unclassified fail;
//   - --strict-runs and any failed run;
//   - a volume guard, so even a tolerated kind that dominates goes RED
//     (all runs failed, or >50% failed over >=5 runs);
//   - fewer than --min-runs runs in the window.
// Zero runs is a distinct non-RED "idle?" warning (a wedged scheduler looks
// different from a healthy quiet window, but the operator should still see it).
export function evaluateRuns(metrics, options = {}) {
  const strictRuns = options.strictRuns === true;
  const minRuns = typeof options.minRuns === "number" ? options.minRuns : undefined;
  if (metrics === undefined || metrics === null || metrics.ran === false) {
    if (metrics && typeof metrics.error === "string") {
      return { status: "fail", note: `metrics read failed — ${metrics.error}`, untoleratedKinds: [] };
    }
    return { status: "skip", note: "no runs data", untoleratedKinds: [] };
  }

  const { totalRuns, failedRuns } = metrics;
  const cancelledCount = metrics.failureKinds
    .filter((entry) => CANCELLED_KIND_PATTERN.test(entry.kind))
    .reduce((sum, entry) => sum + entry.count, 0);
  // Only non-cancelled kinds are candidates for "untolerated"; cancellations are
  // lifecycle outcomes attributable to cancelled (not failed) runs.
  const failureKinds = metrics.failureKinds.filter((entry) => !CANCELLED_KIND_PATTERN.test(entry.kind));
  const classified = failureKinds.reduce((sum, entry) => sum + entry.count, 0);
  const unclassified = Math.max(0, failedRuns - classified);
  const untoleratedKinds = failureKinds
    .filter((entry) => !TOLERATED_FAILURE_KINDS.has(entry.kind))
    .map((entry) => entry.kind);
  if (unclassified > 0) {
    untoleratedKinds.push("(unclassified)");
  }

  const failKindParts = [
    ...failureKinds.map((entry) => `${entry.kind}×${entry.count}`),
    ...(unclassified > 0 ? [`(unclassified)×${unclassified}`] : []),
  ];
  const kindsSummary = failKindParts.length === 0 ? "" : ` (${failKindParts.join(", ")})`;
  const cancelledSummary = cancelledCount > 0 ? `, ${cancelledCount} cancelled` : "";
  const counts = `${totalRuns} runs, ${failedRuns} failed${cancelledSummary}${kindsSummary}`;
  const failRate = totalRuns > 0 ? failedRuns / totalRuns : 0;

  if (strictRuns && failedRuns > 0) {
    return { status: "fail", note: `${counts} — strict`, untoleratedKinds };
  }
  if (untoleratedKinds.length > 0) {
    return { status: "fail", note: `${counts} — untolerated failure kind(s): ${untoleratedKinds.join(", ")}`, untoleratedKinds };
  }
  if (failedRuns > 0 && failedRuns === totalRuns) {
    return { status: "fail", note: `${counts} — all runs failed`, untoleratedKinds };
  }
  if (totalRuns >= RUNS_FAILURE_RATE_MIN_SAMPLE && failRate > RUNS_FAILURE_RATE_LIMIT) {
    return { status: "fail", note: `${counts} — failure rate ${(failRate * 100).toFixed(0)}% over ${totalRuns} runs`, untoleratedKinds };
  }
  if (minRuns !== undefined && totalRuns < minRuns) {
    return { status: "fail", note: `${counts} — below --min-runs ${minRuns}`, untoleratedKinds };
  }
  if (totalRuns === 0) {
    return { status: "warn", note: "0 runs (idle?)", untoleratedKinds };
  }
  return { status: "pass", note: counts, untoleratedKinds };
}

export function instanceName(label) {
  return typeof label === "string" && LABEL_PATTERN.test(label)
    ? label.slice(LABEL_PREFIX.length)
    : "invalid-label";
}

export function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : "unknown";
}

export function evaluateRuntime(runtime, expected = {}) {
  if (runtime?.timedOut === true) {
    return { status: "fail", note: "runtime probe timed out" };
  }
  if (!runtime || runtime.ran !== true) {
    return { status: "fail", note: "runtime probe unavailable" };
  }
  const expectNode = expected.expectNode ?? DEFAULT_EXPECT_NODE;
  const expectAbi = expected.expectAbi ?? DEFAULT_EXPECT_ABI;
  if (runtime.node !== expectNode || runtime.abi !== expectAbi) {
    return {
      status: "fail",
      note: `runtime ${runtime.node}/abi${runtime.abi} != expected ${expectNode}/abi${expectAbi}`,
    };
  }
  return { status: "pass", note: `${runtime.node}/abi${runtime.abi}` };
}

export function evaluateService(service) {
  if (service?.timedOut === true) {
    return { status: "fail", note: "service probe timed out" };
  }
  if (!service || service.found !== true) {
    return { status: "fail", note: "service not found" };
  }
  if (typeof service.pid === "number") {
    return { status: "pass", note: `running (pid ${service.pid})` };
  }
  return { status: "fail", note: `not running (last exit ${service.lastExitStatus ?? "?"})` };
}

export function evaluateValidate(validate) {
  if (validate?.timedOut === true) {
    return { status: "fail", note: "validate command timed out" };
  }
  if (!validate || validate.ran !== true) {
    return { status: "fail", note: "validate probe unavailable" };
  }
  if (validate.validJson === true && validate.ok === true && validate.exitCode === 0) {
    return { status: "pass", note: "" };
  }
  if (validate.validJson !== true) {
    return { status: "fail", note: "validate returned malformed JSON" };
  }
  return { status: "fail", note: "validate reported errors" };
}

/** Parse the strict memory result even on exit 1, then enforce the full frozen contract. */
export function parseMemoryAudit(text, exitCode) {
  const report = parseJsonObject(text);
  if (report === null || !isStrictMemoryReport(report)) {
    return { ran: true, malformed: true };
  }
  const expectedExit = MEMORY_FAIL_STATUSES.has(report.status) ? 1 : 0;
  if (exitCode !== expectedExit) {
    return { ran: true, malformed: true };
  }
  return { ran: true, status: report.status };
}

export function isStrictMemoryReport(report) {
  if (report.schemaVersion !== 1
    || typeof report.backend !== "string"
    || typeof report.status !== "string"
    || !MEMORY_STATUSES.has(report.status)
    || !isValidIsoInstant(report.checkedAt)
    || !isClosedIssueList(report.issues)
    || !isClosedMemoryCounts(report.counts)) {
    return false;
  }

  if (report.backend === "bujo") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS)
      && typeof report.mode === "string"
      && MEMORY_MODES.has(report.mode)
      && BUJO_MEMORY_STATUSES.has(report.status)
      && report.status === deriveBuiltInMemoryStatus(report.issues)
      && hasValidBuiltInCountSemantics(report.mode, report.issues, report.counts);
  }
  if (report.backend === "none") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS_WITHOUT_MODE)
      && report.status === "not_configured"
      && report.issues.length === 0
      && hasOnlyZeroMemoryCounts(report.counts);
  }
  if (report.backend === "supermemory") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS_WITHOUT_MODE)
      && report.status === "unknown"
      && report.issues.length === 0
      && hasOnlyZeroMemoryCounts(report.counts);
  }
  return false;
}

export function hasExactKeys(record, expectedKeys) {
  const actualKeys = Object.keys(record);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(record, key));
}

export function isClosedIssueList(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  let previousIndex = -1;
  for (const issue of value) {
    if (typeof issue !== "string") {
      return false;
    }
    const index = MEMORY_ISSUE_INDEX.get(issue);
    if (index === undefined || index <= previousIndex) {
      return false;
    }
    previousIndex = index;
  }
  return true;
}

export function isClosedMemoryCounts(value) {
  return isRecord(value)
    && hasExactKeys(value, MEMORY_COUNT_KEYS)
    && MEMORY_COUNT_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

export function hasOnlyZeroMemoryCounts(counts) {
  return MEMORY_COUNT_KEYS.every((key) => counts[key] === 0);
}

export function deriveBuiltInMemoryStatus(issues) {
  if (issues.some((issue) => MEMORY_UNKNOWN_ISSUES.has(issue))) return "unknown";
  if (issues.some((issue) => MEMORY_UNHEALTHY_ISSUES.has(issue))) return "unhealthy";
  if (issues.some((issue) => MEMORY_DEGRADED_ISSUES.has(issue))) return "degraded";
  return issues.length === 0 ? "healthy" : "in_progress";
}

export function hasValidBuiltInCountSemantics(mode, issues, counts) {
  const has = (issue) => issues.includes(issue);
  if (counts.due > counts.pending
    || has("intake_pending") !== (counts.pending > 0)
    || has("dead_letters") !== (counts.dead > 0)
    || has("outbox_pending") !== (counts.outbox > 0)
    || has("temporary_artifacts") !== (counts.temporary > 0)) {
    return false;
  }
  if (counts.outbox > 0 && !has("mutation_in_progress")) return false;

  const expectedMissingVectors = mode === "lite" ? 0 : Math.max(0, counts.memories - counts.vectors);
  if (counts.missingVectors !== expectedMissingVectors) return false;
  if (mode === "journal" && counts.missingVectors > 0 && !has("mutation_in_progress")) return false;
  if (mode === "bujo" && counts.vectors !== counts.memories && !has("vector_mismatch")) return false;
  if (mode === "lite" && counts.vectors !== 0 && !has("vector_mismatch")) return false;
  if (counts.vectors > counts.memories && !has("vector_mismatch")) return false;
  return true;
}

export function isValidIsoInstant(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const offsetHour = match[9] === undefined ? 0 : Number.parseInt(match[9], 10);
  const offsetMinute = match[10] === undefined ? 0 : Number.parseInt(match[10], 10);
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function evaluateMemory(memory) {
  if (memory?.timedOut === true) {
    return { status: "fail", memoryStatus: "malformed", note: "memory audit timed out" };
  }
  if (!memory || memory.ran !== true) {
    return { status: "fail", memoryStatus: "malformed", note: "memory audit unavailable" };
  }
  if (memory.malformed === true || typeof memory.status !== "string") {
    return { status: "fail", memoryStatus: "malformed", note: "strict memory audit malformed" };
  }
  if (MEMORY_PASS_STATUSES.has(memory.status)) {
    return { status: "pass", memoryStatus: memory.status, note: "" };
  }
  if (MEMORY_WARN_STATUSES.has(memory.status)) {
    return { status: "warn", memoryStatus: memory.status, note: "memory mutation in progress" };
  }
  if (MEMORY_SKIP_STATUSES.has(memory.status)) {
    return { status: "skip", memoryStatus: memory.status, note: "memory not configured" };
  }
  if (MEMORY_FAIL_STATUSES.has(memory.status)) {
    return { status: "fail", memoryStatus: memory.status, note: `memory ${memory.status}` };
  }
  return { status: "fail", memoryStatus: "malformed", note: "strict memory audit malformed" };
}

const CELL = { pass: "ok", warn: "warn", fail: "FAIL", skip: "—" };

// The verdict + table. Pure: takes already-collected structured data.
export function buildFleetReport(input) {
  const {
    date,
    deployedSha,
    deployedShaError,
    fleetLabelError,
    expectSha,
    expectNode,
    expectAbi,
    strictRuns,
    minRuns,
  } = input;
  const rows = input.instances.map((instance) => {
    const name = instanceName(instance.label);
    // A plist that matched the prefix but could not be read is an unknown
    // config the fleet may be running blind — RED, never silently dropped.
    if (typeof instance.discoveryError === "string") {
      const service = {
        status: "fail",
        note: instance.discoveryError === "plist probe timed out" ? "plist probe timed out" : "plist unreadable",
      };
      const skipped = { status: "skip", note: "" };
      return {
        name,
        label: instance.label,
        service,
        loaded: skipped,
        runtime: skipped,
        validate: skipped,
        memory: { ...skipped, memoryStatus: "malformed" },
        runs: skipped,
        notes: service.note,
      };
    }
    const service = evaluateService(instance.service);
    const runtime = evaluateRuntime(instance.runtime, { expectNode, expectAbi });
    const loaded = evaluateLoaded(instance.loaded, instance.service, instance.runtime, { expectSha });
    const validate = evaluateValidate(instance.validate);
    const memory = evaluateMemory(instance.memory);
    const runs = evaluateRuns(instance.metrics, { strictRuns, minRuns });
    const notes = [
      service.status !== "pass" ? service.note : null,
      loaded.status === "fail" ? loaded.note : null,
      runtime.status !== "pass" ? runtime.note : null,
      validate.status !== "pass" ? validate.note : null,
      memory.status !== "pass" ? memory.note : null,
      runs.note || null,
    ]
      .filter((note) => note !== null && note !== "")
      .join("; ");
    return { name, label: instance.label, service, loaded, runtime, validate, memory, runs, notes };
  });

  let reason = typeof fleetLabelError === "string" ? fleetLabelError : null;
  if (reason === null) {
    for (const row of rows) {
      if (row.service.status === "fail") {
        reason = `${row.name}: ${row.service.note}`;
        break;
      }
      if (row.loaded.status === "fail"
        && !(row.loaded.note === "build/runtime mismatch" && row.runtime.status === "fail")) {
        reason = `${row.name}: ${row.loaded.note}`;
        break;
      }
      if (row.runtime.status === "fail") {
        reason = `${row.name}: ${row.runtime.note}`;
        break;
      }
      if (row.loaded.status === "fail") {
        reason = `${row.name}: ${row.loaded.note}`;
        break;
      }
      if (row.validate.status === "fail") {
        reason = `${row.name}: ${row.validate.note}`;
        break;
      }
      if (row.memory.status === "fail") {
        reason = `${row.name}: ${row.memory.note}`;
        break;
      }
      if (row.runs.status === "fail") {
        reason = `${row.name}: ${row.runs.note}`;
        break;
      }
    }
  }

  const shaKnown = typeof deployedSha === "string" && deployedSha.length >= 7;
  if (reason === null && typeof deployedShaError === "string") {
    reason = deployedShaError;
  }
  if (reason === null && typeof expectSha === "string" && expectSha.length > 0) {
    if (!shaKnown || deployedSha !== expectSha) {
      reason = `deployed sha ${shortSha(deployedSha)} != expected ${shortSha(expectSha)}`;
    }
  }
  if (reason === null) {
    const checkoutShas = new Set(input.instances
      .map((instance) => instance.loaded?.checkoutInitial?.sha)
      .filter((sha) => typeof sha === "string"));
    if (checkoutShas.size > 1) {
      reason = `instances span ${checkoutShas.size} deploy revisions`;
    } else if (shaKnown && checkoutShas.size === 1 && !checkoutShas.has(deployedSha)) {
      reason = `deployed sha ${shortSha(deployedSha)} differs from loaded checkout`;
    }
  }
  if (reason === null && rows.length === 0) {
    reason = "no fleet instances discovered";
  }

  const verdict = reason === null ? "GREEN" : "RED";
  const verdictLine = verdict === "GREEN"
    ? `VERDICT: GREEN ${date} sha ${shortSha(deployedSha)}`
    : `VERDICT: RED ${date} — ${reason}`;

  const table = renderTable(rows);
  const shaLine = typeof expectSha === "string" && expectSha.length > 0
    ? `Deployed sha: ${shortSha(deployedSha)} (expected ${shortSha(expectSha)})`
    : `Deployed sha: ${shortSha(deployedSha)}`;
  const body = [
    `### Fleet green-check ${date}`,
    "",
    table,
    "",
    shaLine,
    "",
    verdictLine,
  ].join("\n");

  return { verdict, reason, rows, table, body, verdictLine, exitCode: verdict === "GREEN" ? 0 : 1 };
}

export function renderTable(rows) {
  const header = "| instance | service | loaded | runtime | validate | memory | runs-24h | notes |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((row) => {
    const notes = row.notes.length > 0 ? row.notes.replace(/\|/gu, "\\|") : "";
    return `| ${row.name} | ${CELL[row.service.status]} | ${CELL[row.loaded.status]} | ${CELL[row.runtime.status]} | ${CELL[row.validate.status]} | ${row.memory.memoryStatus} | ${CELL[row.runs.status]} | ${notes} |`;
  });
  return [header, divider, ...lines].join("\n");
}
