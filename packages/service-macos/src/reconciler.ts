import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateAgentConfig, type AgentLoadOptions, type AgentValidationResult } from "@mono-agent/core";

import { type CommandRunner, processCommandRunner } from "./command.js";
import {
  type LoadedServiceMacosConfig,
  type ServiceMacosServiceConfig,
  loadServiceMacosConfig,
} from "./config.js";
import { loadProtectedEnvironment } from "./environment.js";
export {
  ServiceMacosDriftError,
  ServiceMacosMutationDisabledError,
} from "./errors.js";
import {
  ServiceMacosDriftError,
  ServiceMacosMutationDisabledError,
} from "./errors.js";
import {
  type ServiceMacosRuntimePaths,
  type ServiceMacosTarget,
  assertRuntimePaths,
  renderServicePlist,
  serviceTarget,
} from "./plist.js";
import {
  assertNoPendingServiceMacosTransaction,
  observeOwnerPrivatePlist,
  recoverPendingServiceMacosTransaction,
  removeServicePlistTransaction,
  replaceServicePlistTransaction,
  type ServiceMacosTransactionLifecycle,
} from "./transactions.js";

export const SERVICE_PLAN_SCHEMA_VERSION = 1;
export const LAUNCHCTL_PATH = "/bin/launchctl";

export interface ServiceFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly ctimeNanoseconds: string;
  readonly uid: number;
  readonly mode: number;
  readonly links: number;
  readonly size: number;
}

export interface ServiceFileObservation {
  readonly exists: boolean;
  readonly digest?: string;
  readonly bytes?: number;
  readonly identity?: ServiceFileIdentity;
}

export interface ServiceMacosObservation {
  readonly target: ServiceMacosTarget;
  readonly file: ServiceFileObservation;
  readonly loaded: boolean;
}

export interface AgentPlanBinding {
  readonly agentConfig: string;
  readonly agentConfigDigest: string;
  readonly packageManifestDigest: string;
  readonly lockfilePath: string;
  readonly lockfileDigest: string;
  readonly environmentFile?: string;
  readonly environmentFileDigest?: string;
}

export type ServicePlanAction = "create" | "update" | "load" | "noop";
export type ServiceRemovalAction = "remove" | "noop";

export interface ServiceMacosPlanEntry {
  readonly serviceId: string;
  readonly service: ServiceMacosServiceConfig;
  readonly target: ServiceMacosTarget;
  readonly binding: AgentPlanBinding;
  readonly observed: ServiceMacosObservation;
  readonly desiredPlist: string;
  readonly desiredDigest: string;
  readonly action: ServicePlanAction;
}

export interface ServiceMacosPlan {
  readonly schemaVersion: 1;
  readonly configPath: string;
  readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths;
  readonly entries: readonly ServiceMacosPlanEntry[];
  readonly fingerprint: string;
}

export interface ServiceMacosRemovalPlanEntry {
  readonly serviceId: string;
  readonly target: ServiceMacosTarget;
  readonly observed: ServiceMacosObservation;
  readonly action: ServiceRemovalAction;
}

export interface ServiceMacosRemovalPlan {
  readonly schemaVersion: 1;
  readonly operation: "remove";
  readonly configPath: string;
  readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths;
  readonly entries: readonly ServiceMacosRemovalPlanEntry[];
  readonly fingerprint: string;
}

export interface InspectServiceMacosOptions {
  readonly runtime: ServiceMacosRuntimePaths;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

export interface PlanServiceMacosOptions extends InspectServiceMacosOptions {
  readonly validateAgent?: (path: string, options?: AgentLoadOptions) => Promise<AgentValidationResult>;
}

export interface ApplyServiceMacosOptions extends PlanServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export interface PlanServiceMacosRemovalOptions extends InspectServiceMacosOptions {
  readonly serviceIds?: readonly string[];
}

export interface RemoveServiceMacosOptions extends InspectServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export interface RecoverServiceMacosOptions extends InspectServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export async function inspectServiceMacos(
  configPath: string,
  options: InspectServiceMacosOptions,
): Promise<readonly ServiceMacosObservation[]> {
  assertRuntimePaths(options.runtime);
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime);
  return await inspectLoadedConfig(loaded, options);
}

