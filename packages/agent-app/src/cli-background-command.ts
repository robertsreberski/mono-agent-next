import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { listRecordedRuns } from "@mono-agent/observability";
import {
  describeSandboxEffectiveState,
  sandboxEffectiveStateWarning,
} from "@mono-agent/runtime-adapter";

import { startMonoAgentApp } from "./app.js";
import type { ExporterStatus, MonoAgentApp, SandboxStatus } from "./app.js";
import { startVerifiedManagedMonoAgentApp } from "./app-controller.js";
import {
  describeSensitiveDataExportWarning,
  phoenixAppBaseUrl,
} from "./app-config.js";
import {
  acquireBackgroundWorkerLease,
  canonicalBackgroundConfigPath,
  defaultBackgroundDeps,
  forceRestartBackground,
  maintainLaunchdController,
  managedBackgroundEnvironment,
  resolveInstanceTarget,
  restartBackground,
  startBackground,
  statusBackground,
  stopBackground,
  tailLogs,
} from "./background.js";
import type { BackgroundDeps, InstanceTarget } from "./background.js";
import {
  captureBackgroundSnapshot,
  decodeBackgroundSnapshot,
  loadDurableBackgroundEnvironment,
  materializeBackgroundRuntimeInputs,
} from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { verifyManagedRuntimeLaunch } from "./background-runtime.js";
import type { ManagedRuntimeLaunchVerification } from "./background-runtime.js";
import { formatChannelFactValue } from "./channel-fact-format.js";
import { formatHumanChannelSections } from "./channel-status-display.js";
import type { ChannelStatus } from "./channels.js";
import { loadCliEnvFile } from "./cli-args.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type {
  ValidationReport,
  ValidationSection,
  ValidationStatus,
} from "./doctor.js";
import { readCliConfigSnapshot } from "./first-run-readiness.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import { purgeConversationState } from "./sessions.js";
import { deriveLaunchdLabel, launchdPathsFor } from "./launchd.js";
import { waitForManagedRuntimePublication } from "./managed-runtime-publication.js";
import * as ui from "./ui.js";

const DEFAULT_LOG_LINES = 200;
// Node's maximum setInterval/setTimeout delay (2^31 - 1 ms, ~24.8 days).
const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;
const BACKGROUND_COMMANDS = ["start", "restart", "stop", "status", "logs"] as const;

function formatSection(section: ValidationSection): string {
  let out = `${ui.badge(section.status)}${ui.style.bold(section.label)}\n`;
  for (const detail of section.details) {
    out += `    ${colorDetail(section.status, detail)}\n`;
  }
  return out;
}

function colorDetail(status: ValidationStatus, detail: string): string {
  if (status === "error") return ui.style.red(detail);
  if (detail.startsWith("[WARN]") || detail.startsWith("WARNING:")) {
    return ui.style.yellow(detail);
  }
  return ui.style.dim(detail);
}

/**
 * Outcome of the start/restart preflight. `code` is the process exit status to
 * return when refusing: 2 for a missing config file (a usage problem, matching
 * the arg-parse convention) and 1 for a config that loads but has errors.
 */
export type PreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 2; readonly kind: "missing-config"; readonly configPath: string }
  | { readonly ok: false; readonly code: 1; readonly kind: "validation"; readonly report: ValidationReport };

type PreflightFailure = Extract<PreflightResult, { ok: false }>;

/**
 * Gate for `start`/`restart`: refuse unless the directory has a present, valid
 * config. First the config FILE must exist (env vars alone are not enough — a
 * folder without a config is not a configured agent). Then run the structural
 * validation with `liveness:false` (network probes only yield `waiting`, never
 * `error`, so skipping them keeps the verdict while avoiding bounded network
 * timeouts) and refuse on any `error` section. `waiting` (e.g.
 * Ollama/Supermemory/Phoenix not up yet) is runtime-soft and never blocks.
 */
