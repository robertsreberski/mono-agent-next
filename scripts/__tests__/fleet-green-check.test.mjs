import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLaunchdProbeEnvironment,
  buildFleetReport,
  deriveLaunchdLabel,
  deriveRepoFromCliPath,
  evaluateLoaded,
  evaluateExpectedLabels,
  evaluateMemory,
  evaluateRuntime,
  evaluateRuns,
  instanceName,
  inspectCanonicalLaunchdPath,
  parseArgs,
  parseBuildProvenanceProbe,
  parseManagedRuntimeAttestationProbe,
  parseLaunchdProgramArguments,
  parseLaunchdPathEnvironment,
  parseLaunchctlList,
  parseLaunchctlPrint,
  parseMemoryAudit,
  parseProcessStart,
  reduceMetrics,
  runCommandSync,
  runFleetGreenCheck,
  shortSha,
  MANAGED_BACKGROUND_ENV_NAMES,
} from "../fleet-green-check.mjs";
import { BACKGROUND_OPERATIONAL_ENV_NAMES } from "../../packages/agent-app/src/background-environment.ts";
import { managedPlistTopologyFingerprint } from "../fleet-green-check/probes.mjs";

const DATE = "2026-07-07";
const SHA = "0e35c86d1122334455667788990011223344abcd";
const NODE = "/opt/node-24.15.0/bin/node";
const NODE_DEVICE = "16777234";
const NODE_INODE = "424242";
const CLI = "/Users/example/mono-agent/packages/agent-app/dist/cli.js";
const MEMORY_CHECKED_AT = "2026-07-12T08:00:00.000Z";
const BUILD_COMPLETED_AT = "2026-07-12T10:00:00.000Z";
const RUNTIME_INSTALLED_AT = "2026-07-12T09:00:00.000Z";
const BUILD_FINGERPRINT = "a".repeat(64);
const OUTPUT_DIGEST = "b".repeat(64);
const DEPENDENCY_DIGEST = "c".repeat(64);
const PLIST_FINGERPRINT = "d".repeat(64);
const PLIST_SHAPE_FINGERPRINT = "e".repeat(64);
const EMPTY_MEMORY_COUNTS = Object.freeze({
  pending: 0,
  due: 0,
  dead: 0,
  outbox: 0,
  temporary: 0,
  memories: 0,
  vectors: 0,
  missingVectors: 0,
});

function strictMemoryReport({
  backend = "bujo",
  mode = backend === "bujo" ? "lite" : undefined,
  status = backend === "none" ? "not_configured" : backend === "supermemory" ? "unknown" : "healthy",
  checkedAt = MEMORY_CHECKED_AT,
  issues = [],
  counts = EMPTY_MEMORY_COUNTS,
} = {}) {
  return {
    schemaVersion: 1,
    backend,
    ...(mode === undefined ? {} : { mode }),
    status,
    checkedAt,
    issues,
    counts: { ...counts },
  };
}

function strictMemoryJson(status) {
  if (status === "not_configured") {
    return JSON.stringify(strictMemoryReport({ backend: "none", status }));
  }
  const issues = {
    healthy: [],
    in_progress: ["mutation_in_progress"],
    degraded: ["runtime_stale"],
    unhealthy: ["manifest_missing"],
    unknown: ["health_check_failed"],
  }[status];
  return JSON.stringify(strictMemoryReport({ status, issues }));
}

function service({ found = true, pid = 4242, lastExitStatus = 0 } = {}) {
  return { found, pid, lastExitStatus };
}

function launchctlPrintOutput({
  label = "com.mono-agent.orchestrator-b6ef5dde",
  pid = 100,
  programArguments = [NODE, CLI, "start", "--foreground", "--config", "/Users/example/agents/orchestrator/custom.config.json", "--env-file", "/Users/example/agents/orchestrator/.env.production"],
  cwd = "/Users/example/agents/orchestrator",
  plistPath = `/Users/example/Library/LaunchAgents/${label}.plist`,
  stdoutPath = `/Users/example/.mono-agent/logs/${label}.out.log`,
  stderrPath = `/Users/example/.mono-agent/logs/${label}.err.log`,
} = {}) {
  return [
    `gui/501/${label} = {`,
    `\tpath = ${plistPath}`,
    `\tprogram = ${programArguments[0]}`,
    "\targuments = {",
    ...programArguments.map((argument) => `\t\t${argument}`),
    "\t}",
    `\tworking directory = ${cwd}`,
    `\tstdout path = ${stdoutPath}`,
    `\tstderr path = ${stderrPath}`,
    `\tpid = ${pid}`,
    "}",
    "",
  ].join("\n");
}

function fakeLaunchdPathInspector(path, kind) {
  return `${kind}:${path}`;
}

function fakeExecutablePathInspector(path) {
  return {
    device: NODE_DEVICE,
    inode: NODE_INODE,
    fingerprint: `executable:${path}:${NODE_DEVICE}:${NODE_INODE}`,
  };
}

function fakeExecutableLsof(pid, path = NODE) {
  return {
    status: 0,
    stdout: `p${pid}\nftxt\nD0x1000012\ni${NODE_INODE}\nn${path}\n`,
    stderr: "",
  };
}