export async function planServiceMacos(
  configPath: string,
  options: PlanServiceMacosOptions,
): Promise<ServiceMacosPlan> {
  assertRuntimePaths(options.runtime);
  await assertRuntimeFile(options.runtime.nodePath, options.runtime.uid, true);
  await assertRuntimeFile(options.runtime.runnerScriptPath, options.runtime.uid, false);
  await assertOwnedDirectory(options.runtime.launchAgentsDirectory, options.runtime.uid);
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime);
  const observations = await inspectLoadedConfig(loaded, options);
  const byService = new Map(observations.map((observation) => [observation.target.serviceId, observation]));
  const entries: ServiceMacosPlanEntry[] = [];
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    await assertOwnedDirectory(service.logs.directory, options.runtime.uid);
    const target = serviceTarget(serviceId, service, options.runtime);
    const observed = byService.get(serviceId);
    if (observed === undefined) throw new Error(`Missing observation for ${serviceId}.`);
    const binding = await createAgentBinding(service, options.runtime.uid, options.validateAgent ?? validateAgentConfig);
    const desiredPlist = renderServicePlist(target, service, options.runtime);
    const desiredDigest = digest(desiredPlist);
    const action: ServicePlanAction = !observed.file.exists
      ? "create"
      : observed.file.digest !== desiredDigest
        ? "update"
        : !observed.loaded
          ? "load"
          : "noop";
    entries.push(Object.freeze({ serviceId, service, target, binding, observed, desiredPlist, desiredDigest, action }));
  }
  const partial = Object.freeze({
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION as 1,
    configPath: loaded.path,
    configDigest: digest(loaded.source),
    runtime: Object.freeze({ ...options.runtime }),
    entries: Object.freeze(entries),
  });
  return Object.freeze({ ...partial, fingerprint: fingerprintPlan(partial) });
}

export async function applyServiceMacosPlan(
  plan: ServiceMacosPlan,
  options: ApplyServiceMacosOptions,
): Promise<readonly ServiceMacosObservation[]> {
  if (options.allowMutation !== true) throw new ServiceMacosMutationDisabledError();
  assertRuntimePaths(options.runtime);
  if (!sameRuntime(options.runtime, plan.runtime)) {
    throw new ServiceMacosDriftError("Runtime paths differ from the fingerprinted plan.");
  }
  const { fingerprint: _fingerprint, ...partial } = plan;
  if (fingerprintPlan(partial) !== plan.fingerprint) throw new ServiceMacosDriftError("Plan fingerprint is invalid.");
  const loaded = await loadServiceMacosConfig(plan.configPath);
  if (digest(loaded.source) !== plan.configDigest) throw new ServiceMacosDriftError("Service config changed after planning.");
  await assertRuntimeFile(plan.runtime.nodePath, plan.runtime.uid, true);
  await assertRuntimeFile(plan.runtime.runnerScriptPath, plan.runtime.uid, false);
  await assertOwnedDirectory(plan.runtime.launchAgentsDirectory, plan.runtime.uid);

  const runner = options.runner ?? processCommandRunner;
  for (const entry of plan.entries) {
    await recoverPendingServiceMacosTransaction(
      entry.target,
      plan.runtime.uid,
      transactionLifecycle(entry.target, runner),
    );
  }
  for (const entry of plan.entries) {
    const current = await inspectTarget(entry.target, plan.runtime.uid, runner, options.signal);
    assertObservationMatches(entry.observed, current);
    await assertBindingCurrent(entry, options.validateAgent ?? validateAgentConfig, plan.runtime.uid);
  }

  for (const entry of plan.entries) {
    if (entry.action === "noop") continue;
    const immediate = await inspectTarget(entry.target, plan.runtime.uid, runner, options.signal);
    assertObservationMatches(entry.observed, immediate);
    if (entry.action === "load") {
      await launchctl(runner, ["bootstrap", entry.target.launchdDomain, entry.target.plistPath], options.signal);
      continue;
    }
    await promoteAndActivate(entry, runner, plan.runtime.uid, options.signal);
  }
  const finalObservations = await inspectLoadedConfig(loaded, options);
  const finalByService = new Map(
    finalObservations.map((observation) => [observation.target.serviceId, observation]),
  );
  for (const entry of plan.entries) {
    const final = finalByService.get(entry.serviceId);
    if (
      final === undefined
      || !final.loaded
      || final.file.digest !== entry.desiredDigest
      || final.file.bytes !== Buffer.byteLength(entry.desiredPlist)
    ) {
      throw new ServiceMacosDriftError(`Applied service ${entry.serviceId} did not retain the desired plist and loaded state.`);
    }
  }
  return finalObservations;
}

