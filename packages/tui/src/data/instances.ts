import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { listTraceSources, mergeTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

export type { TraceSourceListItem } from "@mono-agent/observability";

/** The default machine-wide registry dir every agent writes to unless overridden. */
export function defaultTraceRegistryDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return resolve(homedir(), ".mono-agent", "trace-sources");
}

export interface DiscoverInstancesOptions {
  readonly registryDir?: string;
  /**
   * Consult several registries at once (e.g. an agent's config-local registry
   * plus the machine-wide global one) and merge by sourceId — the fresher
   * heartbeat wins a duplicate, earlier dirs win ties. Takes precedence over
   * the single `registryDir` when non-empty; repeated dirs are deduped.
   */
  readonly registryDirs?: readonly string[];
  readonly staleAfterMs?: number;
  readonly env?: Record<string, string | undefined>;
}

export interface DiscoveredInstance {
  readonly source: TraceSourceListItem;
  /** The operator-adapter TUI base URL published by the agent's tui channel, when running. */
  readonly tuiBaseUrl?: string;
  /** dirname(configPath): where replay/config data lives relative to. */
  readonly agentDir?: string;
}

export interface DiscoverInstancesResult {
  readonly instances: readonly DiscoveredInstance[];
  /** First consulted registry — kept for callers that predate multi-registry discovery. */
  readonly registryDir: string;
  /** Every consulted registry, in precedence order (deduped, normalized). */
  readonly registryDirs: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Discover mono-agent instances via one or more trace-source registries
 * (merged by sourceId — fresher heartbeat wins a duplicate, so each instance
 * carries its winning manifest's own absolute artifact/config paths). Stopped
 * sources are filtered out; stale ones stay listed (marked by health) because
 * a busy agent can miss heartbeats while remaining connectable.
 */
export async function discoverInstances(
  options: DiscoverInstancesOptions = {},
): Promise<DiscoverInstancesResult> {
  const registryDirs = normalizeRegistryDirs(options);
  const results = await Promise.all(
    registryDirs.map((registryDir) =>
      listTraceSources({
        registryDir,
        ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      }),
    ),
  );
  const instances = mergeTraceSources(...results.map((result) => result.sources))
    .filter((source) => source.health !== "stopped")
    .map((source) => toInstance(source));
  return {
    instances,
    registryDir: registryDirs[0] ?? "",
    registryDirs,
    warnings: results.flatMap((result) => result.warnings),
  };
}

/** Resolve + dedupe the requested registry list; `registryDirs` (when non-empty) beats the single `registryDir`. */
function normalizeRegistryDirs(options: DiscoverInstancesOptions): string[] {
  const requested =
    options.registryDirs !== undefined && options.registryDirs.length > 0
      ? options.registryDirs
      : [options.registryDir ?? defaultTraceRegistryDir(options.env)];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of requested) {
    const resolved = resolve(dir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      dirs.push(resolved);
    }
  }
  return dirs;
}

export function toInstance(source: TraceSourceListItem): DiscoveredInstance {
  const tuiBaseUrl = tuiBaseUrlFromMetadata(source.metadata);
  return {
    source,
    ...(tuiBaseUrl === undefined ? {} : { tuiBaseUrl }),
    ...(source.configPath === undefined ? {} : { agentDir: dirname(source.configPath) }),
  };
}

function tuiBaseUrlFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const channels = metadata?.channels;
  if (typeof channels !== "object" || channels === null) {
    return undefined;
  }
  const tui = (channels as Record<string, unknown>).tui;
  if (typeof tui !== "object" || tui === null) {
    return undefined;
  }
  const record = tui as Record<string, unknown>;
  if (record.kind !== "running") {
    return undefined;
  }
  return typeof record.baseUrl === "string" && record.baseUrl.length > 0 ? record.baseUrl : undefined;
}

/**
 * Best-effort apiKey resolution for a discovered agent: the registry never
 * carries secrets, so read the agent's own config file (`tui.apiKey` /
 * `MONO_AGENT_TUI_API_KEY` env of THIS process). Failures resolve undefined —
 * a keyless connect against a keyed agent surfaces as 401 with a hint.
 */
export async function resolveInstanceApiKey(
  instance: DiscoveredInstance,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const fromEnv = env.MONO_AGENT_TUI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const configPath = instance.source.configPath;
  if (configPath === undefined) {
    return undefined;
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      tui?: { apiKey?: unknown };
    };
    // Trim to match the adapter's own loader (normalizeOptionalString): the
    // server compares against the trimmed key, so an untrimmed client 401s.
    const apiKey = typeof parsed.tui?.apiKey === "string" ? parsed.tui.apiKey.trim() : undefined;
    return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined;
  } catch {
    return undefined;
  }
}