describe("inspectCanonicalLaunchdPath", () => {
  it("accepts only current-user private real directories and single-link 0600 plist files", () => {
    const root = mkdtempSync(join(tmpdir(), "mono-agent-launchd-metadata-"));
    try {
      chmodSync(root, 0o700);
      const plistPath = join(root, "agent.plist");
      writeFileSync(plistPath, "plist", { mode: 0o600 });
      expect(inspectCanonicalLaunchdPath(root, "directory")).toMatch(/^[0-9a-f]{64}$/u);
      expect(inspectCanonicalLaunchdPath(plistPath, "plist")).toMatch(/^[0-9a-f]{64}$/u);

      chmodSync(root, 0o755);
      expect(inspectCanonicalLaunchdPath(root, "directory")).toBeNull();
      chmodSync(root, 0o700);
      chmodSync(plistPath, 0o644);
      expect(inspectCanonicalLaunchdPath(plistPath, "plist")).toBeNull();
      chmodSync(plistPath, 0o600);

      const hardLink = join(root, "agent-hardlink.plist");
      linkSync(plistPath, hardLink);
      expect(lstatSync(plistPath).nlink).toBe(2);
      expect(inspectCanonicalLaunchdPath(plistPath, "plist")).toBeNull();
      rmSync(hardLink);
      const symbolicLink = join(root, "agent-symlink.plist");
      symlinkSync(plistPath, symbolicLink);
      expect(inspectCanonicalLaunchdPath(symbolicLink, "plist")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changes the identity proof when a validated plist changes", () => {
    const root = mkdtempSync(join(tmpdir(), "mono-agent-launchd-identity-"));
    try {
      const plistPath = join(root, "agent.plist");
      writeFileSync(plistPath, "first", { mode: 0o600 });
      const initial = inspectCanonicalLaunchdPath(plistPath, "plist");
      writeFileSync(plistPath, "second-and-longer", { mode: 0o600 });
      expect(inspectCanonicalLaunchdPath(plistPath, "plist")).not.toBe(initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("managed plist topology", () => {
  it("ignores scheduled mono-agent maintenance helpers as non-instance plists", () => {
    const instance = "com.mono-agent.demo-0a1b2c3d.plist";
    const helper = "com.mono-agent-maintenance.demo-0a1b2c3d.plist";
    expect(managedPlistTopologyFingerprint([instance, helper]))
      .toBe(managedPlistTopologyFingerprint([instance]));
  });
});

function buildMarker(overrides = {}) {
  return {
    schemaVersion: 2,
    gitSha: SHA,
    completedAt: BUILD_COMPLETED_AT,
    nodeVersion: "24.15.0",
    nodeAbi: "137",
    sourceState: "clean",
    outputDigest: OUTPUT_DIGEST,
    dependencyDigest: DEPENDENCY_DIGEST,
    ...overrides,
  };
}

function buildMarkerProbe(overrides = {}) {
  return {
    status: "ok",
    marker: buildMarker(),
    fingerprint: BUILD_FINGERPRINT,
    outputDigest: OUTPUT_DIGEST,
    dependencyDigest: DEPENDENCY_DIGEST,
    ...overrides,
  };
}

function loaded() {
  return {
    ran: true,
    plistFingerprint: PLIST_FINGERPRINT,
    plistShapeFingerprint: PLIST_SHAPE_FINGERPRINT,
    plistRecheck: {
      status: "ok",
      fingerprint: PLIST_FINGERPRINT,
      shapeFingerprint: PLIST_SHAPE_FINGERPRINT,
    },
    launchDefinitionInitial: { status: "ok", fingerprint: "f".repeat(64) },
    launchDefinitionFinal: { status: "ok", fingerprint: "f".repeat(64) },
    launchDefinitionTerminal: { status: "ok", fingerprint: "f".repeat(64) },
    markerInitial: buildMarkerProbe(),
    markerFinal: buildMarkerProbe(),
    checkoutInitial: { sha: SHA, clean: true, error: null },
    checkoutFinal: { sha: SHA, clean: true, error: null },
    processStart: { ran: true, startedAtMs: Date.parse("2026-07-12T10:01:00.000Z") },
    processIdentity: { ran: true, argvMatches: true, executableMatches: true, cwdMatches: true },
    serviceRecheck: service(),
  };
}

function metrics({ totalRuns = 40, failedRuns = 0, failureKinds = [] } = {}) {
  return { ran: true, totalRuns, failedRuns, failureKinds };
}

function greenInstance(label = "com.mono-agent.orchestrator-b6ef5dde") {
  return {
    label,
    dir: "/Users/example/agents/orchestrator",
    service: service(),
    loaded: loaded(),
    runtime: { ran: true, node: "24.15.0", abi: "137" },
    validate: { ran: true, exitCode: 0, validJson: true, ok: true },
    memory: { ran: true, status: "healthy" },
    metrics: metrics({ totalRuns: 110, failedRuns: 1, failureKinds: [{ kind: "provider_unavailable", count: 1 }] }),
  };
}

describe("parseArgs", () => {
  it("parses flags and value options", () => {
    const labels = ["com.mono-agent.a", "com.mono-agent.b", "com.mono-agent.c"];
    expect(parseArgs(["--dry-run", "--strict-runs", "--labels", labels.join(","), "--expect-labels", [...labels].reverse().join(","), "--expect-sha", SHA, "--expect-node", "24.16.0", "--expect-abi", "138", "--min-runs", "5", "--repo", "/r"]))
      .toEqual({ dryRun: true, strictRuns: true, help: false, labels, expectLabels: [...labels].reverse(), expectSha: SHA, expectNode: "24.16.0", expectAbi: "138", minRuns: 5, repo: "/r" });
  });

  it("defaults to a posting, lenient run", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, strictRuns: false, help: false, expectNode: "24.15.0", expectAbi: "137" });
  });

  it("rejects unknown args and missing/invalid values", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/u);
    expect(() => parseArgs(["--labels"])).toThrow(/--labels requires a value/u);
    expect(() => parseArgs(["--labels", "not-a-managed-label"])).toThrow(/canonical mono-agent labels/u);
    expect(() => parseArgs(["--expect-labels", "com.mono-agent.a,com.mono-agent.a"])).toThrow(/duplicate-free/u);
    expect(() => parseArgs(["--labels", "com.mono-agent.a", "--expect-labels", "com.mono-agent.b"]))
      .toThrow(/must exactly match/u);
    expect(() => parseArgs(["--min-runs", "-1"])).toThrow(/--min-runs requires a non-negative integer/u);
    expect(() => parseArgs(["--min-runs", "abc"])).toThrow(/--min-runs requires a non-negative integer/u);
    expect(() => parseArgs(["--expect-node", "24"])).toThrow(/--expect-node requires/u);
    expect(() => parseArgs(["--expect-abi", "abi137"])).toThrow(/--expect-abi requires/u);
    expect(() => parseArgs(["--expect-sha", "abc123"])).toThrow(/--expect-sha requires/u);
    expect(() => parseArgs(["--expect-sha", "A".repeat(40)])).toThrow(/--expect-sha requires/u);
  });
});

describe("expected fleet labels", () => {
  it("accepts only an exact set and reports closed missing/extra counts", () => {
    const expected = ["com.mono-agent.a", "com.mono-agent.b"];
    expect(evaluateExpectedLabels(expected, [...expected].reverse())).toBeNull();
    expect(evaluateExpectedLabels(["com.mono-agent.a", "com.mono-agent.c"], expected))
      .toBe("fleet labels mismatch (missing 1, extra 1)");
    expect(evaluateExpectedLabels(expected, undefined)).toBeNull();
  });
});

describe("parseLaunchctlList", () => {
  it("reads pid + last exit from a loaded service", () => {
    const text = '{\n\t"PID" = 34604;\n\t"LastExitStatus" = 0;\n};';
    expect(parseLaunchctlList(text, 0)).toEqual({ found: true, pid: 34604, lastExitStatus: 0 });
  });

  it("marks a stopped-clean service (no pid, exit 0) as found", () => {
    expect(parseLaunchctlList('{\n\t"LastExitStatus" = 0;\n};', 0)).toEqual({ found: true, pid: null, lastExitStatus: 0 });
  });

  it("treats a non-zero launchctl exit as not found (bogus label)", () => {
    expect(parseLaunchctlList("Could not find service.\n", 113)).toEqual({ found: false, pid: null, lastExitStatus: null });
  });
});

describe("parseLaunchctlPrint", () => {
  it("accepts only the exact loaded plist path, structured argv, cwd, and pid", () => {
    const label = "com.mono-agent.orchestrator-b6ef5dde";
    const programArguments = [NODE, CLI, "start", "--config", "/Users/example/Agent Folder/config.json"];
    const expected = {
      plistPath: `/Users/example/Library/LaunchAgents/${label}.plist`,
      launchdProgramArguments: programArguments,
      dir: "/Users/example/Agent Folder",
      stdoutPath: `/Users/example/.mono-agent/logs/${label}.out.log`,
      stderrPath: `/Users/example/.mono-agent/logs/${label}.err.log`,
      pid: 100,
    };
    expect(parseLaunchctlPrint(launchctlPrintOutput({
      label,
      programArguments,
      cwd: expected.dir,
    }), 0, expected)).toEqual({
      status: "ok",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(parseLaunchctlPrint(launchctlPrintOutput({
      label,
      programArguments: [...programArguments, "--unexpected"],
      cwd: expected.dir,
    }), 0, expected)).toEqual({ status: "unavailable" });
  });
});

describe("deriveRepoFromCliPath", () => {
  it("strips the packages/agent-app suffix", () => {
    expect(deriveRepoFromCliPath("/Users/example/mono-agent/packages/agent-app/dist/cli.js")).toBe("/Users/example/mono-agent");
  });

  it("returns null for non-matching paths", () => {
    expect(deriveRepoFromCliPath(null)).toBeNull();
    expect(deriveRepoFromCliPath("/usr/local/bin/node")).toBeNull();
  });
});

describe("loaded build provenance", () => {
  it("parses only the exact closed marker-probe contract", () => {
    const report = {
      schemaVersion: 2,
      status: "ok",
      marker: buildMarker(),
      fingerprint: BUILD_FINGERPRINT,
      outputDigest: OUTPUT_DIGEST,
      dependencyDigest: DEPENDENCY_DIGEST,
    };
    expect(parseBuildProvenanceProbe(JSON.stringify(report), 0)).toEqual(buildMarkerProbe());
    expect(parseBuildProvenanceProbe('{"schemaVersion":2,"status":"missing"}', 1)).toEqual({ status: "missing" });
    expect(parseBuildProvenanceProbe('{"schemaVersion":2,"status":"unsafe"}', 1)).toEqual({ status: "unsafe" });
    expect(parseBuildProvenanceProbe('{"schemaVersion":2,"status":"malformed"}', 1)).toEqual({ status: "malformed" });
  });

  it("parses only the closed managed-runtime attestation contract", () => {
    const fingerprint = "9".repeat(64);
    expect(parseManagedRuntimeAttestationProbe(JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      fingerprint,
      installedAt: RUNTIME_INSTALLED_AT,
    }), 0)).toEqual({ status: "ok", fingerprint, installedAt: RUNTIME_INSTALLED_AT });
    expect(parseManagedRuntimeAttestationProbe('{"schemaVersion":1,"status":"unsafe"}', 1))
      .toEqual({ status: "unsafe" });
    expect(parseManagedRuntimeAttestationProbe(JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      fingerprint,
      installedAt: RUNTIME_INSTALLED_AT,
      private: "must-not-survive",
    }), 0)).toEqual({ status: "malformed" });
  });

  it("requires stable managed-runtime attestation on managed rows", () => {
    const value = loaded();
    value.managed = true;
    value.processIdentity = { ran: true, executableMatches: true, cwdMatches: true };
    value.runtimeAttestationInitial = { status: "ok", fingerprint: "9".repeat(64), installedAt: RUNTIME_INSTALLED_AT };
    value.runtimeAttestationFinal = { status: "ok", fingerprint: "8".repeat(64), installedAt: RUNTIME_INSTALLED_AT };
    expect(evaluateLoaded(value, service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "fail", note: "managed runtime changed during probe" });
  });

  it("requires the running executable inode to match the plist Node for every accepted shape", () => {
    const value = loaded();
    value.processIdentity.executableMatches = false;
    expect(evaluateLoaded(value, service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "fail", note: "process executable does not match plist" });
  });

  it("rejects a process from the install second and accepts only a later-second start", () => {
    const value = loaded();
    value.managed = true;
    value.processIdentity = { ran: true, executableMatches: true, cwdMatches: true };
    value.runtimeAttestationInitial = {
      status: "ok",
      fingerprint: "9".repeat(64),
      installedAt: "2026-07-12T10:01:00.500Z",
    };
    value.runtimeAttestationFinal = { ...value.runtimeAttestationInitial };
    expect(evaluateLoaded(value, service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "fail", note: "process predates managed runtime" });

    value.processStart.startedAtMs = Date.parse("2026-07-12T10:01:01.000Z");
    expect(evaluateLoaded(value, service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "pass", note: "" });

    value.runtimeAttestationInitial.installedAt = "2026-07-12T10:02:00.000Z";
    value.runtimeAttestationFinal.installedAt = "2026-07-12T10:02:00.000Z";
    expect(evaluateLoaded(value, service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "fail", note: "process predates managed runtime" });
  });

  it.each([
    ["non-JSON", 1],
    [JSON.stringify({ schemaVersion: 2, status: "missing", private: "secret" }), 1],
    [JSON.stringify({ schemaVersion: 2, status: "ok", marker: { ...buildMarker(), private: "secret" }, fingerprint: BUILD_FINGERPRINT, outputDigest: OUTPUT_DIGEST, dependencyDigest: DEPENDENCY_DIGEST }), 0],
    [JSON.stringify({ schemaVersion: 2, status: "ok", marker: buildMarker(), fingerprint: BUILD_FINGERPRINT, outputDigest: OUTPUT_DIGEST }), 0],
    [JSON.stringify({ schemaVersion: 2, status: "ok", marker: { ...buildMarker(), dependencyDigest: undefined }, fingerprint: BUILD_FINGERPRINT, outputDigest: OUTPUT_DIGEST, dependencyDigest: DEPENDENCY_DIGEST }), 0],
    [JSON.stringify({ schemaVersion: 2, status: "ok", marker: buildMarker(), fingerprint: "short", outputDigest: OUTPUT_DIGEST, dependencyDigest: DEPENDENCY_DIGEST }), 0],
    [JSON.stringify({ schemaVersion: 2, status: "ok", marker: buildMarker({ sourceState: "unknown" }), fingerprint: BUILD_FINGERPRINT, outputDigest: OUTPUT_DIGEST, dependencyDigest: DEPENDENCY_DIGEST }), 0],
    [JSON.stringify({ schemaVersion: 2, status: "ok", marker: buildMarker(), fingerprint: BUILD_FINGERPRINT, outputDigest: OUTPUT_DIGEST, dependencyDigest: DEPENDENCY_DIGEST }), 1],
  ])("collapses malformed probe %# without retaining arbitrary values", (text, exitCode) => {
    const parsed = parseBuildProvenanceProbe(text, exitCode);
    expect(parsed).toEqual({ status: "malformed" });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("parses the closed ps start-time shape", () => {
    const parsed = parseProcessStart("Sun Jul 12 12:01:00 2026\n", 0);
    expect(parsed).toEqual({ ran: true, startedAtMs: Date.UTC(2026, 6, 12, 12, 1, 0) });
    expect(parseProcessStart("private process output", 0)).toEqual({ ran: false });
    expect(parseProcessStart("Sun Jul 12 12:01:00 2026", 1)).toEqual({ ran: false });
    expect(parseProcessStart("Mon Jul 12 12:01:00 2026", 0)).toEqual({ ran: false });
    expect(parseProcessStart("Sun Feb 30 12:01:00 2026", 0)).toEqual({ ran: false });
  });

  it("passes only a stable process started after the matching clean build", () => {
    expect(evaluateLoaded(loaded(), service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "pass", note: "" });
  });

  it.each([
    ["missing marker", (value) => { value.markerInitial = { status: "missing" }; value.markerFinal = { status: "missing" }; }, "build marker missing"],
    ["unsafe marker", (value) => { value.markerInitial = { status: "unsafe" }; value.markerFinal = { status: "unsafe" }; }, "build marker unsafe"],
    ["dirty source", (value) => { value.markerInitial.marker.sourceState = "dirty"; value.markerFinal.marker.sourceState = "dirty"; }, "build source not clean"],
    ["wrong sha", (value) => { value.markerInitial.marker.gitSha = "b".repeat(40); value.markerFinal.marker.gitSha = "b".repeat(40); }, "build marker sha mismatch"],
    ["marker replacement", (value) => { value.markerFinal.fingerprint = "b".repeat(64); }, "build changed during probe"],
    ["output mutation", (value) => { value.markerFinal.outputDigest = "c".repeat(64); }, "build changed during probe"],
    ["dependency mutation", (value) => { value.markerFinal.dependencyDigest = "f".repeat(64); }, "build changed during probe"],
    ["digest mismatch", (value) => { value.markerInitial.outputDigest = "c".repeat(64); value.markerFinal.outputDigest = "c".repeat(64); }, "build output digest mismatch"],
    ["dependency mismatch", (value) => { value.markerInitial.dependencyDigest = "f".repeat(64); value.markerFinal.dependencyDigest = "f".repeat(64); }, "build dependency digest mismatch"],
    ["sha unavailable", (value) => { value.checkoutInitial = { sha: null, clean: true, error: null }; }, "checkout sha unavailable"],
    ["checkout race", (value) => { value.checkoutFinal.sha = "c".repeat(40); }, "checkout changed during probe"],
    ["dirty checkout initially", (value) => { value.checkoutInitial.clean = false; }, "deploy checkout dirty"],
    ["dirty checkout finally", (value) => { value.checkoutFinal.clean = false; }, "deploy checkout dirty"],
    ["service restart", (value) => { value.serviceRecheck = service({ pid: 4343 }); }, "service changed during probe"],
    ["service state change", (value) => { value.serviceRecheck = service({ lastExitStatus: 1 }); }, "service changed during probe"],
    ["stale argv", (value) => { value.processIdentity.argvMatches = false; }, "process arguments do not match plist"],
    ["stale cwd", (value) => { value.processIdentity.cwdMatches = false; }, "process working directory does not match plist"],
    ["plist replacement", (value) => { value.plistRecheck.fingerprint = "f".repeat(64); }, "launchd plist changed during probe"],
    ["plist shape change", (value) => { value.plistRecheck.shapeFingerprint = "f".repeat(64); }, "launchd plist changed during probe"],
    ["plist removal", (value) => { value.plistRecheck = { status: "unavailable" }; }, "launchd plist changed during probe"],
    ["plist timeout", (value) => { value.plistRecheck = { status: "unavailable", timedOut: true }; }, "plist recheck timed out"],
    ["old process", (value) => { value.processStart.startedAtMs = Date.parse(BUILD_COMPLETED_AT); }, "process predates build"],
  ])("fails closed for %s", (_label, mutate, note) => {
    const value = loaded();
    mutate(value);
    expect(evaluateLoaded(value, service(), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "fail", note });
  });

  it("requires a running process even when the stopped job last exited cleanly", () => {
    expect(evaluateLoaded({ ran: false }, service({ pid: null, lastExitStatus: 0 }), { ran: true, node: "24.15.0", abi: "137" }))
      .toEqual({ status: "fail", note: "running process required" });
  });

  it("requires the full expected sha on the per-instance checkout and marker", () => {
    expect(evaluateLoaded(loaded(), service(), { ran: true, node: "24.15.0", abi: "137" }, { expectSha: "c".repeat(40) }))
      .toEqual({ status: "fail", note: "loaded sha 0e35c86 != expected ccccccc" });
  });
});

describe("parseLaunchdProgramArguments", () => {
  const config = "/Users/example/agents/orchestrator/custom.config.json";
  const envFile = "/Users/example/agents/orchestrator/.env.production";
  const managedArguments = (...environment) => [
    "/usr/bin/env",
    "-i",
    ...environment,
    NODE,
    CLI,
    "start",
    "--foreground",
    "--config",
    config,
    "--env-file",
    envFile,
    "--expected-background-snapshot",
    "approved_snapshot",
    "--expected-managed-runtime-launch",
    "runtime_proof",
  ];

  it("retains only the exact absolute config and env-file used by the service", () => {
    const programArguments = [
      NODE, CLI, "start", "--foreground", "--config", config, "--env-file", envFile,
    ];
    expect(parseLaunchdProgramArguments(programArguments)).toEqual({
      nodePath: NODE,
      cliPath: CLI,
      configPath: config,
      envFile,
      expectedBackgroundSnapshot: undefined,
      expectedManagedRuntimeLaunch: undefined,
      managed: false,
      launchdProgramArguments: programArguments,
      programArguments,
      probeArgs: ["--config", config, "--env-file", envFile],
    });
  });

  it("rejects an unversioned cwd-default legacy shape no producer emitted", () => {
    const programArguments = [NODE, CLI, "start", "--foreground"];
    expect(parseLaunchdProgramArguments(programArguments)).toBeNull();
  });

  it("accepts the hardened managed-worker wrapper and retains its exact non-secret environment", () => {
    const programArguments = managedArguments(
      "HOME=/Users/example",
      "MONO_AGENT_MANAGED_WORKER=1",
      "PATH=/managed/bin:/usr/bin:/bin",
    );
    expect(parseLaunchdProgramArguments(programArguments)).toEqual({
      nodePath: NODE,
      cliPath: CLI,
      configPath: config,
      envFile,
      expectedBackgroundSnapshot: "approved_snapshot",
      expectedManagedRuntimeLaunch: "runtime_proof",
      managed: true,
      managedEnvironment: {
        HOME: "/Users/example",
        PATH: "/managed/bin:/usr/bin:/bin",
      },
      launchdProgramArguments: programArguments,
      programArguments: programArguments.slice(5),
      probeArgs: ["--config", config, "--env-file", envFile],
      pathEnv: "/managed/bin:/usr/bin:/bin",
    });
  });

  it.each([
    ["unknown environment", managedArguments("AWS_ACCESS_KEY_ID=private", "MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin")],
    ["missing lifecycle marker", managedArguments("HOME=/Users/example", "PATH=/usr/bin:/bin")],
    ["wrong lifecycle marker", managedArguments("MONO_AGENT_MANAGED_WORKER=0", "PATH=/usr/bin:/bin")],
    ["missing PATH", managedArguments("MONO_AGENT_MANAGED_WORKER=1")],
    ["duplicate PATH", managedArguments("MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin", "PATH=/bin")],
    ["unsorted environment", managedArguments("PATH=/usr/bin:/bin", "MONO_AGENT_MANAGED_WORKER=1")],
    ["missing approved snapshot", managedArguments("MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin").slice(0, -4)],
    ["missing runtime proof", managedArguments("MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin").slice(0, -2)],
    ["reordered lifecycle flags", (() => {
      const args = managedArguments("MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin");
      const worker = args.slice(4);
      return [...args.slice(0, 4), worker[0], worker[1], "start", "--config", config, "--foreground", "--env-file", envFile, "--expected-background-snapshot", "approved_snapshot", "--expected-managed-runtime-launch", "runtime_proof"];
    })()],
  ])("rejects a managed wrapper with %s", (_label, args) => {
    expect(parseLaunchdProgramArguments(args)).toBeNull();
  });

  it("accepts producer-valid spaces in managed paths and values without ambiguous ps argv proof", () => {
    const spacedConfig = "/Users/example/Agent Folder/config file.json";
    const spaced = managedArguments(
      "HOME=/Users/example/Agent Home",
      "MONO_AGENT_MANAGED_WORKER=1",
      "PATH=/Users/example/Agent Home/bin:/usr/bin:/bin",
    );
    spaced[spaced.indexOf(config)] = spacedConfig;
    expect(parseLaunchdProgramArguments(spaced)).toMatchObject({
      managed: true,
      configPath: spacedConfig,
      managedEnvironment: {
        HOME: "/Users/example/Agent Home",
        PATH: "/Users/example/Agent Home/bin:/usr/bin:/bin",
      },
    });
  });

  it("uses locale-independent code-unit ordering and stays in exact producer allowlist parity", () => {
    const argumentsWithMixedCase = managedArguments(
      "COMSPEC=/first",
      "ComSpec=/second",
      "MONO_AGENT_MANAGED_WORKER=1",
      "PATH=/usr/bin:/bin",
    );
    expect(parseLaunchdProgramArguments(argumentsWithMixedCase)?.managed).toBe(true);
    expect(new Set([...MANAGED_BACKGROUND_ENV_NAMES].filter((name) => name !== "MONO_AGENT_MANAGED_WORKER")))
      .toEqual(new Set(BACKGROUND_OPERATIONAL_ENV_NAMES));
  });

  it.each([
    ["missing config value", [NODE, CLI, "start", "--config"]],
    ["relative config", [NODE, CLI, "start", "--config", "relative.json"]],
    ["duplicate config", [NODE, CLI, "start", "--config", config, "--config", config]],
    ["duplicate env file", [NODE, CLI, "start", "--env-file", envFile, "--env-file", envFile]],
    ["unknown flag", [NODE, CLI, "start", "--token", "private-value"]],
    ["wrong command", [NODE, CLI, "validate", "--config", config]],
    ["relative runtime", ["node", CLI, "start", "--config", config]],
    ["NUL runtime", [`${NODE}\0private-runtime`, CLI, "start", "--config", config]],
    ["NUL cli", [NODE, `${CLI}\0private-cli`, "start", "--config", config]],
    ["newline argument", [NODE, CLI, "start", "--config", `${config}\nprivate`]],
    ["space-bearing config", [NODE, CLI, "start", "--config", "/private/config path.json"]],
    ["tab-bearing runtime", [`${NODE}\tprivate`, CLI, "start", "--config", config]],
    ["non-string argument", [NODE, CLI, "start", "--config", 7]],
  ])("rejects %s", (_label, args) => {
    expect(parseLaunchdProgramArguments(args)).toBeNull();
  });
});

describe("parseLaunchdPathEnvironment", () => {
  it("retains the exact non-secret PATH emitted by the managed plist", () => {
    expect(parseLaunchdPathEnvironment({ PATH: "/managed/bin:/usr/bin:/bin" }))
      .toBe("/managed/bin:/usr/bin:/bin");
  });

  it.each([
    ["missing environment", undefined],
    ["missing PATH", {}],
    ["empty PATH", { PATH: "" }],
    ["non-string PATH", { PATH: 7 }],
    ["NUL PATH", { PATH: "/usr/bin\0/private" }],
    ["additional variable", { PATH: "/usr/bin:/bin", PRIVATE_TOKEN: "must-not-retain" }],
  ])("rejects %s", (_label, environment) => {
    expect(parseLaunchdPathEnvironment(environment)).toBeNull();
  });
});

describe("buildLaunchdProbeEnvironment", () => {
  it("keeps only the exact PATH and launchd-safe operational values", () => {
    expect(buildLaunchdProbeEnvironment("/managed/bin:/usr/bin:/bin", {
      PATH: "/interactive/bin",
      HOME: "/Users/example",
      USER: "example",
      LANG: "en_US.UTF-8",
      MONO_AGENT_MEMORY_PATH: "/private/wrong-memory",
      MONO_AGENT_MODEL: "wrong-model",
      OPENAI_API_KEY: "private-provider-credential",
      ANTHROPIC_API_KEY: "private-provider-credential",
      NODE_OPTIONS: "--require=/private/inject.js",
      HTTPS_PROXY: "http://private-proxy.invalid",
    })).toEqual({
      PATH: "/managed/bin:/usr/bin:/bin",
      HOME: "/Users/example",
      USER: "example",
      LANG: "en_US.UTF-8",
    });
  });
});

describe("reduceMetrics", () => {
  it("extracts the overall bucket fields", () => {
    const report = {
      overall: {
        totalRuns: 110,
        statusCounts: { succeeded: 109, failed: 1 },
        failureKindRates: [{ failureKind: "provider_unavailable", count: 1, rate: 0.009 }],
      },
    };
    expect(reduceMetrics(report)).toEqual({
      ran: true,
      totalRuns: 110,
      failedRuns: 1,
      failureKinds: [{ kind: "provider_unavailable", count: 1 }],
    });
  });

  it("rejects malformed aggregate JSON instead of fabricating zero runs", () => {
    expect(() => reduceMetrics({ overall: { totalRuns: "secret", failureKindRates: [] } })).toThrow(/invalid metrics/u);
    expect(() => reduceMetrics({ overall: { totalRuns: 1, statusCounts: { failed: 0 } } })).toThrow(/invalid metrics/u);
  });
});

describe("runtime health", () => {
  it("passes only the expected exact Node version and modules ABI", () => {
    expect(evaluateRuntime({ ran: true, node: "24.15.0", abi: "137" })).toEqual({
      status: "pass",
      note: "24.15.0/abi137",
    });
    expect(evaluateRuntime({ ran: true, node: "24.15.1", abi: "137" }).status).toBe("fail");
    expect(evaluateRuntime({ ran: true, node: "24.15.0", abi: "127" }).status).toBe("fail");
    expect(evaluateRuntime({ ran: false }).status).toBe("fail");
  });
});

describe("strict memory health", () => {
  it.each([
    ["healthy", 0, "pass"],
    ["in_progress", 0, "warn"],
    ["not_configured", 0, "skip"],
    ["degraded", 1, "fail"],
    ["unhealthy", 1, "fail"],
    ["unknown", 1, "fail"],
  ])("classifies %s from its contract exit", (status, exitCode, expected) => {
    const parsed = parseMemoryAudit(strictMemoryJson(status), exitCode);
    expect(parsed).toEqual({ ran: true, status });
    expect(evaluateMemory(parsed).status).toBe(expected);
    expect(evaluateMemory(parsed).memoryStatus).toBe(status);
  });

  it.each([
    [strictMemoryReport({ mode: "lite" }), 0, "healthy"],
    [strictMemoryReport({ mode: "journal", status: "in_progress", issues: ["mutation_in_progress"] }), 0, "in_progress"],
    [strictMemoryReport({ mode: "bujo", status: "degraded", issues: ["runtime_stale"] }), 1, "degraded"],
    [strictMemoryReport({ backend: "none" }), 0, "not_configured"],
    [strictMemoryReport({ backend: "supermemory" }), 1, "unknown"],
  ])("accepts the complete closed backend report %#", (report, exitCode, status) => {
    expect(parseMemoryAudit(JSON.stringify(report), exitCode)).toEqual({ ran: true, status });
  });

  it("accepts a real ISO instant with an explicit offset", () => {
    const report = strictMemoryReport({ checkedAt: "2026-07-12T10:00:00+02:00" });
    expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, status: "healthy" });
  });

  it.each([
    ["non-JSON", 1],
    [JSON.stringify({ schemaVersion: 1 }), 0],
    [JSON.stringify({ ...strictMemoryReport(), status: "invented" }), 1],
    [JSON.stringify({ ...strictMemoryReport(), schemaVersion: 2 }), 0],
    [strictMemoryJson("degraded"), 0],
    [strictMemoryJson("healthy"), 1],
    [strictMemoryJson("healthy"), 2],
  ])("fails closed on malformed output/exit %#", (json, exitCode) => {
    const parsed = parseMemoryAudit(json, exitCode);
    expect(parsed).toEqual({ ran: true, malformed: true });
    expect(evaluateMemory(parsed)).toMatchObject({ status: "fail", memoryStatus: "malformed" });
  });

  it.each(["schemaVersion", "backend", "mode", "status", "checkedAt", "issues", "counts"])(
    "rejects a built-in report missing %s",
    (field) => {
      const report = strictMemoryReport();
      delete report[field];
      expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, malformed: true });
    },
  );

  it("rejects extra top-level fields and never retains their secret-bearing values", () => {
    const secret = "ya29.extra-field-secret";
    const parsed = parseMemoryAudit(JSON.stringify({ ...strictMemoryReport(), diagnostics: { token: secret } }), 0);
    expect(parsed).toEqual({ ran: true, malformed: true });
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  it.each([
    ["unknown backend", { backend: "unknown" }, 1],
    ["invalid bujo mode", { mode: "full" }, 0],
    ["not-configured bujo", { status: "not_configured" }, 0],
    ["none with a mode", { backend: "none", mode: "lite", status: "not_configured" }, 0],
    ["healthy none", { backend: "none", mode: undefined, status: "healthy" }, 0],
    ["supermemory with a mode", { backend: "supermemory", mode: "lite", status: "unknown" }, 1],
    ["not-configured supermemory", { backend: "supermemory", mode: undefined, status: "not_configured" }, 0],
  ])("rejects invalid backend/status/mode combination: %s", (_label, values, exitCode) => {
    expect(parseMemoryAudit(JSON.stringify(strictMemoryReport(values)), exitCode)).toEqual({ ran: true, malformed: true });
  });

  it("rejects a built-in report without its required mode", () => {
    const report = strictMemoryReport();
    delete report.mode;
    expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, malformed: true });
  });

  it.each([
    ["not a timestamp", "not-a-timestamp"],
    ["date only", "2026-07-12"],
    ["impossible day", "2026-02-30T08:00:00.000Z"],
    ["non-leap February", "2025-02-29T08:00:00.000Z"],
    ["invalid hour", "2026-07-12T24:00:00.000Z"],
    ["invalid offset", "2026-07-12T08:00:00+24:00"],
  ])("rejects invalid checkedAt: %s", (_label, checkedAt) => {
    const report = strictMemoryReport({ checkedAt });
    expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, malformed: true });
  });

  it.each([
    ["not an array", "manifest_missing"],
    ["unknown code", ["secret_provider_error"]],
    ["non-string code", [1]],
    ["duplicate code", ["manifest_missing", "manifest_missing"]],
    ["non-canonical order", ["database_missing", "manifest_missing"]],
  ])("rejects an invalid issues field: %s", (_label, issues) => {
    const report = strictMemoryReport({ issues });
    expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, malformed: true });
  });

  it("accepts the complete issue vocabulary in canonical producer order", () => {
    const issues = [
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
    const counts = {
      ...EMPTY_MEMORY_COUNTS,
      pending: 1,
      due: 1,
      dead: 1,
      outbox: 1,
      temporary: 1,
    };
    expect(parseMemoryAudit(JSON.stringify(strictMemoryReport({ status: "unknown", issues, counts })), 1))
      .toEqual({ ran: true, status: "unknown" });
  });

  it.each([
    ["healthy with a fatal issue", { status: "healthy", issues: ["manifest_missing"] }, 0],
    ["degraded with an unknown issue", { status: "degraded", issues: ["health_check_failed"] }, 1],
    ["unknown with only stalled work", { status: "unknown", issues: ["work_stalled"] }, 1],
  ])("rejects status/issue contradictions: %s", (_label, values, exitCode) => {
    expect(parseMemoryAudit(JSON.stringify(strictMemoryReport(values)), exitCode))
      .toEqual({ ran: true, malformed: true });
  });

  it("accepts the new closed status mappings", () => {
    expect(parseMemoryAudit(JSON.stringify(strictMemoryReport({
      status: "unknown",
      issues: ["health_check_failed"],
    })), 1)).toEqual({ ran: true, status: "unknown" });
    expect(parseMemoryAudit(JSON.stringify(strictMemoryReport({
      status: "degraded",
      issues: ["work_stalled"],
    })), 1)).toEqual({ ran: true, status: "degraded" });
  });

  it.each([
    ["due exceeds pending", { counts: { ...EMPTY_MEMORY_COUNTS, due: 1 } }, 0],
    ["pending lacks issue", { counts: { ...EMPTY_MEMORY_COUNTS, pending: 1 } }, 0],
    ["pending issue lacks count", { status: "in_progress", issues: ["intake_pending"] }, 0],
    ["dead count lacks issue", { counts: { ...EMPTY_MEMORY_COUNTS, dead: 1 } }, 0],
    ["outbox lacks mutation issue", { status: "in_progress", issues: ["outbox_pending"], counts: { ...EMPTY_MEMORY_COUNTS, outbox: 1 } }, 0],
    ["temporary count lacks issue", { counts: { ...EMPTY_MEMORY_COUNTS, temporary: 1 } }, 0],
    ["none backend has counts", { backend: "none", status: "not_configured", counts: { ...EMPTY_MEMORY_COUNTS, memories: 1 } }, 0],
    ["supermemory backend has counts", { backend: "supermemory", status: "unknown", counts: { ...EMPTY_MEMORY_COUNTS, memories: 1 } }, 1],
  ])("rejects count/issue contradictions: %s", (_label, values, exitCode) => {
    expect(parseMemoryAudit(JSON.stringify(strictMemoryReport(values)), exitCode))
      .toEqual({ ran: true, malformed: true });
  });

  it("accepts Journal vector backlog as in-progress without overconstraining queue counts", () => {
    const report = strictMemoryReport({
      mode: "journal",
      status: "in_progress",
      issues: ["mutation_in_progress"],
      counts: { ...EMPTY_MEMORY_COUNTS, memories: 3, vectors: 2, missingVectors: 1 },
    });
    expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, status: "in_progress" });
  });

  it.each([
    ["missing count", ({ missingVectors: _omitted, ...counts }) => counts],
    ["extra count", (counts) => ({ ...counts, secretBytes: 1 })],
    ["negative count", (counts) => ({ ...counts, pending: -1 })],
    ["fractional count", (counts) => ({ ...counts, due: 0.5 })],
    ["unsafe count", (counts) => ({ ...counts, memories: Number.MAX_SAFE_INTEGER + 1 })],
    ["numeric string", (counts) => ({ ...counts, vectors: "0" })],
  ])("rejects invalid closed counts: %s", (_label, mutate) => {
    const report = strictMemoryReport({ counts: mutate(EMPTY_MEMORY_COUNTS) });
    expect(parseMemoryAudit(JSON.stringify(report), 0)).toEqual({ ran: true, malformed: true });
  });
});