export async function planServiceMacosRemoval(
  configPath: string,
  options: PlanServiceMacosRemovalOptions,
): Promise<ServiceMacosRemovalPlan> {
  assertRuntimePaths(options.runtime);
  await assertOwnedDirectory(options.runtime.launchAgentsDirectory, options.runtime.uid);
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime);
  const selectedServiceIds = selectRemovalServiceIds(loaded, options.serviceIds);
  const observations = await inspectLoadedConfig(loaded, options);
  const byService = new Map(observations.map((observation) => [observation.target.serviceId, observation]));
  const entries = selectedServiceIds.map((serviceId): ServiceMacosRemovalPlanEntry => {
    const observed = byService.get(serviceId);
    if (observed === undefined) throw new Error(`Missing observation for ${serviceId}.`);
    if (observed.loaded && !observed.file.exists) {
      throw new ServiceMacosDriftError(
        `Loaded service ${serviceId} has no managed plist; removal cannot be rolled back safely.`,
      );
    }
    return Object.freeze({
      serviceId,
      target: observed.target,
      observed,
      action: observed.loaded || observed.file.exists ? "remove" : "noop",
    });
  });
  const partial = Object.freeze({
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION as 1,
    operation: "remove" as const,
    configPath: loaded.path,
    configDigest: digest(loaded.source),
    runtime: Object.freeze({ ...options.runtime }),
    entries: Object.freeze(entries),
  });
  return Object.freeze({ ...partial, fingerprint: fingerprintRemovalPlan(partial) });
}

export async function removeServiceMacosPlan(
  plan: ServiceMacosRemovalPlan,
  options: RemoveServiceMacosOptions,
): Promise<readonly ServiceMacosObservation[]> {
  if (options.allowMutation !== true) throw new ServiceMacosMutationDisabledError();
  assertRuntimePaths(options.runtime);
  if (!sameRuntime(options.runtime, plan.runtime)) {
    throw new ServiceMacosDriftError("Runtime paths differ from the fingerprinted removal plan.");
  }
  const { fingerprint: _fingerprint, ...partial } = plan;
  if (fingerprintRemovalPlan(partial) !== plan.fingerprint) {
    throw new ServiceMacosDriftError("Removal plan fingerprint is invalid.");
  }
  const loaded = await loadServiceMacosConfig(plan.configPath);
  if (digest(loaded.source) !== plan.configDigest) {
    throw new ServiceMacosDriftError("Service config changed after removal planning.");
  }
  await assertOwnedDirectory(plan.runtime.launchAgentsDirectory, plan.runtime.uid);
  const runner = options.runner ?? processCommandRunner;

  for (const entry of plan.entries) {
    await recoverPendingServiceMacosTransaction(
      entry.target,
      plan.runtime.uid,
      transactionLifecycle(entry.target, runner),
    );
  }
  for (const entry of plan.entries) {
    const current = await inspectTarget(entry.target, plan.runtime.uid, runner, options.signal);
    assertObservationMatches(entry.observed, current);
  }
  for (const entry of plan.entries) {
    if (entry.action === "noop") continue;
    const immediate = await inspectTarget(entry.target, plan.runtime.uid, runner, options.signal);
    assertObservationMatches(entry.observed, immediate);
    await removeAndDisable(entry, runner, plan.runtime.uid, options.signal);
  }
  return Object.freeze(await Promise.all(
    plan.entries.map(async (entry) => {
      const observation = await inspectTarget(entry.target, plan.runtime.uid, runner, options.signal);
      if (observation.loaded || observation.file.exists) {
        throw new ServiceMacosDriftError(`Removal did not disable ${entry.serviceId}.`);
      }
      return observation;
    }),
  ));
}

export async function recoverServiceMacosTransactions(
  configPath: string,
  options: RecoverServiceMacosOptions,
): Promise<readonly ServiceMacosObservation[]> {
  if (options.allowMutation !== true) throw new ServiceMacosMutationDisabledError();
  assertRuntimePaths(options.runtime);
  await assertOwnedDirectory(options.runtime.launchAgentsDirectory, options.runtime.uid);
  const loaded = await loadServiceMacosConfig(configPath);
  const runner = options.runner ?? processCommandRunner;
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    const target = serviceTarget(serviceId, service, options.runtime);
    await recoverPendingServiceMacosTransaction(
      target,
      options.runtime.uid,
      transactionLifecycle(target, runner),
    );
  }
  return await inspectLoadedConfig(loaded, options);
}

