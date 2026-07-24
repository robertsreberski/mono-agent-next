import { dirname } from "node:path";

import { validateAgentConfig } from "@mono-agent/core";
import { loadWebConfig } from "@mono-agent/web";

import { processCommandRunner } from "./command.js";
import {
  type LoadedServiceMacosConfig,
  loadServiceMacosConfig,
} from "./config.js";
import {
  assertServiceLogRetention,
  readManagedServiceLog,
} from "./logs.js";
export {
  ServiceMacosDriftError,
  ServiceMacosMutationDisabledError,
} from "./errors.js";
import {
  ServiceMacosDriftError,
  ServiceMacosMutationDisabledError,
} from "./errors.js";
import {
  activateExisting,
  assertBindingCurrent,
  boundLogs,
  createServiceBinding,
  promoteAndActivate,
  removeAndDisable,
  transactionLifecycle,
} from "./lifecycle.js";
import {
  assertOwnedDirectory,
  assertOwnedDirectoryCurrent,
  assertObservationMatches,
  assertRuntimeFile,
  inspectLoadedConfig,
  inspectTarget,
} from "./observe.js";
export { LAUNCHCTL_PATH } from "./observe.js";
import {
  type ServiceMacosRuntimePaths,
  assertRuntimePaths,
  encodeServiceRunnerActivation,
  renderServicePlist,
  serviceTarget,
} from "./plist.js";
import { digest } from "./internal-fs.js";
import type {
  ApplyServiceMacosOptions,
  CompleteServiceMacosObservation,
  InspectServiceMacosOptions,
  MutateSelectedServiceMacosOptions,
  PlanSelectedServiceMacosOptions,
  PlanServiceMacosOptions,
  PlanServiceMacosRemovalOptions,
  ReadServiceMacosLogsOptions,
  RecoverServiceMacosOptions,
  RemoveServiceMacosOptions,
  SelectedServiceMacosOptions,
  ServiceMacosLogsSnapshot,
  ServiceMacosObservation,
  ServiceMacosPlan,
  ServiceMacosPlanEntry,
  ServiceMacosRemovalPlan,
  ServiceMacosRemovalPlanEntry,
  ServiceMacosStatus,
  ServiceMacosStopPlan,
  ServicePlanAction,
  StopServiceMacosOptions,
} from "./service-types.js";
export type {
  ApplyServiceMacosOptions,
  InspectServiceMacosOptions,
  MutateSelectedServiceMacosOptions,
  PlanSelectedServiceMacosOptions,
  PlanServiceMacosOptions,
  PlanServiceMacosRemovalOptions,
  ReadServiceMacosLogsOptions,
  RecoverServiceMacosOptions,
  RemoveServiceMacosOptions,
  SelectedServiceMacosOptions,
  ServiceFileIdentity,
  ServiceFileObservation,
  ServiceMacosLogsSnapshot,
  ServiceMacosObservation,
  ServiceMacosPlan,
  ServiceMacosPlanEntry,
  ServiceMacosRemovalPlan,
  ServiceMacosRemovalPlanEntry,
  ServiceMacosStatus,
  ServiceMacosStopPlan,
  ServiceMacosStopPlanEntry,
  ServicePlanAction,
  ServicePlanBinding,
  ServiceRemovalAction,
  StopServiceMacosOptions,
} from "./service-types.js";
import {
  assertNoPendingServiceMacosTransaction,
  recoverPendingServiceMacosTransaction,
} from "./transactions.js";