describe("evaluateRuns", () => {
  it("passes a lone transient failover (1-of-110 provider_unavailable)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 110, failedRuns: 1, failureKinds: [{ kind: "provider_unavailable", count: 1 }] }));
    expect(result.status).toBe("pass");
    expect(result.note).toBe("110 runs, 1 failed (provider_unavailable×1)");
  });

  it("passes provider_unavailable below the volume guard (3-of-10 = 30%)", () => {
    expect(evaluateRuns(metrics({ totalRuns: 10, failedRuns: 3, failureKinds: [{ kind: "provider_unavailable", count: 3 }] })).status).toBe("pass");
  });

  it("flips usage_limit to RED — only provider_unavailable is tolerated now", () => {
    const result = evaluateRuns(metrics({ totalRuns: 40, failedRuns: 1, failureKinds: [{ kind: "usage_limit", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["usage_limit"]);
  });

  it("keeps context_limit RED so an exhausted overflow remains visible", () => {
    const result = evaluateRuns(metrics({ totalRuns: 40, failedRuns: 1, failureKinds: [{ kind: "context_limit", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["context_limit"]);
  });

  it("48-of-48 provider_auth is RED (untolerated kind, and it dominates)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 48, failedRuns: 48, failureKinds: [{ kind: "provider_auth", count: 48 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["provider_auth"]);
  });

  it("volume guard: even a tolerated kind is RED when every run fails", () => {
    const result = evaluateRuns(metrics({ totalRuns: 5, failedRuns: 5, failureKinds: [{ kind: "provider_unavailable", count: 5 }] }));
    expect(result.status).toBe("fail");
    expect(result.note).toContain("all runs failed");
  });

  it("volume guard: >50% failure over >=5 runs is RED even if tolerated", () => {
    const result = evaluateRuns(metrics({ totalRuns: 6, failedRuns: 4, failureKinds: [{ kind: "provider_unavailable", count: 4 }] }));
    expect(result.status).toBe("fail");
    expect(result.note).toContain("failure rate 67% over 6 runs");
  });

  it("treats a lifecycle cancellation as GREEN, surfacing the count (not a failure)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 25, failedRuns: 0, failureKinds: [{ kind: "cancelled_stale", count: 1 }] }));
    expect(result.status).toBe("pass");
    expect(result.note).toBe("25 runs, 0 failed, 1 cancelled");
    expect(result.untoleratedKinds).toEqual([]);
  });

  it("stays RED when a real untolerated kind coexists with a cancellation (names only the real one)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 25, failedRuns: 1, failureKinds: [{ kind: "runtime_error", count: 1 }, { kind: "cancelled_user", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["runtime_error"]);
    expect(result.note).toContain("1 cancelled");
    expect(result.note).toContain("untolerated failure kind(s): runtime_error");
  });

  it("fails on a new (unknown) failure kind", () => {
    const result = evaluateRuns(metrics({ totalRuns: 10, failedRuns: 1, failureKinds: [{ kind: "totally_new_kind", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["totally_new_kind"]);
  });

  it("fails on an unclassified failure (failed runs without a kind)", () => {
    const result = evaluateRuns(metrics({ totalRuns: 10, failedRuns: 2, failureKinds: [{ kind: "provider_unavailable", count: 1 }] }));
    expect(result.status).toBe("fail");
    expect(result.untoleratedKinds).toEqual(["(unclassified)"]);
  });

  it("under --strict-runs fails on any failed run, even a tolerated one", () => {
    const clean = metrics({ totalRuns: 10, failedRuns: 1, failureKinds: [{ kind: "provider_unavailable", count: 1 }] });
    expect(evaluateRuns(clean).status).toBe("pass");
    expect(evaluateRuns(clean, { strictRuns: true }).status).toBe("fail");
  });

  it("zero runs is a non-RED idle warning", () => {
    const result = evaluateRuns(metrics({ totalRuns: 0, failedRuns: 0 }));
    expect(result.status).toBe("warn");
    expect(result.note).toBe("0 runs (idle?)");
  });

  it("--min-runs fails a too-quiet instance", () => {
    expect(evaluateRuns(metrics({ totalRuns: 2, failedRuns: 0 }), { minRuns: 5 }).status).toBe("fail");
    expect(evaluateRuns(metrics({ totalRuns: 0, failedRuns: 0 }), { minRuns: 5 }).status).toBe("fail");
    expect(evaluateRuns(metrics({ totalRuns: 6, failedRuns: 0 }), { minRuns: 5 }).status).toBe("pass");
  });

  it("fails when metrics could not be read", () => {
    expect(evaluateRuns({ ran: false, error: "boom" }).status).toBe("fail");
  });

  it("skips when there is no runs data", () => {
    expect(evaluateRuns({ ran: false }).status).toBe("skip");
  });
});

describe("buildFleetReport", () => {
  it("GREEN: every instance passes, no expected sha", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance()] });
    expect(report.verdict).toBe("GREEN");
    expect(report.reason).toBeNull();
    expect(report.exitCode).toBe(0);
    expect(report.verdictLine).toBe(`VERDICT: GREEN ${DATE} sha 0e35c86`);
    expect(report.table).toContain("| instance | service | loaded | runtime | validate | memory | runs-24h | notes |");
    expect(report.table).toContain("| orchestrator-b6ef5dde | ok | ok | ok | ok | healthy | ok |");
    expect(report.body).toContain(`### Fleet green-check ${DATE}`);
  });

  it("RED-service-down: a stopped instance drives RED with the service reason", () => {
    const down = greenInstance("com.mono-agent.personal-agent-059657c8");
    down.service = service({ pid: null, lastExitStatus: 1 });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), down] });
    expect(report.verdict).toBe("RED");
    expect(report.exitCode).toBe(1);
    expect(report.reason).toBe("personal-agent-059657c8: not running (last exit 1)");
    expect(report.verdictLine).toBe(`VERDICT: RED ${DATE} — personal-agent-059657c8: not running (last exit 1)`);
  });

  it("RED-loaded-stale: a running pre-build process drives RED in its own column", () => {
    const stale = greenInstance();
    stale.loaded.processStart.startedAtMs = Date.parse(BUILD_COMPLETED_AT);
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [stale] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("orchestrator-b6ef5dde: process predates build");
    expect(report.table).toContain("| orchestrator-b6ef5dde | ok | FAIL | ok |");
  });

  it("marks a stopped clean service RED because every selected agent must run", () => {
    const stopped = greenInstance("com.mono-agent.transcription");
    stopped.service = service({ pid: null, lastExitStatus: 0 });
    stopped.loaded = { ran: false };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [stopped] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("transcription: not running (last exit 0)");
    expect(report.table).toContain("| transcription | FAIL | FAIL | ok |");
  });

  it("RED-validate-fail: reports failure without possibly-secret validation details", () => {
    const broken = greenInstance();
    broken.validate = { ran: true, exitCode: 1, validJson: true, ok: false };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [broken] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("validate reported errors");
  });

  it("RED-runtime-mismatch: the exact plist runtime must match Node and ABI", () => {
    const broken = greenInstance();
    broken.runtime = { ran: true, node: "22.19.0", abi: "127" };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [broken] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("orchestrator-b6ef5dde: runtime 22.19.0/abi127 != expected 24.15.0/abi137");
  });

  it.each([
    ["healthy", "GREEN"],
    ["in_progress", "GREEN"],
    ["not_configured", "GREEN"],
    ["degraded", "RED"],
    ["unhealthy", "RED"],
    ["unknown", "RED"],
  ])("renders memory status %s and applies its verdict policy", (status, verdict) => {
    const instance = greenInstance();
    instance.memory = { ran: true, status };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [instance] });
    expect(report.verdict).toBe(verdict);
    expect(report.table).toContain(`| ${status} |`);
  });

  it("RED-memory-malformed: a missing strict result cannot masquerade as not configured", () => {
    const instance = greenInstance();
    instance.memory = { ran: true, malformed: true };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [instance] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("strict memory audit malformed");
    expect(report.table).toContain("| malformed |");
  });

  it("RED-runs-new-kind: an untolerated failure kind drives RED", () => {
    const bad = greenInstance();
    bad.metrics = metrics({ totalRuns: 5, failedRuns: 1, failureKinds: [{ kind: "segfault_novel", count: 1 }] });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [bad] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("untolerated failure kind(s): segfault_novel");
  });

  it("RED-runs-volume: a tolerated kind that floods the window drives RED", () => {
    const bad = greenInstance();
    bad.metrics = metrics({ totalRuns: 48, failedRuns: 48, failureKinds: [{ kind: "provider_unavailable", count: 48 }] });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [bad] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("all runs failed");
  });

  it("RED-unreadable-plist: a plist that failed conversion is a RED row, not dropped", () => {
    const broken = { label: "com.mono-agent.corrupt-plist", discoveryError: "plist JSON invalid" };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), broken] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("corrupt-plist: plist unreadable");
    expect(report.table).toContain("| corrupt-plist | FAIL | — | — | — | malformed | — |");
  });

  it("idle instance: zero runs shows a non-RED warn cell", () => {
    const idle = greenInstance("com.mono-agent.deep-research-cd0b9a0d");
    idle.metrics = metrics({ totalRuns: 0, failedRuns: 0 });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [idle] });
    expect(report.verdict).toBe("GREEN");
    expect(report.table).toContain("| deep-research-cd0b9a0d | ok | ok | ok | ok | healthy | warn | 0 runs (idle?) |");
  });

  it("a lifecycle cancellation keeps the fleet GREEN with a visible cancelled note", () => {
    const cancelled = greenInstance("com.mono-agent.personal-agent-059657c8");
    cancelled.metrics = metrics({ totalRuns: 25, failedRuns: 0, failureKinds: [{ kind: "cancelled_stale", count: 1 }] });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), cancelled] });
    expect(report.verdict).toBe("GREEN");
    expect(report.table).toContain("| personal-agent-059657c8 | ok | ok | ok | ok | healthy | ok | 25 runs, 0 failed, 1 cancelled |");
  });

  it("--min-runs escalates a too-quiet instance to RED", () => {
    const idle = greenInstance();
    idle.metrics = metrics({ totalRuns: 0, failedRuns: 0 });
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, minRuns: 1, instances: [idle] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toContain("below --min-runs 1");
  });

  it("RED-sha-mismatch: all green but deployed sha != expected", () => {
    const expected = "d".repeat(40);
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, expectSha: expected, instances: [greenInstance()] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("orchestrator-b6ef5dde: loaded sha 0e35c86 != expected ddddddd");
    expect(report.body).toContain("Deployed sha: 0e35c86 (expected ddddddd)");
  });

  it("GREEN when every loaded instance and the deployed summary match the full expected sha", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, expectSha: SHA, instances: [greenInstance()] });
    expect(report.verdict).toBe("GREEN");
  });

  it("RED when selected instances resolve to different revisions", () => {
    const other = greenInstance("com.mono-agent.personal-agent-059657c8");
    other.loaded.checkoutInitial.sha = "c".repeat(40);
    other.loaded.checkoutFinal.sha = "c".repeat(40);
    other.loaded.markerInitial.marker.gitSha = "c".repeat(40);
    other.loaded.markerFinal.marker.gitSha = "c".repeat(40);
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [greenInstance(), other] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("instances span 2 deploy revisions");
  });

  it("RED when the reported deploy sha differs from the single row-proven checkout", () => {
    const report = buildFleetReport({
      date: DATE,
      deployedSha: "f".repeat(40),
      instances: [greenInstance()],
    });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("deployed sha fffffff differs from loaded checkout");
  });

  it("bogus-label: a label with no plist/dir yields a RED row, not a crash", () => {
    const bogus = { label: "com.mono-agent.bogus-does-not-exist", dir: null, service: { found: false, pid: null, lastExitStatus: null }, runtime: { ran: false }, validate: { ran: false }, memory: { ran: false }, metrics: { ran: false } };
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [bogus] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("bogus-does-not-exist: service not found");
    expect(report.table).toContain("| bogus-does-not-exist | FAIL | FAIL | FAIL | FAIL | malformed | — |");
  });

  it("RED when no instances were discovered", () => {
    const report = buildFleetReport({ date: DATE, deployedSha: SHA, instances: [] });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("no fleet instances discovered");
  });

  it("prioritizes the closed exact-fleet membership failure", () => {
    const report = buildFleetReport({
      date: DATE,
      deployedSha: SHA,
      fleetLabelError: "fleet labels mismatch (missing 1, extra 0)",
      instances: [greenInstance()],
    });
    expect(report.verdict).toBe("RED");
    expect(report.reason).toBe("fleet labels mismatch (missing 1, extra 0)");
    expect(report.body).not.toContain("/Users/example");
  });
});

