// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import type { CommandRunner } from "./command.js";
import type { ServiceMacosServiceConfig } from "./config.js";
import {
  canonicalLocalArchiveDependencySpec,
  isCanonicalSha512Integrity,
  isExactDependencyVersion,
  isLocalArchiveDependencySpec,
} from "./dependency.js";
import { loadProtectedEnvironment } from "./environment.js";
import { ServiceMacosDriftError } from "./errors.js";
import {
  digest,
  isErrno,
  isRecord,
  processIsAlive,
} from "./internal-fs.js";
import { readServiceInput } from "./input.js";
import {
  assertServiceLogRetention,
  preflightServiceLogs,
  readServiceReadiness,
  resetServiceLogs,
} from "./logs.js";
import {
  assertOwnedDirectory,
  assertOwnedDirectoryCurrent,
  boundedLaunchctlOutput,
  inspectTarget,
  readInstalledActivation,
  runLaunchctlCommand,
} from "./observe.js";
import type {
  ServiceMacosRuntimePaths,
  ServiceMacosTarget,
} from "./plist.js";
import type {
  ServiceMacosPlanEntry,
  ServiceMacosRemovalPlanEntry,
  ServicePlanBinding,
  ServiceValidators,
} from "./service-types.js";
import {
  removeServicePlistTransaction,
  replaceServicePlistTransaction,
  type ServiceMacosTransactionLifecycle,
} from "./transactions.js";

export async function createServiceBinding(
  service: ServiceMacosServiceConfig,
  runtime: ServiceMacosRuntimePaths,
  validators: ServiceValidators,
): Promise<ServicePlanBinding> {
  const environment = service.environmentFile === undefined
    ? undefined
    : await loadProtectedEnvironment(service.environmentFile, runtime.uid);
  const mergedEnvironment = environment?.values
    ?? Object.freeze(Object.create(null) as Record<string, string>);
  if (service.target.kind === "agent") {
    const validation = await validators.validateAgent(
      service.target.config,
      { environment: mergedEnvironment },
    );
    if (!validation.ok) {
      throw new Error(
        `Agent config ${service.target.config} is invalid: `
        + validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      );
    }
  } else {
    const validation = await validators.validateWeb(
      service.target.config,
      { environment: mergedEnvironment },
    );
    if (validation.sourcePath !== service.target.config) {
      throw new Error(
        `Web config ${service.target.config} did not resolve from its exact `
        + "planned path.",
      );
    }
  }
  const root = dirname(service.target.config);
  const targetSource = await readServiceInput(
    service.target.config,
    1_048_576,
  );
  const packagePath = join(root, "package.json");
  const packageSource = await readServiceInput(packagePath, 8_388_608);
  const directDependencyName = service.target.kind === "agent"
    ? "@mono-agent/core"
    : "@mono-agent/web";
  const lock = await readFirstLockfile(root);
  const directDependencyVersion = await readBoundDirectDependencyVersion(
    packageSource.source,
    packagePath,
    directDependencyName,
    root,
    lock,
  );
  const [nodeSource, runnerSource] = await Promise.all([
    readServiceInput(runtime.nodePath, 268_435_456),
    readServiceInput(runtime.runnerScriptPath, 8_388_608),
  ]);
  return Object.freeze({
    targetConfig: service.target.config,
    targetKind: service.target.kind,
    targetConfigDigest: targetSource.digest,
    directDependencyName,
    directDependencyVersion,
    packageManifestDigest: packageSource.digest,
    lockfilePath: lock.path,
    lockfileDigest: lock.source.digest,
    nodePath: runtime.nodePath,
    nodeDigest: nodeSource.digest,
    runnerScriptPath: runtime.runnerScriptPath,
    runnerScriptDigest: runnerSource.digest,
    logsDirectoryIdentity: await assertOwnedDirectory(
      service.logs.directory,
      runtime.uid,
    ),
    ...(service.environmentFile === undefined || environment === undefined
      ? {}
      : {
        environmentFile: service.environmentFile,
        environmentFileDigest: digest(environment.source),
      }),
  });
}