export async function ensureStartable(
  args: ParsedCliArgs,
  env: Record<string, string | undefined> = process.env,
  options: {
    readonly cwd?: string;
    readonly configPath?: string;
    readonly preferAppPluginInstall?: boolean;
    readonly verifiedRuntimeProvenanceDetail?: string;
  } = {},
): Promise<PreflightResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolve(cwd, args.configPath ?? "mono-agent.config.json");
  if (!(await pathExists(configPath))) {
    return { ok: false, code: 2, kind: "missing-config", configPath };
  }
  const report = await validateMonoAgentFolder({
    env,
    cwd,
    configPath,
    liveness: false,
    ...(options.preferAppPluginInstall === true ? { preferAppPluginInstall: true } : {}),
    ...(options.verifiedRuntimeProvenanceDetail === undefined
      ? {}
      : { verifiedRuntimeProvenanceDetail: options.verifiedRuntimeProvenanceDetail }),
  });
  if (!report.structurallyValid) {
    return { ok: false, code: 1, kind: "validation", report };
  }
  return { ok: true };
}

function printPreflightFailure(result: PreflightFailure): void {
  if (result.kind === "missing-config") {
    process.stderr.write(ui.errorLine(`No mono-agent config found at ${result.configPath}.`));
    process.stderr.write(ui.hint("Run `mono-agent init` to scaffold one, or pass --config <path>."));
    return;
  }
  process.stderr.write(ui.heading("Cannot start: config has errors"));
  for (const section of result.report.sections) {
    if (section.status === "error") {
      process.stderr.write(formatSection(section));
    }
  }
  process.stderr.write(ui.hint("Run `mono-agent validate` for the full report, fix the errors, then retry."));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runStart(
  args: ParsedCliArgs,
  env?: Record<string, string | undefined>,
  managedBackgroundWorker = false,
): Promise<number> {
  if (args.foreground) {
    return await runForeground(args, env, managedBackgroundWorker);
  }
  return await runBackgroundCommand(args, "start", env);
}

/**
 * The blocking worker: builds the responder, starts every configured channel
 * plus traceability, and stays alive until a signal. This is what launchd
 * invokes (via `start --foreground`) and what users get with `--foreground`/`-f`.
 */
async function runForeground(
  args: ParsedCliArgs,
  env: Record<string, string | undefined> = process.env,
  managedBackgroundWorker = false,
): Promise<number> {
  const cwd = process.cwd();
  const configPath = await canonicalBackgroundConfigPath(cwd, args.configPath);

  let managedRuntime: ManagedRuntimeLaunchVerification | undefined;
  if (managedBackgroundWorker) {
    try {
      const label = deriveLaunchdLabel(configPath);
      const paths = launchdPathsFor(label);
      await waitForManagedRuntimePublication({
        label,
        managedRoot: dirname(paths.logDir),
      });
      if (args.expectedBackgroundSnapshot === undefined) {
        process.stderr.write(ui.errorLine("Managed LaunchAgent worker is missing its approved background snapshot."));
        return 0;
      }
      if (args.expectedManagedRuntimeLaunch === undefined) {
        process.stderr.write(ui.errorLine("Managed LaunchAgent worker is missing its finalized runtime proof."));
        return 0;
      }
      managedRuntime = await verifyManagedRuntimeLaunch({
        currentCliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
        launchProof: args.expectedManagedRuntimeLaunch,
      });
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Managed worker could not verify its finalized runtime: ${error instanceof Error ? error.message : String(error)}`,
      ));
      // KeepAlive restarts only unsuccessful exits. A controller must publish a
      // fresh proven plist before this worker can safely recover.
      return 0;
    }
  }
  if (managedBackgroundWorker) {
    loadCliEnvFile(resolve(cwd, args.envFile ?? ".env"));
  }
  const startupEnvironment = { ...env };

  let lease;
  try {
    lease = await acquireBackgroundWorkerLease(configPath);
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Could not acquire the worker singleton lease: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  if (lease === undefined) {
    process.stderr.write(ui.errorLine(
      `Another foreground or managed background worker already owns ${configPath}; refusing to start a duplicate.`,
    ));
    return 1;
  }

  let runtimeInputs: Awaited<ReturnType<typeof materializeBackgroundRuntimeInputs>> | undefined;
  let app: MonoAgentApp | undefined;
  try {
    let backgroundSnapshot: BackgroundSnapshot | undefined;
    if (managedBackgroundWorker) {
      try {
        backgroundSnapshot = decodeBackgroundSnapshot(args.expectedBackgroundSnapshot ?? "");
        const dotenvPath = resolve(cwd, args.envFile ?? ".env");
        if (backgroundSnapshot.configPath !== configPath || backgroundSnapshot.dotenvPath !== dotenvPath) {
          throw new Error("The approved snapshot paths do not match the managed worker arguments.");
        }
        runtimeInputs = await materializeBackgroundRuntimeInputs({
          snapshot: backgroundSnapshot,
          cwd,
          env: startupEnvironment,
        });
      } catch (error) {
        process.stderr.write(ui.errorLine(
          `Managed worker could not freeze its startup snapshot: ${error instanceof Error ? error.message : String(error)}`,
        ));
        // KeepAlive restarts only unsuccessful exits. This refusal cannot heal
        // without a new approved snapshot, so exit successfully and let the
        // controller unload/recreate the job instead of retrying forever.
        return 0;
      }
    }

    const preflightEnvironment = runtimeInputs?.environment ?? startupEnvironment;
    const pre = await ensureStartable(args, preflightEnvironment, {
      ...(runtimeInputs === undefined
        ? {}
        : {
            cwd,
            configPath: runtimeInputs.configPath,
            preferAppPluginInstall: true,
          }),
      ...(managedRuntime === undefined
        ? {}
        : { verifiedRuntimeProvenanceDetail: managedRuntime.provenanceDetail }),
    });
    if (!pre.ok) {
      printPreflightFailure(pre);
      return managedBackgroundWorker ? 0 : pre.code;
    }
    try {
      await readCliConfigSnapshot(runtimeInputs?.configPath ?? configPath);
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Cannot establish the foreground config identity: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return managedBackgroundWorker ? 0 : 1;
    }

    const appOptions = {
      cwd,
      configPath,
      ...(runtimeInputs === undefined ? {} : { configReadPath: runtimeInputs.configPath }),
      env: runtimeInputs?.environment ?? startupEnvironment,
      logger: consoleLogger(),
      ...(backgroundSnapshot === undefined ? {} : { backgroundSnapshot }),
    };
    app = managedRuntime === undefined
      ? await startMonoAgentApp(appOptions)
      : await startVerifiedManagedMonoAgentApp(appOptions, managedRuntime);

    await printAppStatus(app);
    // Block until a shutdown signal. Returning here (the old behavior) let the
    // process exit immediately whenever no channel owned a live handle — e.g. a
    // traceability-only config, now that the operator console is retired and the
    // trace heartbeat timer is unref'd.
    return await waitForShutdownSignal(app);
  } finally {
    await app?.stop().catch(() => undefined);
    await runtimeInputs?.dispose().catch(() => undefined);
    await lease.release().catch((error) => {
      process.stderr.write(ui.style.yellow(
        `⚠ Could not cleanly release worker singleton lease ${lease.path}: ${error instanceof Error ? error.message : String(error)}`,
      ) + "\n");
    });
  }
}

export async function runBackgroundCommand(
  args: ParsedCliArgs,
  command: (typeof BACKGROUND_COMMANDS)[number],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const guard = requireDarwin(command);
  if (guard !== undefined) {
    return guard;
  }

  let controllerEnvironment: Record<string, string | undefined>;
  try {
    controllerEnvironment = await loadDurableBackgroundEnvironment({
      cwd: process.cwd(),
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
      operationalEnvironment: managedBackgroundEnvironment(env),
    });
  } catch (error) {
    if (command === "start" || command === "restart") {
      process.stderr.write(ui.errorLine(
        `Cannot reconstruct the managed worker environment: ${error instanceof Error ? error.message : String(error)}`,
      ));
      process.stderr.write(ui.hint("No LaunchAgent changes were made. Fix the dotenv path and retry."));
      return 1;
    }
    controllerEnvironment = { ...env };
    process.stderr.write(ui.style.yellow(
      `⚠ Could not reconstruct the managed worker environment; ${command} will use the current shell only: ${error instanceof Error ? error.message : String(error)}`,
    ) + "\n");
  }

  // Refuse to launch (or relaunch) an unconfigured/broken folder BEFORE writing
  // the plist and bootstrapping launchctl — otherwise the worker would crash and
  // launchd's KeepAlive would retry it forever. stop/status/logs stay ungated so
  // a broken instance can still be inspected and torn down.
  if (command === "start" || command === "restart") {
    const pre = await ensureStartable(args, controllerEnvironment);
    if (!pre.ok) {
      printPreflightFailure(pre);
      return pre.code;
    }
  }

  let target = await resolveInstanceTarget({
    args: {
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
    },
    env: controllerEnvironment,
    cwd: process.cwd(),
    cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
  });
  if (command === "start" || command === "restart") {
    try {
      const expectedSnapshot = await captureBackgroundSnapshot({
        cwd: target.cwd,
        configPath: target.configPath,
        ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
        env: controllerEnvironment,
      });
      target = { ...target, expectedSnapshot };
    } catch (error) {
      process.stderr.write(ui.errorLine(
        `Cannot prove the durable background snapshot: ${error instanceof Error ? error.message : String(error)}`,
      ));
      process.stderr.write(ui.hint("No LaunchAgent changes were made. Fix the config/dotenv/Identity/Soul/MCP mismatch and retry."));
      return 1;
    }
  }
  const deps = defaultBackgroundDeps();

  switch (command) {
    case "start":
      return await startBackground(target, deps);
    case "restart":
      return args.clearSessions === true
        ? await runForceRestart(target, deps, controllerEnvironment)
        : await restartBackground(target, deps);
    case "stop":
      return await stopBackground(target, deps);
    case "status":
      return await statusBackground(target, deps, { json: args.json === true });
    case "logs":
      return await tailLogs(target, deps, { follow: args.follow, lines: args.lines ?? DEFAULT_LOG_LINES });
  }
}

/** Private launchd-only entry point; `runCli` recognizes its launchd-only env marker. */
export async function runLaunchdLogMaintenanceCommand(
  args: ParsedCliArgs,
  deps: BackgroundDeps = defaultBackgroundDeps(),
): Promise<number> {
  const guard = requireDarwin("scheduled log maintenance");
  if (guard !== undefined) return guard;
  if (args.configPath === undefined || args.controllerCliPath === undefined
    || args.agentCwd === undefined || args.agentPath === undefined) {
    process.stderr.write(ui.errorLine("Managed launchd recovery requires its pinned config, controller CLI, agent cwd, and worker PATH."));
    return 2;
  }
  const agentCwd = resolve(args.agentCwd);
  const configPath = await canonicalBackgroundConfigPath(agentCwd, args.configPath);
  let controllerEnvironment: Record<string, string | undefined>;
  try {
    controllerEnvironment = await loadDurableBackgroundEnvironment({
      cwd: agentCwd,
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
      operationalEnvironment: managedBackgroundEnvironment({
        ...process.env,
        // The helper itself keeps a closed system PATH. Rehydrate the worker's
        // original non-secret PATH from its private launchd arguments so a
        // healthy login pass is stable and recovery preserves tool discovery.
        PATH: args.agentPath,
      }),
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Scheduled recovery could not reconstruct the managed worker environment: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  const preflight = await ensureStartable(args, controllerEnvironment, { cwd: agentCwd, configPath });
  if (!preflight.ok) {
    printPreflightFailure(preflight);
    return preflight.code;
  }

  let sourceAvailable: boolean;
  try {
    sourceAvailable = await controllerCliAvailable(args.controllerCliPath);
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Scheduled recovery could not inspect the original controller CLI: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  const controllerCliPath = sourceAvailable
    ? resolve(args.controllerCliPath)
    : fileURLToPath(new URL("./cli.js", import.meta.url));
  let target = await resolveInstanceTarget({
    args: {
      configPath,
      ...(args.envFile === undefined ? {} : { envFile: args.envFile }),
    },
    env: controllerEnvironment,
    cwd: agentCwd,
    cliPath: controllerCliPath,
  });
  target = {
    ...target,
    // A fallback recovery installs from the helper closure for this run, but
    // the durable helper must keep probing the original source. Otherwise one
    // missing checkout would permanently pin all later recoveries to the old
    // private closure even after the source reappeared.
    controllerCliPath: resolve(args.controllerCliPath),
  };
  try {
    target = {
      ...target,
      expectedSnapshot: await captureBackgroundSnapshot({
        cwd: target.cwd,
        configPath: target.configPath,
        ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
        env: controllerEnvironment,
      }),
    };
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Scheduled recovery could not prove the durable background snapshot: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  return await maintainLaunchdController(target, deps, { sourceAvailable });
}

async function controllerCliAvailable(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * `restart --clear-sessions`: stop the worker, purge provider transcripts and canonical
 * active-conversation history, then start fresh. Stopping first guarantees no
 * conversation state is being written during deletion. Durable memory and run
 * artifacts live elsewhere and remain untouched.
 */
async function runForceRestart(
  target: InstanceTarget,
  deps: BackgroundDeps,
  environment: Record<string, string | undefined>,
): Promise<number> {
  return await forceRestartBackground(target, deps, async () => {
    const result = await purgeConversationState({ env: environment, cwd: target.cwd, configPath: target.configPath });
    const cleared: string[] = [];
    if (result.sessions.removed) {
      const count = result.sessions.files === 0
        ? ""
        : ` (${result.sessions.files} session file${result.sessions.files === 1 ? "" : "s"})`;
      cleared.push(`persisted provider sessions${count}`);
    }
    if (result.history.removed) {
      const count = result.history.files === 0
        ? ""
        : ` (${result.history.files} conversation file${result.history.files === 1 ? "" : "s"})`;
      cleared.push(`active conversation history${count}`);
    }
    if (cleared.length > 0) {
      process.stdout.write(`${ui.badge("ok")}${ui.style.bold(`Cleared ${cleared.join(" and ")}`)}.\n`);
    } else {
      process.stdout.write(ui.style.dim("No persisted provider sessions or conversation history to clear.") + "\n");
    }
  });
}

/**
 * Background service mode is launchd-specific. On other platforms point the
 * user at the still-supported blocking foreground path.
 */
function requireDarwin(command: string): number | undefined {
  if (process.platform === "darwin") {
    return undefined;
  }
  process.stderr.write(ui.errorLine(`Background service mode (mono-agent ${command}) requires macOS (launchd).`));
  process.stderr.write(ui.hint("Run `mono-agent start --foreground` to run in the foreground on this platform."));
  return 1;
}

export interface PrintAppStatusOptions {
  readonly listRecordedRuns?: typeof listRecordedRuns;
  readonly nowMs?: number;
}

export async function printAppStatus(app: MonoAgentApp, options: PrintAppStatusOptions = {}): Promise<void> {
  const trace = app.traceabilityStatus;
  process.stdout.write(ui.rule("instance"));
  process.stdout.write(
    ui.keyValue(
      [
        ["config", app.configPath],
        [
          "traceability",
          trace.kind === "running" ? `running (source ${trace.sourceId})` : `${trace.kind}: ${trace.reason}`,
        ],
      ],
      2,
    ),
  );
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  process.stdout.write(ui.rule("sandbox"));
  process.stdout.write(`  ${describeSandboxStatus(app.sandboxStatus)}\n`);
  process.stdout.write(ui.rule("observability"));
  process.stdout.write(`  ${describeExporter(app.exporterStatus, artifactDir)}\n`);
  const channels = [...app.channelStatuses()];
  if (channels.length > 0) {
    const sections = formatHumanChannelSections(channels.map(([id, status]) => ({
      id,
      kind: status.kind,
      text: describeChannelStatus(status),
    })));
    for (const section of sections) {
      process.stdout.write(ui.rule(section.title));
      for (const line of section.lines) process.stdout.write(`${line}\n`);
    }
  }
  await writeAppRunsHealthDetail(app, options);
}

async function writeAppRunsHealthDetail(app: MonoAgentApp, options: PrintAppStatusOptions): Promise<void> {
  const artifactDir = app.traceabilityStatus.kind === "running" ? app.traceabilityStatus.artifactDir : undefined;
  if (artifactDir === undefined || artifactDir.trim().length === 0) {
    return;
  }
  const reader = options.listRecordedRuns ?? listRecordedRuns;
  let result;
  try {
    result = await reader({ artifactDir, maxRuns: RUNS_HEALTH_MAX_RUNS, scope: "agent" });
  } catch (error) {
    result = {
      totalRuns: 0,
      runs: [],
      warnings: [`Unable to read run summaries: ${reasonOf(error)}`],
    };
  }
  const display = buildRunsHealthDisplay({
    artifactDir,
    totalRuns: result.totalRuns,
    runs: result.runs,
    warnings: result.warnings,
    includeSelectedSkills: true,
    runOwnerAlive: true,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    ...(app.selectedSkills === undefined ? {} : { selectedSkills: app.selectedSkills }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  process.stdout.write(ui.rule("runs health"));
  for (const detail of display.details) {
    process.stdout.write(`  ${detail}\n`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExporter(status: ExporterStatus, artifactDir: string | undefined): string {
  if (status.kind !== "configured") {
    return `${status.kind}: ${status.reason}`;
  }
  const parts = [`phoenix ${status.endpoint}`];
  const appUrl = phoenixAppBaseUrl(status.endpoint);
  if (appUrl !== undefined) {
    parts.push(`app ${appUrl}`);
  }
  if (status.includeSensitiveData) {
    parts.push(ui.style.yellow(describeSensitiveDataExportWarning(status.endpoint)));
  }
  if (status.lastWarning !== undefined) {
    parts.push(`last warning: ${status.lastWarning}`);
  }
  if (status.lastError !== undefined) {
    parts.push(`last error: ${status.lastError}`);
  }
  parts.push(artifactDir === undefined
    ? "JSONL artifacts remain local"
    : `JSONL artifacts remain local at ${artifactDir}`);
  return parts.join("; ");
}

function describeSandboxStatus(status: SandboxStatus): string {
  const engineAvailability = status.engineAvailable === true
    ? "present"
    : status.engineAvailable === false
      ? "absent"
      : "not checked";
  const parts = [
    `effective: ${status.effective}`,
    `engine: ${status.engine ?? "none"} (${engineAvailability})`,
    ...(status.fallback === undefined ? [] : [`fallback: ${status.fallback}`]),
    `fallback active: ${status.fallbackActive ? "yes" : "no"}`,
    status.detail,
  ];
  const warning = status.warning ?? sandboxEffectiveStateWarning(status);
  if (warning !== undefined) {
    parts.push(ui.style.yellow(warning));
  }
  return parts.join("; ");
}

export function describeChannelStatus(status: ChannelStatus): string {
  if (status.kind === "running") {
    const facts = Object.entries(status.summary)
      .map(([key, value]) => `${key}=${formatChannelFactValue(value)}`)
      .join(" ");
    return facts.length === 0 ? "running" : `running (${facts})`;
  }
  return `${status.kind}: ${status.reason}`;
}

/**
 * Block the foreground process until SIGINT/SIGTERM, then stop the app and
 * resolve the exit code. A referenced no-op timer owns the event loop so the
 * process stays alive even with no channel handle (signal listeners alone do
 * NOT keep Node running, and the trace heartbeat is unref'd). Cleared on stop so
 * the loop drains cleanly without a forceful `process.exit`. Exported for tests.
 */
export function waitForShutdownSignal(app: Pick<MonoAgentApp, "stop">): Promise<number> {
  return new Promise<number>((resolve) => {
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      clearInterval(keepAlive);
      void (async () => {
        process.stdout.write("\n" + ui.hint(`Received ${signal}; stopping mono agent app…`));
        try {
          await app.stop();
          resolve(0);
        } catch (error) {
          process.stderr.write(ui.errorLine(
            `Foreground shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          ));
          // Resolve so runForeground's finally block can retry idempotent app
          // cleanup and release the process-lifetime singleton lease.
          resolve(1);
        }
      })();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function consoleLogger() {
  return {
    info(message: string, metadata?: Record<string, unknown>) {
      process.stdout.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
    warn(message: string, metadata?: Record<string, unknown>) {
      process.stderr.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
    error(message: string, metadata?: Record<string, unknown>) {
      process.stderr.write(`${message}${metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`}\n`);
    },
  };
}
