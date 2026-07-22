import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  LABEL_PREFIX,
  LABEL_PATTERN,
  MAX_LABEL_FOLDER_SEGMENT,
  BUILD_PROVENANCE_PROBE,
  MANAGED_RUNTIME_ATTESTATION_PROBE,
  COMMAND_TIMEOUT_MS,
  LAUNCHD_PROBE_ENV_KEYS,
  BUILD_MARKER_SHA_PATTERN,
  CLOSED_SYSTEM_ENVIRONMENT,
  CLOSED_GIT_ENVIRONMENT,
  PLUTIL,
  LAUNCHCTL,
  ENV,
  MANAGED_BACKGROUND_WORKER_ENV,
  MANAGED_BACKGROUND_ENV_NAMES,
  MANAGED_PLIST_KEYS,
} from "./constants.mjs";
import {
  parseLaunchctlList,
  deriveRepoFromCliPath,
  reduceMetrics,
  isRecord,
  parseJsonObject,
  parseBuildProvenanceProbe,
  parseManagedRuntimeAttestationProbe,
  parseProcessStart,
  parseMemoryAudit,
  hasExactKeys,
} from "./evaluate.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function managedPlistTopologyFingerprint(entries) {
  if (!Array.isArray(entries)) return null;
  const managed = entries
    .filter((entry) => typeof entry === "string" && entry.startsWith(LABEL_PREFIX) && entry.endsWith(".plist"))
    .toSorted();
  return sha256(JSON.stringify(managed));
}

export function readValidatedLaunchdPlist(plistPath, filenameLabel, runCommand, inspectPath) {
  const directoryPath = dirname(plistPath);
  const directoryInitial = inspectPath(directoryPath, "directory");
  const plistInitial = inspectPath(plistPath, "plist");
  if (directoryInitial === null || plistInitial === null) return { status: "unavailable" };
  const result = runCommand(PLUTIL, ["-convert", "json", "-o", "-", plistPath], {
    timeout: COMMAND_TIMEOUT_MS.plist,
    environment: CLOSED_SYSTEM_ENVIRONMENT,
  });
  if (result.timedOut === true) return { status: "unavailable", timedOut: true };
  if (result.status !== 0 || typeof result.stdout !== "string") return { status: "unavailable" };
  const directoryFinal = inspectPath(directoryPath, "directory");
  const plistFinal = inspectPath(plistPath, "plist");
  if (directoryFinal !== directoryInitial || plistFinal !== plistInitial) {
    return { status: "unavailable" };
  }

  const plist = parseJsonObject(result.stdout);
  if (plist === null || typeof plist.Label !== "string" || plist.Label !== filenameLabel) {
    return { status: "unavailable" };
  }
  const dir = typeof plist.WorkingDirectory === "string"
    && !/[\u0000-\u001f\u007f]/u.test(plist.WorkingDirectory)
    && isAbsolute(plist.WorkingDirectory)
    ? plist.WorkingDirectory
    : null;
  const program = parseLaunchdProgramArguments(plist.ProgramArguments);
  const managedPathEnv = program?.pathEnv;
  const pathEnv = managedPathEnv
    ?? parseLaunchdPathEnvironment(plist.EnvironmentVariables);
  if (program === null || pathEnv === null || dir === null) return { status: "unavailable" };
  if (typeof program.configPath !== "string"
    || deriveLaunchdLabel(program.configPath) !== filenameLabel) {
    return { status: "unavailable" };
  }
  // Current managed plists carry their closed environment exclusively inside
  // `/usr/bin/env -i`; accepting a second environment source would weaken the
  // exact process/environment proof.
  if (managedPathEnv !== undefined && plist.EnvironmentVariables !== undefined) {
    return { status: "unavailable" };
  }
  if (program.managed === true
    ? !isExactManagedPlist(plist, plistPath, filenameLabel)
    : !isExactLegacyPlist(plist, plistPath, filenameLabel)) {
    return { status: "unavailable" };
  }

  const closedShape = {
    label: filenameLabel,
    plistPath,
    dir,
    pathEnv,
    stdoutPath: plist.StandardOutPath,
    stderrPath: plist.StandardErrorPath,
    ...program,
  };
  return {
    status: "ok",
    fingerprint: sha256(JSON.stringify({
      converted: result.stdout,
      directoryIdentity: directoryFinal,
      plistIdentity: plistFinal,
    })),
    shapeFingerprint: sha256(JSON.stringify(closedShape)),
    entry: closedShape,
  };
}

