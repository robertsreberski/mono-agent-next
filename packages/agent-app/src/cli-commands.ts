#!/usr/bin/env node
// Internal command implementation; `cli.ts` remains the stable public/bin facade.
import { basename, resolve } from "node:path";
import process from "node:process";
import { runBackfill } from "./backfill.js";
import {
  MANAGED_BACKGROUND_WORKER_ENV,
  sanitizeManagedBackgroundWorkerEnvironment,
} from "./background-runtime.js";
import { isBackgroundOperationalEnvName } from "./background-environment.js";
import { readCliDotenvFile } from "./first-run-readiness.js";
import { loadCliEnvFile, parseCliArgs } from "./cli-args.js";
import type { ParsedCliArgs } from "./cli-args.js";
export { loadCliEnvFile, parseCliArgs } from "./cli-args.js";
import { monoAgentVersion, renderHelp, renderHelpTopic } from "./cli-help.js";
export { monoAgentVersion, renderHelp, renderHelpTopic } from "./cli-help.js";
import { runInstallSkill } from "./cli-install-skill-command.js";
import { runConfig, runPresets, runValidate } from "./cli-validate-config-command.js";
export {
  presetShowData,
  renderConfigView,
  renderPresetList,
  renderPresetShow,
} from "./cli-validate-config-command.js";
import { runAuth, runInit } from "./cli-init-command.js";
export {
  identityRoleDisplayLine,
  initChangeDisplayRows,
  readApiKeyFromStdin,
  resolvePiAuthPathForLogin,
  runProviderSetupBeforeInit,
  secretChecklistDisplayRows,
  shouldRunInitWizard,
} from "./cli-init-command.js";
export type {
  InitChangeDisplayRow,
  InitProviderSetupStatus,
  RunProviderSetupBeforeInitOptions,
  SecretChecklistDisplayRow,
} from "./cli-init-command.js";
import {
  runBackgroundCommand,
  runLaunchdLogMaintenanceCommand,
  runStart,
} from "./cli-background-command.js";
export {
  describeChannelStatus,
  ensureStartable,
  printAppStatus,
  waitForShutdownSignal,
} from "./cli-background-command.js";
export type {
  PreflightResult,
  PrintAppStatusOptions,
} from "./cli-background-command.js";
import { runRunsCommand } from "./cli-runs-command.js";
import {
  INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND,
  MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV,
} from "./launchd.js";
import { runSandboxCommand } from "./cli-sandbox-command.js";
export { runSandboxCommand } from "./cli-sandbox-command.js";
export type { SandboxCommandDependencies } from "./cli-sandbox-command.js";
import * as ui from "./ui.js";

interface ValidateContext {
  readonly cwd: string;
  readonly configPath: string;
  readonly envFilePath: string;
  readonly allowFilesystemWrites: boolean;
}

function resolveValidateContext(args: ParsedCliArgs, invocationCwd: string): ValidateContext {
  const cwd = resolve(invocationCwd, args.consumerPath ?? ".");
  return {
    cwd,
    configPath: resolve(cwd, args.configPath ?? "mono-agent.config.json"),
    envFilePath: resolve(cwd, args.envFile ?? ".env"),
    allowFilesystemWrites: args.consumerPath === undefined,
  };
}


