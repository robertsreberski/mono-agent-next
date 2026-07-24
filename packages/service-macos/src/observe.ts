import { lstat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type CommandResult,
  type CommandRunner,
  processCommandRunner,
} from "./command.js";
import type { LoadedServiceMacosConfig } from "./config.js";
import { ServiceMacosDriftError } from "./errors.js";
import { digest, isErrno } from "./internal-fs.js";
import { readServiceInput } from "./input.js";
import { readServiceReadiness } from "./logs.js";
import {
  type ServiceMacosRuntimePaths,
  type ServiceMacosTarget,
  type ServiceRunnerActivation,
  serviceTarget,
} from "./plist.js";
import { parseServiceRunnerActivation } from "./runner.js";
import { observeOwnerPrivatePlist } from "./plist-observation.js";
import type {
  CompleteServiceMacosObservation,
  InspectServiceMacosOptions,
  ServiceFileObservation,
  ServiceMacosObservation,
} from "./service-types.js";

export const LAUNCHCTL_PATH = "/bin/launchctl";
const LAUNCHCTL_COMMAND_TIMEOUT_MS = 5_000;

export async function inspectLoadedConfig(
  loaded: LoadedServiceMacosConfig,
  options: InspectServiceMacosOptions,
  expectedLaunchAgentsDirectoryIdentity: string,
  serviceIds: readonly string[] | undefined,
  reportErrors: true,
): Promise<readonly ServiceMacosObservation[]>;
export async function inspectLoadedConfig(
  loaded: LoadedServiceMacosConfig,
  options: InspectServiceMacosOptions,
  expectedLaunchAgentsDirectoryIdentity: string,
  serviceIds?: readonly string[],
  reportErrors?: false,
): Promise<readonly CompleteServiceMacosObservation[]>;
export async function inspectLoadedConfig(
  loaded: LoadedServiceMacosConfig,
  options: InspectServiceMacosOptions,
  expectedLaunchAgentsDirectoryIdentity: string,
  serviceIds: readonly string[] = Object.keys(loaded.config.services),
  reportErrors = false,
): Promise<readonly ServiceMacosObservation[]> {
  const runner = options.runner ?? processCommandRunner;
  const observations: ServiceMacosObservation[] = [];
  for (const serviceId of serviceIds) {
    const service = loaded.config.services[serviceId]!;
    const target = serviceTarget(serviceId, service, options.runtime);
    observations.push(reportErrors
      ? await inspectTarget(
        target,
        options.runtime.uid,
        runner,
        options.signal,
        expectedLaunchAgentsDirectoryIdentity,
        true,
      )
      : await inspectTarget(
        target,
        options.runtime.uid,
        runner,
        options.signal,
        expectedLaunchAgentsDirectoryIdentity,
      ));
  }
  return Object.freeze(observations);
}

export async function inspectTarget(
  target: ServiceMacosTarget,
  expectedUid: number,
  runner: CommandRunner,
  signal: AbortSignal | undefined,
  expectedLaunchAgentsDirectoryIdentity: string | undefined,
  reportErrors: true,
): Promise<ServiceMacosObservation>;
export async function inspectTarget(
  target: ServiceMacosTarget,
  expectedUid: number,
  runner: CommandRunner,
  signal?: AbortSignal,
  expectedLaunchAgentsDirectoryIdentity?: string,
  reportErrors?: false,
): Promise<CompleteServiceMacosObservation>;
export async function inspectTarget(
  target: ServiceMacosTarget,
  expectedUid: number,
  runner: CommandRunner,
  signal?: AbortSignal,
  expectedLaunchAgentsDirectoryIdentity?: string,
  reportErrors = false,
): Promise<ServiceMacosObservation> {
  throwIfAborted(signal);
  const assertParentCurrent = async (): Promise<void> => {
    if (expectedLaunchAgentsDirectoryIdentity === undefined) return;
    await assertOwnedDirectoryCurrent(
      dirname(target.plistPath),
      expectedUid,
      expectedLaunchAgentsDirectoryIdentity,
    );
  };
  await assertParentCurrent();

  let file: ServiceFileObservation;
  try {
    file = await inspectPlistFile(target.plistPath, expectedUid);
  } catch (error) {
    if (!reportErrors) throw error;
    throwIfAborted(signal);
    await assertParentCurrent();
    return failedObservation(
      target,
      await bestEffortFileExistence(target.plistPath),
      error,
    );
  }

  let result: CommandResult;
  try {
    result = await runLaunchctlCommand(
      runner,
      ["print", target.launchdTarget],
      signal,
    );
    if (
      result.exitCode !== 0
      && result.exitCode !== 3
      && result.exitCode !== 113
    ) {
      throw new Error(
        `launchctl print ${target.launchdTarget} failed `
        + `(${String(result.exitCode)}): ${boundedLaunchctlOutput(result.stderr)}`,
      );
    }
  } catch (error) {
    if (!reportErrors) throw error;
    throwIfAborted(signal);
    await assertParentCurrent();
    return failedObservation(target, file, error);
  }

  const parsed = parseLaunchctlObservation(result);
  const ready = parsed.launchdState === "running"
    && parsed.pid !== undefined
    && Number.isSafeInteger(parsed.pid)
    && parsed.pid > 0
    ? await installedReadiness(target, file, parsed.pid, expectedUid)
    : false;
  await assertParentCurrent();
  return Object.freeze({
    target,
    file,
    loaded: parsed.loaded,
    launchdState: parsed.launchdState,
    ...(parsed.pid === undefined ? {} : { pid: parsed.pid }),
    ready,
  });
}

