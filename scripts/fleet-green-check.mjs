#!/usr/bin/env node
// Daily fleet green-check tracker for the v1 window (goal #168, epic #119).
//
// Read-only health probe of the live launchd mono-agent fleet. Its ONLY side
// effect is one dated checkpoint comment on issue #119 (skipped with --dry-run).
// It never restarts an instance, writes a config, or touches an artifact dir.
//
// Per instance it checks six things and surfaces a compact markdown table:
//   service   — `launchctl list <label>`: every selected job must have a pid.
//   loaded    — a running pid must have started after this checkout's atomic,
//               clean, sha/runtime-bound build marker; the marker, checkout,
//               and launchd pid are re-read to close deploy/restart races.
//   runtime   — the exact plist Node executable reports the expected version + ABI.
//   validate  — exact plist Node + cli.js `validate --json`, exit 0 = pass.
//   memory    — exact plist Node + cli.js `memory audit --strict --json`:
//               healthy passes, in_progress warns, not_configured skips, and
//               every degraded/unhealthy/unknown/malformed result fails.
//   runs-24h  — deployed `cli.js runs report --since <24h-ago> --json` (cwd = dir):
//               surfaces run/failure counts and FAILS on any failure kind other
//               than a transient provider_unavailable failover (#136's expected
//               resilience-evidence kind), on an unclassified failure, or when
//               even a tolerated kind dominates the window (all runs failed, or
//               >50% over >=5 runs) — so a single failover in 110 runs reads
//               GREEN but 48-of-48 provider_auth reads RED. Cancelled runs are
//               lifecycle outcomes (surfaced in the note, never RED). Zero runs
//               is a non-RED "idle?" warning. `--strict-runs` fails on ANY
//               failed run; `--min-runs <n>` fails a too-quiet instance.
//
// Each probe retains and uses the exact Node + cli.js invocation, including the
// hardened `/usr/bin/env -i` wrapper emitted by current managed LaunchAgents,
// the service's exact absolute --config/--env-file values, and its complete
// allowlisted operational environment. Neither the ambient `node`, a cli.js inferred from this checkout,
// cwd-default configuration, nor the checker's ambient PATH is proof of the
// launchd runtime. With --expect-sha every selected process, checkout, and build
// marker must match that full sha exactly. Loaded-code proof is mandatory for
// every selected service.
//
// Verdict: `VERDICT: GREEN <date> sha <short>` or `VERDICT: RED <date> — <reason>`.
// Exits non-zero on RED so a wrapper can alert. No comment posted = not a green
// day; the 7-consecutive-day counter is human-audited from the dated comments.

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMAND_TIMEOUT_MS,
  DEFAULT_EXPECT_ABI,
  DEFAULT_EXPECT_NODE,
  ISSUE_NUMBER,
  REPO,
} from "./fleet-green-check/constants.mjs";
import {
  buildFleetReport,
  evaluateExpectedLabels,
  parseArgs,
} from "./fleet-green-check/evaluate.mjs";
import {
  collectInstance,
  discoverInstances,
  inspectCanonicalLaunchdPath,
  inspectExecutablePath,
  launchctlList,
  launchctlPrint,
  managedPlistTopologyFingerprint,
  probeEnvironmentForEntry,
  readDeployCheckout,
  readValidatedLaunchdPlist,
  repoForEntry,
  resolveDeployRepo,
  runCachedBuildMarkerProbe,
  runCommandSync,
  runManagedRuntimeAttestation,
  runProcessIdentityProbe,
} from "./fleet-green-check/probes.mjs";

export { MANAGED_BACKGROUND_ENV_NAMES } from "./fleet-green-check/constants.mjs";
export {
  buildFleetReport,
  deriveRepoFromCliPath,
  evaluateExpectedLabels,
  evaluateLoaded,
  evaluateMemory,
  evaluateRuntime,
  evaluateRuns,
  instanceName,
  parseArgs,
  parseBuildProvenanceProbe,
  parseLaunchctlList,
  parseManagedRuntimeAttestationProbe,
  parseMemoryAudit,
  parseProcessStart,
  reduceMetrics,
  shortSha,
} from "./fleet-green-check/evaluate.mjs";
export {
  buildLaunchdProbeEnvironment,
  deriveLaunchdLabel,
  inspectCanonicalLaunchdPath,
  parseLaunchctlPrint,
  parseLaunchdPathEnvironment,
  parseLaunchdProgramArguments,
  runCommandSync,
} from "./fleet-green-check/probes.mjs";