export async function assertBindingCurrent(
  entry: ServiceMacosPlanEntry,
  validators: ServiceValidators,
  runtime: ServiceMacosRuntimePaths,
): Promise<void> {
  const current = await createServiceBinding(entry.service, runtime, validators);
  if (JSON.stringify(current) !== JSON.stringify(entry.binding)) {
    throw new ServiceMacosDriftError(
      `Validated target closure changed for ${entry.serviceId}.`,
    );
  }
  await assertServiceLogRetention(
    boundLogs(
      entry.target,
      entry.service,
      current.logsDirectoryIdentity,
    ),
    runtime.uid,
  );
}

export async function promoteAndActivate(
  entry: ServiceMacosPlanEntry,
  runner: CommandRunner,
  expectedParentIdentity: string,
  expectedUid: number,
): Promise<void> {
  const serviceLifecycle = transactionLifecycle(
    entry.target,
    entry.service,
    entry.binding.logsDirectoryIdentity,
    expectedParentIdentity,
    expectedUid,
    runner,
  );
  await serviceLifecycle.preflight();
  await replaceServicePlistTransaction({
    target: entry.target,
    expectedUid,
    expectedParentIdentity,
    expectedFile: entry.observed.file,
    expectedLoaded: entry.observed.loaded,
    desiredPlist: entry.desiredPlist,
    desiredDigest: entry.desiredDigest,
    readinessToken: entry.readinessToken,
    lifecycle: serviceLifecycle,
  });
}

export async function activateExisting(
  entry: ServiceMacosPlanEntry,
  runner: CommandRunner,
  expectedParentIdentity: string,
  expectedUid: number,
  restart: boolean,
): Promise<void> {
  const serviceLifecycle = transactionLifecycle(
    entry.target,
    entry.service,
    entry.binding.logsDirectoryIdentity,
    expectedParentIdentity,
    expectedUid,
    runner,
  );
  await serviceLifecycle.preflight();
  try {
    if (restart) await serviceLifecycle.bootoutIfPresent();
    await serviceLifecycle.bootstrap();
    await serviceLifecycle.proveReady(entry.readinessToken);
  } catch (error) {
    await serviceLifecycle.bootoutIfPresent().catch(() => undefined);
    throw error;
  }
}

export async function removeAndDisable(
  entry: ServiceMacosRemovalPlanEntry,
  service: ServiceMacosServiceConfig,
  runner: CommandRunner,
  expectedParentIdentity: string,
  expectedUid: number,
): Promise<void> {
  await removeServicePlistTransaction({
    target: entry.target,
    expectedUid,
    expectedParentIdentity,
    expectedFile: entry.observed.file,
    expectedLoaded: entry.observed.loaded,
    lifecycle: transactionLifecycle(
      entry.target,
      service,
      undefined,
      expectedParentIdentity,
      expectedUid,
      runner,
    ),
  });
}

