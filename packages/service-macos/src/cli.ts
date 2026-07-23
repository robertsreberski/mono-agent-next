import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createAgentHost, validateAgentConfig } from "@mono-agent/core";

import type { CommandRunner } from "./command.js";
import { loadProtectedEnvironment } from "./environment.js";
import type { ServiceMacosRuntimePaths } from "./plist.js";
import {
  applyServiceMacosPlan,
  inspectServiceMacos,
  planServiceMacos,
  planServiceMacosRemoval,
  removeServiceMacosPlan,
} from "./reconciler.js";

export type ServiceSignal = "SIGINT" | "SIGTERM";

export interface ServiceSignalSource {
  once(signal: ServiceSignal, listener: () => void): unknown;
  removeListener(signal: ServiceSignal, listener: () => void): unknown;
}

export interface ServiceMacosCliOptions {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly runner?: CommandRunner;
  readonly runtime?: ServiceMacosRuntimePaths;
  readonly runnerScriptPath?: string;
  readonly signalSource?: ServiceSignalSource;
}

interface ParsedCommand {
  readonly command: "inspect" | "plan" | "apply" | "remove" | "run-service";
  readonly configPath: string;
  readonly environmentFile?: string;
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
  const protectedEnvironment = command.environmentFile === undefined
    ? undefined
    : await loadProtectedEnvironment(command.environmentFile, uid);
  const environment = protectedEnvironment === undefined
    ? process.env
    : { ...protectedEnvironment.values, ...process.env };
  const validation = await validateAgentConfig(command.configPath, { environment });
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  const host = await createAgentHost(command.configPath, { environment });
  stdout(`${JSON.stringify({ event: "started", ...host.startInfo })}\n`);
  await waitForSignal(signals);
  await host.drain();
  await host.stop();
  return 0;
}

async function waitForSignal(signals: ServiceSignalSource): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      signals.removeListener("SIGINT", finish);
      signals.removeListener("SIGTERM", finish);
      resolve();
    };
    signals.once("SIGINT", finish);
    signals.once("SIGTERM", finish);
  });
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
