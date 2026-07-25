// SPDX-License-Identifier: MIT
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createAgentHost, validateAgentConfig } from "@mono-agent/core";
import { parseWebConfig, startWebServer } from "@mono-agent/web";

import { loadProtectedEnvironment } from "./environment.js";
import { readServiceInput } from "./input.js";
import { digest, isRecord } from "./internal-fs.js";
import {
  bindServiceLogs,
  maintainServiceLogs,
  withdrawServiceReadiness,
  writeServiceReadiness,
} from "./logs.js";
import type { ServiceRunnerActivation } from "./plist.js";

const CONFIG_MAX_BYTES = 1_048_576;
const PACKAGE_MAX_BYTES = 8_388_608;
const LOCKFILE_MAX_BYTES = 67_108_864;
const NODE_MAX_BYTES = 268_435_456;
const RUNNER_MAX_BYTES = 8_388_608;

export type ServiceSignal = "SIGINT" | "SIGTERM";
export interface ServiceSignalSource {
  once(signal: ServiceSignal, listener: () => void): unknown;
  removeListener(signal: ServiceSignal, listener: () => void): unknown;
}
export interface ForegroundServiceCommand {
  readonly configPath: string;
  readonly environmentFile?: string;
  readonly activation: string;
}
export interface ForegroundServiceTestHooks {
  readonly afterRunnerClosureRead?: () => void | Promise<void>;
  readonly afterManagedStart?: (startInfo: unknown) => void | Promise<void>;
  readonly maintenanceIntervalMilliseconds?: number;
  readonly maintainLogs?: typeof maintainServiceLogs;
}

export async function runForegroundService(
  command: ForegroundServiceCommand,
  stdout: (value: string) => void,
  signals: ServiceSignalSource,
  hooks: ForegroundServiceTestHooks = {},
): Promise<number> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("run-service requires a POSIX uid.");
  const activation = parseServiceRunnerActivation(command.activation);
  const protectedEnvironment = command.environmentFile === undefined
    ? undefined
    : await loadProtectedEnvironment(command.environmentFile, uid);
  const environmentDigest = protectedEnvironment === undefined
    ? undefined
    : digest(protectedEnvironment.source);
  if (environmentDigest !== activation.binding.environmentFileDigest) {
    throw new Error("Protected environment does not match the planned activation.");
  }
  const environment = protectedEnvironment?.values
    ?? Object.freeze(Object.create(null) as Record<string, string>);
  const packagePath = join(dirname(command.configPath), "package.json");
  const before = await readRunnerClosure(command.configPath, packagePath, activation);
  const expected = [
    activation.binding.targetConfigDigest,
    activation.binding.packageManifestDigest,
    activation.binding.lockfileDigest,
    activation.binding.nodeDigest,
    activation.binding.runnerScriptDigest,
  ];
  if (
    resolve(command.configPath) !== activation.binding.targetConfig
    || (
    activation.binding.targetKind === "agent"
      ? activation.binding.directDependencyName !== "@mono-agent/core"
      : activation.binding.directDependencyName !== "@mono-agent/web"
    )
    || readDirectDependency(
      before[1]!.source,
      activation.binding.directDependencyName,
    ) !== activation.binding.directDependencyVersion
  ) {
    throw new Error("Runner target does not match its planned direct dependency.");
  }
  if (before.some((input, index) => input.digest !== expected[index])) {
    throw new Error("Runner inputs do not match the planned activation.");
  }

  await hooks.afterRunnerClosureRead?.();
  const managed = activation.binding.targetKind === "agent"
    ? await startAgent(command.configPath, environment, activation.binding.targetConfigDigest)
    : await startWeb(command.configPath, before[0]!.source, environment);
  const proof = digest(command.activation);
  let maintenanceFailed = false;
  let maintenanceRun: Promise<void> | undefined;
  let maintenance: NodeJS.Timeout | undefined;
  let removeSignals: (() => void) | undefined;
  let readinessPublished = false;
  try {
    await hooks.afterManagedStart?.(managed.startInfo);
    const after = await readRunnerClosure(command.configPath, packagePath, activation);
    if (before.some((input, index) => input.identity !== after[index]?.identity)) {
      throw new Error("Runner inputs changed while the target was validated.");
    }
    await managed.proveHealthy();
    const logBinding = await bindServiceLogs(activation.logs, uid);
    const signal = waitForSignal(signals);
    removeSignals = signal.remove;
    await writeServiceReadiness(activation.logs, proof, process.pid, uid);
    readinessPublished = true;
    stdout(`${JSON.stringify({
      event: "started",
      serviceMacosProof: proof,
      pid: process.pid,
      targetKind: activation.binding.targetKind,
      ...managed.startInfo,
    })}\n`);
    const maintainLogs = hooks.maintainLogs ?? maintainServiceLogs;
    maintenance = setInterval(() => {
      if (maintenanceRun !== undefined) return;
      maintenanceRun = maintainLogs(activation.logs, uid, logBinding).catch(() => {
        maintenanceFailed = true;
        process.kill(process.pid, "SIGTERM");
      }).finally(() => {
        maintenanceRun = undefined;
      });
    }, hooks.maintenanceIntervalMilliseconds ?? 1_000);
    await signal.promise;
  } finally {
    if (maintenance !== undefined) clearInterval(maintenance);
    await maintenanceRun;
    removeSignals?.();
    try {
      if (readinessPublished) {
        await withdrawServiceReadiness(activation.logs, proof, process.pid, uid);
      }
    } finally {
      await managed.stop();
    }
  }
  if (maintenanceFailed) throw new Error("Service log rotation failed; the runner stopped.");
  return 0;
}