export async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (argv[0] === "memory" && argv.includes("adopt-replay")) {
      const { writeReplayAdoptionCliFailure } = await import("./memory-command.js");
      writeReplayAdoptionCliFailure(argv.includes("--json"), "replay_adoption_usage");
      return 2;
    }
    if (argv[0] === "memory" && argv.includes("forget")) {
      const { writeMemoryForgetFailure } = await import("./memory-command.js");
      const operationIndex = argv.indexOf("forget") + 1;
      writeMemoryForgetFailure(argv.includes("--json"), argv[operationIndex] ?? "unknown", "forget_usage");
      return 2;
    }
    process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
    process.stdout.write(`\n${renderHelp()}`);
    return 2;
  }

  const managedLaunchdLogMaintenance =
    args.command === INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND
    && process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] === "1";
  if (args.command === INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND) {
    if (!managedLaunchdLogMaintenance) {
      process.stderr.write(ui.errorLine("The launchd log maintenance command is reserved for its managed LaunchAgent."));
      return 2;
    }
    sanitizeManagedLaunchdLogMaintenanceEnvironment(process.env);
    return await runLaunchdLogMaintenanceCommand(args);
  }
  if (process.env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] === "1") {
    process.stderr.write(ui.errorLine("The managed log-maintenance marker cannot authorize another CLI command."));
    return 2;
  }

  // Only the internal launchd foreground shape may honor the managed-worker
  // marker. A hostile/global launchctl environment must not sanitize unrelated
  // commands such as `mono-agent validate` or `mono-agent status`.
  const managedBackgroundWorker =
    args.command === "start" && args.foreground && process.env[MANAGED_BACKGROUND_WORKER_ENV] === "1";
  if (args.expectedBackgroundSnapshot !== undefined && !managedBackgroundWorker) {
    process.stderr.write(ui.errorLine("--expected-background-snapshot is reserved for the managed LaunchAgent worker."));
    return 2;
  }
  if (args.expectedManagedRuntimeLaunch !== undefined && !managedBackgroundWorker) {
    process.stderr.write(ui.errorLine("--expected-managed-runtime-launch is reserved for the managed LaunchAgent worker."));
    return 2;
  }
  if (managedBackgroundWorker) {
    sanitizeManagedBackgroundWorkerEnvironment(process.env);
  }

  if (args.command === "memory"
    && args.positionals[0] === "adopt-replay"
    && hasUnsupportedReplayAdoptionFlag(argv)) {
    const { writeReplayAdoptionCliFailure } = await import("./memory-command.js");
    writeReplayAdoptionCliFailure(args.json === true, "replay_adoption_usage");
    return 2;
  }
  if (args.command === "memory"
    && args.positionals[0] === "forget"
    && hasUnsupportedMemoryForgetFlag(argv)) {
    const { writeMemoryForgetFailure } = await import("./memory-command.js");
    writeMemoryForgetFailure(args.json === true, args.positionals[1] ?? "unknown", "forget_usage");
    return 2;
  }

  const invocationCwd = process.cwd();
  // Capture the exported shell before dotenv loading. Guided init retains only
  // worker-operational values and reports shell/background credential drift;
  // normal CLI commands still get the established shell-over-dotenv precedence.
  const shellEnv = { ...process.env };
  const envFilePath = args.command === "validate"
    ? resolveValidateContext(args, invocationCwd).envFilePath
    : resolve(invocationCwd, args.envFile ?? ".env");
  let dotenvEnv: Record<string, string> = {};
  if (args.command === "init") {
    try {
      dotenvEnv = await readCliDotenvFile(envFilePath);
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Cannot read ${envFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return 1;
    }
  }
  // The machine-wide web console is not an agent/config consumer. In
  // particular, its managed `web run` worker must never ingest an arbitrary
  // .env from whichever directory invoked the controller.
  // Managed workers must first wait for runtime publication and verify the
  // finalized closure. Their foreground entrypoint loads dotenv immediately
  // after that barrier, before snapshot materialization.
  if (shouldLoadCommandDotenv(args.command) && !managedBackgroundWorker) loadCliEnvFile(envFilePath);

  switch (args.command) {
    case "help": {
      const topic = args.positionals[0];
      if (topic === undefined) {
        process.stdout.write(renderHelp());
        return 0;
      }
      const result = renderHelpTopic(topic);
      if (result.ok) {
        process.stdout.write(result.text);
        return 0;
      }
      process.stderr.write(ui.errorLine(result.message));
      return 2;
    }
    case "version":
      process.stdout.write(`mono-agent ${monoAgentVersion()}\n`);
      return 0;
    case "init":
      return await runInit(args, { shellEnv, dotenvEnv, dotenvPath: envFilePath });
    case "validate":
      return await runValidate(args);
    case "auth":
      return await runAuth(args);
    case "sandbox":
      return await runSandboxCommand(args);
    case "config":
      return await runConfig(args);
    case "presets":
      return runPresets(args);
    case "start":
      return await runStart(args, undefined, managedBackgroundWorker);
    case "restart":
    case "stop":
    case "status":
    case "logs":
      return await runBackgroundCommand(args, args.command);
    case "tui": {
      // Lazy import: the operator console (and pi-tui) load only on demand.
      const { runTui } = await import("./tui-command.js");
      return await runTui({
        configPath: resolve(process.cwd(), args.configPath ?? "mono-agent.config.json"),
        cwd: process.cwd(),
        env: process.env,
        ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
        ...(args.agent === undefined ? {} : { agent: args.agent }),
        ...(args.conversation === undefined ? {} : { conversationId: args.conversation }),
        ...(args.local === true ? { local: true } : {}),
        ...(args.configure === true ? { configure: true } : {}),
      });
    }
    case "web": {
      // Lazy import: assistant-ui and the persistent web store load only on demand.
      const { runWebCommand } = await import("./web-command.js");
      return await runWebCommand({
        positionals: args.positionals,
        env: process.env,
        ...(args.host === undefined ? {} : { host: args.host }),
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.loopback === true ? { loopback: true } : {}),
        ...(args.follow === true ? { follow: true } : {}),
        ...(args.lines === undefined ? {} : { lines: args.lines }),
        ...(args.all === true ? { all: true } : {}),
        ...(args.yes === true ? { yes: true } : {}),
      });
    }
    case "install-skill":
      return await runInstallSkill(args);
    case "continuations": {
      const { runContinuationCommand } = await import("./continuation-command.js");
      return await runContinuationCommand({
        cwd: process.cwd(),
        configPath: resolve(process.cwd(), args.configPath ?? "mono-agent.config.json"),
        env: process.env,
        positionals: args.positionals,
        ...(args.json === true ? { json: true } : {}),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      });
    }
    case "backfill":
      return await runBackfill({
        ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
        ...(args.run === undefined ? {} : { run: args.run }),
        all: args.all,
        ...(args.since === undefined ? {} : { since: args.since }),
        ...(args.until === undefined ? {} : { until: args.until }),
        dryRun: args.dryRun,
        includeMemory: args.includeMemory,
      });
    case "runs":
      return await runRunsCommand(args);
    case "memory": {
      // Lazy import: the memory preview path pulls SQLite/backend clients only on demand.
      const { runMemoryCommand } = await import("./memory-command.js");
      return await runMemoryCommand({
        cwd: process.cwd(),
        env: process.env,
        ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
        positionals: args.positionals,
        json: args.json === true,
        strict: args.strict === true,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.idsFile === undefined ? {} : { idsFile: args.idsFile }),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(args.planPath === undefined ? {} : { planPath: args.planPath }),
        ...(args.backupPath === undefined ? {} : { backupPath: args.backupPath }),
      });
    }
  }
}

