import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadAppCoreConfig } from "./app-config.js";
import { configuredChannelPluginPackageNames } from "./channel-plugins.js";
import type { ManagedRuntimeAdditionalPackage } from "./background-runtime.js";
import { SUPERMEMORY_PLUGIN_PACKAGE } from "./supermemory-plugin.js";

export interface ResolveManagedRuntimePackagesInput {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Resolve the exact config-selected plugin roots observed by the current app install. */
export async function resolveConfiguredManagedRuntimePackages(
  input: ResolveManagedRuntimePackagesInput,
): Promise<readonly ManagedRuntimeAdditionalPackage[]> {
  const cwd = resolve(input.cwd);
  const [channelPackages, config] = await Promise.all([
    configuredChannelPluginPackageNames(input.configPath),
    loadAppCoreConfig({ cwd, configPath: input.configPath, env: input.env }),
  ]);
  const requirements = new Map<string, boolean>();
  for (const packageName of channelPackages) requirements.set(packageName, false);
  if (config.memory?.backend === "supermemory") {
    // Preserve Supermemory's established explicit agent-folder precedence,
    // then copy that exact selection into the managed app-side closure. The
    // worker resolves app-first only after this immutable copy is complete.
    requirements.set(SUPERMEMORY_PLUGIN_PACKAGE, true);
  }

  const appBase = import.meta.url;
  const cwdBase = pathToFileURL(join(cwd, "package.json")).href;
  const resolved = await Promise.all([...requirements]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(async ([packageName, allowCwdFallback]) => ({
      packageName,
      packageSource: await resolveInstalledPackageRoot(
        packageName,
        allowCwdFallback ? [cwdBase, appBase] : [appBase],
      ),
    })));
  return resolved;
}

async function resolveInstalledPackageRoot(
  packageName: string,
  bases: readonly string[],
): Promise<string> {
  let lastError: unknown;
  for (const base of bases) {
    try {
      const manifestPath = findPackageJSON(packageName, base);
      if (manifestPath === undefined) {
        throw new Error(`Cannot resolve ${packageName} from ${base}.`);
      }
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
      if (parsed.name !== packageName) {
        throw new Error(`${manifestPath} declares ${String(parsed.name)}, expected ${packageName}.`);
      }
      return await realpath(dirname(manifestPath));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Cannot preserve configured managed-runtime package ${packageName}: ` +
    `${lastError instanceof Error ? lastError.message : String(lastError)}. ` +
    "Install the package beside @mono-agent/agent-app before starting the background agent.",
  );
}
