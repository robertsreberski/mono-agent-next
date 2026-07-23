import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createAgentHost, validateAgentConfig } from "@mono-agent/core";
import type { CommandRunner } from "./command.js";
import { loadProtectedEnvironment } from "./environment.js";
import { readServiceInput } from "./input.js";
import { bindServiceLogs, maintainServiceLogs, withdrawServiceReadiness, writeServiceReadiness } from "./logs.js";
import type { ServiceMacosRuntimePaths, ServiceRunnerActivation } from "./plist.js";
import {
  applyServiceMacosPlan,
  inspectServiceMacos,
  planServiceMacos,
  planServiceMacosRemoval,
  recoverServiceMacosTransactions,
  removeServiceMacosPlan,
} from "./reconciler.js";
export type ServiceSignal = "SIGINT" | "SIGTERM";
export interface ServiceSignalSource {
  once(signal: ServiceSignal, listener: () => void): unknown;
  removeListener(signal: ServiceSignal, listener: () => void): unknown;
}
export interface ServiceMacosCliOptions {
  readonly cwd?: string; readonly stdout?: (value: string) => void; readonly stderr?: (value: string) => void;
  readonly runner?: CommandRunner; readonly runtime?: ServiceMacosRuntimePaths;
  readonly runnerScriptPath?: string; readonly signalSource?: ServiceSignalSource;
}
interface ParsedCommand {
  readonly command: "inspect" | "plan" | "apply" | "remove" | "run-service"; readonly configPath: string;
  readonly environmentFile?: string; readonly activation?: string; readonly allowMutation: boolean;
}
class UsageError extends Error {}
export async function runServiceMacosCli(
  argv: readonly string[],
  options: ServiceMacosCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value: string) => process.stderr.write(value));
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(usage());
    return 0;
  }
  try {
    const parsed = parseCommand(argv, resolve(options.cwd ?? process.cwd()));
    if (parsed.command === "run-service") {
      return await runForegroundService(parsed, stdout, options.signalSource ?? process);
    }
    const runtime = options.runtime ?? defaultRuntime(options.runnerScriptPath);
    if (parsed.command === "inspect") {
      const observations = await inspectServiceMacos(parsed.configPath, { runtime, ...(options.runner === undefined ? {} : { runner: options.runner }) });
      stdout(`${JSON.stringify({ ok: true, observations }, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "remove") {
      if (!parsed.allowMutation) throw new UsageError("remove requires the explicit --allow-mutation flag");
      await recoverServiceMacosTransactions(parsed.configPath, {
        runtime,
        allowMutation: true,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
      });
      const removalPlan = await planServiceMacosRemoval(parsed.configPath, {
        runtime,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
      });
      const observations = await removeServiceMacosPlan(removalPlan, {
        runtime,
        allowMutation: true,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
      });
      stdout(`${JSON.stringify({
        ok: true,
        operation: "remove",
        fingerprint: removalPlan.fingerprint,
        observations,
      }, null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "apply" && parsed.allowMutation) {
      await recoverServiceMacosTransactions(parsed.configPath, {
        runtime,
        allowMutation: true,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
      });
    }
    const plan = await planServiceMacos(parsed.configPath, {
      runtime,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    if (parsed.command === "plan") {
      stdout(`${JSON.stringify({ ok: true, plan }, null, 2)}\n`);
      return 0;
    }
    if (!parsed.allowMutation) throw new UsageError("apply requires the explicit --allow-mutation flag");
    const observations = await applyServiceMacosPlan(plan, {
      runtime,
      allowMutation: true,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    stdout(`${JSON.stringify({ ok: true, fingerprint: plan.fingerprint, observations }, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${usage()}`);
      return 2;
    }
    stderr(`mono-agent-service-macos: ${errorMessage(error)}\n`);
    return 1;
  }
}
export function defaultRuntime(runnerScriptPath?: string): ServiceMacosRuntimePaths {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("service-macos requires a POSIX uid.");
  if (runnerScriptPath === undefined) {
    throw new Error("runnerScriptPath must be supplied by the service-macos executable.");
  }
  return Object.freeze({
    nodePath: process.execPath,
    runnerScriptPath: resolve(runnerScriptPath),
    launchAgentsDirectory: join(homedir(), "Library", "LaunchAgents"),
    uid,
  });
}
function parseCommand(argv: readonly string[], cwd: string): ParsedCommand {
  const command = argv[0];
  if (
    command !== "inspect"
    && command !== "plan"
    && command !== "apply"
    && command !== "remove"
    && command !== "run-service"
  ) {
    throw new UsageError(`Unknown command: ${argv.join(" ")}`);
  }
  let configPath: string | undefined;
  let environmentFile: string | undefined;
  let activation: string | undefined;
  let allowMutation = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--config") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) throw new UsageError("--config requires a path");
      if (configPath !== undefined) throw new UsageError("--config may be supplied only once");
      configPath = resolve(cwd, value);
      continue;
    }
    if (argument === "--environment-file" && command === "run-service") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) throw new UsageError("--environment-file requires a path");
      if (environmentFile !== undefined) throw new UsageError("--environment-file may be supplied only once");
      environmentFile = resolve(cwd, value);
      continue;
    }
    if (argument === "--activation" && command === "run-service") {
      const value = argv[++index];
      if (value === undefined || !/^[A-Za-z0-9_-]{1,16384}$/u.test(value)) throw new UsageError("--activation requires a bounded base64url value");
      if (activation !== undefined) throw new UsageError("--activation may be supplied only once");
      activation = value;
      continue;
    }
    if (argument === "--allow-mutation" && (command === "apply" || command === "remove") && !allowMutation) {
      allowMutation = true;
      continue;
    }
    throw new UsageError(`Unknown or misplaced option: ${argument}`);
  }
  if (configPath === undefined) throw new UsageError(`${command} requires --config <path>`);
  return {
    command,
    configPath,
    ...(environmentFile === undefined ? {} : { environmentFile }),
    ...(activation === undefined ? {} : { activation }),
    allowMutation,
  };
}
async function runForegroundService(
  command: ParsedCommand,
  stdout: (value: string) => void,
  signals: ServiceSignalSource,
): Promise<number> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("run-service requires a POSIX uid.");
  if (command.activation === undefined) throw new Error("run-service requires a fingerprinted --activation.");
  const activation = parseActivation(command.activation);
  const protectedEnvironment = command.environmentFile === undefined
    ? undefined
    : await loadProtectedEnvironment(command.environmentFile, uid);
  const environmentDigest = protectedEnvironment === undefined
    ? undefined
    : createHash("sha256").update(protectedEnvironment.source).digest("hex");
  if (environmentDigest !== activation.binding.environmentFileDigest) {
    throw new Error("Protected environment does not match the planned activation.");
  }
  const environment = protectedEnvironment?.values ?? Object.freeze(Object.create(null) as Record<string, string>);
  const packagePath = join(dirname(command.configPath), "package.json");
  const before = await Promise.all([
    readServiceInput(command.configPath, 1_048_576),
    readServiceInput(packagePath, 8_388_608),
    readServiceInput(activation.binding.lockfilePath, 67_108_864),
  ]);
  const expected = [
    activation.binding.agentConfigDigest,
    activation.binding.packageManifestDigest,
    activation.binding.lockfileDigest,
  ];
  if (before.some((input, index) => input.digest !== expected[index])) {
    throw new Error("Runner inputs do not match the planned activation.");
  }
  const validation = await validateAgentConfig(command.configPath, { environment });
  if (!validation.ok || validation.loaded === undefined) {
    throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  const after = await Promise.all([
    readServiceInput(command.configPath, 1_048_576),
    readServiceInput(packagePath, 8_388_608),
    readServiceInput(activation.binding.lockfilePath, 67_108_864),
  ]);
  if (
    before.some((input, index) => input.identity !== after[index]?.identity)
    || validation.loaded.sources.config.sha256 !== activation.binding.agentConfigDigest
  ) throw new Error("Runner inputs changed or do not match the planned activation.");
  const host = await createAgentHost(validation.loaded, { environment });
  const proof = createHash("sha256").update(command.activation).digest("hex");
  let maintenanceFailed = false;
  let maintenanceRun: Promise<void> | undefined;
  let maintenance: NodeJS.Timeout | undefined;
  let removeSignals: (() => void) | undefined;
  try {
    const health = await host.health();
    if (health.status !== "healthy" || !health.accepting) throw new Error("Agent host did not become healthy.");
    const logBinding = await bindServiceLogs(activation.logs, uid);
    const signal = waitForSignal(signals);
    removeSignals = signal.remove;
    await writeServiceReadiness(activation.logs, proof, process.pid, uid);
    stdout(`${JSON.stringify({ event: "started", serviceMacosProof: proof, pid: process.pid, ...host.startInfo })}\n`);
    maintenance = setInterval(() => {
      if (maintenanceRun !== undefined) return;
      maintenanceRun = maintainServiceLogs(activation.logs, uid, logBinding).catch(() => {
        maintenanceFailed = true; process.kill(process.pid, "SIGTERM");
      }).finally(() => { maintenanceRun = undefined; });
    }, 1_000);
    await signal.promise;
  } finally {
    if (maintenance !== undefined) clearInterval(maintenance);
    await maintenanceRun;
    removeSignals?.();
    try {
      await withdrawServiceReadiness(activation.logs, proof, process.pid, uid);
    } finally {
      try { await host.drain(); } finally { await host.stop(); }
    }
  }
  if (maintenanceFailed) throw new Error("Service log rotation failed; the runner stopped.");
  return 0;
}
function parseActivation(encoded: string): ServiceRunnerActivation {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Runner activation is not valid encoded JSON.");
  }
  if (!record(value) || value.schemaVersion !== 1 || !record(value.binding) || !record(value.logs)) {
    throw new Error("Runner activation has an invalid shape.");
  }
  const binding = value.binding;
  const logs = value.logs;
  const digest = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  if (
    Object.keys(value).some((key) => !["schemaVersion", "binding", "logs"].includes(key))
    || Object.keys(binding).some((key) => !["agentConfigDigest", "packageManifestDigest", "lockfilePath", "lockfileDigest", "logsDirectoryIdentity", "environmentFileDigest"].includes(key))
    || !digest(binding.agentConfigDigest) || !digest(binding.packageManifestDigest)
    || typeof binding.lockfilePath !== "string" || !isAbsolute(binding.lockfilePath) || !digest(binding.lockfileDigest)
    || typeof binding.logsDirectoryIdentity !== "string" || !/^\d+:\d+:\d+:\d+$/u.test(binding.logsDirectoryIdentity)
    || (binding.environmentFileDigest !== undefined && !digest(binding.environmentFileDigest))
    || Object.keys(logs).some((key) => !["directory", "directoryIdentity", "maxBytes", "retainFiles", "stdoutPath", "stderrPath", "readinessPath"].includes(key))
    || typeof logs.directory !== "string" || !isAbsolute(logs.directory)
    || logs.directoryIdentity !== binding.logsDirectoryIdentity
    || typeof logs.stdoutPath !== "string" || !isAbsolute(logs.stdoutPath)
    || typeof logs.stderrPath !== "string" || !isAbsolute(logs.stderrPath)
    || typeof logs.readinessPath !== "string" || !isAbsolute(logs.readinessPath)
    || !Number.isSafeInteger(logs.maxBytes) || (logs.maxBytes as number) < 1 || (logs.maxBytes as number) > 1_073_741_824
    || !Number.isSafeInteger(logs.retainFiles) || (logs.retainFiles as number) < 1 || (logs.retainFiles as number) > 100
  ) throw new Error("Runner activation contains invalid fields.");
  return Object.freeze(value as unknown as ServiceRunnerActivation);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function waitForSignal(signals: ServiceSignalSource): { readonly promise: Promise<void>; readonly remove: () => void } {
  let remove = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    const finish = (): void => {
      remove();
      resolve();
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
function usage(): string {
  return `Usage:
  mono-agent-service-macos inspect --config <service-macos.json>
  mono-agent-service-macos plan --config <service-macos.json>
  mono-agent-service-macos apply --config <service-macos.json> --allow-mutation
  mono-agent-service-macos remove --config <service-macos.json> --allow-mutation
`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