export function shouldLoadCommandDotenv(command: ParsedCliArgs["command"]): boolean {
  return command !== "web";
}

function sanitizeManagedLaunchdLogMaintenanceEnvironment(
  env: Record<string, string | undefined>,
): void {
  for (const name of Object.keys(env)) {
    if (name !== MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV && !isBackgroundOperationalEnvName(name)) {
      delete env[name];
    }
  }
  delete env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV];
}

/**
 * `adopt-replay` is a stopped-store trust boundary, so command-global flags
 * must never be silently ignored. In particular, `--dry-run` cannot be parsed
 * successfully and then execute the mutation. Validate the raw invocation so
 * future parser flags also fail closed unless they are explicitly admitted.
 */
function hasUnsupportedReplayAdoptionFlag(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config" || token === "--env-file") {
      index += 1;
      continue;
    }
    if (token === "--json") continue;
    if (token?.startsWith("-") === true) return true;
  }
  return false;
}

/** Forget is mutating, so every accepted command-global flag is explicit. */
function hasUnsupportedMemoryForgetFlag(argv: readonly string[]): boolean {
  const valueFlags = new Set(["--config", "--env-file", "--ids-file", "--reason", "--plan", "--backup"]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== undefined && valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (token === "--json") continue;
    if (token?.startsWith("-") === true) return true;
  }
  return false;
}

const cliEntryName = process.argv[1] === undefined ? undefined : basename(process.argv[1]);
const isDirectCliInvocation = cliEntryName === "cli.js" || cliEntryName === "mono-agent";
if (isDirectCliInvocation) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${ui.style.red("✗")} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