async function startAgent(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  expectedConfigDigest: string,
) {
  const validation = await validateAgentConfig(configPath, { environment });
  if (!validation.ok || validation.loaded === undefined) {
    throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  if (validation.loaded.sources.config.sha256 !== expectedConfigDigest) {
    throw new Error("Validated agent config does not match the planned activation.");
  }
  const host = await createAgentHost(validation.loaded, { environment });
  return Object.freeze({
    startInfo: host.startInfo,
    async proveHealthy(): Promise<void> {
      const health = await host.health();
      if (health.status !== "healthy" || !health.accepting) {
        throw new Error("Agent host did not become healthy.");
      }
    },
    async stop(): Promise<void> {
      try {
        await host.drain();
      } finally {
        await host.stop();
      }
    },
  });
}

async function startWeb(
  configPath: string,
  configSource: Uint8Array,
  environment: Readonly<Record<string, string>>,
) {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(configSource).toString("utf8")) as unknown;
  } catch {
    throw new Error("Fingerprint-verified web config is not valid JSON.");
  }
  const config = parseWebConfig(raw, { sourcePath: configPath, environment });
  const server = await startWebServer({ config, environment });
  return Object.freeze({
    startInfo: Object.freeze({
      address: server.address,
      port: server.port,
      dataDirectory: server.dataDirectory,
    }),
    async proveHealthy(): Promise<void> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Web health request timed out.")), 2_000);
      try {
        const response = await fetch(new URL("/healthz", server.url), {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        });
        const source = await response.text();
        let value: unknown;
        try {
          value = JSON.parse(source) as unknown;
        } catch {
          throw new Error("Web health endpoint did not return JSON.");
        }
        if (
          response.status !== 200
          || !isRecord(value)
          || Object.keys(value).length !== 1
          || value.status !== "healthy"
        ) {
          throw new Error("Web health endpoint did not return exact healthy readiness.");
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    async stop(): Promise<void> {
      await server.stop();
    },
  });
}

async function readRunnerClosure(
  configPath: string,
  packagePath: string,
  activation: ServiceRunnerActivation,
) {
  return await Promise.all([
    readServiceInput(configPath, CONFIG_MAX_BYTES),
    readServiceInput(packagePath, PACKAGE_MAX_BYTES),
    readServiceInput(activation.binding.lockfilePath, LOCKFILE_MAX_BYTES),
    readServiceInput(activation.binding.nodePath, NODE_MAX_BYTES),
    readServiceInput(activation.binding.runnerScriptPath, RUNNER_MAX_BYTES),
  ]);
}

export function parseServiceRunnerActivation(encoded: string): ServiceRunnerActivation {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Runner activation is not valid encoded JSON.");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.binding) || !isRecord(value.logs)) {
    throw new Error("Runner activation has an invalid shape.");
  }
  const binding = value.binding;
  const logs = value.logs;
  const isSha256Digest = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  if (
    Object.keys(value).some((key) => !["schemaVersion", "binding", "logs"].includes(key))
    || Object.keys(binding).some((key) => ![
      "targetKind",
      "targetConfig",
      "targetConfigDigest",
      "directDependencyName",
      "directDependencyVersion",
      "packageManifestDigest",
      "lockfilePath",
      "lockfileDigest",
      "nodePath",
      "nodeDigest",
      "runnerScriptPath",
      "runnerScriptDigest",
      "logsDirectoryIdentity",
      "environmentFileDigest",
    ].includes(key))
    || (binding.targetKind !== "agent" && binding.targetKind !== "web")
    || typeof binding.targetConfig !== "string"
    || !isAbsolute(binding.targetConfig)
    || !isSha256Digest(binding.targetConfigDigest)
    || (binding.directDependencyName !== "@mono-agent/core"
      && binding.directDependencyName !== "@mono-agent/web")
    || typeof binding.directDependencyVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(binding.directDependencyVersion)
    || !isSha256Digest(binding.packageManifestDigest)
    || typeof binding.lockfilePath !== "string"
    || !isAbsolute(binding.lockfilePath)
    || !isSha256Digest(binding.lockfileDigest)
    || typeof binding.nodePath !== "string"
    || !isAbsolute(binding.nodePath)
    || !isSha256Digest(binding.nodeDigest)
    || typeof binding.runnerScriptPath !== "string"
    || !isAbsolute(binding.runnerScriptPath)
    || !isSha256Digest(binding.runnerScriptDigest)
    || typeof binding.logsDirectoryIdentity !== "string"
    || !/^\d+:\d+:\d+:\d+$/u.test(binding.logsDirectoryIdentity)
    || (
      binding.environmentFileDigest !== undefined
      && !isSha256Digest(binding.environmentFileDigest)
    )
    || Object.keys(logs).some((key) => ![
      "directory",
      "directoryIdentity",
      "maxBytes",
      "retainFiles",
      "stdoutPath",
      "stderrPath",
      "readinessPath",
    ].includes(key))
    || typeof logs.directory !== "string"
    || !isAbsolute(logs.directory)
    || logs.directoryIdentity !== binding.logsDirectoryIdentity
    || typeof logs.stdoutPath !== "string"
    || !isAbsolute(logs.stdoutPath)
    || typeof logs.stderrPath !== "string"
    || !isAbsolute(logs.stderrPath)
    || typeof logs.readinessPath !== "string"
    || !isAbsolute(logs.readinessPath)
    || !Number.isSafeInteger(logs.maxBytes)
    || (logs.maxBytes as number) < 1
    || (logs.maxBytes as number) > 1_073_741_824
    || !Number.isSafeInteger(logs.retainFiles)
    || (logs.retainFiles as number) < 1
    || (logs.retainFiles as number) > 100
  ) {
    throw new Error("Runner activation contains invalid fields.");
  }
  return Object.freeze(value as unknown as ServiceRunnerActivation);
}

function readDirectDependency(
  source: Uint8Array,
  name: "@mono-agent/core" | "@mono-agent/web",
): unknown {
  try {
    const manifest = JSON.parse(Buffer.from(source).toString("utf8")) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest.dependencies)) return undefined;
    return manifest.dependencies[name];
  } catch {
    return undefined;
  }
}

function waitForSignal(signals: ServiceSignalSource): {
  readonly promise: Promise<void>;
  readonly remove: () => void;
} {
  let remove = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    const finish = (): void => {
      remove();
      resolvePromise();
    };
    remove = (): void => {
      signals.removeListener("SIGINT", finish);
      signals.removeListener("SIGTERM", finish);
    };
    signals.once("SIGINT", finish);
    signals.once("SIGTERM", finish);
  });
  return { promise, remove };
}