export async function runFleetGreenCheck(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandSync;
  const launchAgentsDir = options.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const readdir = options.readdir ?? readdirSync;
  const inspectLaunchdPath = options.inspectLaunchdPath ?? inspectCanonicalLaunchdPath;
  const inspectExecutable = options.inspectExecutablePath ?? inspectExecutablePath;
  const trustedNodePath = options.trustedNodePath ?? process.execPath;
  const now = options.now ?? new Date();

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    return { exitCode: 1 };
  }
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  const discovery = discoverInstances(launchAgentsDir, runCommand, readdir, inspectLaunchdPath);
  const discovered = discovery.byLabel;
  const selectedLabels = args.labels ?? args.expectLabels ?? [...discovered.keys()];
  const initialFleetLabelError = evaluateExpectedLabels(discovered.keys(), args.expectLabels);
  const { repo: deployRepo, warning: repoWarning } = resolveDeployRepo(discovered, args.repo);
  const deployed = readDeployCheckout(deployRepo, runCommand);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const date = now.toISOString().slice(0, 10);
  const initialMarkerProbes = new Map();

  const selected = selectedLabels.map((label) => {
    const entry = discovered.get(label) ?? { label, dir: null, nodePath: null, cliPath: null };
    return {
      entry,
      instance: collectInstance(
        entry,
        since,
        runCommand,
        initialMarkerProbes,
        deployRepo,
        trustedNodePath,
        inspectExecutable,
      ),
    };
  });
  const instances = selected.map(({ instance }) => instance);
  // Keep the rows that can participate in the provenance and terminal
  // launchd/process bracket. No cached worker CLI is invoked unless the
  // initial managed attestation already approved it in collectInstance.
  const provenanceSelections = [];
  for (const { entry, instance } of selected) {
    if (instance.loaded.ran !== true
      || instance.loaded.initialExecutionBoundaryApproved !== true
      || instance.loaded.checkoutUnavailable === true
      || typeof instance.service.pid !== "number"
      || entry.nodePath === null
      || probeEnvironmentForEntry(entry) === null) {
      continue;
    }
    const repo = repoForEntry(entry, deployRepo);
    if (repo === null) continue;
    const probeEnvironment = probeEnvironmentForEntry(entry);
    if (probeEnvironment === null) continue;
    provenanceSelections.push({ entry, instance, repo, probeEnvironment });
  }

  // Complete the expensive source/runtime proof before the terminal launchd
  // bracket so a deploy cannot hide inside a long attestation window.
  const finalMarkerProbes = new Map();
  for (const { entry, instance, repo, probeEnvironment } of provenanceSelections) {
    if (entry.managed === true) {
      instance.loaded.runtimeAttestationFinal = runManagedRuntimeAttestation(
        entry,
        repo,
        instance.runtime,
        probeEnvironment,
        trustedNodePath,
        runCommand,
      );
    }
    instance.loaded.markerFinal = runCachedBuildMarkerProbe(
      finalMarkerProbes,
      trustedNodePath,
      repo,
      probeEnvironment,
      runCommand,
    );
  }

  // Bind every instance to the checkout state observed after terminal build
  // provenance. Each read brackets status with HEAD to reject an internal
  // checkout switch, while remaining independent across instances.
  for (const { instance, repo } of provenanceSelections) {
    instance.loaded.checkoutFinal = readDeployCheckout(repo, runCommand);
  }

  // Terminal bracket: loaded definition A -> persisted plist/topology -> loaded
  // definition B -> actual executable/cwd -> service pid. After the final
  // service read no filesystem or process observation is allowed.
  for (const { entry, instance } of provenanceSelections) {
    instance.loaded.launchDefinitionFinal = launchctlPrint(entry, instance.service.pid, runCommand);
  }
  for (const { entry, instance } of selected) {
    if (typeof entry.plistFingerprint !== "string" || typeof entry.plistShapeFingerprint !== "string") continue;
    const rechecked = readValidatedLaunchdPlist(
      join(launchAgentsDir, `${entry.label}.plist`),
      entry.label,
      runCommand,
      inspectLaunchdPath,
    );
    instance.loaded.plistRecheck = rechecked.status === "ok"
      ? {
          status: "ok",
          fingerprint: rechecked.fingerprint,
          shapeFingerprint: rechecked.shapeFingerprint,
        }
      : { status: "unavailable", ...(rechecked.timedOut === true ? { timedOut: true } : {}) };
  }
  let finalTopologyFingerprint = null;
  try {
    finalTopologyFingerprint = managedPlistTopologyFingerprint(readdir(launchAgentsDir));
  } catch {
    // Closed below without retaining filesystem details.
  }
  const topologyError = discovery.topologyFingerprint === null || finalTopologyFingerprint === null
    ? "fleet plist topology unavailable"
    : discovery.topologyFingerprint === finalTopologyFingerprint
      ? null
      : "fleet plist topology changed during probe";
  const fleetLabelError = initialFleetLabelError ?? topologyError;

  for (const { entry, instance } of provenanceSelections) {
    instance.loaded.launchDefinitionTerminal = launchctlPrint(entry, instance.service.pid, runCommand);
    instance.loaded.processIdentity = runProcessIdentityProbe(
      instance.service.pid,
      entry.programArguments,
      entry.dir,
      entry.nodePath,
      entry.managed,
      inspectExecutable,
      runCommand,
    );
  }
  for (const instance of instances) {
    instance.loaded.serviceRecheck = launchctlList(instance.label, runCommand);
  }

  const report = buildFleetReport({
    date,
    deployedSha: deployed.sha,
    ...(deployed.error === null ? {} : { deployedShaError: deployed.error }),
    ...(fleetLabelError === null ? {} : { fleetLabelError }),
    expectSha: args.expectSha,
    expectNode: args.expectNode,
    expectAbi: args.expectAbi,
    strictRuns: args.strictRuns,
    ...(args.minRuns === undefined ? {} : { minRuns: args.minRuns }),
    instances,
  });

  let body = report.body;
  if (repoWarning !== null) {
    body = `${body}\n\n> note: ${repoWarning}`;
  }

  stdout.write(`${body}\n`);

  if (!args.dryRun) {
    const result = runCommand("gh", ["issue", "comment", ISSUE_NUMBER, "--repo", REPO, "--body", body], {
      timeout: COMMAND_TIMEOUT_MS.github,
    });
    if (result.status !== 0) {
      stderr.write(`Failed to post comment to #${ISSUE_NUMBER}.\n`);
      return { exitCode: report.exitCode === 0 ? 1 : report.exitCode };
    }
    stdout.write(`Posted checkpoint to #${ISSUE_NUMBER}.\n`);
  }

  return { exitCode: report.exitCode };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/fleet-green-check.mjs [--dry-run] [--labels <csv>] [--expect-labels <csv>]",
    "                                     [--expect-sha <sha>]",
    "                                     [--expect-node <version>] [--expect-abi <abi>]",
    "                                     [--strict-runs] [--min-runs <n>] [--repo <path>]",
    "",
    "Read-only daily green-check of the launchd mono-agent fleet. Prints a markdown",
    "table + verdict; without --dry-run also posts it as a comment to issue #119.",
    "Dates and the 24h runs window are UTC-anchored. Exits non-zero on RED.",
    "",
    "Runs-24h drives RED on any failure kind other than a transient",
    "provider_unavailable failover, on an unclassified failure, or when even a",
    "tolerated kind dominates (all runs failed, or >50% over >=5 runs). Zero runs",
    "is a non-RED 'idle?' warning.",
    "",
    "  --dry-run       Print only; do not post the GitHub comment.",
    "  --labels <csv>  Check these launchd labels instead of auto-discovering plists",
    "                  (a bogus label yields a RED row — used to simulate RED).",
    "  --expect-labels  Require the discovered fleet and checked labels to match this",
    "                  exact duplicate-free CSV set; missing/extra labels drive RED.",
    "  --expect-sha    Require a full sha matched by every checkout and loaded build.",
    `  --expect-node   Require each plist Node to report this version (default ${DEFAULT_EXPECT_NODE}).`,
    `  --expect-abi    Require each plist Node to report this modules ABI (default ${DEFAULT_EXPECT_ABI}).`,
    "  --strict-runs   Fail runs-24h on ANY failed run, not just untolerated ones.",
    "  --min-runs <n>  Fail an instance with fewer than n runs in the window.",
    "  --repo <path>   Pin the deploy checkout used for build/sha provenance; required",
    "                  when managed plists execute a copied runtime outside Git.",
  ].join("\n");
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runFleetGreenCheck();
  process.exitCode = result.exitCode;
}
