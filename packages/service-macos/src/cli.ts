import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandRunner } from "./command.js";
import type { ServiceMacosRuntimePaths } from "./plist.js";
import {
  applyServiceMacosPlan,
  inspectServiceMacos,
  planRestartServiceMacos,
  planServiceMacos,
  planServiceMacosRemoval,
  planStartServiceMacos,
  planStopServiceMacos,
  readServiceMacosLogs,
  recoverServiceMacosTransactions,
  removeServiceMacosPlan,
  restartServiceMacos,
  startServiceMacos,
  statusServiceMacos,
  stopServiceMacos,
} from "./reconciler.js";
import {
  runForegroundService,
  type ServiceSignalSource,
} from "./runner.js";

export type { ServiceSignal, ServiceSignalSource } from "./runner.js";

export interface ServiceMacosCliOptions {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly runner?: CommandRunner;
  readonly runtime?: ServiceMacosRuntimePaths;
  readonly runnerScriptPath?: string;
  readonly signalSource?: ServiceSignalSource;
}
type PublicCommand =
  | "inspect"
  | "plan"
  | "apply"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "logs"
  | "remove";
interface ParsedCommand {
  readonly command: PublicCommand | "run-service";
  readonly configPath: string;
  readonly serviceId?: string;
  readonly environmentFile?: string;
  readonly activation?: string;
  readonly maxBytes?: number;
  readonly allowMutation: boolean;
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
      if (parsed.activation === undefined) {
        throw new Error("run-service requires a fingerprinted --activation.");
      }
      return await runForegroundService({
        configPath: parsed.configPath,
        activation: parsed.activation,
        ...(parsed.environmentFile === undefined
          ? {}
          : { environmentFile: parsed.environmentFile }),
      }, stdout, options.signalSource ?? process);
    }
    const runtime = options.runtime ?? defaultRuntime(options.runnerScriptPath);
    const runner = options.runner === undefined ? {} : { runner: options.runner };
    if (parsed.command === "inspect") {
      const observations = await inspectServiceMacos(parsed.configPath, { runtime, ...runner });
      writeJson(stdout, { ok: true, observations });
      return 0;
    }
    if (parsed.command === "status") {
      const status = await statusServiceMacos(parsed.configPath, {
        runtime,
        ...runner,
        serviceId: requireServiceId(parsed),
      });
      writeJson(stdout, { ok: true, status });
      return 0;
    }
    if (parsed.command === "logs") {
      const logs = await readServiceMacosLogs(parsed.configPath, {
        runtime,
        ...runner,
        serviceId: requireServiceId(parsed),
        ...(parsed.maxBytes === undefined ? {} : { maxBytes: parsed.maxBytes }),
      });
      writeJson(stdout, { ok: true, logs });
      return 0;
    }
    if (parsed.command === "remove") {
      requireMutation(parsed);
      const serviceId = requireServiceId(parsed);
      await recoverServiceMacosTransactions(parsed.configPath, {
        runtime,
        ...runner,
        serviceId,
        allowMutation: true,
      });
      const plan = await planServiceMacosRemoval(parsed.configPath, {
        runtime,
        ...runner,
        serviceId,
      });
      const observation = (await removeServiceMacosPlan(plan, {
        runtime,
        ...runner,
        allowMutation: true,
      }))[0];
      writeJson(stdout, {
        ok: true,
        operation: "remove",
        fingerprint: plan.fingerprint,
        observation,
      });
      return 0;
    }
    if (parsed.command === "stop") {
      requireMutation(parsed);
      const serviceId = requireServiceId(parsed);
      await recoverServiceMacosTransactions(parsed.configPath, {
        runtime,
        ...runner,
        serviceId,
        allowMutation: true,
      });
      const plan = await planStopServiceMacos(parsed.configPath, {
        runtime,
        ...runner,
        serviceId,
      });
      const observation = await stopServiceMacos(plan, {
        runtime,
        ...runner,
        allowMutation: true,
      });
      writeJson(stdout, {
        ok: true,
        operation: "stop",
        fingerprint: plan.fingerprint,
        observation,
      });
      return 0;
    }
    if (parsed.command === "start" || parsed.command === "restart") {
      requireMutation(parsed);
      const serviceId = requireServiceId(parsed);
      await recoverServiceMacosTransactions(parsed.configPath, {
        runtime,
        ...runner,
        serviceId,
        allowMutation: true,
      });
      const selected = { runtime, ...runner, serviceId };
      const plan = parsed.command === "start"
        ? await planStartServiceMacos(parsed.configPath, selected)
        : await planRestartServiceMacos(parsed.configPath, selected);
      const mutation = { runtime, ...runner, allowMutation: true };
      const observation = parsed.command === "start"
        ? await startServiceMacos(plan, mutation)
        : await restartServiceMacos(plan, mutation);
      writeJson(stdout, {
        ok: true,
        operation: parsed.command,
        fingerprint: plan.fingerprint,
        observation,
      });
      return 0;
    }
    if (parsed.command === "apply" && parsed.allowMutation) {
      await recoverServiceMacosTransactions(parsed.configPath, {
        runtime,
        ...runner,
        allowMutation: true,
      });
    }
    const plan = await planServiceMacos(parsed.configPath, { runtime, ...runner });
    if (parsed.command === "plan") {
      writeJson(stdout, { ok: true, plan });
      return 0;
    }
    requireMutation(parsed);
    const observations = await applyServiceMacosPlan(plan, {
      runtime,
      ...runner,
      allowMutation: true,
    });
    writeJson(stdout, { ok: true, fingerprint: plan.fingerprint, observations });
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
  if (!isCommand(command)) throw new UsageError(`Unknown command: ${argv.join(" ")}`);
  let configPath: string | undefined;
  let serviceId: string | undefined;
  let environmentFile: string | undefined;
  let activation: string | undefined;
  let maxBytes: number | undefined;
  let allowMutation = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--config") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--config requires a path");
      }
      if (configPath !== undefined) throw new UsageError("--config may be supplied only once");
      configPath = resolve(cwd, value);
      continue;
    }
    if (argument === "--service" && command !== "run-service") {
      const value = argv[++index];
      if (value === undefined || !/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(value)) {
        throw new UsageError("--service requires a valid configured service id");
      }
      if (serviceId !== undefined) throw new UsageError("--service may be supplied only once");
      serviceId = value;
      continue;
    }
    if (argument === "--max-bytes" && command === "logs") {
      const value = argv[++index];
      if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
        throw new UsageError("--max-bytes requires a positive integer");
      }
      maxBytes = Number(value);
      if (!Number.isSafeInteger(maxBytes) || maxBytes > 1_048_576) {
        throw new UsageError("--max-bytes must not exceed 1048576");
      }
      continue;
    }
    if (argument === "--environment-file" && command === "run-service") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--environment-file requires a path");
      }
      if (environmentFile !== undefined) {
        throw new UsageError("--environment-file may be supplied only once");
      }
      environmentFile = resolve(cwd, value);
      continue;
    }
    if (argument === "--activation" && command === "run-service") {
      const value = argv[++index];
      if (value === undefined || !/^[A-Za-z0-9_-]{1,16384}$/u.test(value)) {
        throw new UsageError("--activation requires a bounded base64url value");
      }
      if (activation !== undefined) throw new UsageError("--activation may be supplied only once");
      activation = value;
      continue;
    }
    if (
      argument === "--allow-mutation"
      && ["apply", "start", "stop", "restart", "remove"].includes(command)
      && !allowMutation
    ) {
      allowMutation = true;
      continue;
    }
    throw new UsageError(`Unknown or misplaced option: ${argument}`);
  }
  if (configPath === undefined) throw new UsageError(`${command} requires --config <path>`);
  const serviceCommands = ["start", "stop", "restart", "status", "logs", "remove"];
  if (serviceCommands.includes(command) && serviceId === undefined) {
    throw new UsageError(`${command} requires --service <id>`);
  }
  if (!serviceCommands.includes(command) && serviceId !== undefined) {
    throw new UsageError(`--service is not valid for ${command}`);
  }
  return {
    command,
    configPath,
    ...(serviceId === undefined ? {} : { serviceId }),
    ...(environmentFile === undefined ? {} : { environmentFile }),
    ...(activation === undefined ? {} : { activation }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    allowMutation,
  };
}