export function transactionLifecycle(
  target: ServiceMacosTarget,
  service: ServiceMacosServiceConfig,
  expectedDirectoryIdentity: string | undefined,
  expectedParentIdentity: string,
  expectedUid: number,
  runner: CommandRunner,
): ServiceMacosTransactionLifecycle {
  const parent = async () => {
    await assertOwnedDirectoryCurrent(
      dirname(target.plistPath),
      expectedUid,
      expectedParentIdentity,
    );
  };
  const logs = async () => {
    const directoryIdentity = await assertOwnedDirectory(
      service.logs.directory,
      expectedUid,
    );
    if (
      expectedDirectoryIdentity !== undefined
      && directoryIdentity !== expectedDirectoryIdentity
    ) {
      throw new ServiceMacosDriftError(
        `Log directory changed for ${target.serviceId}.`,
      );
    }
    return boundLogs(target, service, directoryIdentity);
  };
  const bootstrap = async (forceStart: boolean): Promise<void> => {
    await parent();
    await resetServiceLogs(await logs(), expectedUid);
    await parent();
    await launchctl(
      runner,
      ["bootstrap", target.launchdDomain, target.plistPath],
    );
    await parent();
    if (forceStart || !service.startAtLogin) {
      await launchctl(runner, ["kickstart", target.launchdTarget]);
    }
    await parent();
  };
  const bootstrapRestored = async (): Promise<void> => {
    await parent();
    const installed = await readInstalledActivation(target, expectedUid);
    await resetServiceLogs(installed.activation.logs, expectedUid);
    await parent();
    await launchctl(
      runner,
      ["bootstrap", target.launchdDomain, target.plistPath],
    );
    await parent();
    await launchctl(runner, ["kickstart", target.launchdTarget]);
    await parent();
  };
  return Object.freeze({
    async preflight(): Promise<void> {
      await parent();
      await preflightServiceLogs(await logs(), expectedUid);
      await parent();
    },
    async inspectLoaded(): Promise<boolean> {
      await parent();
      const result = await runLaunchctlCommand(
        runner,
        ["print", target.launchdTarget],
      );
      await parent();
      if (
        result.exitCode !== 0
        && result.exitCode !== 3
        && result.exitCode !== 113
      ) {
        throw new Error(
          `launchctl print ${target.launchdTarget} failed `
          + `(${String(result.exitCode)}): `
          + boundedLaunchctlOutput(result.stderr),
        );
      }
      return result.exitCode === 0;
    },
    async bootoutRequired(): Promise<void> {
      await parent();
      await stopService(runner, target.launchdTarget, true);
      await parent();
    },
    async bootoutIfPresent(): Promise<void> {
      await parent();
      await bootoutIfPresent(runner, target.launchdTarget);
      await parent();
    },
    async bootstrap(): Promise<void> {
      await bootstrap(false);
    },
    async bootstrapRestored(): Promise<void> {
      await bootstrapRestored();
    },
    async proveReady(readinessToken: string): Promise<void> {
      await parent();
      await proveServiceReady(
        target,
        await logs(),
        readinessToken,
        expectedUid,
        runner,
      );
      await parent();
    },
    async proveInstalledReady(): Promise<void> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const observation = await inspectTarget(
          target,
          expectedUid,
          runner,
          undefined,
          expectedParentIdentity,
        );
        if (
          observation.launchdState === "running"
          && observation.ready
        ) {
          return;
        }
        if (observation.launchdState === "exited") {
          throw new ServiceMacosDriftError(
            `Restored service ${target.serviceId} exited before readiness.`,
          );
        }
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, 100);
        });
      }
      throw new ServiceMacosDriftError(
        `Restored service ${target.serviceId} did not prove readiness.`,
      );
    },
  });
}

export function boundLogs(
  target: ServiceMacosTarget,
  service: ServiceMacosServiceConfig,
  directoryIdentity: string,
) {
  return Object.freeze({
    ...service.logs,
    directoryIdentity,
    stdoutPath: target.stdoutPath,
    stderrPath: target.stderrPath,
    readinessPath: target.readinessPath,
  });
}