export function fingerprintPlan(plan: Omit<ServiceMacosPlan, "fingerprint">): string {
  return `service-macos:v1:${digest(JSON.stringify(plan))}`;
}

export function fingerprintRemovalPlan(plan: Omit<ServiceMacosRemovalPlan, "fingerprint">): string {
  return `service-macos:remove:v1:${digest(JSON.stringify(plan))}`;
}

async function inspectLoadedConfig(
  loaded: LoadedServiceMacosConfig,
  options: InspectServiceMacosOptions,
): Promise<readonly ServiceMacosObservation[]> {
  const runner = options.runner ?? processCommandRunner;
  const observations = [];
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    observations.push(await inspectTarget(serviceTarget(serviceId, service, options.runtime), options.runtime.uid, runner, options.signal));
  }
  return Object.freeze(observations);
}

async function assertNoPendingTransactions(
  loaded: LoadedServiceMacosConfig,
  runtime: ServiceMacosRuntimePaths,
): Promise<void> {
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    await assertNoPendingServiceMacosTransaction(
      serviceTarget(serviceId, service, runtime),
      runtime.uid,
    );
  }
}

async function inspectTarget(
  target: ServiceMacosTarget,
  expectedUid: number,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<ServiceMacosObservation> {
  const file = await inspectPlistFile(target.plistPath, expectedUid);
  const result = await runner.run(LAUNCHCTL_PATH, ["print", target.launchdTarget], signal === undefined ? {} : { signal });
  if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) {
    throw new Error(`launchctl print ${target.launchdTarget} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
  }
  return Object.freeze({ target, file, loaded: result.exitCode === 0 });
}

async function inspectPlistFile(path: string, expectedUid: number): Promise<ServiceFileObservation> {
  return await observeOwnerPrivatePlist(path, expectedUid);
}

async function createAgentBinding(
  service: ServiceMacosServiceConfig,
  expectedUid: number,
  validate: (path: string, options?: AgentLoadOptions) => Promise<AgentValidationResult>,
): Promise<AgentPlanBinding> {
  const environment = service.environmentFile === undefined
    ? undefined
    : await loadProtectedEnvironment(service.environmentFile, expectedUid);
  const mergedEnvironment = environment === undefined
    ? process.env
    : { ...environment.values, ...process.env };
  const validation = await validate(service.agentConfig, { environment: mergedEnvironment });
  if (!validation.ok) {
    throw new Error(`Agent config ${service.agentConfig} is invalid: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const root = dirname(service.agentConfig);
  const agentSource = await readBounded(service.agentConfig, 1_048_576);
  const packageSource = await readBounded(join(root, "package.json"), 8_388_608);
  const lock = await readFirstLockfile(root);
  return Object.freeze({
    agentConfig: service.agentConfig,
    agentConfigDigest: digest(agentSource),
    packageManifestDigest: digest(packageSource),
    lockfilePath: lock.path,
    lockfileDigest: digest(lock.source),
    ...(service.environmentFile === undefined || environment === undefined
      ? {}
      : { environmentFile: service.environmentFile, environmentFileDigest: digest(environment.source) }),
  });
}

async function assertBindingCurrent(
  entry: ServiceMacosPlanEntry,
  validate: (path: string, options?: AgentLoadOptions) => Promise<AgentValidationResult>,
  uid: number,
): Promise<void> {
  const current = await createAgentBinding(entry.service, uid, validate);
  if (JSON.stringify(current) !== JSON.stringify(entry.binding)) {
    throw new ServiceMacosDriftError(`Validated agent closure changed for ${entry.serviceId}.`);
  }
}

async function promoteAndActivate(
  entry: ServiceMacosPlanEntry,
  runner: CommandRunner,
  expectedUid: number,
  signal?: AbortSignal,
): Promise<void> {
  await replaceServicePlistTransaction({
    target: entry.target,
    expectedUid,
    expectedFile: entry.observed.file,
    expectedLoaded: entry.observed.loaded,
    desiredPlist: entry.desiredPlist,
    desiredDigest: entry.desiredDigest,
    lifecycle: transactionLifecycle(entry.target, runner, signal),
  });
}

async function removeAndDisable(
  entry: ServiceMacosRemovalPlanEntry,
  runner: CommandRunner,
  expectedUid: number,
  signal?: AbortSignal,
): Promise<void> {
  await removeServicePlistTransaction({
    target: entry.target,
    expectedUid,
    expectedFile: entry.observed.file,
    expectedLoaded: entry.observed.loaded,
    lifecycle: transactionLifecycle(entry.target, runner, signal),
  });
}

function transactionLifecycle(
  target: ServiceMacosTarget,
  runner: CommandRunner,
  signal?: AbortSignal,
): ServiceMacosTransactionLifecycle {
  return Object.freeze({
    async inspectLoaded(): Promise<boolean> {
      const result = await runner.run(LAUNCHCTL_PATH, ["print", target.launchdTarget], {});
      if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) {
        throw new Error(
          `launchctl print ${target.launchdTarget} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`,
        );
      }
      return result.exitCode === 0;
    },
    async bootoutRequired(): Promise<void> {
      await launchctl(runner, ["bootout", target.launchdTarget], signal);
    },
    async bootoutIfPresent(): Promise<void> {
      await bootoutIfPresent(runner, target.launchdTarget);
    },
    async bootstrap(): Promise<void> {
      await launchctl(runner, ["bootstrap", target.launchdDomain, target.plistPath]);
    },
  });
}

async function launchctl(runner: CommandRunner, arguments_: readonly string[], signal?: AbortSignal): Promise<void> {
  const result = await runner.run(LAUNCHCTL_PATH, arguments_, signal === undefined ? {} : { signal });
  if (result.exitCode !== 0) throw new Error(`launchctl ${arguments_.join(" ")} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
}

async function bootoutIfPresent(runner: CommandRunner, target: string, signal?: AbortSignal): Promise<void> {
  const result = await runner.run(LAUNCHCTL_PATH, ["bootout", target], signal === undefined ? {} : { signal });
  if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) {
    throw new Error(`launchctl bootout ${target} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
  }
}

async function assertRuntimeFile(path: string, expectedUid: number, executable: boolean): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.uid !== expectedUid && stats.uid !== 0)) {
    throw new Error(`${path} must be a regular file owned by uid ${String(expectedUid)} or root.`);
  }
  if (executable && (stats.mode & 0o111) === 0) throw new Error(`${path} must be executable.`);
}