describe("helpers", () => {
  it("instanceName strips the com.mono-agent. prefix", () => {
    expect(instanceName("com.mono-agent.orchestrator-b6ef5dde")).toBe("orchestrator-b6ef5dde");
    expect(instanceName("custom-label")).toBe("invalid-label");
    expect(instanceName("com.mono-agent.ok\nprivate-value")).toBe("invalid-label");
  });

  it("shortSha truncates or reports unknown", () => {
    expect(shortSha(SHA)).toBe("0e35c86");
    expect(shortSha(null)).toBe("unknown");
  });

  it("hard-kills a timeout child that ignores SIGTERM and drops all captured output", () => {
    const secret = "private-timeout-child-output";
    const childSource = [
      "process.on('SIGTERM', () => {});",
      `process.stdout.write(${JSON.stringify(secret)});`,
      `process.stderr.write(${JSON.stringify(secret)});`,
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const startedAt = Date.now();

    const result = runCommandSync(process.execPath, ["-e", childSource], { timeout: 100 });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toEqual({ status: 124, stdout: "", stderr: "", timedOut: true });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("collapses synchronously rejected hostile process arguments to a generic failure", () => {
    const secret = "private-nul-command";
    expect(runCommandSync(`/managed/node\0${secret}`, [])).toEqual({
      status: 127,
      stdout: "",
      stderr: "",
    });
  });
});

describe("runFleetGreenCheck (orchestration)", () => {
  const configPath = "/Users/example/agents/orchestrator/custom.config.json";
  const envFile = "/Users/example/agents/orchestrator/.env.production";
  const launchdPath = "/managed/node/bin:/usr/bin:/bin";
  const exactLegacyPlist = ({
    label = "com.mono-agent.orchestrator-b6ef5dde",
    dir = "/Users/example/agents/orchestrator",
    programArguments = [NODE, CLI, "start", "--foreground", "--config", configPath, "--env-file", envFile],
  } = {}) => JSON.stringify({
    Label: label,
    WorkingDirectory: dir,
    ProgramArguments: programArguments,
    EnvironmentVariables: { PATH: launchdPath },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    StandardOutPath: `/Users/example/.mono-agent/logs/${label}.out.log`,
    StandardErrorPath: `/Users/example/.mono-agent/logs/${label}.err.log`,
    ThrottleInterval: 10,
    ProcessType: "Interactive",
  });
  const plistJson = exactLegacyPlist();
  const metricsJson = JSON.stringify({ overall: { totalRuns: 10, statusCounts: { succeeded: 10, failed: 0 }, failureKindRates: [] } });

  function fakeRunner(overrides = {}) {
    const calls = [];
    const runCommand = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "/usr/bin/plutil") return overrides.plist ?? { status: 0, stdout: plistJson, stderr: "" };
      if (command === "/bin/launchctl") {
        if (args[0] === "print") {
          return overrides.launchDefinition ?? {
            status: 0,
            stdout: launchctlPrintOutput(),
            stderr: "",
          };
        }
        return overrides.service ?? { status: 0, stdout: '{\n\t"PID" = 100;\n\t"LastExitStatus" = 0;\n};', stderr: "" };
      }
      if (command === "/usr/bin/git") {
        if (overrides.git !== undefined) return overrides.git;
        return args.includes("status")
          ? overrides.gitStatus ?? { status: 0, stdout: "", stderr: "" }
          : overrides.gitHead ?? { status: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (command === "/bin/ps") {
        return args.includes("command=")
          ? overrides.identityCommand ?? overrides.process ?? { status: 0, stdout: `${[NODE, CLI, "start", "--foreground", "--config", configPath, "--env-file", envFile].join(" ")}\n`, stderr: "" }
          : overrides.process ?? { status: 0, stdout: "Sun Jul 12 12:01:00 2026\n", stderr: "" };
      }
      if (command === "/usr/sbin/lsof") {
        if (args.includes("txt")) {
          return overrides.identityExecutable ?? {
            status: 0,
            stdout: `p100\nftxt\nD0x1000012\ni${NODE_INODE}\nn${NODE}\n`,
            stderr: "",
          };
        }
        return overrides.identityCwd ?? { status: 0, stdout: "p100\nfcwd\nn/Users/example/agents/orchestrator\n", stderr: "" };
      }
      if (command === NODE && args[0]?.endsWith("build-provenance-probe.mjs")) {
        return overrides.marker ?? {
          status: 0,
          stdout: `${JSON.stringify({ schemaVersion: 2, status: "ok", marker: buildMarker(), fingerprint: BUILD_FINGERPRINT, outputDigest: OUTPUT_DIGEST, dependencyDigest: DEPENDENCY_DIGEST })}\n`,
          stderr: "",
        };
      }
      if (command === NODE && args[0]?.endsWith("managed-runtime-attestation-probe.mjs")) {
        return overrides.runtimeAttestation ?? {
          status: 0,
          stdout: `${JSON.stringify({ schemaVersion: 1, status: "ok", fingerprint: "9".repeat(64), installedAt: RUNTIME_INSTALLED_AT })}\n`,
          stderr: "",
        };
      }
      if (command === NODE && args[0] === "-p") return overrides.runtime ?? { status: 0, stdout: '{"node":"24.15.0","abi":"137"}\n', stderr: "" };
      if (command === NODE && args.includes("validate")) return overrides.validate ?? { status: 0, stdout: '{"ok":true}\n', stderr: "" };
      if (command === NODE && args.includes("memory")) return overrides.memory ?? { status: 0, stdout: `${strictMemoryJson("healthy")}\n`, stderr: "" };
      if (command === NODE && args[1] === "runs" && args[2] === "report") return overrides.metrics ?? { status: 0, stdout: metricsJson, stderr: "" };
      if (command === "gh") return overrides.gh ?? { status: 0, stdout: "https://github.com/comment/1\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
    return { calls, runCommand };
  }

  it("rejects an unknown argument without retaining private or multiline input", async () => {
    const secret = "SYNTHETIC_PRIVATE_ARG";
    const { calls, runCommand } = fakeRunner();
    const out = sink();
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: [`--bad\n${secret}`],
      stdout: out,
      stderr: err,
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(err.text).toContain("Unknown argument.");
    expect(`${out.text}${err.text}`).not.toContain(secret);
    expect(`${out.text}${err.text}`).not.toContain("--bad");
    expect(calls).toEqual([]);
  });

  it("binds a hardened cached runtime to the explicit deploy checkout", async () => {
    const runtimeCli = "/Users/example/.mono-agent/runtimes/agent-app/0.9.2/runtime/node_modules/@mono-agent/agent-app/dist/cli.js";
    const workerArguments = [
      NODE,
      runtimeCli,
      "start",
      "--foreground",
      "--config",
      configPath,
      "--env-file",
      envFile,
      "--expected-background-snapshot",
      "approved_snapshot",
      "--expected-managed-runtime-launch",
      "runtime_proof",
    ];
    const managedPlist = JSON.stringify({
      Label: "com.mono-agent.orchestrator-b6ef5dde",
      WorkingDirectory: "/Users/example/agents/orchestrator",
      ProgramArguments: [
        "/usr/bin/env",
        "-i",
        "HOME=/Users/example",
        "MONO_AGENT_MANAGED_WORKER=1",
        `PATH=${launchdPath}`,
        ...workerArguments,
      ],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      StandardOutPath: "/Users/example/.mono-agent/logs/com.mono-agent.orchestrator-b6ef5dde.out.log",
      StandardErrorPath: "/Users/example/.mono-agent/logs/com.mono-agent.orchestrator-b6ef5dde.err.log",
      ThrottleInterval: 10,
      ProcessType: "Interactive",
    });
    const launchdProgramArguments = JSON.parse(managedPlist).ProgramArguments;
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: managedPlist, stderr: "" },
      identityCommand: { status: 0, stdout: `${workerArguments.join(" ")}\n`, stderr: "" },
      launchDefinition: {
        status: 0,
        stdout: launchctlPrintOutput({ programArguments: launchdProgramArguments }),
        stderr: "",
      },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--repo", "/deploy/mono-agent"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(out.text).toContain("VERDICT: GREEN 2026-07-07 sha 0e35c86");
    expect(calls.filter((call) => call.command === "/usr/bin/git")
      .every((call) => call.args[1] === "/deploy/mono-agent")).toBe(true);
    expect(calls.find((call) => call.command === NODE && call.args.includes("validate"))?.args[0])
      .toBe(runtimeCli);
    const managedProbeEnvironment = { HOME: "/Users/example", PATH: launchdPath };
    expect(calls
      .filter((call) => call.command === NODE)
      .every((call) => JSON.stringify(call.options.environment) === JSON.stringify(managedProbeEnvironment)))
      .toBe(true);
    expect(calls.filter((call) => call.command === NODE
      && call.args[0]?.endsWith("managed-runtime-attestation-probe.mjs"))).toHaveLength(2);

    const mismatched = fakeRunner({
      plist: { status: 0, stdout: managedPlist, stderr: "" },
      launchDefinition: {
        status: 0,
        stdout: launchctlPrintOutput({ programArguments: launchdProgramArguments }),
        stderr: "",
      },
      identityExecutable: {
        status: 0,
        stdout: `p100\nftxt\nD0x1000012\ni999999\nn${NODE}\n`,
        stderr: "",
      },
    });
    const mismatchedOut = sink();
    const mismatchedResult = await runFleetGreenCheck({
      argv: ["--dry-run", "--repo", "/deploy/mono-agent"],
      stdout: mismatchedOut,
      stderr: sink(),
      runCommand: mismatched.runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(mismatchedResult.exitCode).toBe(1);
    expect(mismatchedOut.text).toContain("process executable does not match plist");
  });

  it("fails an arbitrary managed cache path when read-only runtime attestation rejects it", async () => {
    const runtimeCli = "/attacker/stale-cache/node_modules/@mono-agent/agent-app/dist/cli.js";
    const launchdProgramArguments = [
      "/usr/bin/env",
      "-i",
      "HOME=/Users/example",
      "MONO_AGENT_MANAGED_WORKER=1",
      `PATH=${launchdPath}`,
      NODE,
      runtimeCli,
      "start",
      "--foreground",
      "--config",
      configPath,
      "--expected-background-snapshot",
      "approved_snapshot",
      "--expected-managed-runtime-launch",
      "runtime_proof",
    ];
    const managedPlist = JSON.stringify({
      Label: "com.mono-agent.orchestrator-b6ef5dde",
      ProgramArguments: launchdProgramArguments,
      WorkingDirectory: "/Users/example/agents/orchestrator",
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      StandardOutPath: "/Users/example/.mono-agent/logs/com.mono-agent.orchestrator-b6ef5dde.out.log",
      StandardErrorPath: "/Users/example/.mono-agent/logs/com.mono-agent.orchestrator-b6ef5dde.err.log",
      ThrottleInterval: 10,
      ProcessType: "Interactive",
    });
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: managedPlist, stderr: "" },
      runtimeAttestation: { status: 1, stdout: '{"schemaVersion":1,"status":"unsafe"}\n', stderr: "private cache details" },
      launchDefinition: { status: 0, stdout: launchctlPrintOutput({ programArguments: launchdProgramArguments }), stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--repo", "/deploy/mono-agent"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("managed runtime attestation failed");
    expect(out.text).not.toContain("attacker");
    expect(calls.some((call) => call.command === NODE && call.args[0] === runtimeCli)).toBe(false);
  });

  it("fails when launchd's loaded definition differs from the persisted accepted plist", async () => {
    const { runCommand } = fakeRunner({
      launchDefinition: {
        status: 0,
        stdout: launchctlPrintOutput({ programArguments: [NODE, CLI, "start", "--foreground", "--config", "/private/stale.json"] }),
        stderr: "",
      },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("loaded launch definition unavailable");
    expect(out.text).not.toContain("stale.json");
  });

  it("--dry-run prints the verdict and never invokes gh (read-only)", async () => {
    const { calls, runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    expect(out.text).toContain("VERDICT: GREEN 2026-07-07 sha 0e35c86");
    expect(calls.some((c) => c.command === "gh")).toBe(false);
    expect(calls.every((call) => Number.isInteger(call.options?.timeout) && call.options.timeout > 0)).toBe(true);
    const systemEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    expect(calls.filter((call) => call.command === "/usr/bin/plutil")).toHaveLength(2);
    expect(calls.filter((call) => call.command === "/bin/launchctl")).toHaveLength(5);
    expect(calls
      .filter((call) => call.command === "/usr/bin/plutil" || call.command === "/bin/launchctl")
      .every((call) => JSON.stringify(call.options.environment) === JSON.stringify(systemEnvironment)))
      .toBe(true);
    // Strictly read-only against the fleet: every runtime/CLI probe uses the
    // exact plist Node/config/env-file, and the only cli.js subcommands are allowlisted reads.
    expect(calls.some((c) => c.command === "node")).toBe(false);
    const runtimeAndCliCalls = calls.filter((call) => call.command === NODE);
    expect(runtimeAndCliCalls).toHaveLength(6);
    expect(runtimeAndCliCalls.every((call) => call.options.environment?.PATH === launchdPath)).toBe(true);
    expect(calls.find((c) => c.command === NODE && c.args[0] === "-p")?.args).toEqual([
      "-p",
      "JSON.stringify({node:process.versions.node,abi:process.versions.modules})",
    ]);
    const markerProbeCalls = calls.filter((c) => c.command === NODE && c.args[0]?.endsWith("build-provenance-probe.mjs"));
    expect(markerProbeCalls).toHaveLength(2);
    expect(markerProbeCalls.every((call) => call.options.timeout === 30_000)).toBe(true);
    const processProbe = calls.find((c) => c.command === "/bin/ps" && c.args.includes("lstart="));
    expect(processProbe?.args).toEqual(["-p", "100", "-o", "lstart="]);
    expect(processProbe?.options.environment).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC0" });
    const commandProbe = calls.find((c) => c.command === "/bin/ps" && c.args.includes("command="));
    expect(commandProbe?.args).toEqual(["-ww", "-p", "100", "-o", "command="]);
    const cwdProbe = calls.find((c) => c.command === "/usr/sbin/lsof");
    expect(cwdProbe?.args).toEqual(["-a", "-p", "100", "-d", "cwd", "-Fn"]);
    const gitCalls = calls.filter((c) => c.command === "/usr/bin/git");
    expect(gitCalls).toHaveLength(9);
    expect(gitCalls.every((c) => c.options.environment.PATH === "/usr/bin:/bin")).toBe(true);
    const cliSubcommands = calls
      .filter((c) => c.command === NODE && c.args[0] === CLI)
      .map((c) => c.args[1]);
    expect(cliSubcommands.length).toBeGreaterThan(0);
    expect(new Set(cliSubcommands)).toEqual(new Set(["validate", "memory", "runs"]));
    expect(calls.find((c) => c.command === NODE && c.args.includes("validate"))?.args).toEqual([
      CLI, "validate", "--json", "--config", configPath, "--env-file", envFile,
    ]);
    expect(calls.find((c) => c.command === NODE && c.args.includes("memory"))?.args).toEqual([
      CLI, "memory", "audit", "--strict", "--json", "--config", configPath, "--env-file", envFile,
    ]);
    expect(calls.find((c) => c.command === NODE && c.args[1] === "runs" && c.args[2] === "report")?.args).toEqual([
      CLI,
      "runs",
      "report",
      "--since",
      "2026-07-06T12:00:00.000Z",
      "--json",
      "--config",
      configPath,
      "--env-file",
      envFile,
    ]);
  });

  it("reports multiple deploy checkouts without leaking either absolute path", async () => {
    const secondDir = "/Users/example/private-second-agent";
    const secondConfigPath = `${secondDir}/custom.config.json`;
    const secondLabel = deriveLaunchdLabel(secondConfigPath);
    const secondCli = "/Users/example/private-second-checkout/packages/agent-app/dist/cli.js";
    const secondArguments = [NODE, secondCli, "start", "--foreground", "--config", secondConfigPath, "--env-file", envFile];
    const secondPlist = exactLegacyPlist({ label: secondLabel, dir: secondDir, programArguments: secondArguments });
    const base = fakeRunner();
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil" && args.at(-1).includes(secondLabel)) {
        return { status: 0, stdout: secondPlist, stderr: "" };
      }
      if (command === "/bin/launchctl" && args[1] === secondLabel) {
        return { status: 0, stdout: '{\n\t"PID" = 200;\n\t"LastExitStatus" = 0;\n};', stderr: "" };
      }
      if (command === "/bin/launchctl" && args[0] === "print" && args[1].endsWith(secondLabel)) {
        return { status: 0, stdout: launchctlPrintOutput({ label: secondLabel, pid: 200, programArguments: secondArguments, cwd: secondDir }), stderr: "" };
      }
      if (command === "/bin/ps" && args.includes("200")) {
        return args.includes("command=")
          ? { status: 0, stdout: `${secondArguments.join(" ")}\n`, stderr: "" }
          : { status: 0, stdout: "Sun Jul 12 12:01:00 2026\n", stderr: "" };
      }
      if (command === "/usr/sbin/lsof" && args.includes("200")) {
        if (args.includes("txt")) return fakeExecutableLsof(200);
        return { status: 0, stdout: `p200\nfcwd\nn${secondDir}\n`, stderr: "" };
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => [
        "com.mono-agent.orchestrator-b6ef5dde.plist",
        `${secondLabel}.plist`,
      ],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    expect(out.text).toContain("instances span 2 deploy checkouts");
    expect(out.text).not.toContain("private-second-checkout");
    expect(out.text).not.toContain(secondDir);
    const markerCalls = base.calls.filter((call) => call.command === NODE && call.args[0]?.endsWith("build-provenance-probe.mjs"));
    expect(markerCalls).toHaveLength(4);
    expect(markerCalls.filter((call) => call.args[1] === "/Users/example/mono-agent")).toHaveLength(2);
    expect(markerCalls.filter((call) => call.args[1] === "/Users/example/private-second-checkout")).toHaveLength(2);
  });

  it("runs one initial and one final marker probe for instances sharing an exact deploy identity", async () => {
    const secondDir = "/Users/example/agents/personal-agent";
    const secondConfigPath = `${secondDir}/custom.config.json`;
    const secondLabel = deriveLaunchdLabel(secondConfigPath);
    const secondArguments = [NODE, CLI, "start", "--foreground", "--config", secondConfigPath, "--env-file", envFile];
    const secondPlist = exactLegacyPlist({ label: secondLabel, dir: secondDir, programArguments: secondArguments });
    const base = fakeRunner();
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil" && args.at(-1).includes(secondLabel)) {
        return { status: 0, stdout: secondPlist, stderr: "" };
      }
      if (command === "/bin/launchctl" && args[1] === secondLabel) {
        return { status: 0, stdout: '{\n\t"PID" = 200;\n\t"LastExitStatus" = 0;\n};', stderr: "" };
      }
      if (command === "/bin/launchctl" && args[0] === "print" && args[1].endsWith(secondLabel)) {
        return { status: 0, stdout: launchctlPrintOutput({ label: secondLabel, pid: 200, programArguments: secondArguments, cwd: secondDir }), stderr: "" };
      }
      if (command === "/bin/ps" && args.includes("200")) {
        return args.includes("command=")
          ? { status: 0, stdout: `${secondArguments.join(" ")}\n`, stderr: "" }
          : { status: 0, stdout: "Sun Jul 12 12:01:00 2026\n", stderr: "" };
      }
      if (command === "/usr/sbin/lsof" && args.includes("200")) {
        if (args.includes("txt")) return fakeExecutableLsof(200);
        return { status: 0, stdout: `p200\nfcwd\nn${secondDir}\n`, stderr: "" };
      }
      return base.runCommand(command, args, options);
    };
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: sink(),
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => [
        "com.mono-agent.orchestrator-b6ef5dde.plist",
        `${secondLabel}.plist`,
      ],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    const markerCalls = base.calls.filter((call) => call.command === NODE && call.args[0]?.endsWith("build-provenance-probe.mjs"));
    expect(markerCalls).toHaveLength(2);
    expect(markerCalls.every((call) => call.args[1] === "/Users/example/mono-agent" && call.options.environment?.PATH === launchdPath)).toBe(true);
  });

  it("catches a shared deployment mutation after row work with one terminal marker probe", async () => {
    const secondDir = "/Users/example/agents/personal-agent";
    const secondConfigPath = `${secondDir}/custom.config.json`;
    const secondLabel = deriveLaunchdLabel(secondConfigPath);
    const secondArguments = [NODE, CLI, "start", "--foreground", "--config", secondConfigPath, "--env-file", envFile];
    const secondPlist = exactLegacyPlist({ label: secondLabel, dir: secondDir, programArguments: secondArguments });
    const base = fakeRunner();
    let firstRowWorkComplete = false;
    let markerCalls = 0;
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil" && args.at(-1).includes(secondLabel)) {
        return { status: 0, stdout: secondPlist, stderr: "" };
      }
      if (command === "/bin/launchctl" && args[0] === "print" && args[1].endsWith(secondLabel)) {
        return { status: 0, stdout: launchctlPrintOutput({ label: secondLabel, pid: 200, programArguments: secondArguments, cwd: secondDir }), stderr: "" };
      }
      if (command === "/bin/launchctl" && args[1] === secondLabel) {
        return { status: 0, stdout: '{\n\t"PID" = 200;\n\t"LastExitStatus" = 0;\n};', stderr: "" };
      }
      if (command === "/bin/ps" && args.includes("200")) {
        return args.includes("command=")
          ? { status: 0, stdout: `${secondArguments.join(" ")}\n`, stderr: "" }
          : { status: 0, stdout: "Sun Jul 12 12:01:00 2026\n", stderr: "" };
      }
      if (command === "/usr/sbin/lsof" && args.includes("200")) {
        if (args.includes("txt")) return fakeExecutableLsof(200);
        return { status: 0, stdout: `p200\nfcwd\nn${secondDir}\n`, stderr: "" };
      }
      if (command === NODE && args[1] === "runs" && args[2] === "report" && options?.cwd === "/Users/example/agents/orchestrator") {
        firstRowWorkComplete = true;
      }
      if (command === NODE && args[0]?.endsWith("build-provenance-probe.mjs")) {
        markerCalls += 1;
        if (markerCalls === 2) {
          expect(firstRowWorkComplete).toBe(true);
          return {
            status: 0,
            stdout: `${JSON.stringify({
              schemaVersion: 2,
              status: "ok",
              marker: buildMarker({ outputDigest: "f".repeat(64) }),
              fingerprint: "f".repeat(64),
              outputDigest: "f".repeat(64),
              dependencyDigest: DEPENDENCY_DIGEST,
            })}\n`,
            stderr: "",
          };
        }
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => [
        "com.mono-agent.orchestrator-b6ef5dde.plist",
        `${secondLabel}.plist`,
      ],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(markerCalls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("build changed during probe");
  });

  it.each([
    ["a clean HEAD switch after terminal provenance", (headCall) => "c".repeat(40)],
    ["a clean HEAD switch inside the final checkout read", (headCall) => headCall === 1 ? SHA : "c".repeat(40)],
  ])("fails closed on %s", async (_case, finalHead) => {
    const base = fakeRunner();
    let markerCalls = 0;
    let terminalMarkerComplete = false;
    let finalHeadCalls = 0;
    const runCommand = (command, args, options) => {
      if (command === NODE && args[0]?.endsWith("build-provenance-probe.mjs")) {
        markerCalls += 1;
        const result = base.runCommand(command, args, options);
        if (markerCalls === 2) terminalMarkerComplete = true;
        return result;
      }
      if (command === "/usr/bin/git" && args.includes("rev-parse") && terminalMarkerComplete) {
        finalHeadCalls += 1;
        return { status: 0, stdout: `${finalHead(finalHeadCalls)}\n`, stderr: "" };
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(markerCalls).toBe(2);
    expect(finalHeadCalls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("checkout changed during probe");
  });

  it.each([
    [
      "missing",
      "com.mono-agent.orchestrator-b6ef5dde,com.mono-agent.personal-agent-059657c8",
      ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      "fleet labels mismatch (missing 1, extra 0)",
    ],
    [
      "extra hostile filename",
      "com.mono-agent.orchestrator-b6ef5dde",
      ["com.mono-agent.orchestrator-b6ef5dde.plist", "com.mono-agent.bad\nSYNTHETIC_PRIVATE_LABEL.plist"],
      "fleet labels mismatch (missing 0, extra 1)",
    ],
    [
      "non-colliding invalid placeholder",
      "com.mono-agent.orchestrator-b6ef5dde",
      [
        "com.mono-agent.orchestrator-b6ef5dde.plist",
        "com.mono-agent.invalid-plist-1.plist",
        "com.mono-agent.bad\nSYNTHETIC_PRIVATE_LABEL.plist",
      ],
      "fleet labels mismatch (missing 0, extra 2)",
    ],
  ])("fails a %s exact fleet set without retaining label input", async (_case, expectedLabels, entries, expectedReason) => {
    const { runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--expect-labels", expectedLabels],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => entries,
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain(expectedReason);
    expect(out.text).not.toContain("SYNTHETIC_PRIVATE_LABEL");
  });

  it("rejects a plist Label that differs from its canonical filename without leaking it", async () => {
    const secret = "SYNTHETIC_PRIVATE_PLIST_LABEL";
    const hostile = JSON.stringify({
      ...JSON.parse(plistJson),
      Label: `com.mono-agent.other\n${secret}`,
    });
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: hostile, stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(out.text).not.toContain(secret);
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it("rejects a filename Label that is not derived from the persisted config path", async () => {
    const mismatchedConfigPath = "/Users/example/agents/other/custom.config.json";
    const hostile = exactLegacyPlist({
      programArguments: [NODE, CLI, "start", "--foreground", "--config", mismatchedConfigPath],
    });
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: hostile, stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it("rejects unsafe launchd path metadata before converting or executing the plist", async () => {
    const { calls, runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--repo", "/deploy/mono-agent"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: () => null,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(calls.some((call) => call.command === "/usr/bin/plutil")).toBe(false);
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it("rejects launchd plist identity replacement across one conversion", async () => {
    const { calls, runCommand } = fakeRunner();
    let plistInspections = 0;
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--repo", "/deploy/mono-agent"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: (path, kind) => kind === "directory"
        ? `directory:${path}`
        : `plist:${path}:${plistInspections += 1}`,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(calls.filter((call) => call.command === "/usr/bin/plutil")).toHaveLength(1);
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it("fails closed when the per-checkout marker is missing", async () => {
    const { runCommand } = fakeRunner({
      marker: { status: 1, stdout: '{"schemaVersion":2,"status":"missing"}\n', stderr: "private marker path" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("orchestrator-b6ef5dde: build marker missing");
    expect(out.text).not.toContain("private marker path");
  });

  it.each([
    [
      "atomic replacement",
      {
        status: 0,
        stdout: JSON.stringify({
          ...JSON.parse(plistJson),
          WorkingDirectory: "/private/replaced-agent",
        }),
        stderr: "",
      },
      "launchd plist changed during probe",
    ],
    ["removal", { status: 1, stdout: "", stderr: "private missing plist path" }, "launchd plist changed during probe"],
    ["malformed replacement", { status: 0, stdout: "{private malformed bytes", stderr: "" }, "launchd plist changed during probe"],
    ["timed-out replacement", { status: 124, stdout: "private timeout bytes", stderr: "", timedOut: true }, "plist recheck timed out"],
  ])("fails closed when the persisted plist undergoes %s after discovery", async (_case, finalPlist, expected) => {
    const secret = "private";
    const base = fakeRunner();
    let plistCalls = 0;
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil") {
        plistCalls += 1;
        return plistCalls === 1
          ? { status: 0, stdout: plistJson, stderr: "" }
          : finalPlist;
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: err,
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(plistCalls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain(expected);
    expect(`${out.text}${err.text}`).not.toContain(secret);
    expect(`${out.text}${err.text}`).not.toContain("replaced-agent");
  });

  it("fails closed when the managed plist topology changes during probing", async () => {
    const { runCommand } = fakeRunner();
    let reads = 0;
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => {
        reads += 1;
        return reads === 1
          ? ["com.mono-agent.orchestrator-b6ef5dde.plist"]
          : ["com.mono-agent.orchestrator-b6ef5dde.plist", "com.mono-agent.private-added.plist"];
      },
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("fleet plist topology changed during probe");
    expect(out.text).not.toContain("private-added");
  });

  it("catches a pid restart during persisted-plist proof and leaves launchctl as the final external probe", async () => {
    const base = fakeRunner();
    const operations = [];
    let listCalls = 0;
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil") {
        operations.push("plist");
      }
      if (command === "/bin/launchctl") {
        operations.push("launchctl");
        if (args[0] === "list") {
          listCalls += 1;
          const pid = listCalls === 1 ? 100 : 101;
          return { status: 0, stdout: `{\n\t"PID" = ${pid};\n\t"LastExitStatus" = 0;\n};`, stderr: "" };
        }
        return { status: 0, stdout: launchctlPrintOutput(), stderr: "" };
      }
      if ((command === "/bin/ps" && args.includes("command=")) || command === "/usr/sbin/lsof") {
        operations.push("identity");
      }
      if (command === NODE && args[0]?.endsWith("build-provenance-probe.mjs")) {
        operations.push("marker");
      }
      if (command === "/usr/bin/git") {
        operations.push("checkout");
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => {
        operations.push("topology");
        return ["com.mono-agent.orchestrator-b6ef5dde.plist"];
      },
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("orchestrator-b6ef5dde: service changed during probe");
    const finalLaunchctl = operations.lastIndexOf("launchctl");
    expect(operations.at(-1)).toBe("launchctl");
    expect(operations.slice(finalLaunchctl + 1).filter((operation) => ["plist", "topology", "identity", "marker", "checkout"].includes(operation))).toEqual([]);
    expect(operations.lastIndexOf("plist")).toBeLessThan(operations.lastIndexOf("identity"));
    expect(operations.lastIndexOf("plist")).toBeLessThan(operations.lastIndexOf("topology"));
    expect(operations.lastIndexOf("marker")).toBeLessThan(operations.lastIndexOf("checkout"));
    expect(operations.lastIndexOf("checkout")).toBeLessThan(operations.lastIndexOf("plist"));
    expect(operations.lastIndexOf("topology")).toBeLessThan(operations.lastIndexOf("identity"));
    expect(operations.lastIndexOf("identity")).toBeLessThan(finalLaunchctl);
  });

  it("fails a launchd state race even when the pid is unchanged", async () => {
    const base = fakeRunner();
    let listCalls = 0;
    const runCommand = (command, args, options) => {
      if (command === "/bin/launchctl") {
        if (args[0] === "list") {
          listCalls += 1;
          const exit = listCalls === 1 ? 0 : 1;
          return { status: 0, stdout: `{\n\t"PID" = 100;\n\t"LastExitStatus" = ${exit};\n};`, stderr: "" };
        }
        return { status: 0, stdout: launchctlPrintOutput(), stderr: "" };
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("orchestrator-b6ef5dde: service changed during probe");
  });

  it("rechecks every service only after all fleet rows have been collected", async () => {
    const firstLabel = "com.mono-agent.orchestrator-b6ef5dde";
    const secondDir = "/Users/example/agents/personal-agent";
    const secondConfigPath = `${secondDir}/custom.config.json`;
    const secondLabel = deriveLaunchdLabel(secondConfigPath);
    const secondArguments = [NODE, CLI, "start", "--foreground", "--config", secondConfigPath, "--env-file", envFile];
    const secondPlist = exactLegacyPlist({ label: secondLabel, dir: secondDir, programArguments: secondArguments });
    const base = fakeRunner();
    let secondCollectionStarted = false;
    let firstLaunchCalls = 0;
    const launchOrder = [];
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil" && args.at(-1).includes(secondLabel)) {
        return { status: 0, stdout: secondPlist, stderr: "" };
      }
      if (command === "/bin/launchctl") {
        if (args[0] === "print") {
          const label = args[1].split("/").at(-1);
          const pid = label === secondLabel ? 200 : 100;
          const cwd = label === secondLabel ? secondDir : "/Users/example/agents/orchestrator";
          const programArguments = label === secondLabel ? secondArguments : undefined;
          return { status: 0, stdout: launchctlPrintOutput({ label, pid, cwd, programArguments }), stderr: "" };
        }
        const label = args[1];
        launchOrder.push(label);
        if (label === secondLabel) secondCollectionStarted = true;
        if (label === firstLabel) firstLaunchCalls += 1;
        const pid = label === secondLabel ? 200 : firstLaunchCalls > 1 && secondCollectionStarted ? 101 : 100;
        return { status: 0, stdout: `{\n\t"PID" = ${pid};\n\t"LastExitStatus" = 0;\n};`, stderr: "" };
      }
      if (command === "/bin/ps" && args.includes("200")) {
        return args.includes("command=")
          ? { status: 0, stdout: `${secondArguments.join(" ")}\n`, stderr: "" }
          : { status: 0, stdout: "Sun Jul 12 12:01:00 2026\n", stderr: "" };
      }
      if (command === "/usr/sbin/lsof" && args.includes("200")) {
        if (args.includes("txt")) return fakeExecutableLsof(200);
        return { status: 0, stdout: `p200\nfcwd\nn${secondDir}\n`, stderr: "" };
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => [`${firstLabel}.plist`, `${secondLabel}.plist`],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(launchOrder).toEqual([firstLabel, secondLabel, firstLabel, secondLabel]);
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("orchestrator-b6ef5dde: service changed during probe");
  });

  it.each([
    ["marker", "build changed during probe"],
    ["checkout", "checkout changed during probe"],
  ])("captures an early row's final %s only after the later row's expensive probes", async (mutation, expected) => {
    const firstLabel = "com.mono-agent.orchestrator-b6ef5dde";
    const firstRepo = "/Users/example/mono-agent";
    const secondRepo = "/Users/example/private-second-checkout";
    const secondDir = "/Users/example/agents/personal-agent";
    const secondConfigPath = `${secondDir}/custom.config.json`;
    const secondLabel = deriveLaunchdLabel(secondConfigPath);
    const secondCli = `${secondRepo}/packages/agent-app/dist/cli.js`;
    const secondArguments = [NODE, secondCli, "start", "--foreground", "--config", secondConfigPath, "--env-file", envFile];
    const secondPlist = exactLegacyPlist({ label: secondLabel, dir: secondDir, programArguments: secondArguments });
    const base = fakeRunner();
    const events = [];
    let secondExpensiveComplete = false;
    let firstMarkerCalls = 0;
    let firstHeadCalls = 0;
    const runCommand = (command, args, options) => {
      if (command === "/usr/bin/plutil" && args.at(-1).includes(secondLabel)) {
        return { status: 0, stdout: secondPlist, stderr: "" };
      }
      if (command === "/bin/launchctl") {
        const label = args[0] === "print" ? args[1].split("/").at(-1) : args[1];
        if (args[0] === "print") {
          const pid = label === secondLabel ? 200 : 100;
          const programArguments = label === secondLabel ? secondArguments : undefined;
          const cwd = label === secondLabel ? secondDir : "/Users/example/agents/orchestrator";
          return { status: 0, stdout: launchctlPrintOutput({ label, pid, programArguments, cwd }), stderr: "" };
        }
        events.push(`launch:${label}`);
        const pid = label === secondLabel ? 200 : 100;
        return { status: 0, stdout: `{\n\t"PID" = ${pid};\n\t"LastExitStatus" = 0;\n};`, stderr: "" };
      }
      if (command === NODE && args[0]?.endsWith("build-provenance-probe.mjs")) {
        const repo = args[1];
        events.push(`marker:${repo}`);
        if (repo === firstRepo) {
          firstMarkerCalls += 1;
          if (firstMarkerCalls === 2) {
            expect(secondExpensiveComplete).toBe(true);
            if (mutation === "marker") {
              return {
                status: 0,
                stdout: `${JSON.stringify({
                  schemaVersion: 2,
                  status: "ok",
                  marker: buildMarker(),
                  fingerprint: "c".repeat(64),
                  outputDigest: OUTPUT_DIGEST,
                  dependencyDigest: DEPENDENCY_DIGEST,
                })}\n`,
                stderr: "",
              };
            }
          }
        }
        return base.runCommand(command, args, options);
      }
      if (command === "/usr/bin/git") {
        const repo = args[1];
        if (args.includes("rev-parse")) {
          events.push(`head:${repo}`);
          if (repo === firstRepo) {
            firstHeadCalls += 1;
            if (firstHeadCalls >= 5) {
              expect(secondExpensiveComplete).toBe(true);
              return {
                status: 0,
                stdout: `${mutation === "checkout" ? "c".repeat(40) : SHA}\n`,
                stderr: "",
              };
            }
          }
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === NODE && args[1] === "runs" && args[2] === "report" && options?.cwd === secondDir) {
        const result = base.runCommand(command, args, options);
        secondExpensiveComplete = true;
        events.push("second-expensive-complete");
        return result;
      }
      if (command === "/bin/ps" && args.includes("200")) {
        if (args.includes("command=")) events.push("identity:second");
        return args.includes("command=")
          ? { status: 0, stdout: `${secondArguments.join(" ")}\n`, stderr: "" }
          : { status: 0, stdout: "Sun Jul 12 12:01:00 2026\n", stderr: "" };
      }
      if (command === "/bin/ps" && args.includes("100") && args.includes("command=")) {
        events.push("identity:first");
      }
      if (command === "/usr/sbin/lsof" && args.includes("200")) {
        if (args.includes("txt")) return fakeExecutableLsof(200);
        return { status: 0, stdout: `p200\nfcwd\nn${secondDir}\n`, stderr: "" };
      }
      return base.runCommand(command, args, options);
    };
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => [`${firstLabel}.plist`, `${secondLabel}.plist`],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain(expected);
    expect(events.filter((event) => event.startsWith("marker:"))).toEqual([
      `marker:${firstRepo}`,
      `marker:${secondRepo}`,
      `marker:${firstRepo}`,
      `marker:${secondRepo}`,
    ]);
    expect(events.indexOf("second-expensive-complete")).toBeLessThan(events.lastIndexOf(`marker:${firstRepo}`));
    expect(events.filter((event) => event.startsWith("identity:"))).toEqual([
      "identity:first",
      "identity:second",
      "identity:first",
      "identity:second",
    ]);
    expect(events.indexOf("second-expensive-complete")).toBeLessThan(events.lastIndexOf("identity:first"));
    expect(events.slice(-2)).toEqual([`launch:${firstLabel}`, `launch:${secondLabel}`]);
  });

  it.each([
    ["arguments", { identityCommand: { status: 0, stdout: "/private/stale/cli.js --secret token\n", stderr: "" } }, "process arguments do not match plist"],
    ["working directory", { identityCwd: { status: 0, stdout: "p100\nfcwd\nn/private/stale-working-directory\n", stderr: "" } }, "process working directory does not match plist"],
  ])("binds the live pid %s to the plist without retaining raw process values", async (_label, overrides, expected) => {
    const { runCommand } = fakeRunner(overrides);
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain(expected);
    expect(out.text).not.toContain("/private/stale");
    expect(out.text).not.toContain("token");
  });

  it("fails a dirty deploy checkout while retaining no status paths", async () => {
    const { runCommand } = fakeRunner({
      gitStatus: { status: 0, stdout: "?? private-token-file\n", stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("deploy checkout dirty");
    expect(out.text).not.toContain("private-token-file");
  });

  it("fails a loaded-but-stopped clean service without requiring a marker", async () => {
    const stopped = { status: 0, stdout: '{\n\t"LastExitStatus" = 0;\n};', stderr: "" };
    const { calls, runCommand } = fakeRunner({ service: stopped });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("orchestrator-b6ef5dde: not running (last exit 0)");
    expect(out.text).toContain("| orchestrator-b6ef5dde | FAIL | FAIL | FAIL |");
    expect(calls.some((call) => call.command === "/bin/ps")).toBe(false);
    expect(calls.some((call) => call.command === NODE && call.args[0]?.endsWith("build-provenance-probe.mjs"))).toBe(false);
  });

  it("rejects execution-affecting keys outside the exact managed plist producer schema", async () => {
    const managedArguments = [
      "/usr/bin/env", "-i", "HOME=/Users/example", "MONO_AGENT_MANAGED_WORKER=1", `PATH=${launchdPath}`,
      NODE, CLI, "start", "--foreground", "--config", configPath,
      "--expected-background-snapshot", "approved_snapshot",
      "--expected-managed-runtime-launch", "runtime_proof",
    ];
    const hostilePlist = JSON.stringify({
      Label: "com.mono-agent.orchestrator-b6ef5dde",
      Program: "/private/hostile-prelude",
      ProgramArguments: managedArguments,
      WorkingDirectory: "/Users/example/agents/orchestrator",
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      StandardOutPath: "/Users/example/.mono-agent/logs/com.mono-agent.orchestrator-b6ef5dde.out.log",
      StandardErrorPath: "/Users/example/.mono-agent/logs/com.mono-agent.orchestrator-b6ef5dde.err.log",
      ThrottleInterval: 10,
      ProcessType: "Interactive",
    });
    const { calls, runCommand } = fakeRunner({ plist: { status: 0, stdout: hostilePlist, stderr: "" } });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--repo", "/deploy/mono-agent"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(out.text).not.toContain("hostile-prelude");
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it.each([
    ["missing flag value", [NODE, CLI, "start", "--foreground", "--config"]],
    ["duplicate config", [NODE, CLI, "start", "--config", configPath, "--config", configPath]],
    ["hostile unknown flag", [NODE, CLI, "start", "--config", configPath, "--token", "private-plist-token"]],
  ])("fails a %s plist closed without running any CLI probe or leaking values", async (_label, programArguments) => {
    const hostilePlist = JSON.stringify({
      Label: "com.mono-agent.orchestrator-b6ef5dde",
      WorkingDirectory: "/Users/example/agents/orchestrator",
      ProgramArguments: programArguments,
      EnvironmentVariables: { PATH: launchdPath },
    });
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: hostilePlist, stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(out.text).not.toContain("private-plist-token");
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it("fails a hostile plist environment closed without running probes or leaking values", async () => {
    const secret = "private-plist-environment-value";
    const hostilePlist = JSON.stringify({
      Label: "com.mono-agent.orchestrator-b6ef5dde",
      WorkingDirectory: "/Users/example/agents/orchestrator",
      ProgramArguments: [NODE, CLI, "start", "--config", configPath],
      EnvironmentVariables: { PATH: launchdPath, PRIVATE_TOKEN: secret },
    });
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: hostilePlist, stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(out.text).not.toContain(secret);
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it.each([
    ["NUL", "\0"],
    ["tab", "\t"],
    ["newline", "\n"],
    ["DEL", "\u007f"],
  ])("fails a %s working directory closed without throwing or leaking its value", async (_label, control) => {
    const secret = "private-control-working-directory";
    const hostilePlist = JSON.stringify({
      Label: "com.mono-agent.orchestrator-b6ef5dde",
      WorkingDirectory: `/Users/example/agents/orchestrator${control}${secret}`,
      ProgramArguments: [NODE, CLI, "start", "--config", configPath],
      EnvironmentVariables: { PATH: launchdPath },
    });
    const { calls, runCommand } = fakeRunner({
      plist: { status: 0, stdout: hostilePlist, stderr: "" },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
    expect(out.text).not.toContain(secret);
    expect(calls.some((call) => call.command === NODE)).toBe(false);
  });

  it("default run posts the comment to #119 and exits on the verdict", async () => {
    const { calls, runCommand } = fakeRunner();
    const result = await runFleetGreenCheck({
      argv: [],
      stdout: sink(),
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    const gh = calls.find((c) => c.command === "gh");
    expect(gh.args.slice(0, 4)).toEqual(["issue", "comment", "119", "--repo"]);
    expect(gh.args[gh.args.length - 1]).toContain("VERDICT: GREEN");
    expect(gh.options.timeout).toBeGreaterThan(0);
  });

  it.each([
    ["plist", "plist probe timed out"],
    ["service", "service probe timed out"],
    ["marker", "build marker probe timed out"],
    ["process", "process start probe timed out"],
    ["identityCommand", "process identity probe timed out"],
    ["runtime", "runtime probe timed out"],
    ["validate", "validate command timed out"],
    ["memory", "memory audit timed out"],
    ["metrics", "metrics command timed out"],
    ["git", "checkout probe timed out"],
  ])("fails closed on a %s timeout without retaining command output", async (probe, expected) => {
    const secret = `private-${probe}-timeout-output`;
    const timedOut = { status: 124, stdout: secret, stderr: secret, timedOut: true };
    const { runCommand } = fakeRunner({ [probe]: timedOut });
    const out = sink();
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: err,
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain(expected);
    expect(`${out.text}${err.text}`).not.toContain(secret);
  });

  it("parses an exit-1 strict memory report and renders the closed degraded status", async () => {
    const { runCommand } = fakeRunner({
      memory: {
        status: 1,
        stdout: JSON.stringify(strictMemoryReport({ status: "degraded", issues: ["runtime_stale"] })),
        stderr: "provider-specific diagnostic intentionally ignored",
      },
    });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("| degraded |");
  });

  it("rejects a secret-bearing extra memory field without emitting its value", async () => {
    const secret = "ya29.should-never-appear";
    const { runCommand } = fakeRunner({
      memory: {
        status: 0,
        stdout: JSON.stringify({ ...strictMemoryReport(), diagnostic: { accessToken: secret } }),
        stderr: `provider token ${secret}`,
      },
    });
    const out = sink();
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: err,
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("| malformed |");
    expect(`${out.text}${err.text}`).not.toContain(secret);
  });

  it("fails runtime mismatch by default and accepts explicit expected runtime flags", async () => {
    const runtime = { status: 0, stdout: '{"node":"24.16.0","abi":"138"}', stderr: "" };
    const mismatch = fakeRunner({ runtime });
    const red = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: sink(),
      stderr: sink(),
      runCommand: mismatch.runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(red.exitCode).toBe(1);

    const matching = fakeRunner({
      runtime,
      marker: {
        status: 0,
        stdout: `${JSON.stringify({
          schemaVersion: 2,
          status: "ok",
          marker: buildMarker({ nodeVersion: "24.16.0", nodeAbi: "138" }),
          fingerprint: BUILD_FINGERPRINT,
          outputDigest: OUTPUT_DIGEST,
          dependencyDigest: DEPENDENCY_DIGEST,
        })}\n`,
        stderr: "",
      },
    });
    const green = await runFleetGreenCheck({
      argv: ["--dry-run", "--expect-node", "24.16.0", "--expect-abi", "138"],
      stdout: sink(),
      stderr: sink(),
      runCommand: matching.runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(green.exitCode).toBe(0);
  });

  it("fails closed on malformed/nonzero probes without echoing command output", async () => {
    const secret = "ya29.super-secret-token";
    const { runCommand } = fakeRunner({
      validate: { status: 7, stdout: secret, stderr: secret },
      memory: { status: 2, stdout: secret, stderr: secret },
      metrics: { status: 1, stdout: secret, stderr: secret },
    });
    const out = sink();
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: err,
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(`${out.text}${err.text}`).not.toContain(secret);
    expect(out.text).toContain("validate returned malformed JSON");
  });

  it("a bogus --labels override yields RED and still queries the sha, without crashing", async () => {
    const { runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run", "--labels", "com.mono-agent.bogus"],
      stdout: out,
      stderr: sink(),
      runCommand: (command, args) => {
        if (command === "/bin/launchctl") return { status: 113, stdout: "Could not find service.\n", stderr: "" };
        return runCommand(command, args);
      },
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("VERDICT: RED 2026-07-07 — bogus: service not found");
  });

  it("a prefix-matching plist that fails conversion becomes a RED row (not dropped)", async () => {
    const { runCommand } = fakeRunner();
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand: (command, args) => {
        if (command === "/usr/bin/plutil") return { status: 1, stdout: "", stderr: "corrupt.plist: JSON error\n" };
        return runCommand(command, args);
      },
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("VERDICT: RED");
    expect(out.text).toContain("plist unreadable");
  });

  it("a plist whose converted JSON is not an object becomes a RED row", async () => {
    const { runCommand } = fakeRunner({ plist: { status: 0, stdout: "null", stderr: "" } });
    const out = sink();
    const result = await runFleetGreenCheck({
      argv: ["--dry-run"],
      stdout: out,
      stderr: sink(),
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(out.text).toContain("plist unreadable");
  });

  it("surfaces a failed gh comment post as a non-zero exit", async () => {
    const { runCommand } = fakeRunner({ gh: { status: 1, stdout: "", stderr: "gh: not authenticated" } });
    const err = sink();
    const result = await runFleetGreenCheck({
      argv: [],
      stdout: sink(),
      stderr: err,
      runCommand,
      trustedNodePath: NODE,
      inspectLaunchdPath: fakeLaunchdPathInspector,
      inspectExecutablePath: fakeExecutablePathInspector,
      launchAgentsDir: "/Users/example/Library/LaunchAgents",
      readdir: () => ["com.mono-agent.orchestrator-b6ef5dde.plist"],
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(result.exitCode).toBe(1);
    expect(err.text).toContain("Failed to post comment to #119");
  });
});

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