export const SERVICE_PLAN_SCHEMA_VERSION = 1;
interface InternalPlanServiceMacosOptions extends PlanServiceMacosOptions {
  readonly serviceIds?: readonly string[];
  readonly forceRestart?: boolean;
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
  const observations = await inspectLoadedConfig(
    loaded,
    options,
    launchAgentsDirectoryIdentity,
    undefined,
    true,
  );
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
  return await planServiceMacosInternal(configPath, options);
}
async function planServiceMacosInternal(
  configPath: string,
  options: InternalPlanServiceMacosOptions,
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
  const selectedServiceIds = selectServiceIds(loaded, options.serviceIds);
  const observations = await inspectLoadedConfig(
    loaded,
    options,
    launchAgentsDirectoryIdentity,
    selectedServiceIds,
  );
  const byService = new Map(observations.map((observation) => [observation.target.serviceId, observation]));
  const entries: ServiceMacosPlanEntry[] = [];
  for (const serviceId of selectedServiceIds) {
    const service = loaded.config.services[serviceId]!;
    await assertOwnedDirectory(service.logs.directory, options.runtime.uid);
    const target = serviceTarget(serviceId, service, options.runtime);
    const observed = byService.get(serviceId);
    if (observed === undefined) throw new Error(`Missing observation for ${serviceId}.`);
    if (observed.loaded && !observed.file.exists) {
      throw new ServiceMacosDriftError(`Loaded service ${serviceId} has no managed plist; apply refuses to stop it.`);
    }
    const binding = await createServiceBinding(service, options.runtime, {
      validateAgent: options.validateAgent ?? validateAgentConfig,
      validateWeb: options.validateWeb ?? loadWebConfig,
    });
    await assertServiceLogRetention(boundLogs(target, service, binding.logsDirectoryIdentity), options.runtime.uid);
    const activation = encodeServiceRunnerActivation(target, service.logs, binding);
    const desiredPlist = renderServicePlist(target, service, options.runtime, binding);
    const desiredDigest = digest(desiredPlist);
    const action: ServicePlanAction = !observed.file.exists
      ? "create"
      : observed.file.digest !== desiredDigest
        ? "update"
        : options.forceRestart === true && observed.loaded
          ? "restart"
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
    await assertBindingCurrent(entry, {
      validateAgent: options.validateAgent ?? validateAgentConfig,
      validateWeb: options.validateWeb ?? loadWebConfig,
    }, plan.runtime);
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
    plan.entries.map((entry) => entry.serviceId),
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
export async function planStartServiceMacos(
  configPath: string,
  options: PlanSelectedServiceMacosOptions,
): Promise<ServiceMacosPlan> {
  const { serviceId, ...planOptions } = options;
  return await planServiceMacosInternal(configPath, {
    ...planOptions,
    serviceIds: [serviceId],
  });
}
export async function startServiceMacos(
  plan: ServiceMacosPlan,
  options: MutateSelectedServiceMacosOptions,
): Promise<ServiceMacosObservation> {
  const entry = assertSingleServicePlan(plan, "start");
  const observations = await applyServiceMacosPlan(plan, options);
  return requireServiceObservation(observations, entry.serviceId);
}
export async function planRestartServiceMacos(
  configPath: string,
  options: PlanSelectedServiceMacosOptions,
): Promise<ServiceMacosPlan> {
  const { serviceId, ...planOptions } = options;
  const plan = await planServiceMacosInternal(configPath, {
    ...planOptions,
    serviceIds: [serviceId],
    forceRestart: true,
  });
  const entry = assertSingleServicePlan(plan, "restart");
  if (!entry.observed.file.exists || !entry.observed.loaded) {
    throw new ServiceMacosDriftError(
      `Restart requires ${serviceId} to have an installed, loaded managed service.`,
    );
  }
  return plan;
}
export async function restartServiceMacos(
  plan: ServiceMacosPlan,
  options: MutateSelectedServiceMacosOptions,
): Promise<ServiceMacosObservation> {
  const entry = assertSingleServicePlan(plan, "restart");
  if (entry.action !== "restart" && entry.action !== "update") {
    throw new ServiceMacosDriftError(
      "Restart requires a fingerprinted restart or transactional update plan.",
    );
  }
  const observations = await applyServiceMacosPlan(plan, options);
  return requireServiceObservation(observations, entry.serviceId);
}
export async function planStopServiceMacos(
  configPath: string,
  options: SelectedServiceMacosOptions,
): Promise<ServiceMacosStopPlan> {
  assertRuntimePaths(options.runtime);
  const launchAgentsDirectoryIdentity = await assertOwnedDirectory(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
  );
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime, launchAgentsDirectoryIdentity);
  selectServiceIds(loaded, [options.serviceId]);
  const service = loaded.config.services[options.serviceId]!;
  const target = serviceTarget(options.serviceId, service, options.runtime);
  const observed = await inspectTarget(
    target,
    options.runtime.uid,
    options.runner ?? processCommandRunner,
    options.signal,
    launchAgentsDirectoryIdentity,
  );
  if (observed.loaded && !observed.file.exists) {
    throw new ServiceMacosDriftError(
      `Loaded service ${options.serviceId} has no managed plist; stop refuses to unload it.`,
    );
  }
  const entry = Object.freeze({
    serviceId: options.serviceId,
    service,
    target,
    observed,
    action: observed.loaded ? "stop" as const : "noop" as const,
  });
  const partial = Object.freeze({
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION as 1,
    operation: "stop" as const,
    configPath: loaded.path,
    configDigest: digest(loaded.source),
    runtime: Object.freeze({ ...options.runtime }),
    launchAgentsDirectoryIdentity,
    entry,
  });
  return Object.freeze({ ...partial, fingerprint: fingerprintStopPlan(partial) });
}
export async function stopServiceMacos(
  plan: ServiceMacosStopPlan,
  options: StopServiceMacosOptions,
): Promise<ServiceMacosObservation> {
  if (options.allowMutation !== true) throw new ServiceMacosMutationDisabledError();
  assertRuntimePaths(options.runtime);
  if (!sameRuntime(options.runtime, plan.runtime)) {
    throw new ServiceMacosDriftError("Runtime paths differ from the fingerprinted stop plan.");
  }
  const { fingerprint: _fingerprint, ...partial } = plan;
  if (fingerprintStopPlan(partial) !== plan.fingerprint) {
    throw new ServiceMacosDriftError("Stop plan fingerprint is invalid.");
  }
  const loaded = await loadServiceMacosConfig(plan.configPath);
  if (digest(loaded.source) !== plan.configDigest) {
    throw new ServiceMacosDriftError("Service config changed after stop planning.");
  }
  await assertOwnedDirectoryCurrent(
    plan.runtime.launchAgentsDirectory,
    plan.runtime.uid,
    plan.launchAgentsDirectoryIdentity,
  );
  const service = loaded.config.services[plan.entry.serviceId];
  if (service === undefined || JSON.stringify(service) !== JSON.stringify(plan.entry.service)) {
    throw new ServiceMacosDriftError("Selected service changed after stop planning.");
  }
  const runner = options.runner ?? processCommandRunner;
  const lifecycle = transactionLifecycle(
    plan.entry.target,
    service,
    undefined,
    plan.launchAgentsDirectoryIdentity,
    plan.runtime.uid,
    runner,
  );
  await recoverPendingServiceMacosTransaction(
    plan.entry.target,
    plan.runtime.uid,
    plan.launchAgentsDirectoryIdentity,
    lifecycle,
  );
  const current = await inspectTarget(
    plan.entry.target,
    plan.runtime.uid,
    runner,
    options.signal,
    plan.launchAgentsDirectoryIdentity,
  );
  assertObservationMatches(plan.entry.observed, current);
  if (plan.entry.action === "stop") {
    await lifecycle.bootoutRequired();
  }
  const final = await inspectTarget(
    plan.entry.target,
    plan.runtime.uid,
    runner,
    options.signal,
    plan.launchAgentsDirectoryIdentity,
  );
  if (
    final.loaded
    || JSON.stringify(final.file) !== JSON.stringify(plan.entry.observed.file)
  ) {
    throw new ServiceMacosDriftError(
      `Stopped service ${plan.entry.serviceId} did not retain its exact managed plist and unloaded state.`,
    );
  }
  return final;
}
export async function statusServiceMacos(
  configPath: string,
  options: SelectedServiceMacosOptions,
): Promise<ServiceMacosStatus> {
  assertRuntimePaths(options.runtime);
  const launchAgentsDirectoryIdentity = await assertOwnedDirectory(
    options.runtime.launchAgentsDirectory,
    options.runtime.uid,
  );
  const loaded = await loadServiceMacosConfig(configPath);
  await assertNoPendingTransactions(loaded, options.runtime, launchAgentsDirectoryIdentity);
  selectServiceIds(loaded, [options.serviceId]);
  const service = loaded.config.services[options.serviceId]!;
  const observation = await inspectTarget(
    serviceTarget(options.serviceId, service, options.runtime),
    options.runtime.uid,
    options.runner ?? processCommandRunner,
    options.signal,
    launchAgentsDirectoryIdentity,
    true,
  );
  const partial = Object.freeze({
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION as 1,
    operation: "status" as const,
    configPath: loaded.path,
    configDigest: digest(loaded.source),
    serviceId: options.serviceId,
    observation,
  });
  return Object.freeze({
    ...partial,
    fingerprint: `service-macos:status:v1:${digest(JSON.stringify(partial))}`,
  });
}
export async function readServiceMacosLogs(
  configPath: string,
  options: ReadServiceMacosLogsOptions,
): Promise<ServiceMacosLogsSnapshot> {
  const status = await statusServiceMacos(configPath, options);
  const loaded = await loadServiceMacosConfig(configPath);
  if (digest(loaded.source) !== status.configDigest) {
    throw new ServiceMacosDriftError("Service config changed during log inspection.");
  }
  const service = loaded.config.services[options.serviceId]!;
  const maxBytes = options.maxBytes ?? 65_536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    throw new ServiceMacosDriftError("Log inspection maxBytes must be from 1 through 1048576.");
  }
  const logsDirectoryIdentity = await assertOwnedDirectory(
    service.logs.directory,
    options.runtime.uid,
  );
  const [stdout, stderr] = await Promise.all([
    readManagedServiceLog(status.observation.target.stdoutPath, options.runtime.uid, maxBytes),
    readManagedServiceLog(status.observation.target.stderrPath, options.runtime.uid, maxBytes),
  ]);
  await assertOwnedDirectoryCurrent(
    service.logs.directory,
    options.runtime.uid,
    logsDirectoryIdentity,
  );
  const partial = Object.freeze({
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION as 1,
    operation: "logs" as const,
    configPath: loaded.path,
    configDigest: status.configDigest,
    serviceId: options.serviceId,
    observation: status.observation,
    stdout,
    stderr,
  });
  if (service.logs.directory !== dirname(status.observation.target.stdoutPath)) {
    throw new ServiceMacosDriftError("Selected service log directory changed during inspection.");
  }
  return Object.freeze({
    ...partial,
    fingerprint: `service-macos:logs:v1:${digest(JSON.stringify(partial))}`,
  });
}
export function fingerprintStopPlan(plan: Omit<ServiceMacosStopPlan, "fingerprint">): string {
  return `service-macos:stop:v1:${digest(JSON.stringify(plan))}`;
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
  const selectedServiceIds = selectServiceIds(loaded, [options.serviceId]);
  const observations = await inspectLoadedConfig(
    loaded,
    options,
    launchAgentsDirectoryIdentity,
    selectedServiceIds,
  );
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
  const selectedServiceIds = selectServiceIds(
    loaded,
    options.serviceId === undefined ? undefined : [options.serviceId],
  );
  for (const serviceId of selectedServiceIds) {
    const service = loaded.config.services[serviceId]!;
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
  return await inspectLoadedConfig(
    loaded,
    options,
    launchAgentsDirectoryIdentity,
    selectedServiceIds,
  );
}
export function fingerprintPlan(plan: Omit<ServiceMacosPlan, "fingerprint">): string {
  return `service-macos:v1:${digest(JSON.stringify(plan))}`;
}
export function fingerprintRemovalPlan(plan: Omit<ServiceMacosRemovalPlan, "fingerprint">): string {
  return `service-macos:remove:v1:${digest(JSON.stringify(plan))}`;
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
function selectServiceIds(
  loaded: LoadedServiceMacosConfig,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (requested === undefined) return Object.freeze(Object.keys(loaded.config.services).sort());
  if (requested.length === 0) {
    throw new ServiceMacosDriftError("A service plan must select at least one service.");
  }
  const selected = [...new Set(requested)].sort();
  if (selected.length !== requested.length) {
    throw new ServiceMacosDriftError("Selected service ids must be unique.");
  }
  for (const serviceId of selected) {
    if (!Object.hasOwn(loaded.config.services, serviceId)) {
      throw new ServiceMacosDriftError(`Service ${serviceId} is not declared by the service config.`);
    }
  }
  return Object.freeze(selected);
}
function assertSingleServicePlan(
  plan: ServiceMacosPlan,
  operation: "start" | "restart",
): ServiceMacosPlanEntry {
  if (plan.entries.length !== 1 || plan.entries[0] === undefined) {
    throw new ServiceMacosDriftError(
      `${operation} requires a fingerprinted plan selecting exactly one service.`,
    );
  }
  return plan.entries[0];
}
function requireServiceObservation(
  observations: readonly ServiceMacosObservation[],
  serviceId: string,
): CompleteServiceMacosObservation {
  const observation = observations.find((candidate) => candidate.target.serviceId === serviceId);
  if (
    observation === undefined
    || observation.observationError !== undefined
  ) {
    throw new ServiceMacosDriftError(`Final observation for ${serviceId} is missing.`);
  }
  return observation;
}
function sameRuntime(left: ServiceMacosRuntimePaths, right: ServiceMacosRuntimePaths): boolean {
  return left.nodePath === right.nodePath
    && left.runnerScriptPath === right.runnerScriptPath
    && left.launchAgentsDirectory === right.launchAgentsDirectory
    && left.uid === right.uid;
}