export function inspectCanonicalLaunchdPath(path, kind) {
  try {
    const details = lstatSync(path, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : details.uid;
    const mode = Number(details.mode & 0o777n);
    if (details.uid !== currentUid || details.isSymbolicLink()) return null;
    if (kind === "directory") {
      if (!details.isDirectory() || (mode & 0o077) !== 0) return null;
    } else if (!details.isFile() || details.nlink !== 1n || mode !== 0o600) {
      return null;
    }
    return sha256(JSON.stringify({
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      mode: details.mode.toString(),
      nlink: details.nlink.toString(),
      size: details.size.toString(),
      mtimeNs: details.mtimeNs.toString(),
      ctimeNs: details.ctimeNs.toString(),
    }));
  } catch {
    return null;
  }
}

export function inspectExecutablePath(path) {
  try {
    const details = lstatSync(path, { bigint: true });
    if (!details.isFile() || details.isSymbolicLink()) return null;
    const identity = {
      device: details.dev.toString(),
      inode: details.ino.toString(),
    };
    return {
      ...identity,
      fingerprint: sha256(JSON.stringify({
        ...identity,
        mode: details.mode.toString(),
        size: details.size.toString(),
        mtimeNs: details.mtimeNs.toString(),
        ctimeNs: details.ctimeNs.toString(),
      })),
    };
  } catch {
    return null;
  }
}

export function isExactManagedPlist(plist, plistPath, label) {
  const paths = canonicalLaunchdPaths(plistPath, label);
  return hasExactKeys(plist, MANAGED_PLIST_KEYS)
    && paths !== null
    && hasExactLaunchdLifecycle(plist, paths);
}

export function isExactLegacyPlist(plist, plistPath, label) {
  const paths = canonicalLaunchdPaths(plistPath, label);
  return hasExactKeys(plist, [...MANAGED_PLIST_KEYS, "EnvironmentVariables"])
    && paths !== null
    && hasExactLaunchdLifecycle(plist, paths);
}

export function hasExactLaunchdLifecycle(plist, paths) {
  return plist.RunAtLoad === true
    && isRecord(plist.KeepAlive)
    && hasExactKeys(plist.KeepAlive, ["SuccessfulExit"])
    && plist.KeepAlive.SuccessfulExit === false
    && plist.ProcessType === "Interactive"
    && plist.ThrottleInterval === 10
    && plist.StandardOutPath === paths.stdoutPath
    && plist.StandardErrorPath === paths.stderrPath;
}

export function canonicalLaunchdPaths(plistPath, label) {
  if (typeof plistPath !== "string" || !isAbsolute(plistPath)) return null;
  const launchAgentsDir = dirname(plistPath);
  const libraryDir = dirname(launchAgentsDir);
  const home = dirname(libraryDir);
  if (basename(launchAgentsDir) !== "LaunchAgents"
    || basename(libraryDir) !== "Library"
    || plistPath !== join(home, "Library", "LaunchAgents", `${label}.plist`)) return null;
  return {
    stdoutPath: join(home, ".mono-agent", "logs", `${label}.out.log`),
    stderrPath: join(home, ".mono-agent", "logs", `${label}.err.log`),
  };
}

export function deriveLaunchdLabel(configPath) {
  const resolved = resolve(configPath);
  const folder = basename(dirname(resolved))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_LABEL_FOLDER_SEGMENT)
    .replace(/-+$/gu, "");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${LABEL_PREFIX}${folder.length === 0 ? "agent" : folder}-${hash}`;
}

// ---------------------------------------------------------------------------
// Impure layer (thin, untested-live).
// ---------------------------------------------------------------------------

export function discoverInstances(launchAgentsDir, runCommand, readdir, inspectPath) {
  const byLabel = new Map();
  let invalidLabelIndex = 0;
  let entries;
  try {
    entries = readdir(launchAgentsDir);
  } catch {
    return { byLabel, topologyFingerprint: null };
  }
  const reservedLabels = new Set(entries
    .filter((entry) => typeof entry === "string" && entry.endsWith(".plist"))
    .map((entry) => entry.slice(0, -".plist".length))
    .filter((label) => LABEL_PATTERN.test(label)));
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.startsWith(LABEL_PREFIX) || !entry.endsWith(".plist")) {
      continue;
    }
    const plistPath = join(launchAgentsDir, entry);
    const filenameLabel = entry.slice(0, -".plist".length);
    if (!LABEL_PATTERN.test(filenameLabel)) {
      let closedLabel;
      do {
        invalidLabelIndex += 1;
        closedLabel = `${LABEL_PREFIX}invalid-plist-${invalidLabelIndex}`;
      } while (reservedLabels.has(closedLabel) || byLabel.has(closedLabel));
      byLabel.set(closedLabel, {
        label: closedLabel,
        dir: null,
        nodePath: null,
        cliPath: null,
        discoveryError: "plist label invalid",
      });
      continue;
    }
    const validated = readValidatedLaunchdPlist(plistPath, filenameLabel, runCommand, inspectPath);
    if (validated.timedOut === true) {
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, nodePath: null, cliPath: null, discoveryError: "plist probe timed out" });
      continue;
    }
    if (validated.status !== "ok") {
      byLabel.set(filenameLabel, {
        label: filenameLabel,
        dir: null,
        nodePath: null,
        cliPath: null,
        probeArgs: [],
        discoveryError: "plist invalid",
      });
      continue;
    }
    byLabel.set(filenameLabel, {
      ...validated.entry,
      plistFingerprint: validated.fingerprint,
      plistShapeFingerprint: validated.shapeFingerprint,
    });
  }
  return { byLabel, topologyFingerprint: managedPlistTopologyFingerprint(entries) };
}

/**
 * Accept only the current hardened launchd shape emitted by buildPlistXml plus
 * legacy direct-Node plists. Unknown environment names, duplicate assignments,
 * unknown flags, relative paths, and missing values fail the instance closed.
 * Managed environment values are retained only for exact child-probe execution
 * and never rendered. Legacy direct-Node arguments remain whitespace-free;
 * managed arguments are compared structurally through launchctl print.
 */
export function parseLaunchdProgramArguments(value) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || /[\u0000-\u001f\u007f]/u.test(entry))) return null;

  if (value[0] === ENV) {
    return parseManagedLaunchdProgramArguments(value);
  }
  if (value.some((entry) => /\s/u.test(entry))) return null;
  const parsed = parseLaunchdWorkerInvocation(value, false);
  return parsed === null || !sameOrderedStrings(value, canonicalWorkerArguments(parsed, false)) ? null : {
    ...parsed,
    managed: false,
    launchdProgramArguments: [...value],
    programArguments: [...value],
  };
}

export function parseManagedLaunchdProgramArguments(value) {
  if (value[1] !== "-i") return null;
  const environment = new Map();
  const names = [];
  let index = 2;
  while (index < value.length && !isAbsolute(value[index])) {
    const assignment = value[index];
    const separator = assignment.indexOf("=");
    if (separator <= 0) return null;
    const name = assignment.slice(0, separator);
    const environmentValue = assignment.slice(separator + 1);
    if (!MANAGED_BACKGROUND_ENV_NAMES.has(name) || environment.has(name)) return null;
    environment.set(name, environmentValue);
    names.push(name);
    index += 1;
  }
  if (names.some((name, position) => position > 0 && compareCodeUnits(names[position - 1], name) > 0)) {
    return null;
  }
  const pathEnv = environment.get("PATH");
  if (typeof pathEnv !== "string" || pathEnv.length === 0
    || environment.get(MANAGED_BACKGROUND_WORKER_ENV) !== "1") return null;

  const workerArguments = value.slice(index);
  const parsed = parseLaunchdWorkerInvocation(workerArguments, true);
  const managedEnvironment = Object.fromEntries(environment);
  delete managedEnvironment[MANAGED_BACKGROUND_WORKER_ENV];
  return parsed === null
    || !sameOrderedStrings(workerArguments, canonicalWorkerArguments(parsed, true)) ? null : {
    ...parsed,
    // `/usr/bin/env` execs Node in place. ps therefore exposes the worker argv,
    // while the persisted plist fingerprint separately proves the wrapper.
    programArguments: workerArguments,
    launchdProgramArguments: [...value],
    managed: true,
    managedEnvironment,
    pathEnv,
  };
}

export function canonicalWorkerArguments(parsed, managed) {
  return [
    parsed.nodePath,
    parsed.cliPath,
    "start",
    "--foreground",
    "--config",
    parsed.configPath,
    ...(parsed.envFile === undefined ? [] : ["--env-file", parsed.envFile]),
    ...(managed ? ["--expected-background-snapshot", parsed.expectedBackgroundSnapshot] : []),
    ...(managed ? ["--expected-managed-runtime-launch", parsed.expectedManagedRuntimeLaunch] : []),
  ];
}

export function sameOrderedStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parseLaunchdWorkerInvocation(value, managed) {
  const [nodePath, cliPath, command, ...tail] = value;
  if (typeof nodePath !== "string" || nodePath.includes("\0") || !isAbsolute(nodePath)
    || typeof cliPath !== "string" || cliPath.includes("\0")
    || !isAbsolute(cliPath) || !cliPath.endsWith("cli.js")
    || command !== "start") {
    return null;
  }

  let foreground = false;
  let configPath;
  let envFile;
  let expectedBackgroundSnapshot;
  let expectedManagedRuntimeLaunch;
  for (let index = 0; index < tail.length; index += 1) {
    const flag = tail[index];
    if (flag === "--foreground") {
      if (foreground) return null;
      foreground = true;
      continue;
    }
    if (flag === "--expected-background-snapshot") {
      const snapshot = tail[index + 1];
      if (!managed || expectedBackgroundSnapshot !== undefined
        || typeof snapshot !== "string" || !/^[A-Za-z0-9_-]+$/u.test(snapshot)) return null;
      expectedBackgroundSnapshot = snapshot;
      index += 1;
      continue;
    }
    if (flag === "--expected-managed-runtime-launch") {
      const proof = tail[index + 1];
      if (!managed || expectedManagedRuntimeLaunch !== undefined
        || typeof proof !== "string" || !/^[A-Za-z0-9_-]+$/u.test(proof)) return null;
      expectedManagedRuntimeLaunch = proof;
      index += 1;
      continue;
    }
    if (flag !== "--config" && flag !== "--env-file") return null;
    const path = tail[index + 1];
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return null;
    index += 1;
    if (flag === "--config") {
      if (configPath !== undefined) return null;
      configPath = path;
    } else {
      if (envFile !== undefined) return null;
      envFile = path;
    }
  }
  if (managed && (!foreground
    || configPath === undefined
    || expectedBackgroundSnapshot === undefined
    || expectedManagedRuntimeLaunch === undefined)) {
    return null;
  }

  return {
    nodePath,
    cliPath,
    configPath,
    envFile,
    expectedBackgroundSnapshot,
    expectedManagedRuntimeLaunch,
    probeArgs: [
      ...(configPath === undefined ? [] : ["--config", configPath]),
      ...(envFile === undefined ? [] : ["--env-file", envFile]),
    ],
  };
}

export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Legacy direct-Node plists carry only PATH in EnvironmentVariables. */
export function parseLaunchdPathEnvironment(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["PATH"])) return null;
  return typeof value.PATH === "string" && value.PATH.length > 0 && !value.PATH.includes("\0")
    ? value.PATH
    : null;
}

export function collectInstance(
  entry,
  since,
  runCommand,
  initialMarkerProbes,
  deployRepo,
  trustedNodePath,
  inspectExecutable,
) {
  if (typeof entry.discoveryError === "string") {
    const service = launchctlList(entry.label, runCommand);
    return {
      label: entry.label,
      dir: null,
      discoveryError: entry.discoveryError,
      service,
      loaded: { ran: false },
      runtime: { ran: false },
      validate: { ran: false },
      memory: { ran: false },
      metrics: { ran: false },
    };
  }
  const service = launchctlList(entry.label, runCommand);
  const repo = repoForEntry(entry, deployRepo);
  const probeEnvironment = probeEnvironmentForEntry(entry);
  let runtime = { ran: false };
  const persistedPlist = {
    plistFingerprint: entry.plistFingerprint,
    plistShapeFingerprint: entry.plistShapeFingerprint,
    managed: entry.managed === true,
  };
  let loaded = { ran: false, ...persistedPlist };
  if (typeof service.pid === "number") {
    if (repo === null || entry.nodePath === null || probeEnvironment === null) {
      loaded = { ran: true, checkoutUnavailable: true, ...persistedPlist };
    } else {
      const checkoutInitial = readDeployCheckout(repo, runCommand);
      const launchDefinitionInitial = launchctlPrint(entry, service.pid, runCommand);
      const processStart = runProcessStartProbe(service.pid, runCommand);
      const processIdentity = runProcessIdentityProbe(
        service.pid,
        entry.programArguments,
        entry.dir,
        entry.nodePath,
        entry.managed,
        inspectExecutable,
        runCommand,
      );
      const initialExecutionBoundaryApproved = isInitialExecutionBoundaryApproved(
        entry,
        checkoutInitial,
        launchDefinitionInitial,
        processIdentity,
      );
      const markerInitial = initialExecutionBoundaryApproved
        ? runCachedBuildMarkerProbe(
            initialMarkerProbes,
            trustedNodePath,
            repo,
            probeEnvironment,
            runCommand,
          )
        : { status: "unsafe" };
      if (initialExecutionBoundaryApproved
        && isDeployExecutionApproved(checkoutInitial, markerInitial)) {
        runtime = runRuntimeProbe(entry.nodePath, probeEnvironment, runCommand);
      }
      const deployExecutionApproved = initialExecutionBoundaryApproved
        && isDeployExecutionApproved(checkoutInitial, markerInitial, runtime);
      loaded = {
        ran: true,
        ...persistedPlist,
        initialExecutionBoundaryApproved,
        markerInitial,
        ...(entry.managed === true ? {
          runtimeAttestationInitial: deployExecutionApproved
            ? runManagedRuntimeAttestation(entry, repo, runtime, probeEnvironment, trustedNodePath, runCommand)
            : { status: "unsafe" },
        } : {}),
        checkoutInitial,
        launchDefinitionInitial,
        processStart,
        processIdentity,
      };
    }
  }
  let validate = { ran: false };
  let memory = { ran: false };
  let metrics = { ran: false };
  if (entry.dir !== null
    && entry.nodePath !== null
    && entry.cliPath !== null
    && probeEnvironment !== null
    && isCliExecutionApproved(entry, loaded, runtime)) {
    const probeArgs = Array.isArray(entry.probeArgs) ? entry.probeArgs : [];
    validate = runValidate(entry.nodePath, entry.cliPath, entry.dir, probeEnvironment, probeArgs, runCommand);
    memory = runMemoryAudit(entry.nodePath, entry.cliPath, entry.dir, probeEnvironment, probeArgs, runCommand);
    metrics = runMetrics(entry.nodePath, entry.cliPath, entry.dir, probeEnvironment, probeArgs, since, runCommand);
  }
  return { label: entry.label, dir: entry.dir, service, loaded, runtime, validate, memory, metrics };
}

export function isCliExecutionApproved(entry, loaded, runtime) {
  return loaded.ran === true
    && loaded.initialExecutionBoundaryApproved === true
    && loaded.launchDefinitionInitial?.status === "ok"
    && isDeployExecutionApproved(loaded.checkoutInitial, loaded.markerInitial, runtime)
    && (entry.managed !== true || loaded.runtimeAttestationInitial?.status === "ok");
}

export function isInitialExecutionBoundaryApproved(
  entry,
  checkout,
  launchDefinition,
  processIdentity,
) {
  return checkout?.error === null
    && checkout.clean === true
    && typeof checkout.sha === "string"
    && launchDefinition?.status === "ok"
    && processIdentity?.ran === true
    && processIdentity.cwdMatches === true
    && processIdentity.executableMatches === true
    && (entry.managed === true || processIdentity.argvMatches === true);
}

export function isDeployExecutionApproved(checkout, marker, runtime) {
  return marker?.status === "ok"
    && marker.marker?.sourceState === "clean"
    && marker.outputDigest === marker.marker.outputDigest
    && marker.dependencyDigest === marker.marker.dependencyDigest
    && typeof checkout?.sha === "string"
    && checkout.error === null
    && checkout.clean === true
    && checkout.sha === marker.marker.gitSha
    && (runtime === undefined
      || (runtime.ran === true
        && runtime.node === marker.marker.nodeVersion
        && runtime.abi === marker.marker.nodeAbi));
}

export function repoForEntry(entry, deployRepo) {
  return entry.managed === true ? deployRepo : deriveRepoFromCliPath(entry.cliPath);
}

export function probeEnvironmentForEntry(entry) {
  if (entry.managed === true) {
    return isRecord(entry.managedEnvironment) ? { ...entry.managedEnvironment } : null;
  }
  return typeof entry.pathEnv === "string" ? buildLaunchdProbeEnvironment(entry.pathEnv) : null;
}

export function launchctlList(label, runCommand) {
  const result = runCommand(LAUNCHCTL, ["list", label], {
    timeout: COMMAND_TIMEOUT_MS.service,
    environment: CLOSED_SYSTEM_ENVIRONMENT,
  });
  if (result.timedOut === true) {
    return { found: false, pid: null, lastExitStatus: null, timedOut: true };
  }
  return parseLaunchctlList(result.stdout ?? "", result.status);
}

export function parseLaunchctlPrint(text, exitCode, expected) {
  if (exitCode !== 0 || typeof text !== "string" || !isRecord(expected)) {
    return { status: "unavailable" };
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const oneValue = (name) => {
    const prefix = `\t${name} = `;
    const matches = lines.filter((line) => line.startsWith(prefix));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(prefix.length);
    return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
  };
  const blockStarts = lines
    .map((line, index) => line === "\targuments = {" ? index : -1)
    .filter((index) => index >= 0);
  if (blockStarts.length !== 1) return { status: "unavailable" };
  const blockStart = blockStarts[0];
  const blockEnd = lines.indexOf("\t}", blockStart + 1);
  if (blockEnd <= blockStart + 1) return { status: "unavailable" };
  const args = lines.slice(blockStart + 1, blockEnd).map((line) =>
    line.startsWith("\t\t") ? line.slice(2) : null);
  if (args.some((arg) => typeof arg !== "string" || arg.length === 0 || /[\u0000-\u001f\u007f]/u.test(arg))) {
    return { status: "unavailable" };
  }
  const path = oneValue("path");
  const program = oneValue("program");
  const workingDirectory = oneValue("working directory");
  const stdoutPath = oneValue("stdout path");
  const stderrPath = oneValue("stderr path");
  const pidText = oneValue("pid");
  const pid = typeof pidText === "string" && /^\d+$/u.test(pidText) ? Number(pidText) : Number.NaN;
  if (path !== expected.plistPath
    || program !== expected.launchdProgramArguments?.[0]
    || workingDirectory !== expected.dir
    || stdoutPath !== expected.stdoutPath
    || stderrPath !== expected.stderrPath
    || !Number.isSafeInteger(pid)
    || pid !== expected.pid
    || !Array.isArray(expected.launchdProgramArguments)
    || args.length !== expected.launchdProgramArguments.length
    || args.some((arg, index) => arg !== expected.launchdProgramArguments[index])) {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    fingerprint: sha256(JSON.stringify({ path, program, args, workingDirectory, stdoutPath, stderrPath, pid })),
  };
}

export function launchctlPrint(entry, pid, runCommand) {
  const result = runCommand(LAUNCHCTL, ["print", `gui/${typeof process.getuid === "function" ? process.getuid() : ""}/${entry.label}`], {
    timeout: COMMAND_TIMEOUT_MS.service,
    environment: CLOSED_SYSTEM_ENVIRONMENT,
  });
  if (result.timedOut === true) return { status: "unavailable", timedOut: true };
  return parseLaunchctlPrint(result.stdout ?? "", result.status, {
    plistPath: entry.plistPath,
    launchdProgramArguments: entry.launchdProgramArguments,
    dir: entry.dir,
    stdoutPath: entry.stdoutPath,
    stderrPath: entry.stderrPath,
    pid,
  });
}

export function runBuildMarkerProbe(nodePath, repo, probeEnvironment, runCommand) {
  const result = runCommand(nodePath, [BUILD_PROVENANCE_PROBE, repo], {
    timeout: COMMAND_TIMEOUT_MS.loaded,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return Object.freeze({ status: "malformed", timedOut: true });
  }
  const parsed = parseBuildProvenanceProbe(result.stdout ?? "", result.status);
  return Object.freeze({
    ...parsed,
    ...(isRecord(parsed.marker) ? { marker: Object.freeze({ ...parsed.marker }) } : {}),
  });
}

export function runCachedBuildMarkerProbe(cache, nodePath, repo, probeEnvironment, runCommand) {
  const key = JSON.stringify([nodePath, repo, sha256(JSON.stringify(probeEnvironment))]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const probe = runBuildMarkerProbe(nodePath, repo, probeEnvironment, runCommand);
  cache.set(key, probe);
  return probe;
}

export function runManagedRuntimeAttestation(entry, repo, runtime, probeEnvironment, trustedNodePath, runCommand) {
  if (entry.managed !== true
    || runtime?.ran !== true
    || typeof entry.configPath !== "string"
    || typeof entry.expectedBackgroundSnapshot !== "string") {
    return { status: "unsafe" };
  }
  const result = runCommand(trustedNodePath, [
    MANAGED_RUNTIME_ATTESTATION_PROBE,
    repo,
    entry.cliPath,
    entry.dir,
    entry.configPath,
    entry.envFile ?? "",
    entry.expectedBackgroundSnapshot,
    runtime.abi,
  ], {
    cwd: repo,
    timeout: COMMAND_TIMEOUT_MS.attestation,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) return { status: "malformed", timedOut: true };
  return parseManagedRuntimeAttestationProbe(result.stdout ?? "", result.status);
}

export function runProcessStartProbe(pid, runCommand) {
  const result = runCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: COMMAND_TIMEOUT_MS.process,
    environment: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC0" },
  });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  return parseProcessStart(result.stdout ?? "", result.status);
}

export function runProcessIdentityProbe(
  pid,
  expectedArguments,
  expectedCwd,
  expectedNodePath,
  managed,
  inspectExecutable,
  runCommand,
) {
  if (!Array.isArray(expectedArguments) || typeof expectedCwd !== "string") {
    return { ran: false };
  }
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const command = managed === true ? null : runCommand("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      timeout: COMMAND_TIMEOUT_MS.process,
      environment,
    });
  const cwd = runCommand("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    timeout: COMMAND_TIMEOUT_MS.process,
    environment,
  });
  const expectedExecutableInitial = inspectExecutable(expectedNodePath);
  const executable = runCommand("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-FfDin"], {
    timeout: COMMAND_TIMEOUT_MS.process,
    environment,
  });
  if (command?.timedOut === true || cwd.timedOut === true || executable.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  const actualCwd = parseLsofCwd(cwd.stdout ?? "", cwd.status, pid);
  if (actualCwd === null) {
    return { ran: false };
  }
  const expectedExecutableFinal = inspectExecutable(expectedNodePath);
  const actualExecutable = parseLsofExecutable(
    executable.stdout ?? "",
    executable.status,
    pid,
    expectedNodePath,
  );
  if (expectedExecutableInitial === null
    || expectedExecutableFinal === null
    || expectedExecutableInitial.fingerprint !== expectedExecutableFinal.fingerprint
    || actualExecutable === null) return { ran: false };
  const executableMatches = actualExecutable.device === expectedExecutableFinal.device
    && actualExecutable.inode === expectedExecutableFinal.inode;
  if (managed === true) {
    return {
      ran: true,
      executableMatches,
      cwdMatches: actualCwd === expectedCwd,
    };
  }
  const actualCommand = parseExactSingleLine(command?.stdout ?? "", command?.status);
  if (actualCommand === null) return { ran: false };
  return {
    ran: true,
    argvMatches: actualCommand === expectedArguments.join(" "),
    executableMatches,
    cwdMatches: actualCwd === expectedCwd,
  };
}

export function parseLsofExecutable(text, exitCode, pid, expectedPath) {
  if (exitCode !== 0 || typeof text !== "string") return null;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines[0] !== `p${pid}`) return null;
  const matches = [];
  for (let index = 1; index < lines.length;) {
    if (lines[index] !== "ftxt") return null;
    const device = lines[index + 1];
    const inode = lines[index + 2];
    const name = lines[index + 3];
    if (!/^D0x[0-9a-f]+$/u.test(device ?? "")
      || !/^i\d+$/u.test(inode ?? "")
      || typeof name !== "string"
      || !name.startsWith("n")
      || /[\r\0]/u.test(name)) return null;
    if (name.slice(1) === expectedPath) {
      matches.push({
        device: BigInt(device.slice(1)).toString(),
        inode: inode.slice(1),
      });
    }
    index += 4;
  }
  return matches.length === 1 ? matches[0] : null;
}

export function parseExactSingleLine(text, exitCode) {
  if (exitCode !== 0 || typeof text !== "string") return null;
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  return value.length > 0 && !/[\r\n\0]/u.test(value) ? value : null;
}

export function parseLsofCwd(text, exitCode, pid) {
  if (exitCode !== 0 || typeof text !== "string") return null;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== 3 || lines[0] !== `p${pid}` || lines[1] !== "fcwd"
    || !lines[2].startsWith("n") || lines[2].length < 2 || /[\r\0]/u.test(lines[2])) {
    return null;
  }
  return lines[2].slice(1);
}

export function runRuntimeProbe(nodePath, probeEnvironment, runCommand) {
  const result = runCommand(nodePath, [
    "-p",
    "JSON.stringify({node:process.versions.node,abi:process.versions.modules})",
  ], { timeout: COMMAND_TIMEOUT_MS.runtime, environment: probeEnvironment });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  if (result.status !== 0) {
    return { ran: false };
  }
  const parsed = parseJsonObject(result.stdout ?? "");
  if (parsed === null || typeof parsed.node !== "string" || !/^\d+\.\d+\.\d+$/u.test(parsed.node)
    || typeof parsed.abi !== "string" || !/^\d+$/u.test(parsed.abi)) {
    return { ran: false };
  }
  return { ran: true, node: parsed.node, abi: parsed.abi };
}

export function runValidate(nodePath, cliPath, dir, probeEnvironment, probeArgs, runCommand) {
  const result = runCommand(nodePath, [cliPath, "validate", "--json", ...probeArgs], {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS.validate,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  const parsed = parseJsonObject(result.stdout ?? "");
  if (parsed === null || typeof parsed.ok !== "boolean") {
    return { ran: true, exitCode: result.status, validJson: false };
  }
  return { ran: true, exitCode: result.status, validJson: true, ok: parsed.ok };
}

export function runMemoryAudit(nodePath, cliPath, dir, probeEnvironment, probeArgs, runCommand) {
  const result = runCommand(nodePath, [cliPath, "memory", "audit", "--strict", "--json", ...probeArgs], {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS.memory,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  return parseMemoryAudit(result.stdout ?? "", result.status);
}

export function runMetrics(nodePath, cliPath, dir, probeEnvironment, probeArgs, since, runCommand) {
  const result = runCommand(nodePath, [cliPath, "runs", "report", "--since", since, "--json", ...probeArgs], {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS.metrics,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return { ran: false, error: "metrics command timed out" };
  }
  if (result.status !== 0) {
    return { ran: false, error: "metrics command failed" };
  }
  try {
    return reduceMetrics(JSON.parse(result.stdout));
  } catch {
    return { ran: false, error: "metrics JSON malformed" };
  }
}

export function resolveDeployRepo(discovered, override) {
  if (typeof override === "string" && override.length > 0) {
    return { repo: resolve(override), warning: null };
  }
  const repos = new Set();
  for (const entry of discovered.values()) {
    const repo = deriveRepoFromCliPath(entry.cliPath);
    if (repo !== null) {
      repos.add(repo);
    }
  }
  if (repos.size === 0) {
    return { repo: null, warning: "no deploy checkout derivable from plists" };
  }
  const [first] = repos;
  return { repo: first, warning: repos.size > 1 ? `instances span ${repos.size} deploy checkouts` : null };
}

export function readDeployCheckout(repo, runCommand) {
  if (repo === null) {
    return { sha: null, clean: false, error: null };
  }
  const headInitial = runCommand("/usr/bin/git", ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "HEAD"], {
    timeout: COMMAND_TIMEOUT_MS.git,
    environment: CLOSED_GIT_ENVIRONMENT,
  });
  const status = runCommand("/usr/bin/git", [
    "-C",
    repo,
    "-c",
    "core.fsmonitor=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ], {
    timeout: COMMAND_TIMEOUT_MS.git,
    environment: CLOSED_GIT_ENVIRONMENT,
  });
  const headFinal = runCommand("/usr/bin/git", ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "HEAD"], {
    timeout: COMMAND_TIMEOUT_MS.git,
    environment: CLOSED_GIT_ENVIRONMENT,
  });
  if (headInitial.timedOut === true || status.timedOut === true || headFinal.timedOut === true) {
    return { sha: null, clean: false, error: "checkout probe timed out" };
  }
  const initialSha = headInitial.status === 0 ? (headInitial.stdout ?? "").trim() : "";
  const finalSha = headFinal.status === 0 ? (headFinal.stdout ?? "").trim() : "";
  if (!BUILD_MARKER_SHA_PATTERN.test(initialSha)
    || !BUILD_MARKER_SHA_PATTERN.test(finalSha)
    || status.status !== 0
    || typeof status.stdout !== "string") {
    return { sha: null, clean: false, error: "checkout probe unavailable" };
  }
  if (initialSha !== finalSha) {
    return { sha: null, clean: false, error: "checkout changed during probe" };
  }
  return { sha: finalSha, clean: status.stdout.length === 0, error: null };
}

export function runCommandSync(command, args, options = {}) {
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: options.environment ?? (typeof options.pathEnv === "string"
        ? buildLaunchdProbeEnvironment(options.pathEnv)
        : process.env),
      timeout: options.timeout,
      killSignal: "SIGKILL",
    });
  } catch {
    // Invalid/hostile argv or cwd values must become a generic closed probe
    // failure, never a thrown diagnostic that can echo the input.
    return { status: 127, stdout: "", stderr: "" };
  }
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut) {
    return { status: 124, stdout: "", stderr: "", timedOut: true };
  }
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

/**
 * Recreate the legacy non-secret user-launchd baseline needed by Node and filesystem
 * probes. Current managed plists instead pass their exact parsed environment.
 * In particular, never inherit shell-only MONO_AGENT_* overrides,
 * provider credentials, NODE_OPTIONS, proxy variables, or credential-store
 * selectors that are absent from the managed plist. The CLI loads the exact
 * plist --env-file itself.
 */
export function buildLaunchdProbeEnvironment(pathEnv, ambientEnv = process.env) {
  const environment = { PATH: pathEnv };
  for (const key of LAUNCHD_PROBE_ENV_KEYS) {
    const value = ambientEnv[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  return environment;
}
