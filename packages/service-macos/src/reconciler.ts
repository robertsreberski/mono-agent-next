import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateAgentConfig, type AgentLoadOptions, type AgentValidationResult } from "@mono-agent/core";
import { type CommandRunner, processCommandRunner } from "./command.js";
import {
  type LoadedServiceMacosConfig,
  type ServiceMacosServiceConfig,
  loadServiceMacosConfig,
} from "./config.js";
import { loadProtectedEnvironment } from "./environment.js";
import { readServiceInput } from "./input.js";
import { assertServiceLogRetention, readServiceReadiness, resetServiceLogs } from "./logs.js";
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
  type ServiceRunnerBinding,
  type ServiceMacosTarget,
  assertRuntimePaths,
  encodeServiceRunnerActivation,
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
const LAUNCHCTL_COMMAND_TIMEOUT_MS = 5_000;
export interface ServiceFileIdentity {
  readonly device: string; readonly inode: string; readonly ctimeNanoseconds: string;
  readonly uid: number; readonly mode: number; readonly links: number; readonly size: number;
}
export interface ServiceFileObservation {
  readonly exists: boolean; readonly digest?: string; readonly bytes?: number; readonly identity?: ServiceFileIdentity;
}
export interface ServiceMacosObservation {
  readonly target: ServiceMacosTarget; readonly file: ServiceFileObservation; readonly loaded: boolean;
  readonly launchdState: "absent" | "running" | "exited" | "unknown"; readonly pid?: number; readonly ready: boolean;
}
export interface AgentPlanBinding extends ServiceRunnerBinding {
  readonly agentConfig: string; readonly environmentFile?: string;
}
export type ServicePlanAction = "create" | "update" | "load" | "restart" | "noop";
export type ServiceRemovalAction = "remove" | "noop";
export interface ServiceMacosPlanEntry {
  readonly serviceId: string; readonly service: ServiceMacosServiceConfig; readonly target: ServiceMacosTarget;
  readonly binding: AgentPlanBinding; readonly observed: ServiceMacosObservation; readonly desiredPlist: string;
  readonly desiredDigest: string; readonly readinessToken: string; readonly action: ServicePlanAction;
}
export interface ServiceMacosPlan {
  readonly schemaVersion: 1; readonly configPath: string; readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths; readonly launchAgentsDirectoryIdentity: string;
  readonly entries: readonly ServiceMacosPlanEntry[]; readonly fingerprint: string;
}
export interface ServiceMacosRemovalPlanEntry {
  readonly serviceId: string; readonly target: ServiceMacosTarget;
  readonly observed: ServiceMacosObservation; readonly action: ServiceRemovalAction;
}
export interface ServiceMacosRemovalPlan {
  readonly schemaVersion: 1; readonly operation: "remove"; readonly configPath: string; readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths; readonly launchAgentsDirectoryIdentity: string;
  readonly entries: readonly ServiceMacosRemovalPlanEntry[]; readonly fingerprint: string;
}
export interface InspectServiceMacosOptions {
  readonly runtime: ServiceMacosRuntimePaths; readonly runner?: CommandRunner; readonly signal?: AbortSignal;
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
  const launchAgentsDirectoryIdentity = await assertOwnedDirectory(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
  );
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime, launchAgentsDirectoryIdentity);
  const observations = await inspectLoadedConfig(loaded, options, launchAgentsDirectoryIdentity);
  await assertOwnedDirectoryCurrent(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
    launchAgentsDirectoryIdentity,
  );
  return observations;
}
export async function planServiceMacos(
  configPath: string,
  options: PlanServiceMacosOptions,
): Promise<ServiceMacosPlan> {
  assertRuntimePaths(options.runtime);
  await assertRuntimeFile(options.runtime.nodePath, options.runtime.uid, true);
  await assertRuntimeFile(options.runtime.runnerScriptPath, options.runtime.uid, false);
  const launchAgentsDirectoryIdentity = await assertOwnedDirectory(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
  );
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime, launchAgentsDirectoryIdentity);
  const observations = await inspectLoadedConfig(loaded, options, launchAgentsDirectoryIdentity);
  const byService = new Map(observations.map((observation) => [observation.target.serviceId, observation]));
  const entries: ServiceMacosPlanEntry[] = [];
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    await assertOwnedDirectory(service.logs.directory, options.runtime.uid);
    const target = serviceTarget(serviceId, service, options.runtime);
    const observed = byService.get(serviceId);
    if (observed === undefined) throw new Error(`Missing observation for ${serviceId}.`);
    if (observed.loaded && !observed.file.exists) {
      throw new ServiceMacosDriftError(`Loaded service ${serviceId} has no managed plist; apply refuses to stop it.`);
    }
    const binding = await createAgentBinding(service, options.runtime.uid, options.validateAgent ?? validateAgentConfig);
    await assertServiceLogRetention(boundLogs(target, service, binding.logsDirectoryIdentity), options.runtime.uid);
    const activation = encodeServiceRunnerActivation(target, service.logs, binding);
    const desiredPlist = renderServicePlist(target, service, options.runtime, binding);
    const desiredDigest = digest(desiredPlist);
    const action: ServicePlanAction = !observed.file.exists
      ? "create"
      : observed.file.digest !== desiredDigest
        ? "update"
        : !observed.loaded ? "load"
          : observed.launchdState !== "running" || !observed.ready ? "restart" : "noop";
    entries.push(Object.freeze({
      serviceId, service, target, binding, observed, desiredPlist, desiredDigest,
      readinessToken: activation.readinessToken, action,
    }));
  }
  await assertOwnedDirectoryCurrent(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
    launchAgentsDirectoryIdentity,
  );
  const partial = Object.freeze({
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION as 1,
    configPath: loaded.path,
    configDigest: digest(loaded.source),
    runtime: Object.freeze({ ...options.runtime }),
    launchAgentsDirectoryIdentity,
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
  await assertOwnedDirectoryCurrent(
    plan.runtime.launchAgentsDirectory,
    plan.runtime.uid,
    plan.launchAgentsDirectoryIdentity,
  );
  const runner = options.runner ?? processCommandRunner;
  for (const entry of plan.entries) {
    await recoverPendingServiceMacosTransaction(
      entry.target,
      plan.runtime.uid,
      plan.launchAgentsDirectoryIdentity,
      transactionLifecycle(
        entry.target,
        entry.service,
        entry.binding.logsDirectoryIdentity,
        plan.launchAgentsDirectoryIdentity,
        plan.runtime.uid,
        runner,
      ),
    );
  }
  for (const entry of plan.entries) {
    const current = await inspectTarget(
      entry.target,
      plan.runtime.uid,
      runner,
      options.signal,
      plan.launchAgentsDirectoryIdentity,
    );
    assertObservationMatches(entry.observed, current);
    await assertBindingCurrent(entry, options.validateAgent ?? validateAgentConfig, plan.runtime.uid);
  }
  for (const entry of plan.entries) {
    if (entry.action === "noop") {
      await transactionLifecycle(
        entry.target,
        entry.service,
        entry.binding.logsDirectoryIdentity,
        plan.launchAgentsDirectoryIdentity,
        plan.runtime.uid,
        runner,
      ).proveReady(entry.readinessToken);
      continue;
    }
    const immediate = await inspectTarget(
      entry.target,
      plan.runtime.uid,
      runner,
      options.signal,
      plan.launchAgentsDirectoryIdentity,
    );
    assertObservationMatches(entry.observed, immediate);
    if (entry.action === "load" || entry.action === "restart") {
      await activateExisting(
        entry,
        runner,
        plan.launchAgentsDirectoryIdentity,
        plan.runtime.uid,
        entry.action === "restart",
      );
      continue;
    }
    await promoteAndActivate(
      entry,
      runner,
      plan.launchAgentsDirectoryIdentity,
      plan.runtime.uid,
    );
  }
  const finalObservations = await inspectLoadedConfig(
    loaded,
    options,
    plan.launchAgentsDirectoryIdentity,
  );
  const finalByService = new Map(
    finalObservations.map((observation) => [observation.target.serviceId, observation]),
  );
  for (const entry of plan.entries) {
    const final = finalByService.get(entry.serviceId);
    if (
      final === undefined
      || !final.loaded || final.launchdState !== "running" || !final.ready
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
  const launchAgentsDirectoryIdentity = await assertOwnedDirectory(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
  );
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime, launchAgentsDirectoryIdentity);
  const selectedServiceIds = selectRemovalServiceIds(loaded, options.serviceIds);
  const observations = await inspectLoadedConfig(loaded, options, launchAgentsDirectoryIdentity);
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
    launchAgentsDirectoryIdentity,
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
  await assertOwnedDirectoryCurrent(
    plan.runtime.launchAgentsDirectory,
    plan.runtime.uid,
    plan.launchAgentsDirectoryIdentity,
  );
  const runner = options.runner ?? processCommandRunner;
  for (const entry of plan.entries) {
    await recoverPendingServiceMacosTransaction(
      entry.target,
      plan.runtime.uid,
      plan.launchAgentsDirectoryIdentity,
      transactionLifecycle(
        entry.target,
        loaded.config.services[entry.serviceId]!,
        undefined,
        plan.launchAgentsDirectoryIdentity,
        plan.runtime.uid,
        runner,
      ),
    );
  }
  for (const entry of plan.entries) {
    const current = await inspectTarget(
      entry.target,
      plan.runtime.uid,
      runner,
      options.signal,
      plan.launchAgentsDirectoryIdentity,
    );
    assertObservationMatches(entry.observed, current);
  }
  for (const entry of plan.entries) {
    if (entry.action === "noop") continue;
    const immediate = await inspectTarget(
      entry.target,
      plan.runtime.uid,
      runner,
      options.signal,
      plan.launchAgentsDirectoryIdentity,
    );
    assertObservationMatches(entry.observed, immediate);
    await removeAndDisable(
      entry,
      loaded.config.services[entry.serviceId]!,
      runner,
      plan.launchAgentsDirectoryIdentity,
      plan.runtime.uid,
    );
  }
  return Object.freeze(await Promise.all(
    plan.entries.map(async (entry) => {
      const observation = await inspectTarget(
        entry.target,
        plan.runtime.uid,
        runner,
        options.signal,
        plan.launchAgentsDirectoryIdentity,
      );
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
  const launchAgentsDirectoryIdentity = await assertOwnedDirectory(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
  );
  const loaded = await loadServiceMacosConfig(configPath);
  const runner = options.runner ?? processCommandRunner;
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    const target = serviceTarget(serviceId, service, options.runtime);
    await recoverPendingServiceMacosTransaction(
      target,
      options.runtime.uid,
      launchAgentsDirectoryIdentity,
      transactionLifecycle(
        target,
        service,
        undefined,
        launchAgentsDirectoryIdentity,
        options.runtime.uid,
        runner,
      ),
    );
  }
  return await inspectLoadedConfig(loaded, options, launchAgentsDirectoryIdentity);
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
  expectedLaunchAgentsDirectoryIdentity: string,
): Promise<readonly ServiceMacosObservation[]> {
  const runner = options.runner ?? processCommandRunner;
  const observations = [];
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    observations.push(await inspectTarget(
      serviceTarget(serviceId, service, options.runtime),
      options.runtime.uid,
      runner,
      options.signal,
      expectedLaunchAgentsDirectoryIdentity,
    ));
  }
  return Object.freeze(observations);
}
async function assertNoPendingTransactions(
  loaded: LoadedServiceMacosConfig,
  runtime: ServiceMacosRuntimePaths,
  expectedParentIdentity: string,
): Promise<void> {
  for (const [serviceId, service] of Object.entries(loaded.config.services)) {
    await assertNoPendingServiceMacosTransaction(
      serviceTarget(serviceId, service, runtime),
      runtime.uid,
      expectedParentIdentity,
    );
  }
}
async function inspectTarget(
  target: ServiceMacosTarget,
  expectedUid: number,
  runner: CommandRunner,
  signal?: AbortSignal,
  expectedLaunchAgentsDirectoryIdentity?: string,
): Promise<ServiceMacosObservation> {
  if (expectedLaunchAgentsDirectoryIdentity !== undefined) {
    await assertOwnedDirectoryCurrent(
      dirname(target.plistPath),
      expectedUid,
      expectedLaunchAgentsDirectoryIdentity,
    );
  }
  const file = await inspectPlistFile(target.plistPath, expectedUid);
  const result = await runLaunchctlCommand(runner, ["print", target.launchdTarget], signal);
  if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) {
    throw new Error(`launchctl print ${target.launchdTarget} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
  }
  const loaded = result.exitCode === 0;
  const stateText = loaded ? /^\s*state = ([^\r\n]+)$/mu.exec(result.stdout)?.[1]?.trim() : undefined;
  const launchdState = !loaded ? "absent" : stateText === "running" || stateText === "exited" ? stateText : "unknown";
  const pidText = loaded ? /^\s*pid = ([0-9]+)$/mu.exec(result.stdout)?.[1] : undefined;
  const pid = pidText === undefined ? undefined : Number(pidText);
  const ready = launchdState === "running" && pid !== undefined && Number.isSafeInteger(pid) && pid > 0
    ? await installedReadiness(target, file, pid, expectedUid) : false;
  if (expectedLaunchAgentsDirectoryIdentity !== undefined) {
    await assertOwnedDirectoryCurrent(
      dirname(target.plistPath),
      expectedUid,
      expectedLaunchAgentsDirectoryIdentity,
    );
  }
  return Object.freeze({ target, file, loaded, launchdState, ...(pid === undefined ? {} : { pid }), ready });
}
async function installedReadiness(
  target: ServiceMacosTarget, file: ServiceFileObservation, pid: number, uid: number,
): Promise<boolean> {
  if (!file.exists) return false;
  try {
    const source = await readServiceInput(target.plistPath, 1_048_576, { uid, mode: 0o600 });
    if (source.digest !== file.digest) return false;
    const encoded = /<string>--activation<\/string>\s*<string>([A-Za-z0-9_-]+)<\/string>/u.exec(source.source.toString("utf8"))?.[1];
    if (encoded === undefined) return false;
    const activation = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { logs: Parameters<typeof readServiceReadiness>[0] };
    return await readServiceReadiness(activation.logs, digest(encoded), pid, uid);
  } catch {
    return false;
  }
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
  const mergedEnvironment = environment?.values ?? Object.freeze(Object.create(null) as Record<string, string>);
  const validation = await validate(service.agentConfig, { environment: mergedEnvironment });
  if (!validation.ok) {
    throw new Error(`Agent config ${service.agentConfig} is invalid: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const root = dirname(service.agentConfig);
  const agentSource = await readServiceInput(service.agentConfig, 1_048_576);
  const packageSource = await readServiceInput(join(root, "package.json"), 8_388_608);
  const lock = await readFirstLockfile(root);
  return Object.freeze({
    agentConfig: service.agentConfig,
    agentConfigDigest: agentSource.digest,
    packageManifestDigest: packageSource.digest,
    lockfilePath: lock.path,
    lockfileDigest: lock.source.digest,
    logsDirectoryIdentity: await assertOwnedDirectory(service.logs.directory, expectedUid),
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
  await assertServiceLogRetention(boundLogs(entry.target, entry.service, current.logsDirectoryIdentity), uid);
}
async function promoteAndActivate(
  entry: ServiceMacosPlanEntry,
  runner: CommandRunner,
  expectedParentIdentity: string,
  expectedUid: number,
): Promise<void> {
  await replaceServicePlistTransaction({
    target: entry.target,
    expectedUid,
    expectedParentIdentity,
    expectedFile: entry.observed.file,
    expectedLoaded: entry.observed.loaded,
    desiredPlist: entry.desiredPlist,
    desiredDigest: entry.desiredDigest,
    readinessToken: entry.readinessToken,
    lifecycle: transactionLifecycle(
      entry.target,
      entry.service,
      entry.binding.logsDirectoryIdentity,
      expectedParentIdentity,
      expectedUid,
      runner,
    ),
  });
}
async function activateExisting(
  entry: ServiceMacosPlanEntry,
  runner: CommandRunner,
  expectedParentIdentity: string,
  expectedUid: number,
  restart: boolean,
): Promise<void> {
  const lifecycle = transactionLifecycle(
    entry.target,
    entry.service,
    entry.binding.logsDirectoryIdentity,
    expectedParentIdentity,
    expectedUid,
    runner,
  );
  try {
    if (restart) await lifecycle.bootoutIfPresent();
    await lifecycle.bootstrap();
    await lifecycle.proveReady(entry.readinessToken);
  } catch (error) {
    await lifecycle.bootoutIfPresent().catch(() => undefined);
    throw error;
  }
}
async function removeAndDisable(
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
function transactionLifecycle(
  target: ServiceMacosTarget,
  service: ServiceMacosServiceConfig,
  expectedDirectoryIdentity: string | undefined,
  expectedParentIdentity: string,
  expectedUid: number,
  runner: CommandRunner,
): ServiceMacosTransactionLifecycle {
  const parent = async () => {
    await assertOwnedDirectoryCurrent(dirname(target.plistPath), expectedUid, expectedParentIdentity);
  };
  const logs = async () => {
    const directoryIdentity = await assertOwnedDirectory(service.logs.directory, expectedUid);
    if (expectedDirectoryIdentity !== undefined && directoryIdentity !== expectedDirectoryIdentity) {
      throw new ServiceMacosDriftError(`Log directory changed for ${target.serviceId}.`);
    }
    return boundLogs(target, service, directoryIdentity);
  };
  return Object.freeze({
    async inspectLoaded(): Promise<boolean> {
      await parent();
      const result = await runLaunchctlCommand(runner, ["print", target.launchdTarget]);
      await parent();
      if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) {
        throw new Error(
          `launchctl print ${target.launchdTarget} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`,
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
      await parent();
      await resetServiceLogs(await logs(), expectedUid);
      await parent();
      await launchctl(runner, ["bootstrap", target.launchdDomain, target.plistPath]);
      await parent();
      if (!service.startAtLogin) await launchctl(runner, ["kickstart", target.launchdTarget]);
      await parent();
    },
    async proveReady(readinessToken: string): Promise<void> {
      await parent();
      await proveServiceReady(target, await logs(), readinessToken, expectedUid, runner);
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
        if (observation.launchdState === "running" && observation.ready) return;
        if (observation.launchdState === "exited") {
          throw new ServiceMacosDriftError(`Restored service ${target.serviceId} exited before readiness.`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      throw new ServiceMacosDriftError(`Restored service ${target.serviceId} did not prove readiness.`);
    },
  });
}
function boundLogs(target: ServiceMacosTarget, service: ServiceMacosServiceConfig, directoryIdentity: string) {
  return Object.freeze({ ...service.logs, directoryIdentity, stdoutPath: target.stdoutPath,
    stderrPath: target.stderrPath, readinessPath: target.readinessPath });
}
async function proveServiceReady(
  target: ServiceMacosTarget,
  logs: Parameters<typeof readServiceReadiness>[0],
  readinessToken: string,
  expectedUid: number,
  runner: CommandRunner,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runLaunchctlCommand(runner, ["print", target.launchdTarget]);
    if (result.exitCode === 0) {
      const state = /^\s*state = ([^\r\n]+)$/mu.exec(result.stdout)?.[1]?.trim();
      const pidText = /^\s*pid = ([0-9]+)$/mu.exec(result.stdout)?.[1];
      const pid = pidText === undefined ? 0 : Number(pidText);
      if (state === "running" && Number.isSafeInteger(pid) && pid > 0) {
        if (await readServiceReadiness(logs, readinessToken, pid, expectedUid)) return;
      } else if (state === "exited" || /^\s*last exit code = [1-9][0-9]*$/mu.test(result.stdout)) {
        throw new ServiceMacosDriftError(`Service ${target.serviceId} exited before readiness.`);
      }
    } else if (result.exitCode === 3 || result.exitCode === 113) {
      if (attempt >= 2) {
        throw new ServiceMacosDriftError(`Activation did not retain loaded state for ${target.serviceId}.`);
      }
    } else {
      throw new Error(`launchctl print ${target.launchdTarget} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new ServiceMacosDriftError(`Service ${target.serviceId} did not prove healthy planned-input readiness.`);
}
async function launchctl(runner: CommandRunner, arguments_: readonly string[]): Promise<void> {
  const result = await runLaunchctlCommand(runner, arguments_);
  if (result.exitCode !== 0) throw new Error(`launchctl ${arguments_.join(" ")} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
}
async function bootoutIfPresent(runner: CommandRunner, target: string): Promise<void> {
  await stopService(runner, target, false);
}
async function stopService(
  runner: CommandRunner, target: string, required: boolean,
): Promise<void> {
  const before = await runLaunchctlCommand(runner, ["print", target]);
  if (before.exitCode === 3 || before.exitCode === 113) {
    if (required) throw new ServiceMacosDriftError(`Required service ${target} was not loaded before stop.`);
    return;
  }
  if (before.exitCode !== 0) {
    throw new Error(`launchctl print ${target} failed (${String(before.exitCode)}): ${bounded(before.stderr)}`);
  }
  const state = /^\s*state = ([^\r\n]+)$/mu.exec(before.stdout)?.[1]?.trim();
  const pidValue = /^\s*pid = ([^\r\n]+)$/mu.exec(before.stdout)?.[1]?.trim();
  const pid = pidValue === undefined ? undefined : Number(pidValue);
  if (
    (state !== "running" && state !== "exited" && state !== "waiting" && state !== "not running")
    || (pidValue !== undefined && (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0))
    || (state === "running" && pid === undefined)
  ) {
    throw new ServiceMacosDriftError(
      `Cannot prove prior process identity for ${target} from launchd state ${state ?? "missing"}.`,
    );
  }
  await launchctl(runner, ["bootout", target]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runLaunchctlCommand(runner, ["print", target]);
    if ((result.exitCode === 3 || result.exitCode === 113) && (pid === undefined || !processIsAlive(pid))) return;
    if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) {
      throw new Error(`launchctl print ${target} failed (${String(result.exitCode)}): ${bounded(result.stderr)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new ServiceMacosDriftError(`Service ${target} did not prove unload and process death.`);
}
async function runLaunchctlCommand(
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
      `launchctl ${arguments_.join(" ")} timed out after ${String(LAUNCHCTL_COMMAND_TIMEOUT_MS)} ms.`,
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
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return !isErrno(error, "ESRCH"); }
}
async function assertRuntimeFile(path: string, expectedUid: number, executable: boolean): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isFile() || stats.isSymbolicLink() || (stats.uid !== expectedUid && stats.uid !== 0)
    || (stats.mode & 0o022) !== 0
  ) {
    throw new Error(`${path} must be a protected regular file owned by uid ${String(expectedUid)} or root.`);
  }
  if (executable && (stats.mode & 0o111) === 0) throw new Error(`${path} must be executable.`);
}
async function assertOwnedDirectory(path: string, expectedUid: number): Promise<string> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== BigInt(expectedUid) || (stats.mode & 0o022n) !== 0n) {
    throw new Error(`${path} must be a non-group-writable, non-world-writable directory owned by uid ${String(expectedUid)}.`);
  }
  return [stats.dev, stats.ino, stats.uid, stats.mode & 0o777n].join(":");
}
async function assertOwnedDirectoryCurrent(
  path: string,
  expectedUid: number,
  expectedIdentity: string,
): Promise<void> {
  const currentIdentity = await assertOwnedDirectory(path, expectedUid);
  if (currentIdentity !== expectedIdentity) {
    throw new ServiceMacosDriftError(`Protected directory changed after planning: ${path}.`);
  }
}
async function readFirstLockfile(root: string): Promise<{ readonly path: string; readonly source: Awaited<ReturnType<typeof readServiceInput>> }> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json"] as const) {
    const path = join(root, name);
    try {
      return { path, source: await readServiceInput(path, 67_108_864) };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  throw new Error(`${root} must contain pnpm-lock.yaml or package-lock.json.`);
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