function parseLaunchctlObservation(result: CommandResult): {
  readonly loaded: boolean;
  readonly launchdState: CompleteServiceMacosObservation["launchdState"];
  readonly pid?: number;
} {
  const loaded = result.exitCode === 0;
  const stateText = loaded
    ? /^\s*state = ([^\r\n]+)$/mu.exec(result.stdout)?.[1]?.trim()
    : undefined;
  const launchdState = !loaded
    ? "absent"
    : stateText === "running" || stateText === "exited"
      ? stateText
      : "unknown";
  const pidText = loaded
    ? /^\s*pid = ([0-9]+)$/mu.exec(result.stdout)?.[1]
    : undefined;
  const pid = pidText === undefined ? undefined : Number(pidText);
  return Object.freeze({
    loaded,
    launchdState,
    ...(pid === undefined ? {} : { pid }),
  });
}

async function installedReadiness(
  target: ServiceMacosTarget,
  file: ServiceFileObservation,
  pid: number,
  uid: number,
): Promise<boolean> {
  if (!file.exists) return false;
  try {
    const installed = await readInstalledActivation(target, uid, file.digest);
    return await readServiceReadiness(
      installed.activation.logs,
      installed.readinessToken,
      pid,
      uid,
    );
  } catch {
    return false;
  }
}

interface InstalledActivation {
  readonly activation: ServiceRunnerActivation;
  readonly readinessToken: string;
}

export async function readInstalledActivation(
  target: ServiceMacosTarget,
  uid: number,
  expectedDigest?: string,
): Promise<InstalledActivation> {
  const source = await readServiceInput(
    target.plistPath,
    1_048_576,
    { uid, mode: 0o600 },
  );
  if (expectedDigest !== undefined && source.digest !== expectedDigest) {
    throw new ServiceMacosDriftError(
      `Installed plist changed while reading activation for ${target.serviceId}.`,
    );
  }
  const encoded =
    /<string>--activation<\/string>\s*<string>([A-Za-z0-9_-]+)<\/string>/u
      .exec(source.source.toString("utf8"))?.[1];
  if (encoded === undefined) {
    throw new ServiceMacosDriftError(
      `Installed plist has no valid activation for ${target.serviceId}.`,
    );
  }
  return Object.freeze({
    activation: parseServiceRunnerActivation(encoded),
    readinessToken: digest(encoded),
  });
}

async function inspectPlistFile(
  path: string,
  expectedUid: number,
): Promise<ServiceFileObservation> {
  return await observeOwnerPrivatePlist(path, expectedUid);
}

async function bestEffortFileExistence(
  path: string,
): Promise<ServiceFileObservation | undefined> {
  try {
    await lstat(path);
    return Object.freeze({ exists: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return Object.freeze({ exists: false });
    return undefined;
  }
}

function failedObservation(
  target: ServiceMacosTarget,
  file: ServiceFileObservation | undefined,
  error: unknown,
): ServiceMacosObservation {
  return Object.freeze({
    target,
    ...(file === undefined ? {} : { file }),
    launchdState: "unknown",
    ready: false,
    observationError: error instanceof Error ? error.message : String(error),
  });
}

export async function runLaunchctlCommand(
  runner: CommandRunner,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<CommandRunner["run"]>>> {
  if (signal?.aborted === true) throw signal.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new ServiceMacosDriftError(
      `launchctl ${arguments_.join(" ")} timed out after `
      + `${String(LAUNCHCTL_COMMAND_TIMEOUT_MS)} ms.`,
    ));
  }, LAUNCHCTL_COMMAND_TIMEOUT_MS);
  try {
    return await Promise.race([
      Promise.resolve().then(async () => await runner.run(
        LAUNCHCTL_PATH,
        arguments_,
        { signal: controller.signal },
      )),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function assertRuntimeFile(
  path: string,
  expectedUid: number,
  executable: boolean,
): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.uid !== expectedUid && stats.uid !== 0)
    || (stats.mode & 0o022) !== 0
  ) {
    throw new Error(
      `${path} must be a protected regular file owned by uid `
      + `${String(expectedUid)} or root.`,
    );
  }
  if (executable && (stats.mode & 0o111) === 0) {
    throw new Error(`${path} must be executable.`);
  }
}

export async function assertOwnedDirectory(
  path: string,
  expectedUid: number,
): Promise<string> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(expectedUid)
    || (stats.mode & 0o022n) !== 0n
  ) {
    throw new Error(
      `${path} must be a non-group-writable, non-world-writable directory `
      + `owned by uid ${String(expectedUid)}.`,
    );
  }
  return [stats.dev, stats.ino, stats.uid, stats.mode & 0o777n].join(":");
}

export async function assertOwnedDirectoryCurrent(
  path: string,
  expectedUid: number,
  expectedIdentity: string,
): Promise<void> {
  const currentIdentity = await assertOwnedDirectory(path, expectedUid);
  if (currentIdentity !== expectedIdentity) {
    throw new ServiceMacosDriftError(
      `Protected directory changed after planning: ${path}.`,
    );
  }
}

export function boundedLaunchctlOutput(value: string): string {
  return value.trim().slice(0, 1_024);
}

export function assertObservationMatches(
  expected: CompleteServiceMacosObservation,
  actual: CompleteServiceMacosObservation,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new ServiceMacosDriftError(
      `Observed launchd or plist state drifted for ${expected.target.serviceId}.`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}