async function proveServiceReady(
  target: ServiceMacosTarget,
  logs: Parameters<typeof readServiceReadiness>[0],
  readinessToken: string,
  expectedUid: number,
  runner: CommandRunner,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runLaunchctlCommand(
      runner,
      ["print", target.launchdTarget],
    );
    if (result.exitCode === 0) {
      const state =
        /^\s*state = ([^\r\n]+)$/mu.exec(result.stdout)?.[1]?.trim();
      const pidText =
        /^\s*pid = ([0-9]+)$/mu.exec(result.stdout)?.[1];
      const pid = pidText === undefined ? 0 : Number(pidText);
      if (state === "running" && Number.isSafeInteger(pid) && pid > 0) {
        if (
          await readServiceReadiness(
            logs,
            readinessToken,
            pid,
            expectedUid,
          )
        ) {
          return;
        }
      } else if (
        state === "exited"
        || /^\s*last exit code = [1-9][0-9]*$/mu.test(result.stdout)
      ) {
        throw new ServiceMacosDriftError(
          `Service ${target.serviceId} exited before readiness.`,
        );
      }
    } else if (result.exitCode === 3 || result.exitCode === 113) {
      if (attempt >= 2) {
        throw new ServiceMacosDriftError(
          `Activation did not retain loaded state for ${target.serviceId}.`,
        );
      }
    } else {
      throw new Error(
        `launchctl print ${target.launchdTarget} failed `
        + `(${String(result.exitCode)}): `
        + boundedLaunchctlOutput(result.stderr),
      );
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new ServiceMacosDriftError(
    `Service ${target.serviceId} did not prove healthy planned-input readiness.`,
  );
}

async function launchctl(
  runner: CommandRunner,
  arguments_: readonly string[],
): Promise<void> {
  const result = await runLaunchctlCommand(runner, arguments_);
  if (result.exitCode !== 0) {
    throw new Error(
      `launchctl ${arguments_.join(" ")} failed `
      + `(${String(result.exitCode)}): `
      + boundedLaunchctlOutput(result.stderr),
    );
  }
}

async function bootoutIfPresent(
  runner: CommandRunner,
  target: string,
): Promise<void> {
  await stopService(runner, target, false);
}

async function stopService(
  runner: CommandRunner,
  target: string,
  required: boolean,
): Promise<void> {
  const before = await runLaunchctlCommand(runner, ["print", target]);
  if (before.exitCode === 3 || before.exitCode === 113) {
    if (required) {
      throw new ServiceMacosDriftError(
        `Required service ${target} was not loaded before stop.`,
      );
    }
    return;
  }
  if (before.exitCode !== 0) {
    throw new Error(
      `launchctl print ${target} failed (${String(before.exitCode)}): `
      + boundedLaunchctlOutput(before.stderr),
    );
  }
  const state =
    /^\s*state = ([^\r\n]+)$/mu.exec(before.stdout)?.[1]?.trim();
  const pidValue =
    /^\s*pid = ([^\r\n]+)$/mu.exec(before.stdout)?.[1]?.trim();
  const pid = pidValue === undefined ? undefined : Number(pidValue);
  if (
    (
      state !== "running"
      && state !== "exited"
      && state !== "waiting"
      && state !== "not running"
    )
    || (
      pidValue !== undefined
      && (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0)
    )
    || (state === "running" && pid === undefined)
  ) {
    throw new ServiceMacosDriftError(
      `Cannot prove prior process identity for ${target} from launchd state `
      + `${state ?? "missing"}.`,
    );
  }
  await launchctl(runner, ["bootout", target]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runLaunchctlCommand(runner, ["print", target]);
    if (
      (result.exitCode === 3 || result.exitCode === 113)
      && (pid === undefined || !processIsAlive(pid))
    ) {
      return;
    }
    if (
      result.exitCode !== 0
      && result.exitCode !== 3
      && result.exitCode !== 113
    ) {
      throw new Error(
        `launchctl print ${target} failed (${String(result.exitCode)}): `
        + boundedLaunchctlOutput(result.stderr),
      );
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new ServiceMacosDriftError(
    `Service ${target} did not prove unload and process death.`,
  );
}

async function readFirstLockfile(
  root: string,
): Promise<ProtectedLockfile> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json"] as const) {
    const path = join(root, name);
    try {
      return {
        path,
        source: await readServiceInput(path, 67_108_864),
      };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  throw new Error(
    `${root} must contain pnpm-lock.yaml or package-lock.json.`,
  );
}

interface ProtectedLockfile {
  readonly path: string;
  readonly source: Awaited<ReturnType<typeof readServiceInput>>;
}

async function readBoundDirectDependencyVersion(
  source: Uint8Array,
  packagePath: string,
  dependencyName: "@mono-agent/core" | "@mono-agent/web",
  projectRoot: string,
  lock: ProtectedLockfile,
): Promise<string> {
  const dependencySpec = readDirectDependencySpec(
    source,
    packagePath,
    dependencyName,
  );
  if (isExactDependencyVersion(dependencySpec)) {
    return dependencySpec;
  }
  if (basename(lock.path) !== "package-lock.json") {
    throw new Error(
      `${packagePath} local archive dependency ${dependencyName} requires package-lock.json.`,
    );
  }
  const lockJson = parseJsonObject(
    lock.source.source,
    lock.path,
  );
  const packages = isRecord(lockJson.packages) ? lockJson.packages : undefined;
  const root = packages !== undefined && isRecord(packages[""])
    ? packages[""]
    : undefined;
  const rootDependencies = root !== undefined && isRecord(root.dependencies)
    ? root.dependencies
    : undefined;
  const installedCandidate =
    packages?.[`node_modules/${dependencyName}`];
  const installed = isRecord(installedCandidate)
    ? installedCandidate
    : undefined;
  if (
    rootDependencies?.[dependencyName] !== dependencySpec
    || installed === undefined
    || !isExactDependencyVersion(installed.version)
    || !isLocalArchiveDependencySpec(installed.resolved)
    || canonicalLocalArchiveDependencySpec(installed.resolved)
      !== canonicalLocalArchiveDependencySpec(dependencySpec)
    || !isCanonicalSha512Integrity(installed.integrity)
    || installed.link === true
  ) {
    throw new Error(
      `${lock.path} must bind ${dependencyName} to its exact local archive, installed version, and SHA-512 integrity.`,
    );
  }

  const packageRoot = join(
    projectRoot,
    "node_modules",
    ...dependencyName.split("/"),
  );
  const [projectRealPath, packageRealPath, packageStats] = await Promise.all([
    realpath(projectRoot),
    realpath(packageRoot),
    lstat(packageRoot),
  ]);
  const packageRelativePath = relative(projectRealPath, packageRealPath);
  if (
    !packageStats.isDirectory()
    || packageStats.isSymbolicLink()
    || packageRelativePath.length === 0
    || packageRelativePath === ".."
    || packageRelativePath.startsWith("../")
    || packageRelativePath.startsWith("..\\")
    || isAbsolute(packageRelativePath)
  ) {
    throw new Error(
      `${packageRoot} must be a real project-contained package directory.`,
    );
  }
  const installedManifestPath = join(packageRoot, "package.json");
  const installedManifestSource = await readServiceInput(
    installedManifestPath,
    8_388_608,
  );
  const installedManifest = parseJsonObject(
    installedManifestSource.source,
    installedManifestPath,
  );
  if (
    installedManifest.name !== dependencyName
    || installedManifest.version !== installed.version
  ) {
    throw new Error(
      `${installedManifestPath} must match the locked ${dependencyName}@${installed.version}.`,
    );
  }
  return installed.version;
}

function readDirectDependencySpec(
  source: Uint8Array,
  packagePath: string,
  dependencyName: "@mono-agent/core" | "@mono-agent/web",
): string {
  const manifest = parseJsonObject(source, packagePath);
  const dependencies = manifest.dependencies;
  if (!isRecord(dependencies)) {
    throw new Error(
      `${packagePath} must declare ${dependencyName} as a direct dependency.`,
    );
  }
  const dependencySpec = dependencies[dependencyName];
  if (
    !isExactDependencyVersion(dependencySpec)
    && !isLocalArchiveDependencySpec(dependencySpec)
  ) {
    throw new Error(
      `${packagePath} must pin ${dependencyName} to one exact semantic version or npm project-relative file:*.tgz archive.`,
    );
  }
  return dependencySpec;
}

function parseJsonObject(
  source: Uint8Array,
  path: string,
): Record<string, unknown> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(source).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${path} must contain strict JSON.`);
  }
  if (!isRecord(manifest)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return manifest;
}