function isCommand(value: string | undefined): value is ParsedCommand["command"] {
  return value !== undefined && [
    "inspect",
    "plan",
    "apply",
    "start",
    "stop",
    "restart",
    "status",
    "logs",
    "remove",
    "run-service",
  ].includes(value);
}
function requireServiceId(command: ParsedCommand): string {
  if (command.serviceId === undefined) throw new UsageError(`${command.command} requires --service <id>`);
  return command.serviceId;
}
function requireMutation(command: ParsedCommand): void {
  if (!command.allowMutation) {
    throw new UsageError(`${command.command} requires the explicit --allow-mutation flag`);
  }
}
function writeJson(stdout: (value: string) => void, value: unknown): void {
  stdout(`${JSON.stringify(value, null, 2)}\n`);
}
function usage(): string {
  return `Usage:
  mono-agent-service-macos inspect --config <service-macos.json>
  mono-agent-service-macos plan --config <service-macos.json>
  mono-agent-service-macos apply --config <service-macos.json> --allow-mutation
  mono-agent-service-macos start --config <service-macos.json> --service <id> --allow-mutation
  mono-agent-service-macos stop --config <service-macos.json> --service <id> --allow-mutation
  mono-agent-service-macos restart --config <service-macos.json> --service <id> --allow-mutation
  mono-agent-service-macos status --config <service-macos.json> --service <id>
  mono-agent-service-macos logs --config <service-macos.json> --service <id> [--max-bytes <bytes>]
  mono-agent-service-macos remove --config <service-macos.json> --service <id> --allow-mutation
`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