async function assertOwnedDirectory(path: string, expectedUid: number): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== expectedUid || (stats.mode & 0o022) !== 0) {
    throw new Error(`${path} must be a non-group-writable, non-world-writable directory owned by uid ${String(expectedUid)}.`);
  }
}

async function readFirstLockfile(root: string): Promise<{ readonly path: string; readonly source: Buffer }> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json"] as const) {
    const path = join(root, name);
    try {
      return { path, source: await readBounded(path, 67_108_864) };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  throw new Error(`${root} must contain pnpm-lock.yaml or package-lock.json.`);
}

async function readBounded(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) {
    throw new Error(`${path} must be a single-linked regular file no larger than ${String(maximumBytes)} bytes.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1
      || after.size > maximumBytes
    ) {
      throw new Error(`${path} changed identity or exceeded its byte limit while it was opened.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function selectRemovalServiceIds(
  loaded: LoadedServiceMacosConfig,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (requested === undefined) return Object.freeze(Object.keys(loaded.config.services).sort());
  if (requested.length === 0) {
    throw new ServiceMacosDriftError("A removal plan must select at least one service.");
  }
  const selected = [...new Set(requested)].sort();
  if (selected.length !== requested.length) {
    throw new ServiceMacosDriftError("Removal service ids must be unique.");
  }
  for (const serviceId of selected) {
    if (!Object.hasOwn(loaded.config.services, serviceId)) {
      throw new ServiceMacosDriftError(`Removal service ${serviceId} is not declared by the service config.`);
    }
  }
  return Object.freeze(selected);
}

function sameRuntime(left: ServiceMacosRuntimePaths, right: ServiceMacosRuntimePaths): boolean {
  return left.nodePath === right.nodePath
    && left.runnerScriptPath === right.runnerScriptPath
    && left.launchAgentsDirectory === right.launchAgentsDirectory
    && left.uid === right.uid;
}

function assertObservationMatches(expected: ServiceMacosObservation, actual: ServiceMacosObservation): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new ServiceMacosDriftError(`Observed launchd or plist state drifted for ${expected.target.serviceId}.`);
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bounded(value: string): string {
  return value.trim().slice(0, 1_024);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
