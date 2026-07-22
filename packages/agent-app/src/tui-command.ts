import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTraceSources, mergeTraceSources, pruneTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";
import { loadTuiAdapterConfig } from "@mono-agent/operator-adapter";

import { resolveAppTraceRegistryDir, resolveGlobalTraceRegistryDir } from "./app-config.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { hasCompletedManagedStartup } from "./managed-startup.js";

export interface RunTuiOptions {
  readonly configPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /** Explicit dotenv path baked into managed background restarts. */
  readonly envFile?: string;
  /** --agent: connect to this label or sourceId directly. */
  readonly agent?: string;
  /** --conversation: conversation id to chat under (default tui-<sourceId>). */
  readonly conversationId?: string;
  /** Build the current folder's responder in this process instead of discovering a service. */
  readonly local?: boolean;
  /** Attach to the managed background agent in a dedicated self-configuration session. */
  readonly configure?: boolean;
}

/** Test seams: discovery + TUI boot are injectable. */
export interface RunTuiDeps {
  readonly listSources?: typeof listTraceSources;
  readonly startTui?: (options: Record<string, unknown>) => Promise<{ waitUntilExit(): Promise<void> }>;
  readonly isTty?: boolean;
  readonly stdout?: { write(text: string): void };
  readonly stderr?: { write(text: string): void };
  readonly platform?: NodeJS.Platform;
  readonly createLocalSession?: (options: {
    readonly cwd: string;
    readonly configPath: string;
    readonly env: Record<string, string | undefined>;
  }) => Promise<{
    readonly responder: unknown;
    readonly title: string;
    dispose(): Promise<void>;
  }>;
  readonly createRemoteConfigurationSession?: (options: {
    readonly cwd: string;
    readonly configPath: string;
    readonly env: Record<string, string | undefined>;
    readonly envFile?: string;
    readonly restartBackground: (expectedSnapshot: BackgroundSnapshot) => Promise<
      | { readonly ok: true; readonly connection: { readonly baseUrl: string; readonly apiKey?: string } }
      | { readonly ok: false; readonly message: string }
    >;
  }) => Promise<{ readonly configuration: unknown; dispose(): Promise<void> }>;
  readonly restartBackground?: (
    expectedSnapshot: BackgroundSnapshot,
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<
    | { readonly ok: true; readonly connection: { readonly baseUrl: string; readonly apiKey?: string } }
    | { readonly ok: false; readonly message: string }
  >;
  /** Re-prove launchd ownership, exact durable inputs, and TUI reachability before granting configuration authority. */
  readonly verifyConfigurationSource?: (
    source: TraceSourceListItem,
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<TraceSourceListItem | undefined>;
  /** Reconstruct the exact dotenv-plus-operational environment used by the managed worker. */
  readonly loadConfigurationEnvironment?: () => Promise<Record<string, string>>;
}

export type TuiLaunchPlan =
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "connect"; readonly source: TraceSourceListItem }
  | { readonly kind: "picker"; readonly sources: readonly TraceSourceListItem[] };

/**
 * Pure selection logic for `mono-agent tui`: which running agent to connect
 * to, or whether to open the picker. `registryDirs` names every registry that
 * was consulted (one entry, or two when the configured registry and the
 * machine-wide global one differ) purely for the "nothing found" messaging.
 * Exported for unit tests.
 */
export function resolveTuiLaunch(
  sources: readonly TraceSourceListItem[],
  registryDirs: readonly string[],
  agentFilter: string | undefined,
): TuiLaunchPlan {
  const alive = sources.filter((source) => source.health !== "stopped");
  const registryLabel =
    registryDirs.length <= 1 ? `registry: ${registryDirs[0] ?? ""}` : `registries: ${registryDirs.join(", ")}`;
  if (agentFilter !== undefined) {
    const match = alive.find(
      (source) => source.label === agentFilter || source.sourceId === agentFilter,
    );
    if (match === undefined) {
      const available = alive.map((source) => `  ${source.label} (${source.sourceId})`).join("\n");
      return {
        kind: "error",
        message:
          `No running agent matches \`${agentFilter}\`.\n` +
          (alive.length === 0
            ? `No agents are running (${registryLabel}).`
            : `Running agents:\n${available}`),
      };
    }
    return { kind: "connect", source: match };
  }
  if (alive.length === 0) {
    return {
      kind: "none",
      message:
        `No running agents found (${registryLabel}).\n` +
        "Start one with `mono-agent start` in its folder, then run `mono-agent tui` again.",
    };
  }
  if (alive.length === 1 && alive[0] !== undefined) {
    return { kind: "connect", source: alive[0] };
  }
  return { kind: "picker", sources: alive };
}

/** Extract the tui channel's baseUrl from a manifest's channel summaries. */
export function tuiEndpointOf(source: TraceSourceListItem): string | undefined {
  const channels = source.metadata?.channels;
  if (typeof channels !== "object" || channels === null) {
    return undefined;
  }
  const tui = (channels as Record<string, unknown>).tui;
  if (typeof tui !== "object" || tui === null) {
    return undefined;
  }
  const record = tui as Record<string, unknown>;
  // Non-empty required: a malformed manifest with baseUrl "" must fall back to
  // discovery mode rather than attempt a broken connection.
  return record.kind === "running" && typeof record.baseUrl === "string" && record.baseUrl.length > 0
    ? record.baseUrl
    : undefined;
}

/**
 * `mono-agent tui`: discover running agents (machine-wide registry), resolve
 * the target's stream endpoint + key, and launch the operator console. Works
 * from any directory — with no local config the registry falls back to
 * ~/.mono-agent/trace-sources.
 */
export async function runTui(options: RunTuiOptions, deps: RunTuiDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if ((deps.isTty ?? process.stdin.isTTY) !== true) {
    stderr.write("mono-agent tui needs an interactive terminal (stdin is not a TTY).\n");
    return 1;
  }
  if (options.configure === true && options.local === true) {
    stderr.write("Self-configuration must attach to the authoritative background agent; remove `--local`.\n");
    return 1;
  }
  if (options.configure === true && (deps.platform ?? process.platform) !== "darwin") {
    stderr.write(
      "Temporary conversational configuration requires the managed macOS background lifecycle so apply/restart/rollback can be proven. Use ordinary `mono-agent tui`, edit mono-agent.config.json or IDENTITY.md manually, validate, and restart the foreground agent yourself.\n",
    );
    return 1;
  }

  // Lazy: neither the runtime stack nor pi-tui loads for remote discovery.
  const startTui =
    deps.startTui ??
    (async (tuiOptions: Record<string, unknown>) => {
      const { startMonoAgentTui } = await import("@mono-agent/tui");
      return startMonoAgentTui(tuiOptions as never);
    });

  if (options.local === true) {
    const createSession = deps.createLocalSession ?? (async (input) => {
      const { createLocalConfigurationSession } = await import("./local-configuration.js");
      return await createLocalConfigurationSession(input);
    });
    let session;
    try {
      session = await createSession({
        cwd: options.cwd,
        configPath: options.configPath,
        env: options.env,
      });
    } catch (error) {
      stderr.write(`Could not start local TUI: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    try {
      const handle = await startTui({
        responder: session.responder,
        title: session.title,
        subtitle: options.cwd,
        conversationId: options.conversationId ?? "tui-local",
        env: options.env,
        config: { path: options.configPath, cwd: options.cwd, env: options.env },
        instance: {
          label: session.title,
          artifactDir: resolve(options.cwd, ".mono-agent", "artifacts"),
          configPath: options.configPath,
        },
      });
      await handle.waitUntilExit();
      return 0;
    } finally {
      await session.dispose();
    }
  }

  let managedConfigurationEnvironment: Record<string, string> | undefined;
  if (options.configure === true) {
    try {
      managedConfigurationEnvironment = await (
        deps.loadConfigurationEnvironment?.() ?? loadManagedConfigurationEnvironment(options)
      );
    } catch (error) {
      stderr.write(
        `Could not reconstruct the managed worker environment: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  const effectiveEnvironment = managedConfigurationEnvironment ?? options.env;
  let effectiveOptions = options;
  if (options.configure === true) {
    try {
      const { canonicalBackgroundConfigPath } = await import("./background.js");
      effectiveOptions = {
        ...options,
        configPath: await canonicalBackgroundConfigPath(options.cwd, options.configPath),
      };
    } catch (error) {
      stderr.write(
        `Could not resolve the managed configuration identity: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }

  const configuredRegistryDir = await resolveAppTraceRegistryDir({
    env: effectiveEnvironment,
    cwd: effectiveOptions.cwd,
    configPath: effectiveOptions.configPath,
  });
  const globalRegistryDir = resolveGlobalTraceRegistryDir(effectiveEnvironment);
  const listSources = deps.listSources ?? listTraceSources;

  // Use the registry's own echoed (normalized) dir from here on. The "does this
  // differ from the global registry" decision is made BEFORE querying (against
  // the resolvers' own output), not against the echoed result, since a listing
  // seam is free to echo back whatever registryDir it likes.
  const sameAsGlobal = resolve(configuredRegistryDir) === resolve(globalRegistryDir);
  const primary = await listSources({ registryDir: configuredRegistryDir });
  void pruneTraceSources({ registryDir: primary.registryDir });

  const merged = sameAsGlobal ? undefined : await listSources({ registryDir: globalRegistryDir });
  if (merged !== undefined) {
    void pruneTraceSources({ registryDir: merged.registryDir });
  }

  const sources = merged === undefined ? primary.sources : mergeTraceSources(primary.sources, merged.sources);
  // Every consulted registry, in precedence order. The TUI's discovery view
  // (picker, and its in-TUI `r`/`/agents` refresh) re-lists from these, so it
  // MUST see the full union: an agent present only in its local registry (a
  // globalDiscovery:false opt-out, or one still running a pre-mirror build)
  // stays visible from inside its own directory.
  const registryDirs = merged === undefined ? [primary.registryDir] : [primary.registryDir, merged.registryDir];
  const configuredSource = options.configure === true
    ? sources.find((source) =>
        isConfigurationReadySource(source)
        && source.configPath !== undefined
        && resolve(source.configPath) === resolve(effectiveOptions.configPath))
    : undefined;
  let authoritativeConfigurationSource: TraceSourceListItem | undefined;
  if (options.configure === true && configuredSource !== undefined) {
    if (
      options.agent !== undefined
      && options.agent !== configuredSource.sourceId
      && options.agent !== configuredSource.label
    ) {
      stderr.write("The selected agent does not own this folder's configuration; refusing to grant configuration authority.\n");
      return 1;
    }
    const verifyConfigurationSource = deps.verifyConfigurationSource
      ?? ((source: TraceSourceListItem, environment: Readonly<Record<string, string | undefined>>) =>
        verifyManagedConfigurationSource(effectiveOptions, source, environment));
    try {
      authoritativeConfigurationSource = await verifyConfigurationSource(configuredSource, effectiveEnvironment);
    } catch (error) {
      stderr.write(
        `Could not verify the authoritative background agent: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    if (authoritativeConfigurationSource === undefined) {
      stderr.write(
        "The registry entry could not be matched to one live launchd PID, its exact durable-input snapshot, and a reachable TUI endpoint; refusing configuration authority.\n",
      );
      return 1;
    }
  }
  const plan: TuiLaunchPlan = options.configure === true && authoritativeConfigurationSource !== undefined
    ? { kind: "connect", source: authoritativeConfigurationSource }
    : resolveTuiLaunch(sources, registryDirs, options.agent);

  if (plan.kind === "none") {
    stdout.write(`${plan.message}\n`);
    return 1;
  }
  if (plan.kind === "error") {
    stderr.write(`${plan.message}\n`);
    return 1;
  }
  if (options.configure === true && configuredSource === undefined) {
    stderr.write(
      `No ready background agent for ${resolve(effectiveOptions.configPath)}. Start it with \`mono-agent start --config ${shellQuote(resolve(effectiveOptions.configPath))}\`, then retry \`mono-agent tui --configure\`.\n`,
    );
    return 1;
  }

  const common = {
    title: "mono-agent",
    env: effectiveEnvironment,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
  };

  if (plan.kind === "picker") {
    if (options.configure === true) {
      stderr.write("Self-configuration must target the current folder's one authoritative background agent.\n");
      return 1;
    }
    const handle = await startTui({ ...common, discovery: { registryDirs } });
    await handle.waitUntilExit();
    return 0;
  }

  const source = plan.source;
  if (
    options.configure === true
    && (source.configPath === undefined || resolve(source.configPath) !== resolve(effectiveOptions.configPath))
  ) {
    stderr.write("The selected agent does not own this folder's configuration; refusing to grant configuration authority.\n");
    return 1;
  }
  const baseUrl = tuiEndpointOf(source);
  if (options.configure === true && baseUrl === undefined) {
    stderr.write("Self-configuration needs the background agent's running TUI endpoint; enable the tui channel and restart it.\n");
    return 1;
  }
  const apiKey = await resolveAgentApiKey(source, effectiveEnvironment);
  let configurationSession: { readonly configuration: unknown; dispose(): Promise<void> } | undefined;
  if (options.configure === true) {
    const restartBackground = (expectedSnapshot: BackgroundSnapshot) =>
      deps.restartBackground === undefined
        ? restartManagedBackground(effectiveOptions, expectedSnapshot, effectiveEnvironment)
        : deps.restartBackground(expectedSnapshot, effectiveEnvironment);
    const createSession = deps.createRemoteConfigurationSession ?? (async (input) => {
      const { createRemoteConfigurationSession } = await import("./local-configuration.js");
      return await createRemoteConfigurationSession(input);
    });
    try {
      configurationSession = await createSession({
        cwd: effectiveOptions.cwd,
        configPath: effectiveOptions.configPath,
        env: effectiveEnvironment,
        ...(effectiveOptions.envFile === undefined ? {} : { envFile: effectiveOptions.envFile }),
        restartBackground,
      });
    } catch (error) {
      stderr.write(`Could not open self-configuration: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  try {
    const handle = await startTui({
      ...common,
      ...(baseUrl === undefined
        ? // No stream endpoint (tui channel disabled): replay/config still work.
          { discovery: { registryDirs } }
        : { connection: { baseUrl, ...(apiKey === undefined ? {} : { apiKey }) } }),
      ...(configurationSession === undefined ? {} : { configuration: configurationSession.configuration }),
      instance: {
        label: source.label,
        artifactDir: source.artifactDir,
        ...(source.configPath === undefined ? {} : { configPath: source.configPath }),
      },
      ...(options.conversationId === undefined ? { conversationId: `tui-${source.sourceId}` } : {}),
      subtitle: source.configPath === undefined ? source.sourceId : dirname(resolve(source.configPath)),
    });
    if (baseUrl === undefined) {
      stdout.write(
        `Agent \`${source.label}\` has no tui stream endpoint (channel disabled?) — opening in discovery mode; replay/config remain available.\n`,
      );
    }
    await handle.waitUntilExit();
    if (options.configure === true) {
      stdout.write(
        "Configuration console closed; no background stop was requested. " +
        "If restart or recovery reported failure, use the transcript's recovery commands before assuming the agent is running.\n",
      );
    }
    return 0;
  } finally {
    await configurationSession?.dispose();
  }
}

/**
 * The registry never carries secrets: read `tui.apiKey` through the adapter's
 * own loader against the agent's config file (json→env layering included).
 */
async function resolveAgentApiKey(
  source: TraceSourceListItem,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (source.configPath === undefined) {
    return env.MONO_AGENT_TUI_API_KEY;
  }
  try {
    const config = await loadTuiAdapterConfig({ env, jsonPath: source.configPath });
    return config.apiKey;
  } catch {
    return env.MONO_AGENT_TUI_API_KEY;
  }
}

async function restartManagedBackground(
  options: RunTuiOptions,
  expectedSnapshot: BackgroundSnapshot,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<
  | { readonly ok: true; readonly connection: { readonly baseUrl: string; readonly apiKey?: string } }
  | { readonly ok: false; readonly message: string }
> {
  const background = await import("./background.js");
  let target: Awaited<ReturnType<typeof background.resolveInstanceTarget>>;
  try {
    const resolvedTarget = await background.resolveInstanceTarget({
      args: {
        configPath: options.configPath,
        ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
      },
      env: environment,
      cwd: options.cwd,
      cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
      requireTui: true,
    });
    target = { ...resolvedTarget, expectedSnapshot };
  } catch (error) {
    return {
      ok: false,
      message:
        `Could not resolve the managed background target: ${error instanceof Error ? error.message : String(error)}. ` +
        configurationRecoveryCommands(options),
    };
  }
  let result: Awaited<ReturnType<typeof background.ensureBackgroundReady>>;
  try {
    // Never write lifecycle status directly into the active terminal renderer.
    // The host controller returns one concise transcript result instead.
    const lifecycleDeps = {
      ...background.defaultBackgroundDeps(),
      stdout: (_text: string) => undefined,
      stderr: (_text: string) => undefined,
    };
    result = await background.ensureBackgroundReady(target, lifecycleDeps);
  } catch (error) {
    return {
      ok: false,
      message:
        `Managed background restart failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. ` +
        configurationRecoveryCommands(options, target.paths),
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      message:
        `Managed background ${result.action} failed (${result.reason}). ` +
        configurationRecoveryCommands(options, target.paths),
    };
  }
  const baseUrl = tuiEndpointOf(result.source);
  if (baseUrl === undefined) {
    return {
      ok: false,
      message:
        "The restarted agent reported ready without a running TUI endpoint. " +
        configurationRecoveryCommands(options, target.paths),
    };
  }
  const apiKey = await resolveAgentApiKey(result.source, environment);
  return {
    ok: true,
    connection: { baseUrl, ...(apiKey === undefined ? {} : { apiKey }) },
  };
}

async function verifyManagedConfigurationSource(
  options: RunTuiOptions,
  _candidate: TraceSourceListItem,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<TraceSourceListItem | undefined> {
  const background = await import("./background.js");
  const resolvedTarget = await background.resolveInstanceTarget({
    args: {
      configPath: options.configPath,
      ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
    },
    env: environment,
    cwd: options.cwd,
    cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
    requireTui: true,
  });
  const expectedSnapshot = await captureManagedConfigurationAttachSnapshot(resolvedTarget, environment);
  const target = { ...resolvedTarget, expectedSnapshot };
  return await background.pollInstanceReady(target, background.defaultBackgroundDeps(), {
    timeoutMs: 0,
    intervalMs: 0,
    sinceMs: 0,
    requireTui: true,
  });
}

/**
 * Attest the configuration target against the one environment reconstructed
 * before discovery. Re-reading dotenv here could prove a different worker
 * input than the environment later used for authentication and restart.
 */
export async function captureManagedConfigurationAttachSnapshot(
  target: Pick<RunTuiOptions, "cwd" | "configPath" | "envFile">,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<BackgroundSnapshot> {
  const { captureBackgroundSnapshot } = await import("./background-snapshot.js");
  return await captureBackgroundSnapshot({
    cwd: target.cwd,
    configPath: target.configPath,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    env: environment,
  });
}

async function loadManagedConfigurationEnvironment(
  options: RunTuiOptions,
): Promise<Record<string, string>> {
  const [background, snapshot] = await Promise.all([
    import("./background.js"),
    import("./background-snapshot.js"),
  ]);
  return await snapshot.loadDurableBackgroundEnvironment({
    cwd: options.cwd,
    ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
    operationalEnvironment: background.managedBackgroundEnvironment(options.env),
  });
}

function configurationRecoveryCommands(
  options: Pick<RunTuiOptions, "configPath" | "envFile">,
  paths?: { readonly stderrPath: string; readonly stdoutPath: string },
): string {
  const flag =
    ` --config ${shellQuote(resolve(options.configPath))}` +
    (options.envFile === undefined ? "" : ` --env-file ${shellQuote(resolve(options.envFile))}`);
  return (
    `Recovery commands: mono-agent status${flag}; ` +
    `mono-agent logs${flag} --follow; mono-agent restart${flag}; mono-agent stop${flag}.` +
    (paths === undefined
      ? ""
      : ` LaunchAgent logs: ${shellQuote(paths.stderrPath)} and ${shellQuote(paths.stdoutPath)}.`)
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isConfigurationReadySource(source: TraceSourceListItem): boolean {
  return source.health === "running" && hasCompletedManagedStartup(source);
}
